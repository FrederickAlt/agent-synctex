import { createReadStream, readFileSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { basename, resolve } from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import { validateMcpToViewerHostMessage, VIEWER_HOST_PROTOCOL_VERSION, type ViewerHostControlResponse, type ViewerHostSynctexForwardMessage } from "./viewer_host_protocol.ts";
import type { ViewerHostPdfRecord, ViewerHostPdfRegistry } from "./viewer_host_registry.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const require = createRequire(import.meta.url);
const LOCAL_PDFJS_ASSETS = new Map<string, string>([
	["/assets/pdf.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.mjs")],
	["/assets/pdf.worker.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")],
]);

const VIEWER_CLIENT_TABS_SCRIPT = `
const state = {
	tabs: [],
	activePdfId: undefined,
};

const app = document.getElementById("viewer-client-app");
const tabList = document.getElementById("tab-list");
const panels = document.getElementById("viewer-panels");
const emptyState = document.getElementById("empty-state");

function pdfIdKey(pdfId) {
	return String(pdfId);
}

function titleFor(message) {
	return message.title || "PDF " + message.pdf_id;
}

function viewerUrlFor(message) {
	return message.viewer_url || "/viewer/" + encodeURIComponent(String(message.pdf_id));
}

function openOrFocusTab(message) {
	const pdfId = Number(message.pdf_id);
	const existing = state.tabs.find((tab) => tab.pdfId === pdfId);
	if (existing) {
		existing.title = titleFor(message);
		existing.revision = message.revision;
		existing.viewerUrl = viewerUrlFor(message);
		existing.visibleTabToken = message.visible_tab_token;
	} else {
		state.tabs.push({ pdfId, title: titleFor(message), revision: message.revision, viewerUrl: viewerUrlFor(message), visibleTabToken: message.visible_tab_token });
	}
	state.activePdfId = pdfId;
	renderTabs();
}

function closeTab(pdfId) {
	const index = state.tabs.findIndex((tab) => tab.pdfId === pdfId);
	if (index === -1) return;
	const closedTab = state.tabs[index];
	state.tabs.splice(index, 1);
	void fetch("/app-tab-closed", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pdf_id: pdfId, revision: closedTab.revision, viewer_url: closedTab.viewerUrl, visible_tab_token: closedTab.visibleTabToken }),
	}).catch(() => undefined);
	if (state.activePdfId === pdfId) {
		const next = state.tabs[Math.min(index, state.tabs.length - 1)];
		state.activePdfId = next ? next.pdfId : undefined;
	}
	renderTabs();
}

function renderTabs() {
	const existingPanels = new Map(Array.from(panels.querySelectorAll("[role='tabpanel'][data-pdf-id]"), (panel) => [panel.dataset.pdfId, panel]));
	tabList.replaceChildren();
	panels.replaceChildren();
	if (state.activePdfId === undefined || !state.tabs.some((tab) => tab.pdfId === state.activePdfId)) {
		state.activePdfId = state.tabs[0] ? state.tabs[0].pdfId : undefined;
	}
	if (state.activePdfId === undefined) {
		app.removeAttribute("data-active-pdf-id");
		emptyState.hidden = false;
	} else {
		app.setAttribute("data-active-pdf-id", pdfIdKey(state.activePdfId));
		emptyState.hidden = true;
	}
	for (const tab of state.tabs) {
		const selected = tab.pdfId === state.activePdfId;
		const tabItem = document.createElement("div");
		tabItem.className = "tab-item";
		const tabButton = document.createElement("button");
		tabButton.type = "button";
		tabButton.role = "tab";
		tabButton.dataset.pdfId = pdfIdKey(tab.pdfId);
		tabButton.setAttribute("aria-selected", selected ? "true" : "false");
		tabButton.textContent = tab.title;
		tabButton.addEventListener("click", () => {
			state.activePdfId = tab.pdfId;
			renderTabs();
		});
		const closeButton = document.createElement("button");
		closeButton.type = "button";
		closeButton.setAttribute("data-close-pdf-id", pdfIdKey(tab.pdfId));
		closeButton.setAttribute("aria-label", "Close " + tab.title);
		closeButton.textContent = "×";
		closeButton.addEventListener("click", () => closeTab(tab.pdfId));
		tabItem.append(tabButton, closeButton);
		tabList.appendChild(tabItem);

		let panel = existingPanels.get(pdfIdKey(tab.pdfId));
		let iframe;
		if (panel) {
			iframe = panel.querySelector("iframe[data-pdf-id]");
		} else {
			panel = document.createElement("section");
			panel.role = "tabpanel";
			panel.dataset.pdfId = pdfIdKey(tab.pdfId);
			iframe = document.createElement("iframe");
			iframe.dataset.pdfId = pdfIdKey(tab.pdfId);
			panel.appendChild(iframe);
		}
		panel.hidden = !selected;
		iframe.title = tab.title;
		if (iframe.getAttribute("src") !== tab.viewerUrl) iframe.src = tab.viewerUrl;
		panels.appendChild(panel);
	}
}

function connectAppEvents() {
	const events = new EventSource("/app-events");
	events.addEventListener("open", () => document.body.setAttribute("data-app-events", "connected"));
	events.addEventListener("error", () => document.body.setAttribute("data-app-events", "disconnected"));
	events.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.type === "open_pdf" || message.type === "focus_pdf") openOrFocusTab(message);
	});
}

renderTabs();
connectAppEvents();
`;

const VIEWER_SCRIPT = `
const status = document.getElementById("status");
const pages = document.getElementById("pages");
const fallback = document.getElementById("fallback-link");
const configUrl = document.body.dataset.configUrl;

function setStatus(message) {
	if (status) status.textContent = message;
}

function reportViewerError(error) {
	const message = error && error.message ? error.message : String(error || "unknown viewer error");
	setStatus("Unable to render via PDF.js: " + message + ". Use the direct PDF link below.");
}

window.addEventListener("error", (event) => {
	reportViewerError(event.error || event.message || "viewer script failed to load");
});
window.addEventListener("unhandledrejection", (event) => {
	reportViewerError(event.reason || "unhandled viewer promise rejection");
});

async function renderPdf(config) {
	if (fallback) fallback.href = config.pdf_url;
	pages.replaceChildren();
	setStatus("Loading PDF " + config.pdf_id + " revision " + config.revision + " through PDF.js…");
	const pdfjsLib = await import("/assets/pdf.mjs");
	pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";
	const pdf = await pdfjsLib.getDocument({ url: config.pdf_url }).promise;
	for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
		const page = await pdf.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 1.25 });
		const canvas = document.createElement("canvas");
		canvas.width = viewport.width;
		canvas.height = viewport.height;
		canvas.dataset.pageNumber = String(pageNumber);
		const pageContainer = document.createElement("div");
		pageContainer.style.position = "relative";
		pageContainer.style.width = String(viewport.width) + "px";
		pageContainer.style.margin = "1rem auto";
		pageContainer.dataset.pageNumber = String(pageNumber);
		pageContainer.appendChild(canvas);
		pages.appendChild(pageContainer);
		await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
		canvas.dataset.rendered = "true";
	}
	setStatus("Loaded PDF " + config.pdf_id + " revision " + config.revision + ": " + pdf.numPages + " page(s)");
}

fetch(configUrl)
	.then((response) => {
		if (!response.ok) throw new Error("config request failed: " + response.status);
		return response.json();
	})
	.then((config) => renderPdf(config))
	.catch((error) => {
		reportViewerError(error);
	});
`;

export interface ViewerHostFileSystem {
	stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
	createReadStream(path: string): Readable;
}

export interface ViewerHostViewerDispatch {
	openPdf(record: ViewerHostPdfRecord): Promise<void> | void;
	focusPdf(record: ViewerHostPdfRecord): Promise<void> | void;
	synctexForward(message: ViewerHostSynctexForwardMessage, record: ViewerHostPdfRecord): Promise<void> | void;
}

export interface ViewerHostControlStatus {
	ready: boolean;
	protocolVersion?: number;
}

interface ViewerClientTabEvent {
	type: "open_pdf" | "focus_pdf";
	pdf_id: number;
	title: string;
	revision: number;
	viewer_url: string;
	visible_tab_token: string;
}

export interface ViewerHostServerOptions {
	registry: ViewerHostPdfRegistry;
	port?: number;
	fileSystem?: ViewerHostFileSystem;
	viewerDispatch?: ViewerHostViewerDispatch;
	verifyPdfMaybeUpdated?: (record: ViewerHostPdfRecord) => Promise<void> | void;
}

export interface ViewerHostServerAddress {
	host: "127.0.0.1";
	port: number;
}

export class ViewerHostServer {
	private readonly registry: ViewerHostPdfRegistry;
	private readonly port: number;
	private readonly fileSystem: ViewerHostFileSystem;
	private readonly viewerDispatch: ViewerHostViewerDispatch;
	private readonly verifyPdfMaybeUpdated: (record: ViewerHostPdfRecord) => Promise<void> | void;
	private controlReady = false;
	private controlProtocolVersion: number | undefined;
	private server: Server | undefined;
	private activeSockets = new Set<Socket>();
	private appEventClients = new Set<ServerResponse>();
	private visibleViewerClientTabs = new Map<number, ViewerClientTabEvent>();
	private nextVisibleTabToken = 1;
	private originValue: string | undefined;
	private addressValue: ViewerHostServerAddress | undefined;

	constructor(options: ViewerHostServerOptions) {
		this.registry = options.registry;
		this.port = options.port ?? DEFAULT_PORT;
		this.fileSystem = options.fileSystem ?? { stat: statFile, createReadStream };
		this.viewerDispatch = options.viewerDispatch ?? NOOP_VIEWER_DISPATCH;
		this.verifyPdfMaybeUpdated = options.verifyPdfMaybeUpdated ?? (() => undefined);
	}

	get origin(): string {
		if (!this.originValue) throw new Error("Viewer Host Server is not started");
		return this.originValue;
	}

	get address(): ViewerHostServerAddress {
		if (!this.addressValue) throw new Error("Viewer Host Server is not started");
		return this.addressValue;
	}

	get controlStatus(): ViewerHostControlStatus {
		return {
			ready: this.controlReady,
			...(this.controlProtocolVersion === undefined ? {} : { protocolVersion: this.controlProtocolVersion }),
		};
	}

	pdfUrl(pdfId: number, revision: number): string {
		return `${this.origin}/pdf/${pdfId}?revision=${revision}`;
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((request, response) => {
			void this.handleHttpRequest(request, response).catch(() => {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				textResponse(response, 500, "text/plain; charset=utf-8", "viewer host request failed", request.method === "HEAD");
			});
		});
		server.on("connection", (socket) => {
			this.activeSockets.add(socket);
			socket.once("close", () => this.activeSockets.delete(socket));
		});
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ host: LOCAL_HOST, port: this.port }, () => {
					server.off("error", reject);
					resolve();
				});
			});
		} catch (error) {
			this.server = undefined;
			this.originValue = undefined;
			this.addressValue = undefined;
			for (const socket of this.activeSockets) socket.destroy();
			throw error;
		}
		const address = server.address() as AddressInfo | null;
		if (!address || typeof address === "string") {
			throw new Error("Viewer Host Server did not expose a TCP address");
		}
		this.addressValue = { host: LOCAL_HOST, port: address.port };
		this.originValue = `http://${LOCAL_HOST}:${address.port}`;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.originValue = undefined;
		this.addressValue = undefined;
		this.controlReady = false;
		this.controlProtocolVersion = undefined;
		this.visibleViewerClientTabs.clear();
		for (const socket of this.activeSockets) {
			socket.destroy();
		}
		this.appEventClients.clear();
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${LOCAL_HOST}`);
		if (requestUrl.pathname === "/control") {
			await this.handleControlRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/app-events") {
			this.handleAppEventsRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/app-tab-closed") {
			await this.handleAppTabClosedRequest(request, response);
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			textResponse(response, 405, "text/plain; charset=utf-8", "method not allowed", false);
			return;
		}

		if (requestUrl.pathname === "/app") {
			this.serveAppShell(response, request.method === "HEAD");
			return;
		}

		const viewerMatch = /^\/viewer\/(\d+)$/.exec(requestUrl.pathname);
		if (viewerMatch) {
			const pdfId = parsePositiveInteger(viewerMatch[1]);
			if (pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id", request.method === "HEAD");
				return;
			}
			this.serveViewerShell(response, pdfId, request.method === "HEAD");
			return;
		}

		const configMatch = /^\/config\/(\d+)\.json$/.exec(requestUrl.pathname);
		if (configMatch) {
			const pdfId = parsePositiveInteger(configMatch[1]);
			if (pdfId === undefined) {
				textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }), request.method === "HEAD");
				return;
			}
			this.serveViewerConfig(response, pdfId, request.method === "HEAD");
			return;
		}

		if (requestUrl.pathname === "/assets/viewer-client-tabs.js") {
			textResponse(response, 200, "text/javascript; charset=utf-8", VIEWER_CLIENT_TABS_SCRIPT, request.method === "HEAD");
			return;
		}

		if (requestUrl.pathname === "/assets/viewer.js") {
			textResponse(response, 200, "text/javascript; charset=utf-8", VIEWER_SCRIPT, request.method === "HEAD");
			return;
		}

		const pdfJsAssetPath = LOCAL_PDFJS_ASSETS.get(requestUrl.pathname);
		if (pdfJsAssetPath !== undefined) {
			this.serveLocalPdfJsAsset(response, pdfJsAssetPath, request.method === "HEAD");
			return;
		}

		const pdfMatch = /^\/pdf\/(\d+)$/.exec(requestUrl.pathname);
		if (pdfMatch) {
			const pdfId = parsePositiveInteger(pdfMatch[1]);
			const revision = parsePositiveInteger(requestUrl.searchParams.get("revision") ?? undefined);
			if (pdfId === undefined || revision === undefined) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id or revision", request.method === "HEAD");
				return;
			}
			await this.servePdf(response, pdfId, revision, request.method === "HEAD");
			return;
		}

		textResponse(response, 404, "text/plain; charset=utf-8", "not found", request.method === "HEAD");
	}

	private handleAppEventsRequest(request: IncomingMessage, response: ServerResponse): void {
		if (request.method !== "GET") {
			textResponse(response, 405, "text/plain; charset=utf-8", "app event stream requires GET", false);
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		this.appEventClients.add(response);
		writeAppEvent(response, { type: "ready" });
		for (const event of this.visibleViewerClientTabs.values()) {
			writeAppEvent(response, event);
		}
		request.once("close", () => this.appEventClients.delete(response));
	}

	private async handleAppTabClosedRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			textResponse(response, 405, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "method_not_allowed" }), false);
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "malformed_json" }), false);
			return;
		}
		if (!isAppTabClosedPayload(payload)) {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "invalid_close_payload" }), false);
			return;
		}
		const current = this.visibleViewerClientTabs.get(payload.pdf_id);
		if (current?.revision === payload.revision && current.viewer_url === payload.viewer_url && current.visible_tab_token === payload.visible_tab_token) {
			this.visibleViewerClientTabs.delete(payload.pdf_id);
		}
		textResponse(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }), false);
	}

	private serveAppShell(response: ServerResponse, headOnly: boolean): void {
		const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viewer Client</title>
<style>
body{font-family:sans-serif;margin:0;background:#f7f7f7;color:#222}
#viewer-client-app{display:flex;flex-direction:column;height:100vh}
header{display:flex;align-items:center;gap:1rem;padding:.5rem .75rem;background:#1f2937;color:white}
h1{font-size:1rem;margin:0;white-space:nowrap}
[role=tablist]{display:flex;gap:.25rem;overflow:auto}
.tab-item{display:flex;background:#374151;border-radius:.25rem;overflow:hidden}
button{font:inherit}
[role=tab],button[data-close-pdf-id]{border:0;color:white;background:transparent;padding:.35rem .55rem;cursor:pointer}
[role=tab][aria-selected=true]{background:#f7f7f7;color:#111827}
button[data-close-pdf-id]{border-left:1px solid #4b5563}
#empty-state{margin:2rem;text-align:center;color:#555}
#viewer-panels{flex:1;min-height:0}
[role=tabpanel]{height:100%}
iframe{width:100%;height:100%;border:0;background:white}
</style>
</head>
<body>
<main id="viewer-client-app">
<header>
<h1>Viewer Client</h1>
<nav id="tab-list" role="tablist" aria-label="Open PDFs"></nav>
</header>
<p id="empty-state">No PDF is open.</p>
<div id="viewer-panels"></div>
</main>
<script type="module" src="/assets/viewer-client-tabs.js"></script>
</body>
</html>`;
		textResponse(response, 200, "text/html; charset=utf-8", body, headOnly);
	}

	private serveViewerShell(response: ServerResponse, pdfId: number, headOnly: boolean): void {
		const record = this.registry.getPdf(pdfId);
		const fallbackUrl = `/pdf/${record.pdfId}?revision=${record.revision}`;
		const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF.js viewer ${pdfId}</title>
<style>body{font-family:sans-serif;margin:1rem;background:#f7f7f7}canvas{display:block;background:white;box-shadow:0 1px 8px #999}#status{margin-bottom:1rem}</style>
</head>
<body data-config-url="/config/${pdfId}.json">
<h1>PDF.js viewer</h1>
<p id="status">Loading PDF.js viewer for pdf_id=${pdfId}…</p>
<p><a id="fallback-link" href="${fallbackUrl}">Open registered PDF bytes directly</a></p>
<div id="pages"></div>
<script>
(function () {
	function setFailure(message) {
		var status = document.getElementById("status");
		if (status) status.textContent = message + " Use the direct PDF link below.";
	}
	window.addEventListener("error", function (event) {
		if (event.target && event.target.tagName === "SCRIPT") {
			setFailure("Unable to load PDF.js viewer script: viewer script failed to load.");
		}
	});
	window.addEventListener("unhandledrejection", function (event) {
		var reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || "unhandled viewer promise rejection");
		setFailure("Unable to load PDF.js viewer script: " + reason + ".");
	});
}());
</script>
<script type="module" src="/assets/viewer.js" onerror="document.getElementById('status').textContent='Unable to load PDF.js viewer script: viewer script failed to load. Use the direct PDF link below.'"></script>
<script nomodule>document.getElementById("status").textContent = "Unable to load PDF.js viewer script: this browser does not support JavaScript modules. Use the direct PDF link below.";</script>
</body>
</html>`;
		textResponse(response, 200, "text/html; charset=utf-8", body, headOnly);
	}

	private serveViewerConfig(response: ServerResponse, pdfId: number, headOnly: boolean): void {
		let record: ViewerHostPdfRecord;
		try {
			record = this.registry.getPdf(pdfId);
		} catch {
			textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }), headOnly);
			return;
		}
		const viewerSocketUrl = `${this.origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${record.pdfId}`;
		const body = JSON.stringify({
			pdf_id: record.pdfId,
			revision: record.revision,
			pdf_url: this.pdfUrl(record.pdfId, record.revision),
			viewer_socket_url: viewerSocketUrl,
			ws_url: viewerSocketUrl,
		});
		textResponse(response, 200, "application/json; charset=utf-8", body, headOnly);
	}

	private serveLocalPdfJsAsset(response: ServerResponse, path: string, headOnly: boolean): void {
		try {
			binaryResponse(response, 200, "text/javascript; charset=utf-8", readFileSync(path), headOnly);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "PDF.js asset is not readable", headOnly);
		}
	}

	private hasRegisteredPdf(pdfId: number): boolean {
		try {
			this.registry.getPdf(pdfId);
			return true;
		} catch {
			return false;
		}
	}

	private async handleControlRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "control channel requires POST" } });
			return;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "control request body must be valid JSON" } });
			return;
		}

		let message: ReturnType<typeof validateMcpToViewerHostMessage>;
		try {
			message = validateMcpToViewerHostMessage(payload);
		} catch (error) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_message", message: errorMessage(error) } });
			return;
		}

		try {
			jsonResponse(response, 200, await this.dispatchControlMessage(message));
		} catch (error) {
			const message = errorMessage(error);
			const unknownPdf = /^Unknown pdf_id=/.test(message);
			jsonResponse(response, unknownPdf ? 404 : 400, { ok: false, error: { code: unknownPdf ? "unknown_pdf" : "control_dispatch_failed", message } });
		}
	}

	private async dispatchControlMessage(message: ReturnType<typeof validateMcpToViewerHostMessage>): Promise<ViewerHostControlResponse> {
		switch (message.type) {
			case "hello":
				if (message.protocol_version !== VIEWER_HOST_PROTOCOL_VERSION) {
					return { ok: false, error: { code: "unsupported_protocol_version", message: `unsupported protocol_version=${message.protocol_version}` } };
				}
				this.controlReady = true;
				this.controlProtocolVersion = message.protocol_version;
				return { ok: true, message: { type: "ready", protocol_version: VIEWER_HOST_PROTOCOL_VERSION, origin: this.origin } };
			case "open_pdf": {
				const snapshot = await snapshotRegisteredPdf(this.fileSystem, message.pdf_path);
				const revision = this.nextRegistrationRevision(message.pdf_id, message.pdf_path, snapshot);
				const record = this.registry.registerPdf({
					pdfId: message.pdf_id,
					pdfPath: message.pdf_path,
					title: message.title ?? basename(message.pdf_path),
					revision,
					fileSnapshot: snapshot,
				});
				await this.viewerDispatch.openPdf(record);
				this.broadcastViewerClientTabEvent("open_pdf", record);
				return { ok: true, result: { type: "open_pdf", pdf_id: record.pdfId, revision: record.revision } };
			}
			case "focus_pdf": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.viewerDispatch.focusPdf(record);
				this.broadcastViewerClientTabEvent("focus_pdf", record);
				return { ok: true, result: { type: "focus_pdf", pdf_id: record.pdfId } };
			}
			case "synctex_forward": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.viewerDispatch.synctexForward(message, record);
				return { ok: true, result: { type: "synctex_forward", pdf_id: record.pdfId } };
			}
			case "pdf_maybe_updated": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.verifyPdfMaybeUpdated(record);
				return { ok: true, result: { type: "pdf_maybe_updated", pdf_id: record.pdfId } };
			}
		}
	}

	private broadcastViewerClientTabEvent(type: ViewerClientTabEvent["type"], record: ViewerHostPdfRecord): void {
		const event: ViewerClientTabEvent = {
			type,
			pdf_id: record.pdfId,
			title: record.title,
			revision: record.revision,
			viewer_url: `/viewer/${record.pdfId}?revision=${record.revision}`,
			visible_tab_token: this.createVisibleTabToken(),
		};
		this.visibleViewerClientTabs.delete(record.pdfId);
		this.visibleViewerClientTabs.set(record.pdfId, event);
		this.broadcastAppEvent(event);
	}

	private createVisibleTabToken(): string {
		const token = `visible-tab-${this.nextVisibleTabToken}`;
		this.nextVisibleTabToken += 1;
		return token;
	}

	private broadcastAppEvent(event: ViewerClientTabEvent | { type: "ready" }): void {
		for (const client of this.appEventClients) {
			writeAppEvent(client, event);
		}
	}

	private nextRegistrationRevision(pdfId: number, pdfPath: string, snapshot: { size: number; mtimeMs: number }): number {
		try {
			const existing = this.registry.getPdf(pdfId);
			return existing.pdfPath === resolve(pdfPath) && isSnapshotMatch(existing.fileSnapshot, snapshot) ? existing.revision : existing.revision + 1;
		} catch {
			return 1;
		}
	}

	private async servePdf(response: ServerResponse, pdfId: number, revision: number, headOnly: boolean): Promise<void> {
		let record: ViewerHostPdfRecord;
		try {
			record = this.registry.getPdf(pdfId);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id", headOnly);
			return;
		}
		if (revision !== record.revision) {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown revision", headOnly);
			return;
		}

		let fileStatus: Awaited<ReturnType<ViewerHostFileSystem["stat"]>>;
		try {
			fileStatus = await this.fileSystem.stat(record.pdfPath);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not readable", headOnly);
			return;
		}
		if (!fileStatus.isFile()) {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not a regular file", headOnly);
			return;
		}
		if (!isSnapshotMatch(record.fileSnapshot, fileStatus)) {
			textResponse(response, 409, "text/plain; charset=utf-8", "stale PDF snapshot mismatch", headOnly, { "x-viewer-host-error": "stale_pdf_snapshot" });
			return;
		}

		response.writeHead(200, {
			"content-type": "application/pdf",
			"content-length": fileStatus.size,
			"cache-control": "no-store",
			"content-disposition": contentDispositionForPdf(record.title || basename(record.pdfPath)),
		});
		if (headOnly) {
			response.end();
			return;
		}
		const stream = this.fileSystem.createReadStream(record.pdfPath);
		stream.once("error", () => response.destroy());
		response.once("close", () => stream.destroy());
		stream.pipe(response);
	}
}

const NOOP_VIEWER_DISPATCH: ViewerHostViewerDispatch = {
	openPdf() {},
	focusPdf() {},
	synctexForward() {},
};

async function snapshotRegisteredPdf(fileSystem: ViewerHostFileSystem, pdfPath: string): Promise<{ size: number; mtimeMs: number }> {
	let fileStatus: Awaited<ReturnType<ViewerHostFileSystem["stat"]>>;
	try {
		fileStatus = await fileSystem.stat(pdfPath);
	} catch {
		throw new Error("registered PDF is not readable");
	}
	if (!fileStatus.isFile()) {
		throw new Error("registered PDF is not a regular file");
	}
	return { size: fileStatus.size, mtimeMs: fileStatus.mtimeMs };
}

function writeAppEvent(response: ServerResponse, event: ViewerClientTabEvent | { type: "ready" }): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isAppTabClosedPayload(payload: unknown): payload is { pdf_id: number; revision: number; viewer_url: string; visible_tab_token: string } {
	return typeof payload === "object"
		&& payload !== null
		&& Number.isInteger((payload as { pdf_id?: unknown }).pdf_id)
		&& (payload as { pdf_id: number }).pdf_id > 0
		&& Number.isInteger((payload as { revision?: unknown }).revision)
		&& (payload as { revision: number }).revision > 0
		&& typeof (payload as { viewer_url?: unknown }).viewer_url === "string"
		&& !!(payload as { viewer_url: string }).viewer_url
		&& typeof (payload as { visible_tab_token?: unknown }).visible_tab_token === "string"
		&& !!(payload as { visible_tab_token: string }).visible_tab_token;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > 1_000_000) {
			throw new Error("control request body is too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(response: ServerResponse, status: number, body: ViewerHostControlResponse): void {
	const json = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(json, "utf8"),
		"cache-control": "no-store",
	});
	response.end(json);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function textResponse(response: ServerResponse, status: number, contentType: string, body: string, headOnly: boolean, headers: Record<string, string> = {}): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(body, "utf8"),
		"cache-control": "no-store",
		...headers,
	});
	response.end(headOnly ? undefined : body);
}

function binaryResponse(response: ServerResponse, status: number, contentType: string, body: Buffer, headOnly: boolean): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": body.length,
		"cache-control": "no-store",
	});
	response.end(headOnly ? undefined : body);
}

function isSnapshotMatch(expected: { size: number; mtimeMs: number }, actual: { size: number; mtimeMs: number }): boolean {
	return expected.size === actual.size && expected.mtimeMs === actual.mtimeMs;
}

function contentDispositionForPdf(title: string): string {
	const filename = safePdfFilename(title.endsWith(".pdf") ? title : `${title}.pdf`);
	return `inline; filename="${asciiFallbackFilename(filename)}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

function safePdfFilename(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim() || "document.pdf";
}

function asciiFallbackFilename(value: string): string {
	return safePdfFilename(value).replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "_").trim() || "document.pdf";
}

function rfc5987Encode(value: string): string {
	return encodeURIComponent(value)
		.replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(/\*/g, "%2A");
}

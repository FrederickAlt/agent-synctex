import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { basename, resolve } from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import { validateMcpToViewerHostMessage, validateViewerHostToMcpMessage, VIEWER_HOST_PROTOCOL_VERSION, type ViewerHostControlResponse, type ViewerHostSynctexForwardMessage, type ViewerHostToMcpMessage } from "./viewer_host_protocol.ts";
import type { ViewerHostFileSnapshot, ViewerHostPdfRecord, ViewerHostPdfRegistry } from "./viewer_host_registry.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const MAX_VIEWER_SOCKET_MESSAGE_BYTES = 64 * 1024;
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

let activeConfig;
let viewerSocket;
const pageViewports = new Map();

function reverseSynctexPayloadFromViewportPoint(input) {
	const point = input.viewport.convertToPdfPoint(input.viewportX, input.viewportY);
	return { type: "reverse_synctex", page: input.page, x: point[0], y: point[1] };
}

function viewportScale(input) {
	const origin = input.viewport.convertToViewportPoint(0, 0);
	const xUnit = input.viewport.convertToViewportPoint(1, 0);
	const yUnit = input.viewport.convertToViewportPoint(0, 1);
	return { x: Math.abs(xUnit[0] - origin[0]) || 1, y: Math.abs(yUnit[1] - origin[1]) || 1 };
}

function forwardSynctexMarkerFromPdfPoint(input) {
	const scale = viewportScale(input);
	const point = input.viewport.convertToViewportPoint(input.pdfX, input.pdfY);
	const pageHeight = input.pageHeight ?? input.viewport.convertToViewportPoint(0, 0)[1];
	const position = { left: point[0], top: pageHeight - point[1] };
	if (input.width === undefined || input.height === undefined) return position;
	return { ...position, width: input.width * scale.x, height: input.height * scale.y };
}

async function renderPdf(config) {
	activeConfig = config;
	if (fallback) fallback.href = config.pdf_url;
	pageViewports.clear();
	pages.replaceChildren();
	setStatus("Loading PDF " + config.pdf_id + " revision " + config.revision + " through PDF.js…");
	const pdfjsLib = await import("/assets/pdf.mjs");
	pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";
	const pdf = await pdfjsLib.getDocument({ url: config.pdf_url }).promise;
	for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
		const page = await pdf.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 1.25 });
		pageViewports.set(pageNumber, viewport);
		const canvas = document.createElement("canvas");
		canvas.width = viewport.width;
		canvas.height = viewport.height;
		canvas.dataset.pageNumber = String(pageNumber);
		canvas.addEventListener("click", (event) => {
			if (!viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return;
			const rect = canvas.getBoundingClientRect();
			const payload = reverseSynctexPayloadFromViewportPoint({ page: pageNumber, viewportX: event.clientX - rect.left, viewportY: event.clientY - rect.top, viewport });
			viewerSocket.send(JSON.stringify(payload));
		});
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

function showSynctexMarker(message) {
	const pageNumber = Number(message.page);
	const page = pages.querySelector("[data-page-number='" + String(pageNumber) + "']");
	const viewport = pageViewports.get(pageNumber);
	if (!page || !viewport) return;
	let marker = page.querySelector("[data-synctex-marker]");
	if (!marker) {
		marker = document.createElement("div");
		marker.dataset.synctexMarker = "true";
		marker.tabIndex = -1;
		marker.style.position = "absolute";
		marker.style.pointerEvents = "none";
		marker.style.zIndex = "100000";
		page.appendChild(marker);
	}
	const isCircle = message.width === undefined || message.height === undefined;
	const position = forwardSynctexMarkerFromPdfPoint({ pdfX: message.x, pdfY: message.y, width: message.width, height: message.height, pageHeight: page.getBoundingClientRect().height, viewport });
	marker.dataset.synctexMarkerKind = isCircle ? "circle" : "rect";
	marker.style.left = String(position.left) + "px";
	marker.style.top = String(position.top) + "px";
	marker.style.border = isCircle ? "0.2em solid red" : "2px solid #ef4444";
	marker.style.borderRadius = isCircle ? "50%" : "0";
	marker.style.background = isCircle ? "rgba(255,0,0,0.4)" : "rgba(239,68,68,.18)";
	marker.style.transform = isCircle ? "translate(-50%, -50%)" : "";
	marker.style.opacity = isCircle ? "0.8" : "";
	marker.style.width = isCircle ? "0.5em" : String(position.width) + "px";
	marker.style.height = isCircle ? "0.5em" : String(position.height) + "px";
	marker.scrollIntoView({ block: "center", inline: "center" });
	marker.focus({ preventScroll: true });
}

function connectViewerSocket(config) {
	if (!config.viewer_socket_url || !("WebSocket" in window)) return;
	viewerSocket = new WebSocket(config.viewer_socket_url);
	viewerSocket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.type === "pdf_refresh") {
			const nextConfig = { ...activeConfig, revision: message.revision, pdf_url: message.pdf_url };
			void renderPdf(nextConfig).catch(reportViewerError);
		} else if (message.type === "synctex_forward") {
			showSynctexMarker(message);
		}
	});
}

fetch(configUrl)
	.then((response) => {
		if (!response.ok) throw new Error("config request failed: " + response.status);
		return response.json();
	})
	.then((config) => {
		connectViewerSocket(config);
		return renderPdf(config);
	})
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

export interface ViewerHostPdfChangeDetectionOptions {
	debounceMs?: number;
	pollIntervalMs?: number;
	nowMs?: () => number;
}

export interface ViewerHostPdfRefreshDiagnostic {
	pdf_id: number;
	status: "error";
	code: "pdf_not_readable" | "pdf_not_regular_file";
	message: string;
}

interface ViewerClientTabEvent {
	type: "open_pdf" | "focus_pdf";
	pdf_id: number;
	title: string;
	revision: number;
	viewer_url: string;
	visible_tab_token: string;
}

interface ViewerSocketConnection {
	pdfId: number;
	socket: Socket;
	buffer: Buffer;
	closed: boolean;
}

interface PendingPdfRefreshSnapshot {
	snapshot: ViewerHostFileSnapshot;
	observedAtMs: number;
}

export interface ViewerHostServerOptions {
	registry: ViewerHostPdfRegistry;
	port?: number;
	fileSystem?: ViewerHostFileSystem;
	viewerDispatch?: ViewerHostViewerDispatch;
	verifyPdfMaybeUpdated?: (record: ViewerHostPdfRecord) => Promise<void> | void;
	mcpEventSink?: (message: ViewerHostToMcpMessage) => Promise<void> | void;
	pdfChangeDetection?: ViewerHostPdfChangeDetectionOptions;
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
	private readonly mcpEventSink: (message: ViewerHostToMcpMessage) => Promise<void> | void;
	private readonly pdfChangeDebounceMs: number;
	private readonly pdfChangePollIntervalMs: number;
	private readonly nowMs: () => number;
	private controlReady = false;
	private controlProtocolVersion: number | undefined;
	private server: Server | undefined;
	private activeSockets = new Set<Socket>();
	private appEventClients = new Set<ServerResponse>();
	private readonly mcpEventBacklog: ViewerHostToMcpMessage[] = [];
	private viewerSocketClientsByPdfId = new Map<number, Set<ViewerSocketConnection>>();
	private viewerSocketTokensByPdfId = new Map<number, string>();
	private visibleViewerClientTabs = new Map<number, ViewerClientTabEvent>();
	private pendingPdfRefreshSnapshots = new Map<number, PendingPdfRefreshSnapshot>();
	private pdfRefreshDiagnostics = new Map<number, ViewerHostPdfRefreshDiagnostic>();
	private pdfChangePollTimer: ReturnType<typeof setInterval> | undefined;
	private pdfChangePollInFlight = false;
	private nextVisibleTabToken = 1;
	private originValue: string | undefined;
	private addressValue: ViewerHostServerAddress | undefined;

	constructor(options: ViewerHostServerOptions) {
		this.registry = options.registry;
		this.port = options.port ?? DEFAULT_PORT;
		this.fileSystem = options.fileSystem ?? { stat: statFile, createReadStream };
		this.viewerDispatch = options.viewerDispatch ?? NOOP_VIEWER_DISPATCH;
		this.verifyPdfMaybeUpdated = options.verifyPdfMaybeUpdated ?? (() => undefined);
		this.mcpEventSink = options.mcpEventSink ?? (() => undefined);
		this.pdfChangeDebounceMs = nonNegativeNumber(options.pdfChangeDetection?.debounceMs, 250);
		this.pdfChangePollIntervalMs = nonNegativeNumber(options.pdfChangeDetection?.pollIntervalMs, 1_000);
		this.nowMs = options.pdfChangeDetection?.nowMs ?? (() => Date.now());
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

	getConnectedViewerCount(pdfId: number): number {
		this.registry.getPdf(pdfId);
		return this.viewerSocketClientsByPdfId.get(pdfId)?.size ?? 0;
	}

	sendPdfRefresh(pdfId: number): number {
		const record = this.registry.getPdf(pdfId);
		return this.broadcastViewerSocketMessage(record.pdfId, { type: "pdf_refresh", pdf_id: record.pdfId, revision: record.revision, pdf_url: this.pdfUrl(record.pdfId, record.revision) });
	}

	getPdfRefreshDiagnostic(pdfId: number): ViewerHostPdfRefreshDiagnostic | undefined {
		this.registry.getPdf(pdfId);
		const diagnostic = this.pdfRefreshDiagnostics.get(pdfId);
		return diagnostic ? { ...diagnostic } : undefined;
	}

	async verifyPdfChangesNow(pdfId?: number): Promise<void> {
		const records = pdfId === undefined ? this.registry.listPdfs() : [this.registry.getPdf(pdfId)];
		for (const record of records) {
			await this.verifyPdfRecordSnapshot(record);
		}
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
		server.on("upgrade", (request, socket, head) => {
			this.handleViewerSocketUpgrade(request, socket as Socket, head);
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
		this.startPdfChangePolling();
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.originValue = undefined;
		this.addressValue = undefined;
		this.controlReady = false;
		this.controlProtocolVersion = undefined;
		this.visibleViewerClientTabs.clear();
		this.mcpEventBacklog.splice(0);
		this.pendingPdfRefreshSnapshots.clear();
		this.pdfRefreshDiagnostics.clear();
		this.stopPdfChangePolling();
		this.viewerSocketClientsByPdfId.clear();
		this.viewerSocketTokensByPdfId.clear();
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
		if (requestUrl.pathname === "/mcp-events/drain") {
			this.handleMcpEventsDrainRequest(request, response);
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

	private handleMcpEventsDrainRequest(request: IncomingMessage, response: ServerResponse): void {
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "MCP event drain requires POST" } });
			return;
		}
		const events = this.mcpEventBacklog.splice(0);
		jsonResponse(response, 200, { ok: true, events });
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
		const token = this.viewerSocketTokenForPdf(record.pdfId);
		const viewerSocketUrl = `${this.origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${record.pdfId}&token=${encodeURIComponent(token)}`;
		const body = JSON.stringify({
			pdf_id: record.pdfId,
			revision: record.revision,
			pdf_url: this.pdfUrl(record.pdfId, record.revision),
			viewer_socket_url: viewerSocketUrl,
			ws_url: viewerSocketUrl,
			viewer_socket_token: token,
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
				this.pendingPdfRefreshSnapshots.delete(record.pdfId);
				this.pdfRefreshDiagnostics.delete(record.pdfId);
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
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "synctex_forward", pdf_id: record.pdfId } };
			}
			case "pdf_maybe_updated": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.verifyPdfChangesNow(record.pdfId);
				await this.verifyPdfMaybeUpdated(record);
				return { ok: true, result: { type: "pdf_maybe_updated", pdf_id: record.pdfId } };
			}
		}
	}

	private handleViewerSocketUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${LOCAL_HOST}`);
		const pdfId = parsePositiveInteger(requestUrl.searchParams.get("pdf_id") ?? undefined);
		if (requestUrl.pathname !== "/viewer-socket" || pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
			rejectWebSocketUpgrade(socket, 404, "unknown pdf_id");
			return;
		}
		if (!isAllowedViewerSocketOrigin(request.headers.origin, this.origin)) {
			rejectWebSocketUpgrade(socket, 403, "forbidden origin");
			return;
		}
		const token = requestUrl.searchParams.get("token") ?? "";
		if (token !== this.viewerSocketTokenForPdf(pdfId)) {
			rejectWebSocketUpgrade(socket, 403, "invalid viewer socket token");
			return;
		}
		const headerError = validateWebSocketUpgradeHeaders(request);
		if (headerError) {
			rejectWebSocketUpgrade(socket, 400, headerError);
			return;
		}
		const key = request.headers["sec-websocket-key"] as string;
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"",
			"",
		].join("\r\n"));
		const connection: ViewerSocketConnection = { pdfId, socket, buffer: Buffer.alloc(0), closed: false };
		let clients = this.viewerSocketClientsByPdfId.get(pdfId);
		if (!clients) {
			clients = new Set<ViewerSocketConnection>();
			this.viewerSocketClientsByPdfId.set(pdfId, clients);
		}
		clients.add(connection);
		const cleanup = () => this.cleanupViewerSocket(connection);
		socket.once("close", cleanup);
		socket.once("end", cleanup);
		socket.once("error", cleanup);
		socket.on("data", (chunk) => this.handleViewerSocketData(connection, chunk));
		if (head.length > 0) this.handleViewerSocketData(connection, head);
	}

	private handleViewerSocketData(connection: ViewerSocketConnection, chunk: Buffer): void {
		if (connection.closed) return;
		connection.buffer = Buffer.concat([connection.buffer, chunk]);
		if (connection.buffer.length > MAX_VIEWER_SOCKET_MESSAGE_BYTES + 14) {
			this.closeViewerSocket(connection);
			return;
		}
		while (connection.buffer.length > 0) {
			let frame: { fin: boolean; opcode: number; masked: boolean; payload: Buffer; bytesRead: number } | undefined;
			try {
				frame = readWebSocketFrame(connection.buffer);
			} catch {
				this.closeViewerSocket(connection);
				return;
			}
			if (!frame) return;
			connection.buffer = connection.buffer.subarray(frame.bytesRead);
			if (!frame.fin || !frame.masked) {
				this.closeViewerSocket(connection);
				return;
			}
			if (frame.opcode === 0x8) {
				this.closeViewerSocket(connection);
				return;
			}
			if (frame.opcode === 0x9) {
				sendWebSocketFrame(connection.socket, 0xA, frame.payload);
				continue;
			}
			if (frame.opcode !== 0x1) continue;
			this.handleViewerSocketText(connection, frame.payload.toString("utf8"));
		}
	}

	private handleViewerSocketText(connection: ViewerSocketConnection, text: string): void {
		let payload: unknown;
		try {
			payload = JSON.parse(text);
			if (!isRecord(payload) || payload.type !== "reverse_synctex") return;
			if (payload.pdf_id !== undefined && payload.pdf_id !== connection.pdfId) {
				throw new Error(`reverse_synctex pdf_id=${String(payload.pdf_id)} does not match viewer socket pdf_id=${connection.pdfId}`);
			}
			const message = validateViewerHostToMcpMessage({ ...payload, pdf_id: connection.pdfId });
			this.mcpEventBacklog.push(message);
			void Promise.resolve(this.mcpEventSink(message)).catch((error: unknown) => {
				if (!connection.closed) sendViewerSocketJson(connection, { type: "error", code: "reverse_synctex_failed", message: errorMessage(error) });
			});
		} catch (error) {
			sendViewerSocketJson(connection, { type: "error", code: "invalid_viewer_message", message: errorMessage(error) });
		}
	}

	private closeViewerSocket(connection: ViewerSocketConnection): void {
		if (!connection.closed) sendWebSocketFrame(connection.socket, 0x8, Buffer.alloc(0));
		connection.socket.end();
		this.cleanupViewerSocket(connection);
	}

	private cleanupViewerSocket(connection: ViewerSocketConnection): void {
		if (connection.closed) return;
		connection.closed = true;
		const clients = this.viewerSocketClientsByPdfId.get(connection.pdfId);
		clients?.delete(connection);
		if (clients?.size === 0) this.viewerSocketClientsByPdfId.delete(connection.pdfId);
	}

	private broadcastViewerSocketMessage(pdfId: number, message: object): number {
		const clients = this.viewerSocketClientsByPdfId.get(pdfId);
		if (!clients) return 0;
		let delivered = 0;
		for (const connection of clients) {
			if (connection.closed) continue;
			sendViewerSocketJson(connection, message);
			delivered += 1;
		}
		return delivered;
	}

	private viewerSocketTokenForPdf(pdfId: number): string {
		this.registry.getPdf(pdfId);
		let token = this.viewerSocketTokensByPdfId.get(pdfId);
		if (!token) {
			token = randomBytes(32).toString("base64url");
			this.viewerSocketTokensByPdfId.set(pdfId, token);
		}
		return token;
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

	private startPdfChangePolling(): void {
		if (this.pdfChangePollIntervalMs <= 0 || this.pdfChangePollTimer) return;
		this.pdfChangePollTimer = setInterval(() => {
			if (this.pdfChangePollInFlight) return;
			this.pdfChangePollInFlight = true;
			void this.verifyPdfChangesNow()
				.catch(() => undefined)
				.finally(() => { this.pdfChangePollInFlight = false; });
		}, this.pdfChangePollIntervalMs);
		this.pdfChangePollTimer.unref?.();
	}

	private stopPdfChangePolling(): void {
		if (!this.pdfChangePollTimer) return;
		clearInterval(this.pdfChangePollTimer);
		this.pdfChangePollTimer = undefined;
		this.pdfChangePollInFlight = false;
	}

	private async verifyPdfRecordSnapshot(record: ViewerHostPdfRecord): Promise<void> {
		let snapshot: ViewerHostFileSnapshot;
		try {
			snapshot = await snapshotRegisteredPdf(this.fileSystem, record.pdfPath);
			await assertRegisteredPdfReadable(this.fileSystem, record.pdfPath);
		} catch (error) {
			this.pendingPdfRefreshSnapshots.delete(record.pdfId);
			this.pdfRefreshDiagnostics.set(record.pdfId, diagnosticForSnapshotError(record.pdfId, error));
			return;
		}

		this.pdfRefreshDiagnostics.delete(record.pdfId);
		if (isSnapshotMatch(record.fileSnapshot, snapshot)) {
			this.pendingPdfRefreshSnapshots.delete(record.pdfId);
			return;
		}

		const pending = this.pendingPdfRefreshSnapshots.get(record.pdfId);
		const now = this.nowMs();
		if (!pending || !isSnapshotMatch(pending.snapshot, snapshot)) {
			this.pendingPdfRefreshSnapshots.set(record.pdfId, { snapshot, observedAtMs: now });
			return;
		}
		if (now - pending.observedAtMs < this.pdfChangeDebounceMs) return;

		this.pendingPdfRefreshSnapshots.delete(record.pdfId);
		this.registry.registerPdf({
			pdfId: record.pdfId,
			pdfPath: record.pdfPath,
			title: record.title,
			revision: record.revision + 1,
			fileSnapshot: snapshot,
		});
		this.sendPdfRefresh(record.pdfId);
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

function rejectWebSocketUpgrade(socket: Socket, status: number, message: string): void {
	const body = `${message}\n`;
	socket.write([
		`HTTP/1.1 ${status} ${webSocketRejectReason(status)}`,
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${Buffer.byteLength(body, "utf8")}`,
		"",
		body,
	].join("\r\n"));
	socket.destroy();
}

function sendViewerSocketJson(connection: ViewerSocketConnection, message: object): void {
	sendWebSocketFrame(connection.socket, 0x1, Buffer.from(JSON.stringify(message), "utf8"));
}

function sendWebSocketFrame(socket: Socket, opcode: number, payload: Buffer): void {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	socket.write(Buffer.concat([header, payload]));
}

function readWebSocketFrame(buffer: Buffer): { fin: boolean; opcode: number; masked: boolean; payload: Buffer; bytesRead: number } | undefined {
	if (buffer.length < 2) return undefined;
	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	const masked = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < offset + 2) return undefined;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined;
		const bigLength = buffer.readBigUInt64BE(offset);
		if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
		length = Number(bigLength);
		offset += 8;
	}
	if (length > MAX_VIEWER_SOCKET_MESSAGE_BYTES) throw new Error("WebSocket frame is too large");
	const maskLength = masked ? 4 : 0;
	if (buffer.length < offset + maskLength + length) return undefined;
	let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
	if (masked) {
		const mask = buffer.subarray(offset, offset + 4);
		const unmasked = Buffer.alloc(payload.length);
		for (let index = 0; index < payload.length; index += 1) {
			unmasked[index] = payload[index] ^ mask[index % 4];
		}
		payload = unmasked;
	}
	return { fin, opcode, masked, payload, bytesRead: offset + maskLength + length };
}

function validateWebSocketUpgradeHeaders(request: IncomingMessage): string | undefined {
	if (String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") return "invalid websocket upgrade";
	const connection = String(request.headers.connection ?? "").toLowerCase().split(",").map((part) => part.trim());
	if (!connection.includes("upgrade")) return "invalid websocket connection header";
	if (request.headers["sec-websocket-version"] !== "13") return "unsupported websocket version";
	const key = request.headers["sec-websocket-key"];
	if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) return "invalid sec-websocket-key";
	return undefined;
}

function isAllowedViewerSocketOrigin(origin: string | undefined, expectedOrigin: string): boolean {
	return origin === undefined || origin === expectedOrigin;
}

function webSocketRejectReason(status: number): string {
	if (status === 400) return "Bad Request";
	if (status === 403) return "Forbidden";
	if (status === 404) return "Not Found";
	return "Rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function snapshotRegisteredPdf(fileSystem: ViewerHostFileSystem, pdfPath: string): Promise<{ size: number; mtimeMs: number }> {
	let fileStatus: Awaited<ReturnType<ViewerHostFileSystem["stat"]>>;
	try {
		fileStatus = await fileSystem.stat(pdfPath);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
	if (!fileStatus.isFile()) {
		throw new ViewerHostSnapshotError("pdf_not_regular_file", "registered PDF is not a regular file");
	}
	return { size: fileStatus.size, mtimeMs: fileStatus.mtimeMs };
}

async function assertRegisteredPdfReadable(fileSystem: ViewerHostFileSystem, pdfPath: string): Promise<void> {
	let stream: Readable;
	try {
		stream = fileSystem.createReadStream(pdfPath);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
	try {
		await waitForReadablePdfOpen(stream);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
}

async function waitForReadablePdfOpen(stream: Readable): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			stream.off("open", succeed);
			stream.off("readable", succeed);
			stream.off("data", succeed);
			stream.off("end", succeed);
			stream.off("error", fail);
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const succeed = () => settle(() => {
			stream.destroy();
			resolve();
		});
		const fail = (error: Error) => settle(() => {
			stream.destroy();
			reject(error);
		});
		stream.once("open", succeed);
		stream.once("readable", succeed);
		stream.once("data", succeed);
		stream.once("end", succeed);
		stream.once("error", fail);
		stream.resume();
	});
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

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
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

class ViewerHostSnapshotError extends Error {
	readonly diagnosticCode: ViewerHostPdfRefreshDiagnostic["code"];

	constructor(diagnosticCode: ViewerHostPdfRefreshDiagnostic["code"], message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ViewerHostSnapshotError";
		this.diagnosticCode = diagnosticCode;
	}
}

function diagnosticForSnapshotError(pdfId: number, error: unknown): ViewerHostPdfRefreshDiagnostic {
	return {
		pdf_id: pdfId,
		status: "error",
		code: error instanceof ViewerHostSnapshotError ? error.diagnosticCode : "pdf_not_readable",
		message: errorMessage(error),
	};
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new Error("PDF change detection timing values must be finite non-negative numbers");
	return value;
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

import { createReadStream, readFileSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import type { ViewerHostPdfRecord, ViewerHostPdfRegistry } from "./viewer_host_registry.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const require = createRequire(import.meta.url);
const LOCAL_PDFJS_ASSETS = new Map<string, string>([
	["/assets/pdf.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.mjs")],
	["/assets/pdf.worker.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")],
]);

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

export interface ViewerHostServerOptions {
	registry: ViewerHostPdfRegistry;
	port?: number;
	fileSystem?: ViewerHostFileSystem;
}

export interface ViewerHostServerAddress {
	host: "127.0.0.1";
	port: number;
}

export class ViewerHostServer {
	private readonly registry: ViewerHostPdfRegistry;
	private readonly port: number;
	private readonly fileSystem: ViewerHostFileSystem;
	private server: Server | undefined;
	private activeSockets = new Set<Socket>();
	private originValue: string | undefined;
	private addressValue: ViewerHostServerAddress | undefined;

	constructor(options: ViewerHostServerOptions) {
		this.registry = options.registry;
		this.port = options.port ?? DEFAULT_PORT;
		this.fileSystem = options.fileSystem ?? { stat: statFile, createReadStream };
	}

	get origin(): string {
		if (!this.originValue) throw new Error("Viewer Host Server is not started");
		return this.originValue;
	}

	get address(): ViewerHostServerAddress {
		if (!this.addressValue) throw new Error("Viewer Host Server is not started");
		return this.addressValue;
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
		for (const socket of this.activeSockets) {
			socket.destroy();
		}
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "GET" && request.method !== "HEAD") {
			textResponse(response, 405, "text/plain; charset=utf-8", "method not allowed", false);
			return;
		}

		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${LOCAL_HOST}`);
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

	private serveAppShell(response: ServerResponse, headOnly: boolean): void {
		const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viewer Client</title>
<style>body{font-family:sans-serif;margin:1.5rem;background:#f7f7f7;color:#222}main{max-width:48rem;margin:auto;background:white;padding:1rem 1.25rem;box-shadow:0 1px 8px #ccc}</style>
</head>
<body>
<main>
<h1>Viewer Client</h1>
<p id="empty-state">No PDF is open.</p>
</main>
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

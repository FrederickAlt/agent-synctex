import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, URL } from "node:url";
import type { PdfJsViewerClient, PdfJsViewerRegistry } from "./pdfjs_viewer_registry.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LW_VIEWER_ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "viewer_lw");
const LW_PDFJS_BUILD_ASSETS = new Map<string, string>([
	["/viewer-lw/build/pdf.mjs", resolve(LW_VIEWER_ASSET_ROOT, "build", "pdf.mjs")],
	["/viewer-lw/build/pdf.worker.mjs", resolve(LW_VIEWER_ASSET_ROOT, "build", "pdf.worker.mjs")],
	["/viewer-lw/build/pdf.sandbox.mjs", resolve(LW_VIEWER_ASSET_ROOT, "build", "pdf.sandbox.mjs")],
]);

function parsePositivePdfId(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const pdfId = Number(value);
	return Number.isSafeInteger(pdfId) && pdfId > 0 ? pdfId : undefined;
}

function textResponse(response: ServerResponse, status: number, contentType: string, body: string): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(body, "utf8"),
		"cache-control": "no-store",
	});
	response.end(body);
}

function binaryResponse(response: ServerResponse, status: number, contentType: string, body: Buffer, headOnly: boolean): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": body.length,
		"cache-control": "no-store",
	});
	response.end(headOnly ? undefined : body);
}

function contentTypeForPath(path: string): string {
	switch (extname(path)) {
		case ".html": return "text/html; charset=utf-8";
		case ".css": return "text/css; charset=utf-8";
		case ".js":
		case ".mjs": return "text/javascript; charset=utf-8";
		case ".json": return "application/json; charset=utf-8";
		case ".svg": return "image/svg+xml";
		case ".gif": return "image/gif";
		case ".wasm": return "application/wasm";
		case ".bcmap": return "application/octet-stream";
		case ".ftl": return "text/plain; charset=utf-8";
		default: return "application/octet-stream";
	}
}

function websocketAccept(key: string): string {
	return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function rfc5987Encode(value: string): string {
	return encodeURIComponent(value)
		.replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(/\*/g, "%2A");
}

function safePdfFilename(value: string): string {
	const sanitized = value
		.replace(/[\u0000-\u001f\u007f/\\]/g, "_")
		.trim();
	return sanitized || "document.pdf";
}

function asciiFallbackFilename(value: string): string {
	const sanitized = safePdfFilename(value)
		.replace(/[^\x20-\x7e]/g, "_")
		.replace(/[";\\]/g, "_")
		.trim();
	return sanitized || "document.pdf";
}

function contentDispositionForPdfPath(pdfPath: string): string {
	const filename = safePdfFilename(basename(pdfPath));
	const fallback = asciiFallbackFilename(filename);
	return `inline; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

function encodeWebSocketTextFrame(message: string): Buffer {
	const payload = Buffer.from(message, "utf8");
	if (payload.length < 126) {
		return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
	}
	if (payload.length <= 0xffff) {
		const header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
		return Buffer.concat([header, payload]);
	}
	const header = Buffer.alloc(10);
	header[0] = 0x81;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}

function decodeWebSocketTextFrames(frameBuffer: Buffer): { messages: string[]; remaining: Buffer } {
	const messages: string[] = [];
	let cursor = 0;
	while (cursor + 2 <= frameBuffer.length) {
		const firstByte = frameBuffer[cursor];
		const opcode = firstByte & 0x0f;
		const masked = (frameBuffer[cursor + 1] & 0x80) !== 0;
		let payloadLength = frameBuffer[cursor + 1] & 0x7f;
		let offset = cursor + 2;
		if (payloadLength === 126) {
			if (frameBuffer.length < offset + 2) break;
			payloadLength = frameBuffer.readUInt16BE(offset);
			offset += 2;
		} else if (payloadLength === 127) {
			if (frameBuffer.length < offset + 8) break;
			const bigLength = frameBuffer.readBigUInt64BE(offset);
			if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) break;
			payloadLength = Number(bigLength);
			offset += 8;
		}
		let mask: Buffer | undefined;
		if (masked) {
			if (frameBuffer.length < offset + 4) break;
			mask = frameBuffer.subarray(offset, offset + 4);
			offset += 4;
		}
		const nextCursor = offset + payloadLength;
		if (frameBuffer.length < nextCursor) break;
		if (opcode === 0x01) {
			const payload = Buffer.from(frameBuffer.subarray(offset, nextCursor));
			if (mask) {
				for (let index = 0; index < payload.length; index += 1) {
					payload[index] ^= mask[index % 4];
				}
			}
			messages.push(payload.toString("utf8"));
		}
		cursor = nextCursor;
	}
	return { messages, remaining: frameBuffer.subarray(cursor) };
}

function parseViewerSelectionDebug(pdfId: number, rawMessage: string): ViewerSelectionDebug | undefined {
	let message: unknown;
	try {
		message = JSON.parse(rawMessage);
	} catch {
		return undefined;
	}
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (record.type !== "selection_debug") return undefined;
	if (typeof record.phase !== "string" || !record.phase.trim()) return undefined;
	if (record.page !== undefined && (!Number.isInteger(record.page) || (record.page as number) < 1)) return undefined;
	if (typeof record.text !== "string") return undefined;
	if (typeof record.details !== "object" || record.details === null || Array.isArray(record.details)) return undefined;
	return {
		pdfId,
		phase: record.phase,
		...(record.page === undefined ? {} : { page: record.page as number }),
		text: record.text,
		details: record.details as Record<string, unknown>,
	};
}

function parseReverseSynctexClick(pdfId: number, rawMessage: string): ReverseSynctexClick | undefined {
	let message: unknown;
	try {
		message = JSON.parse(rawMessage);
	} catch {
		return undefined;
	}
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (record.type !== "reverse_synctex") return undefined;
	const { page, x, y } = record;
	if (!Number.isInteger(page) || (page as number) < 1) return undefined;
	if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return undefined;
	if (typeof y !== "number" || !Number.isFinite(y) || y < 0) return undefined;
	if (record.textBeforeSelection !== undefined && typeof record.textBeforeSelection !== "string") return undefined;
	if (record.textAfterSelection !== undefined && typeof record.textAfterSelection !== "string") return undefined;
	if (record.selectedText !== undefined && typeof record.selectedText !== "string") return undefined;
	for (const field of ["selectionStartX", "selectionStartY", "selectionEndX", "selectionEndY"] as const) {
		if (record[field] !== undefined && (typeof record[field] !== "number" || !Number.isFinite(record[field]) || record[field] < 0)) return undefined;
	}
	return {
		pdfId,
		page: page as number,
		x,
		y,
		...(record.textBeforeSelection === undefined ? {} : { textBeforeSelection: record.textBeforeSelection }),
		...(record.textAfterSelection === undefined ? {} : { textAfterSelection: record.textAfterSelection }),
		...(record.selectedText === undefined ? {} : { selectedText: record.selectedText }),
		...(record.selectionStartX === undefined ? {} : { selectionStartX: record.selectionStartX as number }),
		...(record.selectionStartY === undefined ? {} : { selectionStartY: record.selectionStartY as number }),
		...(record.selectionEndX === undefined ? {} : { selectionEndX: record.selectionEndX as number }),
		...(record.selectionEndY === undefined ? {} : { selectionEndY: record.selectionEndY as number }),
	};
}

class SocketViewerClient implements PdfJsViewerClient {
	private readonly socket: Socket;
	constructor(socket: Socket) {
		this.socket = socket;
	}
	send(message: string): void {
		if (!this.socket.writable) return;
		this.socket.write(encodeWebSocketTextFrame(message));
	}
}

export interface PdfJsViewerFileSystem {
	stat(path: string): Promise<{ size: number; isFile(): boolean }>;
	createReadStream(path: string): Readable;
}

export interface ReverseSynctexClick {
	pdfId: number;
	page: number;
	x: number;
	y: number;
	textBeforeSelection?: string;
	textAfterSelection?: string;
	selectedText?: string;
	selectionStartX?: number;
	selectionStartY?: number;
	selectionEndX?: number;
	selectionEndY?: number;
}

export interface ViewerSelectionDebug {
	pdfId: number;
	phase: string;
	page?: number;
	text: string;
	details: Record<string, unknown>;
}

export interface PdfJsViewerServerOptions {
	registry: PdfJsViewerRegistry;
	host?: string;
	port?: number;
	fileSystem?: PdfJsViewerFileSystem;
	onReverseSynctex?: (click: ReverseSynctexClick) => void | Promise<void>;
	onSelectionDebug?: (debug: ViewerSelectionDebug) => void | Promise<void>;
}

export class PdfJsViewerServer {
	private readonly registry: PdfJsViewerRegistry;
	private readonly host: string;
	private readonly port: number;
	private readonly fileSystem: PdfJsViewerFileSystem;
	private readonly onReverseSynctex: ((click: ReverseSynctexClick) => void | Promise<void>) | undefined;
	private readonly onSelectionDebug: ((debug: ViewerSelectionDebug) => void | Promise<void>) | undefined;
	private server: Server | null = null;
	private activeSockets = new Set<Socket>();
	private activeWebSockets = new Set<Socket>();
	private originValue: string | undefined;

	constructor(options: PdfJsViewerServerOptions) {
		this.registry = options.registry;
		this.host = options.host ?? DEFAULT_HOST;
		this.port = options.port ?? DEFAULT_PORT;
		this.fileSystem = options.fileSystem ?? {
			stat: statFile,
			createReadStream,
		};
		this.onReverseSynctex = options.onReverseSynctex;
		this.onSelectionDebug = options.onSelectionDebug;
	}

	get origin(): string {
		if (!this.originValue) {
			throw new Error("PDF.js viewer server is not started");
		}
		return this.originValue;
	}

	viewerUrl(pdfId: number): string {
		return `${this.origin}/viewer-lw/${pdfId}`;
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((request, response) => {
			void this.handleHttpRequest(request, response).catch(() => {
				if (!response.headersSent) {
					textResponse(response, 500, "text/plain; charset=utf-8", "viewer server request failed");
				} else {
					response.destroy();
				}
			});
		});
		server.on("connection", (socket) => {
			this.activeSockets.add(socket);
			socket.once("close", () => this.activeSockets.delete(socket));
		});
		server.on("upgrade", (request, socket) => this.handleUpgrade(request, socket as Socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: this.host, port: this.port }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address() as AddressInfo | null;
		if (!address || typeof address === "string") {
			throw new Error("PDF.js viewer server did not expose a TCP address");
		}
		this.originValue = `http://${this.host}:${address.port}`;
	}

	async stop(): Promise<void> {
		for (const socket of this.activeWebSockets) {
			socket.destroy();
		}
		for (const socket of this.activeSockets) {
			socket.destroy();
		}
		const server = this.server;
		this.server = null;
		this.originValue = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
	}

	notifyPdfClosed(pdfId: number): number {
		return this.registry.sendToClients(pdfId, JSON.stringify({ type: "pdf_closed", pdf_id: pdfId }));
	}

	notifyPdfRefresh(pdfId: number, revision: number): number {
		return this.registry.sendToClients(pdfId, JSON.stringify({
			type: "pdf_refresh",
			pdf_id: pdfId,
			revision,
			pdf_url: this.pdfUrl(pdfId, revision),
		}));
	}

	notifySynctex(pdfId: number, target: { page: number; x: number; y: number; width?: number; height?: number; ranges?: Array<{ page: number; h: number; v: number; W: number; H: number }>; source_file: string; line: number }): number {
		return this.registry.sendToClients(pdfId, JSON.stringify({ type: "synctex_forward", pdf_id: pdfId, ...target }));
	}

	pdfUrl(pdfId: number, revision: number): string {
		return `${this.origin}/pdf/${pdfId}?revision=${revision}`;
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${this.host}`);
		if (request.method !== "GET" && request.method !== "HEAD") {
			textResponse(response, 405, "text/plain; charset=utf-8", "method not allowed");
			return;
		}

		const legacyViewerMatch = /^\/viewer\/(\d+)$/.exec(requestUrl.pathname);
		if (legacyViewerMatch) {
			const pdfId = parsePositivePdfId(legacyViewerMatch[1]);
			if (pdfId === undefined || !this.hasActiveRecord(pdfId)) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id");
				return;
			}
			response.writeHead(302, { location: `/viewer-lw/${pdfId}${requestUrl.search}`, "cache-control": "no-store" });
			response.end();
			return;
		}

		const lwViewerMatch = /^\/viewer-lw\/(\d+)$/.exec(requestUrl.pathname);
		if (lwViewerMatch) {
			const pdfId = parsePositivePdfId(lwViewerMatch[1]);
			if (pdfId === undefined || !this.hasActiveRecord(pdfId)) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id");
				return;
			}
			this.serveLaTeXWorkshopViewerShell(response, pdfId, request.method === "HEAD");
			return;
		}

		const configMatch = /^\/config\/(\d+)\.json$/.exec(requestUrl.pathname);
		if (configMatch) {
			const pdfId = parsePositivePdfId(configMatch[1]);
			if (pdfId === undefined || !this.hasActiveRecord(pdfId)) {
				textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }));
				return;
			}
			const record = this.registry.getActiveRecord(pdfId);
			const viewerSocketUrl = `${this.origin.replace(/^http:/, "ws:")}/ws?pdf_id=${pdfId}`;
			const config = JSON.stringify({
				pdf_id: pdfId,
				revision: record.revision,
				pdf_url: this.pdfUrl(pdfId, record.revision),
				viewer_socket_url: viewerSocketUrl,
				ws_url: viewerSocketUrl,
			});
			textResponse(response, 200, "application/json; charset=utf-8", request.method === "HEAD" ? "" : config);
			return;
		}

		if (requestUrl.pathname.startsWith("/viewer-lw/")) {
			this.serveLaTeXWorkshopViewerAsset(response, requestUrl.pathname, request.method === "HEAD");
			return;
		}

		if (requestUrl.pathname.startsWith("/cmaps/") || requestUrl.pathname.startsWith("/standard_fonts/") || requestUrl.pathname.startsWith("/wasm/")) {
			this.serveLaTeXWorkshopStaticAsset(response, requestUrl.pathname.replace(/^\//, ""), request.method === "HEAD");
			return;
		}

		const pdfMatch = /^\/pdf\/(\d+)$/.exec(requestUrl.pathname);
		if (pdfMatch) {
			const pdfId = parsePositivePdfId(pdfMatch[1]);
			if (pdfId === undefined) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id");
				return;
			}
			await this.servePdf(response, pdfId, request.method === "HEAD");
			return;
		}

		textResponse(response, 404, "text/plain; charset=utf-8", "not found");
	}

	private serveLaTeXWorkshopViewerShell(response: ServerResponse, pdfId: number, headOnly: boolean): void {
		try {
			const html = readFileSync(resolve(LW_VIEWER_ASSET_ROOT, "viewer.html"), "utf8")
				.replace("<body tabindex=\"0\">", `<body tabindex="0" data-config-url="/config/${pdfId}.json">`);
			textResponse(response, 200, "text/html; charset=utf-8", headOnly ? "" : html);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "LaTeX Workshop viewer shell is not readable");
		}
	}

	private serveLaTeXWorkshopViewerAsset(response: ServerResponse, requestPath: string, headOnly: boolean): void {
		const buildAsset = LW_PDFJS_BUILD_ASSETS.get(requestPath);
		if (buildAsset !== undefined) {
			this.serveLaTeXWorkshopStaticAsset(response, relative(LW_VIEWER_ASSET_ROOT, buildAsset), headOnly);
			return;
		}
		const relativeAssetPath = requestPath.replace(/^\/viewer-lw\//, "");
		if (relativeAssetPath === "" || relativeAssetPath === "viewer.html" || relativeAssetPath.includes("\0")) {
			textResponse(response, 404, "text/plain; charset=utf-8", "not found");
			return;
		}
		this.serveLaTeXWorkshopStaticAsset(response, relativeAssetPath, headOnly);
	}

	private serveLaTeXWorkshopStaticAsset(response: ServerResponse, relativeAssetPath: string, headOnly: boolean): void {
		const assetPath = resolve(LW_VIEWER_ASSET_ROOT, relativeAssetPath);
		const relativeToRoot = relative(LW_VIEWER_ASSET_ROOT, assetPath);
		if (relativeToRoot.startsWith("..") || relativeToRoot === "" || relativeToRoot.split(sep).includes("..")) {
			textResponse(response, 404, "text/plain; charset=utf-8", "not found");
			return;
		}
		try {
			binaryResponse(response, 200, contentTypeForPath(assetPath), readFileSync(assetPath), headOnly);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "asset is not readable");
		}
	}

	private async servePdf(response: ServerResponse, pdfId: number, headOnly: boolean): Promise<void> {
		let record;
		try {
			record = this.registry.getActiveRecord(pdfId);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id");
			return;
		}
		let fileStatus: Awaited<ReturnType<PdfJsViewerFileSystem["stat"]>>;
		try {
			fileStatus = await this.fileSystem.stat(record.pdfPath);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not readable");
			return;
		}
		if (!fileStatus.isFile()) {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not a regular file");
			return;
		}
		response.writeHead(200, {
			"content-type": "application/pdf",
			"content-length": fileStatus.size,
			"cache-control": "no-store",
			"content-disposition": contentDispositionForPdfPath(record.pdfPath),
		});
		if (headOnly) {
			response.end();
			return;
		}
		const stream = this.fileSystem.createReadStream(record.pdfPath);
		stream.once("error", () => {
			response.destroy();
		});
		response.once("close", () => {
			stream.destroy();
		});
		stream.pipe(response);
	}

	private handleUpgrade(request: IncomingMessage, socket: Socket): void {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${this.host}`);
		if (requestUrl.pathname !== "/ws") {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		const pdfId = parsePositivePdfId(requestUrl.searchParams.get("pdf_id") ?? undefined);
		if (pdfId === undefined || !this.hasActiveRecord(pdfId)) {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string" || !key.trim()) {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${websocketAccept(key)}`,
			"",
			"",
		].join("\r\n"));
		this.activeWebSockets.add(socket);
		const clientId = this.registry.addClient(pdfId, new SocketViewerClient(socket));
		let cleanedUp = false;
		let webSocketInputBuffer: Buffer = Buffer.alloc(0);
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			webSocketInputBuffer = Buffer.alloc(0);
			this.activeWebSockets.delete(socket);
			this.registry.removeClient(clientId);
		};
		socket.on("data", (chunk) => {
			const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			webSocketInputBuffer = webSocketInputBuffer.length === 0 ? frame : Buffer.concat([webSocketInputBuffer, frame]);
			const firstByte = webSocketInputBuffer.length > 0 ? webSocketInputBuffer[0] : 0;
			const opcode = firstByte & 0x0f;
			if (opcode === 0x08) {
				cleanup();
				socket.end();
				return;
			}
			const decoded = decodeWebSocketTextFrames(webSocketInputBuffer);
			webSocketInputBuffer = decoded.remaining;
			for (const rawMessage of decoded.messages) {
				const debug = parseViewerSelectionDebug(pdfId, rawMessage);
				if (debug !== undefined && this.onSelectionDebug !== undefined) {
					void Promise.resolve().then(() => this.onSelectionDebug!(debug)).catch(() => undefined);
					continue;
				}
				const click = parseReverseSynctexClick(pdfId, rawMessage);
				if (click === undefined || this.onReverseSynctex === undefined) continue;
				void Promise.resolve()
					.then(() => this.onReverseSynctex!(click))
					.catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						if (socket.writable) {
							socket.write(encodeWebSocketTextFrame(JSON.stringify({ type: "reverse_synctex_error", pdf_id: pdfId, error: message })));
						}
					});
			}
		});
		socket.once("end", cleanup);
		socket.once("close", cleanup);
		socket.once("error", () => {
			cleanup();
			socket.destroy();
		});
	}

	private hasActiveRecord(pdfId: number): boolean {
		try {
			this.registry.getActiveRecord(pdfId);
			return true;
		} catch {
			return false;
		}
	}
}

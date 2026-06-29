import { createReadStream } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { basename, resolve } from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import { validateMcpToViewerHostMessage, VIEWER_HOST_PROTOCOL_VERSION, type ViewerHostControlResponse, type ViewerHostSynctexForwardMessage } from "./viewer_host_protocol.ts";
import type { ViewerHostPdfRecord, ViewerHostPdfRegistry } from "./viewer_host_registry.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

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
		for (const socket of this.activeSockets) {
			socket.destroy();
		}
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

		if (request.method !== "GET" && request.method !== "HEAD") {
			textResponse(response, 405, "text/plain; charset=utf-8", "method not allowed", false);
			return;
		}

		const pdfMatch = /^\/pdf\/(\d+)$/.exec(requestUrl.pathname);
		if (!pdfMatch) {
			textResponse(response, 404, "text/plain; charset=utf-8", "not found", request.method === "HEAD");
			return;
		}

		const pdfId = parsePositiveInteger(pdfMatch[1]);
		const revision = parsePositiveInteger(requestUrl.searchParams.get("revision") ?? undefined);
		if (pdfId === undefined || revision === undefined) {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id or revision", request.method === "HEAD");
			return;
		}
		await this.servePdf(response, pdfId, revision, request.method === "HEAD");
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
				return { ok: true, result: { type: "open_pdf", pdf_id: record.pdfId, revision: record.revision } };
			}
			case "focus_pdf": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.viewerDispatch.focusPdf(record);
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

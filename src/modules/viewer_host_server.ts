import { createReadStream } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import type { ViewerHostPdfRecord, ViewerHostPdfRegistry } from "./viewer_host_registry.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

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

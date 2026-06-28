import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMcpTmpDir } from "./runtime_paths.ts";
import { PdfJsViewerMcpService } from "./pdfjs_viewer_mcp_service.ts";
import type { GetPdfEventsRequest, PdfEvent } from "./pdf_events.ts";
import type {
	HostServiceCloseRequest,
	HostServiceCloseResponseEnvelope,
	HostServiceJumpRequest,
	HostServiceJumpResponseEnvelope,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
} from "./host_service_protocol.ts";
import type { HostServiceMcpPdfOperations } from "./host_service_mcp.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 2_000;
const BROKER_SOCKET_NAME = "pdfjs-viewer-broker.sock";

export function defaultPdfJsViewerBrokerSocketPath(): string {
	return resolve(getMcpTmpDir(), BROKER_SOCKET_NAME);
}

export class PdfJsViewerBrokerClient {
	readonly pdfOperations: HostServiceMcpPdfOperations;
	private readonly socketPath: string;
	private readonly requestTimeoutMs: number;
	private readonly startTimeoutMs: number;
	private readonly activePdfIds = new Set<number>();

	constructor(options: { socketPath?: string; requestTimeoutMs?: number; startTimeoutMs?: number } = {}) {
		this.socketPath = options.socketPath ?? defaultPdfJsViewerBrokerSocketPath();
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.pdfOperations = {
			openPdf: (request) => this.openPdf(request),
			jumpPdf: (request) => this.call<HostServiceJumpResponseEnvelope>("/jump_pdf", request),
			closePdf: (request) => this.closePdf(request),
			getPdfEvents: (request) => this.call<PdfEvent[]>("/get_pdf_events", request),
			markTrackedPdfUpdated: (pdfPath) => this.call<unknown>("/mark_tracked_pdf_updated", { pdfPath }),
		};
	}

	activePdfCount(): number {
		return this.activePdfIds.size;
	}

	async close(): Promise<void> {
		if (this.activePdfIds.size > 0 || await this.brokerHasActivePdfs()) {
			// The broker intentionally outlives short-lived stdio MCP transports so returned viewer_url values remain reachable.
			return;
		}
		await this.shutdown().catch(() => undefined);
	}

	private async brokerHasActivePdfs(): Promise<boolean> {
		try {
			const status = await this.postJson<{ active_pdf_count?: unknown }>("/status", {}, 500);
			return typeof status.active_pdf_count === "number" && status.active_pdf_count > 0;
		} catch {
			return false;
		}
	}

	private async openPdf(request: HostServiceOpenRequest): Promise<HostServiceOpenResponseEnvelope> {
		const response = await this.call<HostServiceOpenResponseEnvelope>("/open_pdf", request);
		const pdfId = response.status_details.pdf_id;
		if (response.status === "ok" && typeof pdfId === "number" && Number.isInteger(pdfId) && pdfId > 0) {
			this.activePdfIds.add(pdfId);
		}
		return response;
	}

	private async closePdf(request: HostServiceCloseRequest): Promise<HostServiceCloseResponseEnvelope> {
		const response = await this.call<HostServiceCloseResponseEnvelope>("/close_pdf", request);
		if (response.status === "ok") {
			this.activePdfIds.delete(request.pdf_id);
		}
		return response;
	}

	async shutdown(): Promise<void> {
		await this.postJson("/shutdown", {}, this.requestTimeoutMs);
	}

	private async call<T>(path: string, body: unknown): Promise<T> {
		await this.ensureStarted();
		return this.postJson<T>(path, body, this.requestTimeoutMs);
	}

	private async ensureStarted(): Promise<void> {
		try {
			await this.postJson("/status", {}, 500);
			return;
		} catch {
			// Start below.
		}
		mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		if (existsSync(this.socketPath)) {
			rmSync(this.socketPath, { force: true });
		}
		const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/pdfjs-viewer-broker.ts");
		const child = spawn(process.execPath, [scriptPath, this.socketPath], {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
		const deadline = Date.now() + this.startTimeoutMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				await this.postJson("/status", {}, 500);
				return;
			} catch (error) {
				lastError = error;
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			}
		}
		throw new Error(`PDF.js viewer broker did not start at ${this.socketPath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
	}

	private postJson<T>(path: string, body: unknown, timeoutMs: number = this.requestTimeoutMs): Promise<T> {
		const payload = JSON.stringify(body);
		return new Promise<T>((resolvePromise, rejectPromise) => {
			let settled = false;
			const finish = (value: T | Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (value instanceof Error) rejectPromise(value);
				else resolvePromise(value);
			};
			const request = httpRequest({
				socketPath: this.socketPath,
				path,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload),
				},
			}, (response) => {
				let raw = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					raw += chunk;
				});
				response.on("end", () => {
					try {
						const parsed = raw ? JSON.parse(raw) as unknown : undefined;
						if ((response.statusCode ?? 500) >= 400) {
							const message = typeof parsed === "object" && parsed !== null && "error" in parsed ? String((parsed as { error?: unknown }).error) : `broker request failed with HTTP ${response.statusCode}`;
							finish(new Error(message));
							return;
						}
						finish(parsed as T);
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				});
			});
			const timer = setTimeout(() => {
				request.destroy();
				finish(new Error("PDF.js viewer broker request timed out"));
			}, timeoutMs);
			timer.unref?.();
			request.on("error", (error) => finish(error));
			request.end(payload);
		});
	}
}

export class PdfJsViewerBrokerServer {
	private readonly socketPath: string;
	private readonly service: PdfJsViewerMcpService;
	private server: Server | undefined;

	constructor(socketPath = defaultPdfJsViewerBrokerSocketPath(), service = new PdfJsViewerMcpService()) {
		this.socketPath = socketPath;
		this.service = service;
	}

	async start(): Promise<void> {
		if (this.server) return;
		mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		rmSync(this.socketPath, { force: true });
		const server = createServer((request, response) => {
			void this.handleRequest(request, response).catch((error) => {
				writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
			});
		});
		this.server = server;
		await new Promise<void>((resolveStart, rejectStart) => {
			server.once("error", rejectStart);
			server.listen(this.socketPath, () => {
				server.off("error", rejectStart);
				resolveStart();
			});
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolveStop, rejectStop) => {
				server.close((error) => error ? rejectStop(error) : resolveStop());
			});
		}
		await this.service.stop();
		rmSync(this.socketPath, { force: true });
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			writeJson(response, 405, { error: "method not allowed" });
			return;
		}
		const body = await readJsonBody(request);
		switch (request.url) {
			case "/status":
				writeJson(response, 200, { ok: true, active_pdf_count: this.service.activePdfCount() });
				return;
			case "/shutdown":
				writeJson(response, 200, { ok: true });
				setImmediate(() => {
					void this.stop();
				});
				return;
			case "/open_pdf":
				writeJson(response, 200, await this.service.openPdf(body as HostServiceOpenRequest));
				return;
			case "/jump_pdf":
				writeJson(response, 200, await this.service.jumpPdf(body as HostServiceJumpRequest));
				return;
			case "/close_pdf":
				writeJson(response, 200, await this.service.closePdf(body as HostServiceCloseRequest));
				return;
			case "/get_pdf_events":
				writeJson(response, 200, await this.service.getPdfEvents(body as GetPdfEventsRequest));
				return;
			case "/mark_tracked_pdf_updated": {
				const pdfPath = typeof (body as { pdfPath?: unknown }).pdfPath === "string" ? (body as { pdfPath: string }).pdfPath : "";
				writeJson(response, 200, await this.service.markTrackedPdfUpdated(pdfPath));
				return;
			}
			default:
				writeJson(response, 404, { error: "not found" });
		}
	}
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody, rejectBody) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			try {
				resolveBody(raw ? JSON.parse(raw) : {});
			} catch (error) {
				rejectBody(error);
			}
		});
		request.on("error", rejectBody);
	});
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(statusCode, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	response.end(payload);
}

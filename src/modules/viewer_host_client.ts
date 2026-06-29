import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadablePdfFile, assertReadableSourceFile, inferDefaultSourceFileForPdf } from "./pdf_tracking/pdf_tracking.ts";
import { mapForwardSynctex, mapReverseSynctex } from "./synctex/forward_synctex.ts";
import { PdfEventStore, type GetPdfEventsRequest, type PdfEvent } from "./pdf_events.ts";
import type {
	HostServiceJumpRequest,
	HostServiceJumpResponseEnvelope,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
	HostServiceWorkspaceContext,
} from "./host_service_protocol.ts";
import type { HostServiceMcpPdfOperations } from "./host_service_mcp.ts";
import {
	validateMcpToViewerHostMessage,
	validateViewerHostToMcpMessage,
	type McpToViewerHostMessage,
	type ViewerHostControlResponse,
	type ViewerHostReverseSynctexMessage,
	type ViewerHostToMcpMessage,
} from "./viewer_host_protocol.ts";
import { ViewerHostControlClient } from "./viewer_host_control_client.ts";

const VIEWER_HOST_BACKEND_NAME = "viewer-host-client";
const VIEWER_HOST_CAPABILITIES = {
	open: true,
	close: false,
	forward_search: true,
	inverse_search: true,
	reuse: true,
};
const MIN_PDF_ID = 1;
const MAX_PDF_ID = 99_999_999;
const DEFAULT_VIEWER_HOST_READY_TIMEOUT_MS = 10_000;
const DEFAULT_VIEWER_HOST_SHUTDOWN_TIMEOUT_MS = 1_000;

interface TrackedViewerHostPdf {
	pdfId: number;
	pdfPath: string;
	workspaceCwd: string;
	createdAtNs: number;
	revision: number;
	viewerUrl: string;
	fileSnapshot?: { size: number; mtimeMs: number };
}

export interface ViewerHostClient {
	readonly origin: string;
	send(message: McpToViewerHostMessage): Promise<void | ViewerHostControlResponse>;
	drainEvents?(): Promise<ViewerHostToMcpMessage[]>;
	close?(): Promise<void> | void;
}

export type ViewerHostClientFactory = () => ViewerHostClient | Promise<ViewerHostClient>;

interface ActiveViewerHostSession {
	client: ViewerHostClient;
	generation: number;
}

export class FakeViewerHostClient implements ViewerHostClient {
	readonly origin: string;
	readonly messages: McpToViewerHostMessage[] = [];

	constructor(options: { origin?: string } = {}) {
		this.origin = options.origin ?? "http://127.0.0.1:43125";
	}

	async send(message: McpToViewerHostMessage): Promise<void> {
		this.messages.push(validateMcpToViewerHostMessage(message));
	}
}

export interface ViewerHostProcessLauncherOptions {
	command?: string;
	args?: string[];
	readyTimeoutMs?: number;
	shutdownTimeoutMs?: number;
}

interface ViewerHostReadyLine {
	type: "ready";
	origin: string;
	app_url: string;
}

class LocalViewerHostProcessClient implements ViewerHostClient {
	readonly origin: string;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly shutdownTimeoutMs: number;
	private readonly controlClient: ViewerHostControlClient;
	private closed = false;

	constructor(child: ChildProcessWithoutNullStreams, ready: ViewerHostReadyLine, shutdownTimeoutMs: number) {
		this.child = child;
		this.shutdownTimeoutMs = shutdownTimeoutMs;
		this.origin = ready.origin.replace(/\/$/, "");
		this.controlClient = new ViewerHostControlClient({ origin: this.origin });
	}

	async send(message: McpToViewerHostMessage): Promise<ViewerHostControlResponse> {
		if (this.closed) throw new Error("Viewer Host process is closed");
		return this.controlClient.send(message);
	}

	async drainEvents(): Promise<ViewerHostToMcpMessage[]> {
		if (this.closed) return [];
		const response = await fetch(`${this.origin}/mcp-events/drain`, { method: "POST" });
		const payload = await response.json() as { ok?: unknown; events?: unknown; error?: { message?: unknown } };
		if (!response.ok || payload.ok !== true || !Array.isArray(payload.events)) {
			throw new Error(typeof payload.error?.message === "string" ? payload.error.message : "failed to drain Viewer Host MCP events");
		}
		return payload.events.map((event) => validateViewerHostToMcpMessage(event));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.child.stdin.write("shutdown\n");
		await waitForProcessExitOrKill(this.child, this.shutdownTimeoutMs);
	}
}

export function createDefaultViewerHostClientFactory(options: ViewerHostProcessLauncherOptions = {}): ViewerHostClientFactory {
	return async () => launchLocalViewerHostProcess(options);
}

async function launchLocalViewerHostProcess(options: ViewerHostProcessLauncherOptions): Promise<ViewerHostClient> {
	const command = options.command ?? process.execPath;
	const args = options.args ?? [fileURLToPath(new URL("../../scripts/viewer-host-server.ts", import.meta.url))];
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_VIEWER_HOST_READY_TIMEOUT_MS;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_VIEWER_HOST_SHUTDOWN_TIMEOUT_MS;
	const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += String(chunk);
		if (stderr.length > 8_192) stderr = stderr.slice(-8_192);
	});
	try {
		const ready = await readViewerHostReadyLine(child, readyTimeoutMs, () => stderr);
		return new LocalViewerHostProcessClient(child, ready, shutdownTimeoutMs);
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
}

async function readViewerHostReadyLine(child: ChildProcessWithoutNullStreams, timeoutMs: number, stderrText: () => string): Promise<ViewerHostReadyLine> {
	return await new Promise<ViewerHostReadyLine>((resolveReady, rejectReady) => {
		let buffer = "";
		let settled = false;
		const timer = setTimeout(() => rejectOnce(new Error("timed out waiting for Viewer Host Server startup")), timeoutMs);
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectReady(error);
		};
		const resolveOnce = (ready: ViewerHostReadyLine) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveReady(ready);
		};
		child.once("error", (error) => rejectOnce(new Error(`failed to start Viewer Host Server: ${error.message}`)));
		child.once("exit", (code, signal) => {
			rejectOnce(new Error(`Viewer Host Server exited before reporting ready (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${stderrText() ? `: ${stderrText()}` : ""}`));
		});
		child.stdout.on("data", (chunk) => {
			buffer += String(chunk);
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline).trim();
			try {
				const parsed = JSON.parse(line) as Partial<ViewerHostReadyLine>;
				if (parsed.type !== "ready" || typeof parsed.origin !== "string" || typeof parsed.app_url !== "string") {
					throw new Error("expected ready message with origin and app_url");
				}
				resolveOnce({ type: "ready", origin: parsed.origin, app_url: parsed.app_url });
			} catch (error) {
				rejectOnce(new Error(`invalid Viewer Host Server startup message: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
	});
}

async function waitForProcessExitOrKill(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveWait) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveWait();
		}, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveWait();
		});
	});
}

export interface ViewerHostMcpServiceOptions {
	client?: ViewerHostClient;
	clientFactory?: ViewerHostClientFactory;
	eventStore?: PdfEventStore;
	makePdfId?: () => number;
	nowNs?: () => number;
}

export class ViewerHostMcpService {
	private readonly clientFactory: ViewerHostClientFactory;
	private activeSession: ActiveViewerHostSession | undefined;
	private reconnectRequired = false;
	private nextGeneration = 0;
	private sendQueue: Promise<void> = Promise.resolve();
	private readonly registeredGenerationByPdfId = new Map<number, number>();
	private readonly eventStore: PdfEventStore;
	private readonly makePdfId: () => number;
	private readonly nowNs: () => number;
	private readonly recordsById = new Map<number, TrackedViewerHostPdf>();
	private readonly recordsByPath = new Map<string, TrackedViewerHostPdf>();
	readonly pdfOperations: HostServiceMcpPdfOperations;

	constructor(options: ViewerHostMcpServiceOptions = {}) {
		if (options.client && options.clientFactory) {
			throw new Error("ViewerHostMcpService accepts either client or clientFactory, not both");
		}
		if (options.client) {
			this.activeSession = { client: options.client, generation: this.allocateGeneration() };
			this.clientFactory = async () => options.client!;
		} else {
			this.clientFactory = options.clientFactory ?? createDefaultViewerHostClientFactory();
		}
		this.eventStore = options.eventStore ?? new PdfEventStore();
		this.makePdfId = options.makePdfId ?? (() => randomInt(MIN_PDF_ID, MAX_PDF_ID + 1));
		this.nowNs = options.nowNs ?? (() => Date.now() * 1_000_000);
		this.pdfOperations = {
			openPdf: (request) => this.openPdf(request),
			jumpPdf: (request) => this.jumpPdf(request),
			getPdfEvents: (request) => this.getPdfEvents(request),
			markTrackedPdfUpdated: (pdfPath) => this.markTrackedPdfUpdated(pdfPath),
		};
	}

	async openPdf(request: HostServiceOpenRequest): Promise<HostServiceOpenResponseEnvelope> {
		const pdfPath = this.resolvePdfPath(request.details.pdf_path, request.workspace_context);
		try {
			assertReadablePdfFile(pdfPath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return this.openError(request, pdfPath, reason, reason.includes("must point to a PDF file") ? "invalid_pdf" : "invalid_request");
		}

		try {
			const opened = await this.enqueueLifecycle(async () => {
				const existing = this.recordsByPath.get(pdfPath);
				if (existing) {
					await this.sendWithReconnectLocked({ type: "focus_pdf", pdf_id: existing.pdfId }, { reregisterBeforeSend: true });
					return { record: existing, reused: true };
				}

				const session = await this.ensureSession();
				const record = this.createPdfRecord(pdfPath, request.workspace_context.cwd, session.client);
				const registeredSession = await this.sendWithReconnectLocked({ type: "open_pdf", pdf_id: record.pdfId, pdf_path: record.pdfPath, title: basename(record.pdfPath) }, { reregisterBeforeSend: false });
				this.setRecordViewerUrl(record, registeredSession);
				this.commitPdfRecord(record);
				return { record, reused: false };
			});
			return this.openOk(request, opened.record, opened.reused);
		} catch (error) {
			const reason = viewerHostUnavailableReason(error);
			return this.openError(request, pdfPath, reason, "viewer_host_unavailable", this.recordsByPath.get(pdfPath));
		}
	}

	async jumpPdf(request: HostServiceJumpRequest): Promise<HostServiceJumpResponseEnvelope> {
		let record: TrackedViewerHostPdf | undefined;
		let sourceFile: string | undefined;
		try {
			record = this.getRecord(request.pdf_id);
			sourceFile = request.source_file ?? inferDefaultSourceFileForPdf(record.pdfPath);
			if (!sourceFile) {
				throw new Error(`No default source_file is known for tracked pdf_id=${request.pdf_id}. Pass source_file explicitly.`);
			}
			sourceFile = isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(request.workspace_context.cwd, sourceFile);
			assertReadableSourceFile(sourceFile);
			assertReadablePdfFile(record.pdfPath);
			const jump = mapForwardSynctex({ pdfPath: record.pdfPath, sourceFile, line: request.line, cwd: request.workspace_context.cwd });
			await this.sendWithReconnect({
				type: "synctex_forward",
				pdf_id: record.pdfId,
				page: jump.page,
				x: jump.x,
				y: jump.y,
				source_file: jump.sourceFile,
				line: jump.line,
			}, { reregisterBeforeSend: true });
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "ok",
				generated_at_ns: this.nowNs(),
				status_details: {
					protocol_version: request.protocol_version,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: VIEWER_HOST_BACKEND_NAME,
					backend_path: VIEWER_HOST_BACKEND_NAME,
					backend_identity_ok: true,
					handled: true,
					reopened: false,
					pdf: record.pdfPath,
					pdf_id: record.pdfId,
					source_file: jump.sourceFile,
					line: jump.line,
					source_line: jump.sourceLine,
					page: jump.page,
					x: jump.x,
					y: jump.y,
					viewer_notifications: 0,
					handle: record.viewerUrl,
					reason: "sent synctex_forward to Viewer Host Client",
					managed_record: this.managedRecord(record, false),
				},
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: this.nowNs(),
				error: reason,
				status_details: {
					protocol_version: request.protocol_version,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: VIEWER_HOST_BACKEND_NAME,
					backend_path: VIEWER_HOST_BACKEND_NAME,
					backend_identity_ok: true,
					handled: false,
					reopened: false,
					pdf: record?.pdfPath,
					pdf_id: request.pdf_id,
					source_file: sourceFile,
					line: request.line,
					error_code: this.jumpErrorCode(reason),
					reason,
				},
			};
		}
	}

	async getPdfEvents(request: GetPdfEventsRequest): Promise<PdfEvent[]> {
		await this.drainHostEvents();
		return this.eventStore.getEvents(request);
	}

	async markTrackedPdfUpdated(pdfPath: string): Promise<{ tracked: boolean; pdfId?: number }> {
		const record = this.recordsByPath.get(resolve(pdfPath));
		if (!record) return { tracked: false };
		await this.sendWithReconnect({ type: "pdf_maybe_updated", pdf_id: record.pdfId }, { reregisterBeforeSend: true });
		return { tracked: true, pdfId: record.pdfId };
	}

	handleHostMessage(message: ViewerHostToMcpMessage): void {
		const parsed = validateViewerHostToMcpMessage(message);
		if (parsed.type !== "reverse_synctex") return;
		this.appendReverseSynctexEvent(parsed);
	}

	private async drainHostEvents(): Promise<void> {
		const events = await this.activeSession?.client.drainEvents?.() ?? [];
		for (const event of events) {
			this.handleHostMessage(event);
		}
	}

	async stop(): Promise<void> {
		await this.activeSession?.client.close?.();
		this.activeSession = undefined;
		this.recordsById.clear();
		this.recordsByPath.clear();
		this.registeredGenerationByPdfId.clear();
	}

	private allocateGeneration(): number {
		this.nextGeneration += 1;
		return this.nextGeneration;
	}

	private async ensureSession(forceReconnect = false): Promise<ActiveViewerHostSession> {
		if (forceReconnect || this.reconnectRequired || !this.activeSession) {
			if (forceReconnect || this.reconnectRequired) {
				await this.activeSession?.client.close?.();
			}
			this.activeSession = { client: await this.clientFactory(), generation: this.allocateGeneration() };
			this.reconnectRequired = false;
		}
		return this.activeSession;
	}

	private async sendWithReconnect(message: McpToViewerHostMessage, options: { reregisterBeforeSend: boolean }): Promise<void> {
		await this.enqueueLifecycle(async () => {
			await this.sendWithReconnectLocked(message, options);
		});
	}

	private async sendWithReconnectLocked(message: McpToViewerHostMessage, options: { reregisterBeforeSend: boolean }): Promise<ActiveViewerHostSession> {
		try {
			return await this.sendOnActiveSession(message, options.reregisterBeforeSend);
		} catch (error) {
			this.reconnectRequired = true;
			const firstReason = error instanceof Error ? error.message : String(error);
			try {
				return await this.sendOnActiveSession(message, true, true);
			} catch (retryError) {
				this.reconnectRequired = true;
				const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
				throw new Error(`${firstReason}; after relaunch/reconnect: ${retryReason}`);
			}
		}
	}

	private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.sendQueue.then(operation, operation);
		this.sendQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async sendOnActiveSession(message: McpToViewerHostMessage, reregisterBeforeSend: boolean, forceReconnect = false): Promise<ActiveViewerHostSession> {
		const session = await this.ensureSession(forceReconnect);
		if (reregisterBeforeSend) {
			await this.reregisterKnownPdfs(session);
		}
		if (message.type === "open_pdf" && this.registeredGenerationByPdfId.get(message.pdf_id) === session.generation) {
			return session;
		}
		await this.sendToClient(session.client, message);
		if (message.type === "open_pdf" && this.activeSession === session) {
			this.registeredGenerationByPdfId.set(message.pdf_id, session.generation);
			this.updateViewerUrlsForSession(session);
		}
		return session;
	}

	private async reregisterKnownPdfs(session: ActiveViewerHostSession): Promise<void> {
		const reregistered: number[] = [];
		for (const record of this.recordsById.values()) {
			if (this.registeredGenerationByPdfId.get(record.pdfId) === session.generation) continue;
			await this.sendToClient(session.client, { type: "open_pdf", pdf_id: record.pdfId, pdf_path: record.pdfPath, title: basename(record.pdfPath) });
			reregistered.push(record.pdfId);
		}
		if (this.activeSession !== session) return;
		for (const pdfId of reregistered) {
			this.registeredGenerationByPdfId.set(pdfId, session.generation);
		}
		if (reregistered.length > 0) {
			this.updateViewerUrlsForSession(session);
		}
	}

	private async sendToClient(client: ViewerHostClient, message: McpToViewerHostMessage): Promise<void> {
		const response = await client.send(validateMcpToViewerHostMessage(message));
		if (isViewerHostControlResponse(response) && !response.ok) {
			throw new Error(response.error.message);
		}
	}

	private updateViewerUrlsForSession(session: ActiveViewerHostSession): void {
		const origin = session.client.origin.replace(/\/$/, "");
		for (const record of this.recordsById.values()) {
			record.viewerUrl = `${origin}/viewer/${record.pdfId}`;
		}
	}

	private appendReverseSynctexEvent(message: ViewerHostReverseSynctexMessage): void {
		const record = this.getRecord(message.pdf_id);
		const location = mapReverseSynctex({
			pdfPath: record.pdfPath,
			page: message.page,
			x: message.x,
			y: message.y,
			cwd: record.workspaceCwd || dirname(record.pdfPath),
		});
		this.eventStore.appendReverseSynctexEvent({
			type: "reverse_synctex",
			pdf_id: message.pdf_id,
			source_file: location.sourceFile,
			line: location.line,
			column: location.column,
			...(location.sourceLine === undefined ? {} : { source_line: location.sourceLine }),
			timestamp: new Date().toISOString(),
			page: message.page,
			x: message.x,
			y: message.y,
		});
	}

	private resolvePdfPath(pdfPath: string, workspaceContext: HostServiceWorkspaceContext): string {
		return isAbsolute(pdfPath) ? resolve(pdfPath) : resolve(workspaceContext.cwd, pdfPath);
	}

	private createPdfRecord(pdfPath: string, workspaceCwd: string, client: ViewerHostClient): TrackedViewerHostPdf {
		const normalizedPath = resolve(pdfPath);
		const pdfId = this.allocatePdfId();
		const record: TrackedViewerHostPdf = {
			pdfId,
			pdfPath: normalizedPath,
			workspaceCwd: resolve(workspaceCwd),
			createdAtNs: this.nowNs(),
			revision: 1,
			viewerUrl: "",
			fileSnapshot: snapshotPdf(normalizedPath),
		};
		this.setRecordViewerUrl(record, { client });
		return record;
	}

	private commitPdfRecord(record: TrackedViewerHostPdf): void {
		this.recordsById.set(record.pdfId, record);
		this.recordsByPath.set(record.pdfPath, record);
	}

	private setRecordViewerUrl(record: TrackedViewerHostPdf, session: Pick<ActiveViewerHostSession, "client">): void {
		const origin = session.client.origin.replace(/\/$/, "");
		record.viewerUrl = `${origin}/viewer/${record.pdfId}`;
	}

	private allocatePdfId(): number {
		for (let attempt = 0; attempt < 64; attempt += 1) {
			const candidate = this.makePdfId();
			if (!Number.isInteger(candidate) || candidate < MIN_PDF_ID || candidate > MAX_PDF_ID) {
				throw new Error(`Invalid generated pdf_id=${String(candidate)}`);
			}
			if (!this.recordsById.has(candidate)) return candidate;
		}
		throw new Error("Unable to allocate unique pdf_id");
	}

	private getRecord(pdfId: number): TrackedViewerHostPdf {
		const record = this.recordsById.get(pdfId);
		if (!record) throw new Error(`Unknown pdf_id=${pdfId}: no MCP-owned PDF record found`);
		return record;
	}

	private openOk(request: HostServiceOpenRequest, record: TrackedViewerHostPdf, reused: boolean): HostServiceOpenResponseEnvelope {
		return {
			protocol_version: request.protocol_version,
			request_id: request.request_id,
			operation: "open_pdf",
			status: "ok",
			generated_at_ns: this.nowNs(),
			status_details: {
				...this.openStatusBase(request, record.pdfPath),
				supported: true,
				service_available: true,
				owned: true,
				reused,
				handle: record.viewerUrl,
				pdf_id: record.pdfId,
				revision: record.revision,
				viewer_url: record.viewerUrl,
				managed_record: this.managedRecord(record, reused),
			},
		};
	}

	private openError(request: HostServiceOpenRequest, pdfPath: string, reason: string, errorCode: string, record?: TrackedViewerHostPdf): HostServiceOpenResponseEnvelope {
		return {
			protocol_version: request.protocol_version,
			request_id: request.request_id,
			operation: "open_pdf",
			status: "error",
			generated_at_ns: this.nowNs(),
			error: reason,
			status_details: {
				...this.openStatusBase(request, pdfPath),
				supported: false,
				service_available: false,
				owned: record !== undefined,
				reused: record !== undefined,
				...(record === undefined ? {} : { pdf_id: record.pdfId, revision: record.revision, viewer_url: record.viewerUrl, handle: record.viewerUrl, managed_record: this.managedRecord(record, true) }),
				error_code: errorCode,
				reason,
			},
		};
	}

	private openStatusBase(request: HostServiceOpenRequest, pdfPath: string) {
		return {
			protocol_version: request.protocol_version,
			workspace_context: request.workspace_context,
			request_id: request.request_id,
			operation: "open_pdf" as const,
			backend: VIEWER_HOST_BACKEND_NAME,
			backend_path: VIEWER_HOST_BACKEND_NAME,
			capabilities: VIEWER_HOST_CAPABILITIES,
			pdf: pdfPath,
		};
	}

	private managedRecord(record: TrackedViewerHostPdf, reused: boolean) {
		return {
			id: record.pdfId,
			pdfPath: record.pdfPath,
			viewerHandle: record.viewerUrl,
			viewerBackend: VIEWER_HOST_BACKEND_NAME,
			viewerOwned: false,
			createdAtNs: record.createdAtNs,
			reused,
			capabilities: VIEWER_HOST_CAPABILITIES,
			backendPath: VIEWER_HOST_BACKEND_NAME,
			defaultSourcePath: inferDefaultSourceFileForPdf(record.pdfPath),
			metadata: { viewer_host_origin: viewerOriginForRecord(record) ?? this.activeSession?.client.origin, revision: record.revision, file_snapshot: record.fileSnapshot },
		};
	}

	private jumpErrorCode(reason: string): string {
		if (/Viewer Host unavailable|control channel|relaunch|reconnect|registration rejected/i.test(reason)) return "viewer_host_unavailable";
		if (/missing SyncTeX sidecar/i.test(reason)) return "synctex_missing";
		if (/No SyncTeX mapping found/i.test(reason)) return "synctex_unmapped";
		if (/Unknown pdf_id/i.test(reason)) return "invalid_request";
		if (/source_file/i.test(reason)) return "invalid_request";
		return "synctex_failed";
	}
}

function viewerOriginForRecord(record: TrackedViewerHostPdf): string | undefined {
	try {
		return new URL(record.viewerUrl).origin;
	} catch {
		return undefined;
	}
}

function isViewerHostControlResponse(value: unknown): value is ViewerHostControlResponse {
	return typeof value === "object" && value !== null && "ok" in value;
}

function viewerHostUnavailableReason(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Viewer Host unavailable: ${reason}`;
}

function snapshotPdf(pdfPath: string): { size: number; mtimeMs: number } | undefined {
	try {
		const status = statSync(pdfPath);
		if (!status.isFile()) return undefined;
		return { size: status.size, mtimeMs: status.mtimeMs };
	} catch {
		return undefined;
	}
}

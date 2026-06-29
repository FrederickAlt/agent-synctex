import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { randomInt } from "node:crypto";
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
	type ViewerHostReverseSynctexMessage,
	type ViewerHostToMcpMessage,
} from "./viewer_host_protocol.ts";

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
	send(message: McpToViewerHostMessage): Promise<void>;
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

export interface ViewerHostMcpServiceOptions {
	client?: ViewerHostClient;
	eventStore?: PdfEventStore;
	makePdfId?: () => number;
	nowNs?: () => number;
}

export class ViewerHostMcpService {
	private readonly client: ViewerHostClient;
	private readonly eventStore: PdfEventStore;
	private readonly makePdfId: () => number;
	private readonly nowNs: () => number;
	private readonly recordsById = new Map<number, TrackedViewerHostPdf>();
	private readonly recordsByPath = new Map<string, TrackedViewerHostPdf>();
	readonly pdfOperations: HostServiceMcpPdfOperations;

	constructor(options: ViewerHostMcpServiceOptions = {}) {
		this.client = options.client ?? new FakeViewerHostClient();
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

		const existing = this.recordsByPath.get(pdfPath);
		if (existing) {
			await this.client.send({ type: "focus_pdf", pdf_id: existing.pdfId });
			return this.openOk(request, existing, true);
		}

		const record = this.trackPdf(pdfPath, request.workspace_context.cwd);
		await this.client.send({ type: "open_pdf", pdf_id: record.pdfId, pdf_path: record.pdfPath, title: basename(record.pdfPath) });
		return this.openOk(request, record, false);
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
			await this.client.send({
				type: "synctex_forward",
				pdf_id: record.pdfId,
				page: jump.page,
				x: jump.x,
				y: jump.y,
				source_file: jump.sourceFile,
				line: jump.line,
			});
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

	getPdfEvents(request: GetPdfEventsRequest): PdfEvent[] {
		return this.eventStore.getEvents(request);
	}

	async markTrackedPdfUpdated(pdfPath: string): Promise<{ tracked: boolean; pdfId?: number }> {
		const record = this.recordsByPath.get(resolve(pdfPath));
		if (!record) return { tracked: false };
		await this.client.send({ type: "pdf_maybe_updated", pdf_id: record.pdfId });
		return { tracked: true, pdfId: record.pdfId };
	}

	handleHostMessage(message: ViewerHostToMcpMessage): void {
		const parsed = validateViewerHostToMcpMessage(message);
		if (parsed.type !== "reverse_synctex") return;
		this.appendReverseSynctexEvent(parsed);
	}

	async stop(): Promise<void> {
		this.recordsById.clear();
		this.recordsByPath.clear();
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

	private trackPdf(pdfPath: string, workspaceCwd: string): TrackedViewerHostPdf {
		const normalizedPath = resolve(pdfPath);
		const pdfId = this.allocatePdfId();
		const record: TrackedViewerHostPdf = {
			pdfId,
			pdfPath: normalizedPath,
			workspaceCwd: resolve(workspaceCwd),
			createdAtNs: this.nowNs(),
			revision: 1,
			viewerUrl: `${this.client.origin.replace(/\/$/, "")}/viewer/${pdfId}`,
			fileSnapshot: snapshotPdf(normalizedPath),
		};
		this.recordsById.set(pdfId, record);
		this.recordsByPath.set(normalizedPath, record);
		return record;
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

	private openError(request: HostServiceOpenRequest, pdfPath: string, reason: string, errorCode: string): HostServiceOpenResponseEnvelope {
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
				owned: false,
				reused: false,
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
			metadata: { viewer_host_origin: this.client.origin, revision: record.revision, file_snapshot: record.fileSnapshot },
		};
	}

	private jumpErrorCode(reason: string): string {
		if (/missing SyncTeX sidecar/i.test(reason)) return "synctex_missing";
		if (/No SyncTeX mapping found/i.test(reason)) return "synctex_unmapped";
		if (/Unknown pdf_id/i.test(reason)) return "invalid_request";
		if (/source_file/i.test(reason)) return "invalid_request";
		return "synctex_failed";
	}
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

import { randomInt, randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	rmSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { HostServiceCompileService } from "./host_service_compile.ts";
import {
	buildRasterizeErrorResponse,
	executeRasterizePdfRequest,
	normalizeWorkspaceContextForRasterize,
} from "./host_service_rasterization.ts";
import { HostServiceSessionLeaseService, requireSessionId } from "./host_service_session_leases.ts";
import { safeInlinePreviewPngPath } from "./preview/inline_preview_metadata.ts";
import {
	FakeViewerBackend,
	type FakeViewerBackendOptions,
	ZathuraViewerBackend,
} from "./host_service_viewer_backends.ts";
import {
	HostServiceManagedViewerService,
} from "./host_service_managed_viewer.ts";
import type {
	HostServiceAnyResponseDetails,
	HostServiceCallbackTarget,
	HostServiceCallbackTargetRegistration,
	HostServiceCloseRequest,
	HostServiceCloseResponseDetails,
	HostServiceCloseResponseEnvelope,
	HostServiceCompileRequest,
	HostServiceCompileResponseDetails,
	HostServiceCompileResponseEnvelope,
	HostServiceCompileSnippetRequest,
	HostServiceCompileSnippetResponseDetails,
	HostServiceCompileSnippetResponseEnvelope,
	HostServiceJumpRequest,
	HostServiceJumpResponseDetails,
	HostServiceJumpResponseEnvelope,
	HostServiceManagedViewerRecord,
	HostServiceManagedViewerRecordInput,
	HostServicePdfIdKnownRecord,
	HostServicePdfIdRecordState,
	HostServiceOpenRequest,
	HostServiceOpenResponseDetails,
	HostServiceOpenResponseEnvelope,
	HostServiceOperation,
	HostServiceRasterizeArtifact,
	HostServiceRasterizeRequest,
	HostServiceRasterizeResponseDetails,
	HostServiceRasterizeResponseEnvelope,
	HostServiceRegisterCallbackTargetRequest,
	HostServiceRegisterCallbackTargetResponseDetails,
	HostServiceRegisterCallbackTargetResponseEnvelope,
	HostServiceRequest,
	HostServiceSessionHeartbeatRequest,
	HostServiceSessionHeartbeatResponseDetails,
	HostServiceSessionHeartbeatResponseEnvelope,
	HostServiceGetPendingNotificationsRequest,
	HostServiceGetPendingNotificationsResponseDetails,
	HostServiceGetPendingNotificationsResponseEnvelope,
	HostServiceResolveCallbackTargetRequest,
	HostServiceResolveCallbackTargetResponseDetails,
	HostServiceResolveCallbackTargetResponseEnvelope,
	HostServiceResponseEnvelope,
	HostServiceResponseError,
	HostServiceStatusRequest,
	HostServiceStatusResponseDetails,
	HostServiceStatusResponseEnvelope,
	HostServiceUnregisterCallbackTargetRequest,
	HostServiceUnregisterCallbackTargetResponseDetails,
	HostServiceUnregisterCallbackTargetResponseEnvelope,
	HostServiceViewerBackendCapabilities,
	HostServiceWorkspaceContext,
} from "./host_service_protocol.ts";
import {
	buildMcpErrorResponse,
	handleFramedMcpRequest,
	HostServiceMcpFrameReader,
	mcpFramedResponse,
	MCP_ERROR_PARSE_ERROR,
} from "./host_service_mcp.ts";
import type { ViewerBackendAdapter } from "./host_service_viewer_protocol.ts";
import { createLogger } from "./logging.ts";
import { HostServiceContinuousCompileManager } from "./host_service_continuous_compile.ts";

const clientLogger = createLogger("host-service.client");
const serverLogger = createLogger("host-service.server");

export { FakeViewerBackend, HostServiceContinuousCompileManager, HostServiceSessionLeaseService, ZathuraViewerBackend };
export type {
	FakeViewerBackendOptions,
	HostServiceAnyResponseDetails,
	HostServiceCallbackTarget,
	HostServiceCallbackTargetRegistration,
	HostServiceCloseRequest,
	HostServiceCloseResponseDetails,
	HostServiceCloseResponseEnvelope,
	HostServiceCompileRequest,
	HostServiceCompileResponseDetails,
	HostServiceCompileResponseEnvelope,
	HostServiceCompileSnippetRequest,
	HostServiceCompileSnippetResponseDetails,
	HostServiceCompileSnippetResponseEnvelope,
	HostServiceJumpRequest,
	HostServiceJumpResponseDetails,
	HostServiceJumpResponseEnvelope,
	HostServiceManagedViewerRecord,
	HostServiceManagedViewerRecordInput,
	HostServicePdfIdKnownRecord,
	HostServicePdfIdRecordState,
	HostServiceOpenRequest,
	HostServiceOpenResponseDetails,
	HostServiceOpenResponseEnvelope,
	HostServiceOperation,
	HostServiceRasterizeArtifact,
	HostServiceRasterizeRequest,
	HostServiceRasterizeResponseDetails,
	HostServiceRasterizeResponseEnvelope,
	HostServiceRegisterCallbackTargetRequest,
	HostServiceRegisterCallbackTargetResponseDetails,
	HostServiceRegisterCallbackTargetResponseEnvelope,
	HostServiceRequest,
	HostServiceSessionHeartbeatRequest,
	HostServiceSessionHeartbeatResponseDetails,
	HostServiceSessionHeartbeatResponseEnvelope,
	HostServiceGetPendingNotificationsRequest,
	HostServiceGetPendingNotificationsResponseDetails,
	HostServiceGetPendingNotificationsResponseEnvelope,
	HostServiceResolveCallbackTargetRequest,
	HostServiceResolveCallbackTargetResponseDetails,
	HostServiceResolveCallbackTargetResponseEnvelope,
	HostServiceResponseEnvelope,
	HostServiceResponseError,
	HostServiceStatusRequest,
	HostServiceStatusResponseDetails,
	HostServiceStatusResponseEnvelope,
	HostServiceUnregisterCallbackTargetRequest,
	HostServiceUnregisterCallbackTargetResponseDetails,
	HostServiceUnregisterCallbackTargetResponseEnvelope,
	HostServiceViewerBackendCapabilities,
	HostServiceWorkspaceContext,
	ViewerBackendAdapter,
};
export interface HostServicePdfIdRegistryOptions {
	minPdfId?: number;
	maxPdfId?: number;
	makePdfId?: () => number;
	maxAllocationAttempts?: number;
}


export interface HostServiceClientOptions {
	socketPath?: string;
	requestTimeoutMs?: number;
	requestIdFactory?: () => string;
}

export interface HostServiceServerOptions {
	socketPath?: string;
	serviceName?: string;
	serviceInstanceId?: string;
	viewerBackend?: ViewerBackendAdapter;
	managedViewerRecords?: HostServicePdfIdRegistry;
	sessionLeases?: HostServiceSessionLeaseService;
	continuousCompileManager?: HostServiceContinuousCompileManager;
	sessionPruneIntervalMs?: number;
}

const PROTOCOL_VERSION = 1;
const DEFAULT_HOST_SERVICE_NAME = "tex-actions-host-service";
const HOST_SERVICE_RUNTIME_DIR_NAME = "tex-actions";
const HOST_SERVICE_SOCKET_NAME = "host-service.sock";
export const HOST_SERVICE_SOCKET_PATH_ENV_VAR = "TEX_ACTIONS_HOST_SERVICE_SOCKET_PATH";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const REQUIRED_DIRECTORY_MODE = 0o700;
const REQUIRED_SOCKET_MODE = 0o600;
const MAX_PAYLOAD_BYTES = 16_384;
const STARTUP_SOCKET_CHECK_TIMEOUT_MS = 250;
const ACTIVE_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_PRUNE_INTERVAL_MS = 1_000;
const FALLBACK_WORKSPACE_CONTEXT: HostServiceWorkspaceContext = { cwd: "/" };
export const MIN_ACTIVE_PDF_ID = 1;
export const MAX_ACTIVE_PDF_ID = 99_999_999;
const DEFAULT_MIN_ACTIVE_PDF_ID = MIN_ACTIVE_PDF_ID;
const DEFAULT_MAX_ACTIVE_PDF_ID = MAX_ACTIVE_PDF_ID;
const DEFAULT_ACTIVE_PDF_ID_ALLOCATION_ATTEMPTS = 64;

const CALLBACK_SOCKET_PROBE_TIMEOUT_MS = 75;
interface HostServiceStoredCallbackTarget {
	target: HostServiceCallbackTarget;
	staleAfterNs?: number;
}

export interface HostServiceSocketResolutionOptions {
	platform?: NodeJS.Platform;
	runtimeDir?: string;
	homeDir?: string;
	fallbackDir?: string;
	socketPathOverride?: string;
}

export function resolveHostServiceSocketDirectory(options: HostServiceSocketResolutionOptions = {}): string {
	const platform = options.platform ?? process.platform;
	const runtimeDir = options.runtimeDir ?? process.env.XDG_RUNTIME_DIR;
	const homeDir = options.homeDir ?? process.env.HOME;
	const fallbackDir = options.fallbackDir ?? tmpdir();
	if (platform === "darwin") {
		if (homeDir) {
			return join(homeDir, "Library", "Caches", HOST_SERVICE_RUNTIME_DIR_NAME);
		}
		return join(fallbackDir, "Library", "Caches", HOST_SERVICE_RUNTIME_DIR_NAME);
	}
	const baseDir = runtimeDir ?? homeDir ?? fallbackDir;
	return join(baseDir, HOST_SERVICE_RUNTIME_DIR_NAME);
}

export function resolveHostServiceSocketPath(options: HostServiceSocketResolutionOptions = {}): string {
	const socketPathOverride = options.socketPathOverride ?? process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	if (socketPathOverride) {
		return resolve(socketPathOverride);
	}
	const socketDirectory = resolveHostServiceSocketDirectory(options);
	return resolve(socketDirectory, HOST_SERVICE_SOCKET_NAME);
}

export function defaultHostServiceSocketPath(): string {
	return resolveHostServiceSocketPath();
}

export class HostServicePdfIdRegistry {
	private readonly minPdfId: number;
	private readonly maxPdfId: number;
	private readonly makePdfId: () => number;
	private readonly maxAllocationAttempts: number;
	private readonly activeRecords = new Map<number, HostServiceManagedViewerRecord>();
	private readonly staleRecords = new Map<number, HostServiceManagedViewerRecord>();
	private readonly closedRecords = new Map<number, HostServiceManagedViewerRecord>();

	constructor(options: HostServicePdfIdRegistryOptions = {}) {
		this.minPdfId = options.minPdfId ?? DEFAULT_MIN_ACTIVE_PDF_ID;
		this.maxPdfId = options.maxPdfId ?? DEFAULT_MAX_ACTIVE_PDF_ID;
		if (
			!Number.isInteger(this.minPdfId) ||
			!Number.isInteger(this.maxPdfId) ||
			this.minPdfId < MIN_ACTIVE_PDF_ID ||
			this.maxPdfId > MAX_ACTIVE_PDF_ID ||
			this.maxPdfId < this.minPdfId
		) {
			throw new Error("invalid pdf id range");
		}
		this.makePdfId = options.makePdfId ?? (() => randomInt(this.minPdfId, this.maxPdfId + 1));
		this.maxAllocationAttempts = options.maxAllocationAttempts ?? DEFAULT_ACTIVE_PDF_ID_ALLOCATION_ATTEMPTS;
		if (!Number.isInteger(this.maxAllocationAttempts) || this.maxAllocationAttempts <= 0) {
			throw new Error("invalid maxAllocationAttempts");
		}
	}

	trackRecord(record: HostServiceManagedViewerRecordInput): HostServiceManagedViewerRecord {
		const id = this.allocatePdfId();
		const nowNs = Date.now() * 1_000_000;
		const managedRecord: HostServiceManagedViewerRecord = {
			id,
			pdfPath: record.pdfPath,
			viewerHandle: record.viewerHandle,
			viewerBackend: record.viewerBackend,
			viewerOwned: record.viewerOwned,
			createdAtNs: nowNs,
			pid: record.pid,
			pidDiagnostic: record.pidDiagnostic,
			reused: record.reused,
			capabilities: record.capabilities,
			backendPath: record.backendPath,
			callback: record.callback,
			defaultSourcePath: record.defaultSourcePath,
			metadata: record.metadata,
		};
		this.activeRecords.set(id, managedRecord);
		return managedRecord;
	}

	registerRecord(record: HostServiceManagedViewerRecordInput): HostServiceManagedViewerRecord {
		return this.trackRecord(record);
	}

	get activeCount(): number {
		return this.activeRecords.size;
	}

	getActiveRecord(pdfId: number): HostServiceManagedViewerRecord {
		const knownRecord = this.getKnownRecord(pdfId);
		if (knownRecord.state === "active") {
			return knownRecord.record;
		}
		if (knownRecord.state === "stale") {
			throw new Error(`Stale pdf_id=${pdfId}: reopen this PDF record before retrying`);
		}
		throw new Error(`Closed pdf_id=${pdfId}: this record has been removed and is no longer active`);
	}

	getKnownRecord(pdfId: number): HostServicePdfIdKnownRecord {
		const activeRecord = this.activeRecords.get(pdfId);
		if (activeRecord) {
			return { state: "active", record: activeRecord };
		}
		const staleRecord = this.staleRecords.get(pdfId);
		if (staleRecord) {
			return { state: "stale", record: staleRecord };
		}
		const closedRecord = this.closedRecords.get(pdfId);
		if (closedRecord) {
			return { state: "closed", record: closedRecord };
		}
		throw new Error(`Unknown pdf_id=${pdfId}: no active pdf record found`);
	}

	findActiveRecord(predicate: (record: HostServiceManagedViewerRecord) => boolean): HostServiceManagedViewerRecord | undefined {
		for (const record of this.activeRecords.values()) {
			if (predicate(record)) {
				return record;
			}
		}
		return undefined;
	}

	markRecordStale(pdfId: number): HostServiceManagedViewerRecord {
		const activeRecord = this.activeRecords.get(pdfId);
		if (!activeRecord) {
			this.getActiveRecord(pdfId); // throws clear, classification-rich error for non-active IDs
			throw new Error(`Unable to mark pdf_id=${pdfId} as stale`);
		}
		this.activeRecords.delete(pdfId);
		this.staleRecords.set(pdfId, activeRecord);
		return activeRecord;
	}

	removeRecord(pdfId: number): HostServiceManagedViewerRecord {
		const activeRecord = this.activeRecords.get(pdfId);
		if (activeRecord) {
			this.activeRecords.delete(pdfId);
			this.closedRecords.set(pdfId, activeRecord);
			return activeRecord;
		}
		if (this.staleRecords.has(pdfId)) {
			throw new Error(`Stale pdf_id=${pdfId}: reopen this PDF record before retrying`);
		}
		if (this.closedRecords.has(pdfId)) {
			throw new Error(`Closed pdf_id=${pdfId}: this record has been removed and is no longer active`);
		}
		throw new Error(`Unknown pdf_id=${pdfId}: no active pdf record found`);
	}

	reviveRecord(pdfId: number): HostServiceManagedViewerRecord {
		const knownRecord = this.getKnownRecord(pdfId);
		if (knownRecord.state === "active") {
			return knownRecord.record;
		}
		this.staleRecords.delete(pdfId);
		this.closedRecords.delete(pdfId);
		this.activeRecords.set(pdfId, knownRecord.record);
		return knownRecord.record;
	}

	reviveRecordIfState(
		pdfId: number,
		expectedState: HostServicePdfIdRecordState,
		expectedRecord: HostServiceManagedViewerRecord,
	): HostServiceManagedViewerRecord | undefined {
		let knownRecord: HostServicePdfIdKnownRecord;
		try {
			knownRecord = this.getKnownRecord(pdfId);
		} catch {
			return undefined;
		}
		if (knownRecord.state !== expectedState || knownRecord.record !== expectedRecord) {
			return undefined;
		}
		if (knownRecord.state !== "active") {
			this.staleRecords.delete(pdfId);
			this.closedRecords.delete(pdfId);
			this.activeRecords.set(pdfId, knownRecord.record);
		}
		return knownRecord.record;
	}

	closeRecord(pdfId: number): HostServiceManagedViewerRecord {
		return this.removeRecord(pdfId);
	}

	clear(): void {
		this.activeRecords.clear();
		this.staleRecords.clear();
		this.closedRecords.clear();
	}

	private allocatePdfId(): number {
		const collisions: number[] = [];
		for (let attempt = 0; attempt < this.maxAllocationAttempts; attempt += 1) {
			const candidate = this.makePdfId();
			if (
				!Number.isInteger(candidate) ||
				candidate < MIN_ACTIVE_PDF_ID ||
				candidate > MAX_ACTIVE_PDF_ID ||
				candidate < this.minPdfId ||
				candidate > this.maxPdfId
			) {
				throw new Error(`Invalid generated pdf_id=${String(candidate)}; expected integer in ${this.minPdfId}..${this.maxPdfId}`);
			}
			if (
				this.activeRecords.has(candidate) ||
				this.staleRecords.has(candidate) ||
				this.closedRecords.has(candidate)
			) {
				collisions.push(candidate);
				continue;
			}
			return candidate;
		}
		throw new Error(`Unable to allocate unique active pdf_id after ${this.maxAllocationAttempts} attempts (collisions: ${collisions.join(", ")})`);
	}
}

export class HostServiceClient {
	private readonly socketPath: string;
	readonly requestTimeoutMs: number;
	private readonly makeRequestId: () => string;

	constructor(options: HostServiceClientOptions = {}) {
		this.socketPath = resolve(options.socketPath ?? defaultHostServiceSocketPath());
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.makeRequestId = options.requestIdFactory ?? (() => `host-${randomUUID()}`);
	}

	async requestStatus(
		workspaceContext: HostServiceWorkspaceContext,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceStatusResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "status",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidStatusResponse(response, requestId)) {
			throw new Error(`Malformed host service status response payload: ${JSON.stringify(response)}`);
		}
		if (response.status === "error") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestSessionHeartbeat(
		workspaceContext: HostServiceWorkspaceContext,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceSessionHeartbeatResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "session_heartbeat",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidSessionHeartbeatResponse(response, requestId)) {
			throw new Error(`Malformed host service session_heartbeat response payload: ${JSON.stringify(response)}`);
		}
		if (response.status === "error") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestPendingNotifications(
		workspaceContext: HostServiceWorkspaceContext,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceGetPendingNotificationsResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "get_pending_notifications",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidGetPendingNotificationsResponse(response, requestId)) {
			throw new Error(`Malformed host service get_pending_notifications response payload: ${JSON.stringify(response)}`);
		}
		if (response.status === "error") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestCompileLatexFile(
		request: HostServiceCompileRequest["details"],
		workspaceContext: HostServiceWorkspaceContext,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceCompileResponseDetails> {
		const context = normalizeWorkspaceContextForCompile(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request({
			protocol_version: PROTOCOL_VERSION,
			request_id: requestId,
			operation: "compile_latex_file",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: context,
			details: {
				latex_file_path: request.latex_file_path,
				...(request.compiler === undefined ? {} : { compiler: request.compiler }),
				...(request.clean === undefined ? {} : { clean: request.clean }),
				...(request.open_pdf === undefined ? {} : { open_pdf: request.open_pdf }),
				...(request.continuous === undefined ? {} : { continuous: request.continuous }),
				...(request.reuse_existing === undefined ? {} : { reuse_existing: request.reuse_existing }),
				...(request.require_persistent_viewer === undefined ? {} : { require_persistent_viewer: request.require_persistent_viewer }),
				...(request.callback_target_id === undefined ? {} : { callback_target_id: request.callback_target_id }),
				...(request.callback === undefined ? {} : { callback: request.callback }),
			},

		},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidCompileResponse(response, requestId)) {
			throw new Error(`Malformed host service compile_latex_file response payload: ${JSON.stringify(response)}`);
		}
		if (response.status === "error") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			const error = new Error(`${response.error || "host service returned error status"}${suffix}`) as HostServiceResponseError;
			error.statusDetails = response.status_details;
			error.errorCode = response.status_details.error_code;
			error.requestId = response.request_id;
			error.requestOperation = "compile_latex_file";
			throw error;
		}
		return response.status_details;
	}

	async requestCompileLatexSnippet(
		request: HostServiceCompileSnippetRequest["details"],
		workspaceContext: HostServiceWorkspaceContext,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceCompileSnippetResponseDetails> {
		const context = normalizeWorkspaceContextForSnippetCompile(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request({
			protocol_version: PROTOCOL_VERSION,
			request_id: requestId,
			operation: "compile_latex_snippet",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: context,
			details: {
				latex_source: request.latex_source,
				...(request.compiler === undefined ? {} : { compiler: request.compiler }),
				...(request.suppress_page_numbers === undefined
					? {}
					: { suppress_page_numbers: request.suppress_page_numbers }),
				...(request.crop_to_content === undefined ? {} : { crop_to_content: request.crop_to_content }),
				...(request.open_pdf === undefined ? {} : { open_pdf: request.open_pdf }),
				...(request.fixed_preview === undefined ? {} : { fixed_preview: request.fixed_preview }),
				...(request.reuse_existing === undefined ? {} : { reuse_existing: request.reuse_existing }),
				...(request.require_persistent_viewer === undefined ? {} : { require_persistent_viewer: request.require_persistent_viewer }),
				...(request.callback_target_id === undefined ? {} : { callback_target_id: request.callback_target_id }),
				...(request.callback === undefined ? {} : { callback: request.callback }),
			},

		},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidCompileSnippetResponse(response, requestId)) {
			throw new Error(`Malformed host service compile_latex_snippet response payload: ${JSON.stringify(response)}`);
		}
		if (response.status === "error") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			const error = new Error(`${response.error || "host service returned error status"}${suffix}`) as HostServiceResponseError;
			error.statusDetails = response.status_details;
			error.errorCode = response.status_details.error_code;
			error.requestId = response.request_id;
			error.requestOperation = "compile_latex_snippet";
			throw error;
		}
		return response.status_details;
	}

	async requestRasterizePdf(
		request: HostServiceRasterizeRequest["details"],
		workspaceContext: HostServiceWorkspaceContext,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceRasterizeResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request({
			protocol_version: PROTOCOL_VERSION,
			request_id: requestId,
			operation: "rasterize",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: context,
			details: {
				pdf_path: request.pdf_path,
				...(request.dpi === undefined ? {} : { dpi: request.dpi }),
				...(request.page === undefined ? {} : { page: request.page }),
				...(request.merge_pages === undefined ? {} : { merge_pages: request.merge_pages }),
			},
		},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidRasterizeResponse(response, requestId)) {
			throw new Error(`Malformed host service rasterize response payload: ${JSON.stringify(response)}`);
		}
		if (response.status === "error") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestRegisterCallbackTarget(
		workspaceContext: HostServiceWorkspaceContext,
		registration: HostServiceCallbackTargetRegistration,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceRegisterCallbackTargetResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "register_callback_target",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
				target_id: registration.target_id,
				target: registration.target,
				stale_after_ms: registration.stale_after_ms,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidRegisterCallbackTargetResponse(response, requestId)) {
			throw new Error(`Malformed host service register_callback_target response payload: ${JSON.stringify(response)}`);
		}
		if (response.status !== "ok") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestUnregisterCallbackTarget(
		workspaceContext: HostServiceWorkspaceContext,
		targetId: string,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceUnregisterCallbackTargetResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "unregister_callback_target",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
				target_id: targetId,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidUnregisterCallbackTargetResponse(response, requestId)) {
			throw new Error(`Malformed host service unregister_callback_target response payload: ${JSON.stringify(response)}`);
		}
		if (response.status !== "ok") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestResolveCallbackTarget(
		workspaceContext: HostServiceWorkspaceContext,
		targetId: string,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceResolveCallbackTargetResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "resolve_callback_target",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
				target_id: targetId,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidResolveCallbackTargetResponse(response, requestId)) {
			throw new Error(`Malformed host service resolve_callback_target response payload: ${JSON.stringify(response)}`);
		}
		if (response.status !== "ok") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestOpenPdf(
		workspaceContext: HostServiceWorkspaceContext,
		details: HostServiceOpenRequest["details"],
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceOpenResponseDetails> {
		const context = normalizeWorkspaceContextForViewer(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "open_pdf",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
				details: {
					pdf_path: details.pdf_path,
					callback: details.callback,
					reuse_existing: details.reuse_existing,
					require_persistent_viewer: details.require_persistent_viewer,
				},
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidOpenResponse(response, requestId)) {
			throw new Error(`Malformed host service open_pdf response payload: ${JSON.stringify(response)}`);
		}
		if (response.status !== "ok") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestClosePdf(
		workspaceContext: HostServiceWorkspaceContext,
		pdfId: number,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceCloseResponseDetails> {
		if (!Number.isInteger(pdfId) || pdfId <= 0) {
			throw new Error("invalid pdf_id");
		}
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const requestPayload: HostServiceCloseRequest = {
			protocol_version: PROTOCOL_VERSION,
			request_id: requestId,
			operation: "close_pdf",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: context,
			pdf_id: pdfId,
		};
		const response = await this.request(
			requestPayload,
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidCloseResponse(response, requestId)) {
			throw new Error(`Malformed host service close_pdf response payload: ${JSON.stringify(response)}`);
		}
		if (response.status !== "ok") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	async requestJumpPdf(
		workspaceContext: HostServiceWorkspaceContext,
		details: { pdf_id: number; line: number; source_file?: string },
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceJumpResponseDetails> {
		if (!Number.isInteger(details.pdf_id) || details.pdf_id <= 0) {
			throw new Error("invalid pdf_id");
		}
		if (!Number.isInteger(details.line) || details.line <= 0) {
			throw new Error("line must be a positive integer");
		}
		const context = normalizeWorkspaceContextForViewer(workspaceContext);
		const requestId = this.makeRequestId();
		const requestPayload: HostServiceJumpRequest = {
			protocol_version: PROTOCOL_VERSION,
			request_id: requestId,
			operation: "jump_pdf",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: context,
			pdf_id: details.pdf_id,
			line: details.line,
			...(details.source_file === undefined ? {} : { source_file: details.source_file }),
		};
		const response = await this.request(
			requestPayload,
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidJumpResponse(response, requestId)) {
			throw new Error(`Malformed host service jump_pdf response payload: ${JSON.stringify(response)}`);
		}
		if (response.status !== "ok") {
			const jumpResponseDetails = response.status_details;
			const errorCode = typeof jumpResponseDetails.error_code === "string" ? jumpResponseDetails.error_code : undefined;
			const suffix = errorCode ? ` (code=${errorCode})` : "";
			const parts: string[] = [];
			if (typeof jumpResponseDetails.backend === "string" && jumpResponseDetails.backend) {
				parts.push(`backend=${jumpResponseDetails.backend}`);
			}
			if (typeof jumpResponseDetails.backend_path === "string" && jumpResponseDetails.backend_path) {
				parts.push(`backend_path=${jumpResponseDetails.backend_path}`);
			}
			if (typeof jumpResponseDetails.pdf_id === "number" && Number.isInteger(jumpResponseDetails.pdf_id)) {
				parts.push(`pdf_id=${jumpResponseDetails.pdf_id}`);
			}
			if (typeof jumpResponseDetails.pdf === "string") {
				parts.push(`pdf=${jumpResponseDetails.pdf}`);
			}
			if (typeof jumpResponseDetails.source_file === "string") {
				parts.push(`source_file=${jumpResponseDetails.source_file}`);
			}
			if (typeof jumpResponseDetails.line === "number") {
				parts.push(`line=${jumpResponseDetails.line}`);
			}
			if (typeof jumpResponseDetails.source_line === "string") {
				parts.push(`source_line=${JSON.stringify(jumpResponseDetails.source_line)}`);
			}
			if (typeof jumpResponseDetails.reason === "string") {
				parts.push(`reason=${jumpResponseDetails.reason}`);
			}
			const context = parts.length > 0 ? ` ${parts.join(" ")}` : "";
			const diagnostics = Array.isArray(jumpResponseDetails.diagnostics)
				? ` diagnostics=${JSON.stringify(jumpResponseDetails.diagnostics)}`
				: "";
			throw new Error(`${response.error || jumpResponseDetails.reason || "host service returned error status"}${suffix}${context}${diagnostics}`);
		}
		return response.status_details;
	}

	async requestOpen(
		workspaceContext: HostServiceWorkspaceContext,
		details: HostServiceOpenRequest["details"],
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceOpenResponseDetails> {
		return this.requestOpenPdf(workspaceContext, details, signal, requestTimeoutMs);
	}

	private async request(
		request: HostServiceRequest,
		signal: AbortSignal | undefined,
		requestTimeoutMs: number,
	): Promise<HostServiceResponseEnvelope> {
		const startedAt = Date.now();
		clientLogger.info("request.begin", {
			operation: request.operation,
			request_id: request.request_id,
			socket_path: this.socketPath,
			cwd: request.workspace_context.cwd,
			timeout_ms: requestTimeoutMs,
		});
		if (!isValidWorkspaceContext(request.workspace_context)) {
			throw new Error("host service request requires valid workspace_context.cwd");
		}
		if (signal?.aborted) {
			throw new Error("host service request cancelled before submit");
		}
		validateHostServiceSocketDirectory(dirname(this.socketPath));

		if (request.operation === "compile_latex_file") {
			normalizeWorkspaceContextForCompile(request.workspace_context);
		}
		if (request.operation === "compile_latex_snippet") {
			normalizeWorkspaceContextForSnippetCompile(request.workspace_context);
		}
		if (request.operation === "rasterize") {
			normalizeWorkspaceContextForRasterize(request.workspace_context);
		}
		if (request.operation === "open_pdf" || request.operation === "jump_pdf") {
			normalizeWorkspaceContextForViewer(request.workspace_context);
		}

		const payload = `${JSON.stringify(request)}\n`;
		if (payload.length > MAX_PAYLOAD_BYTES) {
			throw new Error("host service request too large");
		}

		let abortUnsub: (() => void) | undefined;
		const requestPromise = new Promise<HostServiceResponseEnvelope>((resolve, reject) => {
			let settled = false;
			let raw = "";
			const finish = (value: HostServiceResponseEnvelope | Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (value instanceof Error) {
					reject(value);
				} else {
					resolve(value);
				}
			};

			const socket = createConnection({ path: this.socketPath });
			const timer = setTimeout(() => {
				finish(new Error("host service request timed out; is the host service running?"));
				socket.destroy();
			}, requestTimeoutMs);
			timer.unref?.();

			if (signal) {
				abortUnsub = () => {
					finish(new Error("host service request aborted"));
					socket.destroy();
				};
				signal.addEventListener("abort", abortUnsub, { once: true });
			}

			socket.setEncoding("utf8");
			socket.setTimeout(requestTimeoutMs, () => {
				finish(new Error("host service request timed out; is the host service running?"));
				socket.destroy();
			});

			socket.on("connect", () => {
				socket.write(payload);
			});
			socket.on("data", (chunk) => {
				raw += String(chunk);
				if (raw.length > MAX_PAYLOAD_BYTES) {
					finish(new Error("host service response too large"));
					socket.destroy();
					return;
				}
				const lineBreak = raw.indexOf("\n");
				if (lineBreak < 0) return;
				try {
					const response = parseResponse(raw.slice(0, lineBreak).trim(), request.request_id, request.operation);
					finish(response);
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
				socket.destroy();
			});
			socket.once("close", () => {
				if (!settled && !raw.trim()) {
					finish(new Error("host service disconnected without response"));
				} else {
					finishIfNotSettled();
				}
			});
			socket.once("error", (error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
					finish(new Error("host service socket unavailable; is the host service running?"));
					return;
				}
				finish(error instanceof Error ? error : new Error(String(error)));
			});

			const finishIfNotSettled = () => {
				if (!settled && raw.trim()) {
					try {
						const response = parseResponse(raw.trim(), request.request_id, request.operation);
						finish(response);
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				}
			};
		});

		try {
			const response = await requestPromise.finally(() => {
				if (signal && abortUnsub) {
					signal.removeEventListener("abort", abortUnsub);
				}
			});
			clientLogger.info("request.end", {
				operation: request.operation,
				request_id: request.request_id,
				status: response.status,
				duration_ms: Date.now() - startedAt,
			});
			return response;
		} catch (error) {
			clientLogger.warn("request.error", {
				operation: request.operation,
				request_id: request.request_id,
				duration_ms: Date.now() - startedAt,
				error,
			});
			throw error;
		}
	}
}

export class HostServiceServer {
	readonly socketPath: string;
	readonly serviceName: string;
	private readonly protocolVersion = PROTOCOL_VERSION;
	private readonly viewerBackend: ViewerBackendAdapter;
	private readonly managedViewerRecords: HostServicePdfIdRegistry;
	private readonly managedViewerService: HostServiceManagedViewerService;
	private readonly compileService: HostServiceCompileService;
	private readonly sessionLeases: HostServiceSessionLeaseService;
	private readonly continuousCompileManager: HostServiceContinuousCompileManager;
	private readonly sessionPruneIntervalMs: number;
	private sessionPruneTimer: ReturnType<typeof setInterval> | null = null;
	private stopping = false;
	private server: Server | null = null;
	private startedAtNs = 0;
	private serviceInstanceId: string;
	private totalRequests = 0;
	private socketOwnedByServer = false;
	private readonly activeConnections = new Set<Socket>();
	private readonly callbackTargets = new Map<string, HostServiceStoredCallbackTarget>();

	constructor(options: HostServiceServerOptions = {}) {
		this.socketPath = resolve(options.socketPath ?? defaultHostServiceSocketPath());
		this.serviceName = options.serviceName ?? DEFAULT_HOST_SERVICE_NAME;
		this.serviceInstanceId = options.serviceInstanceId ?? `host-service-${Date.now()}-${randomUUID()}`;
		this.viewerBackend = options.viewerBackend ?? new ZathuraViewerBackend();
		this.managedViewerRecords = options.managedViewerRecords ?? new HostServicePdfIdRegistry();
		this.managedViewerService = new HostServiceManagedViewerService({
			protocolVersion: this.protocolVersion,
			viewerBackend: this.viewerBackend,
			managedViewerRecords: this.managedViewerRecords,
		});
		this.sessionLeases = options.sessionLeases ?? new HostServiceSessionLeaseService();
		this.continuousCompileManager = options.continuousCompileManager ?? new HostServiceContinuousCompileManager();
		this.sessionPruneIntervalMs = options.sessionPruneIntervalMs ?? DEFAULT_SESSION_PRUNE_INTERVAL_MS;
		this.continuousCompileManager.setNotificationSink({
			isSessionLive: (sessionId) => this.sessionLeases.isLive(sessionId),
			queuePendingNotification: (sessionId, notification) => this.sessionLeases.queuePendingNotification(sessionId, notification),
			clearPendingNotificationsForRoot: (rootSource) => this.sessionLeases.clearPendingNotificationsForRoot(rootSource),
			clearPendingNotificationsForSessionRoot: (sessionId, rootSource) => this.sessionLeases.clearPendingNotificationsForSessionRoot(sessionId, rootSource),
		});
		this.compileService = new HostServiceCompileService({
			protocolVersion: this.protocolVersion,
			managedViewerService: this.managedViewerService,
			resolveManagedOpenCallback: this.resolveManagedOpenCallback.bind(this),
			refreshContinuousSessionLease: (workspaceContext) => {
				if (!this.stopping) {
					this.sessionLeases.heartbeat(workspaceContext);
				}
			},
			continuousCompileManager: this.continuousCompileManager,
		});
		this.sessionLeases.onExpiredSessions((sessionIds) => this.continuousCompileManager.removeSessions(sessionIds));
	}

	async start(): Promise<void> {
		if (this.server) {
			return;
		}
		serverLogger.info("start.begin", { socket_path: this.socketPath, service_name: this.serviceName });
		this.stopping = false;
		this.continuousCompileManager.setAcceptingSubscriptions(true);
		this.socketOwnedByServer = false;
		try {
			await this.prepareSocketPath();
			this.startedAtNs = Date.now() * 1_000_000;
			const server = createServer((socket) => {
				this.handleConnection(socket);
			});
			this.server = server;

			await new Promise<void>((resolve, reject) => {
				const finalizeError = (error: Error) => {
					if (this.server === server) {
						this.server = null;
					}
					reject(error);
				};
				server.once("error", finalizeError);
				server.listen(this.socketPath, () => {
					try {
						chmodSync(this.socketPath, REQUIRED_SOCKET_MODE);
						this.socketOwnedByServer = true;
						resolve();
					} catch (error) {
						this.server = null;
						finalizeError(error instanceof Error ? error : new Error(String(error)));
					}
				});
			});
			this.startSessionPruneLoop();
			serverLogger.info("start.end", { socket_path: this.socketPath, service_name: this.serviceName, service_instance_id: this.serviceInstanceId });
		} catch (error) {
			serverLogger.error("start.error", { socket_path: this.socketPath, service_name: this.serviceName, error });
			throw error;
		}
	}

	private async closeViewerBackendSessions(): Promise<void> {
		const closeAll = this.viewerBackend.closeAll;
		if (typeof closeAll !== "function") {
			return;
		}
		try {
			await closeAll.call(this.viewerBackend);
		} catch {
			// best effort: session shutdown should be resilient and prefer process teardown continuity
		}
	}

	async stop(): Promise<void> {
		serverLogger.info("stop.begin", { socket_path: this.socketPath, service_name: this.serviceName, active_connections: this.activeConnections.size });
		this.stopping = true;
		this.continuousCompileManager.setAcceptingSubscriptions(false);
		this.stopSessionPruneLoop();
		const server = this.server;
		this.server = null;
		for (const socket of this.activeConnections) {
			socket.destroy();
		}
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
		await this.continuousCompileManager.stopAll();
		await this.closeViewerBackendSessions();
		this.callbackTargets.clear();
		this.sessionLeases.clear();
		this.managedViewerRecords.clear();
		this.removeSocketPath();
		serverLogger.info("stop.end", { socket_path: this.socketPath, service_name: this.serviceName, server_was_running: server !== null });
	}

	private startSessionPruneLoop(): void {
		this.stopSessionPruneLoop();
		this.sessionPruneTimer = setInterval(() => {
			this.sessionLeases.pruneExpired();
		}, this.sessionPruneIntervalMs);
		this.sessionPruneTimer.unref?.();
	}

	private stopSessionPruneLoop(): void {
		if (this.sessionPruneTimer) {
			clearInterval(this.sessionPruneTimer);
			this.sessionPruneTimer = null;
		}
	}

	private handleConnection(socket: Socket): void {
		if (this.stopping) {
			socket.destroy();
			return;
		}
		this.activeConnections.add(socket);
		socket.setTimeout(ACTIVE_CONNECTION_TIMEOUT_MS, () => {
			socket.destroy();
		});
		const frameReader = new HostServiceMcpFrameReader({ maxPayloadBytes: MAX_PAYLOAD_BYTES });
		const handleData = (chunk: Buffer) => {
			try {
				frameReader.write(chunk);
				while (true) {
					const frame = frameReader.nextFrame();
					if (!frame) {
						return;
					}
					if (frame.protocol === "host-service") {
						socket.off("data", handleData);
						socket.removeAllListeners("timeout");
						this.respondToRequest(frame.payload, socket);
						return;
					}
					this.respondToMcpRequest(frame.payload, socket);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (frameReader.detectedProtocol === "mcp") {
					const response = mcpFramedResponse(buildMcpErrorResponse(null, MCP_ERROR_PARSE_ERROR, message));
					socket.write(response);
				} else {
					socket.end(
						buildErrorResponse(
							this.protocolVersion,
							this.socketPath,
							this.serviceName,
							this.serviceInstanceId,
							"",
							message,
							"invalid_request",
						),
					);
				}
				socket.destroy();
			}
		};
		socket.on("data", handleData);
		socket.once("close", () => {
			this.activeConnections.delete(socket);
		});
		socket.on("error", () => {
			socket.destroy();
		});
	}

	private respondToMcpRequest(raw: string, socket: Socket): void {
		void (async () => {
			const response = await handleFramedMcpRequest(raw, {
				openPdf: (request) => this.managedViewerService.openViewer(request),
				jumpPdf: (request) => this.managedViewerService.jumpViewer(request),
				closePdf: (request) => this.managedViewerService.closeViewer(request),
				resolveManagedOpenCallback: (workspaceContext, callbackTargetId, callbackTarget) =>
					this.resolveManagedOpenCallback(workspaceContext, callbackTargetId, callbackTarget),
				continuousCompileManager: this.continuousCompileManager,
				refreshSessionLease: (workspaceContext) => {
					if (!this.stopping) {
						this.sessionLeases.heartbeat(workspaceContext);
					}
				},
			});
			if (response === null) {
				return;
			}
			socket.write(response);
		})().catch((error) => {
			serverLogger.error("mcp_request.internal_error", { error });
			socket.destroy();
		});
	}

	private respondToRequest(raw: string, socket: Socket): void {
		void (async () => {
			let requestPayload: unknown;
			let request: HostServiceRequest;
			try {
				requestPayload = parseRequest(raw);
				request = validateHostServiceRequest(requestPayload);
			} catch (error) {
				const requestId = getRequestIdFromPayload(requestPayload);
				serverLogger.warn("request.invalid", {
					request_id: requestId,
					operation: getOperationFromPayload(requestPayload),
					error,
				});
				const requestOperation = getOperationFromPayload(requestPayload);
				if (requestOperation === "compile_latex_file" || requestOperation === "compile_latex_snippet") {
					const requestWorkspaceContext = getWorkspaceContextFromPayload(requestPayload);
					const requestedSource = requestOperation === "compile_latex_file"
						? getLatexPathFromPayload(requestPayload)
						: getLatexSnippetFromPayload(requestPayload);
					const source = requestOperation === "compile_latex_file"
						? requestedSource ?? ""
						: "";
					const logPath = requestOperation === "compile_latex_file" && source ? inferLatexLogPath(source) : "";
					socket.end(buildCompileErrorResponse(
						requestId,
						requestWorkspaceContext ?? FALLBACK_WORKSPACE_CONTEXT,
						source,
						logPath,
						false,
						"invalid_request",
						error instanceof Error ? error.message : String(error),
						requestOperation,
					));
					return;
				}
				if (requestOperation === "rasterize") {
					socket.end(buildRasterizeErrorResponse(
						this.protocolVersion,
						requestId,
						getWorkspaceContextFromPayload(requestPayload) ?? FALLBACK_WORKSPACE_CONTEXT,
						getRasterizePdfPathFromPayload(requestPayload),
						"invalid_request",
						error instanceof Error ? error.message : String(error),
					));
					return;
				}
				if (requestOperation === "open_pdf" || requestOperation === "close_pdf" || requestOperation === "jump_pdf") {
					socket.end(buildViewerOperationErrorResponse(
						requestId,
						getWorkspaceContextFromPayload(requestPayload) ?? FALLBACK_WORKSPACE_CONTEXT,
						requestOperation,
						"invalid_request",
						error instanceof Error ? error.message : String(error),
					));
					return;
				}
				socket.end(buildErrorResponse(
					this.protocolVersion,
					this.socketPath,
					this.serviceName,
					this.serviceInstanceId,
					getRequestIdFromPayload(requestPayload),
					error instanceof Error ? error.message : String(error),
					"invalid_request",
					requestOperation,
				));
				return;
			}
			serverLogger.info("request.received", {
				operation: request.operation,
				request_id: request.request_id,
				cwd: request.workspace_context.cwd,
			});
			switch (request.operation) {
				case "status": {
					this.sessionLeases.pruneExpired();
					this.totalRequests += 1;
					const nowNs = Date.now() * 1_000_000;
					const viewerBackendAvailable = this.viewerBackend.isAvailable();
					const response: HostServiceStatusResponseEnvelope = {
						protocol_version: this.protocolVersion,
						request_id: request.request_id,
						operation: request.operation,
						status: "ok",
						generated_at_ns: nowNs,
						status_details: {
							protocol_version: this.protocolVersion,
							supported: true,
							service_available: viewerBackendAvailable,
							service_name: this.serviceName,
							socket_path: this.socketPath,
							service_instance_started_ns: this.startedAtNs,
							service_instance_id: this.serviceInstanceId,
							workspace_context: request.workspace_context,
							request_id: request.request_id,
								operation: request.operation,
							uptime_ns: nowNs - this.startedAtNs,
							total_requests: this.totalRequests,
							viewer_backend_name: this.viewerBackend.name,
							viewer_backend_available: viewerBackendAvailable,
							viewer_backend_capabilities: this.viewerBackend.capabilities,
							live_session_count: this.sessionLeases.liveSessionCount,
						},
					};
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "session_heartbeat": {
					this.totalRequests += 1;
					const response = this.sessionHeartbeatRequest(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "get_pending_notifications": {
					this.totalRequests += 1;
					const response = this.getPendingNotificationsRequest(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "compile_latex_file": {
					this.totalRequests += 1;
					if (request.details.continuous !== undefined) {
						this.sessionLeases.heartbeat(request.workspace_context);
					}
					const response = await this.compileService.compileLatexFileRequest(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "compile_latex_snippet": {
					this.totalRequests += 1;
					const response = await this.compileService.compileLatexSnippetRequest(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "rasterize": {
					this.totalRequests += 1;
					const response = await this.rasterizePdfRequest(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "open_pdf": {
					this.totalRequests += 1;
					const response = await this.managedViewerService.openViewer(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "close_pdf": {
					this.totalRequests += 1;
					const response = await this.managedViewerService.closeViewer(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "jump_pdf": {
					this.totalRequests += 1;
					const response = await this.managedViewerService.jumpViewer(request);
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "register_callback_target": {
					await this.pruneCallbackTargets();
					const targetId = callbackTargetRegistryKey(request.workspace_context, request.target_id);
					const targetRecord = {
						target: request.target,
						staleAfterNs: resolveStaleAfterNs(request.stale_after_ms),
					};
					const replaced = this.callbackTargets.has(targetId);
					this.callbackTargets.set(targetId, targetRecord);
					this.totalRequests += 1;
					const nowNs = Date.now() * 1_000_000;
					const response: HostServiceRegisterCallbackTargetResponseEnvelope = {
						protocol_version: this.protocolVersion,
						request_id: request.request_id,
						operation: request.operation,
						status: "ok",
						generated_at_ns: nowNs,
						status_details: {
							protocol_version: this.protocolVersion,
							supported: true,
							service_available: true,
							service_name: this.serviceName,
							socket_path: this.socketPath,
							service_instance_started_ns: this.startedAtNs,
							service_instance_id: this.serviceInstanceId,
							workspace_context: request.workspace_context,
							request_id: request.request_id,
							operation: request.operation,
							target_id: request.target_id,
							callback_registered: true,
							callback_replaced: replaced,
							target: targetRecord.target,
							uptime_ns: nowNs - this.startedAtNs,
							total_requests: this.totalRequests,
						},
					};
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "unregister_callback_target": {
					await this.pruneCallbackTargets();
					const targetId = callbackTargetRegistryKey(request.workspace_context, request.target_id);
					const removed = this.callbackTargets.delete(targetId);
					this.totalRequests += 1;
					const nowNs = Date.now() * 1_000_000;
					const response: HostServiceUnregisterCallbackTargetResponseEnvelope = {
						protocol_version: this.protocolVersion,
						request_id: request.request_id,
						operation: request.operation,
						status: "ok",
						generated_at_ns: nowNs,
						status_details: {
							protocol_version: this.protocolVersion,
							supported: true,
							service_available: true,
							service_name: this.serviceName,
							socket_path: this.socketPath,
							service_instance_started_ns: this.startedAtNs,
							service_instance_id: this.serviceInstanceId,
							workspace_context: request.workspace_context,
							request_id: request.request_id,
							operation: request.operation,
							target_id: request.target_id,
							removed,
							uptime_ns: nowNs - this.startedAtNs,
							total_requests: this.totalRequests,
						},
					};
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
				case "resolve_callback_target": {
					await this.pruneCallbackTargets();
					const targetId = callbackTargetRegistryKey(request.workspace_context, request.target_id);
					const target = await this.resolveCallbackTarget(targetId);
					const targetAvailable = target !== undefined;
					this.totalRequests += 1;
					const nowNs = Date.now() * 1_000_000;
					const response: HostServiceResolveCallbackTargetResponseEnvelope = {
						protocol_version: this.protocolVersion,
						request_id: request.request_id,
						operation: request.operation,
						status: "ok",
						generated_at_ns: nowNs,
						status_details: {
							protocol_version: this.protocolVersion,
							supported: true,
							service_available: true,
							service_name: this.serviceName,
							socket_path: this.socketPath,
							service_instance_started_ns: this.startedAtNs,
							service_instance_id: this.serviceInstanceId,
							workspace_context: request.workspace_context,
							request_id: request.request_id,
							operation: request.operation,
							target_id: request.target_id,
							callback_available: targetAvailable,
							target: targetAvailable ? target : undefined,
							uptime_ns: nowNs - this.startedAtNs,
							total_requests: this.totalRequests,
						},
					};
					socket.end(`${JSON.stringify(response)}\n`);
					return;
				}
			}
		})().catch((error) => {
			serverLogger.error("request.internal_error", { error });
			socket.end(buildErrorResponse(
				this.protocolVersion,
				this.socketPath,
				this.serviceName,
				this.serviceInstanceId,
				"",
				"host service failed while handling request",
				"internal_error",
			));
		});
	}

	private async resolveCallbackTarget(targetId: string): Promise<HostServiceCallbackTarget | undefined> {
		const stored = this.callbackTargets.get(targetId);
		if (!stored) {
			return undefined;
		}
		if (!(await isSocketUsable(stored.target.socket_path))) {
			this.callbackTargets.delete(targetId);
			return undefined;
		}
		return stored.target;
	}

	private async pruneCallbackTargets(): Promise<void> {
		const nowNs = Date.now() * 1_000_000;
		for (const [targetId, stored] of this.callbackTargets) {
			if (stored.staleAfterNs !== undefined && stored.staleAfterNs > 0 && nowNs > stored.staleAfterNs) {
				this.callbackTargets.delete(targetId);
				continue;
			}
			if (!(await isSocketUsable(stored.target.socket_path))) {
				this.callbackTargets.delete(targetId);
			}
		}
	}

	private async resolveManagedOpenCallback(
		workspaceContext: HostServiceWorkspaceContext,
		callbackTargetId: string | undefined,
		callbackTarget: HostServiceCallbackTarget | undefined,
	): Promise<HostServiceCallbackTarget | undefined> {
		if (callbackTargetId !== undefined) {
			const targetId = callbackTargetRegistryKey(workspaceContext, callbackTargetId);
			return await this.resolveCallbackTarget(targetId);
		}
		return callbackTarget;
	}

	private sessionHeartbeatRequest(request: HostServiceSessionHeartbeatRequest): HostServiceSessionHeartbeatResponseEnvelope {
		const lease = this.sessionLeases.heartbeat(request.workspace_context);
		const nowNs = Date.now() * 1_000_000;
		return {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: request.operation,
			status: "ok",
			generated_at_ns: nowNs,
			status_details: {
				...this.commonSessionStatusDetails(request, nowNs),
				operation: request.operation,
				session_id: lease.session_id,
				last_seen_at_ns: lease.last_seen_at_ns,
				lease_expires_at_ns: lease.expires_at_ns,
				live_session_count: this.sessionLeases.liveSessionCount,
			},
		};
	}

	private getPendingNotificationsRequest(
		request: HostServiceGetPendingNotificationsRequest,
	): HostServiceGetPendingNotificationsResponseEnvelope {
		const sessionId = requireSessionId(request.workspace_context);
		const notifications = this.sessionLeases.retrievePendingNotifications(request.workspace_context);
		const nowNs = Date.now() * 1_000_000;
		return {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: request.operation,
			status: "ok",
			generated_at_ns: nowNs,
			status_details: {
				...this.commonSessionStatusDetails(request, nowNs),
				operation: request.operation,
				session_id: sessionId,
				notifications,
				delivered_count: notifications.length,
				live_session_count: this.sessionLeases.liveSessionCount,
			},
		};
	}

	private commonSessionStatusDetails(
		request: HostServiceSessionHeartbeatRequest | HostServiceGetPendingNotificationsRequest,
		nowNs: number,
	) {
		return {
			protocol_version: this.protocolVersion,
			supported: true,
			service_available: true,
			service_name: this.serviceName,
			socket_path: this.socketPath,
			service_instance_started_ns: this.startedAtNs,
			service_instance_id: this.serviceInstanceId,
			workspace_context: request.workspace_context,
			request_id: request.request_id,
			uptime_ns: nowNs - this.startedAtNs,
			total_requests: this.totalRequests,
		};
	}

	private async rasterizePdfRequest(request: HostServiceRasterizeRequest): Promise<HostServiceRasterizeResponseEnvelope> {
		return executeRasterizePdfRequest(this.protocolVersion, request);
	}

	private async prepareSocketPath(): Promise<void> {
		const baseDir = dirname(this.socketPath);
		ensureDirectory(baseDir);
		let existing: ReturnType<typeof lstatSync>;
		try {
			existing = lstatSync(this.socketPath);
		} catch (error) {
			if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		if (existing.isSymbolicLink()) {
			throw new Error(`host service socket path is a symlink: ${this.socketPath}`);
		}
		if (!existing.isSocket()) {
			throw new Error(`host service socket path has unsupported file type: ${this.socketPath}`);
		}

		const socketProbeResult = await isSocketPathSafeToReclaim(this.socketPath);
		if (!socketCanBeReclaimable(socketProbeResult)) {
			throw new Error(`host service socket path is already in use by a running service: ${this.socketPath}`);
		}
		rmSync(this.socketPath, { force: true });
	}

	private removeSocketPath(): void {
		if (!this.socketOwnedByServer) {
			return;
		}
		try {
			const st = lstatSync(this.socketPath);
			if (st.isSocket()) {
				rmSync(this.socketPath, { force: true });
			}
		} catch (error) {
			if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		} finally {
			this.socketOwnedByServer = false;
			this.activeConnections.clear();
		}
	}
}

function socketCanBeReclaimable(result: SocketProbeResult): result is "stale" {
	return result === "stale";
}

function isValidWorkspaceContext(value: unknown): value is HostServiceWorkspaceContext {
	if (!isStringRecord(value)) return false;
	if (typeof value.cwd !== "string" || !value.cwd.trim()) return false;
	if (value.workspace_root !== undefined && typeof value.workspace_root !== "string") return false;
	if (value.session_id !== undefined && typeof value.session_id !== "string") return false;
	return true;
}

function normalizeWorkspaceContext(context: HostServiceWorkspaceContext): HostServiceWorkspaceContext {
	if (!isValidWorkspaceContext(context)) {
		throw new Error("invalid workspace_context; cwd is required");
	}
	return {
		cwd: context.cwd,
		workspace_root: context.workspace_root,
		session_id: context.session_id,
	};
}

function normalizeWorkspaceContextWithSession(context: HostServiceWorkspaceContext): HostServiceWorkspaceContext {
	const workspaceContext = normalizeWorkspaceContext(context);
	return {
		...workspaceContext,
		session_id: requireSessionId(workspaceContext),
	};
}

function normalizeWorkspaceContextForCompile(context: HostServiceWorkspaceContext): HostServiceWorkspaceContext {
	const normalized = normalizeWorkspaceContext(context);
	if (!isAbsolute(normalized.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for compile_latex_file");
	}
	if (normalized.workspace_root !== undefined && !isAbsolute(normalized.workspace_root)) {
		throw new Error("workspace_context.workspace_root must be absolute for compile_latex_file");
	}
	return normalized;
}

function normalizeWorkspaceContextForSnippetCompile(context: HostServiceWorkspaceContext): HostServiceWorkspaceContext {
	const normalized = normalizeWorkspaceContext(context);
	if (!isAbsolute(normalized.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for compile_latex_snippet");
	}
	if (normalized.workspace_root !== undefined && !isAbsolute(normalized.workspace_root)) {
		throw new Error("workspace_context.workspace_root must be absolute for compile_latex_snippet");
	}
	return normalized;
}

function normalizeWorkspaceContextForViewer(context: HostServiceWorkspaceContext): HostServiceWorkspaceContext {
	const normalized = normalizeWorkspaceContext(context);
	if (!isAbsolute(normalized.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for open");
	}
	if (normalized.workspace_root !== undefined && !isAbsolute(normalized.workspace_root)) {
		throw new Error("workspace_context.workspace_root must be absolute for open");
	}
	return normalized;
}

function inferLatexLogPath(sourcePath: string): string {
	return join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.log`);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isValidLatexDiagnostic(value: unknown): boolean {
	if (!isStringRecord(value)) return false;
	if (typeof value.kind !== "string" || typeof value.message !== "string") return false;
	if (value.line !== undefined && (typeof value.line !== "number" || !Number.isInteger(value.line))) return false;
	if (value.source !== undefined && typeof value.source !== "string") return false;
	return true;
}

function isValidPendingNotification(value: unknown): boolean {
	if (!isStringRecord(value)) return false;
	if (typeof value.id !== "string" || !value.id.trim()) return false;
	if (typeof value.created_at_ns !== "number") return false;
	if (typeof value.message !== "string" || !value.message.trim()) return false;
	if (value.root_source !== undefined && typeof value.root_source !== "string") return false;
	if (value.details !== undefined && !isStringRecord(value.details)) return false;
	return true;
}

function parseRequest(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("Malformed host service request payload");
	}
}

function getRequestIdFromPayload(payload: unknown): string {
	if (isStringRecord(payload) && typeof payload.request_id === "string") {
		return payload.request_id;
	}
	return "";
}

function getRequestOperationFromPayload(payload: unknown): string | undefined {
	if (!isStringRecord(payload)) {
		return undefined;
	}
	if (typeof payload.operation !== "string") {
		return undefined;
	}
	return payload.operation;
}

function getOperationFromPayload(payload: unknown): HostServiceOperation {
	if (isStringRecord(payload) && typeof payload.operation === "string") {
		const operation = payload.operation;
		if (
			operation === "status"
			|| operation === "session_heartbeat"
			|| operation === "get_pending_notifications"
			|| operation === "compile_latex_file"
			|| operation === "compile_latex_snippet"
			|| operation === "rasterize"
			|| operation === "open_pdf"
			|| operation === "close_pdf"
			|| operation === "jump_pdf"
			|| operation === "register_callback_target"
			|| operation === "unregister_callback_target"
			|| operation === "resolve_callback_target"
		) {
			return operation;
		}
	}
	return "status";
}

function parseResponse(
	raw: string,
	expectedRequestId: string,
	expectedOperation: HostServiceOperation,
): HostServiceResponseEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Malformed host service response payload: ${raw}`);
	}
	const normalized = normalizeHostServiceResponsePayload(parsed);
	if (!isValidHostServiceResponse(normalized, expectedRequestId, expectedOperation)) {
		throw new Error(`Malformed host service response payload: ${raw}`);
	}
	return normalized;
}

function normalizeHostServiceResponsePayload(value: unknown): unknown {
	if (!isStringRecord(value) || value.operation !== "open_pdf") {
		return value;
	}
	if (!isStringRecord(value.status_details)) {
		return value;
	}
	const details = value.status_details;
	const managedRecordPdf = isStringRecord(details.managed_record) && typeof details.managed_record.pdfPath === "string"
		? details.managed_record.pdfPath
		: undefined;
	const detailsPdf = typeof details.pdf === "string" && details.pdf ? details.pdf : undefined;
	const envelopePdf = typeof value.pdf === "string" && value.pdf ? value.pdf : undefined;
	const pdf = detailsPdf ?? envelopePdf ?? managedRecordPdf;
	if (pdf === undefined) {
		return value;
	}
	return {
		...value,
		pdf,
		status_details: {
			...details,
			pdf,
		},
	};
}

function validateHostServiceRequest(value: unknown): HostServiceRequest {
	if (!isStringRecord(value)) {
		throw new Error("invalid request payload");
	}
	if (value.protocol_version !== PROTOCOL_VERSION) {
		throw new Error("unsupported protocol version");
	}
	if (typeof value.request_id !== "string" || !value.request_id.trim()) {
		throw new Error("missing request_id");
	}
	if (typeof value.created_at_ns !== "number") {
		throw new Error("missing created_at_ns");
	}
	if (!isValidWorkspaceContext(value.workspace_context)) {
		throw new Error("invalid workspace_context");
	}
	switch (value.operation) {
		case "status": {
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "status",
				created_at_ns: value.created_at_ns,
				workspace_context: value.workspace_context,
			};
		}
		case "session_heartbeat": {
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "session_heartbeat",
				created_at_ns: value.created_at_ns,
				workspace_context: normalizeWorkspaceContextWithSession(value.workspace_context),
			};
		}
		case "get_pending_notifications": {
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "get_pending_notifications",
				created_at_ns: value.created_at_ns,
				workspace_context: normalizeWorkspaceContextWithSession(value.workspace_context),
			};
		}
		case "compile_latex_file": {
			if (!isStringRecord(value.details)) {
				throw new Error("missing compile details");
			}
			const rawDetails = value.details;
			if (typeof rawDetails.latex_file_path !== "string" || !rawDetails.latex_file_path.trim()) {
				throw new Error("missing latex_file_path");
			}
			if (rawDetails.compiler !== undefined && typeof rawDetails.compiler !== "string") {
				throw new Error("compiler must be a string");
			}
			if (rawDetails.clean !== undefined && typeof rawDetails.clean !== "boolean") {
				throw new Error("clean must be a boolean");
			}
			if (rawDetails.open_pdf !== undefined && typeof rawDetails.open_pdf !== "boolean") {
				throw new Error("open_pdf must be a boolean");
			}
			if (rawDetails.continuous !== undefined && typeof rawDetails.continuous !== "boolean") {
				throw new Error("continuous must be a boolean");
			}
			if (rawDetails.reuse_existing !== undefined && typeof rawDetails.reuse_existing !== "boolean") {
				throw new Error("reuse_existing must be a boolean");
			}
			if (rawDetails.require_persistent_viewer !== undefined && typeof rawDetails.require_persistent_viewer !== "boolean") {
				throw new Error("require_persistent_viewer must be a boolean");
			}
			if (rawDetails.callback_target_id !== undefined && typeof rawDetails.callback_target_id !== "string") {
				throw new Error("callback_target_id must be a non-empty string");
			}
			if (rawDetails.callback_target_id !== undefined && !rawDetails.callback_target_id.trim()) {
				throw new Error("callback_target_id must be a non-empty string");
			}
			if (rawDetails.callback !== undefined && !isValidCallbackTarget(rawDetails.callback)) {
				throw new Error("callback must be a valid callback target");
			}
			const openPdf = rawDetails.open_pdf === true;
			const workspaceContext = rawDetails.continuous === undefined
				? normalizeWorkspaceContextForCompile(value.workspace_context)
				: normalizeWorkspaceContextWithSession(normalizeWorkspaceContextForCompile(value.workspace_context));
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "compile_latex_file",
				created_at_ns: value.created_at_ns,
				workspace_context: workspaceContext,
				details: {
					latex_file_path: rawDetails.latex_file_path,
					compiler: rawDetails.compiler,
					clean: rawDetails.clean === true,
					open_pdf: openPdf,
					continuous: rawDetails.continuous,
					reuse_existing: rawDetails.reuse_existing,
					require_persistent_viewer: rawDetails.require_persistent_viewer,
					callback_target_id: rawDetails.callback_target_id,
					callback: rawDetails.callback as HostServiceCallbackTarget | undefined,
				},
			};
		}
		case "compile_latex_snippet": {
			if (!isStringRecord(value.details)) {
				throw new Error("missing compile details");
			}
			const rawDetails = value.details;
			if (typeof rawDetails.latex_source !== "string" || !rawDetails.latex_source.trim()) {
				throw new Error("missing latex_source");
			}
			if (rawDetails.compiler !== undefined && typeof rawDetails.compiler !== "string") {
				throw new Error("compiler must be a string");
			}
			if (rawDetails.suppress_page_numbers !== undefined && typeof rawDetails.suppress_page_numbers !== "boolean") {
				throw new Error("suppress_page_numbers must be a boolean");
			}
			if (rawDetails.crop_to_content !== undefined && typeof rawDetails.crop_to_content !== "boolean") {
				throw new Error("crop_to_content must be a boolean");
			}
			if (rawDetails.open_pdf !== undefined && typeof rawDetails.open_pdf !== "boolean") {
				throw new Error("open_pdf must be a boolean");
			}
			if (rawDetails.callback_target_id !== undefined && typeof rawDetails.callback_target_id !== "string") {
				throw new Error("callback_target_id must be a non-empty string");
			}
			if (rawDetails.callback_target_id !== undefined && !rawDetails.callback_target_id.trim()) {
				throw new Error("callback_target_id must be a non-empty string");
			}
			if (rawDetails.fixed_preview_pdf_path !== undefined) {
				throw new Error("fixed_preview_pdf_path is not supported; use fixed_preview");
			}
			if (rawDetails.fixed_preview !== undefined && typeof rawDetails.fixed_preview !== "boolean") {
				throw new Error("fixed_preview must be a boolean");
			}
			if (rawDetails.reuse_existing !== undefined && typeof rawDetails.reuse_existing !== "boolean") {
				throw new Error("reuse_existing must be a boolean");
			}
			if (rawDetails.require_persistent_viewer !== undefined && typeof rawDetails.require_persistent_viewer !== "boolean") {
				throw new Error("require_persistent_viewer must be a boolean");
			}
			if (rawDetails.callback !== undefined && !isValidCallbackTarget(rawDetails.callback)) {
				throw new Error("callback must be a valid callback target");
			}
			const openPdf = rawDetails.open_pdf === true;
			const workspaceContext = normalizeWorkspaceContextForSnippetCompile(value.workspace_context);
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "compile_latex_snippet",
				created_at_ns: value.created_at_ns,
				workspace_context: workspaceContext,
				details: {
					latex_source: rawDetails.latex_source,
					compiler: rawDetails.compiler,
					suppress_page_numbers: rawDetails.suppress_page_numbers,
					crop_to_content: rawDetails.crop_to_content,
					open_pdf: openPdf,
					fixed_preview: rawDetails.fixed_preview,
					reuse_existing: rawDetails.reuse_existing,
					require_persistent_viewer: rawDetails.require_persistent_viewer,
					callback_target_id: rawDetails.callback_target_id,
					callback: rawDetails.callback as HostServiceCallbackTarget | undefined,
				},
			};
		}
		case "rasterize": {
			if (!isStringRecord(value.details)) {
				throw new Error("missing rasterize details");
			}
			const rawDetails = value.details;
			if (typeof rawDetails.pdf_path !== "string" || !rawDetails.pdf_path.trim()) {
				throw new Error("missing pdf_path");
			}
			if (rawDetails.dpi !== undefined) {
				if (typeof rawDetails.dpi !== "number" || !Number.isInteger(rawDetails.dpi) || rawDetails.dpi <= 0) {
					throw new Error("dpi must be a positive integer");
				}
			}
			if (rawDetails.page !== undefined) {
				if (typeof rawDetails.page !== "number" || !Number.isInteger(rawDetails.page) || rawDetails.page < 1) {
					throw new Error("page must be a positive integer");
				}
			}
			if (rawDetails.merge_pages !== undefined && typeof rawDetails.merge_pages !== "boolean") {
				throw new Error("merge_pages must be a boolean");
			}
			const workspaceContext = normalizeWorkspaceContextForRasterize(value.workspace_context);
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "rasterize",
				created_at_ns: value.created_at_ns,
				workspace_context: workspaceContext,
				details: {
					pdf_path: rawDetails.pdf_path,
					dpi: rawDetails.dpi,
					page: rawDetails.page,
					merge_pages: rawDetails.merge_pages,
				},
			};
		}
		case "open_pdf": {
			if (!isStringRecord(value.details)) {
				throw new Error("missing open details");
			}
			const rawDetails = value.details;
			if (typeof rawDetails.pdf_path !== "string" || !rawDetails.pdf_path.trim()) {
				throw new Error("missing pdf_path");
			}
			if (rawDetails.callback !== undefined && !isValidCallbackTarget(rawDetails.callback)) {
				throw new Error("invalid callback");
			}
			if (rawDetails.reuse_existing !== undefined && typeof rawDetails.reuse_existing !== "boolean") {
				throw new Error("reuse_existing must be a boolean");
			}
			if (rawDetails.require_persistent_viewer !== undefined && typeof rawDetails.require_persistent_viewer !== "boolean") {
				throw new Error("require_persistent_viewer must be a boolean");
			}
			const workspaceContext = normalizeWorkspaceContextForViewer(value.workspace_context);
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "open_pdf",
				created_at_ns: value.created_at_ns,
				workspace_context: workspaceContext,
				details: {
					pdf_path: resolve(workspaceContext.cwd, rawDetails.pdf_path),
					callback: rawDetails.callback,
					reuse_existing: rawDetails.reuse_existing,
					require_persistent_viewer: rawDetails.require_persistent_viewer,
				},
			};
		}
		case "close_pdf": {
			const rawPdfId = (value as Record<string, unknown>).pdf_id;
			if (typeof rawPdfId !== "number" || !Number.isInteger(rawPdfId) || rawPdfId <= 0) {
				throw new Error("invalid pdf_id");
			}
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "close_pdf",
				created_at_ns: value.created_at_ns,
				workspace_context: value.workspace_context,
				pdf_id: rawPdfId,
			};
		}
		case "jump_pdf": {
			const rawPdfId = (value as Record<string, unknown>).pdf_id;
			if (typeof rawPdfId !== "number" || !Number.isInteger(rawPdfId) || rawPdfId <= 0) {
				throw new Error("invalid pdf_id");
			}
			const rawLine = (value as Record<string, unknown>).line;
			if (typeof rawLine !== "number" || !Number.isInteger(rawLine) || rawLine <= 0) {
				throw new Error("line must be a positive integer");
			}
			const rawSourceFile = (value as Record<string, unknown>).source_file;
			if (rawSourceFile !== undefined) {
				if (typeof rawSourceFile !== "string" || !rawSourceFile.trim()) {
					throw new Error("source_file must be a non-empty string");
				}
			}
			const workspaceContext = normalizeWorkspaceContextForViewer(value.workspace_context);
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "jump_pdf",
				created_at_ns: value.created_at_ns,
				workspace_context: workspaceContext,
				pdf_id: rawPdfId,
				line: rawLine,
				...(rawSourceFile === undefined ? {} : { source_file: resolve(workspaceContext.cwd, rawSourceFile) }),
			};
		}
		case "register_callback_target": {
			if (typeof value.target_id !== "string" || !value.target_id.trim()) {
				throw new Error("invalid target_id");
			}
			if (!isValidCallbackTarget(value.target)) {
				throw new Error("invalid callback target");
			}
			const staleAfterMs = value.stale_after_ms;
			if (staleAfterMs !== undefined) {
				if (typeof staleAfterMs !== "number" || !Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
					throw new Error("invalid stale_after_ms");
				}
			}
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "register_callback_target",
				created_at_ns: value.created_at_ns,
				workspace_context: value.workspace_context,
				target_id: value.target_id,
				target: value.target,
				stale_after_ms: staleAfterMs,
			};
		}
		case "unregister_callback_target": {
			if (typeof value.target_id !== "string" || !value.target_id.trim()) {
				throw new Error("invalid target_id");
			}
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "unregister_callback_target",
				created_at_ns: value.created_at_ns,
				workspace_context: value.workspace_context,
				target_id: value.target_id,
			};
		}
		case "resolve_callback_target": {
			if (typeof value.target_id !== "string" || !value.target_id.trim()) {
				throw new Error("invalid target_id");
			}
			return {
				protocol_version: PROTOCOL_VERSION,
				request_id: value.request_id,
				operation: "resolve_callback_target",
				created_at_ns: value.created_at_ns,
				workspace_context: value.workspace_context,
				target_id: value.target_id,
			};
		}
	}
	throw new Error(`unsupported operation: ${String(value.operation)}`);
}

function isValidHostServiceResponse(
	value: unknown,
	expectedRequestId: string,
	expectedOperation: HostServiceOperation,
): value is HostServiceResponseEnvelope {
	if (!isStringRecord(value)) {
		return false;
	}
	if (typeof value.protocol_version !== "number" || value.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof value.request_id !== "string" || value.request_id !== expectedRequestId) {
		return false;
	}
	if (value.status !== "ok" && value.status !== "error") {
		return false;
	}
	if (value.operation !== expectedOperation) {
		return false;
	}
	if (typeof value.generated_at_ns !== "number") {
		return false;
	}
	if (value.error !== undefined && typeof value.error !== "string") {
		return false;
	}
	if (value.status === "error" && value.error === undefined) {
		return false;
	}
	if (value.operation === "status") {
		return isValidStatusResponse(value, expectedRequestId);
	}
	if (value.operation === "session_heartbeat") {
		return isValidSessionHeartbeatResponse(value, expectedRequestId);
	}
	if (value.operation === "get_pending_notifications") {
		return isValidGetPendingNotificationsResponse(value, expectedRequestId);
	}
	if (value.operation === "compile_latex_file") {
		return isValidCompileResponse(value, expectedRequestId);
	}
	if (value.operation === "compile_latex_snippet") {
		return isValidCompileResponseLike(value, expectedRequestId, "compile_latex_snippet");
	}
	if (value.operation === "rasterize") {
		return isValidRasterizeResponse(value, expectedRequestId);
	}
	if (value.operation === "register_callback_target") {
		return isValidRegisterCallbackTargetResponse(value, expectedRequestId);
	}
	if (value.operation === "unregister_callback_target") {
		return isValidUnregisterCallbackTargetResponse(value, expectedRequestId);
	}
	if (value.operation === "resolve_callback_target") {
		return isValidResolveCallbackTargetResponse(value, expectedRequestId);
	}
	if (value.operation === "open_pdf") {
		return isValidOpenResponse(value, expectedRequestId);
	}
	if (value.operation === "close_pdf") {
		return isValidCloseResponse(value, expectedRequestId);
	}
	if (value.operation === "jump_pdf") {
		return isValidJumpResponse(value, expectedRequestId);
	}
	return false;
}

function isValidStatusResponse(value: unknown, expectedRequestId: string): value is HostServiceStatusResponseEnvelope {
	if (!isStringRecord(value)) {
		return false;
	}
	if (!isValidCommonHostServiceResponseDetails(value.status_details, expectedRequestId)) {
		return false;
	}
	const details = value.status_details;
	if (!isStringRecord(details)) {
		return false;
	}
	if (details.operation !== "status") {
		return false;
	}
	if (details.viewer_backend_name !== undefined && typeof details.viewer_backend_name !== "string") {
		return false;
	}
	if (details.viewer_backend_available !== undefined && typeof details.viewer_backend_available !== "boolean") {
		return false;
	}
	if (details.viewer_backend_capabilities !== undefined && !isValidViewerBackendCapabilities(details.viewer_backend_capabilities)) {
		return false;
	}
	if (typeof value.status === "string") {
		if (value.status === "error" && value.error === undefined) {
			return false;
		}
	}
	if (value.operation !== "status") {
		return false;
	}
	return true;
}

function isValidSessionHeartbeatResponse(value: unknown, expectedRequestId: string): value is HostServiceSessionHeartbeatResponseEnvelope {
	if (!isValidCommonHostServiceResponse(value, expectedRequestId, "session_heartbeat")) {
		return false;
	}
	const details = value.status_details;
	if (details.operation !== "session_heartbeat") {
		return false;
	}
	if (details.session_id !== undefined && (typeof details.session_id !== "string" || !details.session_id)) {
		return false;
	}
	if (details.last_seen_at_ns !== undefined && typeof details.last_seen_at_ns !== "number") {
		return false;
	}
	if (details.lease_expires_at_ns !== undefined && typeof details.lease_expires_at_ns !== "number") {
		return false;
	}
	if (value.status === "ok") {
		return typeof details.session_id === "string"
			&& typeof details.last_seen_at_ns === "number"
			&& typeof details.lease_expires_at_ns === "number";
	}
	return true;
}

function isValidGetPendingNotificationsResponse(
	value: unknown,
	expectedRequestId: string,
): value is HostServiceGetPendingNotificationsResponseEnvelope {
	if (!isValidCommonHostServiceResponse(value, expectedRequestId, "get_pending_notifications")) {
		return false;
	}
	const details = value.status_details;
	if (details.operation !== "get_pending_notifications") {
		return false;
	}
	if (details.session_id !== undefined && (typeof details.session_id !== "string" || !details.session_id)) {
		return false;
	}
	if (details.notifications !== undefined && !Array.isArray(details.notifications)) {
		return false;
	}
	if (Array.isArray(details.notifications) && !details.notifications.every(isValidPendingNotification)) {
		return false;
	}
	if (details.delivered_count !== undefined && (typeof details.delivered_count !== "number" || !Number.isInteger(details.delivered_count) || details.delivered_count < 0)) {
		return false;
	}
	if (value.status === "ok") {
		return typeof details.session_id === "string"
			&& Array.isArray(details.notifications)
			&& typeof details.delivered_count === "number";
	}
	return true;
}

function isValidCompileResponse(value: unknown, expectedRequestId: string): value is HostServiceCompileResponseEnvelope {
	return isValidCompileResponseLike(value, expectedRequestId, "compile_latex_file");
}

function isValidCompileSnippetResponse(value: unknown, expectedRequestId: string): value is HostServiceCompileSnippetResponseEnvelope {
	return isValidCompileResponseLike(value, expectedRequestId, "compile_latex_snippet");
}

function isValidRasterizeResponse(
	value: unknown,
	expectedRequestId: string,
): value is HostServiceRasterizeResponseEnvelope {
	if (!isStringRecord(value)) {
		return false;
	}
	if (typeof value.protocol_version !== "number" || value.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof value.request_id !== "string" || value.request_id !== expectedRequestId) {
		return false;
	}
	if (value.status !== "ok" && value.status !== "error") {
		return false;
	}
	if (value.operation !== "rasterize") {
		return false;
	}
	if (typeof value.generated_at_ns !== "number") {
		return false;
	}
	if (value.error !== undefined && typeof value.error !== "string") {
		return false;
	}
	if (value.status === "error" && value.error === undefined) {
		return false;
	}
	if (!isStringRecord(value.status_details)) {
		return false;
	}
	const details = value.status_details;
	if (typeof details.protocol_version !== "number" || details.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof details.supported !== "boolean") {
		return false;
	}
	if (typeof details.service_available !== "boolean") {
		return false;
	}
	if (!isValidWorkspaceContext(details.workspace_context)) {
		return false;
	}
	if (typeof details.request_id !== "string" || details.request_id !== expectedRequestId) {
		return false;
	}
	if (details.operation !== "rasterize") {
		return false;
	}
	if (typeof details.pdf_path !== "string") {
		return false;
	}
	if (!Array.isArray(details.artifacts) || !details.artifacts.every(isValidInlinePreviewArtifact)) {
		return false;
	}
	if (!Array.isArray(details.artifact_paths) || !details.artifact_paths.every((entry) => {
		if (typeof entry !== "string") {
			return false;
		}
		return safeInlinePreviewPngPath(entry) !== "";
	})) {
		return false;
	}
	if (typeof details.error_code !== "undefined" && typeof details.error_code !== "string") {
		return false;
	}
	if (value.status === "error" && typeof details.error_code !== "string") {
		return false;
	}
	if (value.status === "ok" && details.error_code !== undefined) {
		return false;
	}
	return true;
}

function isValidInlinePreviewArtifact(value: unknown): value is HostServiceRasterizeArtifact {
	if (!isStringRecord(value)) {
		return false;
	}
	if (typeof value.pngPath !== "string" || safeInlinePreviewPngPath(value.pngPath) === "") {
		return false;
	}
	if (typeof value.page !== "number" || !Number.isInteger(value.page) || value.page < 1) {
		return false;
	}
	if (typeof value.dpi !== "number" || !Number.isInteger(value.dpi) || value.dpi <= 0) {
		return false;
	}
	if (value.renderer !== "mutool" && value.renderer !== "pdftoppm") {
		return false;
	}
	if (typeof value.trimmed !== "boolean") {
		return false;
	}
	if (typeof value.fullPageWidthPx !== "number" || !Number.isInteger(value.fullPageWidthPx) || value.fullPageWidthPx <= 0) {
		return false;
	}
	if (typeof value.fullPageHeightPx !== "number" || !Number.isInteger(value.fullPageHeightPx) || value.fullPageHeightPx <= 0) {
		return false;
	}
	if (typeof value.widthPx !== "number" || !Number.isInteger(value.widthPx) || value.widthPx <= 0) {
		return false;
	}
	if (typeof value.heightPx !== "number" || !Number.isInteger(value.heightPx) || value.heightPx <= 0) {
		return false;
	}
	return true;
}

function isValidContinuousCompileDetails(value: unknown): boolean {
	if (!isStringRecord(value)) {
		return false;
	}
	if (value.requested !== true) {
		return false;
	}
	if (!["started", "already_active", "deactivated", "still_active_for_other_subscribers", "stopped", "unavailable", "error"].includes(String(value.status))) {
		return false;
	}
	if (typeof value.root_source !== "string" || !value.root_source) {
		return false;
	}
	if (typeof value.session_id !== "string") {
		return false;
	}
	if (typeof value.subscriber_count !== "number" || !Number.isInteger(value.subscriber_count) || value.subscriber_count < 0) {
		return false;
	}
	if (value.pid !== undefined && (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)) {
		return false;
	}
	if (value.error !== undefined && typeof value.error !== "string") {
		return false;
	}
	if (value.error_code !== undefined && typeof value.error_code !== "string") {
		return false;
	}
	return true;
}

function isValidCompileResponseLike(
	value: unknown,
	expectedRequestId: string,
	operation: "compile_latex_file" | "compile_latex_snippet",
): value is HostServiceCompileResponseEnvelope | HostServiceCompileSnippetResponseEnvelope {
	if (!isStringRecord(value)) {
		return false;
	}
	if (typeof value.protocol_version !== "number" || value.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof value.request_id !== "string" || value.request_id !== expectedRequestId) {
		return false;
	}
	if (value.status !== "ok" && value.status !== "error") {
		return false;
	}
	if (value.operation !== operation) {
		return false;
	}
	if (typeof value.generated_at_ns !== "number") {
		return false;
	}
	if (value.error !== undefined && typeof value.error !== "string") {
		return false;
	}
	if (value.status === "error" && value.error === undefined) {
		return false;
	}
	if (!isStringRecord(value.status_details)) {
		return false;
	}
	const details = value.status_details;
	if (typeof details.protocol_version !== "number" || details.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof details.supported !== "boolean") {
		return false;
	}
	if (typeof details.service_available !== "boolean") {
		return false;
	}
	if (!isValidWorkspaceContext(details.workspace_context)) {
		return false;
	}
	if (typeof details.request_id !== "string" || details.request_id !== expectedRequestId) {
		return false;
	}
	if (details.operation !== operation) {
		return false;
	}
	if (typeof details.source !== "string") {
		return false;
	}
	if (typeof details.pdf !== "string") {
		return false;
	}
	if (typeof details.log !== "string") {
		return false;
	}
	if (typeof details.clean !== "boolean") {
		return false;
	}
	if (!Array.isArray(details.cleaned_artifacts) || !details.cleaned_artifacts.every((entry) => typeof entry === "string")) {
		return false;
	}
	if (!Array.isArray(details.artifact_paths) || !details.artifact_paths.every((entry) => typeof entry === "string")) {
		return false;
	}
	if (details.compile_status !== undefined && !["ok", "ok_with_warnings", "nonzero_but_pdf_updated"].includes(String(details.compile_status))) {
		return false;
	}
	if (details.compiler_exit_code !== undefined && details.compiler_exit_code !== null && typeof details.compiler_exit_code !== "number") {
		return false;
	}
	if (details.compiler_signal !== undefined && details.compiler_signal !== null && typeof details.compiler_signal !== "string") {
		return false;
	}
	if (details.warning_count !== undefined && (typeof details.warning_count !== "number" || !Number.isInteger(details.warning_count) || details.warning_count < 0)) {
		return false;
	}
	if (details.warnings !== undefined && (!Array.isArray(details.warnings) || !details.warnings.every(isValidLatexDiagnostic))) {
		return false;
	}
	if (details.warnings_truncated !== undefined && typeof details.warnings_truncated !== "boolean") {
		return false;
	}
	if (details.error_summary !== undefined && typeof details.error_summary !== "string") {
		return false;
	}
	if (details.diagnostics !== undefined && (!Array.isArray(details.diagnostics) || !details.diagnostics.every(isValidLatexDiagnostic))) {
		return false;
	}
	if (details.pdf_id !== undefined && (typeof details.pdf_id !== "number" || !Number.isInteger(details.pdf_id) || details.pdf_id <= 0)) {
		return false;
	}
	if (details.managed_record !== undefined && !isValidManagedViewerRecord(details.managed_record)) {
		return false;
	}
	if (details.continuous !== undefined && !isValidContinuousCompileDetails(details.continuous)) {
		return false;
	}
	if (typeof details.error_code !== "undefined" && typeof details.error_code !== "string") {
		return false;
	}
	if (value.status === "error" && typeof details.error_code !== "string") {
		return false;
	}
	if (value.status === "ok" && details.error_code !== undefined) {
		return false;
	}
	return true;
}

function isValidCommonHostServiceResponseDetails(
	details: unknown,
	expectedRequestId: string,
): details is Record<string, unknown> {
	if (!isStringRecord(details)) {
		return false;
	}
	if (typeof details.protocol_version !== "number" || details.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof details.supported !== "boolean") {
		return false;
	}
	if (typeof details.service_available !== "boolean") {
		return false;
	}
	if (!isValidWorkspaceContext(details.workspace_context)) {
		return false;
	}
	if (typeof details.request_id !== "string" || details.request_id !== expectedRequestId) {
		return false;
	}
	if (typeof details.operation !== "string") {
		return false;
	}
	if (typeof details.service_instance_started_ns !== "number") {
		return false;
	}
	if (typeof details.service_instance_id !== "string" || !details.service_instance_id) {
		return false;
	}
	if (typeof details.uptime_ns !== "number") {
		return false;
	}
	if (typeof details.total_requests !== "number") {
		return false;
	}
	if (details.error_code !== undefined && typeof details.error_code !== "string") {
		return false;
	}
	if (details.live_session_count !== undefined && (typeof details.live_session_count !== "number" || !Number.isInteger(details.live_session_count) || details.live_session_count < 0)) {
		return false;
	}
	return true;
}

function isValidRegisterCallbackTargetResponse(response: unknown, expectedRequestId: string): response is HostServiceRegisterCallbackTargetResponseEnvelope {
	if (!isValidCommonHostServiceResponse(response, expectedRequestId, "register_callback_target")) {
		return false;
	}
	if (!isStringRecord(response.status_details)) {
		return false;
	}
	const details = response.status_details;
	if (details.operation !== "register_callback_target") {
		return false;
	}
	if (details.target_id !== undefined && (typeof details.target_id !== "string" || !details.target_id)) {
		return false;
	}
	if (response.status === "ok") {
		if (typeof details.callback_registered !== "boolean") {
			return false;
		}
		if (typeof details.callback_replaced !== "boolean") {
			return false;
		}
		if (!isValidCallbackTarget(details.target)) {
			return false;
		}
	}
	return true;
}

function isValidUnregisterCallbackTargetResponse(response: unknown, expectedRequestId: string): response is HostServiceUnregisterCallbackTargetResponseEnvelope {
	if (!isValidCommonHostServiceResponse(response, expectedRequestId, "unregister_callback_target")) {
		return false;
	}
	if (!isStringRecord(response.status_details)) {
		return false;
	}
	const details = response.status_details;
	if (details.operation !== "unregister_callback_target") {
		return false;
	}
	if (details.target_id !== undefined && (typeof details.target_id !== "string" || !details.target_id)) {
		return false;
	}
	if (response.status === "ok" && typeof details.removed !== "boolean") {
		return false;
	}
	return true;
}

function isValidResolveCallbackTargetResponse(response: unknown, expectedRequestId: string): response is HostServiceResolveCallbackTargetResponseEnvelope {
	if (!isValidCommonHostServiceResponse(response, expectedRequestId, "resolve_callback_target")) {
		return false;
	}
	if (!isStringRecord(response.status_details)) {
		return false;
	}
	const details = response.status_details;
	if (details.operation !== "resolve_callback_target") {
		return false;
	}
	if (details.target_id !== undefined && (typeof details.target_id !== "string" || !details.target_id)) {
		return false;
	}
	if (details.callback_available !== undefined && typeof details.callback_available !== "boolean") {
		return false;
	}
	if (response.status === "ok") {
		if (typeof details.callback_available !== "boolean") {
			return false;
		}
		if (details.callback_available && details.target === undefined) {
			return false;
		}
		if (details.target !== undefined && !isValidCallbackTarget(details.target)) {
			return false;
		}
	}
	return true;
}

function isValidOpenResponse(response: unknown, expectedRequestId: string): response is HostServiceOpenResponseEnvelope {
	if (!isStringRecord(response)) return false;
	if (response.status !== "ok" && response.status !== "error") return false;
	if (typeof response.protocol_version !== "number" || response.protocol_version !== PROTOCOL_VERSION) return false;
	if (typeof response.request_id !== "string" || response.request_id !== expectedRequestId) return false;
	if (response.operation !== "open_pdf") return false;
	if (typeof response.generated_at_ns !== "number") return false;
	if (response.error !== undefined && typeof response.error !== "string") return false;
	if (response.status === "error" && response.error === undefined) return false;
	if (!isStringRecord(response.status_details)) return false;
	const details = response.status_details;
	if (typeof details.protocol_version !== "number" || details.protocol_version !== PROTOCOL_VERSION) return false;
	if (typeof details.supported !== "boolean") return false;
	if (typeof details.service_available !== "boolean") return false;
	if (!isValidWorkspaceContext(details.workspace_context)) return false;
	if (typeof details.request_id !== "string" || details.request_id !== expectedRequestId) return false;
	if (details.operation !== "open_pdf") return false;
	if (typeof details.backend !== "string" || !details.backend) return false;
	if (typeof details.backend_path !== "string" || !details.backend_path) return false;
	if (typeof details.owned !== "boolean") return false;
	if (typeof details.reused !== "boolean") return false;
	if (!isValidViewerBackendCapabilities(details.capabilities)) return false;
	if (details.handle !== undefined && typeof details.handle !== "string") return false;
	if (details.pid !== undefined) {
		if (typeof details.pid !== "number" || !Number.isInteger(details.pid) || details.pid <= 0) return false;
	}
	if (details.pid_diagnostic !== undefined && typeof details.pid_diagnostic !== "string") return false;
	if (details.pdf !== undefined && typeof details.pdf !== "string") return false;
	if (response.status === "ok" && (typeof details.pdf !== "string" || !details.pdf)) return false;
	if (details.error_code !== undefined && typeof details.error_code !== "string") return false;
	if (response.status === "error" && typeof details.error_code !== "string") return false;
	if (response.status === "ok" && details.error_code !== undefined) return false;
	if (response.status === "ok" && details.pdf_id === undefined) return false;
	if (response.status === "ok" && (typeof details.pdf_id !== "number" || !Number.isInteger(details.pdf_id) || details.pdf_id <= 0)) return false;
	if (response.status === "ok" && details.managed_record !== undefined && !isValidManagedViewerRecord(details.managed_record)) return false;
	if (response.status === "ok" && details.handle === undefined) return false;
	return true;
}

function isValidCloseResponse(response: unknown, expectedRequestId: string): response is HostServiceCloseResponseEnvelope {
	if (!isStringRecord(response)) return false;
	if (response.status !== "ok" && response.status !== "error") return false;
	if (typeof response.protocol_version !== "number" || response.protocol_version !== PROTOCOL_VERSION) return false;
	if (typeof response.request_id !== "string" || response.request_id !== expectedRequestId) return false;
	if (response.operation !== "close_pdf") return false;
	if (typeof response.generated_at_ns !== "number") return false;
	if (response.error !== undefined && typeof response.error !== "string") return false;
	if (response.status === "error" && response.error === undefined) return false;
	if (!isStringRecord(response.status_details)) return false;
	const details = response.status_details;
	if (typeof details.protocol_version !== "number" || details.protocol_version !== PROTOCOL_VERSION) return false;
	if (typeof details.supported !== "boolean") return false;
	if (typeof details.service_available !== "boolean") return false;
	if (!isValidWorkspaceContext(details.workspace_context)) return false;
	if (typeof details.request_id !== "string" || details.request_id !== expectedRequestId) return false;
	if (details.operation !== "close_pdf") return false;
	if (typeof details.backend !== "string" || !details.backend) return false;
	if (typeof details.backend_path !== "string" || !details.backend_path) return false;
	if (details.backend_identity_ok !== undefined && typeof details.backend_identity_ok !== "boolean") return false;
	if (typeof details.closed !== "boolean") return false;
	if (details.handle !== undefined && typeof details.handle !== "string") return false;
	const closeRequestError = response.status === "error" && typeof details.error_code === "string" && details.error_code === "invalid_request";
	if (!closeRequestError && (typeof details.pdf_id !== "number" || !Number.isInteger(details.pdf_id) || details.pdf_id <= 0)) {
		return false;
	}
	if (details.error_code !== undefined && typeof details.error_code !== "string") return false;
	if (details.reason !== undefined && typeof details.reason !== "string") return false;
	if (response.status === "error" && typeof details.error_code !== "string") return false;
	if (response.status === "ok" && details.error_code !== undefined) return false;
	return true;
}

function isValidJumpResponse(response: unknown, expectedRequestId: string): response is HostServiceJumpResponseEnvelope {
	if (!isStringRecord(response)) return false;
	if (response.status !== "ok" && response.status !== "error") return false;
	if (typeof response.protocol_version !== "number" || response.protocol_version !== PROTOCOL_VERSION) return false;
	if (typeof response.request_id !== "string" || response.request_id !== expectedRequestId) return false;
	if (response.operation !== "jump_pdf") return false;
	if (typeof response.generated_at_ns !== "number") return false;
	if (response.error !== undefined && typeof response.error !== "string") return false;
	if (response.status === "error" && response.error === undefined) return false;
	if (!isStringRecord(response.status_details)) return false;
	const details = response.status_details;
	if (typeof details.protocol_version !== "number" || details.protocol_version !== PROTOCOL_VERSION) return false;
	if (typeof details.supported !== "boolean") return false;
	if (typeof details.service_available !== "boolean") return false;
	if (!isValidWorkspaceContext(details.workspace_context)) return false;
	if (typeof details.request_id !== "string" || details.request_id !== expectedRequestId) return false;
	if (details.operation !== "jump_pdf") return false;
	if (typeof details.backend !== "string" || !details.backend) return false;
	if (typeof details.backend_path !== "string" || !details.backend_path) return false;
	if (details.backend_identity_ok !== undefined && typeof details.backend_identity_ok !== "boolean") return false;
	if (typeof details.handled !== "boolean") return false;
	if (typeof details.reopened !== "boolean") return false;
	if (details.closed !== undefined && typeof details.closed !== "boolean") return false;
	if (details.pdf_id !== undefined && (typeof details.pdf_id !== "number" || !Number.isInteger(details.pdf_id) || details.pdf_id <= 0)) return false;
	if (details.pdf !== undefined && typeof details.pdf !== "string") return false;
	if (details.source_file !== undefined && typeof details.source_file !== "string") return false;
	if (details.line !== undefined && (typeof details.line !== "number" || !Number.isInteger(details.line) || details.line <= 0)) return false;
	if (details.source_line !== undefined && typeof details.source_line !== "string") return false;
	if (details.reason !== undefined && typeof details.reason !== "string") return false;
	if (details.handle !== undefined && typeof details.handle !== "string") return false;
	if (details.error_code !== undefined && typeof details.error_code !== "string") return false;
	if (response.status === "error" && typeof details.error_code !== "string") return false;
	if (response.status === "ok" && details.error_code !== undefined) return false;
	if (details.diagnostics !== undefined && !Array.isArray(details.diagnostics)) return false;
	if (details.managed_record !== undefined && !isValidManagedViewerRecord(details.managed_record)) return false;
	return true;
}

function isValidCommonHostServiceResponse(
	response: unknown,
	expectedRequestId: string,
	operation: Extract<
		HostServiceOperation,
		"status" | "session_heartbeat" | "get_pending_notifications" | "compile_latex_file" | "compile_latex_snippet" | "register_callback_target" | "unregister_callback_target" | "resolve_callback_target"
	>,
): response is HostServiceResponseEnvelope {
	if (!isStringRecord(response)) {
		return false;
	}
	if (typeof response.protocol_version !== "number" || response.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof response.request_id !== "string" || response.request_id !== expectedRequestId) {
		return false;
	}
	if (response.status !== "ok" && response.status !== "error") {
		return false;
	}
	if (response.operation !== operation) {
		return false;
	}
	if (typeof response.generated_at_ns !== "number") {
		return false;
	}
	if (response.error !== undefined && typeof response.error !== "string") {
		return false;
	}
	if (response.status === "error" && response.error === undefined) {
		return false;
	}
	if (!isStringRecord(response.status_details)) {
		return false;
	}
	const details = response.status_details;
	if (!isValidCommonHostServiceResponseDetails(details, expectedRequestId)) {
		return false;
	}
	if (!isValidWorkspaceContext(details.workspace_context)) {
		return false;
	}
	if (typeof details.service_name !== "string" || !details.service_name) {
		return false;
	}
	if (typeof details.socket_path !== "string" || !details.socket_path) {
		return false;
	}
	return true;
}

function isValidCallbackTarget(value: unknown): value is HostServiceCallbackTarget {
	if (!isStringRecord(value)) {
		return false;
	}
	if (value.kind !== "pi-synctex-callback-v1") {
		return false;
	}
	if (value.transport !== "unix") {
		return false;
	}
	if (typeof value.socket_path !== "string" || !value.socket_path) {
		return false;
	}
	if (typeof value.token !== "string" || !value.token) {
		return false;
	}
	return true;
}

function isValidManagedViewerRecord(value: unknown): value is HostServiceManagedViewerRecord {
	if (!isStringRecord(value)) {
		return false;
	}
	if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id <= 0) {
		return false;
	}
	if (typeof value.pdfPath !== "string" || !value.pdfPath) {
		return false;
	}
	if (typeof value.viewerHandle !== "string" || !value.viewerHandle) {
		return false;
	}
	if (typeof value.viewerBackend !== "string" || !value.viewerBackend) {
		return false;
	}
	if (typeof value.viewerOwned !== "boolean") {
		return false;
	}
	if (typeof value.createdAtNs !== "number" || !Number.isInteger(value.createdAtNs) || value.createdAtNs <= 0) {
		return false;
	}
	if (value.pid !== undefined && (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)) {
		return false;
	}
	if (value.pidDiagnostic !== undefined && typeof value.pidDiagnostic !== "string") {
		return false;
	}
	if (value.reused !== undefined && typeof value.reused !== "boolean") {
		return false;
	}
	if (value.capabilities !== undefined && !isValidViewerBackendCapabilities(value.capabilities)) {
		return false;
	}
	if (value.backendPath !== undefined && (typeof value.backendPath !== "string" || !value.backendPath)) {
		return false;
	}
	if (value.callback !== undefined && !isValidCallbackTarget(value.callback)) {
		return false;
	}
	if (value.defaultSourcePath !== undefined && (typeof value.defaultSourcePath !== "string" || !value.defaultSourcePath)) {
		return false;
	}
	if (value.metadata !== undefined && !isStringRecord(value.metadata)) {
		return false;
	}
	return true;
}

function isValidViewerBackendCapabilities(value: unknown): value is HostServiceViewerBackendCapabilities {
	if (!isStringRecord(value)) {
		return false;
	}
	return (
		typeof value.open === "boolean"
		&& typeof value.close === "boolean"
		&& typeof value.forward_search === "boolean"
		&& typeof value.inverse_search === "boolean"
		&& typeof value.reuse === "boolean"
	);
}

function getWorkspaceContextFromPayload(payload: unknown): HostServiceWorkspaceContext | undefined {
	if (!isStringRecord(payload)) {
		return undefined;
	}
	return isValidWorkspaceContext(payload.workspace_context) ? payload.workspace_context : undefined;
}

function getLatexPathFromPayload(payload: unknown): string | undefined {
	if (!isStringRecord(payload) || !isStringRecord(payload.details)) {
		return undefined;
	}
	const details = payload.details;
	if (typeof details.latex_file_path !== "string") {
		return undefined;
	}
	return details.latex_file_path;
}

function getLatexSnippetFromPayload(payload: unknown): string | undefined {
	if (!isStringRecord(payload) || !isStringRecord(payload.details)) {
		return undefined;
	}
	const details = payload.details;
	if (typeof details.latex_source !== "string") {
		return undefined;
	}
	return details.latex_source;
}

function getRasterizePdfPathFromPayload(payload: unknown): string {
	if (!isStringRecord(payload) || !isStringRecord(payload.details)) {
		return "";
	}
	const details = payload.details;
	if (typeof details.pdf_path !== "string") {
		return "";
	}
	return details.pdf_path;
}

function getExistingArtifacts(...paths: string[]): string[] {
	const seen = new Set<string>();
	for (const path of paths) {
		if (!path || seen.has(path) || !existsSync(path)) {
			continue;
		}
		seen.add(path);
	}
	return Array.from(seen);
}

function callbackTargetRegistryKey(context: HostServiceWorkspaceContext, targetId: string): string {
	const workspaceRoot = context.workspace_root ?? context.cwd;
	const sessionId = context.session_id ?? "";
	return JSON.stringify([workspaceRoot, sessionId, targetId]);
}

function resolveStaleAfterNs(staleAfterMs: number | undefined): number | undefined {
	if (staleAfterMs === undefined) return undefined;
	return Date.now() * 1_000_000 + staleAfterMs * 1_000_000;
}

function isSocketUsable(socketPath: string): Promise<boolean> {
	try {
		const st = lstatSync(socketPath);
		if (!st.isSocket()) {
			return Promise.resolve(false);
		}
	} catch {
		return Promise.resolve(false);
	}
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finalize = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const socket = createConnection({ path: socketPath });
		const timer = setTimeout(() => {
			finalize(false);
			socket.destroy();
		}, CALLBACK_SOCKET_PROBE_TIMEOUT_MS);
		timer.unref?.();

		socket.once("connect", () => {
			finalize(true);
			socket.destroy();
		});
		socket.once("error", () => {
			finalize(false);
			socket.destroy();
		});
	});
}

function buildCompileErrorResponse(
	requestId: string,
	workspaceContext: HostServiceWorkspaceContext,
	source: string,
	logPath: string,
	clean: boolean,
	errorCode: string,
	errorText: string,
	operation: HostServiceOperation,
): string {
	const nowNs = Date.now() * 1_000_000;
	const response = {
		protocol_version: PROTOCOL_VERSION,
		request_id: requestId,
		operation,
		status: "error",
		generated_at_ns: nowNs,
		error: errorText,
		status_details: {
			protocol_version: PROTOCOL_VERSION,
			supported: false,
			service_available: false,
			workspace_context: workspaceContext,
			request_id: requestId,
			operation,
			source: source,
			pdf: "",
			log: logPath,
			clean: clean,
			artifact_paths: getExistingArtifacts(logPath),
			cleaned_artifacts: [],
			error_code: errorCode,
		},
	};
	return `${JSON.stringify(response)}\n`;
}

function buildViewerOperationErrorResponse(
	requestId: string,
	workspaceContext: HostServiceWorkspaceContext,
	operation: "open_pdf" | "close_pdf" | "jump_pdf",
	errorCode: string,
	errorText: string,
): string {
	const nowNs = Date.now() * 1_000_000;
	const base: Record<string, unknown> = {
		protocol_version: PROTOCOL_VERSION,
		request_id: requestId,
		operation,
		status: "error",
		generated_at_ns: nowNs,
		error: errorText,
		status_details: {
			protocol_version: PROTOCOL_VERSION,
			supported: false,
			service_available: false,
			workspace_context: workspaceContext,
			request_id: requestId,
			operation,
			error_code: errorCode,
		},
	};
	if (operation === "open_pdf") {
		(base.status_details as Record<string, unknown>).backend = "unknown";
		(base.status_details as Record<string, unknown>).backend_path = "unknown";
		(base.status_details as Record<string, unknown>).capabilities = {
			open: false,
			close: false,
			forward_search: false,
			inverse_search: false,
			reuse: false,
		};
		(base.status_details as Record<string, unknown>).owned = false;
		(base.status_details as Record<string, unknown>).reused = false;
		(base.status_details as Record<string, unknown>).pdf = "";
	}
	if (operation === "close_pdf") {
		(base.status_details as Record<string, unknown>).backend = "unknown";
		(base.status_details as Record<string, unknown>).backend_path = "unknown";
		(base.status_details as Record<string, unknown>).closed = false;
		(base.status_details as Record<string, unknown>).reason = "unavailable during validation";
	}
	if (operation === "jump_pdf") {
		(base.status_details as Record<string, unknown>).backend = "unknown";
		(base.status_details as Record<string, unknown>).backend_path = "unknown";
		(base.status_details as Record<string, unknown>).handled = false;
		(base.status_details as Record<string, unknown>).reopened = false;
		(base.status_details as Record<string, unknown>).reason = "unavailable during validation";
	}
	return `${JSON.stringify(base)}\n`;
}

type HostServiceNonCompileOperation = Exclude<
	HostServiceOperation,
	"compile_latex_file" | "compile_latex_snippet"
>;

function buildErrorResponse(
	protocolVersion: number,
	socketPath: string,
	serviceName: string,
	serviceInstanceId: string,
	requestId: string,
	errorText: string,
	errorCode: string,
	operation: HostServiceNonCompileOperation = "status",
): string {
	const nowNs = Date.now() * 1_000_000;
	const response = {
		protocol_version: protocolVersion,
		request_id: requestId,
		operation,
		status: "error",
		generated_at_ns: nowNs,
		error: errorText,
		status_details: {
			protocol_version: protocolVersion,
			supported: false,
			service_available: false,
			service_name: serviceName,
			socket_path: socketPath,
			service_instance_started_ns: nowNs,
			service_instance_id: serviceInstanceId,
			workspace_context: FALLBACK_WORKSPACE_CONTEXT,
			request_id: requestId,
			operation,
			uptime_ns: 0,
			total_requests: 0,
			error_code: errorCode,
		},
	} as HostServiceResponseEnvelope;
	return `${JSON.stringify(response)}\n`;
}


function ensureDirectory(path: string): void {
	try {
		lstatSync(path);
		assertDirectorySafe(path);
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			mkdirSync(path, { recursive: true, mode: REQUIRED_DIRECTORY_MODE });
			chmodSync(path, REQUIRED_DIRECTORY_MODE);
			assertDirectorySafe(path);
			return;
		}
		throw error;
	}
}

function assertDirectorySafe(path: string): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) {
		throw new Error(`host service path is a symlink: ${path}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`host service path is not a directory: ${path}`);
	}
	if (process.getuid?.() !== undefined && st.uid !== process.getuid()) {
		throw new Error(`host service path is not owned by current user: ${path}`);
	}
	if ((st.mode & 0o777) !== REQUIRED_DIRECTORY_MODE) {
		throw new Error(`host service path has unsafe mode: ${path}`);
	}
}

function validateHostServiceSocketDirectory(dir: string): void {
	assertDirectorySafe(dir);
	// directory read/write/execute check is enforced by accessSync to guarantee current user visibility.
	accessSync(dir, constants.F_OK | constants.R_OK | constants.W_OK | constants.X_OK);
}

type SocketProbeResult = "stale" | "in_use";

async function isSocketPathSafeToReclaim(socketPath: string): Promise<SocketProbeResult> {
	return new Promise<SocketProbeResult>((resolve, reject) => {
		let settled = false;
		const resolveIfUnsettled = (result: SocketProbeResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const rejectIfUnsettled = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		const socket = createConnection({ path: socketPath });
		const timer = setTimeout(() => {
			rejectIfUnsettled(new Error(`host service socket path probe timed out: ${socketPath}`));
			socket.destroy();
		}, STARTUP_SOCKET_CHECK_TIMEOUT_MS);
		timer.unref?.();
		socket.once("connect", () => {
			resolveIfUnsettled("in_use");
			socket.destroy();
		});
		socket.once("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ECONNREFUSED") {
				resolveIfUnsettled("stale");
				return;
			}
			if (code) {
				rejectIfUnsettled(new Error(`host service socket path is not safe to replace (${code}): ${socketPath}`));
				return;
			}
			rejectIfUnsettled(new Error(`host service socket path probe failed for unknown reason: ${socketPath}`));
		});
		socket.once("close", () => {
			if (!settled) {
				rejectIfUnsettled(new Error(`host service socket path probe closed before verdict: ${socketPath}`));
			}
		});
	});
}

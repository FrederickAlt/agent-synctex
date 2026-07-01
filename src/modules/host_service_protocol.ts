import type {
	HostServiceCallbackTarget,
	HostServiceViewerBackendCapabilities,
} from "./host_service_viewer_protocol.ts";
import type { InlinePreviewArtifact } from "./preview/inline_preview.ts";
import type { LatexCompileStatus, LatexDiagnosticSummary } from "./latex/latex_file_compiler.ts";
import type { HostServicePendingNotification } from "./host_service_session_leases.ts";

export type { HostServiceCallbackTarget, HostServiceViewerBackendCapabilities, HostServicePendingNotification };


export interface HostServiceWorkspaceContext {
	cwd: string;
	workspace_root?: string;
	session_id?: string;
}

export interface HostServiceStatusRequest {
	protocol_version: number;
	request_id: string;
	operation: "status";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
}

export interface HostServiceSessionHeartbeatRequest {
	protocol_version: number;
	request_id: string;
	operation: "session_heartbeat";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
}

export interface HostServiceGetPendingNotificationsRequest {
	protocol_version: number;
	request_id: string;
	operation: "get_pending_notifications";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
}

export interface HostServiceCompileRequest {
	protocol_version: number;
	request_id: string;
	operation: "compile_latex_file";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	details: {
		latex_file_path: string;
		compiler?: unknown;
		clean?: boolean;
		open_pdf?: boolean;
		reuse_existing?: boolean;
		require_persistent_viewer?: boolean;
		callback_target_id?: string;
		callback?: HostServiceCallbackTarget;
	};
}

export interface HostServiceCompileSnippetRequest {
	protocol_version: number;
	request_id: string;
	operation: "compile_latex_snippet";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	details: {
		latex_source: string;
		compiler?: unknown;
		suppress_page_numbers?: boolean;
		crop_to_content?: boolean;
		open_pdf?: boolean;
		fixed_preview?: boolean;
		reuse_existing?: boolean;
		require_persistent_viewer?: boolean;
		callback_target_id?: string;
		callback?: HostServiceCallbackTarget;
	};
}

export interface HostServiceRasterizeRequest {
	protocol_version: number;
	request_id: string;
	operation: "rasterize";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	details: {
		pdf_path: string;
		dpi?: number;
		page?: number;
		merge_pages?: boolean;
	};
}

export type HostServiceRasterizeArtifact = InlinePreviewArtifact;

export interface HostServiceRasterizeResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "rasterize";
	pdf_path: string;
	artifacts: HostServiceRasterizeArtifact[];
	artifact_paths: string[];
	error_code?: string;
}

export interface HostServiceRegisterCallbackTargetRequest {
	protocol_version: number;
	request_id: string;
	operation: "register_callback_target";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	target_id: string;
	target: HostServiceCallbackTarget;
	stale_after_ms?: number;
}

export interface HostServiceUnregisterCallbackTargetRequest {
	protocol_version: number;
	request_id: string;
	operation: "unregister_callback_target";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	target_id: string;
}

export interface HostServiceResolveCallbackTargetRequest {
	protocol_version: number;
	request_id: string;
	operation: "resolve_callback_target";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	target_id: string;
}

export interface HostServiceCallbackTargetRegistration {
	target_id: string;
	target: HostServiceCallbackTarget;
	stale_after_ms?: number;
}

export interface HostServiceOpenRequest {
	protocol_version: number;
	request_id: string;
	operation: "open_pdf";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	details: {
		pdf_path: string;
		callback?: HostServiceCallbackTarget;
		reuse_existing?: boolean;
		require_persistent_viewer?: boolean;
	};
}

export interface HostServiceCloseRequest {
	protocol_version: number;
	request_id: string;
	operation: "close_pdf";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	pdf_id: number;
}

export interface HostServiceJumpRequest {
	protocol_version: number;
	request_id: string;
	operation: "jump_pdf";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	pdf_id: number;
	line: number;
	source_file?: string;
}

export type HostServiceRequest =
	| HostServiceStatusRequest
	| HostServiceSessionHeartbeatRequest
	| HostServiceGetPendingNotificationsRequest
	| HostServiceCompileRequest
	| HostServiceCompileSnippetRequest
	| HostServiceRasterizeRequest
	| HostServiceOpenRequest
	| HostServiceCloseRequest
	| HostServiceJumpRequest
	| HostServiceRegisterCallbackTargetRequest
	| HostServiceUnregisterCallbackTargetRequest
	| HostServiceResolveCallbackTargetRequest;

export type HostServiceOperation =
	| "status"
	| "session_heartbeat"
	| "get_pending_notifications"
	| "compile_latex_file"
	| "compile_latex_snippet"
	| "rasterize"
	| "open_pdf"
	| "close_pdf"
	| "jump_pdf"
	| "register_callback_target"
	| "unregister_callback_target"
	| "resolve_callback_target";

export interface HostServiceStatusResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	service_name: string;
	socket_path: string;
	service_instance_started_ns: number;
	service_instance_id: string;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "status";
	uptime_ns: number;
	total_requests: number;
	error_code?: string;
	viewer_backend_name?: string;
	viewer_backend_available?: boolean;
	viewer_backend_capabilities?: HostServiceViewerBackendCapabilities;
	live_session_count?: number;
}

export interface HostServiceSessionHeartbeatResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	service_name: string;
	socket_path: string;
	service_instance_started_ns: number;
	service_instance_id: string;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "session_heartbeat";
	session_id?: string;
	last_seen_at_ns?: number;
	lease_expires_at_ns?: number;
	live_session_count?: number;
	uptime_ns: number;
	total_requests: number;
	error_code?: string;
}

export interface HostServiceGetPendingNotificationsResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	service_name: string;
	socket_path: string;
	service_instance_started_ns: number;
	service_instance_id: string;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "get_pending_notifications";
	session_id?: string;
	notifications: HostServicePendingNotification[];
	delivered_count: number;
	live_session_count?: number;
	uptime_ns: number;
	total_requests: number;
	error_code?: string;
}

export interface HostServiceCompileResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "compile_latex_file";
	source: string;
	pdf: string;
	log: string;
	artifact_paths: string[];
	clean: boolean;
	cleaned_artifacts: string[];
	compile_status?: LatexCompileStatus;
	compiler_exit_code?: number | null;
	compiler_signal?: string | null;
	warning_count?: number;
	warnings?: LatexDiagnosticSummary[];
	warnings_truncated?: boolean;
	error_summary?: string;
	diagnostics?: LatexDiagnosticSummary[];
	pdf_id?: number;
	viewer_url?: string;
	managed_record?: HostServiceManagedViewerRecord;
	error_code?: string;
}

export interface HostServiceCompileSnippetResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "compile_latex_snippet";
	source: string;
	pdf: string;
	log: string;
	artifact_paths: string[];
	clean: boolean;
	cleaned_artifacts: string[];
	compile_status?: LatexCompileStatus;
	compiler_exit_code?: number | null;
	compiler_signal?: string | null;
	warning_count?: number;
	warnings?: LatexDiagnosticSummary[];
	warnings_truncated?: boolean;
	error_summary?: string;
	diagnostics?: LatexDiagnosticSummary[];
	operation_pdf?: string;
	operation_artifact_paths?: string[];
	pdf_id?: number;
	viewer_url?: string;
	managed_record?: HostServiceManagedViewerRecord;
	error_code?: string;
}
export interface HostServiceRegisterCallbackTargetResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	service_name: string;
	socket_path: string;
	service_instance_started_ns: number;
	service_instance_id: string;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "register_callback_target";
	target_id?: string;
	callback_registered?: boolean;
	callback_replaced?: boolean;
	target?: HostServiceCallbackTarget;
	uptime_ns: number;
	total_requests: number;
	error_code?: string;
}

export interface HostServiceUnregisterCallbackTargetResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	service_name: string;
	socket_path: string;
	service_instance_started_ns: number;
	service_instance_id: string;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "unregister_callback_target";
	target_id?: string;
	removed?: boolean;
	uptime_ns: number;
	total_requests: number;
	error_code?: string;
}

export interface HostServiceResolveCallbackTargetResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	service_name: string;
	socket_path: string;
	service_instance_started_ns: number;
	service_instance_id: string;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "resolve_callback_target";
	target_id?: string;
	callback_available?: boolean;
	target?: HostServiceCallbackTarget;
	uptime_ns: number;
	total_requests: number;
	error_code?: string;
}

export interface HostServiceOpenResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "open_pdf";
	backend: string;
	backend_path: string;
	capabilities: HostServiceViewerBackendCapabilities;
	handle?: string;
	owned: boolean;
	reused: boolean;
	pid?: number;
	pid_diagnostic?: string;
	pdf?: string;
	pdf_id?: number;
	revision?: number;
	viewer_url?: string;
	browser_launch?: Record<string, unknown>;
	managed_record?: HostServiceManagedViewerRecord;
	error_code?: string;
	reason?: string;
}

export interface HostServiceCloseResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "close_pdf";
	backend: string;
	backend_path: string;
	backend_identity_ok?: boolean;
	closed: boolean;
	reason?: string;
	handle?: string;
	pdf_id: number;
	viewer_notifications?: number;
	error_code?: string;
}

export interface HostServiceJumpResponseSynctexRange {
	page: number;
	h: number;
	v: number;
	W: number;
	H: number;
}

export interface HostServiceJumpResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "jump_pdf";
	backend: string;
	backend_path: string;
	backend_identity_ok?: boolean;
	handled: boolean;
	closed?: boolean;
	reopened: boolean;
	pdf?: string;
	pdf_id?: number;
	source_file?: string;
	line?: number;
	source_line?: string;
	page?: number;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	ranges?: HostServiceJumpResponseSynctexRange[];
	synctex_branch?: "native" | "js_fallback";
	synctex_diagnostics?: unknown;
	viewer_notifications?: number;
	reason?: string;
	handle?: string;
	error_code?: string;
	diagnostics?: Array<Record<string, unknown>>;
	managed_record?: HostServiceManagedViewerRecord;
}

export interface HostServiceStatusResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "status";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceStatusResponseDetails;
}

export interface HostServiceSessionHeartbeatResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "session_heartbeat";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceSessionHeartbeatResponseDetails;
}

export interface HostServiceGetPendingNotificationsResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "get_pending_notifications";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceGetPendingNotificationsResponseDetails;
}

export interface HostServiceCompileResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "compile_latex_file";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceCompileResponseDetails;
}

export interface HostServiceCompileSnippetResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "compile_latex_snippet";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceCompileSnippetResponseDetails;
}

export interface HostServiceRasterizeResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "rasterize";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceRasterizeResponseDetails;
}

export interface HostServiceOpenResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "open_pdf";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	pdf?: string;
	status_details: HostServiceOpenResponseDetails;
}

export interface HostServiceCloseResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "close_pdf";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceCloseResponseDetails;
}

export interface HostServiceJumpResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "jump_pdf";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceJumpResponseDetails;
}

export interface HostServiceRegisterCallbackTargetResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "register_callback_target";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceRegisterCallbackTargetResponseDetails;
}

export interface HostServiceUnregisterCallbackTargetResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "unregister_callback_target";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceUnregisterCallbackTargetResponseDetails;
}

export interface HostServiceResolveCallbackTargetResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "resolve_callback_target";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceResolveCallbackTargetResponseDetails;
}

export type HostServiceResponseEnvelope =
	| HostServiceStatusResponseEnvelope
	| HostServiceSessionHeartbeatResponseEnvelope
	| HostServiceGetPendingNotificationsResponseEnvelope
	| HostServiceCompileResponseEnvelope
	| HostServiceCompileSnippetResponseEnvelope
	| HostServiceRasterizeResponseEnvelope
	| HostServiceOpenResponseEnvelope
	| HostServiceCloseResponseEnvelope
	| HostServiceJumpResponseEnvelope
	| HostServiceRegisterCallbackTargetResponseEnvelope
	| HostServiceUnregisterCallbackTargetResponseEnvelope
	| HostServiceResolveCallbackTargetResponseEnvelope;

export type HostServiceAnyResponseDetails =
	| HostServiceStatusResponseDetails
	| HostServiceSessionHeartbeatResponseDetails
	| HostServiceGetPendingNotificationsResponseDetails
	| HostServiceCompileResponseDetails
	| HostServiceCompileSnippetResponseDetails
	| HostServiceRasterizeResponseDetails
	| HostServiceOpenResponseDetails
	| HostServiceCloseResponseDetails
	| HostServiceJumpResponseDetails
	| HostServiceRegisterCallbackTargetResponseDetails
	| HostServiceUnregisterCallbackTargetResponseDetails
	| HostServiceResolveCallbackTargetResponseDetails;

export interface HostServiceResponseError extends Error {
	statusDetails?: HostServiceAnyResponseDetails;
	errorCode?: string;
	requestId?: string;
	requestOperation?: HostServiceOperation;
}

export interface HostServiceManagedViewerRecord {
	id: number;
	pdfPath: string;
	viewerHandle: string;
	viewerBackend: string;
	viewerOwned: boolean;
	createdAtNs: number;
	callback?: HostServiceCallbackTarget;
	pid?: number;
	pidDiagnostic?: string;
	reused?: boolean;
	capabilities?: HostServiceViewerBackendCapabilities;
	backendPath?: string;
	defaultSourcePath?: string;
	metadata?: Record<string, unknown>;
}

export interface HostServiceManagedViewerRecordInput {
	pdfPath: string;
	viewerHandle: string;
	viewerBackend: string;
	viewerOwned: boolean;
	pid?: number;
	pidDiagnostic?: string;
	reused?: boolean;
	capabilities?: HostServiceViewerBackendCapabilities;
	backendPath?: string;
	callback?: HostServiceCallbackTarget;
	defaultSourcePath?: string;
	metadata?: Record<string, unknown>;
}

export type HostServicePdfIdRecordState = "active" | "stale" | "closed";

export interface HostServicePdfIdKnownRecord {
	state: HostServicePdfIdRecordState;
	record: HostServiceManagedViewerRecord;
}

export interface HostServicePdfIdRegistryLike {
	findActiveRecord(predicate: (record: HostServiceManagedViewerRecord) => boolean): HostServiceManagedViewerRecord | undefined;
	getActiveRecord(pdfId: number): HostServiceManagedViewerRecord;
	getKnownRecord(pdfId: number): HostServicePdfIdKnownRecord;
	trackRecord(record: HostServiceManagedViewerRecordInput): HostServiceManagedViewerRecord;
	reviveRecord(pdfId: number): HostServiceManagedViewerRecord;
	reviveRecordIfState(pdfId: number, expectedState: HostServicePdfIdRecordState, expectedRecord: HostServiceManagedViewerRecord): HostServiceManagedViewerRecord | undefined;
	closeRecord(pdfId: number): HostServiceManagedViewerRecord;
}

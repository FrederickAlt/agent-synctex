import type { LatexCompileStatus, LatexDiagnosticSummary } from "./latex/latex_file_compiler.ts";

export interface HostServiceWorkspaceContext {
	cwd: string;
	workspace_root?: string;
	session_id?: string;
}

export interface HostServiceViewerBackendCapabilities {
	open: boolean;
	close: boolean;
	forward_search: boolean;
	inverse_search: boolean;
	reuse: boolean;
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
		debug_synctex?: boolean;
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
		name?: string;
		preamble_root_file?: string;
		compiler?: unknown;
		suppress_page_numbers?: boolean;
		crop_to_content?: boolean;
		open_pdf?: boolean;
		debug_synctex?: boolean;
	};
}

export interface HostServiceOpenRequest {
	protocol_version: number;
	request_id: string;
	operation: "open_pdf";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
	details: {
		pdf_path: string;
		debug_synctex?: boolean;
	};
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
	debug_synctex?: boolean;
}

export type HostServiceRequest =
	| HostServiceCompileRequest
	| HostServiceCompileSnippetRequest
	| HostServiceOpenRequest
	| HostServiceJumpRequest;

export type HostServiceOperation = HostServiceRequest["operation"];

interface CompileResponseDetailsBase {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
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
	browser_launch?: Record<string, unknown>;
	managed_record?: HostServiceManagedViewerRecord;
	error_code?: string;
}

export interface HostServiceCompileResponseDetails extends CompileResponseDetailsBase {
	operation: "compile_latex_file";
}

export interface HostServiceCompileSnippetResponseDetails extends CompileResponseDetailsBase {
	operation: "compile_latex_snippet";
	source_dir?: string;
	preamble_root_file?: string;
	operation_pdf?: string;
	operation_artifact_paths?: string[];
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

export interface HostServiceJumpResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: "jump_pdf";
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceJumpResponseDetails;
}

export type HostServiceResponseEnvelope =
	| HostServiceCompileResponseEnvelope
	| HostServiceCompileSnippetResponseEnvelope
	| HostServiceOpenResponseEnvelope
	| HostServiceJumpResponseEnvelope;

export type HostServiceAnyResponseDetails =
	| HostServiceCompileResponseDetails
	| HostServiceCompileSnippetResponseDetails
	| HostServiceOpenResponseDetails
	| HostServiceJumpResponseDetails;

export interface HostServiceManagedViewerRecord {
	id: number;
	pdfPath: string;
	viewerHandle: string;
	viewerBackend: string;
	viewerOwned: boolean;
	createdAtNs: number;
	pid?: number;
	pidDiagnostic?: string;
	reused?: boolean;
	capabilities?: HostServiceViewerBackendCapabilities;
	backendPath?: string;
	defaultSourcePath?: string;
	metadata?: Record<string, unknown>;
}

import { isAbsolute, relative, resolve } from "node:path";
import { HostServiceCompileService } from "./host_service_compile.ts";
import type { GetPdfEventsRequest, PdfEvent } from "./pdf_events.ts";
import { normalizeFetchPdfContextRequest, type FetchPdfContextRequest, type PostUserPdfContextResult } from "./post_user_pdf_context.ts";
import { appendViewerUrlAgentNotice, viewerUrlForAgentWhenNoLiveViewer } from "./viewer_url_agent_notice.ts";
import type {
	HostServiceCompileRequest,
	HostServiceCompileResponseEnvelope,
	HostServiceCompileSnippetRequest,
	HostServiceCompileSnippetResponseEnvelope,
	HostServiceJumpRequest,
	HostServiceJumpResponseEnvelope,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
	HostServiceWorkspaceContext,
} from "./host_service_protocol.ts";

const MCP_JSONRPC_VERSION = "2.0" as const;
export const MCP_TOOL_NAME = "tex-actions" as const;
export const MCP_TOOL_DISPLAY_NAME = "TeX Actions" as const;
export const MCP_PROTOCOL_VERSION = "2025-03-26" as const;
export const MCP_SERVER_VERSION = "0.1.0" as const;
export const MCP_ERROR_PARSE_ERROR = -32700;
export const MCP_ERROR_INVALID_REQUEST = -32600;
export const MCP_ERROR_METHOD_NOT_FOUND = -32601;
export const MCP_ERROR_INVALID_PARAMS = -32602;
export const MCP_ERROR_INTERNAL = -32603;
const MCP_RUNTIME_PROTOCOL_VERSION = 1;
const MCP_RUNTIME_REQUEST_PREFIX = "mcp-runtime";
const MCP_DEFAULT_WORKSPACE_CONTEXT: HostServiceWorkspaceContext = { cwd: "/" };
let mcpRuntimeRequestCounter = 0;

export interface HostServiceMcpPdfOperations {
	openPdf?: (request: HostServiceOpenRequest) => Promise<HostServiceOpenResponseEnvelope>;
	jumpPdf?: (request: HostServiceJumpRequest) => Promise<HostServiceJumpResponseEnvelope>;
	getPdfEvents?: (request: GetPdfEventsRequest) => PdfEvent[] | Promise<PdfEvent[]>;
	fetchPdfContext?: (request: FetchPdfContextRequest) => PostUserPdfContextResult | Promise<PostUserPdfContextResult>;
	markTrackedPdfUpdated?: (pdfPath: string) => Promise<unknown>;
	compileService?: HostServiceCompileService;
}

function createMcpCompileService(pdfOperations: HostServiceMcpPdfOperations): HostServiceCompileService {
	if (pdfOperations.compileService) {
		return pdfOperations.compileService;
	}
	return new HostServiceCompileService({
		protocolVersion: MCP_RUNTIME_PROTOCOL_VERSION,
		managedViewerService: {
			async openViewer(openRequest) {
				if (!pdfOperations.openPdf) {
					throw new Error("open_pdf is not implemented by the runtime");
				}
				return pdfOperations.openPdf(openRequest);
			},
			markPdfUpdated: pdfOperations.markTrackedPdfUpdated,
		},
	});
}

export type McpRequestId = string | number | null;

export interface McpSuccessResponse {
	jsonrpc: typeof MCP_JSONRPC_VERSION;
	id: ParsedMcpRequestId;
	result: Record<string, unknown>;
}

export interface McpErrorBody {
	code: number;
	message: string;
	data?: unknown;
}

export interface McpErrorResponse {
	jsonrpc: typeof MCP_JSONRPC_VERSION;
	id: ParsedMcpRequestId;
	error: McpErrorBody;
}

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
}

type McpResponsePayload = McpSuccessResponse | McpErrorResponse;

export interface HostServiceMcpOptions {
	hooksEnabled?: boolean;
	exposeFetchPdfContext?: boolean;
	emitViewerUrlFallback?: (url: string) => void;
}

type ParsedMcpRequestId = McpRequestId | undefined;

interface McpParsedRequest {
	id: ParsedMcpRequestId;
	method: string;
	params: unknown;
}

export interface McpToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

class McpRequestError extends Error {
	readonly code: number;
	readonly requestId: ParsedMcpRequestId;
	readonly data?: unknown;
	constructor(code: number, requestId: ParsedMcpRequestId, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.requestId = requestId;
		this.data = data;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nextRuntimeRequestId(): string {
	mcpRuntimeRequestCounter += 1;
	return `${MCP_RUNTIME_REQUEST_PREFIX}-${mcpRuntimeRequestCounter}`;
}

function normalizeWorkspaceContext(rawWorkspaceContext: unknown): HostServiceWorkspaceContext {
	if (rawWorkspaceContext === undefined) {
		return MCP_DEFAULT_WORKSPACE_CONTEXT;
	}
	if (!isRecord(rawWorkspaceContext)) {
		throw new Error("workspace_context must be an object");
	}
	const rawCwd = rawWorkspaceContext.cwd;
	if (typeof rawCwd !== "string" || !rawCwd.trim()) {
		throw new Error("workspace_context.cwd must be a non-empty string");
	}
	const workspaceContext: HostServiceWorkspaceContext = {
		cwd: rawCwd,
	};
	if (rawWorkspaceContext.workspace_root !== undefined) {
		if (typeof rawWorkspaceContext.workspace_root !== "string" || !rawWorkspaceContext.workspace_root.trim()) {
			throw new Error("workspace_context.workspace_root must be a non-empty string");
		}
		if (!isAbsolute(rawWorkspaceContext.workspace_root)) {
			throw new Error("workspace_context.workspace_root must be absolute");
		}
		workspaceContext.workspace_root = rawWorkspaceContext.workspace_root;
	}
	if (rawWorkspaceContext.session_id !== undefined) {
		if (typeof rawWorkspaceContext.session_id !== "string" || !rawWorkspaceContext.session_id.trim()) {
			throw new Error("workspace_context.session_id must be a non-empty string");
		}
		workspaceContext.session_id = rawWorkspaceContext.session_id;
	}
	return workspaceContext;
}

function parseBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
	if (!(key in args)) {
		return undefined;
	}
	const value = args[key];
	if (typeof value !== "boolean") {
		throw new Error(`${key} must be a boolean`);
	}
	return value;
}

function parseOptionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
	if (!(key in args)) {
		return undefined;
	}
	const value = args[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value;
}

function parseStringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value;
}

function parsePositiveIntegerArg(args: Record<string, unknown>, key: string): number {
	const value = args[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${key} must be a positive integer`);
	}
	return value;
}

function parseCompileWorkspaceContext(sourcePath: string, rawWorkspaceContext: unknown): HostServiceWorkspaceContext {
	if (rawWorkspaceContext === undefined) {
		if (!isAbsolute(sourcePath)) {
			throw new Error("relative latex_file_path requires workspace_context.cwd");
		}
		return MCP_DEFAULT_WORKSPACE_CONTEXT;
	}

	const workspaceContext = normalizeWorkspaceContext(rawWorkspaceContext);
	if (!isAbsolute(workspaceContext.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for compile_latex_file");
	}
	return workspaceContext;
}
function parseShowLatexRequest(args: Record<string, unknown>): HostServiceCompileSnippetRequest {
	for (const key of Object.keys(args)) {
		if (!["source", "compiler", "preamble_root_file", "workspace_context", "debug_synctex"].includes(key)) {
			throw new Error(`show_latex unknown argument: ${key}`);
		}
	}
	const source = parseStringArg(args, "source");
	const compiler = parseOptionalStringArg(args, "compiler");
	const preambleRootFile = parseOptionalStringArg(args, "preamble_root_file");
	const debugSynctex = parseBooleanArg(args, "debug_synctex");
	const rawWorkspaceContext = args.workspace_context;
	const workspaceContext = rawWorkspaceContext === undefined
		? { cwd: MCP_DEFAULT_WORKSPACE_CONTEXT.cwd }
		: normalizeWorkspaceContext(rawWorkspaceContext);
	if (rawWorkspaceContext !== undefined && !isAbsolute(workspaceContext.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for show_latex");
	}
	return {
		protocol_version: MCP_RUNTIME_PROTOCOL_VERSION,
		request_id: nextRuntimeRequestId(),
		operation: "compile_latex_snippet",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: workspaceContext,
		details: {
			latex_source: source,
			...(preambleRootFile === undefined ? {} : { preamble_root_file: preambleRootFile }),
			...(compiler === undefined ? {} : { compiler }),
			open_pdf: true,
			...(debugSynctex === undefined ? {} : { debug_synctex: debugSynctex }),
		},
	};
}

function parseOpenWorkspaceContext(pdfPath: string, rawWorkspaceContext: unknown): HostServiceWorkspaceContext {
	if (rawWorkspaceContext === undefined) {
		if (!isAbsolute(pdfPath)) {
			throw new Error("relative pdf_file_path requires workspace_context.cwd");
		}
		return MCP_DEFAULT_WORKSPACE_CONTEXT;
	}
	const workspaceContext = normalizeWorkspaceContext(rawWorkspaceContext);
	if (!isAbsolute(workspaceContext.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for open_pdf");
	}
	return workspaceContext;
}

function parseJumpWorkspaceContext(rawWorkspaceContext: unknown, sourceFile?: string): HostServiceWorkspaceContext {
	if (rawWorkspaceContext === undefined) {
		if (sourceFile !== undefined && !isAbsolute(sourceFile)) {
			throw new Error("relative source_file requires workspace_context.cwd");
		}
		return MCP_DEFAULT_WORKSPACE_CONTEXT;
	}
	const workspaceContext = normalizeWorkspaceContext(rawWorkspaceContext);
	if (!isAbsolute(workspaceContext.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for jump_pdf");
	}
	return workspaceContext;
}

function parseCompileLatexFileRequest(args: Record<string, unknown>): { compileRequest: HostServiceCompileRequest; hideWarnings: boolean } {
	const allowedArgs = new Set(["latex_file_path", "compiler", "clean", "open_pdf", "hide_warnings", "reuse_existing", "require_persistent_viewer", "debug_synctex", "workspace_context"]);
	for (const key of Object.keys(args)) {
		if (!allowedArgs.has(key)) {
			throw new Error(`compile_latex_file unknown argument: ${key}`);
		}
	}
	const latexFilePath = parseStringArg(args, "latex_file_path");
	const compiler = parseOptionalStringArg(args, "compiler");
	const clean = parseBooleanArg(args, "clean");
	const openPdf = parseBooleanArg(args, "open_pdf");
	const hideWarnings = parseBooleanArg(args, "hide_warnings") ?? true;
	const reuseExisting = openPdf ? parseBooleanArg(args, "reuse_existing") : undefined;
	const requirePersistentViewer = openPdf ? parseBooleanArg(args, "require_persistent_viewer") : undefined;
	const debugSynctex = openPdf ? parseBooleanArg(args, "debug_synctex") : undefined;
	const workspaceContext = parseCompileWorkspaceContext(latexFilePath, args.workspace_context);
	return {
		compileRequest: {
			protocol_version: MCP_RUNTIME_PROTOCOL_VERSION,
			request_id: nextRuntimeRequestId(),
			operation: "compile_latex_file",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: workspaceContext,
			details: {
				latex_file_path: latexFilePath,
				...(compiler === undefined ? {} : { compiler }),
				...(clean === undefined ? {} : { clean }),
				...(openPdf === undefined ? {} : { open_pdf: openPdf }),
				...(reuseExisting === undefined ? {} : { reuse_existing: reuseExisting }),
				...(requirePersistentViewer === undefined ? {} : { require_persistent_viewer: requirePersistentViewer }),
				...(debugSynctex === undefined ? {} : { debug_synctex: debugSynctex }),
			},
		},
		hideWarnings,
	};
}

function parseOpenPdfRequest(args: Record<string, unknown>): HostServiceOpenRequest {
	const allowedArgs = new Set(["pdf_file_path", "reuse_existing", "require_persistent_viewer", "debug_synctex", "workspace_context"]);
	for (const key of Object.keys(args)) {
		if (!allowedArgs.has(key)) {
			throw new Error(`open_pdf unknown argument: ${key}`);
		}
	}
	const pdfPath = parseOptionalStringArg(args, "pdf_file_path");
	if (pdfPath === undefined) {
		throw new Error("pdf_file_path must be a non-empty string");
	}
	const rawWorkspaceContext = args.workspace_context;
	const workspaceContext = parseOpenWorkspaceContext(pdfPath, rawWorkspaceContext);
	const resolvedPdfPath = isAbsolute(pdfPath) ? pdfPath : resolve(workspaceContext.cwd, pdfPath);
	const reuseExisting = parseBooleanArg(args, "reuse_existing");
	const requirePersistentViewer = parseBooleanArg(args, "require_persistent_viewer");
	const debugSynctex = parseBooleanArg(args, "debug_synctex");
	return {
		protocol_version: MCP_RUNTIME_PROTOCOL_VERSION,
		request_id: nextRuntimeRequestId(),
		operation: "open_pdf",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: workspaceContext,
		details: {
			pdf_path: resolvedPdfPath,
			...(reuseExisting === undefined ? {} : { reuse_existing: reuseExisting }),
			...(requirePersistentViewer === undefined ? {} : { require_persistent_viewer: requirePersistentViewer }),
			...(debugSynctex === undefined ? {} : { debug_synctex: debugSynctex }),
		},
	};
}

function parseJumpPdfRequest(args: Record<string, unknown>): HostServiceJumpRequest {
	const allowedArgs = new Set(["pdf_id", "line", "source_file", "debug_synctex", "workspace_context"]);
	for (const key of Object.keys(args)) {
		if (!allowedArgs.has(key)) {
			throw new Error(`jump_pdf unknown argument: ${key}`);
		}
	}
	const pdfId = parsePositiveIntegerArg(args, "pdf_id");
	const line = parsePositiveIntegerArg(args, "line");
	const sourceFile = parseOptionalStringArg(args, "source_file");
	const debugSynctex = parseBooleanArg(args, "debug_synctex");
	const workspaceContext = parseJumpWorkspaceContext(args.workspace_context, sourceFile);
	const resolvedSourceFile = sourceFile === undefined
		? undefined
		: isAbsolute(sourceFile) ? sourceFile : resolve(workspaceContext.cwd, sourceFile);
	return {
		protocol_version: MCP_RUNTIME_PROTOCOL_VERSION,
		request_id: nextRuntimeRequestId(),
		operation: "jump_pdf",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: workspaceContext,
		pdf_id: pdfId,
		line,
		...(resolvedSourceFile === undefined ? {} : { source_file: resolvedSourceFile }),
		...(debugSynctex === undefined ? {} : { debug_synctex: debugSynctex }),
	};
}
function formatDiagnosticSummary(details: { warnings?: unknown; warning_count?: unknown; warnings_truncated?: unknown }, hideWarnings = false): string {
	if (typeof details.warning_count !== "number" || details.warning_count <= 0) return "";
	if (hideWarnings) return `\nWarnings: ${details.warning_count} warnings hidden.`;
	if (!Array.isArray(details.warnings)) return "";
	const lines = details.warnings
		.slice(0, 5)
		.map((warning) => isRecord(warning) && typeof warning.message === "string" ? `- ${warning.message}` : "")
		.filter((line) => line.length > 0);
	if (!lines.length) return "";
	return `\nWarnings:\n${lines.join("\n")}${details.warnings_truncated === true ? "\n- ... more warnings omitted" : ""}`;
}

function emitViewerUrlFallback(details: Record<string, unknown>, options: HostServiceMcpOptions): void {
	const viewerUrl = viewerUrlForAgentWhenNoLiveViewer(details);
	if (viewerUrl === undefined) return;
	options.emitViewerUrlFallback?.(viewerUrl);
}

function agentFacingDetails<T extends Record<string, unknown>>(details: T): T {
	const filtered = { ...details } as Record<string, unknown>;
	delete filtered.pdf;
	delete filtered.operation_pdf;
	delete filtered.artifact_paths;
	delete filtered.operation_artifact_paths;
	delete filtered.managed_record;
	delete filtered.handle;
	delete filtered.viewer_url;
	return filtered as T;
}

function agentFacingCompileDetails<T extends Record<string, unknown> & { warning_count?: unknown; warnings?: unknown }>(details: T, hideWarnings: boolean): T | (Omit<T, "warnings"> & { warnings_hidden: true }) {
	const filtered = agentFacingDetails(details);
	if (!hideWarnings || typeof filtered.warning_count !== "number" || filtered.warning_count <= 0) return filtered;
	const { warnings: _warnings, ...filteredDetails } = filtered;
	return { ...filteredDetails, warnings_hidden: true };
}

function formatEditableSourceNotice(details: { source?: unknown; workspace_context?: unknown }, includeSource: boolean): string {
	if (!includeSource) return "";
	if (typeof details.source !== "string" || details.source.length === 0) return "";
	const cwd = isRecord(details.workspace_context) && typeof details.workspace_context.cwd === "string"
		? details.workspace_context.cwd
		: undefined;
	const source = agentFacingPath(details.source, cwd);
	return `\nEditable source: ${source}`;
}

function agentFacingPath(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	try {
		const resolvedCwd = resolve(cwd);
		const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedCwd, path);
		const relativePath = relative(resolvedCwd, resolvedPath);
		if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath;
	} catch {
		return path;
	}
	return path;
}

function parseToolResult(
	response: HostServiceCompileResponseEnvelope | HostServiceCompileSnippetResponseEnvelope,
	successText: string,
	options: { hideWarnings?: boolean; includeSourceDirectory?: boolean } = {},
): McpToolResult {
	const details = response.status_details;
	if (response.status === "ok") {
		const status = details.compile_status ?? (successText.replace(/:$/, "") || "ok");
		const pdfId = details.pdf_id === undefined ? "" : ` pdf_id=${details.pdf_id}`;
		const warningCount = details.warning_count ? ` warnings=${details.warning_count}` : "";
		const exitCode = details.compile_status === "nonzero_but_pdf_updated" ? ` exit_code=${details.compiler_exit_code ?? "unknown"}` : "";
		const cleanOk = status === "ok" && !details.warning_count;
		const log = !cleanOk && details.log ? `\nLog: ${details.log}` : "";
		const sourceNotice = formatEditableSourceNotice(details, options.includeSourceDirectory === true);
		const text = `${status}:${pdfId}${exitCode}${warningCount}${log}${formatDiagnosticSummary(details, options.hideWarnings === true)}${sourceNotice}`.trim();
		return {
			content: [{ type: "text", text: appendViewerUrlAgentNotice(text, details as unknown as Record<string, unknown>) }],
			details: agentFacingCompileDetails(details as unknown as Record<string, unknown> & typeof details, options.hideWarnings === true),
		};
	}
	const errorCode = typeof details.error_code === "string" ? ` (code=${details.error_code})` : "";
	const summary = typeof details.error_summary === "string" && details.error_summary ? `\n${details.error_summary}` : "";
	const log = details.log ? `\nLog: ${details.log}` : "";
	const sourceNotice = formatEditableSourceNotice(details, options.includeSourceDirectory === true);
	return {
		isError: true,
		content: [{ type: "text", text: `${response.error || "compile failed"}${errorCode}${summary}${log}${sourceNotice}` }],
		details: agentFacingDetails(details as unknown as Record<string, unknown>) as unknown as typeof details,
	};
}

function parseManagedPdfToolResult(
	response: HostServiceOpenResponseEnvelope | HostServiceJumpResponseEnvelope,
	successPrefix: string,
): McpToolResult {
	const details = response.status_details as unknown as Record<string, unknown>;
	if (response.status === "ok") {
		const lineNumber = typeof details.line === "number" && Number.isInteger(details.line)
			? details.line
			: undefined;
		const line = lineNumber === undefined ? "" : ` line=${lineNumber}`;
		const sourceLine = typeof details.source_line === "string" && lineNumber !== undefined
			? `\nline ${lineNumber} contains:\n${details.source_line}`
			: "";
		const pdfId =
			typeof details.pdf_id === "number" && details.pdf_id > 0
				? ` pdf_id=${details.pdf_id}`
				: "";
		const handled =
				typeof details.handled === "boolean" && details.handled
					? " handled"
					: "";
		const text = (`${successPrefix}${pdfId}${line}${handled}`.trim() || successPrefix) + sourceLine;
		return {
			content: [{
				type: "text",
				text: appendViewerUrlAgentNotice(text, details),
			}],
			details: agentFacingDetails(details),
		};
	}
	const errorCode = typeof details.error_code === "string" ? ` (code=${details.error_code})` : "";
	return {
		isError: true,
		content: [{ type: "text", text: `${response.error || "operation failed"}${errorCode}` }],
		details: agentFacingDetails(details),
	};
}

function validMcpRequestId(raw: unknown): raw is McpRequestId {
	return typeof raw === "string" || typeof raw === "number" || raw === null;
}

function parseToolCallParams(params: unknown): { name: string; args: Record<string, unknown> } {
	if (!isRecord(params)) {
		throw new McpRequestError(MCP_ERROR_INVALID_PARAMS, null, "tools/call params must be an object");
	}
	const rawName = params.name;
	if (typeof rawName !== "string" || !rawName.trim()) {
		throw new McpRequestError(MCP_ERROR_INVALID_PARAMS, null, "tools/call requires a tool name");
	}
	const rawArguments = params.arguments;
	if (rawArguments === undefined) {
		return { name: rawName, args: {} };
	}
	if (typeof rawArguments === "string") {
		if (rawName === "show_latex") return { name: rawName, args: { source: rawArguments } };
	}
	if (!isRecord(rawArguments)) {
		throw new McpRequestError(MCP_ERROR_INVALID_PARAMS, null, "tools/call arguments must be an object");
	}
	return { name: rawName, args: rawArguments };
}

function parseRequest(rawPayload: string): McpParsedRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawPayload);
	} catch (error) {
		throw new McpRequestError(MCP_ERROR_PARSE_ERROR, null, "Parse error", error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(parsed)) {
		throw new McpRequestError(MCP_ERROR_INVALID_REQUEST, null, "Invalid Request");
	}
	const rawId = (parsed as Record<string, unknown>).id;
	let requestId: ParsedMcpRequestId;
	if (rawId === undefined) {
		requestId = undefined;
	} else if (validMcpRequestId(rawId)) {
		requestId = rawId;
	} else {
		requestId = null;
		throw new McpRequestError(MCP_ERROR_INVALID_REQUEST, requestId, "Invalid request id");
	}
	if (parsed.jsonrpc !== MCP_JSONRPC_VERSION) {
		throw new McpRequestError(MCP_ERROR_INVALID_REQUEST, requestId ?? null, "Invalid JSON-RPC version");
	}
	if (typeof parsed.method !== "string" || !parsed.method.trim()) {
		throw new McpRequestError(MCP_ERROR_INVALID_REQUEST, requestId ?? null, "Missing method");
	}
	return {
		id: requestId,
		method: parsed.method,
		params: parsed.params,
	};
}

export function buildMcpErrorResponse(id: ParsedMcpRequestId, code: number, message: string, data?: unknown): McpErrorResponse {
	return {
		jsonrpc: MCP_JSONRPC_VERSION,
		id,
		error: {
			code,
			message,
			...(data === undefined ? {} : { data }),
		},
	};
}

function buildSuccess(id: ParsedMcpRequestId, result: Record<string, unknown>): McpSuccessResponse {
	return {
		jsonrpc: MCP_JSONRPC_VERSION,
		id,
		result,
	};
}

function encodeResponse(payload: McpResponsePayload): string {
	const body = JSON.stringify(payload);
	return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function workspaceContextSchema(): { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } {
	return {
		type: "object",
		properties: {
			cwd: { type: "string", minLength: 1 },
			workspace_root: { type: "string", minLength: 1 },
			session_id: { type: "string", minLength: 1 },
		},
		required: ["cwd"],
		additionalProperties: false,
	};
}

function mcpToolDescriptions(options: HostServiceMcpOptions = {}): readonly McpToolDefinition[] {
	const tools: McpToolDefinition[] = [
		{
			name: "show_latex",
			description: "Render LaTeX as a temporary PDF and route its viewer open request through the Viewer Host Client boundary. Without preamble_root_file, source must be a complete LaTeX document. With preamble_root_file, the discovered preamble for that LaTeX root wraps either a \\begin{document}...\\end{document} body or document body content. The response includes the generated editable .tex source path so callers can edit it and recompile. If a browser viewer is detected after launch/focus, the tool returns only pdf_id plus that source location because the user can already see the output; it includes a Viewer URL only when no live browser viewer is detected.",
			inputSchema: {
				type: "object",
				properties: {
					source: { type: "string", minLength: 1, description: "LaTeX source. Without preamble_root_file, pass a complete document. With preamble_root_file, pass either a \\begin{document}...\\end{document} body or only document body content." },
					compiler: { type: "string" },
					preamble_root_file: { type: "string", minLength: 1, description: "LaTeX root file whose discovered preamble should wrap this source. Relative paths resolve from the workspace cwd." },
					workspace_context: workspaceContextSchema(),
				},
				required: ["source"],
				additionalProperties: false,
			},
		},
		{
			name: "compile_latex_file",
			description: "Compile a LaTeX source file once with latexmk and optionally route the output PDF open request through the Viewer Host Client boundary. The compiler option selects the TeX engine latexmk should run. Same-root requests are coordinated in the MCP runtime to avoid overlapping latexmk processes. Set clean=true to remove common same-basename artifacts before compiling. Warning message details are hidden by default; set hide_warnings=false to show warning summaries and details.warnings. When open_pdf=true, if a browser viewer is detected after launch/focus, the tool returns only pdf_id because the user can already see the output; it includes a Viewer URL only when no live browser viewer is detected.",
			inputSchema: {
				type: "object",
				properties: {
					latex_file_path: { type: "string", minLength: 1 },
					compiler: { type: "string" },
					clean: { type: "boolean" },
					open_pdf: { type: "boolean" },
					hide_warnings: { type: "boolean", default: true, description: "Defaults to true. When true, successful compiles keep warning_count metadata but hide warning message details from text and omit details.warnings. Set hide_warnings=false to show warning summaries and details.warnings." },
					reuse_existing: { type: "boolean" },
					require_persistent_viewer: { type: "boolean" },
					workspace_context: workspaceContextSchema(),
				},
				required: ["latex_file_path"],
				additionalProperties: false,
			},
		},
		{
			name: "open_pdf",
			description: "Register a PDF in MCP state, send an open/focus request through the Viewer Host Client boundary, and return a runtime PDF id. If a browser viewer is detected after launch/focus, the tool returns only pdf_id because the user can already see the output; it includes a Viewer URL only when no live browser viewer is detected.",
			inputSchema: {
				type: "object",
				properties: {
					pdf_file_path: { type: "string", minLength: 1 },
					reuse_existing: { type: "boolean" },
					require_persistent_viewer: { type: "boolean" },
					workspace_context: workspaceContextSchema(),
				},
				required: ["pdf_file_path"],
				additionalProperties: false,
			},
		},
		{
			name: "jump_pdf",
			description: "Jump a tracked PDF to a source line via forward SyncTeX. If a browser viewer is detected after launch/focus, the tool returns only pdf_id/handled status because the user can already see the output; it includes a Viewer URL only when no live browser viewer is detected.",
			inputSchema: {
				type: "object",
				properties: {
					pdf_id: { type: "integer", minimum: 1 },
					line: { type: "integer", minimum: 1 },
					source_file: { type: "string", minLength: 1 },
					workspace_context: workspaceContextSchema(),
				},
				required: ["pdf_id", "line"],
				additionalProperties: false,
			},
		},
	];
	if (shouldExposeFetchPdfContext(options)) {
		tools.push({
			name: "fetch_pdf_context",
			description: "Fetch unread PDF viewer marks/comments as concise source-cited context. Returns user comments attached to LaTeX source lines and consumes pending viewer marks.",
			inputSchema: {
				type: "object",
				properties: {
					pdf_id: { type: "integer", minimum: 1 },
					max_events: { type: "integer", minimum: 1 },
				},
				required: [],
				additionalProperties: false,
			},
		});
	}
	return tools;
}

const HOST_SERVICE_BASE_TOOL_NAMES = [
	"show_latex",
	"compile_latex_file",
	"open_pdf",
	"jump_pdf",
] as const;

export const HOST_SERVICE_TOOL_NAMES = [
	...HOST_SERVICE_BASE_TOOL_NAMES,
	"fetch_pdf_context",
] as const;

type HostServiceToolName = (typeof HOST_SERVICE_TOOL_NAMES)[number];

function hostServiceToolNames(options: HostServiceMcpOptions = {}): readonly HostServiceToolName[] {
	return shouldExposeFetchPdfContext(options) ? HOST_SERVICE_TOOL_NAMES : HOST_SERVICE_BASE_TOOL_NAMES;
}

function shouldExposeFetchPdfContext(options: HostServiceMcpOptions = {}): boolean {
	return options.exposeFetchPdfContext ?? options.hooksEnabled !== true;
}

type HostServiceMcpToolHandler = (
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	pdfOperations: HostServiceMcpPdfOperations,
	mcpCompileService: HostServiceCompileService,
	options: HostServiceMcpOptions,
) => Promise<McpResponsePayload>;

async function handleShowLatexTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	_pdfOperations: HostServiceMcpPdfOperations,
	mcpCompileService: HostServiceCompileService,
	options: HostServiceMcpOptions,
): Promise<McpResponsePayload> {
	let compileRequest: HostServiceCompileSnippetRequest;
	try {
		compileRequest = parseShowLatexRequest(args);
	} catch (error) {
		return buildMcpErrorResponse(
			requestId,
			MCP_ERROR_INVALID_PARAMS,
			error instanceof Error ? error.message : String(error),
		);
	}
	try {
		const compileResponse = await mcpCompileService.compileLatexSnippetRequest(compileRequest);
		emitViewerUrlFallback(compileResponse.status_details as unknown as Record<string, unknown>, options);
		return buildSuccess(requestId, parseToolResult(compileResponse, "ok", { includeSourceDirectory: true }));
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: `show_latex failed: ${details}` }],
		});
	}
}

async function handleCompileLatexFileTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	pdfOperations: HostServiceMcpPdfOperations,
	mcpCompileService: HostServiceCompileService,
	options: HostServiceMcpOptions,
): Promise<McpResponsePayload> {
	let compileRequest: HostServiceCompileRequest;
	let hideWarnings = true;
	try {
		const parsed = parseCompileLatexFileRequest(args);
		compileRequest = parsed.compileRequest;
		hideWarnings = parsed.hideWarnings;
	} catch (error) {
		return buildMcpErrorResponse(
			requestId,
			MCP_ERROR_INVALID_PARAMS,
			error instanceof Error ? error.message : String(error),
		);
	}
	try {
		const compileResponse = await mcpCompileService.compileLatexFileRequest(compileRequest);
		emitViewerUrlFallback(compileResponse.status_details as unknown as Record<string, unknown>, options);
		return buildSuccess(requestId, parseToolResult(compileResponse, "ok:", { hideWarnings }));
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: `compile_latex_file failed: ${details}` }],
		});
	}
}

async function handleOpenPdfTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	pdfOperations: HostServiceMcpPdfOperations,
	_mcpCompileService: HostServiceCompileService,
	options: HostServiceMcpOptions,
): Promise<McpResponsePayload> {
	let openRequest: HostServiceOpenRequest;
	try {
		openRequest = parseOpenPdfRequest(args);
	} catch (error) {
		return buildMcpErrorResponse(
			requestId,
			MCP_ERROR_INVALID_PARAMS,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (!pdfOperations.openPdf) {
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: "open_pdf is not yet implemented by the runtime" }],
		});
	}
	try {
		const openResponse = await pdfOperations.openPdf(openRequest);
		emitViewerUrlFallback(openResponse.status_details as unknown as Record<string, unknown>, options);
		return buildSuccess(requestId, parseManagedPdfToolResult(openResponse, "open_pdf ok:"));
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: `open_pdf failed: ${details}` }],
		});
	}
}

async function handleJumpPdfTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	pdfOperations: HostServiceMcpPdfOperations,
	_mcpCompileService: HostServiceCompileService,
	options: HostServiceMcpOptions,
): Promise<McpResponsePayload> {
	let jumpRequest: HostServiceJumpRequest;
	try {
		jumpRequest = parseJumpPdfRequest(args);
	} catch (error) {
		return buildMcpErrorResponse(
			requestId,
			MCP_ERROR_INVALID_PARAMS,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (!pdfOperations.jumpPdf) {
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: "jump_pdf is not yet implemented by the runtime" }],
		});
	}
	try {
		const jumpResponse = await pdfOperations.jumpPdf(jumpRequest);
		emitViewerUrlFallback(jumpResponse.status_details as unknown as Record<string, unknown>, options);
		return buildSuccess(requestId, parseManagedPdfToolResult(jumpResponse, "jump_pdf ok:"));
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: `jump_pdf failed: ${details}` }],
		});
	}
}

async function handleFetchPdfContextTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	pdfOperations: HostServiceMcpPdfOperations,
	_mcpCompileService: HostServiceCompileService,
	_options: HostServiceMcpOptions,
): Promise<McpResponsePayload> {
	let request: FetchPdfContextRequest;
	try {
		request = normalizeFetchPdfContextRequest(args);
	} catch (error) {
		return buildMcpErrorResponse(requestId, MCP_ERROR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
	}
	const result = await collectPdfContext(pdfOperations, request);
	return buildSuccess(requestId, {
		content: [{ type: "text", text: result.text || "No PDF marks from the User are pending." }],
		details: {
			pdf_ids: result.pdfIds,
			event_count: result.eventCount,
			cleared: result.cleared,
		},
	});
}

async function collectPdfContext(pdfOperations: HostServiceMcpPdfOperations, request: FetchPdfContextRequest): Promise<PostUserPdfContextResult> {
	return await pdfOperations.fetchPdfContext?.(request) ?? {
		text: "",
		pdfIds: [],
		eventCount: 0,
		cleared: false,
		events: [],
	};
}

export function mcpFramedResponse(payload: McpResponsePayload): string {
	return encodeResponse(payload);
}

export async function handleMcpRequest(
	rawPayload: string,
	pdfOperations: HostServiceMcpPdfOperations = {},
	options: HostServiceMcpOptions = {},
): Promise<McpResponsePayload | null> {
	let request: McpParsedRequest;
	try {
		request = parseRequest(rawPayload);
	} catch (error) {
		if (error instanceof McpRequestError) {
			return buildMcpErrorResponse(error.requestId, error.code, error.message, error.data);
		}
		return buildMcpErrorResponse(null, MCP_ERROR_INTERNAL, error instanceof Error ? error.message : String(error));
	}

	if (request.id === undefined && !request.method.startsWith("notifications/")) {
		return buildMcpErrorResponse(null, MCP_ERROR_INVALID_REQUEST, "Missing request id");
	}
	if (request.id === undefined) {
		return null;
	}

	switch (request.method) {
		case "initialize":
			return buildSuccess(request.id, {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {
					tools: {
						listChanged: false,
					},
				},
				serverInfo: {
					name: MCP_TOOL_NAME,
					version: MCP_SERVER_VERSION,
					displayName: MCP_TOOL_DISPLAY_NAME,
				},
			});
		case "ping":
			return buildSuccess(request.id, {});
		case "tools/list":
			return buildSuccess(request.id, {
				tools: mcpToolDescriptions(options),
			});
		case "tools/call": {
			let call: { name: string; args: Record<string, unknown> };
			try {
				call = parseToolCallParams(request.params);
			} catch (error) {
				if (error instanceof McpRequestError) {
					return buildMcpErrorResponse(request.id, MCP_ERROR_INVALID_PARAMS, error.message, error.data);
				}
				return buildMcpErrorResponse(request.id, MCP_ERROR_INTERNAL, error instanceof Error ? error.message : String(error));
			}

			if (!hostServiceToolNames(options).includes(call.name as HostServiceToolName)) {
				return buildSuccess(request.id, {
					isError: true,
					content: [{ type: "text", text: `Tool not implemented by runtime: ${call.name}` }],
				});
			}

			const mcpCompileService = createMcpCompileService(pdfOperations);
			const toolHandlers: Record<HostServiceToolName, HostServiceMcpToolHandler> = {
				show_latex: handleShowLatexTool,
				compile_latex_file: handleCompileLatexFileTool,
				open_pdf: handleOpenPdfTool,
				jump_pdf: handleJumpPdfTool,
				fetch_pdf_context: handleFetchPdfContextTool,
			};
			const handler = toolHandlers[call.name as HostServiceToolName] ?? null;
			if (handler === null) {
				return buildSuccess(request.id, {
					isError: true,
					content: [{ type: "text", text: `${call.name} is not yet implemented by the runtime` }],
				});
			}

			return await handler(request.id, call.args, pdfOperations, mcpCompileService, options);
		}
		default:
			return buildMcpErrorResponse(request.id, MCP_ERROR_METHOD_NOT_FOUND, `method not found: ${request.method}`);
	}
}

export async function handleFramedMcpRequest(
	rawPayload: string,
	pdfOperations?: HostServiceMcpPdfOperations,
	options?: HostServiceMcpOptions,
): Promise<string | null> {
	const response = await handleMcpRequest(rawPayload, pdfOperations, options);
	if (response === null) {
		return null;
	}
	return mcpFramedResponse(response);
}

export interface McpStdioFrame {
	protocol: "mcp" | "json-line";
	payload: string;
}

const MCP_HEADER_PREFIX = "content-length:";

export class McpStdioFrameReader {
	private buffer: Buffer = Buffer.alloc(0);
	private protocol: McpStdioFrame["protocol"] | undefined;
	private contentLength: number | undefined;
	private readonly maxPayloadBytes: number;

	constructor(options: { maxPayloadBytes?: number } = {}) {
		this.maxPayloadBytes = options.maxPayloadBytes ?? 16_384;
	}

	write(chunk: string | Buffer): void {
		const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next]);
		if (this.buffer.length > this.maxPayloadBytes * 2) {
			throw new Error("framing input exceeded safe size");
		}
	}

	private consumeJsonLineFrame(): McpStdioFrame | null {
		const lineBreak = this.buffer.indexOf(10);
		if (lineBreak < 0) return null;
		if (lineBreak > this.maxPayloadBytes) {
			throw new Error("JSON-line frame payload too large");
		}
		const payload = this.buffer.slice(0, lineBreak).toString("utf8").trim();
		this.buffer = this.buffer.slice(lineBreak + 1);
		return { protocol: "json-line", payload };
	}

	private parseMcpHeader(): { contentLength: number; bodyStart: number } | null {
		const lfTerminator = this.buffer.indexOf("\n\n");
		const crlfTerminator = this.buffer.indexOf("\r\n\r\n");
		const separator = crlfTerminator >= 0 ? crlfTerminator : lfTerminator;
		if (separator < 0) {
			if (this.buffer.length > this.maxPayloadBytes * 2) {
				throw new Error("Malformed MCP frame header");
			}
			return null;
		}
		const headerText = this.buffer.slice(0, separator).toString("utf8");
		const bodyStart = separator + (crlfTerminator >= 0 ? 4 : 2);
		const headerLines = headerText.split(/\r?\n/);
		let contentLength: number | undefined;
		for (const rawLine of headerLines) {
			const line = rawLine.trim();
			if (!line) continue;
			const splitAt = line.indexOf(":");
			if (splitAt < 0) continue;
			const headerName = line.slice(0, splitAt).trim().toLowerCase();
			const headerValue = line.slice(splitAt + 1).trim();
			if (headerName === MCP_HEADER_PREFIX.slice(0, -1)) {
				if (!/^\d+$/.test(headerValue)) {
					throw new Error("Malformed MCP Content-Length header");
				}
				const parsedLength = Number.parseInt(headerValue, 10);
				if (!Number.isInteger(parsedLength) || parsedLength < 0) {
					throw new Error("Malformed MCP Content-Length header");
				}
				contentLength = parsedLength;
			}
		}
		if (contentLength === undefined) {
			throw new Error("Missing MCP Content-Length header");
		}
		if (contentLength > this.maxPayloadBytes) {
			throw new Error("MCP frame payload exceeds maximum size");
		}
		return { contentLength, bodyStart };
	}

	private consumeMcpFrame(): McpStdioFrame | null {
		if (this.contentLength === undefined) {
			const header = this.parseMcpHeader();
			if (!header) return null;
			const { contentLength, bodyStart } = header;
			this.contentLength = contentLength;
			this.buffer = this.buffer.slice(bodyStart);
		}
		if (this.buffer.length < this.contentLength) return null;
		const payload = this.buffer.slice(0, this.contentLength).toString("utf8");
		this.buffer = this.buffer.slice(this.contentLength);
		this.contentLength = undefined;
		return { protocol: "mcp", payload };
	}

	private detectProtocol(): McpStdioFrame["protocol"] | undefined {
		if (this.protocol !== undefined) return this.protocol;
		const preview = this.buffer.toString("utf8", 0, Math.min(this.buffer.length, 64)).trimStart();
		if (!preview.length) return undefined;
		if (preview[0] === "{") {
			this.protocol = "json-line";
			return "json-line";
		}
		const lower = preview.toLowerCase();
		if (lower.startsWith("content-length")) {
			if (/^content-length\s*:/i.test(lower)) {
				this.protocol = "mcp";
				return "mcp";
			}
			if (lower.length < MCP_HEADER_PREFIX.length) return undefined;
			throw new Error("Malformed MCP header");
		}
		if (lower[0] === "c" && lower.length < MCP_HEADER_PREFIX.length) return undefined;
		throw new Error("Unsupported MCP stdio framing; expected Content-Length or JSON-line frame");
	}

	nextFrame(): McpStdioFrame | null {
		const protocol = this.detectProtocol();
		if (!protocol) return null;
		return protocol === "json-line" ? this.consumeJsonLineFrame() : this.consumeMcpFrame();
	}
}

import { isAbsolute, resolve } from "node:path";
import { getLatexPreambleFilePath } from "./runtime_preamble.ts";
import { writeLatexPreambleToTmpdir } from "./runtime_preamble.ts";
import { resolveTexActionsAgentRuntimeDir } from "./agent_runtime_context.ts";
import { HostServiceCompileService } from "./host_service_compile.ts";
import type { HostServiceContinuousCompileManager } from "./host_service_continuous_compile.ts";
import type {
	HostServiceCallbackTarget,
	HostServiceCloseRequest,
	HostServiceCloseResponseEnvelope,
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
const MCP_HOST_SERVICE_PROTOCOL_VERSION = 1;
const MCP_HOST_SERVICE_DAEMON_REQUEST_PREFIX = "mcp-host-service";
const MCP_DEFAULT_WORKSPACE_CONTEXT: HostServiceWorkspaceContext = { cwd: "/" };
let mcpHostServiceRequestCounter = 0;

interface HostServiceMcpPdfOperations {
	openPdf?: (request: HostServiceOpenRequest) => Promise<HostServiceOpenResponseEnvelope>;
	jumpPdf?: (request: HostServiceJumpRequest) => Promise<HostServiceJumpResponseEnvelope>;
	closePdf?: (request: HostServiceCloseRequest) => Promise<HostServiceCloseResponseEnvelope>;
	resolveManagedOpenCallback?: (
		workspaceContext: HostServiceWorkspaceContext,
		callbackTargetId: string | undefined,
		callbackTarget: HostServiceCallbackTarget | undefined,
	) => Promise<HostServiceCallbackTarget | undefined>;
	continuousCompileManager?: HostServiceContinuousCompileManager;
	refreshSessionLease?: (workspaceContext: HostServiceWorkspaceContext) => void | Promise<void>;
}

function createMcpCompileService(pdfOperations: HostServiceMcpPdfOperations): HostServiceCompileService {
	return new HostServiceCompileService({
		protocolVersion: MCP_HOST_SERVICE_PROTOCOL_VERSION,
		managedViewerService: {
			async openViewer(openRequest) {
				if (!pdfOperations.openPdf) {
					throw new Error("open_pdf is not implemented by the daemon");
				}
				return pdfOperations.openPdf(openRequest);
			},
		},
		resolveManagedOpenCallback: async (workspaceContext, callbackTargetId, callbackTarget) =>
			pdfOperations.resolveManagedOpenCallback
				? pdfOperations.resolveManagedOpenCallback(workspaceContext, callbackTargetId, callbackTarget)
				: callbackTarget,
		refreshContinuousSessionLease: (workspaceContext) => {
			void pdfOperations.refreshSessionLease?.(workspaceContext);
		},
		continuousCompileManager: pdfOperations.continuousCompileManager,
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

function nextHostServiceRequestId(): string {
	mcpHostServiceRequestCounter += 1;
	return `${MCP_HOST_SERVICE_DAEMON_REQUEST_PREFIX}-${mcpHostServiceRequestCounter}`;
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
	const source = parseStringArg(args, "source");
	const compiler = parseOptionalStringArg(args, "compiler");
	const inline = parseBooleanArg(args, "inline");
	const openPdf = inline === false ? true : parseBooleanArg(args, "open_pdf");
	if (args.fixed_preview_pdf_path !== undefined) {
		throw new Error("fixed_preview_pdf_path is not supported; use fixed_preview");
	}
	const fixedPreview = openPdf ? (inline === false ? true : parseBooleanArg(args, "fixed_preview")) : undefined;
	const reuseExisting = openPdf ? parseBooleanArg(args, "reuse_existing") : undefined;
	const requirePersistentViewer = openPdf ? parseBooleanArg(args, "require_persistent_viewer") : undefined;
	const callback = openPdf ? parseCallbackTargetArg(args) : undefined;
	const rawWorkspaceContext = args.workspace_context;
	const workspaceContext = rawWorkspaceContext === undefined
		? { cwd: MCP_DEFAULT_WORKSPACE_CONTEXT.cwd }
		: normalizeWorkspaceContext(rawWorkspaceContext);
	if (rawWorkspaceContext !== undefined && !isAbsolute(workspaceContext.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for show_latex");
	}
	return {
		protocol_version: MCP_HOST_SERVICE_PROTOCOL_VERSION,
		request_id: nextHostServiceRequestId(),
		operation: "compile_latex_snippet",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: workspaceContext,
		details: {
			latex_source: source,
			...(compiler === undefined ? {} : { compiler }),
			...(openPdf === true ? { open_pdf: true } : {}),
			...(openPdf === true
				? {
					...(fixedPreview === undefined ? {} : { fixed_preview: fixedPreview }),
					reuse_existing: reuseExisting,
					require_persistent_viewer: requirePersistentViewer,
					...(callback === undefined ? {} : { callback }),
				}
				: {}),
		},
	};
}

function parseCallbackTargetArg(args: Record<string, unknown>): HostServiceCallbackTarget | undefined {
	const rawCallback = args.callback;
	if (rawCallback === undefined) {
		return;
	}
	if (!isRecord(rawCallback)) {
		throw new Error("callback must be an object");
	}
	if (typeof rawCallback.kind !== "string" || !rawCallback.kind.trim()) {
		throw new Error("callback.kind must be a non-empty string");
	}
	if (typeof rawCallback.transport !== "string" || !rawCallback.transport.trim()) {
		throw new Error("callback.transport must be a non-empty string");
	}
	if (typeof rawCallback.socket_path !== "string" || !rawCallback.socket_path.trim()) {
		throw new Error("callback.socket_path must be a non-empty string");
	}
	if (typeof rawCallback.token !== "string" || !rawCallback.token.trim()) {
		throw new Error("callback.token must be a non-empty string");
	}
	const kind = rawCallback.kind;
	const transport = rawCallback.transport;
	if (kind !== "pi-synctex-callback-v1") {
		throw new Error("callback.kind must be pi-synctex-callback-v1");
	}
	if (transport !== "unix") {
		throw new Error("callback.transport must be unix");
	}
	return {
		kind,
		transport,
		socket_path: rawCallback.socket_path,
		token: rawCallback.token,
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

function parseCompileLatexFileRequest(args: Record<string, unknown>): HostServiceCompileRequest {
	const latexFilePath = parseStringArg(args, "latex_file_path");
	const compiler = parseOptionalStringArg(args, "compiler");
	const clean = parseBooleanArg(args, "clean");
	const openPdf = parseBooleanArg(args, "open_pdf");
	const continuous = parseBooleanArg(args, "continuous");
	const callback = openPdf ? parseCallbackTargetArg(args) : undefined;
	const callbackTargetId = openPdf ? parseOptionalStringArg(args, "callback_target_id") : undefined;
	const reuseExisting = openPdf ? parseBooleanArg(args, "reuse_existing") : undefined;
	const requirePersistentViewer = openPdf ? parseBooleanArg(args, "require_persistent_viewer") : undefined;
	const workspaceContext = parseCompileWorkspaceContext(latexFilePath, args.workspace_context);
	if (continuous !== undefined && !workspaceContext.session_id?.trim()) {
		throw new Error("workspace_context.session_id is required for continuous compilation");
	}
	return {
		protocol_version: MCP_HOST_SERVICE_PROTOCOL_VERSION,
		request_id: nextHostServiceRequestId(),
		operation: "compile_latex_file",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: workspaceContext,
		details: {
			latex_file_path: latexFilePath,
			...(compiler === undefined ? {} : { compiler }),
			...(clean === undefined ? {} : { clean }),
			...(openPdf === undefined ? {} : { open_pdf: openPdf }),
			...(continuous === undefined ? {} : { continuous }),
			...(callback === undefined ? {} : { callback }),
			...(callbackTargetId === undefined ? {} : { callback_target_id: callbackTargetId }),
			...(reuseExisting === undefined ? {} : { reuse_existing: reuseExisting }),
			...(requirePersistentViewer === undefined ? {} : { require_persistent_viewer: requirePersistentViewer }),
		},
	};
}

function parseOpenPdfRequest(args: Record<string, unknown>): HostServiceOpenRequest {
	const pdfPath = parseOptionalStringArg(args, "pdf_file_path")
		?? parseOptionalStringArg(args, "pdf_path");
	if (pdfPath === undefined) {
		throw new Error("pdf_file_path must be a non-empty string");
	}
	const rawWorkspaceContext = args.workspace_context;
	const workspaceContext = parseOpenWorkspaceContext(pdfPath, rawWorkspaceContext);
	const resolvedPdfPath = isAbsolute(pdfPath) ? pdfPath : resolve(workspaceContext.cwd, pdfPath);
	const callback = parseCallbackTargetArg(args);
	const reuseExisting = parseBooleanArg(args, "reuse_existing");
	const requirePersistentViewer = parseBooleanArg(args, "require_persistent_viewer");
	return {
		protocol_version: MCP_HOST_SERVICE_PROTOCOL_VERSION,
		request_id: nextHostServiceRequestId(),
		operation: "open_pdf",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: workspaceContext,
		details: {
			pdf_path: resolvedPdfPath,
			...(callback === undefined ? {} : { callback }),
			...(reuseExisting === undefined ? {} : { reuse_existing: reuseExisting }),
			...(requirePersistentViewer === undefined ? {} : { require_persistent_viewer: requirePersistentViewer }),
		},
	};
}

function parseJumpPdfRequest(args: Record<string, unknown>): HostServiceJumpRequest {
	const pdfId = parsePositiveIntegerArg(args, "pdf_id");
	const line = parsePositiveIntegerArg(args, "line");
	const sourceFile = parseOptionalStringArg(args, "source_file");
	const workspaceContext = parseJumpWorkspaceContext(args.workspace_context, sourceFile);
	const resolvedSourceFile = sourceFile === undefined
		? undefined
		: isAbsolute(sourceFile) ? sourceFile : resolve(workspaceContext.cwd, sourceFile);
	return {
		protocol_version: MCP_HOST_SERVICE_PROTOCOL_VERSION,
		request_id: nextHostServiceRequestId(),
		operation: "jump_pdf",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: workspaceContext,
		pdf_id: pdfId,
		line,
		...(resolvedSourceFile === undefined ? {} : { source_file: resolvedSourceFile }),
	};
}
function parseClosePdfRequest(args: Record<string, unknown>): HostServiceCloseRequest {
	const pdfId = parsePositiveIntegerArg(args, "pdf_id");
	return {
		protocol_version: MCP_HOST_SERVICE_PROTOCOL_VERSION,
		request_id: nextHostServiceRequestId(),
		operation: "close_pdf",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: MCP_DEFAULT_WORKSPACE_CONTEXT,
		pdf_id: pdfId,
	};
}

function formatContinuousSummary(details: unknown): string {
	if (!isRecord(details) || !isRecord(details.continuous)) return "";
	const continuous = details.continuous;
	const status = typeof continuous.status === "string" ? continuous.status : "unknown";
	const subscribers = typeof continuous.subscriber_count === "number" ? continuous.subscriber_count : "unknown";
	const pid = typeof continuous.pid === "number" ? ` pid=${continuous.pid}` : "";
	const root = typeof continuous.root_source === "string" ? ` root=${continuous.root_source}` : "";
	const error = typeof continuous.error === "string" ? ` error=${continuous.error}` : "";
	return `\nContinuous: ${status} subscribers=${subscribers}${pid}${root}${error}`;
}

function formatDiagnosticSummary(details: { warnings?: unknown; warning_count?: unknown; warnings_truncated?: unknown }): string {
	if (typeof details.warning_count !== "number" || details.warning_count <= 0 || !Array.isArray(details.warnings)) return "";
	const lines = details.warnings
		.slice(0, 5)
		.map((warning) => isRecord(warning) && typeof warning.message === "string" ? `- ${warning.message}` : "")
		.filter((line) => line.length > 0);
	if (!lines.length) return "";
	return `\nWarnings:\n${lines.join("\n")}${details.warnings_truncated === true ? "\n- ... more warnings omitted" : ""}`;
}

function parseToolResult(
	response: HostServiceCompileResponseEnvelope | HostServiceCompileSnippetResponseEnvelope,
	successText: string,
): McpToolResult {
	const details = response.status_details;
	if (response.status === "ok") {
		const status = details.compile_status ?? (successText.replace(/:$/, "") || "ok");
		const pdfId = details.pdf_id === undefined ? "" : ` pdf_id=${details.pdf_id}`;
		const pdf = details.pdf ? ` pdf=${details.pdf}` : "";
		const compileOnlyPdf = !pdfId && details.pdf ? ` ${details.pdf}` : "";
		const warningCount = details.warning_count ? ` warnings=${details.warning_count}` : "";
		const exitCode = details.compile_status === "nonzero_but_pdf_updated" ? ` exit_code=${details.compiler_exit_code ?? "unknown"}` : "";
		const log = details.log ? `\nLog: ${details.log}` : "";
		return {
			content: [{ type: "text", text: `${status}:${pdfId}${pdfId ? pdf : compileOnlyPdf}${exitCode}${warningCount}${log}${formatContinuousSummary(details)}${formatDiagnosticSummary(details)}`.trim() }],
			details,
		};
	}
	const errorCode = typeof details.error_code === "string" ? ` (code=${details.error_code})` : "";
	const summary = typeof details.error_summary === "string" && details.error_summary ? `\n${details.error_summary}` : "";
	const log = details.log ? `\nLog: ${details.log}` : "";
	return {
		isError: true,
		content: [{ type: "text", text: `${response.error || "compile failed"}${errorCode}${summary}${log}` }],
		details,
	};
}

function parseManagedPdfToolResult(
	response: HostServiceOpenResponseEnvelope | HostServiceJumpResponseEnvelope | HostServiceCloseResponseEnvelope,
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
		const pdf =
			typeof details.pdf === "string" && details.pdf
				? ` pdf=${details.pdf}`
				: "";
		const pdfId =
			typeof details.pdf_id === "number" && details.pdf_id > 0
				? ` pdf_id=${details.pdf_id}`
				: "";
		const handled =
				typeof details.handled === "boolean" && details.handled
					? " handled"
					: "";
		const closed =
				typeof details.closed === "boolean" && details.closed
					? " closed"
					: "";
		return {
			content: [{
				type: "text",
				text: (`${successPrefix}${pdf}${pdfId}${line}${handled}${closed}`.trim() || successPrefix) + sourceLine,
			}],
			details,
		};
	}
	const errorCode = typeof details.error_code === "string" ? ` (code=${details.error_code})` : "";
	return {
		isError: true,
		content: [{ type: "text", text: `${response.error || "operation failed"}${errorCode}` }],
		details,
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

function mcpPreamblePath(runtimeDirectory?: string): string {
	return getLatexPreambleFilePath(runtimeDirectory);
}

function resolveSetPreambleRuntimeDirectory(rawWorkspaceContext: unknown): string | undefined {
	if (rawWorkspaceContext === undefined) {
		return undefined;
	}
	const workspaceContext = normalizeWorkspaceContext(rawWorkspaceContext);
	if (workspaceContext.workspace_root === undefined) {
		throw new Error("set_latex_preamble workspace_context requires workspace_root");
	}
	if (workspaceContext.session_id === undefined) {
		throw new Error("set_latex_preamble workspace_context requires session_id");
	}
	const expectedRuntimeDirectory = resolveTexActionsAgentRuntimeDir(workspaceContext.session_id);
	if (resolve(workspaceContext.workspace_root) !== expectedRuntimeDirectory) {
		throw new Error("set_latex_preamble workspace_context.workspace_root must match the agent runtime directory");
	}
	return expectedRuntimeDirectory;
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

function mcpToolDescriptions(): readonly McpToolDefinition[] {
	return [
		{
			name: "show_latex",
			description: "Render a LaTeX snippet and optionally open a tracked PDF preview.",
			inputSchema: {
				type: "object",
				properties: {
					source: { type: "string", minLength: 1 },
					compiler: { type: "string" },
					inline: { type: "boolean" },
					open_pdf: { type: "boolean" },
					fixed_preview: { type: "boolean" },
					reuse_existing: { type: "boolean" },
					require_persistent_viewer: { type: "boolean" },
					callback: {
						type: "object",
						properties: {
							kind: { type: "string", const: "pi-synctex-callback-v1" },
							transport: { type: "string", const: "unix" },
							socket_path: { type: "string", minLength: 1 },
							token: { type: "string", minLength: 1 },
						},
						required: ["kind", "transport", "socket_path", "token"],
						additionalProperties: false,
					},
					workspace_context: workspaceContextSchema(),
				},
				required: ["source"],
				additionalProperties: false,
			},
		},
		{
			name: "compile_latex_file",
			description: "Compile a LaTeX source file with latexmk and optionally register a host-service PDF. The compiler option selects the TeX engine latexmk should run. Set continuous=true to compile once and subscribe this session to shared latexmk -pvc background recompilation; set continuous=false to compile once and unsubscribe this session; omitting continuous performs a latexmk-backed one-shot compile and leaves existing continuous state unchanged. Use continuous=false, not close_pdf, to stop continuous compilation because close_pdf does not stop continuous compilation.",
			inputSchema: {
				type: "object",
				properties: {
					latex_file_path: { type: "string", minLength: 1 },
					compiler: { type: "string" },
					clean: { type: "boolean" },
					open_pdf: { type: "boolean" },
					continuous: { type: "boolean", description: "When true, immediately compile with latexmk using the selected engine, then subscribe this session to one shared host-service latexmk -pvc compiler for the normalized root file. latexmk runs with -norc, -view=none, recorder/SyncTeX-friendly flags, selected-engine configuration, and -no-shell-escape engine commands so project latexmkrc files cannot override the default commands; this provides no latexmk-owned viewer launch. When false, immediately compile then unsubscribe this session, stopping the compiler only when no other sessions remain. Omit for a latexmk-backed one-shot compile that leaves continuous compilation unchanged." },
					callback_target_id: { type: "string", minLength: 1 },
					callback: {
						type: "object",
						properties: {
							kind: { type: "string", const: "pi-synctex-callback-v1" },
							transport: { type: "string", const: "unix" },
							socket_path: { type: "string", minLength: 1 },
							token: { type: "string", minLength: 1 },
						},
						required: ["kind", "transport", "socket_path", "token"],
						additionalProperties: false,
					},
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
			description: "Open a PDF through the host-service viewer and return a daemon-owned PDF id.",
			inputSchema: {
				type: "object",
				properties: {
					pdf_file_path: { type: "string", minLength: 1 },
					callback: {
						type: "object",
						properties: {
							kind: { type: "string", const: "pi-synctex-callback-v1" },
							transport: { type: "string", const: "unix" },
							socket_path: { type: "string", minLength: 1 },
							token: { type: "string", minLength: 1 },
						},
						required: ["kind", "transport", "socket_path", "token"],
						additionalProperties: false,
					},
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
			description: "Jump a tracked PDF to a source line via forward SyncTeX.",
			inputSchema: {
				type: "object",
				properties: {
					pdf_id: { type: "number", minimum: 1 },
					line: { type: "number", minimum: 1 },
					source_file: { type: "string", minLength: 1 },
					workspace_context: workspaceContextSchema(),
				},
				required: ["pdf_id", "line"],
				additionalProperties: false,
			},
		},
		{
			name: "close_pdf",
			description: "Close a tracked PDF by id. This only affects viewer lifecycle; it does not stop continuous compilation. Use compile_latex_file with continuous=false for the root source to stop a continuous subscription.",
			inputSchema: {
				type: "object",
				properties: {
					pdf_id: { type: "number", minimum: 1 },
				},
				required: ["pdf_id"],
				additionalProperties: false,
			},
		},
		{
			name: "set_latex_preamble",
			description: "Set the active LaTeX preview preamble in the provided workspace runtime, or the daemon runtime for legacy callers.",
			inputSchema: {
				type: "object",
				properties: {
					latex_preamble: { type: "string" },
					workspace_context: workspaceContextSchema(),
				},
				required: ["latex_preamble"],
				additionalProperties: false,
			},
		},
	];
}

export const HOST_SERVICE_TOOL_NAMES = [
	"show_latex",
	"compile_latex_file",
	"open_pdf",
	"jump_pdf",
	"close_pdf",
	"set_latex_preamble",
] as const;

type HostServiceToolName = (typeof HOST_SERVICE_TOOL_NAMES)[number];

type HostServiceMcpToolHandler = (
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	pdfOperations: HostServiceMcpPdfOperations,
	mcpCompileService: HostServiceCompileService,
) => Promise<McpResponsePayload>;

async function handleShowLatexTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	_pdfOperations: HostServiceMcpPdfOperations,
	mcpCompileService: HostServiceCompileService,
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
		return buildSuccess(requestId, parseToolResult(compileResponse, "ok"));
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
): Promise<McpResponsePayload> {
	let compileRequest: HostServiceCompileRequest;
	try {
		compileRequest = parseCompileLatexFileRequest(args);
	} catch (error) {
		return buildMcpErrorResponse(
			requestId,
			MCP_ERROR_INVALID_PARAMS,
			error instanceof Error ? error.message : String(error),
		);
	}
	try {
		if (compileRequest.details.continuous !== undefined) {
			await pdfOperations.refreshSessionLease?.(compileRequest.workspace_context);
		}
		const compileResponse = await mcpCompileService.compileLatexFileRequest(compileRequest);
		return buildSuccess(requestId, parseToolResult(compileResponse, "ok:"));
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
			content: [{ type: "text", text: "open_pdf is not yet implemented by the daemon" }],
		});
	}
	try {
		const openResponse = await pdfOperations.openPdf(openRequest);
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
			content: [{ type: "text", text: "jump_pdf is not yet implemented by the daemon" }],
		});
	}
	try {
		const jumpResponse = await pdfOperations.jumpPdf(jumpRequest);
		return buildSuccess(requestId, parseManagedPdfToolResult(jumpResponse, "jump_pdf ok:"));
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: `jump_pdf failed: ${details}` }],
		});
	}
}

async function handleClosePdfTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	pdfOperations: HostServiceMcpPdfOperations,
	_mcpCompileService: HostServiceCompileService,
): Promise<McpResponsePayload> {
	let closeRequest: HostServiceCloseRequest;
	try {
		closeRequest = parseClosePdfRequest(args);
	} catch (error) {
		return buildMcpErrorResponse(
			requestId,
			MCP_ERROR_INVALID_PARAMS,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (!pdfOperations.closePdf) {
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: "close_pdf is not yet implemented by the daemon" }],
		});
	}
	try {
		const closeResponse = await pdfOperations.closePdf(closeRequest);
		return buildSuccess(requestId, parseManagedPdfToolResult(closeResponse, "close_pdf ok:"));
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: `close_pdf failed: ${details}` }],
		});
	}
}

async function handleSetLatexPreambleTool(
	requestId: ParsedMcpRequestId,
	args: Record<string, unknown>,
	_pdfOperations: HostServiceMcpPdfOperations,
	_mcpCompileService: HostServiceCompileService,
): Promise<McpResponsePayload> {
	const preamble = args.latex_preamble;
	if (typeof preamble !== "string") {
		return buildMcpErrorResponse(requestId, MCP_ERROR_INVALID_PARAMS, "set_latex_preamble requires latex_preamble to be a string");
	}
	let runtimeDirectory: string | undefined;
	try {
		runtimeDirectory = resolveSetPreambleRuntimeDirectory(args.workspace_context);
	} catch (error) {
		return buildMcpErrorResponse(requestId, MCP_ERROR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
	}
	try {
		const preambleLength = writeLatexPreambleToTmpdir(
			preamble,
			runtimeDirectory === undefined ? {} : { runtimeDirectory },
		);
		const preamblePath = mcpPreamblePath(runtimeDirectory);
		const resultText = preambleLength
			? `LaTeX preamble set (${preambleLength} characters) at ${preamblePath}`
			: `LaTeX preamble cleared at ${preamblePath}`;
		const toolResult: McpToolResult = {
			content: [{ type: "text", text: resultText }],
		};
		return buildSuccess(requestId, toolResult);
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		return buildSuccess(requestId, {
			isError: true,
			content: [{ type: "text", text: `set_latex_preamble failed: ${details}` }],
		});
	}
}

export function mcpFramedResponse(payload: McpResponsePayload): string {
	return encodeResponse(payload);
}

export async function handleMcpRequest(
	rawPayload: string,
	pdfOperations: HostServiceMcpPdfOperations = {},
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
				tools: mcpToolDescriptions(),
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

			if (!HOST_SERVICE_TOOL_NAMES.includes(call.name as typeof HOST_SERVICE_TOOL_NAMES[number])) {
				return buildSuccess(request.id, {
					isError: true,
					content: [{ type: "text", text: `Tool not implemented by daemon: ${call.name}` }],
				});
			}

			const mcpCompileService = createMcpCompileService(pdfOperations);
			const toolHandlers: Record<HostServiceToolName, HostServiceMcpToolHandler> = {
				show_latex: handleShowLatexTool,
				compile_latex_file: handleCompileLatexFileTool,
				open_pdf: handleOpenPdfTool,
				jump_pdf: handleJumpPdfTool,
				close_pdf: handleClosePdfTool,
				set_latex_preamble: handleSetLatexPreambleTool,
			};
			const handler = toolHandlers[call.name as HostServiceToolName] ?? null;
			if (handler === null) {
				return buildSuccess(request.id, {
					isError: true,
					content: [{ type: "text", text: `${call.name} is not yet implemented by the daemon` }],
				});
			}

			return await handler(request.id, call.args, pdfOperations, mcpCompileService);
		}
		default:
			return buildMcpErrorResponse(request.id, MCP_ERROR_METHOD_NOT_FOUND, `method not found: ${request.method}`);
	}
}

export async function handleFramedMcpRequest(
	rawPayload: string,
	pdfOperations?: HostServiceMcpPdfOperations,
): Promise<string | null> {
	const response = await handleMcpRequest(rawPayload, pdfOperations);
	if (response === null) {
		return null;
	}
	return mcpFramedResponse(response);
}

export interface HostServiceDaemonFrame {
	protocol: "host-service" | "mcp";
	payload: string;
}

const MCP_HEADER_PREFIX = "content-length:";

export class HostServiceMcpFrameReader {
	private buffer: Buffer = Buffer.alloc(0);
	private protocol: "host-service" | "mcp" | undefined;
	private contentLength: number | undefined;
	private readonly maxPayloadBytes: number;

	get detectedProtocol(): "host-service" | "mcp" | undefined {
		return this.protocol;
	}

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

	private consumeHostServiceFrame(): HostServiceDaemonFrame | null {
		const lineBreak = this.buffer.indexOf(10);
		if (lineBreak < 0) {
			return null;
		}
		if (lineBreak > this.maxPayloadBytes) {
			throw new Error("host-service request payload too large");
		}
		const payload = this.buffer.slice(0, lineBreak).toString("utf8").trim();
		this.buffer = this.buffer.slice(lineBreak + 1);
		return { protocol: "host-service", payload };
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
			if (!line) {
				continue;
			}
			const splitAt = line.indexOf(":");
			if (splitAt < 0) {
				continue;
			}
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

	private consumeMcpFrame(): HostServiceDaemonFrame | null {
		if (this.contentLength === undefined) {
			const header = this.parseMcpHeader();
			if (!header) {
				return null;
			}
			const { contentLength, bodyStart } = header;
			this.contentLength = contentLength;
			this.buffer = this.buffer.slice(bodyStart);
		}
		if (this.buffer.length < this.contentLength) {
			return null;
		}
		const payload = this.buffer.slice(0, this.contentLength).toString("utf8");
		this.buffer = this.buffer.slice(this.contentLength);
		this.contentLength = undefined;
		return { protocol: "mcp", payload };
	}

	private detectProtocol(): "host-service" | "mcp" | undefined {
		if (this.protocol !== undefined) {
			return this.protocol;
		}
		const preview = this.buffer.toString("utf8", 0, Math.min(this.buffer.length, 64)).trimStart();
		if (!preview.length) {
			return undefined;
		}
		if (preview[0] === "{") {
			this.protocol = "host-service";
			return "host-service";
		}
		const lower = preview.toLowerCase();
		if (lower.startsWith("content-length")) {
			if (/^content-length\s*:/i.test(lower)) {
				this.protocol = "mcp";
				return "mcp";
			}
			if (lower.length < MCP_HEADER_PREFIX.length) {
				return undefined;
			}
			throw new Error("Malformed MCP header");
		}
		if (lower[0] === "c" && lower.length < MCP_HEADER_PREFIX.length) {
			return undefined;
		}
		this.protocol = "host-service";
		return "host-service";
	}

	nextFrame(): HostServiceDaemonFrame | null {
		const protocol = this.detectProtocol();
		if (!protocol) {
			return null;
		}
		if (protocol === "host-service") {
			return this.consumeHostServiceFrame();
		}
		return this.consumeMcpFrame();
	}
}

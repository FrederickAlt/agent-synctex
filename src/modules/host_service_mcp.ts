import { getLatexPreambleFilePath } from "./runtime_preamble.ts";
import { writeLatexPreambleToTmpdir } from "./runtime_preamble.ts";

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

function mcpPreamblePath(): string {
	return getLatexPreambleFilePath();
}

function mcpToolDescriptions(): readonly McpToolDefinition[] {
	return [
		{
			name: "show_latex",
			description: "Render a LaTeX snippet and optionally open a tracked PDF preview.",
			inputSchema: { type: "object", additionalProperties: true },
		},
		{
			name: "compile_latex_file",
			description: "Compile a LaTeX source file and optionally register a host-service PDF.",
			inputSchema: { type: "object", additionalProperties: true },
		},
		{
			name: "open_pdf",
			description: "Open an existing PDF for host-service tracking and interaction.",
			inputSchema: { type: "object", additionalProperties: true },
		},
		{
			name: "jump_pdf",
			description: "Jump a tracked PDF to a source line via forward SyncTeX.",
			inputSchema: { type: "object", additionalProperties: true },
		},
		{
			name: "close_pdf",
			description: "Close a tracked PDF by id.",
			inputSchema: { type: "object", additionalProperties: true },
		},
		{
			name: "set_latex_preamble",
			description: "Set the active LaTeX preview preamble in the daemon runtime.",
			inputSchema: {
				type: "object",
				properties: {
					latex_preamble: { type: "string" },
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

export function mcpFramedResponse(payload: McpResponsePayload): string {
	return encodeResponse(payload);
}

export function handleMcpRequest(rawPayload: string): McpResponsePayload | null {
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
		case "initialize": {
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
		}
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
				const toolResult: McpToolResult = {
					isError: true,
					content: [{ type: "text", text: `Tool not implemented by daemon: ${call.name}` }],
				};
				return buildSuccess(request.id, { ...toolResult });
			}
			if (call.name !== "set_latex_preamble") {
				const toolResult: McpToolResult = {
					isError: true,
					content: [{ type: "text", text: `${call.name} is not yet implemented by the daemon` }],
				};
				return buildSuccess(request.id, { ...toolResult });
			}
			try {
				const preamble = call.args.latex_preamble;
				if (typeof preamble !== "string") {
					return buildMcpErrorResponse(request.id, MCP_ERROR_INVALID_PARAMS, "set_latex_preamble requires latex_preamble to be a string");
				}
				const preambleLength = writeLatexPreambleToTmpdir(preamble);
				const preamblePath = mcpPreamblePath();
				const resultText = preambleLength
					? `LaTeX preamble set (${preambleLength} characters) at ${preamblePath}`
					: `LaTeX preamble cleared at ${preamblePath}`;
				const toolResult: McpToolResult = {
					content: [{ type: "text", text: resultText }],
				};
				return buildSuccess(request.id, toolResult);
			} catch (error) {
				const details = error instanceof Error ? error.message : String(error);
				return buildSuccess(request.id, {
					isError: true,
					content: [{ type: "text", text: `set_latex_preamble failed: ${details}` }],
				});
			}
		}
		default:
			return buildMcpErrorResponse(request.id, MCP_ERROR_METHOD_NOT_FOUND, `method not found: ${request.method}`);
	}
}

export function handleFramedMcpRequest(rawPayload: string): string | null {
	const response = handleMcpRequest(rawPayload);
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

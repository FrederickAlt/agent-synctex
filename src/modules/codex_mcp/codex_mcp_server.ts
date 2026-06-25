import { createConnection } from "node:net";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
	MCP_ERROR_INTERNAL,
	MCP_ERROR_PARSE_ERROR,
	type McpRequestId,
	HostServiceMcpFrameReader,
	buildMcpErrorResponse,
} from "../host_service_mcp.ts";
import { resolveAgentWorkspaceContext } from "../agent_runtime_context.ts";
import { HostServiceClient, resolveHostServiceSocketPath } from "../host_service.ts";
import { initializeLatexPreambleFile } from "../pi_extension/latex_preamble_manager.ts";
import {
	asError,
	frameClientPayload,
	frameMcpPayload,
	isRecord,
	type McpClientFrameProtocol,
	McpStdioFrameLoop,
	omitToolInputSchemaProperties,
	requestMetadata,
	writeStreamPayload,
} from "../mcp_stdio_transport.ts";

export interface CodexMcpDaemonRelayOptions {
	socketPath?: string;
	stdin?: Readable;
	stdout?: Writable;
	stderr?: Writable;
	requestTimeoutMs?: number;
	maxPayloadBytes?: number;
	heartbeatIntervalMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_FRAME_SIZE_BYTES = 16_384;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
type ClientFrameProtocol = McpClientFrameProtocol;

function hideInternalArgumentsFromTool(tool: unknown): unknown {
	const omitted = ["workspace_context"];
	if (isRecord(tool) && tool.name === "show_latex") {
		omitted.push("inline");
	}
	return omitToolInputSchemaProperties(tool, omitted);
}

function rewriteToolsListForCodex(response: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(response.result) || !Array.isArray(response.result.tools)) {
		return response;
	}
	return {
		...response,
		result: {
			...response.result,
			tools: response.result.tools.map(hideInternalArgumentsFromTool),
		},
	};
}

const WORKSPACE_CONTEXT_TOOL_NAMES = new Set([
	"show_latex",
	"compile_latex_file",
	"open_pdf",
	"jump_pdf",
	"set_latex_preamble",
]);

function rewriteToolCallArgumentsForCodex(request: Record<string, unknown>): Record<string, unknown> {
	if (request.method !== "tools/call" || !isRecord(request.params) || typeof request.params.name !== "string") {
		return request;
	}
	if (!WORKSPACE_CONTEXT_TOOL_NAMES.has(request.params.name)) {
		return request;
	}
	const currentArguments = isRecord(request.params.arguments) ? request.params.arguments : {};
	const workspaceContext = resolveAgentWorkspaceContext();
	initializeLatexPreambleFile({
		cwd: workspaceContext.cwd,
		runtimeDirectory: workspaceContext.workspace_root,
		overwrite: false,
	});
	return {
		...request,
		params: {
			...request.params,
			arguments: {
				...currentArguments,
				...(request.params.name === "show_latex" ? { inline: false } : {}),
				workspace_context: workspaceContext,
			},
		},
	};
}

function rewriteClientRequestForCodex(payload: string): string {
	try {
		const parsed = JSON.parse(payload);
		if (!isRecord(parsed)) {
			return payload;
		}
		const rewritten = rewriteToolCallArgumentsForCodex(parsed);
		return rewritten === parsed ? payload : JSON.stringify(rewritten);
	} catch {
		return payload;
	}
}

function rewriteDaemonResponseForCodex(payload: string): string {
	try {
		const parsed = JSON.parse(payload);
		if (!isRecord(parsed)) {
			return payload;
		}
		const rewritten = rewriteToolsListForCodex(parsed);
		return rewritten === parsed ? payload : JSON.stringify(rewritten);
	} catch {
		return payload;
	}
}

function daemonUnavailableMessage(socketPath: string): string {
	return [
		`TeX Actions daemon is unavailable at ${socketPath}.`,
		"Restart with `pdf-preview-servicectl restart`.",
		"Then run `npm run tex-actionsctl -- doctor` or `tex-actionsctl doctor`.",
	].join(" ");
}

function systemInfoNotificationPayload(message: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		method: "notifications/message",
		params: {
			level: "info",
			logger: "tex-actions",
			data: message,
		},
	});
}

function isUnsupportedPendingNotificationsError(error: unknown): boolean {
	const message = asError(error).message;
	return /unsupported operation: get_pending_notifications/.test(message)
		|| /Malformed host service get_pending_notifications response payload/.test(message);
}

export class CodexMcpDaemonRelay {
	readonly socketPath: string;
	private readonly stdout: Writable;
	private readonly stderr: Writable;
	private readonly requestTimeoutMs: number;
	private readonly maxPayloadBytes: number;
	private readonly heartbeatIntervalMs: number;
	private readonly frameLoop: McpStdioFrameLoop;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	constructor(options: CodexMcpDaemonRelayOptions = {}) {
		this.socketPath = options.socketPath ?? resolveHostServiceSocketPath();
		this.stdout = options.stdout ?? processStdout;
		this.stderr = options.stderr ?? processStderr;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_FRAME_SIZE_BYTES;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.frameLoop = new McpStdioFrameLoop({
			stdin: options.stdin ?? processStdin,
			stderr: this.stderr,
			maxPayloadBytes: this.maxPayloadBytes,
			onFrame: this.handleFrame,
			onParseError: (error) => this.sendErrorFrame(null, MCP_ERROR_PARSE_ERROR, error.message).catch(() => undefined),
			onDiagnostic: this.writeDiagnostic,
		});
	}

	start(): void {
		if (this.closed) {
			return;
		}
		this.frameLoop.start();
		this.startHeartbeat();
	}

	readonly close = (): void => {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.frameLoop.close();
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	};

	private startHeartbeat(): void {
		if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimer) {
			return;
		}
		void this.sendHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			void this.sendHeartbeat();
		}, this.heartbeatIntervalMs);
		this.heartbeatTimer.unref?.();
	}

	private async sendHeartbeat(): Promise<void> {
		const workspaceContext = resolveAgentWorkspaceContext();
		const client = new HostServiceClient({ socketPath: this.socketPath, requestTimeoutMs: this.requestTimeoutMs });
		await client.requestSessionHeartbeat(workspaceContext).catch(() => undefined);
	}

	private readonly handleFrame = async (frame: { protocol: ClientFrameProtocol; payload: string }): Promise<void> => {
		const { requestId, expectsResponse } = requestMetadata(frame.payload);
		try {
			await this.flushPendingSystemInfo(frame.protocol);
			await this.forwardToDaemon(frame.payload, expectsResponse, frame.protocol);
		} catch (error) {
			if (!expectsResponse) {
				return;
			}
			await this.sendErrorFrame(
				requestId,
				MCP_ERROR_INTERNAL,
				`${daemonUnavailableMessage(this.socketPath)} ${asError(error).message}`,
				frame.protocol,
			);
		}
	};

	private async flushPendingSystemInfo(clientProtocol: ClientFrameProtocol): Promise<void> {
		const workspaceContext = resolveAgentWorkspaceContext();
		const client = new HostServiceClient({ socketPath: this.socketPath, requestTimeoutMs: this.requestTimeoutMs });
		try {
			const pending = await client.requestPendingNotifications(workspaceContext);
			for (const notification of pending.notifications) {
				await this.writeOutput(frameClientPayload(systemInfoNotificationPayload(notification.message), clientProtocol));
			}
		} catch (error) {
			if (!isUnsupportedPendingNotificationsError(error)) {
				this.writeDiagnostic(`Pending TeX Actions system-info retrieval failed: ${asError(error).message}`);
			}
		}
	}

	private async forwardToDaemon(payload: string, expectsResponse: boolean, clientProtocol: ClientFrameProtocol): Promise<void> {
		const daemonPayload = rewriteClientRequestForCodex(payload);
		const framed = frameMcpPayload(daemonPayload);
		if (!expectsResponse) {
			await this.writeNotification(framed);
			return;
		}
		await this.writeRequestAndReadResponse(framed, clientProtocol);
	}

	private async writeRequestAndReadResponse(framedRequest: string, clientProtocol: ClientFrameProtocol): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection({ path: this.socketPath });
			const responseReader = new HostServiceMcpFrameReader({ maxPayloadBytes: this.maxPayloadBytes });
			socket.setEncoding("utf8");

			let settled = false;
			let sawFrame = false;
			const finalize = (error?: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) {
					reject(error);
					return;
				}
				resolve();
			};

			const timer = setTimeout(() => {
				finalize(new Error("TeX Actions daemon request timed out while waiting for MCP response."));
			}, this.requestTimeoutMs);
			timer.unref?.();

			const onConnect = () => {
				socket.write(framedRequest);
			};
			const onData = (chunk: string) => {
				try {
					responseReader.write(chunk);
					const frame = responseReader.nextFrame();
					if (!frame) {
						return;
					}
					sawFrame = true;
					if (frame.protocol !== "mcp") {
						finalize(new Error("Daemon returned non-MCP protocol response."));
						return;
					}
					const clientPayload = rewriteDaemonResponseForCodex(frame.payload);
					void this.writeOutput(frameClientPayload(clientPayload, clientProtocol)).then(
						() => finalize(),
						(error) => finalize(asError(error)),
					);
					return;
				} catch (error) {
					finalize(asError(error));
				}
			};
			const onClose = () => {
				if (sawFrame) {
					return;
				}
				finalize(new Error("TeX Actions daemon disconnected before response."));
			};
			const onError = (error: unknown) => {
				finalize(asError(error));
			};

			socket.once("connect", onConnect);
			socket.on("data", onData);
			socket.once("close", onClose);
			socket.once("error", onError);
			socket.setTimeout(this.requestTimeoutMs, () => {
				finalize(new Error("TeX Actions daemon request timed out while waiting for MCP response."));
			});

			// Keep local request timeout aligned with promise timeout.
			socket.once("close", () => {
				clearTimeout(timer);
			});
			socket.once("end", () => {
				if (!sawFrame) {
					finalize(new Error("TeX Actions daemon response ended unexpectedly."));
				}
			});
		});
	}

	private async writeNotification(framedRequest: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection({ path: this.socketPath });
			socket.once("connect", () => {
				socket.end(framedRequest);
			});
			socket.once("close", () => {
				resolve();
			});
			socket.once("error", (error) => {
				reject(asError(error));
			});
		});
	}

	private async sendErrorFrame(requestId: McpRequestId, code: number, message: string, protocol: ClientFrameProtocol = "mcp"): Promise<void> {
		const response = buildMcpErrorResponse(requestId, code, message);
		await this.writeOutput(frameClientPayload(JSON.stringify(response), protocol));
	}

	private async writeOutput(payload: string): Promise<void> {
		await writeStreamPayload(this.stdout, payload);
	}

	private writeDiagnostic(message: string): void {
		this.stderr.write(`${message}\n`);
	}
}

export function startCodexMcpDaemonRelay(options: CodexMcpDaemonRelayOptions = {}): CodexMcpDaemonRelay {
	const relay = new CodexMcpDaemonRelay(options);
	relay.start();
	return relay;
}

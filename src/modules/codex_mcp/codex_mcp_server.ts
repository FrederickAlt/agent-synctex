import { createConnection } from "node:net";
import { once } from "node:events";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
	MCP_ERROR_INTERNAL,
	MCP_ERROR_PARSE_ERROR,
	type HostServiceDaemonFrame,
	type McpRequestId,
	HostServiceMcpFrameReader,
	buildMcpErrorResponse,
	mcpFramedResponse,
} from "../host_service_mcp.ts";
import { resolveHostServiceSocketPath } from "../host_service.ts";

export interface CodexMcpDaemonRelayOptions {
	socketPath?: string;
	stdin?: Readable;
	stdout?: Writable;
	stderr?: Writable;
	requestTimeoutMs?: number;
	maxPayloadBytes?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_FRAME_SIZE_BYTES = 16_384;
type ClientFrameProtocol = HostServiceDaemonFrame["protocol"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function framePayload(payload: string): string {
	return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

function frameClientPayload(payload: string, protocol: ClientFrameProtocol): string {
	if (protocol === "mcp") {
		return framePayload(payload);
	}
	return `${payload}\n`;
}

function requestMetadata(payload: string): { requestId: McpRequestId; expectsResponse: boolean } {
	try {
		const parsed = JSON.parse(payload);
		if (!isRecord(parsed)) {
			return { requestId: null, expectsResponse: true };
		}
		if (!Object.prototype.hasOwnProperty.call(parsed, "id")) {
			return { requestId: null, expectsResponse: false };
		}
		const rawId = (parsed as { id?: unknown }).id;
		if (rawId === null || typeof rawId === "string" || typeof rawId === "number") {
			return { requestId: rawId, expectsResponse: true };
		}
		return { requestId: null, expectsResponse: true };
	} catch {
		return { requestId: null, expectsResponse: true };
	}
}

function daemonUnavailableMessage(socketPath: string): string {
	return [
		`TeX Actions daemon is unavailable at ${socketPath}.`,
		"Restart with `pdf-preview-servicectl restart`.",
		"Then run `npm run tex-actionsctl -- doctor` or `tex-actionsctl doctor`.",
	].join(" ");
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class CodexMcpDaemonRelay {
	readonly socketPath: string;
	private readonly stdin: Readable;
	private readonly stdout: Writable;
	private readonly stderr: Writable;
	private readonly requestTimeoutMs: number;
	private readonly maxPayloadBytes: number;
	private readonly frameReader: HostServiceMcpFrameReader;
	private task: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(options: CodexMcpDaemonRelayOptions = {}) {
		this.socketPath = options.socketPath ?? resolveHostServiceSocketPath();
		this.stdin = options.stdin ?? processStdin;
		this.stdout = options.stdout ?? processStdout;
		this.stderr = options.stderr ?? processStderr;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_FRAME_SIZE_BYTES;
		this.frameReader = new HostServiceMcpFrameReader({ maxPayloadBytes: this.maxPayloadBytes });
	}

	start(): void {
		if (this.closed) {
			return;
		}
		if (this.stdin.readableEncoding !== "utf8") {
			this.stdin.setEncoding("utf8");
		}
		this.stdin.on("data", this.handleData);
		this.stdin.once("close", this.close);
	}

	readonly close = (): void => {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.stdin.off("data", this.handleData);
		this.stdin.off("close", this.close);
	};

	private readonly handleData = (chunk: string | Buffer): void => {
		if (this.closed) {
			return;
		}
		try {
			this.frameReader.write(chunk);
			while (true) {
				const frame = this.frameReader.nextFrame();
				if (!frame) {
					break;
				}
				this.task = this.task.then(() => this.handleFrame(frame)).catch((error) => {
					this.writeDiagnostic(asError(error).message);
				});
			}
		} catch (error) {
			void this.sendErrorFrame(null, MCP_ERROR_PARSE_ERROR, asError(error).message).catch(() => {
				// no-op
			});
		}
	};

	private async handleFrame(frame: HostServiceDaemonFrame): Promise<void> {
		const { requestId, expectsResponse } = requestMetadata(frame.payload);
		try {
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
	}

	private async forwardToDaemon(payload: string, expectsResponse: boolean, clientProtocol: ClientFrameProtocol): Promise<void> {
		const framed = framePayload(payload);
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
					void this.writeOutput(frameClientPayload(frame.payload, clientProtocol)).then(
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
		if (protocol === "mcp") {
			await this.writeOutput(mcpFramedResponse(response));
			return;
		}
		await this.writeOutput(`${JSON.stringify(response)}\n`);
	}

	private async writeOutput(payload: string): Promise<void> {
		if (!this.stdout.write(payload)) {
			await once(this.stdout, "drain");
		}
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

import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
	type McpStdioFrame,
	type McpRequestId,
	McpStdioFrameReader,
} from "./host_service_mcp.ts";

export type McpClientFrameProtocol = McpStdioFrame["protocol"];

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function frameMcpPayload(payload: string): string {
	return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

export function frameClientPayload(payload: string, protocol: McpClientFrameProtocol): string {
	return protocol === "json-line" ? `${payload}\n` : frameMcpPayload(payload);
}

export function requestMetadata(payload: string): { requestId: McpRequestId; expectsResponse: boolean } {
	try {
		const parsed = JSON.parse(payload) as unknown;
		if (!isRecord(parsed)) {
			return { requestId: null, expectsResponse: true };
		}
		if (!Object.prototype.hasOwnProperty.call(parsed, "id")) {
			return { requestId: null, expectsResponse: false };
		}
		const rawId = parsed.id;
		if (rawId === null || typeof rawId === "string" || typeof rawId === "number") {
			return { requestId: rawId, expectsResponse: true };
		}
		return { requestId: null, expectsResponse: true };
	} catch {
		return { requestId: null, expectsResponse: true };
	}
}

export function omitToolInputSchemaProperties(tool: unknown, omittedProperties: readonly string[]): unknown {
	if (!isRecord(tool) || !isRecord(tool.inputSchema)) {
		return tool;
	}
	const inputSchema: Record<string, unknown> = { ...tool.inputSchema };
	if (isRecord(inputSchema.properties)) {
		const properties = { ...inputSchema.properties };
		for (const property of omittedProperties) {
			delete properties[property];
		}
		inputSchema.properties = properties;
	}
	if (Array.isArray(inputSchema.required)) {
		inputSchema.required = inputSchema.required.filter((entry) => typeof entry !== "string" || !omittedProperties.includes(entry));
	}
	return {
		...tool,
		inputSchema,
	};
}

export async function writeStreamPayload(stream: Writable, payload: string): Promise<void> {
	if (!stream.write(payload)) {
		await once(stream, "drain");
	}
}

export interface McpStdioFrameLoopOptions {
	stdin: Readable;
	stderr: Writable;
	maxPayloadBytes?: number;
	onFrame: (frame: McpStdioFrame) => Promise<void>;
	onParseError: (error: Error) => Promise<void> | void;
	onDiagnostic?: (message: string) => void;
	onClose?: () => void;
}

export class McpStdioFrameLoop {
	private readonly stdin: Readable;
	private readonly stderr: Writable;
	private readonly frameReader: McpStdioFrameReader;
	private readonly onFrame: McpStdioFrameLoopOptions["onFrame"];
	private readonly onParseError: McpStdioFrameLoopOptions["onParseError"];
	private readonly onDiagnostic: (message: string) => void;
	private readonly onClose: () => void;
	private task: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(options: McpStdioFrameLoopOptions) {
		this.stdin = options.stdin;
		this.stderr = options.stderr;
		this.frameReader = new McpStdioFrameReader({ maxPayloadBytes: options.maxPayloadBytes });
		this.onFrame = options.onFrame;
		this.onParseError = options.onParseError;
		this.onDiagnostic = options.onDiagnostic ?? ((message) => this.stderr.write(`${message}\n`));
		this.onClose = options.onClose ?? (() => undefined);
	}

	start(): void {
		if (this.closed) return;
		if (this.stdin.readableEncoding !== "utf8") {
			this.stdin.setEncoding("utf8");
		}
		this.stdin.on("data", this.handleData);
		this.stdin.once("close", this.handleInputClose);
	}

	readonly close = (): void => {
		if (this.closed) return;
		this.closed = true;
		this.stdin.off("data", this.handleData);
		this.stdin.off("close", this.handleInputClose);
	};

	private readonly handleInputClose = (): void => {
		this.close();
		this.onClose();
	};

	private readonly handleData = (chunk: string | Buffer): void => {
		if (this.closed) return;
		try {
			this.frameReader.write(chunk);
			while (true) {
				const frame = this.frameReader.nextFrame();
				if (!frame) break;
				this.task = this.task.then(() => this.onFrame(frame)).catch((error) => {
					this.onDiagnostic(asError(error).message);
				});
			}
		} catch (error) {
			void Promise.resolve(this.onParseError(asError(error))).catch((parseError) => {
				this.onDiagnostic(asError(parseError).message);
			});
		}
	};
}

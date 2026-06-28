import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import { MCP_ERROR_PARSE_ERROR, buildMcpErrorResponse, handleMcpRequest } from "./host_service_mcp.ts";
import { resolveAgentWorkspaceContext } from "./agent_runtime_context.ts";
import { initializeLatexPreambleFile } from "./pi_extension/latex_preamble_manager.ts";
import { PdfJsViewerBrokerClient } from "./pdfjs_viewer_broker.ts";
import {
	frameClientPayload,
	isRecord,
	type McpClientFrameProtocol,
	McpStdioFrameLoop,
	omitToolInputSchemaProperties,
	writeStreamPayload,
} from "./mcp_stdio_transport.ts";

type StdioMcpPdfOperations = NonNullable<Parameters<typeof handleMcpRequest>[1]>;
type DefaultPdfOperationsService = {
	readonly pdfOperations: StdioMcpPdfOperations;
	close(): Promise<void>;
	activePdfCount?(): number;
};

export interface TexActionsStdioMcpRuntimeOptions {
	stdin?: Readable;
	stdout?: Writable;
	stderr?: Writable;
	launchCwd?: string;
	maxPayloadBytes?: number;
	pdfOperations?: StdioMcpPdfOperations;
	viewerLingerMs?: number;
}

export interface TexActionsStdioMcpRuntimeCloseOptions {
	lingerViewerService?: boolean;
}

const DEFAULT_VIEWER_LINGER_MS = 10 * 60 * 1_000;

const STDIO_WORKSPACE_CONTEXT_TOOL_NAMES = new Set([
	"show_latex",
	"compile_latex_file",
	"open_pdf",
	"jump_pdf",
	"set_latex_preamble",
]);

function sanitizeToolForV1(tool: unknown): unknown {
	return omitToolInputSchemaProperties(tool, ["workspace_context"]);
}

function rewriteToolsListForV1(response: unknown): unknown {
	if (!isRecord(response) || !isRecord(response.result) || !Array.isArray(response.result.tools)) {
		return response;
	}
	return {
		...response,
		result: {
			...response.result,
			tools: response.result.tools.map(sanitizeToolForV1),
		},
	};
}

export class TexActionsStdioMcpRuntime {
	private readonly stdout: Writable;
	private readonly launchCwd: string;
	private readonly frameLoop: McpStdioFrameLoop;
	private readonly pdfOperations: StdioMcpPdfOperations;
	private readonly defaultPdfService?: DefaultPdfOperationsService;
	private readonly viewerLingerMs: number;
	private viewerLingerTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(options: TexActionsStdioMcpRuntimeOptions = {}) {
		const stderr = options.stderr ?? processStderr;
		this.stdout = options.stdout ?? processStdout;
		this.launchCwd = options.launchCwd ?? process.cwd();
		this.defaultPdfService = options.pdfOperations === undefined ? new PdfJsViewerBrokerClient() : undefined;
		this.viewerLingerMs = options.viewerLingerMs ?? DEFAULT_VIEWER_LINGER_MS;
		this.pdfOperations = options.pdfOperations ?? this.defaultPdfService?.pdfOperations ?? {};
		this.frameLoop = new McpStdioFrameLoop({
			stdin: options.stdin ?? processStdin,
			stderr,
			maxPayloadBytes: options.maxPayloadBytes,
			onFrame: (frame) => this.handleFrame(frame.payload, frame.protocol),
			onParseError: (error) => this.writePayload(JSON.stringify(buildMcpErrorResponse(null, MCP_ERROR_PARSE_ERROR, error.message)), "mcp"),
		});
	}

	start(): void {
		if (this.closed) return;
		this.seedRuntimePreamble();
		this.frameLoop.start();
	}

	readonly close = (options: TexActionsStdioMcpRuntimeCloseOptions = {}): void => {
		if (this.closed) return;
		this.closed = true;
		this.frameLoop.close();
		if (options.lingerViewerService === true && this.shouldLingerViewerService()) {
			this.scheduleViewerServiceStop();
			return;
		}
		void this.stopDefaultPdfService();
	};

	readonly forceClose = (): void => {
		this.closed = true;
		this.frameLoop.close();
		void this.stopDefaultPdfService();
	};

	private shouldLingerViewerService(): boolean {
		return this.defaultPdfService !== undefined
			&& (this.defaultPdfService.activePdfCount?.() ?? 0) > 0
			&& this.viewerLingerMs > 0;
	}

	private scheduleViewerServiceStop(): void {
		if (this.viewerLingerTimer) return;
		this.viewerLingerTimer = setTimeout(() => {
			void this.stopDefaultPdfService();
		}, this.viewerLingerMs);
		this.viewerLingerTimer.unref?.();
	}

	private async stopDefaultPdfService(): Promise<void> {
		if (this.viewerLingerTimer) {
			clearTimeout(this.viewerLingerTimer);
			this.viewerLingerTimer = undefined;
		}
		await this.defaultPdfService?.close();
	}

	private workspaceContext() {
		return resolveAgentWorkspaceContext({ cwd: this.launchCwd });
	}

	private seedRuntimePreamble(): void {
		const workspaceContext = this.workspaceContext();
		initializeLatexPreambleFile({
			cwd: workspaceContext.cwd,
			runtimeDirectory: workspaceContext.workspace_root,
			overwrite: false,
		});
	}

	private async handleFrame(payload: string, protocol: McpClientFrameProtocol): Promise<void> {
		const rewrittenPayload = this.rewriteRequestPayload(payload);
		const response = await handleMcpRequest(rewrittenPayload, this.pdfOperations);
		if (response === null) return;
		const rewrittenResponse = rewriteToolsListForV1(response);
		await this.writePayload(JSON.stringify(rewrittenResponse), protocol);
	}

	private rewriteRequestPayload(payload: string): string {
		try {
			const parsed: unknown = JSON.parse(payload);
			if (!isRecord(parsed) || parsed.method !== "tools/call" || !isRecord(parsed.params) || typeof parsed.params.name !== "string") {
				return payload;
			}
			if (!STDIO_WORKSPACE_CONTEXT_TOOL_NAMES.has(parsed.params.name)) {
				return payload;
			}
			const currentArguments = isRecord(parsed.params.arguments) ? parsed.params.arguments : {};
			const nextArguments = { ...currentArguments };
			delete nextArguments.workspace_context;
			return JSON.stringify({
				...parsed,
				params: {
					...parsed.params,
					arguments: {
						...nextArguments,
						workspace_context: this.workspaceContext(),
					},
				},
			});
		} catch {
			return payload;
		}
	}

	private async writePayload(payload: string, protocol: McpClientFrameProtocol): Promise<void> {
		await writeStreamPayload(this.stdout, frameClientPayload(payload, protocol));
	}
}

export function startTexActionsStdioMcpRuntime(options: TexActionsStdioMcpRuntimeOptions = {}): TexActionsStdioMcpRuntime {
	const runtime = new TexActionsStdioMcpRuntime(options);
	runtime.start();
	return runtime;
}

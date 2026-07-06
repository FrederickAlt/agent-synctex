import { writeFileSync } from "node:fs";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import { MCP_ERROR_PARSE_ERROR, buildMcpErrorResponse, handleMcpRequest } from "./host_service_mcp.ts";
import { resolveAgentWorkspaceContext, resolveAgentWorkspaceContextForAgentId, TEX_ACTIONS_AGENT_ID_ENV_VAR } from "./agent_runtime_context.ts";
import { initializeLatexPreambleFile } from "./pi_extension/latex_preamble_manager.ts";
import { ViewerHostMcpService } from "./viewer_host_client.ts";
import { startHookContextBridge, type HookContextBridgeHandle } from "./hook_context_bridge.ts";
import { areHarnessHooksInstalled } from "./installer/hook_install_state.ts";
import type { HarnessId } from "./installer/types.ts";
import {
	frameClientPayload,
	isRecord,
	type McpClientFrameProtocol,
	McpStdioFrameLoop,
	omitToolInputSchemaProperties,
	writeStreamPayload,
} from "./mcp_stdio_transport.ts";

type StdioMcpPdfOperations = NonNullable<Parameters<typeof handleMcpRequest>[1]>;

export type StdioMcpHookMode =
	| { kind: "hook-capable"; harness: HarnessId; hooksInstalled?: boolean }
	| { kind: "legacy-hooks" }
	| { kind: "no-hooks"; harness?: HarnessId; fallbackReason?: "missing-harness" };

export interface TexActionsStdioMcpRuntimeOptions {
	stdin?: Readable;
	stdout?: Writable;
	stderr?: Writable;
	launchCwd?: string;
	maxPayloadBytes?: number;
	pdfOperations?: StdioMcpPdfOperations;
	hooksEnabled?: boolean;
	hookMode?: StdioMcpHookMode;
	viewerUrlFallbackWriter?: (message: string) => void;
	agentId?: string;
}

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
	private readonly stderr: Writable;
	private readonly viewerUrlFallbackWriter: (message: string) => void;
	private readonly launchCwd: string;
	private readonly frameLoop: McpStdioFrameLoop;
	private readonly pdfOperations: StdioMcpPdfOperations;
	private readonly hookMode: StdioMcpHookMode;
	private readonly explicitAgentId: string | undefined;
	private readonly defaultPdfService?: ViewerHostMcpService;
	private hookContextBridge?: HookContextBridgeHandle;
	private firstToolCallWarning: string | undefined;
	private closed = false;

	constructor(options: TexActionsStdioMcpRuntimeOptions = {}) {
		const stderr = options.stderr ?? processStderr;
		this.stdout = options.stdout ?? processStdout;
		this.stderr = stderr;
		this.viewerUrlFallbackWriter = options.viewerUrlFallbackWriter ?? ((message) => writeViewerUrlFallbackToUser(message, stderr));
		this.launchCwd = options.launchCwd ?? process.cwd();
		this.hookMode = normalizeHookMode(options, this.launchCwd);
		this.explicitAgentId = options.agentId;
		const workspaceContext = this.workspaceContext();
		this.defaultPdfService = options.pdfOperations === undefined ? new ViewerHostMcpService({ agentRuntimeDir: workspaceContext.workspace_root }) : undefined;
		this.pdfOperations = options.pdfOperations ?? this.defaultPdfService?.pdfOperations ?? {};
		this.firstToolCallWarning = firstToolCallWarning(this.hookMode);
		this.frameLoop = new McpStdioFrameLoop({
			stdin: options.stdin ?? processStdin,
			stderr,
			maxPayloadBytes: options.maxPayloadBytes,
			onFrame: (frame) => this.handleFrame(frame.payload, frame.protocol),
			onParseError: (error) => this.writePayload(JSON.stringify(buildMcpErrorResponse(null, MCP_ERROR_PARSE_ERROR, error.message)), "mcp"),
			onClose: () => this.close(),
		});
	}

	start(): void {
		if (this.closed) return;
		const workspaceContext = this.seedRuntimePreamble();
		if (this.hookMode.kind === "hook-capable" || this.hookMode.kind === "legacy-hooks") {
			this.hookContextBridge = startHookContextBridge({
				runtimeDir: workspaceContext.workspace_root!,
				fetchContext: async (request) => {
					if (!this.pdfOperations.fetchPdfContext) return { text: "", pdfIds: [], eventCount: 0, cleared: false, events: [] };
					return this.pdfOperations.fetchPdfContext({ ...request, cwd: workspaceContext.cwd });
				},
			});
			void this.hookContextBridge.ready.catch(() => undefined);
		}
		this.frameLoop.start();
	}

	readonly close = (): void => {
		if (this.closed) return;
		this.closed = true;
		this.frameLoop.close();
		void this.hookContextBridge?.close();
		void this.defaultPdfService?.stop();
	};

	private workspaceContext() {
		if (this.hookMode.kind !== "legacy-hooks" && this.hookMode.harness) {
			const envAgentId = process.env[TEX_ACTIONS_AGENT_ID_ENV_VAR]?.trim();
			return resolveAgentWorkspaceContextForAgentId(this.explicitAgentId ?? (envAgentId || undefined) ?? `agent-synctex-${this.hookMode.harness}`, this.launchCwd);
		}
		return resolveAgentWorkspaceContext({ cwd: this.launchCwd });
	}

	private seedRuntimePreamble() {
		const workspaceContext = this.workspaceContext();
		initializeLatexPreambleFile({
			cwd: workspaceContext.cwd,
			runtimeDirectory: workspaceContext.workspace_root,
			overwrite: false,
		});
		return workspaceContext;
	}

	private async handleFrame(payload: string, protocol: McpClientFrameProtocol): Promise<void> {
		const rewrittenPayload = this.rewriteRequestPayload(payload);
		const response = await handleMcpRequest(rewrittenPayload, this.pdfOperations, {
			exposeFetchPdfContext: this.exposeFetchPdfContext(),
			emitViewerUrlFallback: (url) => this.writeViewerUrlFallback(url),
		});
		if (response === null) return;
		const warnedResponse = this.maybeAttachFirstToolCallWarning(response, rewrittenPayload);
		const rewrittenResponse = rewriteToolsListForV1(warnedResponse);
		await this.writePayload(JSON.stringify(rewrittenResponse), protocol);
	}

	private exposeFetchPdfContext(): boolean {
		return this.hookMode.kind === "no-hooks" || (this.hookMode.kind === "hook-capable" && this.hookMode.hooksInstalled !== true);
	}

	private maybeAttachFirstToolCallWarning(response: unknown, payload: string): unknown {
		if (!this.firstToolCallWarning || !isToolCallPayload(payload)) return response;
		const warning = this.firstToolCallWarning;
		this.firstToolCallWarning = undefined;
		return appendTextToToolResult(response, warning);
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
			const rawArguments = parsed.params.arguments;
			const currentArguments = isRecord(rawArguments)
				? rawArguments
				: typeof rawArguments === "string" && parsed.params.name === "show_latex"
					? { source: rawArguments }
					: typeof rawArguments === "string" && parsed.params.name === "set_latex_preamble"
						? { latex_preamble: rawArguments }
						: {};
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

	private writeViewerUrlFallback(url: string): void {
		this.viewerUrlFallbackWriter(`Agent SyncTeX: no browser viewer was detected after launch; pass this Viewer URL to the user: ${url}\n`);
	}
}

function writeViewerUrlFallbackToUser(message: string, stderr: Writable): void {
	try {
		writeFileSync("/dev/tty", message);
		return;
	} catch {
		stderr.write(message);
	}
}

function normalizeHookMode(options: TexActionsStdioMcpRuntimeOptions, cwd: string): StdioMcpHookMode {
	if (options.hookMode) {
		if (options.hookMode.kind === "hook-capable") {
			return { ...options.hookMode, hooksInstalled: options.hookMode.hooksInstalled ?? areHarnessHooksInstalled(options.hookMode.harness, cwd) };
		}
		return options.hookMode;
	}
	return options.hooksEnabled === true ? { kind: "legacy-hooks" } : { kind: "no-hooks" };
}

function firstToolCallWarning(hookMode: StdioMcpHookMode): string | undefined {
	if (hookMode.kind === "hook-capable" && hookMode.hooksInstalled !== true) {
		return `Agent SyncTeX hooks are not installed for ${hookMode.harness}.\n\nAsk the user to run:\n  agent-synctex install --harness ${hookMode.harness}\n\nOr install project-locally:\n  agent-synctex install --harness ${hookMode.harness} --local\n\nUntil hooks are installed, use fetch_pdf_context for PDF marks/comments.`;
	}
	if (hookMode.kind === "no-hooks" && hookMode.fallbackReason === "missing-harness") {
		return `Agent SyncTeX was started without --harness, so it fell back to --no-hooks mode.\n\nFor automatic PDF comment injection, configure the MCP as:\n  agent-synctex mcp --harness <harness>\n\nFor intentional manual-only mode, configure:\n  agent-synctex mcp --no-hooks\n\nUse fetch_pdf_context manually for PDF marks/comments in this session.`;
	}
	return undefined;
}

function isToolCallPayload(payload: string): boolean {
	try {
		const parsed = JSON.parse(payload) as unknown;
		return isRecord(parsed) && parsed.method === "tools/call";
	} catch {
		return false;
	}
}

function appendTextToToolResult(response: unknown, text: string): unknown {
	if (!isRecord(response) || !isRecord(response.result) || !Array.isArray(response.result.content)) return response;
	return {
		...response,
		result: {
			...response.result,
			content: [{ type: "text", text }, ...response.result.content],
		},
	};
}

export function startTexActionsStdioMcpRuntime(options: TexActionsStdioMcpRuntimeOptions = {}): TexActionsStdioMcpRuntime {
	const runtime = new TexActionsStdioMcpRuntime(options);
	runtime.start();
	return runtime;
}

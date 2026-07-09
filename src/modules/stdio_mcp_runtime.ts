import { writeFileSync } from "node:fs";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import { MCP_ERROR_PARSE_ERROR, buildMcpErrorResponse, handleMcpRequest } from "./host_service_mcp.ts";
import { resolveAgentWorkspaceContext, resolveAgentWorkspaceContextForAgentId, resolveHookAgentWorkspaceContext } from "./agent_runtime_context.ts";
import type { HostServiceWorkspaceContext } from "./host_service_protocol.ts";
import { HostServiceCompileService } from "./host_service_compile.ts";
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
]);

const STDIO_AGENT_SCOPED_TOOL_NAMES = new Set([
	...STDIO_WORKSPACE_CONTEXT_TOOL_NAMES,
	"fetch_pdf_context",
]);

const AGENT_SYNCTEX_SESSION_METADATA_KEYS = [
	"_agent_synctex",
	"_codex",
	"_pi",
	"_claude",
	"_cline",
	"_opencode",
];

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

interface AgentSynctexSessionMetadata {
	sessionId: string;
	cwd?: string;
}

function sessionMetadataFromArguments(args: Record<string, unknown>): AgentSynctexSessionMetadata | undefined {
	for (const key of AGENT_SYNCTEX_SESSION_METADATA_KEYS) {
		const metadata = isRecord(args[key]) ? args[key] : undefined;
		const sessionId = stringValue(metadata?.session_id) ?? stringValue(metadata?.sessionId);
		if (sessionId) return { sessionId, cwd: stringValue(metadata?.cwd) };
	}
	const workspaceContext = isRecord(args.workspace_context) ? args.workspace_context : undefined;
	const workspaceSessionId = stringValue(workspaceContext?.session_id);
	if (workspaceSessionId) return { sessionId: workspaceSessionId, cwd: stringValue(workspaceContext?.cwd) };
	return undefined;
}

function stripAgentSynctexSessionMetadata(args: Record<string, unknown>): Record<string, unknown> {
	const stripped = { ...args };
	for (const key of AGENT_SYNCTEX_SESSION_METADATA_KEYS) delete stripped[key];
	return stripped;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export class TexActionsStdioMcpRuntime {
	private readonly stdout: Writable;
	private readonly stderr: Writable;
	private readonly viewerUrlFallbackWriter: (message: string) => void;
	private readonly launchCwd: string;
	private readonly frameLoop: McpStdioFrameLoop;
	private readonly providedPdfOperations: StdioMcpPdfOperations | undefined;
	private readonly hookMode: StdioMcpHookMode;
	private readonly explicitAgentId: string | undefined;
	private readonly pdfServicesByAgentId = new Map<string, ViewerHostMcpService>();
	private readonly compileServicesByAgentId = new Map<string, HostServiceCompileService>();
	private readonly pdfOperationsByAgentId = new Map<string, StdioMcpPdfOperations>();
	private readonly hookContextBridgesByAgentId = new Map<string, HookContextBridgeHandle>();
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
		this.providedPdfOperations = options.pdfOperations;
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
		this.ensureHookContextBridge(workspaceContext, this.pdfOperationsForWorkspace(workspaceContext));
		this.frameLoop.start();
	}

	readonly close = (): void => {
		if (this.closed) return;
		this.closed = true;
		this.frameLoop.close();
		for (const bridge of this.hookContextBridgesByAgentId.values()) void bridge.close();
		this.hookContextBridgesByAgentId.clear();
		for (const service of this.compileServicesByAgentId.values()) service.stop();
		this.compileServicesByAgentId.clear();
		for (const service of this.pdfServicesByAgentId.values()) void service.stop();
		this.pdfServicesByAgentId.clear();
		this.pdfOperationsByAgentId.clear();
	};

	private workspaceContext(metadata?: AgentSynctexSessionMetadata): HostServiceWorkspaceContext {
		if (metadata?.sessionId) return resolveAgentWorkspaceContextForAgentId(metadata.sessionId, metadata.cwd ?? this.launchCwd);
		if (this.explicitAgentId) return resolveAgentWorkspaceContextForAgentId(this.explicitAgentId, this.launchCwd);
		if (this.hookMode.kind !== "legacy-hooks" && this.hookMode.harness) {
			return resolveHookAgentWorkspaceContext({ cwd: this.launchCwd });
		}
		return resolveAgentWorkspaceContext({ cwd: this.launchCwd });
	}

	private seedRuntimePreamble(workspaceContext = this.workspaceContext()): HostServiceWorkspaceContext {
		return workspaceContext;
	}

	private pdfOperationsForWorkspace(workspaceContext: HostServiceWorkspaceContext): StdioMcpPdfOperations {
		if (this.providedPdfOperations) return this.providedPdfOperations;
		const agentId = workspaceContext.session_id ?? "default";
		const existingOperations = this.pdfOperationsByAgentId.get(agentId);
		if (existingOperations) return existingOperations;
		const service = new ViewerHostMcpService({ agentRuntimeDir: workspaceContext.workspace_root });
		this.pdfServicesByAgentId.set(agentId, service);
		const compileService = new HostServiceCompileService({
			protocolVersion: 1,
			managedViewerService: {
				async openViewer(openRequest) {
					if (!service.pdfOperations.openPdf) throw new Error("open_pdf is not implemented by the runtime");
					return service.pdfOperations.openPdf(openRequest);
				},
				markPdfUpdated: service.pdfOperations.markTrackedPdfUpdated,
			},
		});
		compileService.start();
		this.compileServicesByAgentId.set(agentId, compileService);
		const operations: StdioMcpPdfOperations = { ...service.pdfOperations, compileService };
		this.pdfOperationsByAgentId.set(agentId, operations);
		return operations;
	}

	private ensureHookContextBridge(workspaceContext: HostServiceWorkspaceContext, pdfOperations: StdioMcpPdfOperations): void {
		if (this.hookMode.kind !== "hook-capable" && this.hookMode.kind !== "legacy-hooks") return;
		const agentId = workspaceContext.session_id ?? "default";
		if (this.hookContextBridgesByAgentId.has(agentId)) return;
		const runtimeDir = workspaceContext.workspace_root;
		if (!runtimeDir) return;
		const bridge = startHookContextBridge({
			runtimeDir,
			fetchContext: async (request) => {
				if (!pdfOperations.fetchPdfContext) return { text: "", pdfIds: [], eventCount: 0, cleared: false, events: [] };
				return pdfOperations.fetchPdfContext({ ...request, cwd: workspaceContext.cwd });
			},
		});
		this.hookContextBridgesByAgentId.set(agentId, bridge);
		void bridge.ready.catch(() => undefined);
	}

	private async handleFrame(payload: string, protocol: McpClientFrameProtocol): Promise<void> {
		const routedRequest = this.rewriteRequestPayload(payload);
		const response = await handleMcpRequest(routedRequest.payload, routedRequest.pdfOperations, {
			exposeFetchPdfContext: this.exposeFetchPdfContext(),
			emitViewerUrlFallback: (url) => this.writeViewerUrlFallback(url),
		});
		if (response === null) return;
		const warnedResponse = this.maybeAttachFirstToolCallWarning(response, routedRequest.payload);
		const rewrittenResponse = rewriteToolsListForV1(warnedResponse);
		await this.writePayload(JSON.stringify(rewrittenResponse), protocol);
	}

	private exposeFetchPdfContext(): boolean {
		return this.hookMode.kind === "no-hooks";
	}

	private maybeAttachFirstToolCallWarning(response: unknown, payload: string): unknown {
		if (!this.firstToolCallWarning || !isToolCallPayload(payload)) return response;
		const warning = this.firstToolCallWarning;
		this.firstToolCallWarning = undefined;
		return appendTextToToolResult(response, warning);
	}

	private rewriteRequestPayload(payload: string): { payload: string; pdfOperations: StdioMcpPdfOperations } {
		try {
			const parsed: unknown = JSON.parse(payload);
			if (!isRecord(parsed) || parsed.method !== "tools/call" || !isRecord(parsed.params) || typeof parsed.params.name !== "string") {
				const workspaceContext = this.workspaceContext();
				return { payload, pdfOperations: this.pdfOperationsForWorkspace(workspaceContext) };
			}
			if (!STDIO_AGENT_SCOPED_TOOL_NAMES.has(parsed.params.name)) {
				const workspaceContext = this.workspaceContext();
				return { payload, pdfOperations: this.pdfOperationsForWorkspace(workspaceContext) };
			}
			const rawArguments = parsed.params.arguments;
			if (parsed.params.name === "fetch_pdf_context" && rawArguments !== undefined && !isRecord(rawArguments)) {
				const workspaceContext = this.workspaceContext();
				return { payload, pdfOperations: this.pdfOperationsForWorkspace(workspaceContext) };
			}
			const currentArguments = isRecord(rawArguments)
				? rawArguments
				: typeof rawArguments === "string" && parsed.params.name === "show_latex"
					? { source: rawArguments }
					: {};
			const metadata = sessionMetadataFromArguments(currentArguments);
			const workspaceContext = this.seedRuntimePreamble(this.workspaceContext(metadata));
			const pdfOperations = this.pdfOperationsForWorkspace(workspaceContext);
			this.ensureHookContextBridge(workspaceContext, pdfOperations);
			const nextArguments = stripAgentSynctexSessionMetadata(currentArguments);
			delete nextArguments.workspace_context;
			const rewrittenArguments = STDIO_WORKSPACE_CONTEXT_TOOL_NAMES.has(parsed.params.name)
				? { ...nextArguments, workspace_context: workspaceContext }
				: nextArguments;
			return {
				payload: JSON.stringify({
					...parsed,
					params: {
						...parsed.params,
						arguments: rewrittenArguments,
					},
				}),
				pdfOperations,
			};
		} catch {
			const workspaceContext = this.workspaceContext();
			return { payload, pdfOperations: this.pdfOperationsForWorkspace(workspaceContext) };
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
		return `Agent SyncTeX hooks are not installed for ${hookMode.harness}.\n\nAsk the user to run:\n  agent-synctex install --harness ${hookMode.harness}\n\nOr install project-locally:\n  agent-synctex install --harness ${hookMode.harness} --local`;
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

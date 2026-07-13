import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import { MCP_ERROR_INVALID_PARAMS, MCP_ERROR_PARSE_ERROR, buildMcpErrorResponse, handleMcpRequest } from "./host_service_mcp.ts";
import { resolveAgentWorkspaceContext, resolveAgentWorkspaceContextForAgentId, resolveHookAgentWorkspaceContext, sanitizeTexActionsAgentId } from "./agent_runtime_context.ts";
import type { HostServiceWorkspaceContext } from "./host_service_protocol.ts";
import { HostServiceCompileService } from "./host_service_compile.ts";
import { ViewerHostMcpService } from "./viewer_host_client.ts";
import type { ViewerHostCompileActionMessage } from "./viewer_host_protocol.ts";
import { areHarnessHooksInstalled } from "./installer/hook_install_state.ts";
import { LATEXMK_CONTINUOUS_EVENT_PREFIX, latexmkContinuousArgs } from "./latex/latex_file_compiler.ts";
import type { HarnessId } from "./installer/types.ts";
import { executableSearchPath, resolveExecutable } from "./executable_resolution.ts";
import {
	frameClientPayload,
	isRecord,
	type McpClientFrameProtocol,
	McpStdioFrameLoop,
	omitToolInputSchemaProperties,
	writeStreamPayload,
} from "./mcp_stdio_transport.ts";

type StdioMcpPdfOperations = NonNullable<Parameters<typeof handleMcpRequest>[1]>;
const STATELESS_PDF_OPERATIONS: StdioMcpPdfOperations = {};

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

function mcpRequestIdFromPayload(payload: string): string | number | null {
	try {
		const parsed = JSON.parse(payload) as unknown;
		if (!isRecord(parsed)) return null;
		return typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null ? parsed.id : null;
	} catch {
		return null;
	}
}

interface AgentRuntimeBundle {
	pdfService: ViewerHostMcpService;
	compileService: HostServiceCompileService;
	compileActions: ViewerCompileActionsHandle;
	operations: StdioMcpPdfOperations;
}

class AgentRuntimeScopeError extends Error {}

export class TexActionsStdioMcpRuntime {
	private readonly stdout: Writable;
	private readonly stderr: Writable;
	private readonly viewerUrlFallbackWriter: (message: string) => void;
	private readonly launchCwd: string;
	private readonly frameLoop: McpStdioFrameLoop;
	private readonly providedPdfOperations: StdioMcpPdfOperations | undefined;
	private readonly hookMode: StdioMcpHookMode;
	private readonly explicitAgentId: string | undefined;
	private agentRuntime: { agentId: string; bundle: AgentRuntimeBundle } | undefined;
	private boundAgentId: string | undefined;
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
		this.frameLoop.start();
	}

	readonly close = (): void => {
		if (this.closed) return;
		this.closed = true;
		this.frameLoop.close();
		const runtime = this.agentRuntime?.bundle;
		this.agentRuntime = undefined;
		if (runtime) {
			const compileActionCleanup = runtime.compileActions.stop();
			runtime.compileService.stop();
			void (async () => {
				try {
					await compileActionCleanup;
				} finally {
					await runtime.pdfService.stop();
				}
			})().catch(() => undefined);
		}
	};

	private workspaceContext(metadata?: AgentSynctexSessionMetadata): HostServiceWorkspaceContext {
		const requested = this.explicitAgentId
			? { agentId: this.explicitAgentId, cwd: this.launchCwd }
			: metadata?.sessionId
				? { agentId: metadata.sessionId, cwd: metadata.cwd ?? this.launchCwd }
				: undefined;
		const requestedAgentId = requested === undefined ? undefined : sanitizeTexActionsAgentId(requested.agentId);
		if (requestedAgentId !== undefined && this.boundAgentId !== undefined && this.boundAgentId !== requestedAgentId) {
			throw new AgentRuntimeScopeError(`This MCP runtime is bound to agent ${this.boundAgentId}; refusing session metadata for ${requestedAgentId}`);
		}
		const resolved = requested === undefined
			? this.hookMode.kind !== "legacy-hooks" && this.hookMode.harness
				? resolveHookAgentWorkspaceContext({ cwd: this.launchCwd })
				: resolveAgentWorkspaceContext({ cwd: this.launchCwd })
			: resolveAgentWorkspaceContextForAgentId(requested.agentId, requested.cwd);
		const agentId = resolved.session_id ?? "default";
		if (this.boundAgentId !== undefined && this.boundAgentId !== agentId) {
			throw new AgentRuntimeScopeError(`This MCP runtime is bound to agent ${this.boundAgentId}; refusing session metadata for ${agentId}`);
		}
		this.boundAgentId = agentId;
		return resolved;
	}

	private seedRuntimePreamble(workspaceContext = this.workspaceContext()): HostServiceWorkspaceContext {
		return workspaceContext;
	}

	private pdfOperationsForWorkspace(workspaceContext: HostServiceWorkspaceContext): StdioMcpPdfOperations {
		if (this.providedPdfOperations) return this.providedPdfOperations;
		const agentId = workspaceContext.session_id ?? "default";
		if (this.agentRuntime) {
			if (this.agentRuntime.agentId !== agentId) throw new AgentRuntimeScopeError(`Viewer Host runtime belongs to ${this.agentRuntime.agentId}, not ${agentId}`);
			return this.agentRuntime.bundle.operations;
		}
		const service = new ViewerHostMcpService({ agentRuntimeDir: workspaceContext.workspace_root, workspaceCwd: workspaceContext.cwd });
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
		const compileActions = installViewerCompileActions(service, compileService);
		const operations: StdioMcpPdfOperations = { ...service.pdfOperations, compileService };
		this.agentRuntime = { agentId, bundle: { pdfService: service, compileService, compileActions, operations } };
		return operations;
	}

	private async handleFrame(payload: string, protocol: McpClientFrameProtocol): Promise<void> {
		await this.handleFrameNow(payload, protocol);
	}

	private async handleFrameNow(payload: string, protocol: McpClientFrameProtocol): Promise<void> {
		const routedRequest = this.rewriteRequestPayload(payload);
		if (routedRequest.routingError !== undefined) {
			await this.writePayload(JSON.stringify(buildMcpErrorResponse(mcpRequestIdFromPayload(payload), MCP_ERROR_INVALID_PARAMS, routedRequest.routingError)), protocol);
			return;
		}
		if (routedRequest.continuousCompileActive && isNamedToolCallPayload(routedRequest.payload, "compile_latex_file")) {
			await this.writePayload(JSON.stringify(buildContinuousCompileActiveToolResponse(routedRequest.payload)), protocol);
			return;
		}
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

	private rewriteRequestPayload(payload: string): { payload: string; pdfOperations: StdioMcpPdfOperations; continuousCompileActive: boolean; routingError?: string } {
		try {
			const parsed: unknown = JSON.parse(payload);
			if (!isRecord(parsed) || parsed.method !== "tools/call" || !isRecord(parsed.params) || typeof parsed.params.name !== "string") {
				return { payload, pdfOperations: this.providedPdfOperations ?? STATELESS_PDF_OPERATIONS, continuousCompileActive: false };
			}
			if (!STDIO_AGENT_SCOPED_TOOL_NAMES.has(parsed.params.name)) {
				return { payload, pdfOperations: this.providedPdfOperations ?? STATELESS_PDF_OPERATIONS, continuousCompileActive: false };
			}
			const rawArguments = parsed.params.arguments;
			if (parsed.params.name === "fetch_pdf_context" && rawArguments !== undefined && !isRecord(rawArguments)) {
				return { payload, pdfOperations: this.providedPdfOperations ?? STATELESS_PDF_OPERATIONS, continuousCompileActive: false };
			}
			const currentArguments = isRecord(rawArguments)
				? rawArguments
				: typeof rawArguments === "string" && parsed.params.name === "show_latex"
					? { source: rawArguments }
					: {};
			const metadata = sessionMetadataFromArguments(currentArguments);
			const workspaceContext = this.seedRuntimePreamble(this.workspaceContext(metadata));
			const agentId = workspaceContext.session_id ?? "default";
			const pdfOperations = this.pdfOperationsForWorkspace(workspaceContext);
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
				continuousCompileActive: this.continuousCompileActiveForToolCall(agentId, parsed.params.name, rewrittenArguments, workspaceContext),
			};
		} catch (error) {
			if (error instanceof AgentRuntimeScopeError) {
				return { payload, pdfOperations: this.providedPdfOperations ?? STATELESS_PDF_OPERATIONS, continuousCompileActive: false, routingError: error.message };
			}
			return { payload, pdfOperations: this.providedPdfOperations ?? STATELESS_PDF_OPERATIONS, continuousCompileActive: false };
		}
	}

	private continuousCompileActiveForToolCall(agentId: string, toolName: string, args: Record<string, unknown>, workspaceContext: HostServiceWorkspaceContext): boolean {
		if (toolName !== "compile_latex_file" || typeof args.latex_file_path !== "string") return false;
		return this.agentRuntime?.agentId === agentId && this.agentRuntime.bundle.compileActions.hasContinuousCompileForSource(args.latex_file_path, workspaceContext.cwd) === true;
	}

	private async writePayload(payload: string, protocol: McpClientFrameProtocol): Promise<void> {
		await writeStreamPayload(this.stdout, frameClientPayload(payload, protocol));
	}

	private writeViewerUrlFallback(url: string): void {
		this.viewerUrlFallbackWriter(`Agent SyncTeX viewer: ${url}\n`);
	}
}

interface ViewerCompileActionsHandle {
	stop(): Promise<void>;
	hasContinuousCompileForSource(sourcePath: string, cwd: string): boolean;
}

type ViewerCompileRecord = { pdfId: number; pdfPath: string; workspaceCwd: string };

interface ContinuousLatexmkProcess {
	child: ChildProcessWithoutNullStreams;
	record: ViewerCompileRecord;
	sourcePath: string;
	buffer: string;
	outputTail: string;
	stopping: boolean;
	outputTask: Promise<void>;
}

export interface ViewerContinuousLatexmkControllerOptions {
	spawnProcess?: typeof spawn;
}

export class ViewerContinuousLatexmkController {
	private readonly service: ViewerHostMcpService;
	private readonly processes = new Map<number, ContinuousLatexmkProcess>();
	private readonly spawnProcess: typeof spawn;
	private shuttingDown = false;

	constructor(service: ViewerHostMcpService, options: ViewerContinuousLatexmkControllerOptions = {}) {
		this.service = service;
		this.spawnProcess = options.spawnProcess ?? spawn;
	}

	has(pdfId: number): boolean {
		return this.processes.has(pdfId);
	}

	hasSource(sourcePath: string, cwd: string): boolean {
		const normalized = normalizeContinuousSourcePath(sourcePath, cwd);
		return [...this.processes.values()].some((state) => normalizeContinuousSourcePath(state.sourcePath, dirname(state.sourcePath)) === normalized);
	}

	async start(record: ViewerCompileRecord): Promise<void> {
		if (this.shuttingDown) return;
		if (this.processes.has(record.pdfId)) {
			await this.sendStatus(record, true, { continuous: true });
			return;
		}
		const sourcePath = sourcePathForCompiledPdf(record.pdfPath);
		await this.sendStatus(record, true, { continuous: true });
		if (this.shuttingDown) return;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnProcess(resolveExecutable("latexmk"), latexmkContinuousArgs(sourcePath, undefined), {
				cwd: dirname(sourcePath),
				env: {
					...process.env,
					HOME: process.env.HOME || homedir(),
					PATH: executableSearchPath(),
				},
			});
		} catch (error) {
			const detail = continuousCompileErrorText(sourcePath, error);
			await this.sendStatus(record, false, { continuous: false, severity: "error", message: detail, injectText: detail });
			return;
		}
		const state: ContinuousLatexmkProcess = { child, record, sourcePath, buffer: "", outputTail: "", stopping: false, outputTask: Promise.resolve() };
		this.processes.set(record.pdfId, state);
		const enqueueOutput = (chunk: Buffer | string) => {
			state.outputTask = state.outputTask.then(() => this.handleOutput(state, chunk)).catch(() => undefined);
		};
		child.stdout.on("data", enqueueOutput);
		child.stderr.on("data", enqueueOutput);
		child.on("error", (error) => {
			if (state.stopping) return;
			state.stopping = true;
			if (this.processes.get(record.pdfId) === state) this.processes.delete(record.pdfId);
			const detail = continuousCompileErrorText(sourcePath, error);
			void this.sendStatus(record, false, { continuous: false, severity: "error", message: detail, injectText: detail });
		});
		child.on("close", (code, signal) => {
			if (this.processes.get(record.pdfId) === state) this.processes.delete(record.pdfId);
			if (state.stopping) return;
			const detail = continuousCompileErrorText(sourcePath, `continuous latexmk exited (${code ?? signal ?? "unknown"})`, state.outputTail);
			void this.sendStatus(record, false, { continuous: false, severity: "error", message: detail, injectText: detail });
		});
	}

	async stop(pdfId: number, notice?: string, options: { emitStatus?: boolean } = {}): Promise<boolean> {
		const state = this.processes.get(pdfId);
		if (state === undefined) return false;
		state.stopping = true;
		this.processes.delete(pdfId);
		state.child.kill("SIGTERM");
		const killTimer = setTimeout(() => state.child.kill("SIGKILL"), 2_000);
		killTimer.unref?.();
		await state.outputTask.catch(() => undefined);
		if (options.emitStatus !== false) {
			await this.sendStatus(state.record, false, { continuous: false, ...(notice === undefined ? {} : { severity: "info", message: notice }) });
		}
		return true;
	}

	async stopAll(options: { emitStatus?: boolean } = {}): Promise<void> {
		this.shuttingDown = true;
		await Promise.all([...this.processes.keys()].map((pdfId) => this.stop(pdfId, undefined, options)));
	}

	private async handleOutput(state: ContinuousLatexmkProcess, chunk: Buffer | string): Promise<void> {
		if (!this.isCurrent(state)) return;
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		state.outputTail = `${state.outputTail}${text}`.slice(-12_000);
		state.buffer += text;
		const lines = state.buffer.split(/\r?\n/);
		state.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!this.isCurrent(state)) return;
			const event = line.startsWith(LATEXMK_CONTINUOUS_EVENT_PREFIX) ? line.slice(LATEXMK_CONTINUOUS_EVENT_PREFIX.length).trim() : undefined;
			if (event === "compiling") {
				await this.sendStatus(state.record, true, { continuous: true });
			} else if (event === "success" || event === "warning") {
				await this.service.pdfOperations.markTrackedPdfUpdated?.(state.record.pdfPath);
				if (!this.isCurrent(state)) return;
				await this.sendStatus(state.record, false, { continuous: true });
			} else if (event === "failure") {
				const detail = continuousCompileErrorText(state.sourcePath, "compile failed", state.outputTail);
				await this.sendStatus(state.record, false, { continuous: true, severity: "error", message: detail, injectText: detail });
			}
		}
	}

	private isCurrent(state: ContinuousLatexmkProcess): boolean {
		return !state.stopping && this.processes.get(state.record.pdfId) === state;
	}

	private async sendStatus(record: ViewerCompileRecord, running: boolean, options: { continuous: boolean; severity?: "info" | "error"; message?: string; injectText?: string }): Promise<void> {
		await this.service.sendCompileStatus({
			pdf_id: record.pdfId,
			running,
			continuous: options.continuous,
			...(options.severity === undefined ? {} : { severity: options.severity }),
			...(options.message === undefined ? {} : { message: options.message }),
			...(options.injectText === undefined ? {} : { inject_text: options.injectText }),
		});
	}
}

function installViewerCompileActions(service: ViewerHostMcpService, compileService: HostServiceCompileService): ViewerCompileActionsHandle {
	type ActiveCompile = { controller: AbortController; generation: number };
	const active = new Map<number, ActiveCompile>();
	let nextGeneration = 0;
	let transitionQueue: Promise<void> = Promise.resolve();
	let closing = false;
	let cleanupTask: Promise<void> | undefined;
	const continuous = new ViewerContinuousLatexmkController(service);
	const runCompile = async (record: ViewerCompileRecord) => {
		if (active.has(record.pdfId) || continuous.has(record.pdfId)) return;
		const sourcePath = sourcePathForCompiledPdf(record.pdfPath);
		const sendStatus = async (running: boolean, options: { severity?: "info" | "error"; message?: string; injectText?: string } = {}) => {
			await service.sendCompileStatus({
				pdf_id: record.pdfId,
				running,
				continuous: false,
				...(options.severity === undefined ? {} : { severity: options.severity }),
				...(options.message === undefined ? {} : { message: options.message }),
				...(options.injectText === undefined ? {} : { inject_text: options.injectText }),
			});
		};
		const controller = new AbortController();
		const run: ActiveCompile = { controller, generation: ++nextGeneration };
		active.set(record.pdfId, run);
		try {
			await sendStatus(true);
			if (controller.signal.aborted || active.get(record.pdfId) !== run) return;
			const response = await compileService.compileLatexFileRequest({
				protocol_version: 1,
				request_id: `viewer-compile-${Date.now()}`,
				operation: "compile_latex_file",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: { cwd: record.workspaceCwd },
				details: { latex_file_path: sourcePath, open_pdf: true, reuse_existing: true },
			}, controller.signal);
			if (active.get(record.pdfId) !== run) return;
			active.delete(record.pdfId);
			if (response.status === "error") {
				const detail = viewerCompileErrorText(response.error ?? "compile failed", response.status_details as unknown as Record<string, unknown>);
				await sendStatus(false, { severity: "error", message: detail, injectText: detail });
			} else {
				await sendStatus(false);
			}
		} catch (error) {
			if (active.get(record.pdfId) !== run) return;
			active.delete(record.pdfId);
			if (!controller.signal.aborted) {
				const detail = error instanceof Error ? error.message : String(error);
				await sendStatus(false, { severity: "error", message: detail, injectText: detail });
			}
		}
	};
	const handleAction = async (message: ViewerHostCompileActionMessage, record: ViewerCompileRecord) => {
		if (closing) return;
		if (message.action === "status") {
			await service.sendCompileStatus({ pdf_id: record.pdfId, running: active.has(record.pdfId), continuous: continuous.has(record.pdfId) });
			return;
		}
		const sendStopped = async (notice?: string) => {
			await service.sendCompileStatus({ pdf_id: record.pdfId, running: false, continuous: false, ...(notice === undefined ? {} : { severity: "info", message: notice }) });
		};
		if (message.action === "stop") {
			active.get(record.pdfId)?.controller.abort(new Error("compile stopped by viewer"));
			active.delete(record.pdfId);
			if (!await continuous.stop(record.pdfId, "Continuous compilation deactivated.")) await sendStopped("Continuous compilation deactivated.");
			return;
		}
		if (message.action === "continuous_off") {
			if (!await continuous.stop(record.pdfId)) await service.sendCompileStatus({ pdf_id: record.pdfId, running: active.has(record.pdfId), continuous: false });
			return;
		}
		if (message.action === "continuous_on") {
			active.get(record.pdfId)?.controller.abort(new Error("compile superseded by continuous compilation"));
			active.delete(record.pdfId);
			await continuous.start(record);
			return;
		}
		void runCompile(record);
	};
	service.setCompileActionHandler((message, record) => {
		if (closing) return Promise.resolve();
		const transition = transitionQueue.then(() => handleAction(message, record), () => handleAction(message, record));
		transitionQueue = transition.catch(() => undefined);
		return transition;
	});
	return {
		stop: () => {
			if (cleanupTask) return cleanupTask;
			closing = true;
			for (const run of active.values()) run.controller.abort(new Error("MCP runtime stopped"));
			active.clear();
			const pendingTransitions = transitionQueue;
			cleanupTask = (async () => {
				await continuous.stopAll({ emitStatus: false });
				await pendingTransitions.catch(() => undefined);
			})();
			return cleanupTask;
		},
		hasContinuousCompileForSource: (sourcePath, cwd) => continuous.hasSource(sourcePath, cwd),
	};
}

function sourcePathForCompiledPdf(pdfPath: string): string {
	const extension = extname(pdfPath);
	return extension.toLowerCase() === ".pdf" ? `${pdfPath.slice(0, -extension.length)}.tex` : `${pdfPath}.tex`;
}

function normalizeContinuousSourcePath(sourcePath: string, cwd: string): string {
	return resolve(cwd, sourcePath.trim());
}

function viewerCompileErrorText(error: string, details: Record<string, unknown>): string {
	const source = typeof details.source === "string" ? basename(details.source) : "LaTeX source";
	const summary = typeof details.error_summary === "string" && details.error_summary.trim() ? `\n${details.error_summary.trim()}` : "";
	const log = typeof details.log === "string" && details.log.trim() ? `\nLog: ${details.log}` : "";
	return `${source}: ${error}${summary}${log}`.trim();
}

function continuousCompileErrorText(sourcePath: string, error: unknown, outputTail = ""): string {
	const message = error instanceof Error ? error.message : String(error);
	const tail = outputTail.trim() ? `\n${outputTail.trim().split(/\r?\n/).slice(-8).join("\n")}` : "";
	return `${basename(sourcePath)}: continuous compilation failed: ${message}${tail}`.trim();
}

function isNamedToolCallPayload(payload: string, name: string): boolean {
	try {
		const parsed: unknown = JSON.parse(payload);
		return isRecord(parsed) && parsed.method === "tools/call" && isRecord(parsed.params) && parsed.params.name === name;
	} catch {
		return false;
	}
}

function buildContinuousCompileActiveToolResponse(payload: string): unknown {
	let id: unknown = null;
	try {
		const parsed: unknown = JSON.parse(payload);
		if (isRecord(parsed) && (typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null)) id = parsed.id;
	} catch {}
	return {
		jsonrpc: "2.0",
		id,
		result: {
			content: [{ type: "text", text: "Continuous compilation is enabled by the user. Do not start or stop a separate compile; let the existing continuous latexmk process continue updating the viewer/PDF." }],
			details: { continuous_compile_active: true },
		},
	};
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

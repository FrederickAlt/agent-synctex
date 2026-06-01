import { createInterface, type Interface } from "node:readline";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolResponse } from "@mariozechner/pi-coding-agent";
import { Container, getCapabilities, getCellDimensions, getPngDimensions, Image, Text, type Component } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	calculateInlineDisplayColumns,
	mergeInlinePreviewArtifacts,
	rasterizePdfPages,
} from "./src/modules/preview/inline_preview.ts";
import { buildInlinePreviewToolPayload } from "./src/modules/preview/inline_preview_payload.ts";
import {
	safeInlinePreviewPngPath,
	inlinePreviewRenderStateFromDetails as lookupInlinePreviewRenderStateFromDetails,
	type InlinePreviewRenderState,
} from "./src/modules/preview/inline_preview_metadata.ts";
import { createTerminalRefreshPolicy } from "./src/modules/preview/terminal_refresh_policy.ts";
import { createInlinePreviewRenderer } from "./src/modules/preview/inline_preview_renderer.ts";
import {
	createShowLatexPreviewPipeline,
	type ShowLatexCallOptions,
	type ShowLatexCompiledPreview,
	type ShowLatexPreviewResult,
	type ShowLatexWorkspaceContext,
} from "./src/modules/preview/show_latex_pipeline.ts";
import { buildKittyPlaceholderImageRender, KittyPreviewInvalidationRegistry } from "./src/modules/preview/kitty_placeholder_image.ts";
import {
	clearPdfTrackerForContext,
	closeTrackedPdfForContext,
	contextSessionKey,
	describePdfJumpFailureContextForContext,
	jumpTrackedPdfForContext,
	openTrackedPdfForContext,
} from "./src/modules/pdf_session/pdf_session.ts";
import { SynctexCallbackServer, type SynctexCallbackConfig, type SynctexPasteTarget } from "./src/modules/synctex/synctex.ts";
import {
	HostServiceClient,
	type HostServiceCompileResponseDetails,
	type HostServiceCompileSnippetResponseDetails,
	type HostServiceOpenResponseDetails,
	defaultHostServiceSocketPath,
} from "./src/modules/host_service.ts";
import {
	createUniversalToolFacade,
	registerTracerTools,
	type TracerToolDefinition,
} from "./src/modules/pi_adapter/pi_adapter.ts";
import {
	createLatexFileCompileToolSupport,
	DEFAULT_LATEX_COMPILER,
	LATEX_COMPILERS,
	LoggedToolError,
	type LatexCompiler,
} from "./src/modules/latex/latex_file_compiler.ts";
interface McpEnvelope {
	jsonrpc?: "2.0";
	id?: string | number;
	result?: unknown;
	error?: {
		message?: string;
		code?: number;
	};
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface PipelineArtifactStatus {
	path: string;
	exists: boolean;
	size: number;
	mtime: number;
}

interface PipelineStatusSnapshot {
	pdf: PipelineArtifactStatus;
	ready: PipelineArtifactStatus;
}

const MCP_TMPDIR = process.env.MCP_TMPDIR ?? resolve(process.env.XDG_RUNTIME_DIR || process.env.HOME || process.cwd(), "show-latex");
const MCP_FIXED_PREVIEW_PDF_PATH = resolve(MCP_TMPDIR, "show-latex.pdf");
const LATEX_PREAMBLE_FILE_NAMES = ["preamble.tex", "praeamble.tex"] as const;
const LATEX_PREAMBLE_PATH = resolve(MCP_TMPDIR, "preamble.tex");
const REQUEST_TIMEOUT_DEFAULT_MS = 60_000;
const STARTUP_TIMEOUT_DEFAULT_MS = 5_000;
const STARTUP_TIMEOUT_MAX_MS = 120_000;
const MCP_SHUTDOWN_TERM_TIMEOUT_MS = 1_000;
const MCP_SHUTDOWN_KILL_TIMEOUT_MS = 1_000;
const TMUX_COMMAND_TIMEOUT_MS = 1_000;
const HOST_SERVICE_CALLBACK_TARGET_PREFIX = "pi";
const HOST_SERVICE_SESSION_ENV_VAR = "PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH";
const HOST_SERVICE_REQUEST_TIMEOUT_MS = 5_000;

function debugLog(..._parts: unknown[]): void {
	// Debug logging is intentionally disabled; this extension has no environment-driven configuration.
}

function logShutdownTimeout(message: string): void {
	console.error(`[pdf-preview] ${message}`);
}

function waitForVoidWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolveWait) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolveWait(false);
		}, timeoutMs);
		timer.unref?.();
		promise.then(
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolveWait(true);
			},
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolveWait(true);
			},
		);
	});
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function ensurePreviewTmpdirAccessible(): void {
	try {
		if (!existsSync(MCP_TMPDIR)) {
			mkdirSync(MCP_TMPDIR, { recursive: true, mode: 0o700 });
		}
		accessSync(MCP_TMPDIR, constants.F_OK | constants.R_OK | constants.W_OK | constants.X_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot access preview temp directory at ${MCP_TMPDIR}: ${message}`);
	}
}

function findPreambleFile(directory: string): string | null {
	for (const fileName of LATEX_PREAMBLE_FILE_NAMES) {
		const candidate = resolve(directory, fileName);
		if (existsSync(candidate)) return candidate;
	}

	return null;
}

function writeLatexPreambleToTmpdir(latexPreamble: string): number {
	ensurePreviewTmpdirAccessible();
	const preamble = latexPreamble.trim();
	writeFileSync(LATEX_PREAMBLE_PATH, preamble ? `${preamble}\n` : "", { mode: 0o600 });
	return preamble.length;
}

function initializeLatexPreambleFile(): void {
	const cwdPreambleFile = findPreambleFile(process.cwd());
	if (!cwdPreambleFile) {
		ensurePreviewTmpdirAccessible();
		return;
	}

	try {
		const preamble = readFileSync(cwdPreambleFile, "utf8");
		writeLatexPreambleToTmpdir(preamble);
		debugLog(`copied cwd ${basename(cwdPreambleFile)} to ${LATEX_PREAMBLE_PATH}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to copy cwd preamble ${cwdPreambleFile} to ${LATEX_PREAMBLE_PATH}: ${message}`);
	}
}

const latexFileCompileToolSupport = createLatexFileCompileToolSupport();

function resolveLatexCompiler(compiler: unknown): LatexCompiler | undefined {
	return latexFileCompileToolSupport.resolveLatexCompiler(compiler);
}

function resolveLatexFilePath(latexFilePath: string, cwd = process.cwd()): string {
	return latexFileCompileToolSupport.resolveLatexFilePath(latexFilePath, cwd);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function errorDetails(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message;
	return String(error);
}

function tailText(text: string, limit = 12000): string {
	return text.length <= limit ? text : `...\n${text.slice(-limit)}`;
}

function lastLines(text: string, count = 5): string {
	return text
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.slice(-count)
		.join("\n");
}

function latexErrorLogPath(prefix: string): string {
	const safePrefix = prefix.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "latex";
	mkdirSync(MCP_TMPDIR, { recursive: true, mode: 0o700 });
	return resolve(MCP_TMPDIR, `${safePrefix}.${process.pid}.${Date.now()}.log`);
}

function writeLatexToolErrorLog(
	toolName: string,
	title: string,
	context: Record<string, unknown>,
	error: unknown,
): string {
	const tempLogPath = latexErrorLogPath(toolName);
	const contextLines = Object.entries(context)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${key}: ${String(value)}`);
	const sections = [
		title,
		...contextLines,
		"\n--- error ---",
		errorDetails(error),
	];

	writeFileSync(tempLogPath, `${sections.join("\n")}\n`, { mode: 0o600 });
	return tempLogPath;
}

const LATEX_ERROR_TAIL_LINES = 20;

function shortFailureMessage(shortMessage: string, logPath: string, tail: string): string {
	const tailLines = lastLines(tail, LATEX_ERROR_TAIL_LINES);
	return tailLines
		? `${shortMessage}. Log: ${logPath}\nLast ${LATEX_ERROR_TAIL_LINES} lines:\n${tailLines}`
		: `${shortMessage}. Log: ${logPath}`;
}

function latexToolFailure(
	toolName: string,
	shortMessage: string,
	context: Record<string, unknown>,
	error: unknown,
): Error {
	if (error instanceof LoggedToolError) return error;

	try {
		const tempLogPath = writeLatexToolErrorLog(toolName, shortMessage, context, error);
		const tail = lastLines(errorMessage(error), LATEX_ERROR_TAIL_LINES);
		return new LoggedToolError(shortFailureMessage(shortMessage, tempLogPath, tail), tempLogPath, tail);
	} catch (logError) {
		const message = logError instanceof Error ? logError.message : String(logError);
		return new Error(`${shortMessage}. Could not write temp log: ${message}`);
	}
}
function resolveMcpScriptPath(): string {
	const candidates: string[] = [];

	try {
		const extDir = dirname(fileURLToPath(new URL("./", import.meta.url)));
		candidates.push(resolve(extDir, "scripts", "show_latex_mcp.py"));
	} catch {
		// extension root detection unavailable in this runtime mode
	}

	candidates.push(resolve(process.cwd(), "scripts", "show_latex_mcp.py"));
	candidates.push(resolve(process.cwd(), ".pi", "extensions", "pdf-preview", "scripts", "show_latex_mcp.py"));
	candidates.push(resolve(homedir(), ".pi", "agent", "extensions", "pdf-preview", "scripts", "show_latex_mcp.py"));
	candidates.push(resolve(homedir(), "projects", "AI", "pi_extensions", "pdf-preview", "scripts", "show_latex_mcp.py"));

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	return candidates[0] ?? "/tmp/show_latex_mcp.py";
}

function resolveSynctexCallbackScriptPath(): string {
	const candidates: string[] = [];

	try {
		const extDir = dirname(fileURLToPath(new URL("./", import.meta.url)));
		candidates.push(resolve(extDir, "scripts", "pi_synctex_callback.mjs"));
	} catch {
		// extension root detection unavailable in this runtime mode
	}

	candidates.push(resolve(process.cwd(), "scripts", "pi_synctex_callback.mjs"));
	candidates.push(resolve(process.cwd(), ".pi", "extensions", "pdf-preview", "scripts", "pi_synctex_callback.mjs"));
	candidates.push(resolve(homedir(), ".pi", "agent", "extensions", "pdf-preview", "scripts", "pi_synctex_callback.mjs"));

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	return candidates[0] ?? "/tmp/pi_synctex_callback.mjs";
}

function synctexPasteTarget(ctx: ExtensionContext): SynctexPasteTarget {
	return {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
	};
}

class ShowLatexMcpClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private lineReader: Interface | null = null;
	private started: Promise<void> | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private nextId = 1;
	private initialized = false;

	private readonly requestTimeoutMs: number;
	private readonly startupTimeoutMs: number;

	constructor(
		private readonly pythonPath: string,
		private readonly scriptPath: string,
	) {
		this.requestTimeoutMs = REQUEST_TIMEOUT_DEFAULT_MS;
		this.startupTimeoutMs = Math.min(STARTUP_TIMEOUT_DEFAULT_MS, STARTUP_TIMEOUT_MAX_MS);

		debugLog(
			"show_latex MCP client config",
			`requestTimeoutMs=${this.requestTimeoutMs}`,
			`startupTimeoutMs=${this.startupTimeoutMs}`,
			`scriptPath=${this.scriptPath}`,
		);
	}

	async initialize(): Promise<void> {
		await this.ensureStarted();
		if (this.initialized) return;
		await this.sendRequest("initialize", undefined);
		this.initialized = true;
	}

	async callShowLatex(
		latexSource: string,
		compiler?: LatexCompiler,
		synctexEditorCommand?: string,
		signal?: AbortSignal,
		options: ShowLatexCallOptions = {},
	): Promise<ShowLatexPreviewResult> {
		await this.initialize();
		const requestStartedMs = Date.now();
		let beforeStatus: PipelineStatusSnapshot | null = null;
		try {
			beforeStatus = await this.getShowLatexStatus(signal);
		} catch (error) {
			debugLog(
				`pre-check status unavailable; will validate with post-check only: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const argumentsPayload: Record<string, unknown> = { latex_source: latexSource };
		if (compiler) argumentsPayload.compiler = compiler;
		if (synctexEditorCommand) argumentsPayload.synctex_editor_command = synctexEditorCommand;
		if (options.writeReady !== undefined) argumentsPayload.write_ready = options.writeReady;
		if (options.writeFixed !== undefined) argumentsPayload.write_fixed = options.writeFixed;

		const result = await this.sendRequest(
			"tools/call",
			{
				name: "show_latex",
				arguments: argumentsPayload,
			},
			signal,
		);

		if (typeof result !== "object" || result === null) {
			throw new Error("Invalid MCP result shape");
		}

		const resultObj = result as {
			isError?: boolean;
			content?: Array<{ text?: unknown }>;
			details?: { pdf?: unknown };
		};
		if (resultObj.isError) {
			const text = this.extractText(resultObj);
			throw new Error(text || "MCP tool call failed");
		}

		const text = this.extractText(resultObj);
		if (!text) {
			throw new Error("MCP response missing text content");
		}

		const afterStatus = await this.getShowLatexStatus(signal);
		const pdfPath = typeof resultObj.details?.pdf === "string"
			? resultObj.details.pdf
			: afterStatus?.pdf.path;
		if (!pdfPath) {
			throw new Error("Unable to verify preview PDF after MCP call.");
		}

		if (options.writeReady === false) {
			this.verifyPreviewPdfUpdated(pdfPath, requestStartedMs);
		} else {
			if (!afterStatus) {
				throw new Error("Unable to verify preview artifacts after MCP call.");
			}
			this.verifyPreviewArtifactsUpdated(beforeStatus, afterStatus, requestStartedMs);
		}

		return { text, pdfPath };
	}

	private async getShowLatexStatus(signal?: AbortSignal): Promise<PipelineStatusSnapshot | null> {
		const result = await this.sendRequest(
			"tools/call",
			{
				name: "show_latex_status",
				arguments: {},
			},
			signal,
		);

		if (typeof result !== "object" || result === null) {
			debugLog("show_latex_status returned invalid payload");
			return null;
		}

		const resultObj = result as { isError?: boolean; content?: Array<{ text?: unknown }> };
		if (resultObj.isError) {
			const statusError = this.extractText(resultObj);
			debugLog(`show_latex_status reported error: ${statusError}`);
			return null;
		}

		const text = this.extractText(resultObj);
		if (!text) {
			debugLog("show_latex_status response was empty");
			return null;
		}

		try {
			return this.parsePipelineStatus(text);
		} catch (error) {
			debugLog(`show_latex_status parse failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	private parsePipelineStatus(statusText: string): PipelineStatusSnapshot {
		const pdf = this.parseArtifactStatus(statusText, "pdf");
		const ready = this.parseArtifactStatus(statusText, "ready");

		return { pdf, ready };
	}

	private parseArtifactStatus(statusText: string, artifact: "pdf" | "ready"): PipelineArtifactStatus {
		const line = statusText
			.split(/\r?\n/)
			.find((entry) => entry.startsWith(`${artifact}=`));
		if (!line) {
			throw new Error(`show_latex_status output missing ${artifact} line`);
		}

		const pathMatch = line.match(/^[^=]+=(.*?)(?: exists| missing)(?: |$)/);
		if (!pathMatch) {
			throw new Error(`Could not parse ${artifact} path from status line: ${line}`);
		}
		const artifactPath = pathMatch[1];

		if (line.includes(" missing")) {
			return { path: artifactPath, exists: false, size: 0, mtime: 0 };
		}

		const sizeMatch = line.match(/size=(\d+)/);
		const mtimeMatch = line.match(/mtime=(-?\d+)/);
		if (!sizeMatch || !mtimeMatch) {
			throw new Error(`Could not parse ${artifact} status line: ${line}`);
		}

		const size = Number.parseInt(sizeMatch[1], 10);
		const mtime = Number.parseInt(mtimeMatch[1], 10);
		if (!Number.isFinite(size) || !Number.isFinite(mtime)) {
			throw new Error(`Could not parse numeric values from ${artifact} status line: ${line}`);
		}

		return { path: artifactPath, exists: true, size, mtime };
	}

	private verifyPreviewPdfUpdated(pdfPath: string, requestStartedMs: number): void {
		let stat;
		try {
			stat = statSync(pdfPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`LaTeX preview failed: PDF file was not produced at ${pdfPath}: ${message}`);
		}
		if (!stat.isFile() || stat.size <= 0) {
			throw new Error(`LaTeX preview failed: PDF file was not produced at ${pdfPath}.`);
		}

		const startedSecond = Math.floor(requestStartedMs / 1000);
		const pdfMtimeSecond = Math.floor(stat.mtimeMs / 1000);
		if (pdfMtimeSecond < startedSecond) {
			throw new Error("LaTeX preview failed: produced PDF is older than the current request.");
		}
	}

	private verifyPreviewArtifactsUpdated(
		beforeStatus: PipelineStatusSnapshot | null,
		afterStatus: PipelineStatusSnapshot,
		requestStartedMs: number,
	): void {
		this.verifyPreviewPdfUpdated(afterStatus.pdf.path, requestStartedMs);
		if (!afterStatus.ready.exists || afterStatus.ready.size <= 0) {
			throw new Error("LaTeX preview failed: ready marker was not produced.");
		}

		const startedSecond = Math.floor(requestStartedMs / 1000);
		if (afterStatus.pdf.mtime < startedSecond) {
			throw new Error("LaTeX preview failed: produced PDF is older than the current request.");
		}
		if (afterStatus.ready.mtime < startedSecond) {
			throw new Error("LaTeX preview failed: ready marker is older than the current request.");
		}

		if (beforeStatus && beforeStatus.pdf.mtime === afterStatus.pdf.mtime
			&& beforeStatus.pdf.size === afterStatus.pdf.size
			&& beforeStatus.ready.mtime === afterStatus.ready.mtime
			&& beforeStatus.ready.size === afterStatus.ready.size) {
			throw new Error("LaTeX preview failed: backend did not refresh preview artifacts.");
		}
	}

	async shutdown(): Promise<void> {
		if (!this.child) return;

		const child = this.child;
		this.child = null;
		this.initialized = false;
		this.started = null;

		this.rejectAll(new Error("MCP service stopped"));

		this.lineReader?.removeAllListeners();
		this.lineReader?.close();
		this.lineReader = null;
		child.removeAllListeners("error");
		child.removeAllListeners("close");

		const closePromise = new Promise<void>((resolveClose) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolveClose();
				return;
			}
			child.once("close", () => resolveClose());
		});

		debugLog(`shutting down MCP helper pid=${child.pid}`);
		try {
			child.stdin.end();
		} catch {
			// Ignore best-effort stdin shutdown failures.
		}
		child.kill("SIGTERM");
		if (await waitForVoidWithTimeout(closePromise, MCP_SHUTDOWN_TERM_TIMEOUT_MS)) return;

		logShutdownTimeout(`MCP helper pid=${child.pid ?? "unknown"} did not exit within ${MCP_SHUTDOWN_TERM_TIMEOUT_MS}ms after SIGTERM; sending SIGKILL`);
		child.kill("SIGKILL");
		if (await waitForVoidWithTimeout(closePromise, MCP_SHUTDOWN_KILL_TIMEOUT_MS)) return;

		logShutdownTimeout(`MCP helper pid=${child.pid ?? "unknown"} did not exit within ${MCP_SHUTDOWN_KILL_TIMEOUT_MS}ms after SIGKILL; destroying stdio handles`);
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		child.unref();
	}

	private async ensureStarted(): Promise<void> {
		if (this.started) {
			await this.started;
			return;
		}
		this.started = this.startProcess();
		await this.started;
	}

	private async startProcess(): Promise<void> {
		if (this.child) return;

		ensurePreviewTmpdirAccessible();
		if (!existsSync(this.scriptPath)) {
			this.started = null;
			throw new Error(`MCP script not found: ${this.scriptPath}`);
		}

		return new Promise((resolve, reject) => {
			const child = spawn(this.pythonPath, [this.scriptPath], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;

			if (!child.stdout || !child.stdin || !child.stderr) {
				this.started = null;
				this.child = null;
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore cleanup errors
				}
				reject(new Error("MCP process missing stdio streams"));
				return;
			}

			let settled = false;
			let startupTimer: ReturnType<typeof setTimeout> | null = null;

			const finalize = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (startupTimer) {
					clearTimeout(startupTimer);
					startupTimer = null;
				}
				if (error) {
					this.rejectAll(error);
					this.initialized = false;
					this.child = null;
					this.started = null;
					try {
						child.kill("SIGTERM");
					} catch {
						// ignore cleanup errors
					}
					reject(error);
					return;
				}

				debugLog(`MCP helper ready pid=${child.pid}`);
				resolve();
			};

			const onClose = () => {
				if (!settled) {
					fail(new Error("MCP process exited during startup"));
					return;
				}

				this.rejectAll(new Error("MCP process closed"));
				this.initialized = false;
				this.child = null;
				this.started = null;
			};

			const fail = (err: Error) => {
				debugLog(`MCP startup failed: ${err.message}`);
				finalize(err);
			};

			child.once("error", fail);
			child.once("close", onClose);
			child.once("spawn", () => {
				debugLog(`MCP helper spawned pid=${child.pid}`);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8").trim();
				if (text) {
					debugLog("MCP stderr:", text);
				}
			});

			this.lineReader?.removeAllListeners();
			this.lineReader?.close();
			this.lineReader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
			this.lineReader.on("line", (line) => this.handleLine(line));

			child.once("spawn", () => {
				setImmediate(() => {
					if (settled) return;
					finalize();
				});
			});

			startupTimer = setTimeout(() => {
				fail(new Error(`MCP process startup timed out after ${this.startupTimeoutMs}ms`));
			}, this.startupTimeoutMs);
		});
	}

	private async sendRequest(
		method: string,
		params: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (!this.child || !this.child.stdin.writable) {
			throw new Error("MCP service is not available");
		}

		const id = this.nextId++;
		const key = String(id);
		const payload = {
			jsonrpc: "2.0" as const,
			id,
			method,
			...(params ? { params } : {}),
		};

		const response = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new Error(
					`MCP request timed out after ${this.requestTimeoutMs}ms (method=${method}, id=${key})`,
				);
				debugLog(error.message);
				this.completeWithError(key, error);
				void this.shutdown();
			}, this.requestTimeoutMs);

			const pending: PendingRequest = {
				resolve,
				reject,
				timer,
				signal,
			};

			if (signal) {
				const onAbort = () => {
					const error = new Error("MCP request aborted");
					debugLog(`request aborted method=${method} id=${key}`);
					this.completeWithError(key, error);
				};
				pending.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}

			this.pending.set(key, pending);
		});

		try {
			await new Promise<void>((resolveWrite, rejectWrite) => {
				if (!this.child?.stdin) {
					rejectWrite(new Error("MCP service is not available"));
					return;
				}
				this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
					if (error) {
						rejectWrite(error);
						return;
					}
					resolveWrite();
				});
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.completeWithError(key, new Error(`Failed to send MCP request: ${message}`));
			throw error;
		}

		debugLog(`sent MCP request method=${method} id=${key}`);
		return response;
	}

	private handleLine(raw: string): void {
		const line = raw.trim();
		if (!line) return;

		let msg: McpEnvelope;
		try {
			msg = JSON.parse(line);
		} catch {
			debugLog("MCP stdout non-JSON line", line.slice(0, 500));
			return;
		}

		if (msg.id === undefined) {
			debugLog("MCP response missing id", line);
			return;
		}
		const pending = this.pending.get(String(msg.id));
		if (!pending) {
			debugLog("MCP response for unknown request", String(msg.id));
			return;
		}

		this.complete(pending, String(msg.id), msg);
	}

	private complete(pending: PendingRequest, key: string, msg: McpEnvelope): void {
		clearTimeout(pending.timer);
		this.pending.delete(key);

		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}

		if (msg.error) {
			pending.reject(new Error(msg.error.message || "MCP error"));
			return;
		}

		if (msg.result === undefined) {
			pending.reject(new Error("MCP response missing result"));
			return;
		}

		debugLog(`MCP request completed id=${key}`);
		pending.resolve(msg.result);
	}

	private completeWithError(key: string, error: Error): void {
		const pending = this.pending.get(key);
		if (!pending) return;

		clearTimeout(pending.timer);
		this.pending.delete(key);

		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}

		debugLog(`MCP request failed id=${key}: ${error.message}`);
		pending.reject(error);
	}

	private rejectAll(error: Error): void {
		for (const [key] of this.pending.entries()) {
			this.completeWithError(key, error);
		}
	}

	private extractText(resultObj: { content?: Array<{ text?: unknown }> }): string {
		if (!Array.isArray(resultObj.content)) return "";

		return resultObj.content
			.map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
			.filter((text) => text.length > 0)
			.join("\n");
	}
}

const MCP_SCRIPT_PATH = resolveMcpScriptPath();
const SYNCTEX_CALLBACK_SCRIPT_PATH = resolveSynctexCallbackScriptPath();
const mcpClient = new ShowLatexMcpClient("python3", MCP_SCRIPT_PATH);
function hostServiceClientConfig() {
	return {
		socketPath: process.env[HOST_SERVICE_SESSION_ENV_VAR] ?? defaultHostServiceSocketPath(),
		requestTimeoutMs: HOST_SERVICE_REQUEST_TIMEOUT_MS,
	};
}
const hostServiceSessionTargets = new Map<string, { targetId: string; workspaceContext: { cwd: string; session_id?: string }; socketPath: string }>();
const tmuxKittyPreviewInvalidationRegistry = new KittyPreviewInvalidationRegistry();
const terminalRefreshPolicy = createTerminalRefreshPolicy({
	adapter: {
		isTmuxKittyTerminal: isTmuxKittyTerminal,
		runTmux: runTmux,
		writeOutput: (sequence: string) => {
			process.stdout.write(sequence);
		},
		onSignal: (signal, handler) => {
			process.on(signal, handler);
			return () => process.off(signal, handler);
		},
	},
	invalidatorRegistry: tmuxKittyPreviewInvalidationRegistry,
});
const inlinePreviewRenderStates = new Map<string, InlinePreviewRenderState>();
const MAX_INLINE_PREVIEW_RENDER_STATES = 8;
const synctexCallbacksByContext = new Map<string, SynctexCallbackServer>();
const synctexCallbackServers = new Set<SynctexCallbackServer>();

function rememberInlinePreviewRenderState(state: InlinePreviewRenderState): string {
	const id = randomUUID();
	inlinePreviewRenderStates.set(id, state);
	while (inlinePreviewRenderStates.size > MAX_INLINE_PREVIEW_RENDER_STATES) {
		const oldest = inlinePreviewRenderStates.keys().next().value;
		if (oldest === undefined) break;
		inlinePreviewRenderStates.delete(oldest);
	}
	return id;
}

function inlinePreviewRenderStateFromDetails(details: Record<string, unknown>): InlinePreviewRenderState | null {
	return lookupInlinePreviewRenderStateFromDetails(details, (previewId) => inlinePreviewRenderStates.get(previewId));
}
function callbackKeyForContext(ctx: ExtensionContext): string {
	return contextSessionKey(ctx);
}

function hostServiceSocketPath(): string {
	return hostServiceClientConfig().socketPath;
}

function hostServiceTargetId(ctx: ExtensionContext): string {
	return `${HOST_SERVICE_CALLBACK_TARGET_PREFIX}:${callbackKeyForContext(ctx)}`;
}

function hostServiceWorkspaceContextForSession(ctx: ExtensionContext): { cwd: string; session_id?: string } {
	const context: { cwd: string; session_id?: string } = {
		cwd: ctx.cwd,
	};
	const rawSessionId = (ctx as { session_id?: unknown }).session_id;
	if (typeof rawSessionId === "string" && rawSessionId.length > 0) {
		context.session_id = rawSessionId;
	}
	return context;
}

function hostServiceWorkspaceContextForRequest(ctx?: ExtensionContext): { cwd: string; session_id?: string } {
	if (ctx) {
		return hostServiceWorkspaceContextForSession(ctx);
	}
	return { cwd: process.cwd() };
}

function hostServiceWorkspaceContextForShowLatex(ctx?: ExtensionContext): { cwd: string; workspace_root?: string; session_id?: string } {
	const context = hostServiceWorkspaceContextForRequest(ctx);
	return {
		...context,
		workspace_root: MCP_TMPDIR,
	};
}

async function ensureHostServiceCallbackTarget(ctx: ExtensionContext): Promise<string> {
	const contextKey = callbackKeyForContext(ctx);
	const targetId = hostServiceTargetId(ctx);
	const workspaceContext = hostServiceWorkspaceContextForSession(ctx);
	if (hostServiceSessionTargets.has(contextKey)) {
		const client = new HostServiceClient({
			socketPath: hostServiceSocketPath(),
			requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
		});
		try {
			const resolved = await client.requestResolveCallbackTarget(workspaceContext, targetId);
			if (resolved.callback_available) {
				return targetId;
			}
		} catch {
			// Fall back to re-registering the callback target if possible.
		}
	}
	await registerHostServiceCallbackTarget(ctx);
	return targetId;
}

function notifyHostServiceError(ctx: ExtensionContext, operation: string, error: unknown): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`Host Service ${operation} failed: ${errorMessage(error)}. Expected socket ${hostServiceSocketPath()}`, "error");
}

async function registerHostServiceCallbackTarget(ctx: ExtensionContext): Promise<void> {
	const contextKey = callbackKeyForContext(ctx);
	const targetId = hostServiceTargetId(ctx);
	const workspaceContext = hostServiceWorkspaceContextForSession(ctx);
	const callbackServer = await ensureSynctexCallbacks(ctx);
	const socketPath = hostServiceSocketPath();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
	});
	await client.requestStatus(workspaceContext);
	await client.requestRegisterCallbackTarget(workspaceContext, {
		target_id: targetId,
		target: callbackServer.callbackConfig,
	});
	hostServiceSessionTargets.set(contextKey, {
		targetId,
		workspaceContext,
		socketPath,
	});
}

async function unregisterHostServiceCallbackTarget(contextKey: string): Promise<void> {
	const registration = hostServiceSessionTargets.get(contextKey);
	if (!registration) return;
	hostServiceSessionTargets.delete(contextKey);
	const client = new HostServiceClient({
		socketPath: registration.socketPath,
		requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
	});
	await client.requestUnregisterCallbackTarget(registration.workspaceContext, registration.targetId);
}

async function unregisterAllHostServiceCallbacks(): Promise<void> {
	const contextKeys = [...hostServiceSessionTargets.keys()];
	await Promise.allSettled(contextKeys.map((contextKey) => unregisterHostServiceCallbackTarget(contextKey)));
}

function createSynctexCallbackServer(): SynctexCallbackServer {
	return new SynctexCallbackServer({ callbackScriptPath: SYNCTEX_CALLBACK_SCRIPT_PATH, tmpDir: MCP_TMPDIR });
}

async function rotateSynctexCallbacks(ctx: ExtensionContext): Promise<SynctexCallbackServer> {
	const key = callbackKeyForContext(ctx);
	const previous = synctexCallbacksByContext.get(key);
	const next = createSynctexCallbackServer();
	synctexCallbacksByContext.set(key, next);
	synctexCallbackServers.add(next);
	if (previous) synctexCallbackServers.delete(previous);
	await previous?.close();
	await next.ensureStarted(synctexPasteTarget(ctx));
	return next;
}

async function ensureSynctexCallbacks(ctx: ExtensionContext): Promise<SynctexCallbackServer> {
	const key = callbackKeyForContext(ctx);
	let server = synctexCallbacksByContext.get(key);
	if (!server) {
		server = createSynctexCallbackServer();
		synctexCallbacksByContext.set(key, server);
		synctexCallbackServers.add(server);
	}
	await server.ensureStarted(synctexPasteTarget(ctx));
	return server;
}

async function shutdownSynctexCallbacks(ctx?: ExtensionContext): Promise<void> {
	if (ctx) {
		const key = callbackKeyForContext(ctx);
		const server = synctexCallbacksByContext.get(key);
		if (!server) return;
		synctexCallbacksByContext.delete(key);
		synctexCallbackServers.delete(server);
		await server.close();
		return;
	}

	const servers = [...synctexCallbackServers];
	synctexCallbacksByContext.clear();
	synctexCallbackServers.clear();
	await Promise.all(servers.map((server) => server.close()));
}

const LatexCompilerParam = Type.Optional(Type.Union(
	LATEX_COMPILERS.map((compiler) => Type.Literal(compiler)),
	{
		description: `Optional LaTeX compiler. Defaults to ${DEFAULT_LATEX_COMPILER}.`,
		default: DEFAULT_LATEX_COMPILER,
	},
));

const ShowLatexParams = Type.Object(
	{
		source: Type.String({
			description: "Raw LaTeX source code to compile. Prefer passing this tool as FREEFORM/raw text. Optional leading front matter can set compiler and inline, for example: ---\ncompiler: lualatex\ninline: false\n---",
			minLength: 1,
		}),
		compiler: LatexCompilerParam,
		inline: Type.Optional(Type.Boolean({
			description: "When true, rasterize the compiled PDF and show it inline in the Pi TUI instead of requesting a host-service external preview. Defaults to true.",
			default: true,
		})),
	},
	{ additionalProperties: false },
);

const CompileLatexFileParams = Type.Object(
	{
		latex_file_path: Type.String({
			description: "Path to a local LaTeX source file to compile in its own directory. Relative \\input, \\include, graphics, bibliography, and other project files are resolved from the file's directory by the LaTeX compiler.",
			minLength: 1,
		}),
		compiler: LatexCompilerParam,
		open_pdf: Type.Optional(Type.Boolean({
			description: "When true, request the host service to open and track the compiled PDF after successful compilation. Defaults to false.",
			default: false,
		})),
		clean: Type.Optional(Type.Boolean({
			description: "When true, remove common LaTeX artifacts for this source file's basename before compiling, including the previous PDF and SyncTeX sidecar. Defaults to false.",
			default: false,
		})),
	},
	{ additionalProperties: false },
);

const OpenPdfParams = Type.Object(
	{
		pdf_file_path: Type.String({
			description: "Path to an existing local PDF file to send to the host service for opening/tracking and later SyncTeX actions.",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

const ClosePdfParams = Type.Object(
	{
		pdf_id: Type.Number({
			description: "Host-service PDF ID returned by open_pdf or compile_latex_file(..., open_pdf=true).",
			minimum: 1,
		}),
	},
	{ additionalProperties: false },
);

const JumpPdfParams = Type.Object(
	{
		pdf_id: Type.Number({
			description: "Host-service PDF ID returned by open_pdf or compile_latex_file(..., open_pdf=true). Arbitrary PDF paths are not accepted.",
			minimum: 1,
		}),
		line: Type.Number({
			description: "1-based line in the selected source file. If source_file is provided, this line is interpreted within that file.",
			minimum: 1,
		}),
		source_file: Type.Optional(Type.String({
			description: "Optional source file for the SyncTeX jump. When the target is in a file included via \\input, \\include, or similar, pass that included .tex file and use a line number from that file, not the parent file's include line.",
			minLength: 1,
		})),
	},
	{ additionalProperties: false },
);

const SetLatexPreambleParams = Type.Object(
	{
		latex_preamble: Type.String({
			description: "LaTeX preamble lines to write to ${XDG_RUNTIME_DIR}/show-latex/preamble.tex and include before \\begin{document} for show_latex snippet compiles. This overwrites the active temp preamble; if a project preamble was copied there at startup, this makes the active preview preamble diverge from the project's real ./preamble.tex. Use only for pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. Use an empty string to clear it only when intentionally clearing the active preview preamble.",
		}),
	},
	{ additionalProperties: false },
);

const showLatexPreviewPipeline = createShowLatexPreviewPipeline({
	resolveLatexCompiler,
	callShowLatex: async (latexSource, compiler, _synctexEditorCommand, signal, options) => {
		const workspaceContext = options?.workspaceContext ?? hostServiceWorkspaceContextForRequest(undefined);
		const client = new HostServiceClient({
			socketPath: hostServiceSocketPath(),
			requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
		});
		const compileResult = await client.requestCompileLatexSnippet(
			{
				latex_source: latexSource,
				compiler: compiler,
				...(options?.suppressPageNumbers === true ? { suppress_page_numbers: true } : {}),
				...(options?.cropToContent === true ? { crop_to_content: true } : {}),
			},
			workspaceContext,
			signal,
		);
		return { text: "ok", pdfPath: compileResult.pdf, sourcePath: compileResult.source };
	},
	rememberInlinePreviewRenderState,
	rasterizePdfPages: async (pdfPath, options) => {
		const client = new HostServiceClient({
			socketPath: hostServiceSocketPath(),
			requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
		});
		const rasterResult = await client.requestRasterizePdf(
			{ pdf_path: pdfPath },
			options?.workspaceContext ?? hostServiceWorkspaceContextForRequest(undefined),
			options?.signal,
		);
		return rasterResult.artifacts;
	},
	mergeInlinePreviewArtifacts,
	buildInlinePreviewToolPayload,
});

function prepareShowLatexArguments(args: unknown): Record<string, unknown> {
	return showLatexPreviewPipeline.prepareShowLatexArguments(args);
}

async function executeShowLatexPreviewTool(
	toolName: string,
	latexSourceInput: string,
	compilerParam: unknown,
	inlineParam: unknown,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext | undefined,
): Promise<ToolResponse> {
	let latexSource = "";
	let compiler: LatexCompiler | undefined;
	let synctexCommand = "";
	let previewPdfPath = "";
	let preview: ShowLatexCompiledPreview;
	let inline = true;
	const workspaceContext = hostServiceWorkspaceContextForShowLatex(ctx);

	try {
		latexSource = latexSourceInput;
		compiler = resolveLatexCompiler(compilerParam);
		inline = inlineParam !== false;
		if (!inline) {
			if (!ctx) {
				throw new Error("show_latex with inline=false requires a Pi agent session context");
			}
			const server = await ensureSynctexCallbacks(ctx);
			synctexCommand = server.command;
		}

		preview = await showLatexPreviewPipeline.compileAndPreviewLatex({
			latexSource,
			compiler,
			inline,
			signal,
			workspaceContext,
			synctexEditorCommand: inline ? undefined : synctexCommand,
		});
		previewPdfPath = preview.previewPdfPath;
	} catch (error) {
		throw latexToolFailure(toolName, "LaTeX preview compilation failed", {
			compiler: compiler ?? compilerParam ?? DEFAULT_LATEX_COMPILER,
			inline,
			latex_source_length: latexSource.length,
			latex_source_tail: tailText(latexSource, 30000),
			pdf: previewPdfPath,
			fixed_preview_pdf: MCP_FIXED_PREVIEW_PDF_PATH,
		}, error);
	}

	if (preview.inline) {
		const inlineResult = await showLatexPreviewPipeline.buildInlinePreviewResult(preview, signal);
		return inlineResult.payload;
	}

	try {
		const callbackTargetId = await ensureHostServiceCallbackTarget(ctx!);
		const callbackConfig = (await ensureSynctexCallbacks(ctx!)).callbackConfig;
		if (previewPdfPath !== MCP_FIXED_PREVIEW_PDF_PATH) {
			ensurePreviewTmpdirAccessible();
			copyFileSync(previewPdfPath, MCP_FIXED_PREVIEW_PDF_PATH);
			copySynctexArtifactsForFixedPdfPath(previewPdfPath, MCP_FIXED_PREVIEW_PDF_PATH);
		}
		const openResponse = await openPdfThroughHostService(MCP_FIXED_PREVIEW_PDF_PATH, workspaceContext, callbackConfig, signal);
		if (openResponse.pdf_id === undefined) {
			throw new Error("Host service open response missing pdf_id");
		}
		let trackedPdf: Awaited<ReturnType<typeof openTrackedPdfForContext>>;
		const defaultSourceForPdf = preview.sourcePath ?? previewPdfPath;
		const trackedOpenResult = {
			pid: openResponse.pid,
			viewerHandle: openResponse.handle,
			viewerBackend: openResponse.backend,
			viewerOwned: openResponse.owned,
			viewerCapabilities: openResponse.capabilities,
			hostServicePdfId: openResponse.pdf_id,
			hostServiceSocketPath: hostServiceSocketPath(),
			hostServiceCallbackTargetId: callbackTargetId,
		};
		try {
			trackedPdf = await openTrackedPdfForContext(
				ctx,
				MCP_FIXED_PREVIEW_PDF_PATH,
				signal,
				async () => trackedOpenResult,
				defaultSourceForPdf,
				synctexCommand || undefined,
				{
					reuseTrackedPdf: false,
					pdfId: openResponse.pdf_id,
				},
			);
		} catch (error) {
			if (openResponse.pdf_id !== undefined) {
				await new HostServiceClient({
					socketPath: hostServiceSocketPath(),
					requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
				}).requestClosePdf(workspaceContext, openResponse.pdf_id, signal).catch(() => undefined);
			}
			throw error;
		}

		return {
			content: [{ type: "text", text: preview.text }],
			details: {
				pdf: trackedPdf.path,
				pdf_id: trackedPdf.id,
				operation_pdf: previewPdfPath,
				inline: false,
			},
		};
	} catch (error) {
		throw latexToolFailure(toolName, describeShowLatexHostServiceOpenFailure(error), {
			compiler: compiler ?? compilerParam ?? DEFAULT_LATEX_COMPILER,
			inline,
			latex_source_length: latexSource.length,
			latex_source_tail: tailText(latexSource, 30000),
			preview_pdf: previewPdfPath,
			fixed_preview_pdf: MCP_FIXED_PREVIEW_PDF_PATH,
			open_error: errorMessage(error),
			open_error_code: extractHostServiceErrorCode(error),
		}, error);
	}
}

function describeShowLatexHostServiceOpenFailure(error: unknown): string {
	const message = errorMessage(error).toLowerCase();
	const errorCode = extractHostServiceErrorCode(error);

	if (message.includes("viewer service request timed out") || message.includes("host service request timed out")) {
		return "Host service request timed out while opening preview";
	}
	if (errorCode === "backend_unavailable") {
		return "Host service backend unavailable while opening preview";
	}
	if (errorCode) {
		return `Host service unavailable while opening preview (code=${errorCode})`;
	}
	if (message.includes("viewer service unavailable") || message.includes("host service unavailable")) {
		return "Host service unavailable while opening preview";
	}
	return "Host service unavailable while opening preview";
}

function extractHostServiceErrorCode(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return /\(code=([^)]+)\)/.exec(message)?.[1];
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostServiceCompileErrorDetails(
	error: unknown,
): (HostServiceCompileResponseDetails | { operation?: string; source?: string; pdf?: string; clean?: boolean; cleaned_artifacts?: unknown; error_code?: string } ) | undefined {
	if (!error || typeof error !== "object") {
		return;
	}
	const statusDetails = "statusDetails" in error ? (error as { statusDetails?: unknown }).statusDetails : undefined;
	if (!isStringRecord(statusDetails)) {
		return;
	}
	if (typeof statusDetails.operation === "string" && !["compile_latex_file", "compile_latex_snippet"].includes(statusDetails.operation)) {
		return;
	}
	if (typeof statusDetails.source !== "string" || typeof statusDetails.pdf !== "string") {
		return;
	}
	return statusDetails as HostServiceCompileResponseDetails | HostServiceCompileSnippetResponseDetails | { operation?: string };
}

function stringsOrEmpty(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.every((entry) => typeof entry === "string") ? value : [];
}

function describeCompileFailureContext(
	requestedPath: string,
	compileResult: { source: string; pdf: string; clean: boolean; cleaned_artifacts: string[] } | undefined,
	error: unknown,
): { source: string; pdf: string; clean: boolean; cleaned_artifacts: string[] } {
	const details = hostServiceCompileErrorDetails(error);
	if (details) {
		return {
			source: typeof details.source === "string" ? details.source : requestedPath,
			pdf: typeof details.pdf === "string" ? details.pdf : "",
			clean: typeof details.clean === "boolean" ? details.clean : false,
			cleaned_artifacts: stringsOrEmpty(details.cleaned_artifacts),
		};
	}
	if (compileResult !== undefined) {
		return compileResult;
	}
	return {
		source: requestedPath,
		pdf: "",
		clean: false,
		cleaned_artifacts: [],
	};
}

function isOpenFailureFromCompileError(error: unknown): boolean {
	const details = hostServiceCompileErrorDetails(error);
	return typeof details?.pdf === "string" && details.pdf.length > 0 && details.error_code !== "compile_failed";
}

function copySynctexArtifactsForFixedPdfPath(sourcePdfPath: string, fixedPdfPath: string): void {
	const sourceBase = sourcePdfPath.toLowerCase().endsWith(".pdf") ? sourcePdfPath.slice(0, -4) : sourcePdfPath;
	const fixedBase = fixedPdfPath.toLowerCase().endsWith(".pdf") ? fixedPdfPath.slice(0, -4) : fixedPdfPath;
	for (const extension of [".synctex", ".synctex.gz"] as const) {
		const sourceArtifactPath = `${sourceBase}${extension}`;
		const fixedArtifactPath = `${fixedBase}${extension}`;
		if (existsSync(sourceArtifactPath)) {
			copyFileSync(sourceArtifactPath, fixedArtifactPath);
			continue;
		}
		if (existsSync(fixedArtifactPath)) {
			rmSync(fixedArtifactPath);
		}
	}
}

async function openPdfThroughHostService(
	pdfPath: string,
	workspaceContext: ShowLatexWorkspaceContext,
	callbackConfig: SynctexCallbackConfig,
	signal?: AbortSignal,
): Promise<HostServiceOpenResponseDetails> {
	const hostServiceClient = new HostServiceClient({
		socketPath: hostServiceSocketPath(),
		requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
	});
	return hostServiceClient.requestOpenPdf(
		workspaceContext,
		{
			pdf_path: pdfPath,
			callback: callbackConfig,
			reuse_existing: true,
			require_persistent_viewer: true,
		},
		signal,
	);
}

function resolvePositiveInteger(value: unknown, name: string): number {
	const numberValue = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(numberValue) || numberValue < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return numberValue;
}

function isTmuxKittyTerminal(): boolean {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase();
	const term = process.env.TERM?.toLowerCase();
	const insideTmux = Boolean(process.env.TMUX) || termProgram === "tmux" || Boolean(term?.startsWith("tmux")) || Boolean(term?.startsWith("screen"));
	return insideTmux && (Boolean(process.env.KITTY_WINDOW_ID) || termProgram === "kitty");
}

function runTmux(args: string[]): void {
	if (!process.env.TMUX) return;
	const result = spawnSync("tmux", args, { stdio: "ignore", timeout: TMUX_COMMAND_TIMEOUT_MS });
	const error = result.error as (Error & { code?: string }) | undefined;
	if (error?.code === "ETIMEDOUT") {
		logShutdownTimeout(`tmux ${args.join(" ")} timed out after ${TMUX_COMMAND_TIMEOUT_MS}ms`);
	}
}

const inlinePreviewRenderer = createInlinePreviewRenderer({
	readState: (details) => lookupInlinePreviewRenderStateFromDetails(details, (previewId) => inlinePreviewRenderStates.get(previewId)),
	imagePolicy: {
		canShowImages: (context) => {
			if (typeof context === "object" && context !== null && "showImages" in context && (context as { showImages?: unknown }).showImages === false) {
				return false;
			}
			return true;
		},
		terminalSupportsImages: () => Boolean(getCapabilities().images),
	},
	isTmuxKittyTerminal,
	readImageBase64: (pngPath) => {
		const safePath = safeInlinePreviewPngPath(pngPath);
		if (!safePath) return null;
		try {
			return readFileSync(safePath).toString("base64");
		} catch {
			return null;
		}
	},
	makeText: (text) => new Text(text, 0, 0),
	makeContainer: () => new Container(),
	makeInlineImage: (options) => new Image(options.base64Data, "image/png", { fallbackColor: options.fallbackColor }, {
		maxWidthCells: options.maxWidthCells,
		filename: options.filename,
	}),
	makeKittyPlaceholderImage: buildKittyPlaceholderImageRender,
	calculateDisplayColumns: calculateInlineDisplayColumns,
	getCellDimensions,
	getPngDimensions: (base64Data) => getPngDimensions(base64Data) ?? undefined,
	allocateImageId: () => Math.floor(Math.random() * 0xfffffe) + 1,
	rememberInvalidator: (context) => terminalRefreshPolicy.rememberInvalidator(context),
});

function renderInlineLatexPreview(result: { content?: Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>; details?: Record<string, unknown> }, theme: unknown, context: unknown): Component {
	return inlinePreviewRenderer.render({ result, theme, context }).component;
}

function renderShowLatexResult(result: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> }, _options: unknown, theme: unknown, context: unknown): Component {
	const details = result.details as Record<string, unknown> | undefined;
	if (details?.inline === true || details?.inline_previews || details?.inline_preview) {
		return renderInlineLatexPreview(result, theme, context);
	}

	const text = result.content?.map((entry) => entry.text ?? "").filter(Boolean).join("\n") ?? "ok";
	return new Text(text, 0, 0);
}

export default function (pi: ExtensionAPI) {
	initializeLatexPreambleFile();

	pi.on("session_start", async (_event, ctx) => {
		terminalRefreshPolicy.cleanup();
		terminalRefreshPolicy.install({ hasUI: ctx.hasUI, ui: ctx.ui });

		try {
			await rotateSynctexCallbacks(ctx);
			await registerHostServiceCallbackTarget(ctx);
		} catch (error) {
			notifyHostServiceError(ctx, "startup", error);
			if (!ctx.hasUI) {
				console.error(`Host Service startup failed: ${errorMessage(error)}`);
			}
		}
	});

	pi.registerTool({
		name: "show_latex",
		label: "Show LaTeX",
		description: "FREEFORM/raw LaTeX preview. Pass LaTeX code directly; optional YAML-like front matter may set compiler and inline. Example: ---\ncompiler: lualatex\ninline: true\n---\n\\begin{equation}\nx\n\\end{equation}\nThe \\begin{document}...\\end{document} wrapper is accepted but not required. Defaults to inline preview with lualatex; set inline=false to request host-service external open instead.",
		promptSnippet: "FREEFORM LaTeX preview; optional front matter can set compiler and inline",
		promptGuidelines: [
			"Use show_latex when the user asks for a LaTeX PDF preview. Prefer passing only the LaTeX body, for example \\[x\\]; \\begin{document}...\\end{document} is accepted but usually unnecessary.",
			"Use optional front matter only when changing options, for example: ---\ncompiler: xelatex\ninline: false\n---",
			"show_latex renders inline by default; set inline=false only when the user wants an external viewer.",
			"Do not use verbatim-like LaTeX constructs (for example, \\begin{verbatim}, lstlisting, minted, or \\verb) to show the user LaTeX code; provide real LaTeX that compiles and renders the requested content.",
			"In an existing LaTeX project, assume ./preamble.tex or ./praeamble.tex has already been copied into ${XDG_RUNTIME_DIR}/show-latex/preamble.tex. Do not add a standalone \\documentclass or repeat the project preamble unless the user explicitly asks.",
			"If a project snippet preview fails, inspect the log and project preamble, or restore the project preamble in ${XDG_RUNTIME_DIR}/show-latex/preamble.tex. Do not call set_latex_preamble with a minimal preamble as a workaround unless the user explicitly asks to change the active preview preamble.",
		],
		renderShell: "self",
		parameters: ShowLatexParams,
		prepareArguments: prepareShowLatexArguments,
		renderResult: renderShowLatexResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parsed = showLatexPreviewPipeline.parseShowLatexInput(String(params.source ?? ""));
			return executeShowLatexPreviewTool("show-latex", parsed.latexSource, params.compiler ?? parsed.compiler, params.inline ?? parsed.inline, signal, ctx);
		},
	});

	pi.registerTool({
		name: "open_pdf",
		label: "Open PDF",
		description: "Open an existing local PDF through the host service and track it for later SyncTeX actions. Returns a host-service pdf_id for this Pi session. Opening the same PDF path again reuses the existing tracked or visible viewer where practical. The viewer is configured with this session's inverse SyncTeX callback so PDF clicks paste source references into the interactive editor without submitting.",
		promptSnippet: "Open and track a local PDF through the host service",
		promptGuidelines: [
			"Use open_pdf when the user asks to view an existing PDF or when you need a pdf_id for later PDF actions.",
			"Pass an existing local PDF path. The returned pdf_id is the host-service ID for this Pi session.",
			"Opening the same normalized PDF path again should return the existing pdf_id instead of creating a duplicate viewer where practical.",
			"PDFs opened through the host service are wired to paste inverse SyncTeX clicks into the current interactive editor without triggering an agent turn when the backend supports it.",
		],
		parameters: OpenPdfParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let requestedPath = "";
			let pdfPath = "";
			let synctexCommand = "";
			try {
				requestedPath = String(params.pdf_file_path ?? "");
				if (!requestedPath.trim()) {
					throw new Error("pdf_file_path must be a non-empty string");
				}

				if (!ctx) {
					throw new Error("open_pdf requires a Pi agent session context");
				}
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const callbackTargetId = await ensureHostServiceCallbackTarget(ctx);
				const callbackServer = await ensureSynctexCallbacks(ctx);
				synctexCommand = callbackServer.command;
				const socketPath = hostServiceSocketPath();
				const hostServiceClient = new HostServiceClient({
					socketPath,
					requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
				});
				const openResponse = await hostServiceClient.requestOpenPdf(
					workspaceContext,
					{
						pdf_path: requestedPath,
						callback: callbackServer.callbackConfig,
						reuse_existing: true,
						require_persistent_viewer: true,
					},
					signal,
				);
				const trackedPdfPath = resolve(workspaceContext.cwd, openResponse.managed_record?.pdfPath ?? requestedPath);
				let trackedPdf: Awaited<ReturnType<typeof openTrackedPdfForContext>>;
				try {
					trackedPdf = await openTrackedPdfForContext(
						ctx,
						trackedPdfPath,
						signal,
						() => Promise.resolve({
							pid: openResponse.pid,
							viewerHandle: openResponse.handle,
							viewerBackend: openResponse.backend,
							viewerOwned: openResponse.owned,
							viewerCapabilities: openResponse.capabilities,
							hostServicePdfId: openResponse.pdf_id,
							hostServiceSocketPath: socketPath,
							hostServiceCallbackTargetId: callbackTargetId,
						}),
						undefined,
						synctexCommand,
						{
							reuseTrackedPdf: false,
							pdfId: openResponse.pdf_id,
						},
					);
				} catch (error) {
					if (openResponse.pdf_id !== undefined) {
						await hostServiceClient.requestClosePdf(workspaceContext, openResponse.pdf_id, signal)
							.catch(() => undefined);
					}
					throw error;
				}
				pdfPath = trackedPdf.path;

				const pidText = trackedPdf.pid === undefined ? "" : ` pid=${trackedPdf.pid}`;
				const text = `ok: pdf_id=${trackedPdf.id}${pidText} pdf=${trackedPdf.path}`;
				return {
					content: [{ type: "text", text }],
					details: {
						pdf_id: trackedPdf.id,
						pid: trackedPdf.pid,
						pdf: trackedPdf.path,
						source: trackedPdf.sourceFile,
						viewer_handle: trackedPdf.viewerHandle,
						viewer_backend: trackedPdf.viewerBackend,
						viewer_owned: trackedPdf.viewerOwned,
						viewer_capabilities: trackedPdf.viewerCapabilities,
					},
				};
			} catch (error) {
				throw latexToolFailure("open-pdf", "Open PDF failed", {
					requested_path: requestedPath,
					pdf: pdfPath,
					open_error: error instanceof Error ? error.message : String(error),
					open_error_code: extractHostServiceErrorCode(error),
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "close_pdf",
		label: "Close PDF",
		description: "Request the host service to close an extension-tracked PDF by pdf_id. Service-managed windows are closed through private handle metadata. Unowned/reused handles are acknowledged as not closed to avoid killing user-owned processes. The PDF is then removed from this session's tracking table when the close request succeeds.",
		promptSnippet: "Close a tracked PDF via host service",
		promptGuidelines: [
			"Use close_pdf when the user asks to close a PDF previously opened or tracked by this extension.",
			"Pass the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true).",
		],
		parameters: ClosePdfParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let pdfId = 0;
			try {
				pdfId = resolvePositiveInteger(params.pdf_id, "pdf_id");
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const result = await closeTrackedPdfForContext(
					ctx,
					pdfId,
					async (viewerHandle, viewerBackend, closeSignal) => {
						throw new Error("closeTrackedPdf requires host-service metadata in normal operation mode");
					},
					signal,
					async (hostPdfId, hostServiceSocketPath, closeSignal) => {
						const workspaceHostServiceClient = new HostServiceClient({
							socketPath: hostServiceSocketPath,
							requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
						});
						const closeResponse = await workspaceHostServiceClient.requestClosePdf(workspaceContext, hostPdfId, closeSignal);
						return {
							closed: closeResponse.closed,
							reason: closeResponse.reason,
						};
					},
				);
				const reasonText = result.reason ? ` reason=${result.reason}` : "";
				const closedText = result.closed
					? `closed_pids=${result.closedPids.length ? result.closedPids.join(",") : "none"}`
					: "closed=false";
				return {
					content: [{ type: "text", text: `ok: pdf_id=${pdfId} pdf=${result.pdf} ${closedText}${reasonText}` }],
					details: { pdf_id: pdfId, pdf: result.pdf, closed: result.closed, reason: result.reason, closed_pids: result.closedPids },
				};
			} catch (error) {
				throw latexToolFailure("close-pdf", "Close PDF failed", {
					pdf_id: pdfId || params.pdf_id,
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "jump_pdf",
		label: "Jump PDF",
		description: "Perform a line-based host-service forward SyncTeX jump in an already tracked PDF. Requires the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); arbitrary PDF paths are not accepted. The PDF must have SyncTeX data, and the source file must be readable. Uses the tracked default source file when known, or pass source_file when no default source was inferred or when jumping to an included .tex file. On success, the text result names the jumped line and then shows the verbatim LaTeX source line.",
		promptSnippet: "Jump to a source line in a tracked PDF",
		promptGuidelines: [
			"Use jump_pdf to move an already tracked host-service PDF to a source line via forward SyncTeX.",
			"Pass the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); do not pass arbitrary PDF paths.",
			"Reuse the same pdf_id for repeated jumps within one tracked PDF.",
			"source_file is optional only when the target line is in the tracked default source file; provide it whenever the target is in another source file or needs disambiguation.",
			"When the target content is in a file included by \\input, \\include, or similar, pass source_file as the included .tex file and use the line number from that included file. Do not jump to the parent file's \\input/\\include line unless that directive itself is the target.",
			"Mental model: pdf_id = viewer/PDF; source_file = TeX file containing the target line. For multi-file LaTeX, compile main.tex once and track its resulting PDF once, keep its pdf_id, and use jump_pdf(pdf_id, line, source_file=<included file>) for all fragments. Never open a new PDF merely because the target line is in another included file.",
			"After a successful jump, the tool result text names the jumped line and then shows the source line's verbatim LaTeX. Use it to verify that edits did not shift the intended target row.",
			"After a successful jump, do not tell the user which line you jumped to unless they explicitly ask for the exact line; the user will see the line in the PDF viewer.",
		],
		parameters: JumpPdfParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let pdfId = 0;
			let line = 0;
			let sourceFile: string | undefined;
			let synctexCommand = "";
			try {
				pdfId = resolvePositiveInteger(params.pdf_id, "pdf_id");
				line = resolvePositiveInteger(params.line, "line");
				sourceFile = params.source_file === undefined ? undefined : String(params.source_file);
				if (sourceFile !== undefined && !sourceFile.trim()) {
					throw new Error("source_file must be a non-empty string when provided");
				}
				if (!ctx) {
					throw new Error("jump_pdf requires a Pi agent session context");
				}
				const server = await ensureSynctexCallbacks(ctx);
				synctexCommand = server.command;
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const result = await jumpTrackedPdfForContext(
					ctx,
					pdfId,
					line,
					sourceFile,
					signal,
					{
						synctexEditorCommand: synctexCommand || undefined,
						opener: async () => {
							throw new Error("jumpTrackedPdf requires host-service metadata in normal operation mode");
						},
						requestForwardSearch: async () => {
							throw new Error("jumpTrackedPdf requires host-service metadata in normal operation mode");
						},
						requestJumpFromHostService: async (
						hostPdfId,
						hostServiceSocketPath,
						hostSourceFile,
						jumpLine,
						jumpSignal,
					) => {
						const workspaceHostServiceClient = new HostServiceClient({
							socketPath: hostServiceSocketPath,
							requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
						});
						const hostResponse = await workspaceHostServiceClient.requestJumpPdf(
							workspaceContext,
							{ pdf_id: hostPdfId, line: jumpLine, source_file: hostSourceFile },
							jumpSignal,
						);
						return {
							handled: hostResponse.handled,
							source_file: hostResponse.source_file,
							source_line: hostResponse.source_line,
							reopened: hostResponse.reopened,
						};
					},
					cwd: ctx.cwd,
					},
				);
				return {
					content: [{ type: "text", text: `line ${result.line} contains:\n${result.sourceLine}` }],
					details: { pdf_id: pdfId, line, source: result.sourceFile, pdf: result.pdf, reopened: result.reopened, source_line: result.sourceLine },
				};
			} catch (error) {
				const failureContext: Record<string, unknown> = {
					pdf_id: pdfId || params.pdf_id,
					line: line || params.line,
					source_file: sourceFile ?? params.source_file,
				};
				if (ctx && pdfId > 0) {
					failureContext.jump_failure_context = describePdfJumpFailureContextForContext(ctx, pdfId, synctexCommand || undefined);
				}
				throw latexToolFailure("jump-pdf", "PDF jump failed", failureContext, error);
			}
		},
	});

	const compileLatexFileToolFacade = createUniversalToolFacade({
		"compile_latex_file": async (_toolCallId, params, signal, _onUpdate, ctx) => {
			let requestedPath = "";
			let compileResult: { source: string; pdf: string; clean: boolean; cleaned_artifacts: string[] } | undefined;
			let openResult: { pdf_id?: number; pdf: string; source: string } | undefined;
			let synctexCommand = "";
			let compiler: LatexCompiler | undefined;
			let shouldOpenPdf = false;
			let shouldClean = false;
			let targetId = "";
			try {
				requestedPath = String(params.latex_file_path ?? "");
				if (!requestedPath.trim()) {
					throw new Error("latex_file_path must be a non-empty string");
				}

				compiler = resolveLatexCompiler(params.compiler);
				shouldOpenPdf = params.open_pdf === true;
				shouldClean = params.clean === true;
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const client = new HostServiceClient({
					socketPath: hostServiceSocketPath(),
					requestTimeoutMs: hostServiceClientConfig().requestTimeoutMs,
				});
				const compileRequest: {
					latex_file_path: string;
					compiler?: string;
					clean?: boolean;
					open_pdf?: boolean;
					callback_target_id?: string;
				} = {
					latex_file_path: requestedPath,
					...(shouldClean ? { clean: true } : {}),
				};
				if (compiler !== undefined) {
					compileRequest.compiler = compiler;
				}
				if (shouldOpenPdf && ctx) {
					targetId = await ensureHostServiceCallbackTarget(ctx);
					compileRequest.open_pdf = true;
					compileRequest.callback_target_id = targetId;
				}
				const compileResponse = await client.requestCompileLatexFile(compileRequest, workspaceContext, signal);
				compileResult = {
					source: compileResponse.source,
					pdf: compileResponse.pdf,
					clean: compileResponse.clean,
					cleaned_artifacts: compileResponse.cleaned_artifacts,
				};

				if (!shouldOpenPdf) {
					return {
						content: [{ type: "text", text: `ok: ${compileResult.pdf}` }],
						details: {
							source: compileResult.source,
							pdf: compileResult.pdf,
							clean: compileResult.clean,
							cleaned_artifacts: compileResult.cleaned_artifacts,
						},
					};
				}

				if (!ctx) {
					throw new Error("compile_latex_file with open_pdf=true requires a Pi agent session context");
				}
				synctexCommand = (await ensureSynctexCallbacks(ctx)).command;
				const trackedPdf = await openTrackedPdfForContext(
					ctx,
					compileResponse.pdf,
					signal,
					async () => {
						const managedRecord = compileResponse.managed_record;
						return {
							pid: managedRecord?.pid,
							viewerHandle: managedRecord?.viewerHandle,
							viewerBackend: managedRecord?.viewerBackend,
							viewerOwned: managedRecord?.viewerOwned,
							viewerCapabilities: managedRecord?.capabilities,
							hostServicePdfId: compileResponse.pdf_id,
							hostServiceSocketPath: hostServiceSocketPath(),
							hostServiceCallbackTargetId: targetId,
						};
					},
					compileResponse.source,
					synctexCommand,
					{
						reuseTrackedPdf: false,
						pdfId: compileResponse.pdf_id,
					},
				);
				openResult = {
					pdf_id: trackedPdf.id,
					pdf: trackedPdf.path,
					source: trackedPdf.sourceFile ?? compileResponse.source,
				};
				const pidText = trackedPdf.pid === undefined ? "" : ` pid=${trackedPdf.pid}`;
				const text = `ok: pdf_id=${trackedPdf.id}${pidText} pdf=${trackedPdf.path}`;
				return {
					content: [{ type: "text", text }],
					details: {
						source: trackedPdf.sourceFile ?? compileResponse.source,
						pdf: trackedPdf.path,
						pdf_id: trackedPdf.id,
						pid: trackedPdf.pid,
						viewer_handle: trackedPdf.viewerHandle,
						viewer_backend: trackedPdf.viewerBackend,
						viewer_owned: trackedPdf.viewerOwned,
						viewer_capabilities: trackedPdf.viewerCapabilities,
						clean: compileResponse.clean,
						cleaned_artifacts: compileResponse.cleaned_artifacts,
					},
				};
			} catch (error) {
				const failureContext = describeCompileFailureContext(requestedPath, compileResult, error);
				if (openResult === undefined && shouldOpenPdf && isOpenFailureFromCompileError(error)) {
					throw latexToolFailure("compile-latex-file", "LaTeX compile succeeded but opening failed", {
						requested_path: requestedPath,
						source: failureContext.source,
						compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
						open_pdf: shouldOpenPdf,
						clean: failureContext.clean,
						cleaned_artifacts: failureContext.cleaned_artifacts,
						pdf: failureContext.pdf,
						target_id: targetId,
						open_error: error instanceof Error ? error.message : String(error),
						open_error_code: extractHostServiceErrorCode(error),
					}, error);
				}

				throw latexToolFailure("compile-latex-file", "LaTeX compile failed", {
					requested_path: requestedPath,
					source: failureContext.source,
					compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
					open_pdf: shouldOpenPdf,
					clean: failureContext.clean,
					cleaned_artifacts: failureContext.cleaned_artifacts,
					pdf: failureContext.pdf,
					callback_target_id: shouldOpenPdf ? targetId : undefined,
				}, error);
			}
		},
	});

	const compileLatexFileTool: TracerToolDefinition = {
		name: "compile_latex_file",
		label: "Compile LaTeX File",
		description: "Compile an existing local LaTeX source file from its own directory. Defaults to lualatex; pass compiler to choose lualatex, pdflatex, xelatex, or latexmk. Set clean=true to remove common same-basename LaTeX artifacts before compiling. Set open_pdf=true to request a host-service open/track for the successfully compiled PDF; leave it false (the default) to compile without requesting external service state. Relative \\input, \\include, graphics, bibliography, and other project files are resolved the same way they are when compiling the file directly from its directory. The fixed temp preamble is not injected for file compiles.",
		promptSnippet: "Compile a local LaTeX file as PDF",
		promptGuidelines: [
			"Prefer compile_latex_file over invoking a bare compiler directly when the user has an existing .tex file to build.",
			"By default this compiles only. Leave open_pdf false (or omit it) when you want to compile without requesting external service state; set open_pdf=true only when the user wants the compiled PDF opened/tracked by the host service immediately.",
			"Use clean=true when stale or broken same-basename LaTeX artifacts may be causing problems. It removes common artifacts such as .aux, .log, .out, .pdf, .synctex, and .synctex.gz before compiling.",
			"Use this for complete .tex documents. File compiles run in the file's own directory so relative includes and assets resolve normally, and the fixed temp preamble is not injected.",
			"For multi-file LaTeX projects, compile the root file that produces the PDF, such as main.tex, and use open_pdf=true only when a host-service-tracked PDF is needed. The returned pdf_id identifies the running service-tracked PDF and can be reused for jumps into any included .tex file via jump_pdf with source_file set explicitly.",
			"On failure this tool returns only a short error message and writes details to a temporary log file.",
		],
		parameters: CompileLatexFileParams,
	};

	registerTracerTools(pi, compileLatexFileToolFacade, [compileLatexFileTool]);

	pi.registerTool({
		name: "set_latex_preamble",
		label: "Set LaTeX Preamble",
		description: "Set LaTeX preamble lines inserted before \\begin{document} in subsequent show_latex snippet compiles. This overwrites the active temp preamble at ${XDG_RUNTIME_DIR}/show-latex/preamble.tex. If a project preamble was copied there at startup, this changes the active preview preamble for the rest of the session and can make it diverge from the project's real ./preamble.tex or ./praeamble.tex. It should contain pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. compile_latex_file compiles complete files directly and does not inject this preamble.",
		promptSnippet: "Set a LaTeX preamble for future PDF previews",
		promptGuidelines: [
			"Use set_latex_preamble only when the user explicitly wants to change packages/macros/options for every subsequent snippet preview.",
			"In an existing LaTeX project, remember that this overwrites the already-copied active temp preamble, not just an isolated one-off preview setting. Do not use it after a failed preview unless the user explicitly wants to replace the active session preamble.",
			"Do not install a minimal standalone preamble inside an existing LaTeX project as a workaround for a failed show_latex compile. Inspect the log and project preamble first, and restore the project preamble into ${XDG_RUNTIME_DIR}/show-latex/preamble.tex if it diverged.",
			"For reusable project defaults, write pre-\\begin{document} code to ./preamble.tex or ./praeamble.tex before starting the Pi session so it is copied into ${XDG_RUNTIME_DIR}/show-latex/preamble.tex.",
		],
		parameters: SetLatexPreambleParams,
		async execute(_toolCallId, params) {
			const preambleLength = writeLatexPreambleToTmpdir(String(params.latex_preamble ?? ""));
			const text = preambleLength
				? `LaTeX preamble set (${preambleLength} characters) at ${LATEX_PREAMBLE_PATH}. It will be included in subsequent show_latex snippet calls; compile_latex_file compiles complete files directly without preamble injection.`
				: `LaTeX preamble cleared at ${LATEX_PREAMBLE_PATH}.`;
			return {
				content: [{ type: "text", text }],
				details: { preambleLength, preamblePath: LATEX_PREAMBLE_PATH },
			};
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		terminalRefreshPolicy.cleanup();
		terminalRefreshPolicy.clearInvalidators();
		if (ctx) {
			clearPdfTrackerForContext(ctx);
			const contextKey = callbackKeyForContext(ctx);
			try {
				await unregisterHostServiceCallbackTarget(contextKey);
			} catch (error) {
				notifyHostServiceError(ctx, "cleanup", error);
			}
		} else {
			await unregisterAllHostServiceCallbacks();
		}
		await shutdownSynctexCallbacks();
		await mcpClient.shutdown();
	});
}

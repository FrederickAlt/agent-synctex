import { createInterface, type Interface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { jumpToTrackedPdf, openAndTrackPdf, openPdfInZathura, PdfTracker } from "./pdf_tracking.ts";
import { SynctexCallbackServer, type SynctexPasteTarget } from "./synctex.ts";
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
	exists: boolean;
	size: number;
	mtime: number;
}

interface PipelineStatusSnapshot {
	pdf: PipelineArtifactStatus;
	ready: PipelineArtifactStatus;
}

interface LatexCommandSpec {
	displayName: string;
	command: string;
	args: string[];
}

interface LatexCommandResult {
	exitCode: number | null;
	signal: string | null;
	output: string;
	timedOut: boolean;
	aborted: boolean;
}

class LoggedToolError extends Error {
	constructor(message: string, readonly logPath: string, readonly tail: string = "") {
		super(message);
		this.name = "LoggedToolError";
	}
}

const MCP_TMPDIR = "/tmp/codex-show-latex";
const LATEX_PREAMBLE_FILE_NAMES = ["preamble.tex", "praeamble.tex"] as const;
const LATEX_PREAMBLE_PATH = resolve(MCP_TMPDIR, "preamble.tex");
const DEFAULT_LATEX_COMPILER = "lualatex";
const LATEX_COMPILERS = [DEFAULT_LATEX_COMPILER, "pdflatex", "xelatex", "latexmk"] as const;
type LatexCompiler = (typeof LATEX_COMPILERS)[number];
const DEFAULT_SNIPPET_PREAMBLE = [
	String.raw`\documentclass{article}`,
	String.raw`\usepackage[utf8]{inputenc}`,
	String.raw`\usepackage[T1]{fontenc}`,
	String.raw`\usepackage{amsmath,amssymb,mathtools}`,
	String.raw`\usepackage{xcolor}`,
	String.raw`\pagestyle{empty}`,
].join("\n");
const REQUEST_TIMEOUT_DEFAULT_MS = 60_000;
const STARTUP_TIMEOUT_DEFAULT_MS = 5_000;
const STARTUP_TIMEOUT_MAX_MS = 120_000;

function debugLog(..._parts: unknown[]): void {
	// Debug logging is intentionally disabled; this extension has no environment-driven configuration.
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

function readLatexPreambleFromTmpdir(): string {
	ensurePreviewTmpdirAccessible();

	const preambleFile = findPreambleFile(MCP_TMPDIR);
	if (!preambleFile) return "";

	try {
		return readFileSync(preambleFile, "utf8").trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read temp preamble ${preambleFile}: ${message}`);
	}
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

function hasDocumentClass(latexSource: string): boolean {
	return /\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(latexSource);
}

function removeDocumentClass(latexSource: string): string {
	return latexSource
		.replace(/\s*\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}\s*/m, "\n")
		.trim();
}

function defaultPreambleFor(latexPreamble: string): string {
	return hasDocumentClass(latexPreamble)
		? latexPreamble
		: [DEFAULT_SNIPPET_PREAMBLE, latexPreamble].filter(Boolean).join("\n");
}

function applyLatexPreamble(latexSource: string, latexPreamble: string): string {
	const preamble = latexPreamble.trim();
	const beginDocument = /\\begin\s*\{document\}/.exec(latexSource);
	const sourceHasDocumentClass = hasDocumentClass(latexSource);

	if (sourceHasDocumentClass) {
		const insertablePreamble = hasDocumentClass(preamble) ? removeDocumentClass(preamble) : preamble;
		if (!insertablePreamble) return latexSource;
		if (!beginDocument || beginDocument.index < 0) {
			return `${latexSource.trimEnd()}\n\n${insertablePreamble}\n`;
		}

		return [
			latexSource.slice(0, beginDocument.index).trimEnd(),
			"",
			insertablePreamble,
			"",
			latexSource.slice(beginDocument.index).trimStart(),
		].join("\n");
	}

	if (beginDocument && beginDocument.index >= 0) {
		return [
			defaultPreambleFor(preamble),
			latexSource.slice(beginDocument.index).trimStart(),
			"",
		].filter((part) => part.length > 0).join("\n");
	}

	if (!preamble) return latexSource;

	return [
		defaultPreambleFor(preamble),
		String.raw`\begin{document}`,
		latexSource,
		String.raw`\end{document}`,
		"",
	].join("\n");
}

function resolveLatexCompiler(compiler: unknown): LatexCompiler | undefined {
	if (compiler === undefined || compiler === null) return undefined;
	const value = String(compiler).trim().toLowerCase();
	if (!value) return undefined;
	if ((LATEX_COMPILERS as readonly string[]).includes(value)) return value as LatexCompiler;
	throw new Error(`compiler must be one of: ${LATEX_COMPILERS.join(", ")}`);
}

function resolveLatexFilePath(latexFilePath: string): string {
	return resolve(expandHomePath(latexFilePath.trim()));
}

function assertReadableLatexFile(latexFilePath: string): void {
	let fileStatus;
	try {
		fileStatus = statSync(latexFilePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot stat LaTeX file ${latexFilePath}: ${message}`);
	}

	if (!fileStatus.isFile()) {
		throw new Error(`latex_file_path must point to a regular file: ${latexFilePath}`);
	}

	try {
		accessSync(latexFilePath, constants.R_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read LaTeX file ${latexFilePath}: ${message}`);
	}
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

function readTail(path: string, limit = 12000): string {
	try {
		return tailText(readFileSync(path, "utf8"), limit);
	} catch {
		return "";
	}
}

function latexOutputPdfPath(latexFilePath: string): string {
	const extension = extname(latexFilePath);
	return resolve(dirname(latexFilePath), `${basename(latexFilePath, extension)}.pdf`);
}

function latexLogPath(latexFilePath: string): string {
	const extension = extname(latexFilePath);
	return resolve(dirname(latexFilePath), `${basename(latexFilePath, extension)}.log`);
}

function latexErrorLogPath(prefix: string): string {
	const logDir = resolve(tmpdir(), "codex-show-latex");
	const safePrefix = prefix.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "latex";
	mkdirSync(logDir, { recursive: true, mode: 0o700 });
	return resolve(logDir, `${safePrefix}.${process.pid}.${Date.now()}.log`);
}

function latexCompileErrorLogPath(): string {
	return latexErrorLogPath("compile-latex-file");
}

function latexCommandLine(spec: LatexCommandSpec): string {
	return [spec.command, ...spec.args].map((part) => JSON.stringify(part)).join(" ");
}

function writeLatexCompileErrorLog(
	latexFilePath: string,
	spec: LatexCommandSpec,
	reason: string,
	compilerOutput: string,
): string {
	const projectLogPath = latexLogPath(latexFilePath);
	const projectLogTail = readTail(projectLogPath, 30000).trim();
	const outputTail = tailText(compilerOutput.trim(), 30000).trim();
	const tempLogPath = latexCompileErrorLogPath();
	const sections = [
		"LaTeX file compilation failed",
		`source: ${latexFilePath}`,
		`cwd: ${dirname(latexFilePath)}`,
		`compiler: ${spec.displayName}`,
		`command: ${latexCommandLine(spec)}`,
		`reason: ${reason}`,
		projectLogTail ? `\n--- project log tail (${projectLogPath}) ---\n${projectLogTail}` : "",
		outputTail ? `\n--- compiler output tail ---\n${outputTail}` : "",
	].filter((section) => section.length > 0);

	writeFileSync(tempLogPath, `${sections.join("\n")}\n`, { mode: 0o600 });
	return tempLogPath;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function errorDetails(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message;
	return String(error);
}

function shortFailureMessage(shortMessage: string, logPath: string, tail: string): string {
	const tailLines = lastLines(tail, 5);
	return tailLines
		? `${shortMessage}. Log: ${logPath}\nLast 5 lines:\n${tailLines}`
		: `${shortMessage}. Log: ${logPath}`;
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

function latexToolFailure(
	toolName: string,
	shortMessage: string,
	context: Record<string, unknown>,
	error: unknown,
): Error {
	if (error instanceof LoggedToolError) return error;

	try {
		const tempLogPath = writeLatexToolErrorLog(toolName, shortMessage, context, error);
		const tail = lastLines(errorMessage(error), 5);
		return new LoggedToolError(shortFailureMessage(shortMessage, tempLogPath, tail), tempLogPath, tail);
	} catch (logError) {
		const message = logError instanceof Error ? logError.message : String(logError);
		return new Error(`${shortMessage}. Could not write temp log: ${message}`);
	}
}

function latexCompileErrorTail(latexFilePath: string, reason: string, compilerOutput: string): string {
	const projectLogTail = readTail(latexLogPath(latexFilePath), 30000).trim();
	const outputTail = tailText(compilerOutput.trim(), 30000).trim();
	return lastLines(projectLogTail || outputTail || reason, 5);
}

function latexCompileFailure(
	latexFilePath: string,
	spec: LatexCommandSpec,
	reason: string,
	compilerOutput: string,
): Error {
	try {
		const tempLogPath = writeLatexCompileErrorLog(latexFilePath, spec, reason, compilerOutput);
		const tail = latexCompileErrorTail(latexFilePath, reason, compilerOutput);
		return new LoggedToolError(shortFailureMessage("LaTeX compile failed", tempLogPath, tail), tempLogPath, tail);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`LaTeX compile failed. Could not write temp log: ${message}`);
	}
}

function latexCommandForFile(latexFilePath: string, compiler?: LatexCompiler): LatexCommandSpec {
	const requested = compiler ?? DEFAULT_LATEX_COMPILER;
	const fileName = basename(latexFilePath);
	if (requested === "latexmk") {
		return {
			displayName: "latexmk(lualatex)",
			command: "latexmk",
			args: [
				"-pdf",
				"-lualatex",
				"-synctex=1",
				"-interaction=nonstopmode",
				"-halt-on-error",
				"-file-line-error",
				"-pdflualatex=lualatex -no-shell-escape %O %S",
				fileName,
			],
		};
	}

	return {
		displayName: requested,
		command: requested,
		args: [
			"-synctex=1",
			"-interaction=nonstopmode",
			"-halt-on-error",
			"-file-line-error",
			"-no-shell-escape",
			fileName,
		],
	};
}

function runLatexCommand(spec: LatexCommandSpec, cwd: string, signal?: AbortSignal): Promise<LatexCommandResult> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			resolvePromise({ exitCode: null, signal: null, output: "", timedOut: false, aborted: true });
			return;
		}

		let output = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const child = spawn(spec.command, spec.args, {
			cwd,
			env: {
				...process.env,
				HOME: process.env.HOME || homedir(),
				PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
			},
		});

		const appendOutput = (chunk: Buffer | string) => {
			output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (output.length > 12000) output = output.slice(-12000);
		};

		child.stdout.on("data", appendOutput);
		child.stderr.on("data", appendOutput);

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, REQUEST_TIMEOUT_DEFAULT_MS);

		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};

		child.on("error", (error) => {
			finish(() => reject(error));
		});

		child.on("close", (exitCode, closeSignal) => {
			finish(() => resolvePromise({
				exitCode,
				signal: closeSignal,
				output,
				timedOut,
				aborted,
			}));
		});
	});
}

async function compileLatexFile(latexFilePath: string, compiler?: LatexCompiler, signal?: AbortSignal): Promise<string> {
	assertReadableLatexFile(latexFilePath);

	const outputPdfPath = latexOutputPdfPath(latexFilePath);
	const spec = latexCommandForFile(latexFilePath, compiler);

	debugLog(`compile file start compiler=${spec.displayName} cwd=${dirname(latexFilePath)} file=${basename(latexFilePath)}`);
	let result: LatexCommandResult;
	try {
		result = await runLatexCommand(spec, dirname(latexFilePath), signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw latexCompileFailure(latexFilePath, spec, `failed to start compiler: ${message}`, "");
	}

	if (result.aborted) {
		throw latexCompileFailure(latexFilePath, spec, "compilation aborted", result.output);
	}
	if (result.timedOut) {
		throw latexCompileFailure(latexFilePath, spec, `compiler timed out after ${REQUEST_TIMEOUT_DEFAULT_MS / 1000}s`, result.output);
	}
	if (result.exitCode !== 0) {
		throw latexCompileFailure(latexFilePath, spec, `compiler exited nonzero: ${result.exitCode ?? result.signal ?? "unknown"}`, result.output);
	}

	let outputPdfStatus;
	try {
		outputPdfStatus = statSync(outputPdfPath);
	} catch {
		throw latexCompileFailure(latexFilePath, spec, `PDF was not created at ${outputPdfPath}`, result.output);
	}
	if (!outputPdfStatus.isFile()) {
		throw latexCompileFailure(latexFilePath, spec, `PDF path is not a regular file: ${outputPdfPath}`, result.output);
	}

	debugLog(`compile file ok; wrote ${outputPdfPath}`);
	return outputPdfPath;
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
	): Promise<string> {
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

		const argumentsPayload: Record<string, string> = { latex_source: latexSource };
		if (compiler) argumentsPayload.compiler = compiler;
		if (synctexEditorCommand) argumentsPayload.synctex_editor_command = synctexEditorCommand;

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

		const resultObj = result as { isError?: boolean; content?: Array<{ text?: unknown }> };
		if (resultObj.isError) {
			const text = this.extractText(resultObj);
			throw new Error(text || "MCP tool call failed");
		}

		const text = this.extractText(resultObj);
		if (!text) {
			throw new Error("MCP response missing text content");
		}

		const afterStatus = await this.getShowLatexStatus(signal);
		if (!afterStatus) {
			throw new Error("Unable to verify preview artifacts after MCP call.");
		}
		this.verifyPreviewArtifactsUpdated(beforeStatus, afterStatus, requestStartedMs);

		return text;
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

		if (line.includes(" missing")) {
			return { exists: false, size: 0, mtime: 0 };
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

		return { exists: true, size, mtime };
	}

	private verifyPreviewArtifactsUpdated(
		beforeStatus: PipelineStatusSnapshot | null,
		afterStatus: PipelineStatusSnapshot,
		requestStartedMs: number,
	): void {
		if (!afterStatus.pdf.exists || afterStatus.pdf.size <= 0) {
			throw new Error("LaTeX preview failed: PDF file was not produced.");
		}
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

		debugLog(`shutting down MCP helper pid=${child.pid}`);
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) {
				child.kill("SIGKILL");
			}
		}, 200);
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
const pdfTracker = new PdfTracker();
const synctexCallbacksByContext = new WeakMap<ExtensionContext, SynctexCallbackServer>();
const synctexCallbackServers = new Set<SynctexCallbackServer>();

function createSynctexCallbackServer(): SynctexCallbackServer {
	return new SynctexCallbackServer({ callbackScriptPath: SYNCTEX_CALLBACK_SCRIPT_PATH });
}

async function rotateSynctexCallbacks(ctx: ExtensionContext): Promise<SynctexCallbackServer> {
	const previous = synctexCallbacksByContext.get(ctx);
	const next = createSynctexCallbackServer();
	synctexCallbacksByContext.set(ctx, next);
	synctexCallbackServers.add(next);
	if (previous) synctexCallbackServers.delete(previous);
	await previous?.close();
	await next.ensureStarted(synctexPasteTarget(ctx));
	return next;
}

async function ensureSynctexCallbacks(ctx: ExtensionContext): Promise<SynctexCallbackServer> {
	let server = synctexCallbacksByContext.get(ctx);
	if (!server) {
		server = createSynctexCallbackServer();
		synctexCallbacksByContext.set(ctx, server);
		synctexCallbackServers.add(server);
	}
	await server.ensureStarted(synctexPasteTarget(ctx));
	return server;
}

async function shutdownSynctexCallbacks(ctx?: ExtensionContext): Promise<void> {
	if (ctx) {
		const server = synctexCallbacksByContext.get(ctx);
		if (!server) return;
		synctexCallbacksByContext.delete(ctx);
		synctexCallbackServers.delete(server);
		await server.close();
		return;
	}

	const servers = [...synctexCallbackServers];
	synctexCallbackServers.clear();
	await Promise.all(servers.map((server) => server.close()));
}

const LatexCompilerParam = Type.Optional(Type.Union([
	Type.Literal("lualatex"),
	Type.Literal("pdflatex"),
	Type.Literal("xelatex"),
	Type.Literal("latexmk"),
], {
	description: `Optional LaTeX compiler. Defaults to ${DEFAULT_LATEX_COMPILER}.`,
	default: DEFAULT_LATEX_COMPILER,
}));

const ShowLatexParams = Type.Object(
	{
		latex_source: Type.String({
			description: "LaTeX source code to compile. If a temp preamble is used, that file contains the code before \\begin{document}; provide only the document body or the \\begin{document}...\\end{document} block for preview.",
			minLength: 1,
		}),
		compiler: LatexCompilerParam,
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
			description: "When true, open and track the compiled PDF after successful compilation. Defaults to false.",
			default: false,
		})),
	},
	{ additionalProperties: false },
);

const OpenPdfParams = Type.Object(
	{
		pdf_file_path: Type.String({
			description: "Path to an existing local PDF file to open in Zathura and track for later SyncTeX actions.",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

const JumpPdfParams = Type.Object(
	{
		pdf_id: Type.Number({
			description: "Tracked numeric PDF ID returned by open_pdf or compile_latex_file(..., open_pdf=true). Arbitrary PDF paths are not accepted.",
			minimum: 1,
		}),
		line: Type.Number({
			description: "1-based source line to jump to. The tool supplies the SyncTeX column automatically.",
			minimum: 1,
		}),
		source_file: Type.Optional(Type.String({
			description: "Optional source file for the SyncTeX jump. Omit when the tracked PDF has a known default source; pass it for included-file or ambiguous SyncTeX cases.",
			minLength: 1,
		})),
	},
	{ additionalProperties: false },
);

const SetLatexPreambleParams = Type.Object(
	{
		latex_preamble: Type.String({
			description: "LaTeX preamble lines to write to /tmp/codex-show-latex/preamble.tex and include before \\begin{document} for show_latex snippet compiles; this is for documentclass/usepackage/macros, not document body content. Use an empty string to clear it.",
		}),
	},
	{ additionalProperties: false },
);

const SynctexCallbackCommandParams = Type.Object({}, { additionalProperties: false });

async function compileAndPreviewLatex(
	latexSource: string,
	compiler?: LatexCompiler,
	synctexEditorCommand?: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!latexSource.trim()) {
		throw new Error("latex_source must be a non-empty string");
	}

	if (!existsSync(MCP_SCRIPT_PATH)) {
		throw new Error(`MCP script not found at ${MCP_SCRIPT_PATH}`);
	}

	return mcpClient.callShowLatex(
		applyLatexPreamble(latexSource, readLatexPreambleFromTmpdir()),
		compiler,
		synctexEditorCommand,
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

export default function (pi: ExtensionAPI) {
	initializeLatexPreambleFile();

	pi.on("session_start", (_event, ctx) => {
		void rotateSynctexCallbacks(ctx).catch((error) => {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to start SyncTeX callback server: ${message}`, "error");
			}
		});
	});

	pi.registerCommand("synctex_callback_command", {
		description: "Paste the exact session-specific Zathura SyncTeX callback command into the editor for manual configuration.",
		async handler(_args, ctx) {
			const server = await ensureSynctexCallbacks(ctx);
			if (ctx.hasUI) ctx.ui.pasteToEditor(`${server.command}\n`);
		},
	});

	pi.registerTool({
		name: "show_latex",
		label: "Show LaTeX",
		description: "Compile LaTeX source and refresh the shared preview pipeline. Calling this tool again overwrites the same preview view; the user will only see the most recent preview. Defaults to lualatex; pass compiler to choose lualatex, pdflatex, xelatex, or latexmk. The extension loads its preamble from /tmp/codex-show-latex/preamble.tex (or praeamble.tex there, if present). At startup, ./preamble.tex or ./praeamble.tex from the current working directory is copied to that fixed temp path as the default. When using a preamble file, provide only the document body or the \\begin{document}...\\end{document} block for preview.",
		promptSnippet: "Compile and preview LaTeX as PDF",
		promptGuidelines: [
			"Use show_latex when the user asks for a LaTeX PDF preview. Omit compiler for the lualatex default, or set compiler when a different engine is needed.",
			"If you would otherwise repeat the same LaTeX packages, macros, or style setup, write them with set_latex_preamble or put them in ./preamble.tex or ./praeamble.tex before startup; those files are for pre-\\begin{document} code only, so the preview input should be just the document body or \\begin{document}...\\end{document}.",
		],
		parameters: ShowLatexParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let latexSource = "";
			let compiler: LatexCompiler | undefined;
			let synctexCommand = "";
			try {
				latexSource = String(params.latex_source ?? "");
				compiler = resolveLatexCompiler(params.compiler);
				if (ctx) {
					const server = await ensureSynctexCallbacks(ctx);
					synctexCommand = server.command;
				}
				const text = await compileAndPreviewLatex(latexSource, compiler, synctexCommand, signal);
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			} catch (error) {
				throw latexToolFailure("show-latex", "LaTeX preview failed", {
					compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
					latex_source_length: latexSource.length,
					latex_source_tail: tailText(latexSource, 30000),
					synctex_callback_command: synctexCommand,
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "open_pdf",
		label: "Open PDF",
		description: "Open an existing local PDF in Zathura and track it for later SyncTeX actions. Returns a short numeric pdf_id that is valid only for the current running Pi session. Opening the same normalized PDF path again reuses its existing ID where practical. Zathura is launched with this session's inverse SyncTeX callback so PDF clicks paste source references into the interactive editor without submitting.",
		promptSnippet: "Open and track a local PDF in Zathura",
		promptGuidelines: [
			"Use open_pdf when the user asks to view an existing PDF or when you need a pdf_id for later PDF actions.",
			"Pass an existing local PDF path. The returned pdf_id is short-lived and valid only in the current Pi session.",
			"Extension-opened Zathura PDFs are wired to paste inverse SyncTeX clicks into the current interactive editor without triggering an agent turn.",
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

				if (ctx) {
					const server = await ensureSynctexCallbacks(ctx);
					synctexCommand = server.command;
				}
				const trackedPdf = await openAndTrackPdf(
					requestedPath,
					pdfTracker,
					signal,
					synctexCommand
						? (path, abortSignal) => openPdfInZathura(path, abortSignal, { synctexEditorCommand: synctexCommand })
						: undefined,
				);
				pdfPath = trackedPdf.path;
				const text = synctexCommand
					? `ok: pdf_id=${trackedPdf.id} pdf=${trackedPdf.path}\nsynctex_callback_command=${synctexCommand}`
					: `ok: pdf_id=${trackedPdf.id} pdf=${trackedPdf.path}`;
				return {
					content: [{ type: "text", text }],
					details: { pdf_id: trackedPdf.id, pdf: trackedPdf.path, source: trackedPdf.sourceFile, synctex_callback_command: synctexCommand },
				};
			} catch (error) {
				throw latexToolFailure("open-pdf", "Open PDF failed", {
					requested_path: requestedPath,
					pdf: pdfPath,
					synctex_callback_command: synctexCommand,
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "jump_pdf",
		label: "Jump PDF",
		description: "Perform a line-based Zathura forward SyncTeX jump in an already tracked PDF. Requires the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); arbitrary PDF paths are not accepted. Uses the tracked default source file when known, or pass source_file for ambiguous/included-file jumps.",
		promptSnippet: "Jump to a source line in a tracked PDF",
		promptGuidelines: [
			"Use jump_pdf to move an already tracked Zathura PDF to a source line via forward SyncTeX.",
			"Pass the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); do not pass arbitrary PDF paths.",
			"Omit source_file when the tracked PDF has a known default source. If the tool asks for source_file, retry with the relevant .tex file, especially for included files.",
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
				if (ctx) {
					const server = await ensureSynctexCallbacks(ctx);
					synctexCommand = server.command;
				}

				const result = await jumpToTrackedPdf(
					pdfId,
					line,
					sourceFile,
					pdfTracker,
					signal,
					synctexCommand ? { synctexEditorCommand: synctexCommand } : {},
				);
				return {
					content: [{ type: "text", text: `ok: pdf_id=${pdfId} line=${line} source=${result.sourceFile} pdf=${result.pdf}${result.reopened ? " reopened=true" : ""}` }],
					details: { pdf_id: pdfId, line, source: result.sourceFile, pdf: result.pdf, reopened: result.reopened },
				};
			} catch (error) {
				throw latexToolFailure("jump-pdf", "PDF jump failed", {
					pdf_id: pdfId || params.pdf_id,
					line: line || params.line,
					source_file: sourceFile ?? params.source_file,
					synctex_callback_command: synctexCommand,
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "get_synctex_callback_command",
		label: "Get SyncTeX Callback Command",
		description: "Return the exact session-specific Zathura inverse SyncTeX callback command for manual configuration. The command forwards Zathura %{input}/%{line} clicks to this Pi session and only pastes text into the interactive editor; it never submits a message.",
		promptSnippet: "Get the current session's Zathura inverse SyncTeX callback command",
		promptGuidelines: [
			"Use get_synctex_callback_command when the user wants to configure Zathura manually for inverse SyncTeX clicks.",
			"The returned command is specific to the current running Pi session and should be used as Zathura's synctex-editor-command.",
		],
		parameters: SynctexCallbackCommandParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx) throw new Error("SyncTeX callback command is only available inside a Pi session");
			const server = await ensureSynctexCallbacks(ctx);
			const text = [
				"Zathura SyncTeX callback command:",
				server.command,
				"",
				"Manual use: configure this as zathura's synctex-editor-command for the current Pi session.",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { command: server.command },
			};
		},
	});

	pi.registerTool({
		name: "compile_latex_file",
		label: "Compile LaTeX File",
		description: "Compile an existing local LaTeX source file from its own directory. Defaults to lualatex; pass compiler to choose lualatex, pdflatex, xelatex, or latexmk. Set open_pdf=true to open and track the successfully compiled PDF. Relative \\input, \\include, graphics, bibliography, and other project files are resolved the same way they are when compiling the file directly from its directory. The fixed temp preamble is not injected for file compiles.",
		promptSnippet: "Compile a local LaTeX file as PDF",
		promptGuidelines: [
			"Use compile_latex_file when the user asks to compile an existing LaTeX source file path. Omit compiler for the lualatex default, or set compiler when a different engine is needed.",
			"By default this compiles only. Set open_pdf=true only when the user wants the compiled PDF opened/tracked immediately.",
			"Use this for complete .tex documents. File compiles run in the file's own directory so relative includes and assets resolve normally, and the fixed temp preamble is not injected.",
			"On failure this tool returns only a short error message and writes details to a temporary log file.",
		],
		parameters: CompileLatexFileParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let requestedPath = "";
			let latexFilePath = "";
			let pdfPath = "";
			let compiler: LatexCompiler | undefined;
			let shouldOpenPdf = false;
			let synctexCommand = "";
			try {
				requestedPath = String(params.latex_file_path ?? "");
				if (!requestedPath.trim()) {
					throw new Error("latex_file_path must be a non-empty string");
				}

				latexFilePath = resolveLatexFilePath(requestedPath);
				compiler = resolveLatexCompiler(params.compiler);
				shouldOpenPdf = params.open_pdf === true;
				pdfPath = await compileLatexFile(latexFilePath, compiler, signal);
				if (!shouldOpenPdf) {
					return {
						content: [{ type: "text", text: `ok: ${pdfPath}` }],
						details: { source: latexFilePath, pdf: pdfPath },
					};
				}

				try {
					if (ctx) {
						const server = await ensureSynctexCallbacks(ctx);
						synctexCommand = server.command;
					}
					const trackedPdf = await openAndTrackPdf(
						pdfPath,
						pdfTracker,
						signal,
						synctexCommand
							? (path, abortSignal) => openPdfInZathura(path, abortSignal, { synctexEditorCommand: synctexCommand })
							: undefined,
						latexFilePath,
					);
					const text = synctexCommand
						? `ok: pdf_id=${trackedPdf.id} pdf=${trackedPdf.path}\nsynctex_callback_command=${synctexCommand}`
						: `ok: pdf_id=${trackedPdf.id} pdf=${trackedPdf.path}`;
					return {
						content: [{ type: "text", text }],
						details: { source: latexFilePath, pdf: trackedPdf.path, pdf_id: trackedPdf.id, synctex_callback_command: synctexCommand },
					};
				} catch (error) {
					throw latexToolFailure("compile-latex-file", "LaTeX compile succeeded but opening failed", {
						requested_path: requestedPath,
						source: latexFilePath,
						compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
						pdf: pdfPath,
						synctex_callback_command: synctexCommand,
					}, error);
				}
			} catch (error) {
				throw latexToolFailure("compile-latex-file", "LaTeX compile failed", {
					requested_path: requestedPath,
					source: latexFilePath,
					compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
					open_pdf: shouldOpenPdf,
					pdf: pdfPath,
					synctex_callback_command: synctexCommand,
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "set_latex_preamble",
		label: "Set LaTeX Preamble",
		description: "Set LaTeX preamble lines inserted before \\begin{document} in subsequent show_latex snippet compiles. This writes the hardcoded temp preamble file /tmp/codex-show-latex/preamble.tex. It should contain documentclass/usepackage/macros, not document body content. compile_latex_file compiles complete files directly and does not inject this preamble.",
		promptSnippet: "Set a LaTeX preamble for future PDF previews",
		promptGuidelines: [
			"Use set_latex_preamble when a user wants packages/macros/options included in every preview.",
			"For reusable project defaults, write pre-\\begin{document} code to ./preamble.tex or ./praeamble.tex before startup so it is copied into /tmp/codex-show-latex/preamble.tex.",
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
		pdfTracker.clear();
		await shutdownSynctexCallbacks(ctx);
		await mcpClient.shutdown();
	});
}

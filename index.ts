import { createInterface, type Interface } from "node:readline";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolResponse } from "@mariozechner/pi-coding-agent";
import { Container, getCapabilities, getCellDimensions, getPngDimensions, Image, Text, type Component } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	calculateInlineDisplayColumns,
	INLINE_PREVIEW_DIR,
	mergeInlinePreviewArtifacts,
	rasterizePdfPages,
	type InlinePreviewArtifact,
} from "./inline_preview.ts";
import { buildKittyPlaceholderImageRender, KittyPreviewInvalidationRegistry } from "./kitty_placeholder_image.ts";
import { createTerminalRefreshPolicy } from "./terminal_refresh_policy.ts";
import { closeTrackedPdf, describePdfJumpFailureContext, jumpToTrackedPdf, openAndTrackPdf, openPdfInZathura, PdfTracker } from "./pdf_tracking.ts";
import { fileSnapshot, previewAlreadyOpen } from "./preview_open_detection.ts";
import { readSourceLine, SynctexCallbackServer, type SynctexPasteTarget } from "./synctex.ts";
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

interface ShowLatexPreviewResult {
	text: string;
	pdfPath: string;
}

interface ShowLatexCallOptions {
	writeReady?: boolean;
	writeFixed?: boolean;
	cropToContent?: boolean;
	suppressPageNumbers?: boolean;
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
const MCP_FIXED_PREVIEW_PDF_PATH = resolve(MCP_TMPDIR, "show-latex.pdf");
const MCP_VIEWER_LOG_PATH = resolve(MCP_TMPDIR, "zathura.log");
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
const INLINE_PREVIEW_SETUP = [
	String.raw`\usepackage[active,tightpage]{preview}`,
	String.raw`\setlength\PreviewBorder{8pt}`,
].join("\n");
const INLINE_PAGE_STYLE_SETUP = [
	String.raw`\makeatletter`,
	String.raw`\AtBeginDocument{\pagestyle{empty}\thispagestyle{empty}\let\ps@plain\ps@empty}`,
	String.raw`\makeatother`,
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

function addInlinePreviewSetup(preamble: string): string {
	if (/\\usepackage(?:\s*\[[^\]]*\])?\s*\{preview\}/.test(preamble)) return preamble;
	return [preamble, INLINE_PREVIEW_SETUP].filter(Boolean).join("\n");
}

function addInlinePageStyleSetup(preamble: string): string {
	if (/\\AtBeginDocument\s*\{[^}]*\\pagestyle\s*\{empty\}/s.test(preamble) && /\\ps@plain\b/.test(preamble)) return preamble;
	return [preamble, INLINE_PAGE_STYLE_SETUP].filter(Boolean).join("\n");
}

function wrapLatexPreviewBody(body: string): string {
	if (/\\begin\s*\{preview\}/.test(body)) return body;
	return [String.raw`\begin{preview}`, body.trim(), String.raw`\end{preview}`].join("\n");
}

function wrapDocumentBody(latexSource: string, beginDocument: RegExpExecArray): string | null {
	const documentBodyStart = beginDocument.index + beginDocument[0].length;
	const afterBegin = latexSource.slice(documentBodyStart);
	const endDocument = /\\end\s*\{document\}/.exec(afterBegin);
	if (!endDocument) return null;
	const documentBodyEnd = documentBodyStart + endDocument.index;
	return [
		latexSource.slice(0, documentBodyStart),
		"\n",
		wrapLatexPreviewBody(latexSource.slice(documentBodyStart, documentBodyEnd)),
		"\n",
		latexSource.slice(documentBodyEnd),
	].join("");
}

function applyLatexPreamble(latexSource: string, latexPreamble: string, options: { cropToContent?: boolean; suppressPageNumbers?: boolean } = {}): string {
	const preamble = latexPreamble.trim();
	const beginDocument = /\\begin\s*\{document\}/.exec(latexSource);
	const sourceHasDocumentClass = hasDocumentClass(latexSource);
	const cropToContent = options.cropToContent === true;
	const suppressPageNumbers = options.suppressPageNumbers === true;
	const preparePreamble = (basePreamble: string): string => {
		const withCropSetup = cropToContent ? addInlinePreviewSetup(basePreamble) : basePreamble;
		return suppressPageNumbers ? addInlinePageStyleSetup(withCropSetup) : withCropSetup;
	};

	if (sourceHasDocumentClass) {
		const insertablePreamble = hasDocumentClass(preamble) ? removeDocumentClass(preamble) : preamble;
		const combinedPreamble = preparePreamble(insertablePreamble);
		if (!combinedPreamble && !cropToContent) return latexSource;
		if (!beginDocument || beginDocument.index < 0) {
			return `${latexSource.trimEnd()}\n\n${combinedPreamble}\n`;
		}

		const sourceWithPreamble = [
			latexSource.slice(0, beginDocument.index).trimEnd(),
			"",
			combinedPreamble,
			"",
			latexSource.slice(beginDocument.index).trimStart(),
		].join("\n");
		if (!cropToContent) return sourceWithPreamble;

		const adjustedBeginDocument = /\\begin\s*\{document\}/.exec(sourceWithPreamble);
		return adjustedBeginDocument ? wrapDocumentBody(sourceWithPreamble, adjustedBeginDocument) ?? sourceWithPreamble : sourceWithPreamble;
	}

	if (beginDocument && beginDocument.index >= 0) {
		const sourceWithPreamble = [
			preparePreamble(defaultPreambleFor(preamble)),
			latexSource.slice(beginDocument.index).trimStart(),
			"",
		].filter((part) => part.length > 0).join("\n");
		if (!cropToContent) return sourceWithPreamble;

		const adjustedBeginDocument = /\\begin\s*\{document\}/.exec(sourceWithPreamble);
		return adjustedBeginDocument ? wrapDocumentBody(sourceWithPreamble, adjustedBeginDocument) ?? sourceWithPreamble : sourceWithPreamble;
	}

	if (!preamble && !cropToContent && !suppressPageNumbers) return latexSource;

	return [
		preparePreamble(defaultPreambleFor(preamble)),
		String.raw`\begin{document}`,
		cropToContent ? wrapLatexPreviewBody(latexSource) : latexSource,
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

const LATEX_ERROR_TAIL_LINES = 20;

function shortFailureMessage(shortMessage: string, logPath: string, tail: string): string {
	const tailLines = lastLines(tail, LATEX_ERROR_TAIL_LINES);
	return tailLines
		? `${shortMessage}. Log: ${logPath}\nLast ${LATEX_ERROR_TAIL_LINES} lines:\n${tailLines}`
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
		const tail = lastLines(errorMessage(error), LATEX_ERROR_TAIL_LINES);
		return new LoggedToolError(shortFailureMessage(shortMessage, tempLogPath, tail), tempLogPath, tail);
	} catch (logError) {
		const message = logError instanceof Error ? logError.message : String(logError);
		return new Error(`${shortMessage}. Could not write temp log: ${message}`);
	}
}

function latexCompileErrorTail(latexFilePath: string, reason: string, compilerOutput: string): string {
	const projectLogTail = readTail(latexLogPath(latexFilePath), 30000).trim();
	const outputTail = tailText(compilerOutput.trim(), 30000).trim();
	return lastLines(projectLogTail || outputTail || reason, LATEX_ERROR_TAIL_LINES);
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

async function compileLatexFile(latexFilePath: string, compiler?: LatexCompiler, signal?: AbortSignal, clean = false): Promise<{ pdfPath: string; cleanedArtifacts: string[] }> {
	assertReadableLatexFile(latexFilePath);

	const cleanedArtifacts = clean ? cleanLatexFileArtifacts(latexFilePath) : [];
	const outputPdfPath = latexOutputPdfPath(latexFilePath);
	const spec = latexCommandForFile(latexFilePath, compiler);

	debugLog(`compile file start compiler=${spec.displayName} cwd=${dirname(latexFilePath)} file=${basename(latexFilePath)} clean=${clean} cleaned=${cleanedArtifacts.length}`);
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
	return { pdfPath: outputPdfPath, cleanedArtifacts };
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
		if (options.writeReady === false) argumentsPayload.write_ready = false;
		if (options.writeFixed === false) argumentsPayload.write_fixed = false;

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
const pdfTrackersByContext = new Map<string, PdfTracker>();
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
interface InlinePreviewArtifactMetadata {
	pngPath: string;
	fullPageWidthPx: number;
	fullPageHeightPx: number;
	widthPx: number;
	heightPx: number;
}

interface InlinePreviewRenderState {
	pdf: string;
	previews: InlinePreviewArtifact[];
}

const inlinePreviewRenderStates = new Map<string, InlinePreviewRenderState>();
const MAX_INLINE_PREVIEW_RENDER_STATES = 8;
const INLINE_PREVIEW_MAX_IMAGE_SIZE_BYTES = 25 * 1024 * 1024;
const synctexCallbacksByContext = new Map<string, SynctexCallbackServer>();
const synctexCallbackServers = new Set<SynctexCallbackServer>();
const contextUiIds = new WeakMap<object, string>();
let nextContextUiId = 1;

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

function numberFromUnknown(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 1;
	return Math.max(1, Math.floor(value));
}

function inlinePreviewPdfPathFromDetails(pdfPath: unknown): string {
	if (typeof pdfPath !== "string") return "";
	if (!isAbsolute(pdfPath)) return "";
	return resolve(pdfPath);
}

function isInlinePreviewPngPathValue(absolutePath: string, inlinePreviewDir = INLINE_PREVIEW_DIR): boolean {
	const delta = relative(inlinePreviewDir, absolutePath);
	if (delta === "" || delta === ".") return false;
	if (delta === ".." || delta.startsWith(`..${sep}`)) return false;
	return !isAbsolute(delta);
}

function safeInlinePreviewPngPath(rawPngPath: unknown): string {
	if (typeof rawPngPath !== "string") return "";
	if (!isAbsolute(rawPngPath)) return "";
	const pngPath = resolve(rawPngPath);
	if (extname(pngPath).toLowerCase() !== ".png") return "";

	try {
		const inlinePreviewDir = realpathSync(INLINE_PREVIEW_DIR);
		const realPngPath = realpathSync(pngPath);
		if (!isInlinePreviewPngPathValue(realPngPath, inlinePreviewDir)) return "";
		if (extname(realPngPath).toLowerCase() !== ".png") return "";
		const status = statSync(realPngPath);
		if (!status.isFile()) return "";
		if (status.size <= 0 || status.size > INLINE_PREVIEW_MAX_IMAGE_SIZE_BYTES) return "";
		accessSync(realPngPath, constants.R_OK);
		return realPngPath;
	} catch {
		return "";
	}
}

function inlinePreviewMetadataFromUnknown(value: unknown): InlinePreviewArtifactMetadata | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const pngPath = safeInlinePreviewPngPath(candidate.pngPath);
	if (!pngPath) return null;
	return {
		pngPath,
		fullPageWidthPx: numberFromUnknown(candidate.fullPageWidthPx),
		fullPageHeightPx: numberFromUnknown(candidate.fullPageHeightPx),
		widthPx: numberFromUnknown(candidate.widthPx),
		heightPx: numberFromUnknown(candidate.heightPx),
	};
}

function inlinePreviewArtifactFromMetadata(metadata: InlinePreviewArtifactMetadata): InlinePreviewArtifact {
	return {
		pngPath: metadata.pngPath,
		page: 1,
		dpi: 150,
		renderer: "mutool",
		trimmed: false,
		fullPageWidthPx: metadata.fullPageWidthPx,
		fullPageHeightPx: metadata.fullPageHeightPx,
		widthPx: metadata.widthPx,
		heightPx: metadata.heightPx,
	};
}

function inlinePreviewRenderStateFromDetails(details: Record<string, unknown>): InlinePreviewRenderState | null {
	const previewId = typeof details.preview_id === "string" ? details.preview_id : undefined;
	if (previewId) {
		const state = inlinePreviewRenderStates.get(previewId);
		if (state) return state;
	}

	const rawPreviews = Array.isArray(details.inline_previews)
		? details.inline_previews
		: details.inline_preview
			? [details.inline_preview]
			: [];
	const metadataPreviews = rawPreviews
		.map((entry) => inlinePreviewMetadataFromUnknown(entry))
		.filter((entry): entry is InlinePreviewArtifactMetadata => entry !== null);
	if (metadataPreviews.length === 0) return null;

	return {
		pdf: inlinePreviewPdfPathFromDetails(details.pdf),
		previews: metadataPreviews.map((metadata) => inlinePreviewArtifactFromMetadata(metadata)),
	};
}

function contextSessionKey(ctx?: ExtensionContext): string {
	if (!ctx) {
		throw new Error("PDF tracking is only available inside a Pi agent session");
	}

	const ui = ctx.ui as object;
	let uiId = contextUiIds.get(ui);
	if (!uiId) {
		uiId = `ui-${nextContextUiId++}`;
		contextUiIds.set(ui, uiId);
	}

	return `${ctx.cwd}|${uiId}`;
}

function pdfTrackerForContext(ctx?: ExtensionContext): PdfTracker {
	const key = contextSessionKey(ctx);
	let tracker = pdfTrackersByContext.get(key);
	if (!tracker) {
		tracker = new PdfTracker();
		pdfTrackersByContext.set(key, tracker);
	}
	return tracker;
}

function callbackKeyForContext(ctx: ExtensionContext): string {
	return contextSessionKey(ctx);
}

function createSynctexCallbackServer(): SynctexCallbackServer {
	return new SynctexCallbackServer({ callbackScriptPath: SYNCTEX_CALLBACK_SCRIPT_PATH });
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
	synctexCallbackServers.clear();
	await Promise.all(servers.map((server) => server.close()));
}

const LATEX_FILE_ARTIFACT_EXTENSIONS = [
	".aux",
	".bbl",
	".bcf",
	".blg",
	".dvi",
	".fdb_latexmk",
	".fls",
	".idx",
	".ilg",
	".ind",
	".lof",
	".log",
	".lot",
	".nav",
	".out",
	".pdf",
	".ps",
	".run.xml",
	".snm",
	".synctex",
	".synctex.gz",
	".toc",
	".vrb",
	".xdv",
] as const;

function latexFileArtifactPaths(latexFilePath: string): string[] {
	const dir = dirname(latexFilePath);
	const base = basename(latexFilePath, extname(latexFilePath));
	return LATEX_FILE_ARTIFACT_EXTENSIONS.map((extension) => join(dir, `${base}${extension}`));
}

function cleanLatexFileArtifacts(latexFilePath: string): string[] {
	const removed: string[] = [];
	for (const artifactPath of latexFileArtifactPaths(latexFilePath)) {
		if (!existsSync(artifactPath)) continue;
		rmSync(artifactPath, { force: true });
		removed.push(artifactPath);
	}
	return removed;
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
		source: Type.String({
			description: "Raw LaTeX source code to compile. Prefer passing this tool as FREEFORM/raw text. Optional leading front matter can set compiler and inline, for example: ---\ncompiler: lualatex\ninline: false\n---",
			minLength: 1,
		}),
		compiler: LatexCompilerParam,
		inline: Type.Optional(Type.Boolean({
			description: "When true, rasterize the compiled PDF and show it inline in the Pi TUI instead of opening Zathura. Defaults to true.",
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
			description: "When true, open and track the compiled PDF after successful compilation. Defaults to false.",
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
			description: "Path to an existing local PDF file to open in Zathura and track for later SyncTeX actions.",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

const ClosePdfParams = Type.Object(
	{
		pdf_id: Type.Number({
			description: "Tracked numeric PDF ID returned by open_pdf or compile_latex_file(..., open_pdf=true).",
			minimum: 1,
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
			description: "LaTeX preamble lines to write to /tmp/codex-show-latex/preamble.tex and include before \\begin{document} for show_latex snippet compiles. This overwrites the active temp preamble; if a project preamble was copied there at startup, this makes the active preview preamble diverge from the project's real ./preamble.tex. Use only for pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. Use an empty string to clear it only when intentionally clearing the active preview preamble.",
		}),
	},
	{ additionalProperties: false },
);

const SynctexCallbackCommandParams = Type.Object({}, { additionalProperties: false });

interface ParsedShowLatexInput {
	latexSource: string;
	compiler?: LatexCompiler;
	inline?: boolean;
}

function unquoteFrontMatterScalar(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function parseFrontMatterBoolean(key: string, value: string): boolean {
	const normalized = unquoteFrontMatterScalar(value).toLowerCase();
	if (["true", "yes", "on", "1"].includes(normalized)) return true;
	if (["false", "no", "off", "0"].includes(normalized)) return false;
	throw new Error(`Invalid show_latex front matter value for ${key}: expected true or false`);
}

function parseShowLatexInput(rawInput: string): ParsedShowLatexInput {
	const input = rawInput.replace(/^\uFEFF/, "");
	const frontMatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(input);
	if (!frontMatter) {
		return { latexSource: input };
	}

	const parsed: ParsedShowLatexInput = {
		latexSource: input.slice(frontMatter[0].length),
	};

	for (const rawLine of frontMatter[1].split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf(":");
		if (separator < 0) {
			throw new Error(`Invalid show_latex front matter line: ${rawLine}`);
		}

		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		switch (key) {
			case "compiler":
				parsed.compiler = resolveLatexCompiler(unquoteFrontMatterScalar(value));
				break;
			case "inline":
				parsed.inline = parseFrontMatterBoolean(key, value);
				break;
			default:
				throw new Error(`Unsupported show_latex front matter key: ${key}`);
		}
	}

	return parsed;
}

function compactShowLatexArguments(parsed: ParsedShowLatexInput): Record<string, unknown> {
	const result: Record<string, unknown> = { source: parsed.latexSource };
	if (parsed.compiler !== undefined) result.compiler = parsed.compiler;
	if (parsed.inline !== undefined) result.inline = parsed.inline;
	return result;
}

function prepareShowLatexArguments(args: unknown): Record<string, unknown> {
	if (typeof args === "string") {
		return compactShowLatexArguments(parseShowLatexInput(args));
	}

	if (args && typeof args === "object" && !Array.isArray(args)) {
		const record = args as Record<string, unknown>;
		const source = record.source ?? record.latex_source ?? record.latex ?? record.body ?? record.content ?? record.text ?? record.input;
		const result: Record<string, unknown> = {};
		if (source !== undefined) result.source = source;
		if (record.compiler !== undefined) result.compiler = record.compiler;
		if (record.inline !== undefined) result.inline = record.inline;
		return Object.keys(result).length ? result : record;
	}

	return args as Record<string, unknown>;
}

async function compileAndPreviewLatex(
	latexSource: string,
	compiler?: LatexCompiler,
	synctexEditorCommand?: string,
	signal?: AbortSignal,
	options: ShowLatexCallOptions = {},
): Promise<ShowLatexPreviewResult> {
	if (!latexSource.trim()) {
		throw new Error("latex_source must be a non-empty string");
	}

	if (!existsSync(MCP_SCRIPT_PATH)) {
		throw new Error(`MCP script not found at ${MCP_SCRIPT_PATH}`);
	}

	return mcpClient.callShowLatex(
		applyLatexPreamble(latexSource, readLatexPreambleFromTmpdir(), { cropToContent: options.cropToContent, suppressPageNumbers: options.suppressPageNumbers }),
		compiler,
		synctexEditorCommand,
		signal,
		options,
	);
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
	let inline = true;
	try {
		latexSource = latexSourceInput;
		compiler = resolveLatexCompiler(compilerParam);
		inline = inlineParam !== false;
		if (!inline && ctx) {
			const server = await ensureSynctexCallbacks(ctx);
			synctexCommand = server.command;
		}
		const viewerLogBefore = inline ? undefined : fileSnapshot(MCP_VIEWER_LOG_PATH);
		const preview = await compileAndPreviewLatex(latexSource, compiler, inline ? undefined : synctexCommand, signal, { writeReady: !inline, writeFixed: !inline, cropToContent: false, suppressPageNumbers: inline });
		previewPdfPath = preview.pdfPath;

		if (inline) {
			const pageArtifacts = await rasterizePdfPages(preview.pdfPath, { dpi: 150, signal });
			const artifacts = await mergeInlinePreviewArtifacts(pageArtifacts, { signal });
			const previewId = rememberInlinePreviewRenderState({ pdf: preview.pdfPath, previews: artifacts });
			const inlinePreviews = artifacts.map((artifact) => ({
				pngPath: artifact.pngPath,
				fullPageWidthPx: artifact.fullPageWidthPx,
				fullPageHeightPx: artifact.fullPageHeightPx,
				widthPx: artifact.widthPx,
				heightPx: artifact.heightPx,
			}));
			const primaryImagePath = inlinePreviews[0]?.pngPath ?? "";
			const text = primaryImagePath
				? `✓ LaTeX preview rendered locally\nimage_path=${primaryImagePath}`
				: "✓ LaTeX preview rendered locally";
			return {
				content: [{ type: "text", text }],
				details: {
					inline: true,
					preview_id: previewId,
					pdf: preview.pdfPath,
					image_path: primaryImagePath,
					inline_previews: inlinePreviews,
				},
			};
		}

		let trackedPdfId: number | undefined;
		let openedPdfPath: string | undefined;
		if (!(await previewAlreadyOpen([preview.pdfPath, MCP_FIXED_PREVIEW_PDF_PATH], signal, { viewerLogPath: MCP_VIEWER_LOG_PATH, viewerLogBefore }))) {
			const pdfTracker = pdfTrackerForContext(ctx);
			const trackedPdf = await openAndTrackPdf(
				MCP_FIXED_PREVIEW_PDF_PATH,
				pdfTracker,
				signal,
				synctexCommand
					? (path, abortSignal) => openPdfInZathura(path, abortSignal, { synctexEditorCommand: synctexCommand, reuseExisting: true, requirePersistentViewer: true })
					: undefined,
				undefined,
				synctexCommand || undefined,
			);
			trackedPdfId = trackedPdf.id;
			openedPdfPath = trackedPdf.path;
		}

		return {
			content: [{ type: "text", text: preview.text }],
			details: { pdf: openedPdfPath ?? preview.pdfPath, pdf_id: trackedPdfId, operation_pdf: preview.pdfPath, inline: false, synctex_callback_command: synctexCommand },
		};
	} catch (error) {
		throw latexToolFailure(toolName, "LaTeX preview failed", {
			compiler: compiler ?? compilerParam ?? DEFAULT_LATEX_COMPILER,
			latex_source_length: latexSource.length,
			latex_source_tail: tailText(latexSource, 30000),
			pdf: previewPdfPath,
			fixed_preview_pdf: MCP_FIXED_PREVIEW_PDF_PATH,
			synctex_callback_command: synctexCommand,
		}, error);
	}
}

function resolvePositiveInteger(value: unknown, name: string): number {
	const numberValue = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(numberValue) || numberValue < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return numberValue;
}

function isTmuxKittyTerminal(): boolean {
	return Boolean(process.env.TMUX) && (Boolean(process.env.KITTY_WINDOW_ID) || process.env.TERM_PROGRAM?.toLowerCase() === "kitty");
}

function runTmux(args: string[]): void {
	if (!process.env.TMUX) return;
	spawnSync("tmux", args, { stdio: "ignore" });
}

class InlineLatexPreviewImage implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		private readonly base64Data: string,
		private readonly artifact: InlinePreviewArtifact,
		private readonly fallbackColor: (text: string) => string,
		private readonly filename: string,
	) {}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const maxWidthCells = calculateInlineDisplayColumns(width, this.artifact);
		const image = new Image(this.base64Data, "image/png", { fallbackColor: this.fallbackColor }, {
			maxWidthCells,
			filename: this.filename,
		});

		this.cachedWidth = width;
		this.cachedLines = image.render(width);
		return this.cachedLines;
	}
}

class TmuxKittyPlaceholderImage implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private readonly imageId = Math.floor(Math.random() * 0xfffffe) + 1;

	constructor(
		private readonly title: string,
		private readonly base64Data: string,
		private readonly artifact: InlinePreviewArtifact,
	) {}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const maxWidthCells = calculateInlineDisplayColumns(width, this.artifact);
		const rendered = buildKittyPlaceholderImageRender({
			title: this.title,
			base64Data: this.base64Data,
			imageId: this.imageId,
			width,
			maxWidthCells,
			imageDimensions: getPngDimensions(this.base64Data) ?? this.artifact,
			cellDimensions: getCellDimensions(),
		});

		this.cachedWidth = width;
		this.cachedLines = rendered.lines;
		return this.cachedLines;
	}
}

function renderInlineLatexPreview(result: { content?: Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>; details?: Record<string, unknown> }, theme: unknown, context: unknown): Component {
	const details = result.details ?? {};
	const renderState = inlinePreviewRenderStateFromDetails(details);
	const inlinePreviews = renderState?.previews ?? [];
	const pdf = renderState?.pdf ?? "";
	const canShowImages = !(typeof context === "object" && context !== null && "showImages" in context && (context as { showImages?: unknown }).showImages === false);

	const fg = (role: string, text: string) => {
		if (typeof theme === "object" && theme !== null && "fg" in theme && typeof (theme as { fg?: unknown }).fg === "function") {
			return (theme as { fg: (role: string, text: string) => string }).fg(role, text);
		}
		return text;
	};

	const labelForPaths = (paths: string[]): string =>
		paths.length === 1 ? `PNG: ${paths[0]}` : `PNGs:\n${paths.join("\n")}`;

	const validatedPreviews: InlinePreviewArtifact[] = [];
	const unavailablePngPaths: string[] = [];
	for (const preview of inlinePreviews) {
		const safePath = safeInlinePreviewPngPath(preview.pngPath);
		if (!safePath) {
			if (preview.pngPath) unavailablePngPaths.push(preview.pngPath);
			continue;
		}

		validatedPreviews.push(safePath === preview.pngPath ? preview : { ...preview, pngPath: safePath });
	}

	if (validatedPreviews.length === 0) {
		if (unavailablePngPaths.length > 0) {
			return new Text(`ok: ${pdf}\n${fg("muted", `Inline preview unavailable: ${labelForPaths(unavailablePngPaths)}`)}`, 0, 0);
		}
		return new Text(`ok: ${pdf}\nInline preview: unavailable`, 0, 0);
	}

	if (unavailablePngPaths.length > 0) {
		return new Text(`ok: ${pdf}\n${fg("muted", `Inline preview unavailable: ${labelForPaths(unavailablePngPaths)}`)}`, 0, 0);
	}

	if (!canShowImages) {
		const label = validatedPreviews.map((preview) => preview.pngPath);
		return new Text(
			`${fg("success", "ok")}: ${pdf}\n${fg("muted", `Inline image display is not supported by this terminal. ${labelForPaths(label)}`)}`,
			0,
			0,
		);
	}

	const title = `${fg("success", "✓ LaTeX preview")}`;
	const container = new Container();
	container.addChild(new Text(title, 0, 0));

	const readImageData = (preview: InlinePreviewArtifact): string | null => {
		const safePath = safeInlinePreviewPngPath(preview.pngPath);
		if (!safePath) return null;
		try {
			return readFileSync(safePath).toString("base64");
		} catch {
			return null;
		}
	};

	if (isTmuxKittyTerminal()) {
		terminalRefreshPolicy.rememberInvalidator(context);
		for (const preview of validatedPreviews) {
			const base64 = readImageData(preview);
			if (base64 === null) {
				return new Text(`ok: ${pdf}\n${fg("muted", `Inline preview unavailable: ${labelForPaths([preview.pngPath])}`)}`, 0, 0);
			}
			container.addChild(new TmuxKittyPlaceholderImage("", base64, preview));
		}
		return container;
	}

	if (!getCapabilities().images) {
		const label = validatedPreviews.map((preview) => preview.pngPath);
		return new Text(`${fg("success", "ok")}: ${pdf}\n${fg("muted", `Inline image display is not supported by this terminal. ${labelForPaths(label)}`)}`, 0, 0);
	}

	for (const preview of validatedPreviews) {
		const base64 = readImageData(preview);
		if (base64 === null) {
			return new Text(`ok: ${pdf}\n${fg("muted", `Inline preview unavailable: ${labelForPaths([preview.pngPath])}`)}`, 0, 0);
		}
		container.addChild(new InlineLatexPreviewImage(base64, preview, (text) => fg("muted", text), preview.pngPath));
	}

	return container;
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

	pi.on("session_start", (_event, ctx) => {
		terminalRefreshPolicy.cleanup();
		terminalRefreshPolicy.install({ hasUI: ctx.hasUI, ui: ctx.ui });

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
		description: "FREEFORM/raw LaTeX preview. Pass LaTeX code directly; optional YAML-like front matter may set compiler and inline. Example: ---\ncompiler: lualatex\ninline: true\n---\n\\begin{equation}\nx\n\\end{equation}\nThe \\begin{document}...\\end{document} wrapper is accepted but not required. Defaults to inline preview with lualatex; set inline=false to open/refresh the viewer instead.",
		promptSnippet: "FREEFORM LaTeX preview; optional front matter can set compiler and inline",
		promptGuidelines: [
			"Use show_latex when the user asks for a LaTeX PDF preview. Prefer passing only the LaTeX body, for example \\[x\\]; \\begin{document}...\\end{document} is accepted but usually unnecessary.",
			"Use optional front matter only when changing options, for example: ---\ncompiler: xelatex\ninline: false\n---",
			"show_latex renders inline by default; set inline=false only when the user wants an external viewer.",
			"Do not use verbatim-like LaTeX constructs (for example, \\begin{verbatim}, lstlisting, minted, or \\verb) to show the user LaTeX code; provide real LaTeX that compiles and renders the requested content.",
			"In an existing LaTeX project, assume ./preamble.tex or ./praeamble.tex has already been copied into /tmp/codex-show-latex/preamble.tex. Do not add a standalone \\documentclass or repeat the project preamble unless the user explicitly asks.",
			"If a project snippet preview fails, inspect the log and project preamble, or restore the project preamble in /tmp/codex-show-latex/preamble.tex. Do not call set_latex_preamble with a minimal preamble as a workaround unless the user explicitly asks to change the active preview preamble.",
		],
		renderShell: "self",
		parameters: ShowLatexParams,
		prepareArguments: prepareShowLatexArguments,
		renderResult: renderShowLatexResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parsed = parseShowLatexInput(String(params.source ?? ""));
			return executeShowLatexPreviewTool("show-latex", parsed.latexSource, params.compiler ?? parsed.compiler, params.inline ?? parsed.inline, signal, ctx);
		},
	});

	pi.registerTool({
		name: "open_pdf",
		label: "Open PDF",
		description: "Open an existing local PDF in Zathura and track it for later SyncTeX actions. Returns a short numeric pdf_id that is valid only for the current running Pi session. Opening the same PDF path again reuses the existing tracked or visible viewer where practical. Zathura is launched with this session's inverse SyncTeX callback so PDF clicks paste source references into the interactive editor without submitting.",
		promptSnippet: "Open and track a local PDF in Zathura",
		promptGuidelines: [
			"Use open_pdf when the user asks to view an existing PDF or when you need a pdf_id for later PDF actions.",
			"Pass an existing local PDF path. The returned pdf_id is short-lived and valid only in the current Pi session.",
			"Opening the same normalized PDF path again should return the existing pdf_id instead of creating a duplicate viewer where practical.",
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

				if (!ctx) {
					throw new Error("open_pdf requires a Pi agent session context");
				}
				const server = await ensureSynctexCallbacks(ctx);
				synctexCommand = server.command;
				const pdfTracker = pdfTrackerForContext(ctx);
				const trackedPdf = await openAndTrackPdf(
					requestedPath,
					pdfTracker,
					signal,
					synctexCommand
						? (path, abortSignal) => openPdfInZathura(path, abortSignal, { synctexEditorCommand: synctexCommand, reuseExisting: true, requirePersistentViewer: true })
						: undefined,
					undefined,
					synctexCommand,
				);
				pdfPath = trackedPdf.path;
				const pidText = trackedPdf.pid === undefined ? "" : ` pid=${trackedPdf.pid}`;
				const text = synctexCommand
					? `ok: pdf_id=${trackedPdf.id}${pidText} pdf=${trackedPdf.path}\nsynctex_callback_command=${synctexCommand}`
					: `ok: pdf_id=${trackedPdf.id}${pidText} pdf=${trackedPdf.path}`;
				return {
					content: [{ type: "text", text }],
					details: { pdf_id: trackedPdf.id, pid: trackedPdf.pid, pdf: trackedPdf.path, source: trackedPdf.sourceFile, synctex_callback_command: synctexCommand },
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
		name: "close_pdf",
		label: "Close PDF",
		description: "Close an extension-tracked Zathura PDF window by pdf_id. When the Zathura process ID is known, only that instance is closed; otherwise the extension falls back to local zathura processes whose command line contains the tracked PDF path. The PDF is then removed from this session's tracking table.",
		promptSnippet: "Close a tracked PDF in Zathura",
		promptGuidelines: [
			"Use close_pdf when the user asks to close a PDF previously opened or tracked by this extension.",
			"Pass the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true).",
		],
		parameters: ClosePdfParams,
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let pdfId = 0;
			try {
				pdfId = resolvePositiveInteger(params.pdf_id, "pdf_id");
				const pdfTracker = pdfTrackerForContext(ctx);
				const result = closeTrackedPdf(pdfId, pdfTracker);
				const closedText = result.closedPids.length ? `closed_pids=${result.closedPids.join(",")}` : "closed_pids=none";
				return {
					content: [{ type: "text", text: `ok: pdf_id=${pdfId} pdf=${result.pdf} ${closedText}` }],
					details: { pdf_id: pdfId, pdf: result.pdf, closed_pids: result.closedPids },
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
		description: "Perform a line-based Zathura forward SyncTeX jump in an already tracked PDF. Requires the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); arbitrary PDF paths are not accepted. The PDF must have SyncTeX data, and the source file must be readable. Uses the tracked default source file when known, or pass source_file when no default source was inferred or when jumping to an included .tex file. On success, the text result names the jumped line and then shows the verbatim LaTeX source line.",
		promptSnippet: "Jump to a source line in a tracked PDF",
		promptGuidelines: [
			"Use jump_pdf to move an already tracked Zathura PDF to a source line via forward SyncTeX.",
			"Pass the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); do not pass arbitrary PDF paths.",
			"Reuse the same pdf_id for repeated jumps within one tracked PDF.",
			"source_file is optional only when the target line is in the tracked default source file; provide it whenever the target is in another source file or needs disambiguation.",
			"When the target content is in a file included by \\input, \\include, or similar, pass source_file as the included .tex file and use the line number from that included file. Do not jump to the parent file's \\input/\\include line unless that directive itself is the target.",
			"Mental model: pdf_id = viewer/PDF; source_file = TeX file containing the target line. For multi-file LaTeX, compile/open main.tex once, keep its pdf_id, and use jump_pdf(pdf_id, line, source_file=<included file>) for all fragments. Never open a new PDF merely because the target line is in another included file.",
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
				const pdfTracker = pdfTrackerForContext(ctx);

				const result = await jumpToTrackedPdf(
					pdfId,
					line,
					sourceFile,
					pdfTracker,
					signal,
					synctexCommand ? { synctexEditorCommand: synctexCommand } : {},
				);
				const sourceLine = readSourceLine(result.sourceFile, result.line, process.cwd()) ?? "";
				return {
					content: [{ type: "text", text: `line ${result.line} contains:\n${sourceLine}` }],
					details: { pdf_id: pdfId, line, source: result.sourceFile, pdf: result.pdf, reopened: result.reopened, source_line: sourceLine },
				};
			} catch (error) {
				const failureContext: Record<string, unknown> = {
					pdf_id: pdfId || params.pdf_id,
					line: line || params.line,
					source_file: sourceFile ?? params.source_file,
					synctex_callback_command: synctexCommand,
				};
				if (ctx && pdfId > 0) {
					failureContext.jump_failure_context = describePdfJumpFailureContext(pdfId, pdfTrackerForContext(ctx), synctexCommand || undefined);
				}
				throw latexToolFailure("jump-pdf", "PDF jump failed", failureContext, error);
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
		description: "Compile an existing local LaTeX source file from its own directory. Defaults to lualatex; pass compiler to choose lualatex, pdflatex, xelatex, or latexmk. Set clean=true to remove common same-basename LaTeX artifacts before compiling. Set open_pdf=true to open and track the successfully compiled PDF; leave it false (the default) to compile without opening a viewer window. Relative \\input, \\include, graphics, bibliography, and other project files are resolved the same way they are when compiling the file directly from its directory. The fixed temp preamble is not injected for file compiles.",
		promptSnippet: "Compile a local LaTeX file as PDF",
		promptGuidelines: [
			"Prefer compile_latex_file over invoking a bare compiler directly when the user has an existing .tex file to build.",
			"By default this compiles only. Leave open_pdf false (or omit it) when you want to compile without opening a window; set open_pdf=true only when the user wants the compiled PDF opened/tracked immediately.",
			"Use clean=true when stale or broken same-basename LaTeX artifacts may be causing problems. It removes common artifacts such as .aux, .log, .out, .pdf, .synctex, and .synctex.gz before compiling.",
			"Use this for complete .tex documents. File compiles run in the file's own directory so relative includes and assets resolve normally, and the fixed temp preamble is not injected.",
			"For multi-file LaTeX projects, compile/open the root file that produces the PDF, such as main.tex. The returned pdf_id identifies the resulting PDF/viewer and can be reused for jumps into any included .tex file via jump_pdf with source_file set explicitly.",
			"On failure this tool returns only a short error message and writes details to a temporary log file.",
		],
		parameters: CompileLatexFileParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let requestedPath = "";
			let latexFilePath = "";
			let pdfPath = "";
			let compiler: LatexCompiler | undefined;
			let shouldOpenPdf = false;
			let shouldClean = false;
			let cleanedArtifacts: string[] = [];
			let synctexCommand = "";
			try {
				requestedPath = String(params.latex_file_path ?? "");
				if (!requestedPath.trim()) {
					throw new Error("latex_file_path must be a non-empty string");
				}

				latexFilePath = resolveLatexFilePath(requestedPath);
				compiler = resolveLatexCompiler(params.compiler);
				shouldOpenPdf = params.open_pdf === true;
				shouldClean = params.clean === true;
				const compileResult = await compileLatexFile(latexFilePath, compiler, signal, shouldClean);
				pdfPath = compileResult.pdfPath;
				cleanedArtifacts = compileResult.cleanedArtifacts;
				if (!shouldOpenPdf) {
					return {
						content: [{ type: "text", text: `ok: ${pdfPath}` }],
						details: { source: latexFilePath, pdf: pdfPath, clean: shouldClean, cleaned_artifacts: cleanedArtifacts },
					};
				}

				try {
					if (!ctx) {
						throw new Error("compile_latex_file with open_pdf=true requires a Pi agent session context");
					}
					const server = await ensureSynctexCallbacks(ctx);
					synctexCommand = server.command;
					const pdfTracker = pdfTrackerForContext(ctx);
					const trackedPdf = await openAndTrackPdf(
						pdfPath,
						pdfTracker,
						signal,
						synctexCommand
							? (path, abortSignal) => openPdfInZathura(path, abortSignal, { synctexEditorCommand: synctexCommand, reuseExisting: true, requirePersistentViewer: true })
							: undefined,
						latexFilePath,
						synctexCommand,
					);
					const pidText = trackedPdf.pid === undefined ? "" : ` pid=${trackedPdf.pid}`;
					const text = synctexCommand
						? `ok: pdf_id=${trackedPdf.id}${pidText} pdf=${trackedPdf.path}\nsynctex_callback_command=${synctexCommand}`
						: `ok: pdf_id=${trackedPdf.id}${pidText} pdf=${trackedPdf.path}`;
					return {
						content: [{ type: "text", text }],
						details: { source: latexFilePath, pdf: trackedPdf.path, pdf_id: trackedPdf.id, pid: trackedPdf.pid, clean: shouldClean, cleaned_artifacts: cleanedArtifacts, synctex_callback_command: synctexCommand },
					};
				} catch (error) {
					throw latexToolFailure("compile-latex-file", "LaTeX compile succeeded but opening failed", {
						requested_path: requestedPath,
						source: latexFilePath,
						compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
						clean: shouldClean,
						cleaned_artifacts: cleanedArtifacts,
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
					clean: shouldClean,
					cleaned_artifacts: cleanedArtifacts,
					pdf: pdfPath,
					synctex_callback_command: synctexCommand,
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "set_latex_preamble",
		label: "Set LaTeX Preamble",
		description: "Set LaTeX preamble lines inserted before \\begin{document} in subsequent show_latex snippet compiles. This overwrites the active temp preamble at /tmp/codex-show-latex/preamble.tex. If a project preamble was copied there at startup, this changes the active preview preamble for the rest of the session and can make it diverge from the project's real ./preamble.tex or ./praeamble.tex. It should contain pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. compile_latex_file compiles complete files directly and does not inject this preamble.",
		promptSnippet: "Set a LaTeX preamble for future PDF previews",
		promptGuidelines: [
			"Use set_latex_preamble only when the user explicitly wants to change packages/macros/options for every subsequent snippet preview.",
			"In an existing LaTeX project, remember that this overwrites the already-copied active temp preamble, not just an isolated one-off preview setting. Do not use it after a failed preview unless the user explicitly wants to replace the active session preamble.",
			"Do not install a minimal standalone preamble inside an existing LaTeX project as a workaround for a failed show_latex compile. Inspect the log and project preamble first, and restore the project preamble into /tmp/codex-show-latex/preamble.tex if it diverged.",
			"For reusable project defaults, write pre-\\begin{document} code to ./preamble.tex or ./praeamble.tex before starting the Pi session so it is copied into /tmp/codex-show-latex/preamble.tex.",
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
			const key = contextSessionKey(ctx);
			pdfTrackersByContext.get(key)?.clear();
			pdfTrackersByContext.delete(key);
		}
		await shutdownSynctexCallbacks(ctx);
		await mcpClient.shutdown();
	});
}

import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createLogger } from "../logging.ts";

const logger = createLogger("latex.compiler");

export const DEFAULT_LATEX_COMPILER = "lualatex" as const;
export const LATEX_COMPILERS = [DEFAULT_LATEX_COMPILER, "pdflatex", "xelatex", "latexmk"] as const;

export type LatexCompiler = (typeof LATEX_COMPILERS)[number];

export type LatexCompileStatus = "ok" | "ok_with_warnings" | "nonzero_but_pdf_updated";
export type LatexCompileFailureCode =
	| "compiler_start_failed"
	| "compile_aborted"
	| "compile_timeout"
	| "compile_failed"
	| "failed_no_pdf"
	| "failed_stale_pdf_exists";

export interface LatexDiagnosticSummary {
	kind: string;
	message: string;
	line?: number;
	source?: string;
}

export interface LatexFileCompileRequest {
	requestedPath: string;
	compiler?: unknown;
	signal?: AbortSignal;
	clean?: boolean;
	cwd?: string;
}

export interface LatexFileCompileResult {
	source: string;
	pdfPath: string;
	logPath: string;
	clean: boolean;
	cleanedArtifacts: string[];
	compileStatus: LatexCompileStatus;
	compilerExitCode: number | null;
	compilerSignal: string | null;
	warningCount: number;
	warnings: LatexDiagnosticSummary[];
	warningsTruncated: boolean;
}

export interface LatexFileToolDetails {
	source: string;
	pdf: string;
	log: string;
	clean: boolean;
	cleaned_artifacts: string[];
	compile_status: LatexCompileStatus;
	compiler_exit_code: number | null;
	compiler_signal: string | null;
	warning_count: number;
	warnings: LatexDiagnosticSummary[];
	warnings_truncated: boolean;
}

interface LatexCommandSpec {
	displayName: string;
	command: string;
	args: string[];
	acceptUnchangedPdfWhenOutputWritten?: boolean;
}

interface LatexCommandResult {
	exitCode: number | null;
	signal: string | null;
	output: string;
	timedOut: boolean;
	aborted: boolean;
}

export class LoggedToolError extends Error {
	readonly logPath: string;
	readonly tail: string;
	readonly errorCode: string;
	readonly diagnostics: LatexDiagnosticSummary[];
	readonly diagnosticSummary: string;
	readonly pdfPath?: string;

	constructor(
		message: string,
		logPath: string,
		tail = "",
		options: {
			errorCode?: string;
			diagnostics?: LatexDiagnosticSummary[];
			diagnosticSummary?: string;
			pdfPath?: string;
		} = {},
	) {
		super(message);
		this.name = "LoggedToolError";
		this.logPath = logPath;
		this.tail = tail;
		this.errorCode = options.errorCode ?? "compile_failed";
		this.diagnostics = options.diagnostics ?? [];
		this.diagnosticSummary = options.diagnosticSummary ?? "";
		this.pdfPath = options.pdfPath;
	}
}

export interface LatexFileCompileToolSupport {
	resolveLatexCompiler(compiler: unknown): LatexCompiler | undefined;
	resolveLatexFilePath(latexFilePath: string, cwd?: string): string;
	compileLatexFile(request: LatexFileCompileRequest): Promise<LatexFileCompileResult>;
	buildToolResult(result: LatexFileCompileResult): LatexFileToolDetails;
}

const MCP_TMPDIR = process.env.MCP_TMPDIR ?? resolve(process.env.XDG_RUNTIME_DIR || process.env.HOME || process.cwd(), "tex-actions");
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 12_000;
const MAX_TAIL_BYTES = 30_000;
const MAX_LOG_PARSE_BYTES = 200_000;
const LATEX_ERROR_TAIL_LINES = 20;
const MAX_REPORTED_DIAGNOSTICS = 10;
const MAX_SUMMARY_DIAGNOSTICS = 5;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 500;
const PDF_FRESHNESS_TOLERANCE_MS = 1000;
const LATEXMK_MISSING_MESSAGE = "latexmk is required for this compile mode. Install MacTeX or TeX Live so the latexmk command is available on PATH; BasicTeX users may need to install latexmk separately (for example with tlmgr) and then restart the Host Service so it sees the updated PATH.";
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

function tailText(text: string, limit = MAX_OUTPUT_BYTES): string {
	return text.length <= limit ? text : `...\n${text.slice(-limit)}`;
}

function lastLines(text: string, count = LATEX_ERROR_TAIL_LINES): string {
	return text
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.slice(-count)
		.join("\n");
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function readTail(path: string, limit = MAX_OUTPUT_BYTES): string {
	try {
		return tailText(readFileSync(path, "utf8"), limit);
	} catch {
		return "";
	}
}

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function readTextTail(path: string, limit = MAX_LOG_PARSE_BYTES): string {
	let file;
	try {
		const status = statSync(path);
		if (!status.isFile()) return "";
		if (status.size <= limit) return readText(path);
		file = openSync(path, "r");
		const buffer = Buffer.alloc(limit);
		readSync(file, buffer, 0, limit, status.size - limit);
		return `...\n${buffer.toString("utf8")}`;
	} catch {
		return "";
	} finally {
		if (file !== undefined) closeSync(file);
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
	const safePrefix = prefix.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "latex";
	mkdirSync(MCP_TMPDIR, { recursive: true, mode: 0o700 });
	return resolve(MCP_TMPDIR, `${safePrefix}.${process.pid}.${Date.now()}.log`);
}

function latexCompileErrorLogPath(): string {
	return latexErrorLogPath("compile-latex-file");
}

function latexCommandLine(spec: LatexCommandSpec): string {
	return [spec.command, ...spec.args].map((part) => JSON.stringify(part)).join(" ");
}

function truncateDiagnosticMessage(message: string): string {
	return message.length <= MAX_DIAGNOSTIC_MESSAGE_CHARS
		? message
		: `${message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS).trimEnd()}...`;
}

function diagnosticSummary(diagnostics: LatexDiagnosticSummary[], heading: string): string {
	if (diagnostics.length === 0) return "";
	return `${heading}:\n${diagnostics.slice(0, MAX_SUMMARY_DIAGNOSTICS).map((entry) => `- ${entry.message}`).join("\n")}`;
}

function shortFailureMessage(shortMessage: string, logPath: string, tail: string, diagnostics: LatexDiagnosticSummary[] = []): string {
	const summary = diagnosticSummary(diagnostics, "Error summary");
	if (summary) {
		return `${shortMessage}.\n${summary}\nLog: ${logPath}`;
	}
	const tailLines = lastLines(tail, LATEX_ERROR_TAIL_LINES);
	return tailLines
		? `${shortMessage}. Log: ${logPath}\nLast ${LATEX_ERROR_TAIL_LINES} lines:\n${tailLines}`
		: `${shortMessage}. Log: ${logPath}`;
}

function lineNumberFromText(text: string): number | undefined {
	const inputLine = /(?:input line|line)\s+(\d+)/i.exec(text);
	if (inputLine) return Number(inputLine[1]);
	const lLine = /^l\.(\d+)\b/m.exec(text);
	if (lLine) return Number(lLine[1]);
	const fileLine = /\.tex:(\d+):/.exec(text);
	if (fileLine) return Number(fileLine[1]);
	return undefined;
}

function normalizeDiagnosticBlock(kind: string, block: string): LatexDiagnosticSummary {
	const fullMessage = block.replace(/[ \t]+\n/g, "\n").trim();
	const message = truncateDiagnosticMessage(fullMessage);
	const sourceMatch = /([^\s()]+\.tex):(\d+):/.exec(fullMessage);
	return {
		kind,
		message,
		...(lineNumberFromText(fullMessage) === undefined ? {} : { line: lineNumberFromText(fullMessage) }),
		...(sourceMatch ? { source: sourceMatch[1] } : {}),
	};
}

function diagnosticKey(diagnostic: LatexDiagnosticSummary): string {
	return `${diagnostic.kind}\0${diagnostic.message}`;
}

function dedupeDiagnostics(diagnostics: LatexDiagnosticSummary[]): LatexDiagnosticSummary[] {
	const seen = new Set<string>();
	const result: LatexDiagnosticSummary[] = [];
	for (const diagnostic of diagnostics) {
		const key = diagnosticKey(diagnostic);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(diagnostic);
	}
	return result;
}

function collectDiagnosticBlock(lines: string[], index: number): { block: string; nextIndex: number } {
	const block = [lines[index]];
	let cursor = index + 1;
	while (cursor < lines.length && block.length < 8) {
		const line = lines[cursor];
		if (!line.trim()) break;
		if (/^(?:LaTeX(?: Font)? Warning:|Package .+ Warning:|Class .+ Warning:|(?:pdf|Lua|Xe)TeX warning\b|(?:Over|Under)full \\[hv]box\b|!|.+\.tex:\d+:)/i.test(line)) break;
		if (/^(?:\([^)]+\)\s+|\s{2,}\S|l\.\d+\b)/.test(line)) {
			block.push(line);
			cursor += 1;
			continue;
		}
		break;
	}
	return { block: block.join("\n"), nextIndex: cursor };
}

export function extractLatexWarnings(text: string): { warnings: LatexDiagnosticSummary[]; truncated: boolean; total: number } {
	const lines = text.split(/\r?\n/);
	const warnings: LatexDiagnosticSummary[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		let kind = "warning";
		if (/^(?:Over|Under)full \\[hv]box\b/.test(line)) kind = "badbox";
		else if (/undefined references?|Citation .* undefined|Label\(s\) may have changed/i.test(line)) kind = "undefined_reference";
		else if (/destination with the same identifier/i.test(line)) kind = "duplicate_destination";
		const startsWarning = /^(?:LaTeX(?: Font)? Warning:|Package .+ Warning:|Class .+ Warning:|(?:pdf|Lua|Xe)TeX warning\b)/i.test(line)
			|| /^(?:Over|Under)full \\[hv]box\b/.test(line)
			|| /(?:undefined references?|Citation .* undefined|Label\(s\) may have changed|destination with the same identifier)/i.test(line);
		if (!startsWarning) continue;
		const collected = collectDiagnosticBlock(lines, index);
		warnings.push(normalizeDiagnosticBlock(kind, collected.block));
		index = collected.nextIndex - 1;
	}
	const deduped = dedupeDiagnostics(warnings);
	return {
		warnings: deduped.slice(0, MAX_REPORTED_DIAGNOSTICS),
		truncated: deduped.length > MAX_REPORTED_DIAGNOSTICS,
		total: deduped.length,
	};
}

export function extractLatexFatalDiagnostics(text: string): LatexDiagnosticSummary[] {
	const lines = text.split(/\r?\n/);
	const diagnostics: LatexDiagnosticSummary[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		let kind = "fatal";
		const startsFatal = /^!\s*(?:LaTeX|Package .+|Class .+)?\s*Error:/i.test(line)
			|| /^!\s*Undefined control sequence\.?/i.test(line)
			|| /^Undefined control sequence\.?/i.test(line)
			|| /^Emergency stop\.?/i.test(line)
			|| /^Fatal error occurred/i.test(line)
			|| /^No pages of output\.?/i.test(line)
			|| /^Runaway argument\?/i.test(line)
			|| /^TeX capacity exceeded/i.test(line)
			|| /^.+\.tex:\d+:/i.test(line);
		if (!startsFatal) continue;
		if (/undefined control sequence/i.test(line)) kind = "undefined_control_sequence";
		else if (/emergency stop/i.test(line)) kind = "emergency_stop";
		else if (/file .* not found|not found/i.test(line)) kind = "missing_file";
		const collected = collectDiagnosticBlock(lines, index);
		diagnostics.push(normalizeDiagnosticBlock(kind, collected.block));
		index = collected.nextIndex - 1;
	}
	return dedupeDiagnostics(diagnostics).slice(0, MAX_REPORTED_DIAGNOSTICS);
}

function escapedBasename(path: string): string {
	return basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function latexLogSaysOutputWritten(text: string, pdfPath: string): boolean {
	const pdfName = escapedBasename(pdfPath);
	return new RegExp(`Output written on .*${pdfName}(?:\\s|\\(|$)`, "i").test(text);
}

function latexmkOutputSaysTargetUpToDate(text: string, latexFilePath: string, pdfPath: string): boolean {
	const sourceName = escapedBasename(latexFilePath);
	const pdfName = escapedBasename(pdfPath);
	return new RegExp(`Latexmk: .*Nothing to do for ['\"]?${sourceName}['\"]?\\.?`, "i").test(text)
		|| new RegExp(`Latexmk: .*All targets \\([^)]*${pdfName}[^)]*\\) are up-to-date`, "i").test(text)
		|| new RegExp(`Latexmk: .*${pdfName}.*up-to-date`, "i").test(text);
}

function outputPdfStat(pdfPath: string): Stats | undefined {
	try {
		const status = statSync(pdfPath);
		return status.isFile() ? status : undefined;
	} catch {
		return undefined;
	}
}

function fileWasUpdated(before: Stats | undefined, after: Stats | undefined, compileStartMs: number): boolean {
	if (after === undefined) return false;
	if (before === undefined) return after.mtimeMs >= compileStartMs - PDF_FRESHNESS_TOLERANCE_MS;
	if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return true;
	return before.mtimeMs < compileStartMs - PDF_FRESHNESS_TOLERANCE_MS
		&& after.mtimeMs >= compileStartMs - PDF_FRESHNESS_TOLERANCE_MS;
}

function pdfWasUpdated(before: Stats | undefined, after: Stats | undefined, compileStartMs: number): boolean {
	return fileWasUpdated(before, after, compileStartMs);
}

function combinedLatexLog(latexFilePath: string, compilerOutput: string): string {
	const projectLog = readTextTail(latexLogPath(latexFilePath));
	return [projectLog, compilerOutput].filter((entry) => entry.trim()).join("\n");
}

function writeLatexCompileErrorLog(
	latexFilePath: string,
	spec: LatexCommandSpec,
	reason: string,
	compilerOutput: string,
	diagnostics: LatexDiagnosticSummary[] = [],
): string {
	const projectLogPath = latexLogPath(latexFilePath);
	const projectLogTail = readTail(projectLogPath, MAX_TAIL_BYTES).trim();
	const outputTail = tailText(compilerOutput.trim(), MAX_TAIL_BYTES).trim();
	const tempLogPath = latexCompileErrorLogPath();
	const sections = [
		"LaTeX file compilation failed",
		`source: ${latexFilePath}`,
		`cwd: ${dirname(latexFilePath)}`,
		`compiler: ${spec.displayName}`,
		`command: ${latexCommandLine(spec)}`,
		`reason: ${reason}`,
		diagnostics.length ? `\n--- diagnostic summary ---\n${diagnostics.map((entry) => `- ${entry.message}`).join("\n")}` : "",
		projectLogTail ? `\n--- project log tail (${projectLogPath}) ---\n${projectLogTail}` : "",
		outputTail ? `\n--- compiler output tail ---\n${outputTail}` : "",
	].filter((section) => section.length > 0);

	writeFileSync(tempLogPath, `${sections.join("\n")}\n`, { mode: 0o600 });
	return tempLogPath;
}

function latexCompileErrorTail(latexFilePath: string, reason: string, compilerOutput: string): string {
	const projectLogTail = readTail(latexLogPath(latexFilePath), MAX_TAIL_BYTES).trim();
	const outputTail = tailText(compilerOutput.trim(), MAX_TAIL_BYTES).trim();
	return lastLines(projectLogTail || outputTail || reason, LATEX_ERROR_TAIL_LINES);
}

function writeLatexCompileError(
	errorPath: string,
	spec: LatexCommandSpec,
	reason: string,
	compilerOutput: string,
	diagnostics: LatexDiagnosticSummary[] = [],
): string {
	return writeLatexCompileErrorLog(errorPath, spec, reason, compilerOutput, diagnostics);
}

function latexCompileFailure(
	latexFilePath: string,
	spec: LatexCommandSpec,
	reason: string,
	compilerOutput: string,
	errorCode: LatexCompileFailureCode = "compile_failed",
	diagnostics: LatexDiagnosticSummary[] = [],
	pdfPath?: string,
): Error {
	try {
		const effectiveDiagnostics = diagnostics.length ? diagnostics : extractLatexFatalDiagnostics(combinedLatexLog(latexFilePath, compilerOutput));
		const tempLogPath = writeLatexCompileError(latexFilePath, spec, reason, compilerOutput, effectiveDiagnostics);
		const tail = latexCompileErrorTail(latexFilePath, reason, compilerOutput);
		const summary = diagnosticSummary(effectiveDiagnostics, "Error summary");
		return new LoggedToolError(
			shortFailureMessage(`LaTeX compile failed: ${errorCode}`, tempLogPath, tail, effectiveDiagnostics),
			tempLogPath,
			tail,
			{ errorCode, diagnostics: effectiveDiagnostics, diagnosticSummary: summary, pdfPath: pdfPath && outputPdfStat(pdfPath) ? pdfPath : undefined },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`LaTeX compile failed. Could not write temp log: ${message}`);
	}
}

export function latexmkEngineArgs(compiler: LatexCompiler | undefined): string[] {
	switch (compiler) {
		case "pdflatex":
			return ["-pdf", "-pdflatex=pdflatex -no-shell-escape %O %S"];
		case "xelatex":
			return ["-pdfxe", "-xelatex=xelatex -no-shell-escape %O %S"];
		case "latexmk":
		case undefined:
		case "lualatex":
			return ["-pdf", "-lualatex", "-pdflualatex=lualatex -no-shell-escape %O %S"];
	}
}

export function latexmkEngineIdentity(compiler: LatexCompiler | undefined): string {
	return latexmkEngineArgs(compiler).join("\u0000");
}

export function latexmkSourceOperand(rootSource: string): string {
	const sourceName = basename(rootSource);
	return sourceName.startsWith("-") ? `./${sourceName}` : sourceName;
}

export const LATEXMK_CONTINUOUS_EVENT_PREFIX = "agent-synctex-latexmk-event:";
export const LATEXMK_CONTINUOUS_POLL_INTERVAL_SECONDS = 0.1;

function latexmkContinuousConfig(): string[] {
	const eventCommand = (event: string) => `printf '${LATEXMK_CONTINUOUS_EVENT_PREFIX}%s\\n' ${event}`;
	return [
		"-e",
		[
			`$sleep_time = ${LATEXMK_CONTINUOUS_POLL_INTERVAL_SECONDS};`,
			`$compiling_cmd = q{${eventCommand("compiling")}};`,
			`$success_cmd = q{${eventCommand("success")}};`,
			`$warning_cmd = q{${eventCommand("warning")}};`,
			`$failure_cmd = q{${eventCommand("failure")}};`,
		].join(" "),
	];
}

function latexmkCompileArgs(latexFilePath: string, compiler: LatexCompiler | undefined, continuous: boolean): string[] {
	return [
		...(continuous ? ["-pvc", ...latexmkContinuousConfig()] : []),
		"-norc",
		"-view=none",
		"-recorder",
		"-synctex=1",
		"-interaction=nonstopmode",
		"-halt-on-error",
		"-file-line-error",
		...latexmkEngineArgs(compiler),
		latexmkSourceOperand(latexFilePath),
	];
}

export function latexmkContinuousArgs(rootSource: string, compiler: LatexCompiler | undefined): string[] {
	return latexmkCompileArgs(rootSource, compiler, true);
}

function latexCommandForFile(latexFilePath: string, compiler?: LatexCompiler): LatexCommandSpec {
	const requested = compiler ?? DEFAULT_LATEX_COMPILER;
	return {
		displayName: requested === "latexmk" ? "latexmk(lualatex)" : `latexmk(${requested})`,
		command: "latexmk",
		args: latexmkCompileArgs(latexFilePath, requested, false),
		acceptUnchangedPdfWhenOutputWritten: true,
	};
}

function runLatexCommand(spec: LatexCommandSpec, cwd: string, signal?: AbortSignal): Promise<LatexCommandResult> {
	return new Promise((resolvePromise, reject) => {
		const startedAt = Date.now();
		if (signal?.aborted) {
			resolvePromise({ exitCode: null, signal: null, output: "", timedOut: false, aborted: true });
			return;
		}

		let output = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;

		logger.debug("process.spawn", { command: spec.command, args: spec.args, cwd });
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
			if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
		};

		child.stdout.on("data", appendOutput);
		child.stderr.on("data", appendOutput);

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, REQUEST_TIMEOUT_MS);

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
			logger.error("process.error", { command: spec.command, cwd, duration_ms: Date.now() - startedAt, error });
			finish(() => reject(error));
		});

		child.on("close", (exitCode, closeSignal) => {
			logger.debug("process.close", {
				command: spec.command,
				cwd,
				duration_ms: Date.now() - startedAt,
				exit_code: exitCode,
				signal: closeSignal,
				timed_out: timedOut,
				aborted,
			});
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

function resolveLatexFilePath(latexFilePath: string, cwd = process.cwd()): string {
	return resolve(cwd, expandHomePath(latexFilePath.trim()));
}

function resolveLatexCompiler(compiler: unknown): LatexCompiler | undefined {
	if (compiler === undefined || compiler === null) return undefined;
	const value = String(compiler).trim().toLowerCase();
	if (!value) return undefined;
	if ((LATEX_COMPILERS as readonly string[]).includes(value)) return value as LatexCompiler;
	throw new Error(`compiler must be one of: ${LATEX_COMPILERS.join(", ")}`);
}

async function compileLatexFile(request: LatexFileCompileRequest): Promise<LatexFileCompileResult> {
	const { requestedPath, signal, clean = false } = request;
	const compiler = resolveLatexCompiler(request.compiler);
	const latexFilePath = resolveLatexFilePath(requestedPath, request.cwd);
	assertReadableLatexFile(latexFilePath);

	const cleanedArtifacts = clean ? cleanLatexFileArtifacts(latexFilePath) : [];
	const outputPdfPath = latexOutputPdfPath(latexFilePath);
	const logPath = latexLogPath(latexFilePath);
	const spec = latexCommandForFile(latexFilePath, compiler);
	const beforePdfStatus = outputPdfStat(outputPdfPath);
	const beforeLogStatus = outputPdfStat(logPath);
	const compileStartMs = Date.now();
	logger.info("compile.begin", {
		source_path: latexFilePath,
		pdf_path: outputPdfPath,
		log_path: logPath,
		compiler: spec.displayName,
		command: spec.command,
		cwd: dirname(latexFilePath),
		clean,
		cleaned_artifact_count: cleanedArtifacts.length,
	});

	let result: LatexCommandResult;
	try {
		result = await runLatexCommand(spec, dirname(latexFilePath), signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const reason = spec.command === "latexmk"
			? `failed to start compiler: ${message}. ${LATEXMK_MISSING_MESSAGE}`
			: `failed to start compiler: ${message}`;
		throw latexCompileFailure(latexFilePath, spec, reason, "", "compiler_start_failed", []);
	}

	const projectLog = readTextTail(logPath);
	const combinedLog = [projectLog, result.output].filter((entry) => entry.trim()).join("\n");
	const fatalDiagnostics = extractLatexFatalDiagnostics(combinedLog);
	const warningExtraction = extractLatexWarnings(combinedLog);
	const afterPdfStatus = outputPdfStat(outputPdfPath);
	const afterLogStatus = outputPdfStat(logPath);
	const pdfExists = afterPdfStatus !== undefined;
	const pdfUpdated = pdfWasUpdated(beforePdfStatus, afterPdfStatus, compileStartMs);
	const logUpdated = fileWasUpdated(beforeLogStatus, afterLogStatus, compileStartMs);
	const outputWritten = latexLogSaysOutputWritten(result.output, outputPdfPath)
		|| (logUpdated && latexLogSaysOutputWritten(projectLog, outputPdfPath));
	const targetUpToDate = latexmkOutputSaysTargetUpToDate(result.output, latexFilePath, outputPdfPath);

	if (result.aborted) {
		throw latexCompileFailure(latexFilePath, spec, "compilation aborted", result.output, "compile_aborted", fatalDiagnostics, pdfExists ? outputPdfPath : undefined);
	}
	if (result.timedOut) {
		throw latexCompileFailure(latexFilePath, spec, `compiler timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, result.output, "compile_timeout", fatalDiagnostics, pdfExists ? outputPdfPath : undefined);
	}
	if (!pdfExists) {
		throw latexCompileFailure(latexFilePath, spec, "PDF was not created", result.output, "failed_no_pdf", fatalDiagnostics);
	}
	const acceptsUnchangedLatexmkPdf = spec.acceptUnchangedPdfWhenOutputWritten === true
		&& (outputWritten || targetUpToDate)
		&& result.exitCode === 0
		&& fatalDiagnostics.length === 0;
	if (!pdfUpdated && !acceptsUnchangedLatexmkPdf) {
		throw latexCompileFailure(latexFilePath, spec, `PDF exists but was not updated at ${outputPdfPath}`, result.output, "failed_stale_pdf_exists", fatalDiagnostics, outputPdfPath);
	}
	if (result.exitCode !== 0 && fatalDiagnostics.length > 0) {
		throw latexCompileFailure(
			latexFilePath,
			spec,
			`compiler exited nonzero with fatal diagnostics: ${result.exitCode ?? result.signal ?? "unknown"}`,
			result.output,
			"compile_failed",
			fatalDiagnostics,
			outputPdfPath,
		);
	}
	if (result.exitCode !== 0 && !outputWritten) {
		throw latexCompileFailure(
			latexFilePath,
			spec,
			`compiler exited nonzero without confirmed PDF output: ${result.exitCode ?? result.signal ?? "unknown"}`,
			result.output,
			"compile_failed",
			fatalDiagnostics,
			outputPdfPath,
		);
	}

	const compileStatus: LatexCompileStatus = result.exitCode !== 0
		? "nonzero_but_pdf_updated"
		: warningExtraction.total > 0
			? "ok_with_warnings"
			: "ok";

	logger.info("compile.end", {
		source_path: latexFilePath,
		pdf_path: outputPdfPath,
		log_path: logPath,
		duration_ms: Date.now() - compileStartMs,
		compile_status: compileStatus,
		compiler_exit_code: result.exitCode,
		compiler_signal: result.signal,
		warning_count: warningExtraction.total,
		pdf_exists: pdfExists,
		pdf_updated: pdfUpdated,
		output_written: outputWritten,
		target_up_to_date: targetUpToDate,
		log_updated: logUpdated,
	});

	return {
		source: latexFilePath,
		pdfPath: outputPdfPath,
		logPath,
		clean,
		cleanedArtifacts,
		compileStatus,
		compilerExitCode: result.exitCode,
		compilerSignal: result.signal,
		warningCount: warningExtraction.total,
		warnings: warningExtraction.warnings,
		warningsTruncated: warningExtraction.truncated,
	};
}

function buildToolResult(result: LatexFileCompileResult): LatexFileToolDetails {
	return {
		source: result.source,
		pdf: result.pdfPath,
		log: result.logPath,
		clean: result.clean,
		cleaned_artifacts: result.cleanedArtifacts,
		compile_status: result.compileStatus,
		compiler_exit_code: result.compilerExitCode,
		compiler_signal: result.compilerSignal,
		warning_count: result.warningCount,
		warnings: result.warnings,
		warnings_truncated: result.warningsTruncated,
	};
}

export function createLatexFileCompileToolSupport(): LatexFileCompileToolSupport {
	return {
		resolveLatexCompiler,
		resolveLatexFilePath,
		compileLatexFile,
		buildToolResult: buildToolResult,
	};
}

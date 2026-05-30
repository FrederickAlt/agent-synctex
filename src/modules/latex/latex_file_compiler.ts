import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_LATEX_COMPILER = "lualatex" as const;
export const LATEX_COMPILERS = [DEFAULT_LATEX_COMPILER, "pdflatex", "xelatex", "latexmk"] as const;

export type LatexCompiler = (typeof LATEX_COMPILERS)[number];

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
	clean: boolean;
	cleanedArtifacts: string[];
}

export interface LatexFileToolDetails {
	source: string;
	pdf: string;
	clean: boolean;
	cleaned_artifacts: string[];
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

export class LoggedToolError extends Error {
	readonly logPath: string;
	readonly tail: string;

	constructor(message: string, logPath: string, tail = "") {
		super(message);
		this.name = "LoggedToolError";
		this.logPath = logPath;
		this.tail = tail;
	}
}

export interface LatexFileCompileToolSupport {
	resolveLatexCompiler(compiler: unknown): LatexCompiler | undefined;
	resolveLatexFilePath(latexFilePath: string, cwd?: string): string;
	compileLatexFile(request: LatexFileCompileRequest): Promise<LatexFileCompileResult>;
	buildToolResult(result: LatexFileCompileResult): LatexFileToolDetails;
}

const MCP_TMPDIR = process.env.MCP_TMPDIR ?? "/tmp/codex-show-latex";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 12_000;
const MAX_TAIL_BYTES = 30_000;
const LATEX_ERROR_TAIL_LINES = 20;
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

function shortFailureMessage(shortMessage: string, logPath: string, tail: string): string {
	const tailLines = lastLines(tail, LATEX_ERROR_TAIL_LINES);
	return tailLines
		? `${shortMessage}. Log: ${logPath}\nLast ${LATEX_ERROR_TAIL_LINES} lines:\n${tailLines}`
		: `${shortMessage}. Log: ${logPath}`;
}

function writeLatexCompileErrorLog(
	latexFilePath: string,
	spec: LatexCommandSpec,
	reason: string,
	compilerOutput: string,
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

function writeLatexCompileError(errorPath: string, spec: LatexCommandSpec, reason: string, compilerOutput: string): string {
	return writeLatexCompileErrorLog(errorPath, spec, reason, compilerOutput);
}

function latexCompileFailure(latexFilePath: string, spec: LatexCommandSpec, reason: string, compilerOutput: string): Error {
	try {
		const tempLogPath = writeLatexCompileError(latexFilePath, spec, reason, compilerOutput);
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
	const spec = latexCommandForFile(latexFilePath, compiler);

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
		throw latexCompileFailure(latexFilePath, spec, `compiler timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, result.output);
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

	return {
		source: latexFilePath,
		pdfPath: outputPdfPath,
		clean,
		cleanedArtifacts,
	};
}

function buildToolResult(result: LatexFileCompileResult): LatexFileToolDetails {
	return {
		source: result.source,
		pdf: result.pdfPath,
		clean: result.clean,
		cleaned_artifacts: result.cleanedArtifacts,
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

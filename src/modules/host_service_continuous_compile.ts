import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { dirname, basename, extname, resolve } from "node:path";
import type { LatexCompiler, LatexDiagnosticSummary } from "./latex/latex_file_compiler.ts";
import { extractLatexFatalDiagnostics } from "./latex/latex_file_compiler.ts";
import type { HostServicePendingNotification } from "./host_service_session_leases.ts";

export type ContinuousCompileStatus =
	| "started"
	| "already_active"
	| "deactivated"
	| "still_active_for_other_subscribers"
	| "stopped"
	| "unavailable"
	| "error";

export interface HostServiceContinuousCompileDetails {
	requested: boolean;
	status: ContinuousCompileStatus;
	root_source: string;
	session_id: string;
	subscriber_count: number;
	pid?: number;
	error?: string;
	error_code?: string;
}

export interface ContinuousCompileProcess {
	pid?: number;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	stdout?: NodeJS.ReadableStream | null;
	stderr?: NodeJS.ReadableStream | null;
}

export interface ContinuousCompileSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface ContinuousCompileNotificationSink {
	isSessionLive(sessionId: string): boolean;
	queuePendingNotification(sessionId: string, notification: HostServicePendingNotification): void;
	clearPendingNotificationsForRoot(rootSource: string): void;
	nowNs?: () => number;
}

export interface ContinuousCompileManagerOptions {
	spawnProcess?: (command: string, args: string[], options: ContinuousCompileSpawnOptions) => ContinuousCompileProcess;
	commandExists?: (command: string) => boolean;
	env?: NodeJS.ProcessEnv;
	notificationSink?: ContinuousCompileNotificationSink;
}

interface PdfSnapshot {
	exists: boolean;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

interface ContinuousCompileRecord {
	rootSource: string;
	process: ContinuousCompileProcess;
	subscribers: Set<string>;
	recentOutput: string;
	lastPdfSnapshot?: PdfSnapshot;
	lastFailureFingerprint?: string;
}

const MAX_RECENT_OUTPUT_LENGTH = 16_384;
const MAX_NOTIFICATION_OUTPUT_LENGTH = 4_000;
const MAX_NOTIFICATION_DIAGNOSTICS = 8;
const LATEX_ERROR_TAIL_LINES = 20;
const LATEXMK_MISSING_MESSAGE = "continuous compilation requires latexmk. Install MacTeX or TeX Live so the latexmk command is available on PATH; BasicTeX users may need to install latexmk separately (for example with tlmgr) and then restart the Host Service so it sees the updated PATH.";

function defaultCommandExists(command: string): boolean {
	const result = spawnSync(command, ["-version"], { stdio: "ignore" });
	return !result.error;
}

function defaultSpawnProcess(command: string, args: string[], options: ContinuousCompileSpawnOptions): ContinuousCompileProcess {
	return spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function latexmkEngineArgs(compiler: unknown): string[] {
	switch (compiler) {
		case "pdflatex":
			return ["-pdf", "-pdflatex=pdflatex -no-shell-escape %O %S"];
		case "xelatex":
			return ["-pdfxe", "-xelatex=xelatex -no-shell-escape %O %S"];
		case "latexmk":
		case undefined:
		case null:
		case "lualatex":
			return ["-pdf", "-lualatex", "-pdflualatex=lualatex -no-shell-escape %O %S"];
		default:
			return ["-pdf", "-lualatex", "-pdflualatex=lualatex -no-shell-escape %O %S"];
	}
}

function latexmkContinuousArgs(rootSource: string, compiler: LatexCompiler | unknown): string[] {
	return [
		"-pvc",
		"-view=none",
		"-recorder",
		"-synctex=1",
		"-interaction=nonstopmode",
		"-halt-on-error",
		"-file-line-error",
		...latexmkEngineArgs(compiler),
		basename(rootSource),
	];
}

function appendBounded(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length <= MAX_RECENT_OUTPUT_LENGTH ? next : next.slice(next.length - MAX_RECENT_OUTPUT_LENGTH);
}

function pdfPathForRoot(rootSource: string): string {
	const extension = extname(rootSource);
	return resolve(dirname(rootSource), `${basename(rootSource, extension)}.pdf`);
}

function logPathForRoot(rootSource: string): string {
	const extension = extname(rootSource);
	return resolve(dirname(rootSource), `${basename(rootSource, extension)}.log`);
}

function pdfSnapshot(pdfPath: string): PdfSnapshot | undefined {
	let stats: Stats;
	try {
		stats = statSync(pdfPath);
	} catch {
		return undefined;
	}
	if (!stats.isFile()) {
		return undefined;
	}
	return {
		exists: true,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
	};
}

function samePdfSnapshot(a: PdfSnapshot | undefined, b: PdfSnapshot | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.exists === b.exists && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function readTail(path: string, maxBytes = MAX_RECENT_OUTPUT_LENGTH): string {
	if (!existsSync(path)) return "";
	try {
		const text = readFileSync(path, "utf8");
		return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
	} catch {
		return "";
	}
}

function lastLines(text: string, count: number): string {
	return text.trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

function looksLikeCompileFailure(text: string): boolean {
	return /Latexmk:\s*(Errors|Failure|Bad return code)|(?:^|\n)!\s*(?:LaTeX|Package .+|Class .+)?\s*Error:/i.test(text)
		|| /(?:^|\n)!\s*Undefined control sequence\.?/i.test(text)
		|| /(?:^|\n)(?:Emergency stop\.?|Fatal error occurred|No pages of output\.?|Runaway argument\?|TeX capacity exceeded)/i.test(text)
		|| /failed to make|failure in processing file|collected error summary/i.test(text);
}

function summarizeFailure(diagnostics: LatexDiagnosticSummary[], combinedOutput: string): string {
	if (diagnostics.length > 0) {
		return diagnostics.slice(0, 3).map((diagnostic) => diagnostic.message).join("\n");
	}
	const tail = lastLines(combinedOutput, 6).trim();
	return tail || "Background LaTeX compilation failed without producing a fresh PDF.";
}

function notificationOutputTail(combinedOutput: string): string {
	const tail = lastLines(combinedOutput, LATEX_ERROR_TAIL_LINES);
	return tail.length <= MAX_NOTIFICATION_OUTPUT_LENGTH ? tail : tail.slice(tail.length - MAX_NOTIFICATION_OUTPUT_LENGTH);
}

function failureFingerprint(rootSource: string, pdfPath: string, logPath: string, summary: string, diagnostics: LatexDiagnosticSummary[]): string {
	return JSON.stringify({ rootSource, pdfPath, logPath, summary, diagnostics });
}

export class HostServiceContinuousCompileManager {
	private readonly spawnProcess: (command: string, args: string[], options: ContinuousCompileSpawnOptions) => ContinuousCompileProcess;
	private readonly commandExists: (command: string) => boolean;
	private readonly env: NodeJS.ProcessEnv;
	private readonly recordsByRootSource = new Map<string, ContinuousCompileRecord>();
	private notificationSink: ContinuousCompileNotificationSink | undefined;

	constructor(options: ContinuousCompileManagerOptions = {}) {
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.commandExists = options.commandExists ?? defaultCommandExists;
		this.env = options.env ?? process.env;
		this.notificationSink = options.notificationSink;
	}

	setNotificationSink(notificationSink: ContinuousCompileNotificationSink): void {
		this.notificationSink = notificationSink;
	}

	ensureSubscription(rootSource: string, sessionId: string, compiler?: LatexCompiler | unknown): HostServiceContinuousCompileDetails {
		const existing = this.recordsByRootSource.get(rootSource);
		if (existing) {
			existing.subscribers.add(sessionId);
			return this.details("already_active", existing, sessionId);
		}

		if (!this.commandExists("latexmk")) {
			return {
				requested: true,
				status: "unavailable",
				root_source: rootSource,
				session_id: sessionId,
				subscriber_count: 0,
				error: LATEXMK_MISSING_MESSAGE,
				error_code: "continuous_compiler_unavailable",
			};
		}

		try {
			const child = this.spawnProcess("latexmk", latexmkContinuousArgs(rootSource, compiler), {
				cwd: dirname(rootSource),
				env: this.env,
			});
			const record: ContinuousCompileRecord = {
				rootSource,
				process: child,
				subscribers: new Set([sessionId]),
				recentOutput: "",
				lastPdfSnapshot: pdfSnapshot(pdfPathForRoot(rootSource)),
			};
			this.recordsByRootSource.set(rootSource, record);
			child.stdout?.on("data", (chunk) => {
				this.recordOutputChunk(rootSource, record, Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
			});
			child.stderr?.on("data", (chunk) => {
				this.recordOutputChunk(rootSource, record, Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
			});
			child.on("exit", () => {
				if (this.recordsByRootSource.get(rootSource) === record) {
					this.recordsByRootSource.delete(rootSource);
				}
			});
			child.on("error", () => {
				if (this.recordsByRootSource.get(rootSource) === record) {
					this.recordsByRootSource.delete(rootSource);
				}
			});
			return this.details("started", record, sessionId);
		} catch (error) {
			return {
				requested: true,
				status: "error",
				root_source: rootSource,
				session_id: sessionId,
				subscriber_count: 0,
				error: error instanceof Error ? error.message : String(error),
				error_code: "continuous_compiler_start_failed",
			};
		}
	}

	removeSubscription(rootSource: string, sessionId: string): HostServiceContinuousCompileDetails {
		const record = this.recordsByRootSource.get(rootSource);
		if (!record) {
			return {
				requested: true,
				status: "deactivated",
				root_source: rootSource,
				session_id: sessionId,
				subscriber_count: 0,
			};
		}
		record.subscribers.delete(sessionId);
		if (record.subscribers.size > 0) {
			return this.details("still_active_for_other_subscribers", record, sessionId);
		}
		this.stopRecord(rootSource, record);
		return {
			requested: true,
			status: "stopped",
			root_source: rootSource,
			session_id: sessionId,
			subscriber_count: 0,
			pid: record.process.pid,
		};
	}

	removeSessions(sessionIds: Iterable<string>): void {
		const expired = new Set([...sessionIds].map((sessionId) => sessionId.trim()).filter(Boolean));
		if (!expired.size) {
			return;
		}
		for (const [rootSource, record] of this.recordsByRootSource) {
			for (const sessionId of expired) {
				record.subscribers.delete(sessionId);
			}
			if (record.subscribers.size === 0) {
				this.stopRecord(rootSource, record);
			}
		}
	}

	stopAll(): void {
		for (const [rootSource, record] of this.recordsByRootSource) {
			this.stopRecord(rootSource, record);
		}
	}

	activeRootCount(): number {
		return this.recordsByRootSource.size;
	}

	subscriberCount(rootSource: string): number {
		return this.recordsByRootSource.get(rootSource)?.subscribers.size ?? 0;
	}

	private recordOutputChunk(rootSource: string, record: ContinuousCompileRecord, chunk: string): void {
		if (this.recordsByRootSource.get(rootSource) !== record) {
			return;
		}
		record.recentOutput = appendBounded(record.recentOutput, chunk);
		this.observeBackgroundCompileOutput(record);
	}

	private observeBackgroundCompileOutput(record: ContinuousCompileRecord): void {
		const sink = this.notificationSink;
		if (!sink) {
			return;
		}
		const pdfPath = pdfPathForRoot(record.rootSource);
		const latestPdfSnapshot = pdfSnapshot(pdfPath);
		if (latestPdfSnapshot !== undefined && !samePdfSnapshot(record.lastPdfSnapshot, latestPdfSnapshot)) {
			record.lastPdfSnapshot = latestPdfSnapshot;
			record.lastFailureFingerprint = undefined;
			record.recentOutput = "";
			sink.clearPendingNotificationsForRoot(record.rootSource);
			return;
		}

		if (!looksLikeCompileFailure(record.recentOutput)) {
			return;
		}
		const logPath = logPathForRoot(record.rootSource);
		const logTail = readTail(logPath);
		const combinedOutput = [logTail, record.recentOutput].filter((entry) => entry.trim()).join("\n");
		const diagnosticSource = logTail.trim() ? logTail : combinedOutput;
		const diagnostics = extractLatexFatalDiagnostics(diagnosticSource).slice(0, MAX_NOTIFICATION_DIAGNOSTICS);
		const errorSummary = summarizeFailure(diagnostics, diagnosticSource);
		const fingerprint = failureFingerprint(record.rootSource, pdfPath, logPath, errorSummary, diagnostics);
		if (record.lastFailureFingerprint === fingerprint) {
			return;
		}
		record.lastFailureFingerprint = fingerprint;
		const notification = this.buildFailureNotification(record.rootSource, pdfPath, logPath, errorSummary, diagnostics, combinedOutput);
		for (const sessionId of record.subscribers) {
			if (sink.isSessionLive(sessionId)) {
				sink.queuePendingNotification(sessionId, notification);
			}
		}
	}

	private buildFailureNotification(
		rootSource: string,
		pdfPath: string,
		logPath: string,
		errorSummary: string,
		diagnostics: LatexDiagnosticSummary[],
		combinedOutput: string,
	): HostServicePendingNotification {
		const outputTail = notificationOutputTail(combinedOutput);
		const diagnosticsText = diagnostics.length > 0
			? `\nDiagnostics:\n${diagnostics.map((diagnostic) => `- ${diagnostic.message}`).join("\n")}`
			: "";
		const outputText = outputTail ? `\nLast ${LATEX_ERROR_TAIL_LINES} log/output lines:\n${outputTail}` : "";
		return {
			id: `continuous-compile-failure:${rootSource}`,
			created_at_ns: this.notificationSink?.nowNs?.() ?? Date.now() * 1_000_000,
			root_source: rootSource,
			message: [
				"[system info] Background continuous LaTeX compilation failed without producing a fresh PDF.",
				`Source: ${rootSource}`,
				`PDF: ${pdfPath}`,
				`Log: ${logPath}`,
				`Error summary: ${errorSummary}${diagnosticsText}${outputText}`,
			].join("\n"),
			details: {
				kind: "continuous_compile_failure",
				source_path: rootSource,
				pdf_path: pdfPath,
				log_path: logPath,
				error_summary: errorSummary,
				diagnostics,
				output_tail: outputTail,
			},
		};
	}

	private details(status: ContinuousCompileStatus, record: ContinuousCompileRecord, sessionId: string): HostServiceContinuousCompileDetails {
		return {
			requested: true,
			status,
			root_source: record.rootSource,
			session_id: sessionId,
			subscriber_count: record.subscribers.size,
			pid: record.process.pid,
		};
	}

	private stopRecord(rootSource: string, record: ContinuousCompileRecord): void {
		this.recordsByRootSource.delete(rootSource);
		record.subscribers.clear();
		record.process.kill("SIGTERM");
	}
}

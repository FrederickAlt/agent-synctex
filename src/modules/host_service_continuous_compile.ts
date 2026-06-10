import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { dirname, basename, extname, resolve } from "node:path";
import type { LatexCompiler, LatexDiagnosticSummary, LatexFileCompileResult } from "./latex/latex_file_compiler.ts";
import { extractLatexFatalDiagnostics, extractLatexWarnings, LATEXMK_CONTINUOUS_EVENT_PREFIX, latexmkContinuousArgs, latexmkEngineIdentity, LoggedToolError } from "./latex/latex_file_compiler.ts";
import type { HostServicePendingNotification } from "./host_service_session_leases.ts";
import { buildLatexmkFreshnessSnapshot, HostServiceCompileCoordinationError, isLatexmkFreshnessSnapshotFresh, type HostServiceCompileFreshnessSnapshot } from "./host_service_root_compile_coordinator.ts";

export type ContinuousCompileStatus =
	| "started"
	| "already_active"
	| "deactivated"
	| "still_active_for_other_subscribers"
	| "stopped"
	| "unavailable"
	| "error";

export type ContinuousCompileCycleState = "idle" | "compiling" | "stopping" | "stopped";

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
	clearPendingNotificationsForSessionRoot?(sessionId: string, rootSource: string): void;
	nowNs?: () => number;
}

export interface ContinuousCompileManagerOptions {
	spawnProcess?: (command: string, args: string[], options: ContinuousCompileSpawnOptions) => ContinuousCompileProcess;
	commandExists?: (command: string) => boolean;
	env?: NodeJS.ProcessEnv;
	notificationSink?: ContinuousCompileNotificationSink;
	shutdownGraceMs?: number;
	shutdownForceMs?: number;
}

interface PdfSnapshot {
	exists: boolean;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

interface ContinuousCompileOutcome {
	outcome: { status: "success"; value: LatexFileCompileResult } | { status: "failure"; error: unknown };
	freshness: HostServiceCompileFreshnessSnapshot | undefined;
}

interface ContinuousCompileWaiter {
	compilerIdentity: string;
	resolve: (result: LatexFileCompileResult) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface ContinuousCompileRecord {
	rootSource: string;
	process: ContinuousCompileProcess;
	subscribers: Set<string>;
	compiler: LatexCompiler | undefined;
	engineIdentity: string;
	compilerLabel: string;
	recentOutput: string;
	cycleOutput: string;
	lifecycleBuffer: string;
	cycleState: ContinuousCompileCycleState;
	cycleStartedAtMs: number;
	lastOutcome?: ContinuousCompileOutcome;
	waiters: Set<ContinuousCompileWaiter>;
	lastPdfSnapshot?: PdfSnapshot;
	lastFailureFingerprint?: string;
	restartSubscribersOnExitAfterAbortedCleanStop?: boolean;
	stopping?: boolean;
	stopPromise?: Promise<void>;
}

const MAX_RECENT_OUTPUT_LENGTH = 16_384;
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
const DEFAULT_SHUTDOWN_FORCE_MS = 500;
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

function compilerLabel(compiler: LatexCompiler | undefined): string {
	return compiler === undefined || compiler === "latexmk" ? "lualatex" : compiler;
}

export class HostServiceContinuousCompileManager {
	private readonly spawnProcess: (command: string, args: string[], options: ContinuousCompileSpawnOptions) => ContinuousCompileProcess;
	private readonly commandExists: (command: string) => boolean;
	private readonly env: NodeJS.ProcessEnv;
	private readonly shutdownGraceMs: number;
	private readonly shutdownForceMs: number;
	private readonly recordsByRootSource = new Map<string, ContinuousCompileRecord>();
	private notificationSink: ContinuousCompileNotificationSink | undefined;
	private acceptingSubscriptions = true;

	constructor(options: ContinuousCompileManagerOptions = {}) {
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.commandExists = options.commandExists ?? defaultCommandExists;
		this.env = options.env ?? process.env;
		this.notificationSink = options.notificationSink;
		this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
		this.shutdownForceMs = options.shutdownForceMs ?? DEFAULT_SHUTDOWN_FORCE_MS;
	}

	setNotificationSink(notificationSink: ContinuousCompileNotificationSink): void {
		this.notificationSink = notificationSink;
	}

	setAcceptingSubscriptions(acceptingSubscriptions: boolean): void {
		this.acceptingSubscriptions = acceptingSubscriptions;
	}

	ensureSubscription(rootSource: string, sessionId: string, compiler?: LatexCompiler | unknown): HostServiceContinuousCompileDetails {
		if (!this.acceptingSubscriptions) {
			return {
				requested: true,
				status: "error",
				root_source: rootSource,
				session_id: sessionId,
				subscriber_count: 0,
				error: "continuous compilation is shutting down",
				error_code: "host_service_stopping",
			};
		}
		const requestedCompiler = compiler as LatexCompiler | undefined;
		const requestedEngineIdentity = latexmkEngineIdentity(requestedCompiler);
		const existing = this.recordsByRootSource.get(rootSource);
		if (existing) {
			if (existing.stopping) {
				return {
					requested: true,
					status: "error",
					root_source: rootSource,
					session_id: sessionId,
					subscriber_count: existing.subscribers.size,
					pid: existing.process.pid,
					error: "continuous compilation is stopping",
					error_code: "continuous_compiler_stopping",
				};
			}
			if (existing.engineIdentity !== requestedEngineIdentity) {
				return {
					requested: true,
					status: "error",
					root_source: rootSource,
					session_id: sessionId,
					subscriber_count: existing.subscribers.size,
					pid: existing.process.pid,
					error: "continuous compilation is already active for this root with a different latexmk engine configuration; stop the existing subscription before switching compiler",
					error_code: "continuous_compiler_engine_mismatch",
				};
			}
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
			const child = this.spawnProcess("latexmk", latexmkContinuousArgs(rootSource, requestedCompiler), {
				cwd: dirname(rootSource),
				env: this.env,
			});
			const record: ContinuousCompileRecord = {
				rootSource,
				process: child,
				subscribers: new Set([sessionId]),
				compiler: requestedCompiler,
				engineIdentity: requestedEngineIdentity,
				compilerLabel: compilerLabel(requestedCompiler),
				recentOutput: "",
				cycleOutput: "",
				lifecycleBuffer: "",
				cycleState: "idle",
				cycleStartedAtMs: Date.now(),
				waiters: new Set(),
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
				this.handleProcessStopped(rootSource, record, new HostServiceCompileCoordinationError(
					"continuous compiler stopped before producing a fresh result",
					"continuous_compiler_stopped",
				));
			});
			child.on("error", () => {
				this.handleProcessStopped(rootSource, record, new HostServiceCompileCoordinationError(
					"continuous compiler failed before producing a fresh result",
					"continuous_compiler_failed",
				));
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

	async removeSubscription(rootSource: string, sessionId: string): Promise<HostServiceContinuousCompileDetails> {
		this.clearPendingNotificationsForSessionRoot(sessionId, rootSource);
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
		await this.stopRecordAndWait(rootSource, record);
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
			if (record.stopping) {
				continue;
			}
			for (const sessionId of expired) {
				record.subscribers.delete(sessionId);
			}
			if (record.subscribers.size === 0) {
				void this.stopRecordAndWait(rootSource, record);
			}
		}
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.recordsByRootSource].map(([rootSource, record]) => this.stopRecordAndWait(rootSource, record)));
	}

	activeRootCount(): number {
		return this.recordsByRootSource.size;
	}

	subscriberCount(rootSource: string): number {
		return this.recordsByRootSource.get(rootSource)?.subscribers.size ?? 0;
	}

	cycleState(rootSource: string): ContinuousCompileCycleState | undefined {
		return this.recordsByRootSource.get(rootSource)?.cycleState;
	}

	async cleanRestartAndWaitForFreshResult(
		rootSource: string,
		compilerIdentity: string,
		cleanArtifacts: () => string[],
		signal?: AbortSignal,
	): Promise<{ result: LatexFileCompileResult; cleanedArtifacts: string[]; continuous: HostServiceContinuousCompileDetails } | undefined> {
		const record = this.recordsByRootSource.get(rootSource);
		if (record === undefined) {
			return undefined;
		}
		if (record.engineIdentity !== compilerIdentity) {
			throw new HostServiceCompileCoordinationError(
				`continuous compilation is already active for this root with compiler ${record.compilerLabel}; use the active compiler or stop continuous compilation first before requesting a different compiler`,
				"continuous_compiler_engine_mismatch",
			);
		}
		const subscribers = Array.from(record.subscribers);
		const compiler = record.compiler;
		const sessionId = subscribers[0];
		if (sessionId === undefined) {
			throw new HostServiceCompileCoordinationError(
				"cannot restart continuous compilation after clean because the active compiler has no subscribers",
				"continuous_compiler_restart_failed",
			);
		}

		this.throwIfSignalAborted(signal, "compile request cancelled before stopping active continuous compilation for clean");
		await this.stopRecordAndWaitForCleanRestart(rootSource, record, subscribers, signal);
		if (signal?.aborted) {
			this.restartSubscribersAfterCleanStop(rootSource, subscribers, compiler);
			this.throwIfSignalAborted(signal, "compile request cancelled after stopping active continuous compilation before clean");
		}
		this.throwIfSignalAborted(signal, "compile request cancelled before deleting clean artifacts");
		const cleanedArtifacts = cleanArtifacts();
		if (signal?.aborted) {
			this.restartSubscribersAfterCleanStop(rootSource, subscribers, compiler);
			this.throwIfSignalAborted(signal, "compile request cancelled after deleting clean artifacts before restarting continuous compilation");
		}
		this.throwIfSignalAborted(signal, "compile request cancelled before restarting continuous compilation after clean");
		const continuous = this.restartSubscribersAfterCleanStop(rootSource, subscribers, compiler);
		const result = await this.waitForFreshResult(rootSource, compilerIdentity, signal);
		if (result === undefined) {
			throw new HostServiceCompileCoordinationError(
				"continuous compiler was not active after clean restart",
				"continuous_compiler_restart_failed",
			);
		}
		return { result, cleanedArtifacts, continuous };
	}

	waitForFreshResult(rootSource: string, compilerIdentity: string, signal?: AbortSignal): Promise<LatexFileCompileResult | undefined> {
		const record = this.recordsByRootSource.get(rootSource);
		if (record === undefined) {
			return Promise.resolve(undefined);
		}
		if (record.engineIdentity !== compilerIdentity) {
			return Promise.reject(new HostServiceCompileCoordinationError(
				`continuous compilation is already active for this root with compiler ${record.compilerLabel}; use the active compiler or stop continuous compilation first before requesting a different compiler`,
				"continuous_compiler_engine_mismatch",
			));
		}
		const freshOutcome = this.freshOutcome(record);
		if (freshOutcome !== undefined) {
			return freshOutcome.status === "success" ? Promise.resolve(freshOutcome.value) : Promise.reject(freshOutcome.error);
		}
		if (record.stopping) {
			return Promise.reject(new HostServiceCompileCoordinationError(
				"continuous compilation is stopping before producing a fresh result",
				"continuous_compiler_stopping",
			));
		}
		if (signal?.aborted) {
			return Promise.reject(new HostServiceCompileCoordinationError(
				"compile request cancelled while waiting for active continuous compilation",
				"compile_cancelled",
			));
		}
		return new Promise<LatexFileCompileResult>((resolve, reject) => {
			const waiter: ContinuousCompileWaiter = { compilerIdentity, resolve, reject, signal };
			if (signal !== undefined) {
				waiter.onAbort = () => {
					record.waiters.delete(waiter);
					reject(new HostServiceCompileCoordinationError(
						"compile request cancelled while waiting for active continuous compilation",
						"compile_cancelled",
					));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			record.waiters.add(waiter);
		});
	}

	clearPendingNotificationsForSessionRoot(sessionId: string, rootSource: string): void {
		this.notificationSink?.clearPendingNotificationsForSessionRoot?.(sessionId, rootSource);
	}

	private recordOutputChunk(rootSource: string, record: ContinuousCompileRecord, chunk: string): void {
		if (this.recordsByRootSource.get(rootSource) !== record) {
			return;
		}
		record.recentOutput = appendBounded(record.recentOutput, chunk);
		this.observeLifecycleEvents(record, chunk);
		this.observeBackgroundCompileOutput(record);
	}

	private observeLifecycleEvents(record: ContinuousCompileRecord, chunk: string): void {
		record.lifecycleBuffer += chunk;
		const lines = record.lifecycleBuffer.split(/\r?\n/u);
		record.lifecycleBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const event = line.trim().startsWith(LATEXMK_CONTINUOUS_EVENT_PREFIX)
				? line.trim().slice(LATEXMK_CONTINUOUS_EVENT_PREFIX.length)
				: undefined;
			if (event === "compiling" || event === "success" || event === "warning" || event === "failure") {
				this.applyLifecycleEvent(record, event);
			} else if (record.cycleState === "compiling") {
				record.cycleOutput = appendBounded(record.cycleOutput, `${line}\n`);
			}
		}
		if (record.lifecycleBuffer.length > MAX_RECENT_OUTPUT_LENGTH) {
			record.lifecycleBuffer = record.lifecycleBuffer.slice(record.lifecycleBuffer.length - MAX_RECENT_OUTPUT_LENGTH);
		}
	}

	private applyLifecycleEvent(record: ContinuousCompileRecord, event: "compiling" | "success" | "warning" | "failure"): void {
		if (event === "compiling") {
			record.cycleState = "compiling";
			record.cycleOutput = "";
			record.cycleStartedAtMs = Date.now();
			return;
		}
		record.cycleState = "idle";
		record.lastOutcome = this.buildCycleOutcome(record, event);
		this.resolveObservedCycleWaiters(record, record.lastOutcome);
	}

	private buildCycleOutcome(record: ContinuousCompileRecord, event: "success" | "warning" | "failure"): ContinuousCompileOutcome {
		const rootSource = record.rootSource;
		const pdfPath = pdfPathForRoot(rootSource);
		const logPath = logPathForRoot(rootSource);
		const logTail = readTail(logPath);
		const combinedOutput = [logTail, record.cycleOutput].filter((entry) => entry.trim()).join("\n");
		const compiledAfterMs = record.cycleStartedAtMs;
		if (event !== "failure" && existsSync(pdfPath)) {
			const warningExtraction = extractLatexWarnings(combinedOutput);
			const result: LatexFileCompileResult = {
				source: rootSource,
				pdfPath,
				logPath,
				clean: false,
				cleanedArtifacts: [],
				compileStatus: event === "warning" || warningExtraction.total > 0 ? "ok_with_warnings" : "ok",
				compilerExitCode: 0,
				compilerSignal: null,
				warningCount: warningExtraction.total,
				warnings: warningExtraction.warnings,
				warningsTruncated: warningExtraction.truncated,
			};
			return {
				outcome: { status: "success", value: result },
				freshness: buildLatexmkFreshnessSnapshot({ rootSource, pdfPath, logPath, compiledAfterMs, requirePdf: true }),
			};
		}

		const diagnostics = extractLatexFatalDiagnostics(combinedOutput);
		const summary = summarizeFailure(diagnostics, combinedOutput);
		const errorCode = event === "failure" ? "compile_failed" : "failed_no_pdf";
		const error = new LoggedToolError(
			`LaTeX continuous compile failed: ${summary}`,
			logPath,
			notificationOutputTail(combinedOutput),
			{
				errorCode,
				diagnostics,
				diagnosticSummary: summary,
				pdfPath: existsSync(pdfPath) ? pdfPath : undefined,
			},
		);
		return {
			outcome: { status: "failure", error },
			freshness: buildLatexmkFreshnessSnapshot({ rootSource, logPath, compiledAfterMs, requirePdf: false }),
		};
	}

	private freshOutcome(record: ContinuousCompileRecord): ContinuousCompileOutcome["outcome"] | undefined {
		const outcome = record.lastOutcome;
		if (outcome === undefined || outcome.freshness === undefined || !isLatexmkFreshnessSnapshotFresh(outcome.freshness)) {
			return undefined;
		}
		return outcome.outcome;
	}

	private resolveObservedCycleWaiters(record: ContinuousCompileRecord, cycleOutcome: ContinuousCompileOutcome): void {
		const reusableOutcome = this.freshOutcome(record);
		for (const waiter of [...record.waiters]) {
			if (waiter.compilerIdentity !== record.engineIdentity) {
				continue;
			}
			const outcome = cycleOutcome.outcome.status === "failure" ? cycleOutcome.outcome : reusableOutcome;
			if (outcome === undefined) {
				continue;
			}
			record.waiters.delete(waiter);
			this.detachWaiter(waiter);
			if (outcome.status === "success") {
				waiter.resolve(outcome.value);
			} else {
				waiter.reject(outcome.error);
			}
		}
	}

	private rejectWaiters(record: ContinuousCompileRecord, error: unknown): void {
		for (const waiter of [...record.waiters]) {
			record.waiters.delete(waiter);
			this.detachWaiter(waiter);
			waiter.reject(error);
		}
	}

	private detachWaiter(waiter: ContinuousCompileWaiter): void {
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.onAbort = undefined;
		}
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

	private handleProcessStopped(rootSource: string, record: ContinuousCompileRecord, error: HostServiceCompileCoordinationError): void {
		this.rejectWaiters(record, error);
		record.cycleState = "stopped";
		const shouldRecoverSubscribers = record.restartSubscribersOnExitAfterAbortedCleanStop === true && record.subscribers.size > 0;
		const subscribers = shouldRecoverSubscribers ? Array.from(record.subscribers) : [];
		const compiler = record.compiler;
		if (this.recordsByRootSource.get(rootSource) === record) {
			this.recordsByRootSource.delete(rootSource);
		}
		if (shouldRecoverSubscribers) {
			try {
				this.restartSubscribersAfterCleanStop(rootSource, subscribers, compiler);
			} catch {
				// Recovery is best-effort after the request already aborted; keep artifacts untouched and leave state stopped on restart failure.
			}
		}
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

	private throwIfSignalAborted(signal: AbortSignal | undefined, message: string): void {
		if (signal?.aborted) {
			throw new HostServiceCompileCoordinationError(message, "compile_cancelled");
		}
	}

	private restartSubscribersAfterCleanStop(rootSource: string, subscribers: string[], compiler: LatexCompiler | undefined): HostServiceContinuousCompileDetails {
		const sessionId = subscribers[0];
		if (sessionId === undefined) {
			throw new HostServiceCompileCoordinationError(
				"cannot restart continuous compilation after clean because the active compiler has no subscribers",
				"continuous_compiler_restart_failed",
			);
		}
		const start = this.ensureSubscription(rootSource, sessionId, compiler);
		if (start.status === "error" || start.status === "unavailable") {
			throw new HostServiceCompileCoordinationError(
				`failed to restart continuous compilation after clean: ${start.error ?? start.status}`,
				"continuous_compiler_restart_failed",
			);
		}
		for (const subscriber of subscribers.slice(1)) {
			const added = this.ensureSubscription(rootSource, subscriber, compiler);
			if (added.status === "error" || added.status === "unavailable") {
				throw new HostServiceCompileCoordinationError(
					`failed to restore continuous subscriber after clean: ${added.error ?? added.status}`,
					"continuous_compiler_restart_failed",
				);
			}
		}
		const restartedRecord = this.recordsByRootSource.get(rootSource);
		return restartedRecord === undefined ? start : this.details("started", restartedRecord, sessionId);
	}

	private async stopRecordAndWaitForCleanRestart(
		rootSource: string,
		record: ContinuousCompileRecord,
		subscribers: string[],
		signal: AbortSignal | undefined,
	): Promise<void> {
		const previousCycleState = record.cycleState;
		record.restartSubscribersOnExitAfterAbortedCleanStop = false;
		record.stopping = true;
		record.cycleState = "stopping";
		this.rejectWaiters(record, new HostServiceCompileCoordinationError(
			"continuous compilation is stopping before producing a fresh result",
			"continuous_compiler_stopping",
		));
		const exited = this.waitForProcessExit(record.process);
		record.process.kill("SIGTERM");
		const graceResult = await this.waitForBoundedExitOrAbort(exited, this.shutdownGraceMs, signal);
		if (graceResult === "aborted") {
			this.restoreRecordAfterAbortedCleanStop(rootSource, record, subscribers, previousCycleState);
			this.throwIfSignalAborted(signal, "compile request cancelled while stopping active continuous compilation before clean");
			return;
		}
		if (graceResult === "timeout") {
			record.process.kill("SIGKILL");
			const forceResult = await this.waitForBoundedExitOrAbort(exited, this.shutdownForceMs, signal);
			if (forceResult === "aborted") {
				this.restoreRecordAfterAbortedCleanStop(rootSource, record, subscribers, previousCycleState);
				this.throwIfSignalAborted(signal, "compile request cancelled while force-stopping active continuous compilation before clean");
				return;
			}
		}
		if (this.recordsByRootSource.get(rootSource) === record) {
			this.recordsByRootSource.delete(rootSource);
		}
	}

	private restoreRecordAfterAbortedCleanStop(
		rootSource: string,
		record: ContinuousCompileRecord,
		subscribers: string[],
		previousCycleState: ContinuousCompileCycleState,
	): void {
		if (this.recordsByRootSource.get(rootSource) !== record) {
			return;
		}
		record.subscribers = new Set(subscribers);
		record.restartSubscribersOnExitAfterAbortedCleanStop = true;
		record.stopping = false;
		record.stopPromise = undefined;
		record.cycleState = previousCycleState === "stopping" || previousCycleState === "stopped" ? "idle" : previousCycleState;
	}

	private stopRecordAndWait(rootSource: string, record: ContinuousCompileRecord): Promise<void> {
		if (record.stopPromise) {
			return record.stopPromise;
		}
		record.restartSubscribersOnExitAfterAbortedCleanStop = false;
		record.stopping = true;
		record.cycleState = "stopping";
		record.subscribers.clear();
		this.rejectWaiters(record, new HostServiceCompileCoordinationError(
			"continuous compilation is stopping before producing a fresh result",
			"continuous_compiler_stopping",
		));
		record.stopPromise = (async () => {
			const exited = this.waitForProcessExit(record.process);
			record.process.kill("SIGTERM");
			if (!(await this.waitForBoundedExit(exited, this.shutdownGraceMs))) {
				record.process.kill("SIGKILL");
				await this.waitForBoundedExit(exited, this.shutdownForceMs);
			}
			if (this.recordsByRootSource.get(rootSource) === record) {
				this.recordsByRootSource.delete(rootSource);
			}
		})();
		return record.stopPromise;
	}

	private waitForProcessExit(process: ContinuousCompileProcess): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const settle = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			process.on("exit", settle);
			process.on("error", settle);
		});
	}

	private async waitForBoundedExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
		return (await this.waitForBoundedExitOrAbort(exited, timeoutMs, undefined)) === "exited";
	}

	private async waitForBoundedExitOrAbort(exited: Promise<void>, timeoutMs: number, signal: AbortSignal | undefined): Promise<"exited" | "timeout" | "aborted"> {
		if (signal?.aborted) {
			return "aborted";
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				exited.then(() => "exited" as const),
				new Promise<"timeout" | "aborted">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), timeoutMs);
					if (signal !== undefined) {
						onAbort = () => resolve("aborted");
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			if (signal !== undefined && onAbort !== undefined) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}
}

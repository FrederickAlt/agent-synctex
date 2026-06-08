import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, basename } from "node:path";
import type { LatexCompiler } from "./latex/latex_file_compiler.ts";

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

export interface ContinuousCompileManagerOptions {
	spawnProcess?: (command: string, args: string[], options: ContinuousCompileSpawnOptions) => ContinuousCompileProcess;
	commandExists?: (command: string) => boolean;
	env?: NodeJS.ProcessEnv;
}

interface ContinuousCompileRecord {
	rootSource: string;
	process: ContinuousCompileProcess;
	subscribers: Set<string>;
	recentOutput: string;
}

const MAX_RECENT_OUTPUT_LENGTH = 16_384;
const LATEXMK_MISSING_MESSAGE = "continuous compilation requires latexmk; install MacTeX or TeX Live so the latexmk command is available on PATH";

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

export class HostServiceContinuousCompileManager {
	private readonly spawnProcess: (command: string, args: string[], options: ContinuousCompileSpawnOptions) => ContinuousCompileProcess;
	private readonly commandExists: (command: string) => boolean;
	private readonly env: NodeJS.ProcessEnv;
	private readonly recordsByRootSource = new Map<string, ContinuousCompileRecord>();

	constructor(options: ContinuousCompileManagerOptions = {}) {
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.commandExists = options.commandExists ?? defaultCommandExists;
		this.env = options.env ?? process.env;
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
			};
			this.recordsByRootSource.set(rootSource, record);
			child.stdout?.on("data", (chunk) => {
				record.recentOutput = appendBounded(record.recentOutput, Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
			});
			child.stderr?.on("data", (chunk) => {
				record.recentOutput = appendBounded(record.recentOutput, Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
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

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, normalize, resolve } from "node:path";

export class HostServiceCompileCoordinationError extends Error {
	readonly errorCode: string;

	constructor(message: string, errorCode: string) {
		super(message);
		this.name = "HostServiceCompileCoordinationError";
		this.errorCode = errorCode;
	}
}

export type HostServiceCachedCompileOutcome<T> =
	| { status: "success"; value: T }
	| { status: "failure"; error: unknown };

export interface HostServiceRootCompileCacheRecord<T> {
	rootSource: string;
	compilerIdentity: string;
	outcome: HostServiceCachedCompileOutcome<T>;
	freshness: HostServiceCompileFreshnessSnapshot | undefined;
}

export interface HostServiceCompileFreshnessSnapshot {
	dependencyFiles: HostServiceFileSnapshot[];
	outputFiles: HostServiceFileSnapshot[];
}

interface HostServiceFileSnapshot {
	path: string;
	size: number;
	mtimeMs: number;
	digest: string;
}

interface RootCompileQueueItem {
	operation: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	started: boolean;
}

interface RootCompileQueue {
	items: RootCompileQueueItem[];
	running: boolean;
}

export class HostServiceRootCompileCoordinator {
	private readonly queues = new Map<string, RootCompileQueue>();
	private readonly lastCompileResults = new Map<string, HostServiceRootCompileCacheRecord<unknown>>();
	private stoppedError: HostServiceCompileCoordinationError | undefined;

	runExclusive<T>(rootKey: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.stoppedError !== undefined) {
			return Promise.reject(this.stoppedError);
		}
		if (signal?.aborted) {
			return Promise.reject(new HostServiceCompileCoordinationError(
				"compile request cancelled before entering root compile queue",
				"compile_cancelled",
			));
		}

		return new Promise<T>((resolve, reject) => {
			const queue = this.queueFor(rootKey);
			const item: RootCompileQueueItem = {
				operation,
				resolve: (value) => resolve(value as T),
				reject,
				signal,
				started: false,
			};

			if (signal !== undefined) {
				item.onAbort = () => {
					if (item.started) {
						return;
					}
					this.removeQueuedItem(rootKey, queue, item);
					item.reject(new HostServiceCompileCoordinationError(
						"compile request cancelled while waiting behind an active same-root compile",
						"compile_cancelled",
					));
				};
				signal.addEventListener("abort", item.onAbort, { once: true });
			}

			queue.items.push(item);
			this.pump(rootKey, queue);
		});
	}

	freshCachedResult<T>(rootKey: string, _rootSource: string, compilerIdentity: string): HostServiceCachedCompileOutcome<T> | undefined {
		const cached = this.lastCompileResults.get(rootKey);
		if (cached === undefined) {
			return undefined;
		}
		if (cached.compilerIdentity !== compilerIdentity) {
			return undefined;
		}
		if (cached.freshness === undefined || !isLatexmkFreshnessSnapshotFresh(cached.freshness)) {
			return undefined;
		}
		return cached.outcome as HostServiceCachedCompileOutcome<T>;
	}

	recordLastResult<T>(rootKey: string, record: HostServiceRootCompileCacheRecord<T>): void {
		this.lastCompileResults.set(rootKey, record as HostServiceRootCompileCacheRecord<unknown>);
	}

	clearLastResult(rootKey: string): void {
		this.lastCompileResults.delete(rootKey);
	}

	resume(): void {
		this.stoppedError = undefined;
	}

	stop(error = new HostServiceCompileCoordinationError(
		"host service stopped while compile request was waiting behind an active same-root compile",
		"host_service_stopped",
	)): void {
		this.stoppedError = error;
		this.lastCompileResults.clear();
		for (const [rootKey, queue] of this.queues) {
			const pending = queue.items.filter((item) => !item.started);
			queue.items = queue.items.filter((item) => item.started);
			for (const item of pending) {
				this.detachAbort(item);
				item.reject(error);
			}
			if (queue.items.length === 0) {
				this.queues.delete(rootKey);
			}
		}
	}

	activeRootCount(): number {
		return this.queues.size;
	}

	private queueFor(rootKey: string): RootCompileQueue {
		const existing = this.queues.get(rootKey);
		if (existing !== undefined) {
			return existing;
		}
		const created: RootCompileQueue = { items: [], running: false };
		this.queues.set(rootKey, created);
		return created;
	}

	private pump(rootKey: string, queue: RootCompileQueue): void {
		if (queue.running) {
			return;
		}
		const item = queue.items[0];
		if (item === undefined) {
			this.queues.delete(rootKey);
			return;
		}
		if (this.stoppedError !== undefined) {
			queue.items.shift();
			this.detachAbort(item);
			item.reject(this.stoppedError);
			this.pump(rootKey, queue);
			return;
		}

		queue.running = true;
		item.started = true;
		this.detachAbort(item);
		void item.operation()
			.then((value) => item.resolve(value))
			.catch((error) => item.reject(error))
			.finally(() => {
				queue.items.shift();
				queue.running = false;
				this.pump(rootKey, queue);
			});
	}

	private removeQueuedItem(rootKey: string, queue: RootCompileQueue, item: RootCompileQueueItem): void {
		const index = queue.items.indexOf(item);
		if (index >= 0) {
			queue.items.splice(index, 1);
		}
		this.detachAbort(item);
		if (!queue.running && queue.items.length === 0) {
			this.queues.delete(rootKey);
		}
	}

	private detachAbort(item: RootCompileQueueItem): void {
		if (item.signal !== undefined && item.onAbort !== undefined) {
			item.signal.removeEventListener("abort", item.onAbort);
			item.onAbort = undefined;
		}
	}
}

export function buildLatexmkFreshnessSnapshot(options: {
	rootSource: string;
	pdfPath?: string;
	logPath: string;
	compiledAfterMs: number;
	requirePdf: boolean;
}): HostServiceCompileFreshnessSnapshot | undefined {
	const flsPath = latexmkArtifactPath(options.rootSource, ".fls");
	const recorder = readLatexmkRecorderRecords(flsPath, dirname(options.rootSource));
	if (recorder === undefined) {
		return undefined;
	}
	const outputPathSet = new Set(recorder.outputs.map((path) => normalize(path)));
	const dependencyPaths = recorder.inputs.filter((path) => !outputPathSet.has(normalize(path)));
	if (dependencyPaths.length === 0) {
		return undefined;
	}
	const normalizedRootSource = normalize(options.rootSource);
	if (!dependencyPaths.some((path) => normalize(path) === normalizedRootSource)) {
		return undefined;
	}

	const dependencyFiles = snapshotFiles(dependencyPaths);
	if (dependencyFiles === undefined) {
		return undefined;
	}
	if (dependencyFiles.some((snapshot) => snapshot.mtimeMs > options.compiledAfterMs)) {
		return undefined;
	}

	const outputPaths = [
		...(options.requirePdf && options.pdfPath !== undefined ? [options.pdfPath] : []),
		options.logPath,
		flsPath,
		...recorder.outputs,
		...existingLatexmkDatabaseArtifacts(options.rootSource),
	];
	const outputFiles = snapshotFiles(outputPaths);
	if (outputFiles === undefined) {
		return undefined;
	}
	return { dependencyFiles, outputFiles };
}

export function isLatexmkFreshnessSnapshotFresh(snapshot: HostServiceCompileFreshnessSnapshot): boolean {
	return filesMatch(snapshot.dependencyFiles) && filesMatch(snapshot.outputFiles);
}

function filesMatch(snapshots: HostServiceFileSnapshot[]): boolean {
	for (const snapshot of snapshots) {
		const current = snapshotFile(snapshot.path);
		if (current === undefined) {
			return false;
		}
		if (current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.digest !== snapshot.digest) {
			return false;
		}
	}
	return true;
}

function snapshotFiles(paths: string[]): HostServiceFileSnapshot[] | undefined {
	const uniquePaths = Array.from(new Set(paths.map((path) => normalize(path))));
	const snapshots: HostServiceFileSnapshot[] = [];
	for (const path of uniquePaths) {
		const snapshot = snapshotFile(path);
		if (snapshot === undefined) {
			return undefined;
		}
		snapshots.push(snapshot);
	}
	return snapshots;
}

function snapshotFile(path: string): HostServiceFileSnapshot | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile()) {
			return undefined;
		}
		return {
			path,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
		};
	} catch {
		return undefined;
	}
}

function readLatexmkRecorderRecords(flsPath: string, fallbackDirectory: string): { inputs: string[]; outputs: string[] } | undefined {
	if (!existsSync(flsPath)) {
		return undefined;
	}
	let text: string;
	try {
		text = readFileSync(flsPath, "utf8");
	} catch {
		return undefined;
	}
	let currentDirectory = fallbackDirectory;
	const inputs: string[] = [];
	const outputs: string[] = [];
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (line.startsWith("PWD ")) {
			const nextDirectory = line.slice(4).trim();
			if (nextDirectory) {
				currentDirectory = resolveRecordedPath(nextDirectory, currentDirectory);
			}
			continue;
		}
		if (line.startsWith("INPUT ")) {
			const inputPath = line.slice(6).trim();
			if (!inputPath) {
				return undefined;
			}
			inputs.push(resolveRecordedPath(inputPath, currentDirectory));
			continue;
		}
		if (line.startsWith("OUTPUT ")) {
			const outputPath = line.slice(7).trim();
			if (!outputPath) {
				return undefined;
			}
			outputs.push(resolveRecordedPath(outputPath, currentDirectory));
		}
	}
	return {
		inputs: Array.from(new Set(inputs)),
		outputs: Array.from(new Set(outputs)),
	};
}

function resolveRecordedPath(path: string, currentDirectory: string): string {
	const unquoted = path.replace(/^"(.*)"$/u, "$1");
	return normalize(isAbsolute(unquoted) ? unquoted : resolve(currentDirectory, unquoted));
}

function latexmkArtifactPath(rootSource: string, extension: string): string {
	return resolve(dirname(rootSource), `${basename(rootSource, extname(rootSource))}${extension}`);
}

function existingLatexmkDatabaseArtifacts(rootSource: string): string[] {
	const path = latexmkArtifactPath(rootSource, ".fdb_latexmk");
	return existsSync(path) ? [path] : [];
}

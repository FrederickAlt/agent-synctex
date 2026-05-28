import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface TrackedPdf {
	id: number;
	path: string;
	sourceFile?: string;
	pid?: number;
	synctexEditorCommand?: string;
	openedAtMs: number;
	lastOpenedAtMs: number;
}

interface PdfOpenProcessResult {
	exitCode: number | null;
	signal: string | null;
	output: string;
	timedOut: boolean;
	aborted: boolean;
}

interface ZathuraOpenOptions {
	command?: string;
	timeoutMs?: number;
	synctexEditorCommand?: string;
	isAlreadyOpen?: (pdfFilePath: string) => boolean;
	reuseExisting?: boolean;
	requirePersistentViewer?: boolean;
}

interface ZathuraJumpOptions extends ZathuraOpenOptions {
	opener?: PdfOpener;
	synctexPid?: number;
}

interface ZathuraCloseOptions {
	findPids?: (pdfFilePath: string) => number[];
	killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface PdfJumpResult {
	pdf: string;
	sourceFile: string;
	line: number;
	reopened: boolean;
}

export interface PdfCloseResult {
	pdf: string;
	pdfId: number;
	closedPids: number[];
	wasTracked: boolean;
}

const PDF_HEADER = "%PDF-";
const ZATHURA_OPEN_TIMEOUT_MS = 5_000;
const ZATHURA_PID_DETECTION_TIMEOUT_MS = 750;
const ZATHURA_PID_POLL_MS = 50;
const ZATHURA_DBUS_READY_TIMEOUT_MS = 750;
const ZATHURA_DBUS_FALLBACK_DELAY_MS = 200;
const PDF_OPEN_LOCK_ROOT = "/tmp/codex-show-latex/pdf-open-locks";
const PDF_OPEN_LOCK_STALE_MS = 15_000;
const PROC_ROOT = "/proc";

function readProcessArgs(pid: string, procRoot = PROC_ROOT): string[] | undefined {
	try {
		const raw = readFileSync(join(procRoot, pid, "cmdline"));
		if (raw.length === 0) return undefined;
		return raw.toString("utf8").split("\0").filter(Boolean);
	} catch {
		return undefined;
	}
}

function argMatchesPdfPath(arg: string, normalizedPdfPath: string): boolean {
	if (arg === normalizedPdfPath) return true;
	if (!arg.includes("/") && !arg.endsWith(".pdf")) return false;
	try {
		return realpathSync(resolve(arg)) === normalizedPdfPath;
	} catch {
		return false;
	}
}

export function processArgsMatchZathuraPdf(args: string[], normalizedPdfPath: string): boolean {
	if (args.length === 0) return false;
	if (!basename(args[0]).includes("zathura")) return false;
	return args.slice(1).some((arg) => argMatchesPdfPath(arg, normalizedPdfPath));
}

export function zathuraPidsForPdf(pdfFilePath: string, procRoot = PROC_ROOT): number[] {
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return [];
	}

	const normalizedPdfPath = normalizePdfFilePath(pdfFilePath);
	const pids: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const args = readProcessArgs(entry, procRoot);
		if (args && processArgsMatchZathuraPdf(args, normalizedPdfPath)) {
			pids.push(Number(entry));
		}
	}
	return pids;
}

function processArgsMatchSynctexEditorCommand(args: string[], synctexEditorCommand: string): boolean {
	return args.some((arg, index) => {
		if (arg === `--synctex-editor-command=${synctexEditorCommand}`) return true;
		if ((arg === "--synctex-editor-command" || arg === "-x") && args[index + 1] === synctexEditorCommand) return true;
		return false;
	});
}

function zathuraPidsForPdfWithSynctexCommand(pdfFilePath: string, synctexEditorCommand: string, procRoot = PROC_ROOT): number[] {
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return [];
	}

	const normalizedPdfPath = normalizePdfFilePath(pdfFilePath);
	const pids: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const args = readProcessArgs(entry, procRoot);
		if (args && processArgsMatchZathuraPdf(args, normalizedPdfPath) && processArgsMatchSynctexEditorCommand(args, synctexEditorCommand)) {
			pids.push(Number(entry));
		}
	}
	return pids;
}

function describeZathuraProcessesForPdf(pdfFilePath: string, synctexEditorCommand?: string, procRoot = PROC_ROOT): string {
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Could not inspect ${procRoot}: ${message}`;
	}

	const normalizedPdfPath = normalizePdfFilePath(pdfFilePath);
	const processLines: string[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const args = readProcessArgs(entry, procRoot);
		if (!args || !processArgsMatchZathuraPdf(args, normalizedPdfPath)) continue;
		const callbackMatch = synctexEditorCommand ? processArgsMatchSynctexEditorCommand(args, synctexEditorCommand) : undefined;
		const callbackText = callbackMatch === undefined ? "" : ` callback_match=${callbackMatch}`;
		processLines.push(`pid=${entry}${callbackText} args=${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
	}

	return processLines.length
		? `Zathura processes for ${normalizedPdfPath}:\n${processLines.join("\n")}`
		: `No Zathura process in ${procRoot} matched PDF ${normalizedPdfPath}`;
}

export function describePdfJumpFailureContext(pdfId: number, tracker: PdfTracker, currentSynctexEditorCommand?: string): string {
	const trackedPdf = tracker.getById(pdfId);
	if (!trackedPdf) return `No tracked PDF found for pdf_id=${pdfId}`;

	const trackedPidArgs = trackedPdf.pid === undefined ? undefined : readProcessArgs(String(trackedPdf.pid));
	const effectiveSynctexCommand = currentSynctexEditorCommand ?? trackedPdf.synctexEditorCommand;
	const lines = [
		`tracked_pdf_id=${trackedPdf.id}`,
		`tracked_pdf_path=${trackedPdf.path}`,
		`tracked_source_file=${trackedPdf.sourceFile ?? "<unknown>"}`,
		`tracked_pid=${trackedPdf.pid ?? "<unknown>"}`,
		`tracked_pid_args=${trackedPidArgs ? trackedPidArgs.map((arg) => JSON.stringify(arg)).join(" ") : "<unavailable>"}`,
		`tracked_synctex_callback_command=${trackedPdf.synctexEditorCommand ?? "<none>"}`,
		`current_synctex_callback_command=${currentSynctexEditorCommand ?? "<none>"}`,
		`callback_command_changed=${trackedPdf.synctexEditorCommand !== undefined && currentSynctexEditorCommand !== undefined && trackedPdf.synctexEditorCommand !== currentSynctexEditorCommand}`,
		`effective_callback_process_snapshot=${describeZathuraProcessesForPdf(trackedPdf.path, effectiveSynctexCommand)}`,
	];

	if (trackedPdf.synctexEditorCommand && currentSynctexEditorCommand && trackedPdf.synctexEditorCommand !== currentSynctexEditorCommand) {
		lines.push(`tracked_callback_process_snapshot=${describeZathuraProcessesForPdf(trackedPdf.path, trackedPdf.synctexEditorCommand)}`);
	}

	return lines.join("\n");
}

export function zathuraAlreadyOpen(pdfFilePath: string): boolean {
	return zathuraPidsForPdf(pdfFilePath).length > 0;
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function tailText(text: string, limit = 12000): string {
	return text.length <= limit ? text : `...\n${text.slice(-limit)}`;
}

export function resolvePdfFilePath(pdfFilePath: string): string {
	return resolve(expandHomePath(pdfFilePath.trim()));
}

export function assertReadablePdfFile(pdfFilePath: string): void {
	let fileStatus;
	try {
		fileStatus = statSync(pdfFilePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot stat PDF file ${pdfFilePath}: ${message}`);
	}

	if (!fileStatus.isFile()) {
		throw new Error(`pdf_file_path must point to a regular file: ${pdfFilePath}`);
	}

	try {
		accessSync(pdfFilePath, constants.R_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read PDF file ${pdfFilePath}: ${message}`);
	}

	const header = Buffer.alloc(PDF_HEADER.length);
	let fd: number | null = null;
	try {
		fd = openSync(pdfFilePath, "r");
		const bytesRead = readSync(fd, header, 0, header.length, 0);
		if (bytesRead < header.length || header.toString("ascii") !== PDF_HEADER) {
			throw new Error(`pdf_file_path must point to a PDF file: ${pdfFilePath}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("pdf_file_path must point")) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read PDF header ${pdfFilePath}: ${message}`);
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

export function normalizePdfFilePath(pdfFilePath: string): string {
	const resolvedPath = resolvePdfFilePath(pdfFilePath);
	assertReadablePdfFile(resolvedPath);
	try {
		return realpathSync(resolvedPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot resolve PDF file ${resolvedPath}: ${message}`);
	}
}

export function resolveSourceFilePath(sourceFile: string): string {
	return resolve(expandHomePath(sourceFile.trim()));
}

export function assertReadableSourceFile(sourceFile: string): void {
	let fileStatus;
	try {
		fileStatus = statSync(sourceFile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot stat source_file ${sourceFile}: ${message}`);
	}

	if (!fileStatus.isFile()) {
		throw new Error(`source_file must point to a regular file: ${sourceFile}`);
	}

	try {
		accessSync(sourceFile, constants.R_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read source_file ${sourceFile}: ${message}`);
	}
}

function readableSourceFileOrUndefined(sourceFile: string): string | undefined {
	try {
		const resolvedSourceFile = resolveSourceFilePath(sourceFile);
		assertReadableSourceFile(resolvedSourceFile);
		return resolvedSourceFile;
	} catch {
		return undefined;
	}
}

function synctexSidecarPaths(pdfFilePath: string): string[] {
	const parsedPdfPath = pdfFilePath.toLowerCase().endsWith(".pdf")
		? pdfFilePath.slice(0, -4)
		: pdfFilePath;
	return [`${parsedPdfPath}.synctex.gz`, `${parsedPdfPath}.synctex`];
}

function readSynctexSidecar(path: string): string | undefined {
	if (!existsSync(path)) return undefined;

	try {
		const contents = readFileSync(path);
		return path.endsWith(".gz") ? gunzipSync(contents).toString("utf8") : contents.toString("utf8");
	} catch {
		return undefined;
	}
}

function parseSynctexInputRecords(synctexText: string, pdfDirectory: string): string[] {
	const sourceFiles: string[] = [];
	const seen = new Set<string>();
	for (const line of synctexText.split(/\r?\n/)) {
		const inputMatch = /^Input:\d+:(.+)$/.exec(line.trim());
		if (!inputMatch) continue;

		const inputPath = inputMatch[1].trim();
		if (!inputPath || extname(inputPath).toLowerCase() !== ".tex") continue;

		const candidate = readableSourceFileOrUndefined(isAbsolute(inputPath) ? inputPath : resolve(pdfDirectory, inputPath));
		if (!candidate || seen.has(candidate)) continue;

		seen.add(candidate);
		sourceFiles.push(candidate);
	}

	return sourceFiles;
}

function inferSourceFileFromSynctex(pdfFilePath: string): string | undefined {
	const pdfDirectory = dirname(pdfFilePath);
	const pdfBaseName = basename(pdfFilePath, extname(pdfFilePath));
	const inputRecords: string[] = [];
	const seen = new Set<string>();

	for (const sidecarPath of synctexSidecarPaths(pdfFilePath)) {
		const synctexText = readSynctexSidecar(sidecarPath);
		if (!synctexText) continue;

		for (const inputRecord of parseSynctexInputRecords(synctexText, pdfDirectory)) {
			if (seen.has(inputRecord)) continue;
			seen.add(inputRecord);
			inputRecords.push(inputRecord);
		}
	}

	const matchingBasenameRecords = inputRecords.filter((inputRecord) => basename(inputRecord, extname(inputRecord)) === pdfBaseName);
	if (matchingBasenameRecords.length === 1) return matchingBasenameRecords[0];
	if (inputRecords.length === 1) return inputRecords[0];
	return undefined;
}

export function inferDefaultSourceFileForPdf(pdfFilePath: string): string | undefined {
	const sameBasenameSource = readableSourceFileOrUndefined(join(dirname(pdfFilePath), `${basename(pdfFilePath, extname(pdfFilePath))}.tex`));
	if (sameBasenameSource) return sameBasenameSource;

	return inferSourceFileFromSynctex(pdfFilePath);
}

function runPdfOpenProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<PdfOpenProcessResult> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			resolvePromise({ exitCode: null, signal: null, output: "", timedOut: false, aborted: true });
			return;
		}

		let output = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const child = spawn(command, args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				HOME: process.env.HOME || homedir(),
				PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
			},
		});

		const appendOutput = (chunk: Buffer | string) => {
			output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			output = tailText(output);
		};

		child.stdout.on("data", appendOutput);
		child.stderr.on("data", appendOutput);
		child.unref();

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

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
			child.stdout.destroy();
			child.stderr.destroy();
			callback();
		};

		child.on("error", (error) => {
			finish(() => reject(error));
		});

		child.on("exit", (exitCode, closeSignal) => {
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

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function pdfOpenLockPath(pdfFilePath: string): string {
	const hash = createHash("sha256").update(normalizePdfFilePath(pdfFilePath)).digest("hex");
	return join(PDF_OPEN_LOCK_ROOT, `${hash}.lock`);
}

function removeStalePdfOpenLock(lockPath: string): void {
	try {
		const lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
		if (lockAgeMs > PDF_OPEN_LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
	} catch {
		// If the lock disappeared between attempts, the next mkdir will decide ownership.
	}
}

async function withPdfOpenLock<T>(pdfFilePath: string, timeoutMs: number, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
	mkdirSync(PDF_OPEN_LOCK_ROOT, { recursive: true });
	const lockPath = pdfOpenLockPath(pdfFilePath);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (signal?.aborted) throw new Error("PDF open aborted");
		try {
			mkdirSync(lockPath);
			break;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
				removeStalePdfOpenLock(lockPath);
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for PDF open lock for ${pdfFilePath}`);
				await delay(ZATHURA_PID_POLL_MS);
				continue;
			}
			throw error;
		}
	}

	try {
		return await action();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function zathuraDbusServiceReady(pid: number): boolean | undefined {
	const result = spawnSync("gdbus", [
		"introspect",
		"--session",
		"--dest",
		`org.pwmt.zathura.PID-${pid}`,
		"--object-path",
		"/org/pwmt/zathura",
	], { stdio: "ignore", timeout: 500 });
	if (result.error && "code" in result.error && result.error.code === "ENOENT") return undefined;
	return result.status === 0;
}

async function waitForZathuraDbusReady(pid: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, ZATHURA_DBUS_READY_TIMEOUT_MS));
	while (!signal?.aborted && Date.now() < deadline) {
		const ready = zathuraDbusServiceReady(pid);
		if (ready === true) return;
		if (ready === undefined) break;
		await delay(ZATHURA_PID_POLL_MS);
	}
	await delay(ZATHURA_DBUS_FALLBACK_DELAY_MS);
}

async function waitForNewZathuraPid(
	pdfFilePath: string,
	beforePids: Set<number>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<number | undefined> {
	const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, ZATHURA_PID_DETECTION_TIMEOUT_MS));
	const normalizedPdfPath = normalizePdfFilePath(pdfFilePath);
	while (true) {
		const newPids = zathuraPidsForPdf(pdfFilePath).filter((pid) => !beforePids.has(pid));
		if (newPids.length) {
			const pid = Math.max(...newPids);
			await waitForZathuraDbusReady(pid, timeoutMs, signal);
			const args = readProcessArgs(String(pid));
			if (args && processArgsMatchZathuraPdf(args, normalizedPdfPath)) return pid;
			beforePids.add(pid);
		}
		if (signal?.aborted || Date.now() >= deadline) return undefined;
		await delay(ZATHURA_PID_POLL_MS);
	}
}

export async function openPdfInZathura(
	pdfFilePath: string,
	signal?: AbortSignal,
	options: ZathuraOpenOptions = {},
): Promise<number | undefined> {
	const command = options.command ?? "zathura";
	const timeoutMs = options.timeoutMs ?? ZATHURA_OPEN_TIMEOUT_MS;
	const reusablePidsForPdf = (): Set<number> => new Set(
		options.synctexEditorCommand
			? zathuraPidsForPdfWithSynctexCommand(pdfFilePath, options.synctexEditorCommand)
			: zathuraPidsForPdf(pdfFilePath),
	);
	const defaultIsAlreadyOpen = (reusablePids: Set<number>) => (path: string): boolean => reusablePids.size > 0 || (!options.synctexEditorCommand && zathuraAlreadyOpen(path));
	const existingPids = new Set(zathuraPidsForPdf(pdfFilePath));
	const reusableExistingPids = reusablePidsForPdf();
	const isAlreadyOpen = options.isAlreadyOpen ?? defaultIsAlreadyOpen(reusableExistingPids);
	if (options.reuseExisting && isAlreadyOpen(pdfFilePath)) return reusableExistingPids.size ? Math.max(...reusableExistingPids) : undefined;

	const launch = async (beforePids: Set<number>): Promise<number | undefined> => {
		let result: PdfOpenProcessResult;
		const args = options.synctexEditorCommand
			? [`--synctex-editor-command=${options.synctexEditorCommand}`, "--fork", pdfFilePath]
			: ["--fork", pdfFilePath];

		try {
			result = await runPdfOpenProcess(command, args, timeoutMs, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to start zathura: ${message}`);
		}

		if (result.aborted) {
			throw new Error("PDF open aborted");
		}
		if (result.timedOut) {
			throw new Error(`zathura did not finish launching ${pdfFilePath} within ${timeoutMs / 1000}s`);
		}
		if (result.exitCode !== 0) {
			const status = result.exitCode ?? result.signal ?? "unknown";
			const output = result.output.trim();
			const details = output ? `\n${output}` : "";
			throw new Error(`zathura failed to open ${pdfFilePath}: exited ${status}${details}`);
		}

		const pid = await waitForNewZathuraPid(pdfFilePath, beforePids, timeoutMs, signal);
		if (options.requirePersistentViewer && pid === undefined) {
			throw new Error(`zathura exited before a persistent viewer was available for ${pdfFilePath}. The viewer may have crashed while opening this PDF.`);
		}
		return pid;
	};

	if (!options.reuseExisting) return launch(existingPids);

	return withPdfOpenLock(pdfFilePath, timeoutMs, signal, async () => {
		const lockedExistingPids = new Set(zathuraPidsForPdf(pdfFilePath));
		const lockedReusableExistingPids = reusablePidsForPdf();
		const lockedAlreadyOpen = options.isAlreadyOpen ?? defaultIsAlreadyOpen(lockedReusableExistingPids);
		if (lockedAlreadyOpen(pdfFilePath)) return lockedReusableExistingPids.size ? Math.max(...lockedReusableExistingPids) : undefined;
		return launch(lockedExistingPids);
	});
}

async function jumpPdfInZathura(
	pdfFilePath: string,
	sourceFile: string,
	line: number,
	signal?: AbortSignal,
	options: ZathuraJumpOptions = {},
): Promise<void> {
	const command = options.command ?? "zathura";
	const timeoutMs = options.timeoutMs ?? ZATHURA_OPEN_TIMEOUT_MS;
	const args = ["--synctex-forward", `${line}:1:${sourceFile}`];
	if (options.synctexPid !== undefined) args.push(`--synctex-pid=${options.synctexPid}`);
	args.push(pdfFilePath);
	let result: PdfOpenProcessResult;
	try {
		result = await runPdfOpenProcess(command, args, timeoutMs, signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to start zathura for SyncTeX jump: ${message}`);
	}

	if (result.aborted) {
		throw new Error("PDF jump aborted");
	}
	if (result.timedOut) {
		throw new Error(`zathura SyncTeX jump did not finish for ${pdfFilePath} within ${timeoutMs / 1000}s`);
	}
	if (result.exitCode !== 0) {
		const status = result.exitCode ?? result.signal ?? "unknown";
		const output = result.output.trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`zathura failed to jump ${pdfFilePath} to ${sourceFile}:${line}: exited ${status}${details}`);
	}
}

export type PdfOpener = (pdfFilePath: string, signal?: AbortSignal) => Promise<number | undefined | void>;

export class PdfTracker {
	private readonly trackedPdfsByPath = new Map<string, TrackedPdf[]>();
	private readonly trackedPdfsById = new Map<number, TrackedPdf>();
	private readonly pendingOpensByPath = new Map<string, Promise<TrackedPdf>>();
	private nextPdfId = 1;

	trackOpenedPdf(normalizedPdfPath: string, defaultSourceFile?: string, pid?: number, synctexEditorCommand?: string): TrackedPdf {
		const now = Date.now();
		const trackedPdf: TrackedPdf = {
			id: this.nextPdfId,
			path: normalizedPdfPath,
			sourceFile: defaultSourceFile,
			pid,
			synctexEditorCommand,
			openedAtMs: now,
			lastOpenedAtMs: now,
		};
		this.nextPdfId += 1;
		const pathEntries = this.trackedPdfsByPath.get(normalizedPdfPath) ?? [];
		pathEntries.push(trackedPdf);
		this.trackedPdfsByPath.set(normalizedPdfPath, pathEntries);
		this.trackedPdfsById.set(trackedPdf.id, trackedPdf);
		return trackedPdf;
	}

	markReopened(pdfId: number, pid?: number, defaultSourceFile?: string, synctexEditorCommand?: string): TrackedPdf | undefined {
		const trackedPdf = this.trackedPdfsById.get(pdfId);
		if (!trackedPdf) return undefined;
		if (defaultSourceFile) trackedPdf.sourceFile = defaultSourceFile;
		if (synctexEditorCommand) trackedPdf.synctexEditorCommand = synctexEditorCommand;
		trackedPdf.pid = pid;
		trackedPdf.lastOpenedAtMs = Date.now();
		return trackedPdf;
	}

	getById(pdfId: number): TrackedPdf | undefined {
		return this.trackedPdfsById.get(pdfId);
	}

	getByPath(normalizedPdfPath: string): TrackedPdf | undefined {
		const pathEntries = this.trackedPdfsByPath.get(normalizedPdfPath);
		return pathEntries?.at(-1);
	}

	getAllByPath(normalizedPdfPath: string): TrackedPdf[] {
		return [...(this.trackedPdfsByPath.get(normalizedPdfPath) ?? [])];
	}

	getPendingOpen(normalizedPdfPath: string): Promise<TrackedPdf> | undefined {
		return this.pendingOpensByPath.get(normalizedPdfPath);
	}

	setPendingOpen(normalizedPdfPath: string, promise: Promise<TrackedPdf>): void {
		this.pendingOpensByPath.set(normalizedPdfPath, promise);
	}

	clearPendingOpen(normalizedPdfPath: string, promise: Promise<TrackedPdf>): void {
		if (this.pendingOpensByPath.get(normalizedPdfPath) === promise) {
			this.pendingOpensByPath.delete(normalizedPdfPath);
		}
	}

	untrackById(pdfId: number): TrackedPdf | undefined {
		const trackedPdf = this.trackedPdfsById.get(pdfId);
		if (!trackedPdf) return undefined;
		this.trackedPdfsById.delete(pdfId);
		const pathEntries = this.trackedPdfsByPath.get(trackedPdf.path)?.filter((entry) => entry.id !== pdfId) ?? [];
		if (pathEntries.length) this.trackedPdfsByPath.set(trackedPdf.path, pathEntries);
		else this.trackedPdfsByPath.delete(trackedPdf.path);
		return trackedPdf;
	}

	clear(): void {
		this.trackedPdfsByPath.clear();
		this.trackedPdfsById.clear();
		this.pendingOpensByPath.clear();
		this.nextPdfId = 1;
	}
}

export function closePdfInZathura(
	pdfFilePath: string,
	options: ZathuraCloseOptions = {},
): number[] {
	const findPids = options.findPids ?? zathuraPidsForPdf;
	const killProcess = options.killProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
	const pids = findPids(pdfFilePath);
	const closedPids: number[] = [];
	const failures: string[] = [];

	for (const pid of pids) {
		try {
			killProcess(pid, "SIGTERM");
			closedPids.push(pid);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") continue;
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${pid}: ${message}`);
		}
	}

	if (failures.length) {
		throw new Error(`Failed to close zathura process(es) for ${pdfFilePath}: ${failures.join("; ")}`);
	}
	return closedPids;
}

export function closeTrackedPdf(
	pdfId: number,
	tracker: PdfTracker,
	options: ZathuraCloseOptions = {},
): PdfCloseResult {
	const trackedPdf = tracker.getById(pdfId);
	if (!trackedPdf) {
		throw new Error(`Unknown tracked pdf_id=${pdfId}. Open the PDF first with open_pdf or compile_latex_file(..., open_pdf=true).`);
	}

	const defaultFindPids = () => {
		if (trackedPdf.synctexEditorCommand) {
			const commandPids = zathuraPidsForPdfWithSynctexCommand(trackedPdf.path, trackedPdf.synctexEditorCommand);
			const preferredPids = trackedPdf.pid !== undefined && commandPids.includes(trackedPdf.pid) ? [trackedPdf.pid] : commandPids;
			if (!options.findPids) return preferredPids;
			const foundPids = options.findPids(trackedPdf.path);
			return foundPids.filter((pid) => preferredPids.includes(pid));
		}

		if (trackedPdf.pid !== undefined) {
			if (!options.findPids) return [trackedPdf.pid];
			const foundPids = options.findPids(trackedPdf.path);
			return foundPids.filter((pid) => pid === trackedPdf.pid);
		}

		return options.findPids ? options.findPids(trackedPdf.path) : [];
	};
	const findPids = defaultFindPids;
	const closedPids = closePdfInZathura(trackedPdf.path, {
		...options,
		findPids,
	});
	tracker.untrackById(pdfId);
	return { pdf: trackedPdf.path, pdfId, closedPids, wasTracked: true };
}

function reuseTrackedPdfForPath(normalizedPdfPath: string, tracker: PdfTracker, defaultSourceFile?: string, synctexEditorCommand?: string): TrackedPdf | undefined {
	const trackedPdf = tracker.getByPath(normalizedPdfPath);
	if (!trackedPdf) return undefined;

	const currentPids = synctexEditorCommand
		? zathuraPidsForPdfWithSynctexCommand(normalizedPdfPath, synctexEditorCommand)
		: zathuraPidsForPdf(normalizedPdfPath);
	let pid = trackedPdf.pid;
	if (pid !== undefined && !currentPids.includes(pid)) {
		if (currentPids.length === 0) return undefined;
		pid = Math.max(...currentPids);
	} else if (pid === undefined && currentPids.length > 0) {
		pid = Math.max(...currentPids);
	}

	return tracker.markReopened(trackedPdf.id, pid, defaultSourceFile, synctexEditorCommand) ?? trackedPdf;
}

export async function openAndTrackPdf(
	pdfFilePath: string,
	tracker: PdfTracker,
	signal?: AbortSignal,
	opener: PdfOpener = (path, abortSignal) => openPdfInZathura(path, abortSignal, { reuseExisting: true }),
	defaultSourceFile?: string,
	synctexEditorCommand?: string,
): Promise<TrackedPdf> {
	const pdfPath = normalizePdfFilePath(pdfFilePath);
	const sourceFile = defaultSourceFile ?? inferDefaultSourceFileForPdf(pdfPath);
	const reusableTrackedPdf = reuseTrackedPdfForPath(pdfPath, tracker, sourceFile, synctexEditorCommand);
	if (reusableTrackedPdf) return reusableTrackedPdf;

	const pendingOpen = tracker.getPendingOpen(pdfPath);
	if (pendingOpen) {
		const trackedPdf = await pendingOpen;
		if (sourceFile && trackedPdf.sourceFile !== sourceFile) {
			return tracker.markReopened(trackedPdf.id, trackedPdf.pid, sourceFile, synctexEditorCommand) ?? trackedPdf;
		}
		return trackedPdf;
	}

	const staleTrackedPdf = tracker.getByPath(pdfPath);
	const openPromise = (async () => {
		const pid = await opener(pdfPath, signal);
		const normalizedPid = typeof pid === "number" ? pid : undefined;
		if (staleTrackedPdf && tracker.getById(staleTrackedPdf.id)) {
			return tracker.markReopened(staleTrackedPdf.id, normalizedPid, sourceFile, synctexEditorCommand) ?? staleTrackedPdf;
		}
		return tracker.trackOpenedPdf(pdfPath, sourceFile, normalizedPid, synctexEditorCommand);
	})();
	tracker.setPendingOpen(pdfPath, openPromise);
	try {
		return await openPromise;
	} finally {
		tracker.clearPendingOpen(pdfPath, openPromise);
	}
}

export async function jumpToTrackedPdf(
	pdfId: number,
	line: number,
	sourceFile: string | undefined,
	tracker: PdfTracker,
	signal?: AbortSignal,
	options: ZathuraJumpOptions = {},
): Promise<PdfJumpResult> {
	const trackedPdf = tracker.getById(pdfId);
	if (!trackedPdf) {
		throw new Error(`Unknown tracked pdf_id=${pdfId}. Open the PDF first with open_pdf or compile_latex_file(..., open_pdf=true).`);
	}

	const resolvedSourceFile = sourceFile
		? resolveSourceFilePath(sourceFile)
		: trackedPdf.sourceFile;
	if (!resolvedSourceFile) {
		throw new Error(`No default source_file is known for tracked pdf_id=${pdfId}. Pass source_file explicitly.`);
	}
	assertReadableSourceFile(resolvedSourceFile);

	const trackedSynctexCommand = options.synctexEditorCommand ?? trackedPdf.synctexEditorCommand;
	const hasTrackedCommand = trackedSynctexCommand !== undefined;

	const resolveOwnedPid = (): number | undefined => {
		if (!hasTrackedCommand) {
			return trackedPdf.pid;
		}

		const currentPids = zathuraPidsForPdfWithSynctexCommand(trackedPdf.path, trackedSynctexCommand);
		if (trackedPdf.pid !== undefined && currentPids.includes(trackedPdf.pid)) return trackedPdf.pid;
		return currentPids.length > 0 ? Math.max(...currentPids) : undefined;
	};

	const opener = options.opener ?? ((pdfPath: string, abortSignal?: AbortSignal) => {
		const openerOptions: ZathuraOpenOptions = {
			command: options.command,
			timeoutMs: options.timeoutMs,
			synctexEditorCommand: trackedSynctexCommand,
			reuseExisting: true,
		};
		return openPdfInZathura(pdfPath, abortSignal, openerOptions);
	});

	const jumpWithPid = async (pid: number | undefined): Promise<void> => {
		const jumpOptions: ZathuraJumpOptions = { ...options };
		if (pid !== undefined) jumpOptions.synctexPid = pid;
		await jumpPdfInZathura(trackedPdf.path, resolvedSourceFile, line, signal, jumpOptions);
	};

	const currentPid = resolveOwnedPid();
	if (currentPid !== undefined) {
		tracker.markReopened(pdfId, currentPid, trackedPdf.sourceFile, trackedSynctexCommand);
		await jumpWithPid(currentPid);
		return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: false };
	}

	if (hasTrackedCommand) {
		let reopenedPid: number | undefined;
		try {
			const rawPid = await opener(trackedPdf.path, signal);
			reopenedPid = typeof rawPid === "number" ? rawPid : undefined;
		} catch (reopenError) {
			const message = reopenError instanceof Error ? reopenError.message : String(reopenError);
			throw new Error(`Tracked PDF pdf_id=${pdfId} appears closed or unavailable, and could not be reopened at ${trackedPdf.path} with callback command ${trackedSynctexCommand}: ${message}`);
		}

		tracker.markReopened(pdfId, reopenedPid, trackedPdf.sourceFile, trackedSynctexCommand);
		const ownedPid = resolveOwnedPid();
		if (ownedPid === undefined) {
			if (reopenedPid !== undefined) {
				throw new Error(`Tracked PDF pdf_id=${pdfId} at ${trackedPdf.path} reopened as pid=${reopenedPid}, but that process exited before the SyncTeX jump. Zathura may have crashed while opening this PDF.\n${describeZathuraProcessesForPdf(trackedPdf.path, trackedSynctexCommand)}`);
			}
			try {
				await jumpWithPid(undefined);
				return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: true };
			} catch (jumpError) {
				const message = jumpError instanceof Error ? jumpError.message : String(jumpError);
				throw new Error(`Tracked PDF pdf_id=${pdfId} at ${trackedPdf.path} reopened without an identifiable Zathura window matching callback command ${trackedSynctexCommand}, and an unpinned SyncTeX jump also failed: ${message}\n${describeZathuraProcessesForPdf(trackedPdf.path, trackedSynctexCommand)}`);
			}
		}

		await jumpWithPid(ownedPid);
		return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: true };
	}

	try {
		await jumpWithPid(undefined);
		return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: false };
	} catch (firstJumpError) {
		try {
			const pid = await opener(trackedPdf.path, signal);
			tracker.markReopened(pdfId, typeof pid === "number" ? pid : undefined, trackedPdf.sourceFile, trackedSynctexCommand);
			await jumpWithPid(undefined);
			return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: true };
		} catch (reopenError) {
			const firstMessage = firstJumpError instanceof Error ? firstJumpError.message : String(firstJumpError);
			const secondMessage = reopenError instanceof Error ? reopenError.message : String(reopenError);
			throw new Error(`Tracked PDF pdf_id=${pdfId} appears closed or unavailable, and could not be reopened at ${trackedPdf.path}: ${firstMessage.replace(/\n/g, " ")} ${secondMessage.replace(/\n/g, " ")}`);
		}
	}
}

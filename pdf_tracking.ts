import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface TrackedPdf {
	id: number;
	path: string;
	sourceFile?: string;
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
}

interface ZathuraJumpOptions extends ZathuraOpenOptions {
	opener?: PdfOpener;
}

export interface PdfJumpResult {
	pdf: string;
	sourceFile: string;
	line: number;
	reopened: boolean;
}

const PDF_HEADER = "%PDF-";
const ZATHURA_OPEN_TIMEOUT_MS = 5_000;

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

export async function openPdfInZathura(
	pdfFilePath: string,
	signal?: AbortSignal,
	options: ZathuraOpenOptions = {},
): Promise<void> {
	const command = options.command ?? "zathura";
	const timeoutMs = options.timeoutMs ?? ZATHURA_OPEN_TIMEOUT_MS;
	let result: PdfOpenProcessResult;
	try {
		result = await runPdfOpenProcess(command, ["--fork", pdfFilePath], timeoutMs, signal);
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
}

async function jumpPdfInZathura(
	pdfFilePath: string,
	sourceFile: string,
	line: number,
	signal?: AbortSignal,
	options: ZathuraOpenOptions = {},
): Promise<void> {
	const command = options.command ?? "zathura";
	const timeoutMs = options.timeoutMs ?? ZATHURA_OPEN_TIMEOUT_MS;
	let result: PdfOpenProcessResult;
	try {
		result = await runPdfOpenProcess(command, ["--synctex-forward", `${line}:1:${sourceFile}`, pdfFilePath], timeoutMs, signal);
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

type PdfOpener = (pdfFilePath: string, signal?: AbortSignal) => Promise<void>;

export class PdfTracker {
	private readonly trackedPdfsByPath = new Map<string, TrackedPdf>();
	private readonly trackedPdfsById = new Map<number, TrackedPdf>();
	private nextPdfId = 1;

	trackOpenedPdf(normalizedPdfPath: string, defaultSourceFile?: string): TrackedPdf {
		const existing = this.trackedPdfsByPath.get(normalizedPdfPath);
		if (existing) {
			if (defaultSourceFile) existing.sourceFile = defaultSourceFile;
			existing.lastOpenedAtMs = Date.now();
			return existing;
		}

		const now = Date.now();
		const trackedPdf = {
			id: this.nextPdfId,
			path: normalizedPdfPath,
			sourceFile: defaultSourceFile,
			openedAtMs: now,
			lastOpenedAtMs: now,
		};
		this.nextPdfId += 1;
		this.trackedPdfsByPath.set(normalizedPdfPath, trackedPdf);
		this.trackedPdfsById.set(trackedPdf.id, trackedPdf);
		return trackedPdf;
	}

	getById(pdfId: number): TrackedPdf | undefined {
		return this.trackedPdfsById.get(pdfId);
	}

	getByPath(normalizedPdfPath: string): TrackedPdf | undefined {
		return this.trackedPdfsByPath.get(normalizedPdfPath);
	}

	clear(): void {
		this.trackedPdfsByPath.clear();
		this.trackedPdfsById.clear();
		this.nextPdfId = 1;
	}
}

export async function openAndTrackPdf(
	pdfFilePath: string,
	tracker: PdfTracker,
	signal?: AbortSignal,
	opener: PdfOpener = openPdfInZathura,
	defaultSourceFile?: string,
): Promise<TrackedPdf> {
	const pdfPath = normalizePdfFilePath(pdfFilePath);
	await opener(pdfPath, signal);
	return tracker.trackOpenedPdf(pdfPath, defaultSourceFile ?? inferDefaultSourceFileForPdf(pdfPath));
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

	try {
		await jumpPdfInZathura(trackedPdf.path, resolvedSourceFile, line, signal, options);
		return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: false };
	} catch (firstJumpError) {
		const opener = options.opener ?? ((pdfPath: string, abortSignal?: AbortSignal) => openPdfInZathura(pdfPath, abortSignal, options));
		try {
			await opener(trackedPdf.path, signal);
			tracker.trackOpenedPdf(trackedPdf.path, trackedPdf.sourceFile);
		} catch (reopenError) {
			const message = reopenError instanceof Error ? reopenError.message : String(reopenError);
			throw new Error(`Tracked PDF pdf_id=${pdfId} appears closed or unavailable, and could not be reopened at ${trackedPdf.path}: ${message}`);
		}

		try {
			await jumpPdfInZathura(trackedPdf.path, resolvedSourceFile, line, signal, options);
			return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: true };
		} catch (secondJumpError) {
			const firstMessage = firstJumpError instanceof Error ? firstJumpError.message : String(firstJumpError);
			const secondMessage = secondJumpError instanceof Error ? secondJumpError.message : String(secondJumpError);
			throw new Error(`SyncTeX jump failed for tracked pdf_id=${pdfId} after reopening ${trackedPdf.path}. Verify source_file and line, then try again. First failure: ${firstMessage}. Retry failure: ${secondMessage}`);
		}
	}
}

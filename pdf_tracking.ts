import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface TrackedPdf {
	id: number;
	path: string;
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
}

export class PdfTracker {
	private readonly trackedPdfsByPath = new Map<string, TrackedPdf>();
	private readonly trackedPdfsById = new Map<number, TrackedPdf>();
	private nextPdfId = 1;

	trackOpenedPdf(normalizedPdfPath: string): TrackedPdf {
		const existing = this.trackedPdfsByPath.get(normalizedPdfPath);
		if (existing) {
			existing.lastOpenedAtMs = Date.now();
			return existing;
		}

		const now = Date.now();
		const trackedPdf = {
			id: this.nextPdfId,
			path: normalizedPdfPath,
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

import { gunzipSync } from "node:zlib";
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface TrackedPdf {
	id: number;
	path: string;
	sourceFile?: string;
	pid?: number;
	synctexEditorCommand?: string;
	viewerHandle?: string;
	viewerBackend?: string;
	viewerOwned?: boolean;
	viewerCapabilities?: {
		open: boolean;
		close: boolean;
		forward_search: boolean;
		inverse_search: boolean;
		reuse: boolean;
	};
	hostServicePdfId?: number;
	hostServiceSocketPath?: string;
	hostServiceCallbackTargetId?: string;
	openedAtMs: number;
	lastOpenedAtMs: number;
}

export interface PdfOpenResult {
	pid?: number;
	viewerHandle?: string;
	viewerBackend?: string;
	viewerOwned?: boolean;
	viewerCapabilities?: TrackedPdf["viewerCapabilities"];
	hostServicePdfId?: number;
	hostServiceSocketPath?: string;
	hostServiceCallbackTargetId?: string;
}

export interface PdfJumpResult {
	pdf: string;
	sourceFile: string;
	line: number;
	reopened: boolean;
	sourceLine?: string;
}

export interface PdfCloseResult {
	pdf: string;
	pdfId: number;
	closed: boolean;
	closedPids: number[];
	wasTracked: boolean;
	reason?: string;
}

interface PdfServiceCloseResult {
	closed: boolean;
	reason?: string;
}

interface PdfServiceForwardSearchResult {
	handled: boolean;
	reason?: string;
}

const PDF_HEADER = "%PDF-";

interface PdfCloseOptions {
	requestClose?: (viewerHandle: string, viewerBackend: string, signal?: AbortSignal) => Promise<PdfServiceCloseResult>;
	requestCloseFromHostService?: (hostServicePdfId: number, hostServiceSocketPath: string, signal?: AbortSignal) => Promise<PdfServiceCloseResult>;
}

interface PdfJumpOptions {
	opener?: PdfOpener;
	requestForwardSearch?: (viewerHandle: string, viewerBackend: string, sourceFile: string, line: number, synctexPid?: number, signal?: AbortSignal) => Promise<PdfServiceForwardSearchResult>;
	synctexEditorCommand?: string;
	requestJumpFromHostService?: (
		hostServicePdfId: number,
		hostServiceSocketPath: string,
		sourceFile: string,
		line: number,
		signal?: AbortSignal,
	) => Promise<{
		handled?: boolean;
		source_file?: string;
		source_line?: string;
		reopened?: boolean;
	}>;
}

export function describePdfJumpFailureContext(pdfId: number, tracker: PdfTracker, currentSynctexEditorCommand?: string): string {
	const trackedPdf = tracker.getById(pdfId);
	if (!trackedPdf) return `No tracked PDF found for pdf_id=${pdfId}`;

	return [
		`tracked_pdf_id=${trackedPdf.id}`,
		`tracked_pdf_path=${trackedPdf.path}`,
		`tracked_source_file=${trackedPdf.sourceFile ?? "<unknown>"}`,
		`tracked_pid=${trackedPdf.pid ?? "<unknown>"}`,
		`tracked_synctex_callback_command=${trackedPdf.synctexEditorCommand ?? "<none>"}`,
		`current_synctex_callback_command=${currentSynctexEditorCommand ?? "<none>"}`,
		`callback_command_changed=${trackedPdf.synctexEditorCommand !== undefined && currentSynctexEditorCommand !== undefined && trackedPdf.synctexEditorCommand !== currentSynctexEditorCommand}`,
		`viewer_handle=${trackedPdf.viewerHandle ?? "<none>"}`,
		`viewer_backend=${trackedPdf.viewerBackend ?? "<none>"}`,
		`viewer_owned=${trackedPdf.viewerOwned ?? "<unknown>"}`,
		...(trackedPdf.hostServicePdfId === undefined ? [] : [`host_service_pdf_id=${trackedPdf.hostServicePdfId}`, `host_service_socket_path=${trackedPdf.hostServiceSocketPath ?? "<none>"}`, `host_service_callback_target_id=${trackedPdf.hostServiceCallbackTargetId ?? "<none>"}`]),
	].join("\n");
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
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
		fileStatus = lstatSync(sourceFile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot stat source_file ${sourceFile}: ${message}`);
	}

	if (fileStatus.isSymbolicLink()) {
		throw new Error(`source_file must not be a symlink: ${sourceFile}`);
	}
	if (!fileStatus.isFile()) {
		throw new Error(`source_file must point to a regular file: ${sourceFile}`);
	}
	const uid = process.getuid?.();
	if (uid === undefined || fileStatus.uid !== uid) {
		throw new Error(`source_file must be owned by current user: ${sourceFile}`);
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

export type PdfOpener = (pdfFilePath: string, signal?: AbortSignal) => Promise<PdfOpenResult | void>;

function normalizeOpenResult(rawResult: PdfOpenResult | void): PdfOpenResult {
	if (!rawResult) return {};
	return {
		pid: rawResult.pid,
		viewerHandle: rawResult.viewerHandle,
		viewerBackend: rawResult.viewerBackend,
		viewerOwned: rawResult.viewerOwned,
		viewerCapabilities: rawResult.viewerCapabilities,
		hostServicePdfId: rawResult.hostServicePdfId,
		hostServiceSocketPath: rawResult.hostServiceSocketPath,
		hostServiceCallbackTargetId: rawResult.hostServiceCallbackTargetId,
	};
}

function requireViewerServiceMetadata(result: PdfOpenResult, context = "openAndTrackPdf"): PdfOpenResult {
	if (!result.viewerHandle || !result.viewerBackend) {
		throw new Error(`${context}: opener result must include viewerHandle and viewerBackend for service-opened PDFs.`);
	}
	return result;
}

export class PdfTracker {
	private readonly trackedPdfsByPath = new Map<string, TrackedPdf[]>();
	private readonly trackedPdfsById = new Map<number, TrackedPdf>();
	private readonly pendingOpensByPath = new Map<string, Promise<TrackedPdf>>();
	private nextPdfId = 1;

	trackOpenedPdf(
		normalizedPdfPath: string,
		defaultSourceFile?: string,
		pid?: number,
		synctexEditorCommand?: string,
		viewerOpenResult: PdfOpenResult = {},
	): TrackedPdf {
		const now = Date.now();
		const trackedPdf: TrackedPdf = {
			id: this.nextPdfId,
			path: normalizedPdfPath,
			sourceFile: defaultSourceFile,
			pid,
			synctexEditorCommand,
			viewerHandle: viewerOpenResult.viewerHandle,
			viewerBackend: viewerOpenResult.viewerBackend,
			viewerOwned: viewerOpenResult.viewerOwned,
			viewerCapabilities: viewerOpenResult.viewerCapabilities,
			hostServicePdfId: viewerOpenResult.hostServicePdfId,
			hostServiceSocketPath: viewerOpenResult.hostServiceSocketPath,
			hostServiceCallbackTargetId: viewerOpenResult.hostServiceCallbackTargetId,
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

	markReopened(
		pdfId: number,
		pid?: number,
		defaultSourceFile?: string,
		synctexEditorCommand?: string,
		viewerOpenResult?: PdfOpenResult,
	): TrackedPdf | undefined {
		const trackedPdf = this.trackedPdfsById.get(pdfId);
		if (!trackedPdf) return undefined;
		if (defaultSourceFile) trackedPdf.sourceFile = defaultSourceFile;
		if (synctexEditorCommand) trackedPdf.synctexEditorCommand = synctexEditorCommand;
		if (viewerOpenResult?.viewerHandle !== undefined) trackedPdf.viewerHandle = viewerOpenResult.viewerHandle;
		if (viewerOpenResult?.viewerBackend !== undefined) trackedPdf.viewerBackend = viewerOpenResult.viewerBackend;
		if (viewerOpenResult?.viewerOwned !== undefined) trackedPdf.viewerOwned = viewerOpenResult.viewerOwned;
		if (viewerOpenResult?.viewerCapabilities !== undefined) trackedPdf.viewerCapabilities = viewerOpenResult.viewerCapabilities;
		if (viewerOpenResult?.hostServicePdfId !== undefined) trackedPdf.hostServicePdfId = viewerOpenResult.hostServicePdfId;
		if (viewerOpenResult?.hostServiceSocketPath !== undefined) trackedPdf.hostServiceSocketPath = viewerOpenResult.hostServiceSocketPath;
		if (viewerOpenResult?.hostServiceCallbackTargetId !== undefined) trackedPdf.hostServiceCallbackTargetId = viewerOpenResult.hostServiceCallbackTargetId;
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

export async function closeTrackedPdf(
	pdfId: number,
	tracker: PdfTracker,
	options: PdfCloseOptions = {},
	signal?: AbortSignal,
): Promise<PdfCloseResult> {
	const trackedPdf = tracker.getById(pdfId);
	if (!trackedPdf) {
		throw new Error(`Unknown tracked pdf_id=${pdfId}. Open the PDF first with open_pdf or compile_latex_file(..., open_pdf=true).`);
	}

	if (trackedPdf.hostServicePdfId !== undefined) {
		if (!options.requestCloseFromHostService) {
			throw new Error(`Tracked pdf_id=${pdfId} requires host service close but no host service close handler is configured.`);
		}
		if (trackedPdf.hostServiceSocketPath === undefined) {
			throw new Error(`Tracked pdf_id=${pdfId} has host service metadata without an active socket path.`);
		}
		const serviceResult = await options.requestCloseFromHostService(
			trackedPdf.hostServicePdfId,
			trackedPdf.hostServiceSocketPath,
			signal,
		);
		tracker.untrackById(pdfId);
		return {
			pdf: trackedPdf.path,
			pdfId,
			closed: serviceResult.closed,
			...(serviceResult.reason !== undefined ? { reason: serviceResult.reason } : {}),
			closedPids: [],
			wasTracked: true,
		};
	}

	if (trackedPdf.viewerHandle !== undefined && trackedPdf.viewerBackend !== undefined) {
		if (!options.requestClose) {
			throw new Error(`Tracked pdf_id=${pdfId} requires viewer service close but no close handler is configured.`);
		}
		const serviceResult = await options.requestClose(trackedPdf.viewerHandle, trackedPdf.viewerBackend, signal);
		tracker.untrackById(pdfId);
		return {
			pdf: trackedPdf.path,
			pdfId,
			closed: serviceResult.closed,
			...(serviceResult.reason !== undefined ? { reason: serviceResult.reason } : {}),
			closedPids: [],
			wasTracked: true,
		};
	}

	throw new Error(`Tracked pdf_id=${pdfId} was opened without viewer-service metadata; viewer service is required to close this PDF. Reopen using open_pdf or compile_latex_file(open_pdf=true).`);
}

export async function openAndTrackPdf(
	pdfFilePath: string,
	tracker: PdfTracker,
	signal?: AbortSignal,
	opener?: PdfOpener,
	defaultSourceFile?: string,
	synctexEditorCommand?: string,
	reuseExistingPdf = true,
): Promise<TrackedPdf> {
	const pdfPath = normalizePdfFilePath(pdfFilePath);
	const sourceFile = defaultSourceFile ?? inferDefaultSourceFileForPdf(pdfPath);
	const reusableTrackedPdf = tracker.getByPath(pdfPath);
	if (reuseExistingPdf && reusableTrackedPdf?.viewerHandle !== undefined && reusableTrackedPdf.viewerBackend !== undefined) {
		return tracker.markReopened(reusableTrackedPdf.id, reusableTrackedPdf.pid, sourceFile, synctexEditorCommand) ?? reusableTrackedPdf;
	}

	if (!opener) {
		throw new Error("openAndTrackPdf requires a viewer-service opener. Direct Zathura opening is not supported in this flow.");
	}

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
		const openerResult = await opener(pdfPath, signal);
		const normalizedResult = requireViewerServiceMetadata(normalizeOpenResult(openerResult));
		if (staleTrackedPdf && tracker.getById(staleTrackedPdf.id)) {
			return tracker.markReopened(staleTrackedPdf.id, normalizedResult.pid, sourceFile, synctexEditorCommand, normalizedResult) ?? staleTrackedPdf;
		}
		return tracker.trackOpenedPdf(pdfPath, sourceFile, normalizedResult.pid, synctexEditorCommand, normalizedResult);
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
	options: PdfJumpOptions = {},
): Promise<PdfJumpResult> {
	const trackedPdf = tracker.getById(pdfId);
	if (!trackedPdf) {
		throw new Error(`Unknown tracked pdf_id=${pdfId}. Open the PDF first with open_pdf or compile_latex_file(..., open_pdf=true).`);
	}
	if (!Number.isInteger(line) || line < 1) {
		throw new Error("line must be a positive integer");
	}

	const resolvedSourceFile = sourceFile
		? resolveSourceFilePath(sourceFile)
		: trackedPdf.sourceFile;
	if (!resolvedSourceFile) {
		throw new Error(`No default source_file is known for tracked pdf_id=${pdfId}. Pass source_file explicitly.`);
	}
	assertReadableSourceFile(resolvedSourceFile);

	const trackedSynctexCommand = options.synctexEditorCommand ?? trackedPdf.synctexEditorCommand;

	if (trackedPdf.hostServicePdfId !== undefined) {
		if (!options.requestJumpFromHostService) {
			throw new Error(`Tracked pdf_id=${pdfId} requires host service jump but no jump handler is configured.`);
		}
		if (trackedPdf.hostServiceSocketPath === undefined) {
			throw new Error(`Tracked pdf_id=${pdfId} has host service metadata without an active socket path.`);
		}
		const hostServiceJump = await options.requestJumpFromHostService(
			trackedPdf.hostServicePdfId,
			trackedPdf.hostServiceSocketPath,
			resolvedSourceFile,
			line,
			signal,
		);
		return {
			pdf: trackedPdf.path,
			sourceFile: hostServiceJump.source_file ?? resolvedSourceFile,
			line,
			reopened: Boolean(hostServiceJump.reopened),
			sourceLine: hostServiceJump.source_line,
		};
	}

	const extractServiceErrorCode = (error: unknown): string | undefined => {
		const message = error instanceof Error ? error.message : String(error);
		return /\(code=([^)]+)\)/.exec(message)?.[1];
	};

	const opener = options.opener ?? (() => {
		throw new Error(`Tracked pdf_id=${pdfId} is not managed by a viewer-service handle and viewer service is required to reopen it.`);
	});

	if (trackedPdf.viewerHandle !== undefined && trackedPdf.viewerBackend !== undefined) {
		if (trackedPdf.viewerCapabilities?.forward_search === false) {
			throw new Error(`Tracked pdf_id=${pdfId} is not managed by a forward_search-capable viewer backend: ${trackedPdf.viewerBackend}`);
		}
		if (!options.requestForwardSearch) {
			throw new Error(`Tracked pdf_id=${pdfId} requires viewer service forward_search but no forward-search handler is configured.`);
		}

		const jumpWithService = async (synctexPid: number | undefined): Promise<void> => {
			await options.requestForwardSearch!(
				trackedPdf.viewerHandle as string,
				trackedPdf.viewerBackend as string,
				resolvedSourceFile,
				line,
				synctexPid,
				signal,
			);
		};

		try {
			await jumpWithService(trackedPdf.pid);
			return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: false };
		} catch (firstError) {
			const errorCode = extractServiceErrorCode(firstError);
			if (errorCode !== "handle_not_found") {
				throw firstError;
			}

			let reopenedMetadata: PdfOpenResult | undefined;
			let openerErrorMessage: string | undefined;
			try {
				const rawResult = await opener(trackedPdf.path, signal);
				reopenedMetadata = requireViewerServiceMetadata(normalizeOpenResult(rawResult), "jumpToTrackedPdf");
			} catch (reopenError) {
				openerErrorMessage = reopenError instanceof Error ? reopenError.message : String(reopenError);
			}
			if (reopenedMetadata === undefined) {
				const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
				const secondMessage = openerErrorMessage ? `: ${openerErrorMessage}` : "";
				throw new Error(`Tracked PDF pdf_id=${pdfId} appears closed or unavailable, and had a stale forward_search handle ${trackedPdf.viewerHandle} at ${trackedPdf.path}: ${firstMessage}${secondMessage}`);
			}

			tracker.markReopened(pdfId, reopenedMetadata.pid, trackedPdf.sourceFile, trackedSynctexCommand, reopenedMetadata);
			try {
				await jumpWithService(trackedPdf.pid);
				return { pdf: trackedPdf.path, sourceFile: resolvedSourceFile, line, reopened: true };
			} catch (retryError) {
				const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
				const secondMessage = retryError instanceof Error ? retryError.message : String(retryError);
				throw new Error(`Tracked PDF pdf_id=${pdfId} appears closed or unavailable, stale handle retry failed for ${trackedPdf.path}: ${firstMessage.replace(/\n/g, " ")} ${secondMessage.replace(/\n/g, " ")}`);
			}
		}
	}

	throw new Error(`Tracked pdf_id=${pdfId} was opened without viewer-service metadata; viewer service is required to jump PDFs. Reopen using open_pdf or compile_latex_file(open_pdf=true).`);
}

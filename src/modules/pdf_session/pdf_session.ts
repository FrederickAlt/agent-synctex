import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readSourceLine } from "../synctex/synctex.ts";
import {
	closeTrackedPdf,
	describePdfJumpFailureContext,
	jumpToTrackedPdf,
	type PdfCloseResult,
	type PdfJumpResult,
	type PdfOpenResult,
	PdfTracker,
	type TrackedPdf,
	normalizePdfFilePath,
	openAndTrackPdf,
} from "../pdf_tracking/pdf_tracking.ts";

const pdfTrackersByContext = new Map<string, PdfTracker>();
const contextUiIds = new WeakMap<object, string>();
let nextContextUiId = 1;

export function contextSessionKey(ctx?: ExtensionContext): string {
	if (!ctx) {
		throw new Error("PDF tracking is only available inside a Pi agent session");
	}

	const ui = ctx.ui as object;
	let uiId = contextUiIds.get(ui);
	if (!uiId) {
		uiId = `ui-${nextContextUiId++}`;
		contextUiIds.set(ui, uiId);
	}

	return `${ctx.cwd}|${uiId}`;
}

export type PdfSessionOpenResult = {
	pid?: number;
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
	handle?: string;
	backend?: string;
	owned?: boolean;
	capabilities?: {
		open: boolean;
		close: boolean;
		forward_search: boolean;
		inverse_search: boolean;
		reuse: boolean;
	};
	hostServicePdfId?: number;
	hostServiceSocketPath?: string;
	hostServiceCallbackTargetId?: string;
};
export type PdfSessionOpen = (pdfFilePath: string, signal?: AbortSignal) => Promise<PdfSessionOpenResult | void>;

export type PdfSessionClose = (
	viewerHandle: string,
	viewerBackend: string,
	signal?: AbortSignal,
) => Promise<{ closed: boolean; reason?: string }>;

export type PdfSessionCloseFromHostService = (hostServicePdfId: number, hostServiceSocketPath: string, signal?: AbortSignal) => Promise<{ closed: boolean; reason?: string }>;

function toPdfOpenResult(openResult: PdfSessionOpenResult | void): PdfOpenResult | void {
	if (!openResult) return undefined;
	return {
		pid: openResult.pid,
		viewerHandle: openResult.viewerHandle ?? openResult.handle,
		viewerBackend: openResult.viewerBackend ?? openResult.backend,
		viewerOwned: openResult.viewerOwned ?? openResult.owned,
		viewerCapabilities: openResult.viewerCapabilities ?? openResult.capabilities,
		hostServicePdfId: openResult.hostServicePdfId,
		hostServiceSocketPath: openResult.hostServiceSocketPath,
		hostServiceCallbackTargetId: openResult.hostServiceCallbackTargetId,
	};
}

function requireViewerServiceMetadata(result: PdfOpenResult, context = "openTrackedPdfForContext") : PdfOpenResult {
	if (!result.viewerHandle || !result.viewerBackend) {
		throw new Error(`${context}: opener result must include viewerHandle and viewerBackend for service-opened PDFs.`);
	}
	return result;
}

export function trackOpenResultFromViewerService(
	tracker: PdfTracker,
	pdfPath: string,
	synctexCommand: string | undefined,
	response: PdfSessionOpenResult,
): TrackedPdf {
	const trackedResult = {
		pid: response.pid,
		viewerHandle: response.viewerHandle ?? response.handle,
		viewerBackend: response.viewerBackend ?? response.backend,
		viewerOwned: response.viewerOwned ?? response.owned,
		viewerCapabilities: response.viewerCapabilities ?? response.capabilities,
	};
	const existing = tracker.getByPath(pdfPath);
	if (existing) {
		tracker.markReopened(existing.id, response.pid, undefined, synctexCommand, trackedResult);
		return existing;
	}

	return tracker.trackOpenedPdf(pdfPath, undefined, response.pid, synctexCommand, trackedResult);
}

export function getPdfTrackerForContext(ctx?: ExtensionContext): PdfTracker {
	const key = contextSessionKey(ctx);
	let tracker = pdfTrackersByContext.get(key);
	if (!tracker) {
		tracker = new PdfTracker();
		pdfTrackersByContext.set(key, tracker);
	}
	return tracker;
}

export function clearPdfTrackerForContext(ctx?: ExtensionContext): void {
	const key = contextSessionKey(ctx);
	pdfTrackersByContext.get(key)?.clear();
	pdfTrackersByContext.delete(key);
}

export function clearPdfTrackers(): void {
	for (const tracker of pdfTrackersByContext.values()) {
		tracker.clear();
	}
	pdfTrackersByContext.clear();
}

export interface OpenTrackedPdfOptions {
	reuseTrackedPdf?: boolean;
	pdfId?: number;
}

export async function openTrackedPdfForContext(
	ctx: ExtensionContext | undefined,
	pdfFilePath: string,
	signal: AbortSignal | undefined,
	opener: PdfSessionOpen,
	defaultSourceFile?: string,
	synctexEditorCommand?: string,
	options: OpenTrackedPdfOptions = {},
): Promise<TrackedPdf> {
	const tracker = getPdfTrackerForContext(ctx);
	return openAndTrackPdf(
		pdfFilePath,
		tracker,
		signal,
		async (path: string, openSignal: AbortSignal | undefined) => toPdfOpenResult(await opener(path, openSignal)),
		defaultSourceFile,
		synctexEditorCommand,
		{
			reuseTrackedPdf: options.reuseTrackedPdf ?? true,
			pdfId: options.pdfId,
		},
	);
}

export async function openTrackedPdfForContextFromViewerService(
	ctx: ExtensionContext | undefined,
	pdfFilePath: string,
	signal: AbortSignal | undefined,
	opener: PdfSessionOpen,
	synctexEditorCommand?: string,
): Promise<TrackedPdf> {
	const tracker = getPdfTrackerForContext(ctx);
	const pdfPath = normalizePdfFilePath(pdfFilePath);
	const normalizedOpenResult = requireViewerServiceMetadata(
		toPdfOpenResult(await opener(pdfPath, signal)) ?? {},
		"openTrackedPdfForContextFromViewerService",
	);
	return trackOpenResultFromViewerService(tracker, pdfPath, synctexEditorCommand, {
		...normalizedOpenResult,
	});
}

export interface PdfSessionForwardSearchResult {
	handled: boolean;
	reason?: string;
}

export type PdfSessionForwardSearch = (
	viewerHandle: string,
	viewerBackend: string,
	sourceFile: string,
	line: number,
	synctexPid?: number,
	signal?: AbortSignal,
) => Promise<PdfSessionForwardSearchResult>;

export type PdfSessionJumpSourceReader = (sourceFile: string, line: number, cwd: string) => string | undefined;

export interface PdfSessionJumpOptions {
	synctexEditorCommand?: string;
	requestForwardSearch: PdfSessionForwardSearch;
	opener?: PdfSessionOpen;
	sourceLineReader?: PdfSessionJumpSourceReader;
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
	cwd?: string;
}

export interface PdfSessionJumpResult extends PdfJumpResult {
	sourceLine: string;
}

export async function jumpTrackedPdfForContext(
	ctx: ExtensionContext | undefined,
	pdfId: number,
	line: number,
	sourceFile: string | undefined,
	signal: AbortSignal | undefined,
	options: PdfSessionJumpOptions,
): Promise<PdfSessionJumpResult> {
	const tracker = getPdfTrackerForContext(ctx);
	const result = await jumpToTrackedPdf(
		pdfId,
		line,
		sourceFile,
		tracker,
		signal,
		{
			synctexEditorCommand: options.synctexEditorCommand,
			opener: options.opener ? async (path: string, openSignal: AbortSignal | undefined) => {
				const rawResult = await options.opener!(path, openSignal);
				return toPdfOpenResult(rawResult);
			} : undefined,
			requestForwardSearch: async (viewerHandle, viewerBackend, sourceFilePath, jumpLine, synctexPid, jumpSignal) => {
				const response = await options.requestForwardSearch(
					viewerHandle,
					viewerBackend,
					sourceFilePath,
					jumpLine,
					synctexPid,
					jumpSignal,
				);
				return { handled: response.handled, reason: response.reason };
			},
			requestJumpFromHostService: options.requestJumpFromHostService
				? async (hostServicePdfId, hostServiceSocketPath, sourceFile, jumpLine, jumpSignal) => {
					const response = await options.requestJumpFromHostService!(
						hostServicePdfId,
						hostServiceSocketPath,
						sourceFile,
						jumpLine,
						jumpSignal,
					);
					return {
						handled: response.handled,
						source_file: response.source_file,
						source_line: response.source_line,
						reopened: response.reopened,
				};
				}
				: undefined,
		},
	);

	const sourceLine = result.sourceLine === undefined
		? (options.sourceLineReader ?? readSourceLine)(result.sourceFile, result.line, options.cwd ?? process.cwd())
		: result.sourceLine;
	return {
		...result,
		sourceLine: sourceLine ?? "",
	};
}

export function describePdfJumpFailureContextForContext(
	ctx: ExtensionContext | undefined,
	pdfId: number,
	currentSynctexEditorCommand?: string,
): string {
	return describePdfJumpFailureContext(pdfId, getPdfTrackerForContext(ctx), currentSynctexEditorCommand);
}

export async function closeTrackedPdfForContext(
	ctx: ExtensionContext | undefined,
	pdfId: number,
	requestClose: PdfSessionClose,
	signal?: AbortSignal,
	requestCloseFromHostService?: PdfSessionCloseFromHostService,
): Promise<PdfCloseResult> {
	const tracker = getPdfTrackerForContext(ctx);
	return closeTrackedPdf(
		pdfId,
		tracker,
		{
			requestClose,
			...(requestCloseFromHostService === undefined ? {} : { requestCloseFromHostService }),
		},
		signal,
	);
}

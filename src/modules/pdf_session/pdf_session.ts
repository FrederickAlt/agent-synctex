import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	closeTrackedPdf,
	type PdfCloseResult,
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
};
export type PdfSessionOpen = (pdfFilePath: string, signal?: AbortSignal) => Promise<PdfSessionOpenResult | void>;

export type PdfSessionClose = (
	viewerHandle: string,
	viewerBackend: string,
	signal?: AbortSignal,
) => Promise<{ closed: boolean; reason?: string }>;

function toPdfOpenResult(openResult: PdfSessionOpenResult | void): PdfOpenResult | void {
	if (!openResult) return undefined;
	return {
		pid: openResult.pid,
		viewerHandle: openResult.viewerHandle ?? openResult.handle,
		viewerBackend: openResult.viewerBackend ?? openResult.backend,
		viewerOwned: openResult.viewerOwned ?? openResult.owned,
		viewerCapabilities: openResult.viewerCapabilities ?? openResult.capabilities,
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

export async function openTrackedPdfForContext(
	ctx: ExtensionContext | undefined,
	pdfFilePath: string,
	signal: AbortSignal | undefined,
	opener: PdfSessionOpen,
	defaultSourceFile?: string,
	synctexEditorCommand?: string,
): Promise<TrackedPdf> {
	const tracker = getPdfTrackerForContext(ctx);
	return openAndTrackPdf(
		pdfFilePath,
		tracker,
		signal,
		async (path: string, openSignal: AbortSignal | undefined) => toPdfOpenResult(await opener(path, openSignal)),
		defaultSourceFile,
		synctexEditorCommand,
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

export async function closeTrackedPdfForContext(
	ctx: ExtensionContext | undefined,
	pdfId: number,
	requestClose: PdfSessionClose,
	signal?: AbortSignal,
): Promise<PdfCloseResult> {
	const tracker = getPdfTrackerForContext(ctx);
	return closeTrackedPdf(
		pdfId,
		tracker,
		{
			requestClose,
		},
		signal,
	);
}

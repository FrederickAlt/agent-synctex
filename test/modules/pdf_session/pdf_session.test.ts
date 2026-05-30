import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	clearPdfTrackerForContext,
	closeTrackedPdfForContext,
	contextSessionKey,
	describePdfJumpFailureContextForContext,
	getPdfTrackerForContext,
	jumpTrackedPdfForContext,
	openTrackedPdfForContext,
	openTrackedPdfForContextFromViewerService,
} from "../../../src/modules/pdf_session/pdf_session.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pdf-session-test-"));
}

function writeMinimalPdf(path: string): void {
	writeFileSync(path, "%PDF-1.7\n% test\n%%EOF\n");
}

function fakeContext(cwd: string, ui: object): ExtensionContext {
	return {
		cwd,
		ui,
		hasUI: true,
		isIdle: () => false,
		signal: undefined,
	} as ExtensionContext;
}

test("getPdfTrackerForContext reuses trackers for the same ui+cwd", () => {
	const ui = {};
	const trackerA1 = getPdfTrackerForContext(fakeContext("/project/a", ui));
	const trackerA2 = getPdfTrackerForContext(fakeContext("/project/a", ui));
	const trackerB = getPdfTrackerForContext(fakeContext("/project/b", ui));
	const trackerC = getPdfTrackerForContext(fakeContext("/project/a", {}));

	assert.equal(trackerA1, trackerA2);
	assert.notEqual(trackerA1, trackerB);
	assert.notEqual(trackerA1, trackerC);
});

test("contextSessionKey is stable for the same ui object", () => {
	const ui = {};
	const key1 = contextSessionKey(fakeContext("/project", ui));
	const key2 = contextSessionKey(fakeContext("/project", ui));
	assert.equal(key1, key2);
});

test("openTrackedPdfForContext reuses session tracker and clears on shutdown", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);
	const ctx = fakeContext(dir, {});

	const opened = await openTrackedPdfForContext(ctx, pdf, undefined, async (pdfPath) => ({
		pid: 1234,
		viewerHandle: "viewer-handle",
		viewerBackend: "viewer-backend",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	}));
	assert.equal(opened.id, 1);
	const reopened = await openTrackedPdfForContext(ctx, pdf, undefined, async (pdfPath) => {
		assert.fail(`unexpected opener call for reused PDF: ${pdfPath}`);
	});
	assert.equal(reopened.id, opened.id);

	clearPdfTrackerForContext(ctx);
	const reopenedAfterClear = await openTrackedPdfForContext(ctx, pdf, undefined, async (pdfPath) => ({
		pid: 2222,
		viewerHandle: "viewer-handle-2",
		viewerBackend: "viewer-backend",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	}));
	assert.equal(reopenedAfterClear.id, 1);
	assert.equal(reopenedAfterClear.viewerHandle, "viewer-handle-2");
});

test("openTrackedPdfForContextFromViewerService reopens tracked PDFs while still calling the opener", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);
	const ctx = fakeContext(dir, {});
	let openCalls = 0;

	const opener = async () => {
		openCalls += 1;
		return {
			pid: 3000 + openCalls,
			viewerHandle: `viewer-handle-${openCalls}`,
			viewerBackend: "viewer-backend",
			viewerOwned: true,
			viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
		};
	};

	const first = await openTrackedPdfForContextFromViewerService(ctx, pdf, undefined, opener);
	const second = await openTrackedPdfForContextFromViewerService(ctx, pdf, undefined, opener);
	assert.equal(first.id, second.id);
	assert.equal(openCalls, 2);
	assert.equal(second.viewerHandle, "viewer-handle-2");
});

test("closeTrackedPdfForContext closes tracked PDF and removes from tracker", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);
	const ctx = fakeContext(dir, {});
	const opener = async () => ({
		pid: 3000,
		viewerHandle: "viewer-handle",
		viewerBackend: "viewer-backend",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const tracked = await openTrackedPdfForContext(ctx, pdf, undefined, opener);

	const closeResult = await closeTrackedPdfForContext(ctx, tracked.id, async (viewerHandle, viewerBackend, closeSignal) => {
		assert.equal(viewerHandle, "viewer-handle");
		assert.equal(viewerBackend, "viewer-backend");
		assert.equal(closeSignal, undefined);
		return { closed: true, reason: "closed" };
	});

	assert.equal(closeResult.pdf, tracked.path);
	assert.equal(closeResult.closed, true);
	assert.equal(closeResult.reason, "closed");
	assert.equal(closeResult.closedPids.length, 0);

	const tracker = getPdfTrackerForContext(ctx);
	assert.equal(tracker.getById(tracked.id), undefined);
});

test("jumpTrackedPdfForContext forwards jump requests, reads the target source line, and returns source_line", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "line one\nline two\nline three\n");
	const ctx = fakeContext(dir, {});
	const tracker = getPdfTrackerForContext(ctx);
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 123);
	trackedPdf.viewerHandle = "viewer-handle-1";
	trackedPdf.viewerBackend = "viewer-backend";
	trackedPdf.viewerOwned = true;
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	const forwardSearchCalls: string[] = [];
	const result = await jumpTrackedPdfForContext(
		ctx,
		trackedPdf.id,
		2,
		undefined,
		undefined,
		{
			synctexEditorCommand: "callback-command",
			requestForwardSearch: async (viewerHandle, viewerBackend, sourceFilePath, jumpLine, synctexPid) => {
				forwardSearchCalls.push(`${viewerHandle}|${viewerBackend}|${sourceFilePath}|${jumpLine}|${synctexPid ?? ""}`);
				return { handled: true };
			},
			cwd: ctx.cwd,
		},
	);

	assert.equal(forwardSearchCalls.length, 1);
	assert.equal(forwardSearchCalls[0], `viewer-handle-1|viewer-backend|${source}|2|123`);
	assert.equal(result.sourceLine, "line two");
	assert.equal(result.reopened, false);
});

test("jumpTrackedPdfForContext retries stale handles once and updates tracked metadata", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "first\nsecond\n");
	const ctx = fakeContext(dir, {});
	const tracker = getPdfTrackerForContext(ctx);
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 333);
	trackedPdf.viewerHandle = "viewer-stale";
	trackedPdf.viewerBackend = "viewer-backend";
	trackedPdf.viewerOwned = true;
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	let forwardCalls = 0;
	let openerCalls = 0;
	const result = await jumpTrackedPdfForContext(
		ctx,
		trackedPdf.id,
		1,
		undefined,
		undefined,
		{
			synctexEditorCommand: "callback-command-retry",
			opener: async () => {
				openerCalls += 1;
				return {
					pid: 999,
					viewerHandle: "viewer-recovered",
					viewerBackend: "viewer-backend",
					viewerOwned: true,
					viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
				};
			},
			requestForwardSearch: async (_viewerHandle, _viewerBackend, _sourceFilePath, _jumpLine, _synctexPid) => {
				forwardCalls += 1;
				if (forwardCalls === 1) {
					throw new Error("viewer handle not found (code=handle_not_found)");
				}
				return { handled: true };
			},
			sourceLineReader: () => "first",
			cwd: ctx.cwd,
		},
	);

	assert.equal(result.reopened, true);
	assert.equal(forwardCalls, 2);
	assert.equal(openerCalls, 1);
	assert.equal(tracker.getById(trackedPdf.id)?.viewerHandle, "viewer-recovered");
	assert.equal(result.sourceLine, "first");
});

test("describePdfJumpFailureContextForContext includes current callback metadata", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "source\n");
	const ctx = fakeContext(dir, {});
	const tracker = getPdfTrackerForContext(ctx);
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 555, "callback-old", {
		viewerHandle: "viewer-handle",
		viewerBackend: "viewer-backend",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});

	const context = describePdfJumpFailureContextForContext(ctx, trackedPdf.id, "callback-new");
	assert.equal(context.includes("tracked_pdf_id=1"), true);
	assert.equal(context.includes("tracked_synctex_callback_command=callback-old"), true);
	assert.equal(context.includes("current_synctex_callback_command=callback-new"), true);
	assert.equal(context.includes("callback_command_changed=true"), true);
});

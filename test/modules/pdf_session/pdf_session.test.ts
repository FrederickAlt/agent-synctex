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
	getPdfTrackerForContext,
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

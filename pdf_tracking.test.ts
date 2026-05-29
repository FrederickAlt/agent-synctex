import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReadablePdfFile,
	closeTrackedPdf,
	describePdfJumpFailureContext,
	inferDefaultSourceFileForPdf,
	jumpToTrackedPdf,
	normalizePdfFilePath,
	openAndTrackPdf,
	PdfTracker,
} from "./pdf_tracking.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pdf-tracking-test-"));
}

function writeMinimalPdf(path: string): void {
	writeFileSync(path, "%PDF-1.7\n% test\n%%EOF\n");
}



test("assertReadablePdfFile rejects missing, directory, and non-PDF paths clearly", () => {
	const dir = tempDir();
	assert.throws(() => assertReadablePdfFile(join(dir, "missing.pdf")), /Cannot stat PDF file/);
	assert.throws(() => assertReadablePdfFile(dir), /regular file/);

	const textFile = join(dir, "not-a-pdf.pdf");
	writeFileSync(textFile, "not a pdf");
	assert.throws(() => assertReadablePdfFile(textFile), /must point to a PDF file/);
});

test("normalizePdfFilePath resolves symlinks so equivalent paths share one identity", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
	symlinkSync(pdf, link);

	assert.equal(normalizePdfFilePath(link), normalizePdfFilePath(pdf));
});

test("PdfTracker assigns short session-local IDs and tracks repeated paths separately", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	const repeated = tracker.trackOpenedPdf("/tmp/one.pdf");
	const second = tracker.trackOpenedPdf("/tmp/two.pdf");

	assert.equal(first.id, 1);
	assert.equal(repeated.id, 2);
	assert.equal(second.id, 3);
	assert.equal(tracker.getById(first.id)?.path, "/tmp/one.pdf");
	assert.equal(tracker.getByPath("/tmp/one.pdf")?.id, repeated.id);
	assert.equal(tracker.getByPath("/tmp/two.pdf")?.id, second.id);
	assert.deepEqual(tracker.getAllByPath("/tmp/one.pdf").map((entry) => entry.id), [first.id, repeated.id]);
});

test("PdfTracker stores default source files and can update a reopened instance", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	assert.equal(first.sourceFile, undefined);
	assert.equal(first.pid, undefined);

	const reopened = tracker.markReopened(first.id, 1234, "/tmp/main.tex");
	assert.equal(reopened?.id, first.id);
	assert.equal(first.sourceFile, "/tmp/main.tex");
	assert.equal(first.pid, 1234);
});

test("PdfTracker clear drops session state and resets IDs", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	tracker.trackOpenedPdf("/tmp/two.pdf");

	tracker.clear();

	assert.equal(tracker.getById(first.id), undefined);
	assert.equal(tracker.getByPath("/tmp/one.pdf"), undefined);
	assert.equal(tracker.getByPath("/tmp/two.pdf"), undefined);

	const nextSessionPdf = tracker.trackOpenedPdf("/tmp/one.pdf");
	assert.equal(nextSessionPdf.id, 1);
	assert.notEqual(nextSessionPdf, first);
});

test("PdfTracker can untrack a single PDF", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	const second = tracker.trackOpenedPdf("/tmp/two.pdf");

	assert.equal(tracker.untrackById(first.id), first);
	assert.equal(tracker.getById(first.id), undefined);
	assert.equal(tracker.getByPath("/tmp/one.pdf"), undefined);
	assert.equal(tracker.getById(second.id), second);
	assert.equal(tracker.untrackById(999), undefined);
});


test("inferDefaultSourceFileForPdf prefers a readable same-basename source", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	assert.equal(inferDefaultSourceFileForPdf(pdf), source);
});

test("inferDefaultSourceFileForPdf uses unique SyncTeX input records when basename source is absent", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "main.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(join(dir, "paper.synctex"), `SyncTeX Version:1\nInput:1:${source}\n`);

	assert.equal(inferDefaultSourceFileForPdf(pdf), source);
});

test("inferDefaultSourceFileForPdf reads gzip SyncTeX sidecars and avoids ambiguous inputs", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const main = join(dir, "main.tex");
	const chapter = join(dir, "chapter.tex");
	writeMinimalPdf(pdf);
	writeFileSync(main, "\\documentclass{article}\n");
	writeFileSync(chapter, "chapter\n");
	writeFileSync(join(dir, "paper.synctex.gz"), gzipSync(`Input:1:${main}\nInput:2:${chapter}\n`));

	assert.equal(inferDefaultSourceFileForPdf(pdf), undefined);
});

test("openAndTrackPdf normalizes, opens, infers default source, and tracks a PDF", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	symlinkSync(pdf, link);

	const tracker = new PdfTracker();
	const openedPaths: string[] = [];
	const trackedPdf = await openAndTrackPdf(link, tracker, undefined, async (pdfPath) => {
		openedPaths.push(pdfPath);
		return {
			pid: 4321,
			viewerHandle: "viewer-service-open",
			viewerBackend: "zathura",
			viewerOwned: true,
			viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
		};
	});

	const realPdfPath = realpathSync(pdf);
	assert.deepEqual(openedPaths, [realPdfPath]);
	assert.equal(trackedPdf.id, 1);
	assert.equal(trackedPdf.path, realPdfPath);
	assert.equal(trackedPdf.sourceFile, source);
	assert.equal(trackedPdf.viewerHandle, "viewer-service-open");
	assert.equal(trackedPdf.viewerBackend, "zathura");
	assert.equal(tracker.getByPath(realPdfPath), trackedPdf);
});

test("openAndTrackPdf stores an exact default source from the caller", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "requested-main.tex");
	writeMinimalPdf(pdf);
	writeFileSync(join(dir, "paper.tex"), "inferred basename source\n");
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = await openAndTrackPdf(pdf, tracker, undefined, async () => ({
		pid: 4321,
		viewerHandle: "viewer-service-open",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	}), source);

	assert.equal(trackedPdf.sourceFile, source);
	assert.equal(trackedPdf.viewerHandle, "viewer-service-open");
});

test("openAndTrackPdf rejects opener results without service metadata", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	await assert.rejects(
		() => openAndTrackPdf(pdf, tracker, undefined, async () => ({ pid: 4321 })),
		/openAndTrackPdf: opener result must include viewerHandle and viewerBackend for service-opened PDFs\./,
	);
});

test("openAndTrackPdf stores viewer metadata from structured opener result", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	const trackedPdf = await openAndTrackPdf(pdf, tracker, undefined, async () => ({
		pid: 4321,
		viewerHandle: "zathura:open",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	}));

	assert.equal(trackedPdf.pid, 4321);
	assert.equal(trackedPdf.viewerHandle, "zathura:open");
	assert.equal(trackedPdf.viewerBackend, "zathura");
	assert.equal(trackedPdf.viewerOwned, true);
	assert.deepEqual(trackedPdf.viewerCapabilities, {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	});
});

test("openAndTrackPdf reuses an already service-tracked PDF for the same normalized path", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
	symlinkSync(pdf, link);

	const tracker = new PdfTracker();
	const realPdf = realpathSync(pdf);
	tracker.trackOpenedPdf(realPdf, undefined, 9999, undefined, {
		viewerHandle: "viewer-service-handle",
		viewerBackend: "viewer-service-backend",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const openedPaths: string[] = [];
	const opener = async (pdfPath: string) => {
		openedPaths.push(pdfPath);
		return {
			pid: 9876,
			viewerHandle: "viewer-service-handle",
			viewerBackend: "viewer-service-backend",
			viewerOwned: true,
			viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
		};
	};
	const first = await openAndTrackPdf(pdf, tracker, undefined, opener);
	const second = await openAndTrackPdf(link, tracker, undefined, opener);

	assert.equal(second.id, first.id);
	assert.equal(openedPaths.length, 0);
	assert.deepEqual(tracker.getAllByPath(realPdf).map((entry) => entry.id), [first.id]);
});

test("openAndTrackPdf requires a viewer-service opener", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);
	const tracker = new PdfTracker();

	await assert.rejects(
		() => openAndTrackPdf(pdf, tracker),
		/openAndTrackPdf requires a viewer-service opener\. Direct Zathura opening is not supported in this flow\./,
	);
});

test("openAndTrackPdf shares concurrent opens for the same PDF", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	let openCalls = 0;
	const opener = async () => {
		openCalls += 1;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return {
			pid: 4321,
			viewerHandle: "viewer-service-open",
			viewerBackend: "zathura",
			viewerOwned: true,
			viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
		};
	};
	const [first, second] = await Promise.all([
		openAndTrackPdf(pdf, tracker, undefined, opener),
		openAndTrackPdf(pdf, tracker, undefined, opener),
	]);

	assert.equal(second, first);
	assert.equal(openCalls, 1);
	assert.deepEqual(tracker.getAllByPath(realpathSync(pdf)).map((entry) => entry.id), [first.id]);
});

test("openAndTrackPdf reopens a stale tracked PDF using the existing ID", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	const stale = tracker.trackOpenedPdf(realpathSync(pdf), undefined, 987654321);
	let openCalls = 0;
	const reopened = await openAndTrackPdf(pdf, tracker, undefined, async () => {
		openCalls += 1;
		return {
			pid: 1234,
			viewerHandle: "zathura:open:recovered",
			viewerBackend: "zathura",
			viewerOwned: true,
			viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
		};
	});

	assert.equal(reopened.id, stale.id);
	assert.equal(reopened.pid, 1234);
	assert.equal(reopened.viewerHandle, "zathura:open:recovered");
	assert.equal(openCalls, 1);
	assert.deepEqual(tracker.getAllByPath(realpathSync(pdf)).map((entry) => entry.id), [stale.id]);
});

test("openAndTrackPdf does not track when opening fails", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	await assert.rejects(
		() => openAndTrackPdf(pdf, tracker, undefined, async () => {
			throw new Error("no display");
		}),
		/no display/,
	);

	assert.equal(tracker.getByPath(realpathSync(pdf)), undefined);
});


test("jump failure context includes service metadata", () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", "/tmp/paper.tex", 1234, undefined, {
		viewerHandle: "viewer-handle-1",
		viewerBackend: "viewer-service",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});

	const context = describePdfJumpFailureContext(trackedPdf.id, tracker);
	assert.equal(context.includes("viewer_handle=viewer-handle-1"), true);
	assert.equal(context.includes("viewer_backend=viewer-service"), true);
	assert.equal(context.includes("viewer_owned=true"), true);
	assert.equal(context.includes("tracked_pid=1234"), true);
});

test("jumpToTrackedPdf performs a service forward-search jump using the tracked default source", async () => {
	const pdf = join(tempDir(), "paper.pdf");
	const source = join(tempDir(), "paper.tex");
	const fakeCalls: string[] = [];
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 111);
	trackedPdf.viewerHandle = "zathura:open:service";
	trackedPdf.viewerBackend = "zathura";
	trackedPdf.viewerOwned = true;
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	const result = await jumpToTrackedPdf(trackedPdf.id, 42, undefined, tracker, undefined, {
		requestForwardSearch: async (viewerHandle, viewerBackend, sourceFile, line, synctexPid) => {
			fakeCalls.push(`${viewerHandle}|${viewerBackend}|${sourceFile}|${line}|${synctexPid ?? ""}`);
			return { handled: true };
		},
	});

	assert.deepEqual(fakeCalls, ["zathura:open:service|zathura|" + source + "|42|111"]);
	assert.deepEqual(result, { pdf, sourceFile: source, line: 42, reopened: false });
});

test("jumpToTrackedPdf asks for source_file when no default source is known", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");

	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 1, undefined, tracker),
		/No default source_file is known.*Pass source_file explicitly/,
	);
});

test("jumpToTrackedPdf requires viewer-service metadata", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, undefined, "zathura --synctex-editor-command=unused");
	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 12, undefined, tracker),
		/viewer service is required to jump PDFs|viewer service.*required/i,
	);
});

test("jumpToTrackedPdf rejects non-positive line numbers", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);

	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 0, undefined, tracker),
		/line must be a positive integer/,
	);
});

test("jumpToTrackedPdf errors when service metadata lacks a forward-search handler", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);
	trackedPdf.viewerHandle = "zathura:open:service";
	trackedPdf.viewerBackend = "zathura";
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 9, undefined, tracker),
		/no forward-search handler is configured/,
	);
});

test("jumpToTrackedPdf uses viewer service forward_search when service metadata is present", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const fakeCalls: string[] = [];
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 111);
	trackedPdf.viewerHandle = "zathura:open:service";
	trackedPdf.viewerBackend = "zathura";
	trackedPdf.viewerOwned = true;
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	const result = await jumpToTrackedPdf(trackedPdf.id, 12, undefined, tracker, undefined, {
		requestForwardSearch: async (viewerHandle, viewerBackend, sourceFile, line, synctexPid) => {
			fakeCalls.push(`${viewerHandle}|${viewerBackend}|${sourceFile}|${line}|${synctexPid ?? ""}`);
			return { handled: true };
		},
	});

	assert.deepEqual(fakeCalls, [`zathura:open:service|zathura|${source}|12|111`]);
	assert.deepEqual(result, { pdf, sourceFile: source, line: 12, reopened: false });
});

test("jumpToTrackedPdf rejects non-regular source files in service jumps", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const sourceDirectory = join(dir, "src-dir");
	writeMinimalPdf(pdf);
	mkdirSync(sourceDirectory, { recursive: true });

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, sourceDirectory);
	trackedPdf.viewerHandle = "zathura:open:service";
	trackedPdf.viewerBackend = "zathura";
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	await assert.rejects(
		() => jumpToTrackedPdf(
			trackedPdf.id,
			5,
			sourceDirectory,
			tracker,
			undefined,
			{
				requestForwardSearch: async () => ({ handled: true }),
			},
		),
		/source_file .*regular file/,
	);
});

test("jumpToTrackedPdf rejects a service handle without forward_search capability", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 111);
	trackedPdf.viewerHandle = "zathura:open:service";
	trackedPdf.viewerBackend = "zathura";
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: false,
		inverse_search: true,
		reuse: true,
	};

	await assert.rejects(
		() => jumpToTrackedPdf(
			trackedPdf.id,
			8,
			undefined,
			tracker,
			undefined,
			{
				requestForwardSearch: async () => ({ handled: true }),
		},
		),
		/not.*forward_search.*capable/,
	);
});

test("jumpToTrackedPdf retries stale service handles once", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	let forwardCalls = 0;
	let openerCalls = 0;
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 111);
	trackedPdf.viewerHandle = "zathura:open:stale";
	trackedPdf.viewerBackend = "zathura";
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	const result = await jumpToTrackedPdf(
		trackedPdf.id,
		21,
		undefined,
		tracker,
		undefined,
		{
			requestForwardSearch: async (_viewerHandle, _viewerBackend, _sourceFile, _line, _synctexPid) => {
				forwardCalls += 1;
				if (forwardCalls === 1) {
					throw new Error("viewer handle not recognized (code=handle_not_found)");
				}
				return { handled: true };
			},
			opener: async () => {
				openerCalls += 1;
				return {
					pid: 2222,
					viewerHandle: "zathura:open:recovered",
					viewerBackend: "zathura",
					viewerOwned: true,
					viewerCapabilities: {
						open: true,
						close: true,
						forward_search: true,
						inverse_search: true,
						reuse: true,
					},
				};
			},
		},
	);

	assert.equal(forwardCalls, 2);
	assert.equal(openerCalls, 1);
	assert.equal(result.reopened, true);
	assert.equal(tracker.getById(trackedPdf.id)?.viewerHandle, "zathura:open:recovered");
});

test("jumpToTrackedPdf does not retry service stale handles for non-retriable errors", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	let openerCalls = 0;
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 111);
	trackedPdf.viewerHandle = "zathura:open:service";
	trackedPdf.viewerBackend = "zathura";
	trackedPdf.viewerCapabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};

	await assert.rejects(
		() => jumpToTrackedPdf(
			trackedPdf.id,
			21,
			undefined,
			tracker,
			undefined,
			{
				requestForwardSearch: async () => {
					throw new Error("viewer backend is unavailable (code=backend_unavailable)");
				},
				opener: async () => {
					openerCalls += 1;
					return {
						pid: 2222,
						viewerHandle: "zathura:open:recover",
						viewerBackend: "zathura",
						viewerOwned: true,
						viewerCapabilities: {
							open: true,
							close: true,
							forward_search: true,
							inverse_search: true,
							reuse: true,
						},
					};
				},
			},
		),
		/backend_unavailable/,
	);
	assert.equal(openerCalls, 0);
});




test("closeTrackedPdf closes and removes a tracked PDF", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, undefined, undefined, {
		viewerHandle: "zathura:open-service",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const result = await closeTrackedPdf(trackedPdf.id, tracker, {
		requestClose: async () => ({ closed: true }),
	});

	assert.deepEqual(result, {
		pdf: "/tmp/paper.pdf",
		pdfId: trackedPdf.id,
		closed: true,
		closedPids: [],
		wasTracked: true,
	});
	assert.equal(tracker.getById(trackedPdf.id), undefined);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), undefined);
});

test("closeTrackedPdf closes only the tracked PDF when multiple windows share a PDF path", async () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 101, undefined, {
		viewerHandle: "zathura:open-first",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const second = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 202, undefined, {
		viewerHandle: "zathura:open-second",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const result = await closeTrackedPdf(first.id, tracker, {
		requestClose: async (viewerHandle, viewerBackend) => {
			assert.equal(viewerHandle, "zathura:open-first");
			assert.equal(viewerBackend, "zathura");
			return { closed: true };
		},
	});

	assert.deepEqual(result, {
		pdf: "/tmp/paper.pdf",
		pdfId: first.id,
		closed: true,
		closedPids: [],
		wasTracked: true,
	});
	assert.equal(tracker.getById(first.id), undefined);
	assert.equal(tracker.getById(second.id), second);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), second);
});

test("closeTrackedPdf requires viewer service metadata", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");
	await assert.rejects(
		() => closeTrackedPdf(trackedPdf.id, tracker),
		/viewer service is required to close this PDF|viewer service.*required/i,
	);
});

test("closeTrackedPdf closes service-owned PDFs via viewer service", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 1234, undefined, {
		viewerHandle: "zathura:open-service",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	let requestedHandle: string | undefined;
	let requestedBackend: string | undefined;
	const result = await closeTrackedPdf(trackedPdf.id, tracker, {
		requestClose: async (handle, backend) => {
			requestedHandle = handle;
			requestedBackend = backend;
			return { closed: true };
		},
	});

	assert.equal(requestedHandle, "zathura:open-service");
	assert.equal(requestedBackend, "zathura");
	assert.deepEqual(result, {
		pdf: "/tmp/paper.pdf",
		pdfId: trackedPdf.id,
		closed: true,
		closedPids: [],
		wasTracked: true,
	});
	assert.equal(tracker.getById(trackedPdf.id), undefined);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), undefined);
});

test("closeTrackedPdf returns no-op when service reports an unowned handle", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 1234, undefined, {
		viewerHandle: "zathura:open-shared",
		viewerBackend: "zathura",
		viewerOwned: false,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	let requestedHandle: string | undefined;
	let requestedBackend: string | undefined;
	const result = await closeTrackedPdf(trackedPdf.id, tracker, {
		requestClose: async (handle, backend) => {
			requestedHandle = handle;
			requestedBackend = backend;
			return { closed: false, reason: "not_service_owned" };
		},
	});

	assert.equal(requestedHandle, "zathura:open-shared");
	assert.equal(requestedBackend, "zathura");
	assert.deepEqual(result, {
		pdf: "/tmp/paper.pdf",
		pdfId: trackedPdf.id,
		closed: false,
		closedPids: [],
		wasTracked: true,
		reason: "not_service_owned",
	});
	assert.equal(tracker.getById(trackedPdf.id), undefined);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), undefined);
});

test("closeTrackedPdf forwards abort signal to viewer close request", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 1234, undefined, {
		viewerHandle: "zathura:open-service",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const controller = new AbortController();
	let receivedSignal: AbortSignal | undefined;
	const result = await closeTrackedPdf(
		trackedPdf.id,
		tracker,
		{
			requestClose: async (handle, backend, signal) => {
				receivedSignal = signal;
				assert.equal(handle, "zathura:open-service");
				assert.equal(backend, "zathura");
				return { closed: true };
			},
		},
		controller.signal,
	);

	assert.equal(receivedSignal, controller.signal);
	assert.deepEqual(result, {
		pdf: "/tmp/paper.pdf",
		pdfId: trackedPdf.id,
		closed: true,
		closedPids: [],
		wasTracked: true,
	});
	assert.equal(tracker.getById(trackedPdf.id), undefined);
});

test("closeTrackedPdf surfaces service unknown-handle failures", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 1234, undefined, {
		viewerHandle: "zathura:missing",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});

	await assert.rejects(
		() => closeTrackedPdf(trackedPdf.id, tracker, {
			requestClose: async () => {
				throw new Error("viewer handle not recognized (code=unknown_handle)");
			},
		}),
		/unknown_handle/,
	);
	assert.equal(tracker.getById(trackedPdf.id), trackedPdf);
});

test("closeTrackedPdf surfaces service backend failures", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 1234, undefined, {
		viewerHandle: "zathura:backend-fail",
		viewerBackend: "zathura",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});

	await assert.rejects(
		() => closeTrackedPdf(trackedPdf.id, tracker, {
			requestClose: async () => {
				throw new Error("viewer backend unavailable (code=backend_unavailable)");
			},
		}),
		/backend_unavailable/,
	);
	assert.equal(tracker.getById(trackedPdf.id), trackedPdf);
});

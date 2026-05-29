import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { gzipSync } from "node:zlib";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReadablePdfFile,
	closePdfInZathura,
	closeTrackedPdf,
	describePdfJumpFailureContext,
	inferDefaultSourceFileForPdf,
	jumpToTrackedPdf,
	normalizePdfFilePath,
	openAndTrackPdf,
	openPdfInZathura,
	PdfTracker,
	processArgsMatchZathuraPdf,
	zathuraPidsForPdf,
} from "./pdf_tracking.ts";

process.env.PDF_PREVIEW_ZATHURA_LEGACY = "1";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pdf-tracking-test-"));
}

function writeMinimalPdf(path: string): void {
	writeFileSync(path, "%PDF-1.7\n% test\n%%EOF\n");
}

function activeChildProcessHandles(): number {
	const getActiveHandles = (process as typeof process & { _getActiveHandles: () => Array<{ constructor?: { name?: string } }> })._getActiveHandles;
	return getActiveHandles().filter((handle: { constructor?: { name?: string } }) => handle.constructor?.name === "ChildProcess").length;
}

async function waitForProcessArgs(pid: number, needle: string, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle)) return;
		} catch {
			// Retry until the process exits or /proc catches up.
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`process ${pid} did not expose expected args`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
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

test("processArgsMatchZathuraPdf recognizes zathura processes for a PDF", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const otherPdf = join(dir, "other.pdf");
	writeMinimalPdf(pdf);
	writeMinimalPdf(otherPdf);
	const normalizedPdf = realpathSync(pdf);

	assert.equal(processArgsMatchZathuraPdf(["/usr/bin/zathura", "--fork", pdf], normalizedPdf), true);
	assert.equal(processArgsMatchZathuraPdf(["/usr/bin/zathura", otherPdf], normalizedPdf), false);
	assert.equal(processArgsMatchZathuraPdf(["/usr/bin/evince", pdf], normalizedPdf), false);
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
	});

	const realPdfPath = realpathSync(pdf);
	assert.deepEqual(openedPaths, [realPdfPath]);
	assert.equal(trackedPdf.id, 1);
	assert.equal(trackedPdf.path, realPdfPath);
	assert.equal(trackedPdf.sourceFile, source);
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
	const trackedPdf = await openAndTrackPdf(pdf, tracker, undefined, async () => {}, source);

	assert.equal(trackedPdf.sourceFile, source);
});

test("openAndTrackPdf stores a zathura PID returned by the opener", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	const trackedPdf = await openAndTrackPdf(pdf, tracker, undefined, async () => 4321);

	assert.equal(trackedPdf.pid, 4321);
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
	assert.deepEqual(trackedPdf.viewerCapabilities, { open: true, close: true, forward_search: true, inverse_search: true, reuse: true });
});

test("openAndTrackPdf reuses an existing tracked PDF for the same normalized path", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
	symlinkSync(pdf, link);

	const tracker = new PdfTracker();
	const openedPaths: string[] = [];
	const opener = async (pdfPath: string) => {
		openedPaths.push(pdfPath);
	};
	const first = await openAndTrackPdf(pdf, tracker, undefined, opener);
	const second = await openAndTrackPdf(link, tracker, undefined, opener);

	assert.equal(second, first);
	assert.equal(second.id, first.id);
	assert.deepEqual(openedPaths, [realpathSync(pdf)]);
	assert.deepEqual(tracker.getAllByPath(realpathSync(pdf)).map((entry) => entry.id), [first.id]);
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
		return 1234;
	});

	assert.equal(reopened.id, stale.id);
	assert.equal(reopened.pid, 1234);
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

test("direct Zathura helpers require legacy adapter mode", async () => {
	const previousMode = process.env.PDF_PREVIEW_ZATHURA_LEGACY;
	process.env.PDF_PREVIEW_ZATHURA_LEGACY = "0";
	try {
		assert.throws(
			() => zathuraPidsForPdf("/tmp/paper.pdf"),
			/Default preview flow does not use direct Zathura control for process discovery/,
		);
		await assert.rejects(
			() => openPdfInZathura("/tmp/paper.pdf"),
			/Default preview flow does not use direct Zathura control for open/,
		);
		assert.throws(
			() => closePdfInZathura("/tmp/paper.pdf", { findPids: () => [] }),
			/Default preview flow does not use direct Zathura control for close/,
		);
	} finally {
		if (previousMode === undefined) {
			delete process.env.PDF_PREVIEW_ZATHURA_LEGACY;
		} else {
			process.env.PDF_PREVIEW_ZATHURA_LEGACY = previousMode;
		}
	}
});

test("jump failure context omits process discovery outside legacy adapter mode", () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf", "/tmp/paper.tex", 1234, undefined, {
		viewerHandle: "viewer-handle-1",
		viewerBackend: "viewer-service",
		viewerOwned: true,
		viewerCapabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const previousMode = process.env.PDF_PREVIEW_ZATHURA_LEGACY;
	process.env.PDF_PREVIEW_ZATHURA_LEGACY = "0";
	try {
		const context = describePdfJumpFailureContext(trackedPdf.id, tracker);
		assert.equal(context.includes("viewer_handle=viewer-handle-1"), true);
		assert.equal(context.includes("viewer_backend=viewer-service"), true);
		assert.equal(context.includes("process_snapshot"), false);
		assert.equal(context.includes("tracked_pid_args"), false);
	} finally {
		if (previousMode === undefined) {
			delete process.env.PDF_PREVIEW_ZATHURA_LEGACY;
		} else {
			process.env.PDF_PREVIEW_ZATHURA_LEGACY = previousMode;
		}
	}
});

test("openAndTrackPdf rejects direct-open path when legacy adapter is disabled", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	const previousMode = process.env.PDF_PREVIEW_ZATHURA_LEGACY;
	process.env.PDF_PREVIEW_ZATHURA_LEGACY = "0";
	try {
		await assert.rejects(
			() => openAndTrackPdf(pdf, tracker),
			/Default preview flow does not use direct Zathura control for open and track/,
		);
	} finally {
		if (previousMode === undefined) {
			delete process.env.PDF_PREVIEW_ZATHURA_LEGACY;
		} else {
			process.env.PDF_PREVIEW_ZATHURA_LEGACY = previousMode;
		}
	}
});

test("jumpToTrackedPdf performs a line-based SyncTeX jump using the tracked default source", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);
	const result = await jumpToTrackedPdf(trackedPdf.id, 42, undefined, tracker, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--synctex-forward", `42:1:${source}`, pdf]);
	assert.deepEqual(result, { pdf, sourceFile: source, line: 42, reopened: false });
});

test("jumpToTrackedPdf targets the tracked zathura PID when known", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 4242);
	await jumpToTrackedPdf(trackedPdf.id, 12, undefined, tracker, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--synctex-forward", `12:1:${source}`, "--synctex-pid=4242", pdf]);
});

test("jumpToTrackedPdf asks for source_file when no default source is known", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");

	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 1, undefined, tracker),
		/No default source_file is known.*Pass source_file explicitly/,
	);
});

test("jumpToTrackedPdf refuses direct reopen when legacy adapter is disabled", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, undefined, "zathura --synctex-editor-command=unused");
	const previousMode = process.env.PDF_PREVIEW_ZATHURA_LEGACY;
	process.env.PDF_PREVIEW_ZATHURA_LEGACY = "0";
	try {
		await assert.rejects(
			() => jumpToTrackedPdf(trackedPdf.id, 12, undefined, tracker),
			/Default preview flow does not use direct Zathura control for jump/,
		);
	} finally {
		if (previousMode === undefined) {
			delete process.env.PDF_PREVIEW_ZATHURA_LEGACY;
		} else {
			process.env.PDF_PREVIEW_ZATHURA_LEGACY = previousMode;
		}
	}
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


test("jumpToTrackedPdf reopens a tracked PDF and retries when the first jump fails", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const callsFile = join(dir, "calls.txt");
	const markerFile = join(dir, "failed-once");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(callsFile)}\nprintf '\\n' >> ${JSON.stringify(callsFile)}\nif [ "$1" = "--synctex-forward" ] && [ ! -e ${JSON.stringify(markerFile)} ]; then\n  touch ${JSON.stringify(markerFile)}\n  echo 'no window' >&2\n  exit 9\nfi\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);
	const result = await jumpToTrackedPdf(trackedPdf.id, 7, undefined, tracker, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.equal(result.reopened, true);
	assert.deepEqual(readFileSync(callsFile, "utf8").trim().split("\n"), [
		`--synctex-forward|7:1:${source}|${pdf}|`,
		`--fork|${pdf}|`,
		`--synctex-forward|7:1:${source}|${pdf}|`,
	]);
});

test("jumpToTrackedPdf does not launch an unpinned fallback when the reopened PID already exited", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const callsFile = join(dir, "calls.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(callsFile)}\nprintf '\\n' >> ${JSON.stringify(callsFile)}\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, undefined, "current callback command");
	let reopenCalls = 0;
	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 15, undefined, tracker, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			synctexEditorCommand: "current callback command",
			opener: async () => {
				reopenCalls += 1;
				return 987654321;
			},
		}),
		/reopened as pid=987654321, but that process exited before the SyncTeX jump/,
	);

	assert.equal(reopenCalls, 1);
	assert.equal(existsSync(callsFile), false);
});

test("jumpToTrackedPdf falls back to an unpinned jump when callback PID cannot be identified after reopen", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const callsFile = join(dir, "calls.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(callsFile)}\nprintf '\\n' >> ${JSON.stringify(callsFile)}\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, undefined, "old callback command");
	let reopenCalls = 0;
	const result = await jumpToTrackedPdf(trackedPdf.id, 15, undefined, tracker, undefined, {
		command: fakeZathura,
		timeoutMs: 1000,
		synctexEditorCommand: "current callback command",
		opener: async () => {
			reopenCalls += 1;
			return undefined;
		},
	});

	assert.equal(reopenCalls, 1);
	assert.deepEqual(readFileSync(callsFile, "utf8").trim().split("\n"), [
		`--synctex-forward|15:1:${source}|${pdf}|`,
	]);
	assert.deepEqual(result, { pdf, sourceFile: source, line: 15, reopened: true });
	assert.equal(tracker.getById(trackedPdf.id)?.synctexEditorCommand, "current callback command");
});

test("jumpToTrackedPdf reports a clear error when reopening fails", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, "#!/bin/sh\necho 'jump failed' >&2\nexit 8\n");
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);
	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 9, undefined, tracker, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			opener: async () => {
				throw new Error("cannot reopen");
			},
		}),
		/appears closed or unavailable.*could not be reopened.*cannot reopen/,
	);
});

test("openPdfInZathura launches zathura with --fork and the PDF path", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--fork", pdf]);
});

test("openPdfInZathura can reuse an existing zathura when requested", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, {
		command: fakeZathura,
		timeoutMs: 1000,
		isAlreadyOpen: () => true,
		reuseExisting: true,
	});

	assert.equal(existsSync(argsFile), false);
});

test("openPdfInZathura returns after zathura --fork parent exits even if viewer keeps stdio open", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n(sleep 0.25) &\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 50 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--fork", pdf]);
});

test("openPdfInZathura returns after detecting a persistent viewer even if zathura stays foreground", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/bash\nexec -a zathura bash -c 'while true; do sleep 30; done' dummy "$@"\n`);
	chmodSync(fakeZathura, 0o700);

	const pid = await openPdfInZathura(pdf, undefined, {
		command: fakeZathura,
		timeoutMs: 1500,
		requirePersistentViewer: true,
	});
	try {
		assert.equal(typeof pid, "number");
		assert.ok(pid! > 0);
	} finally {
		process.kill(pid!, "SIGTERM");
	}
});

test("openPdfInZathura prefers the forked zathura child over the --fork launcher pid", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const launcherPidFile = join(dir, "launcher.pid");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/bash\necho "$$" > ${JSON.stringify(launcherPidFile)}\nnohup bash -c 'exec -a zathura bash -c "while true; do sleep 30; done" dummy --fork "$2"' _ "$1" "$2" >/dev/null 2>&1 < /dev/null &\nsleep 0.05\n`);
	chmodSync(fakeZathura, 0o700);

	let pid: number | undefined;
	try {
		pid = await openPdfInZathura(pdf, undefined, {
			command: fakeZathura,
			timeoutMs: 1500,
			requirePersistentViewer: true,
		});
		assert.equal(typeof pid, "number");
		assert.ok(pid! > 0);

		let launcherPidText = "";
		for (let i = 0; i < 50; i += 1) {
			try {
				launcherPidText = readFileSync(launcherPidFile, "utf8").trim();
				if (launcherPidText) break;
			} catch {
				// Retry until the launcher writes the file.
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(launcherPidText, "did not capture fake launcher PID");
		const launcherPid = Number(launcherPidText);
		assert.ok(Number.isFinite(launcherPid));
		assert.notEqual(pid, launcherPid);
		await waitForProcessArgs(pid!, pdf);
	} finally {
		if (pid !== undefined) {
			process.kill(pid, "SIGTERM");
		}
		try {
			const launcherPid = Number(readFileSync(launcherPidFile, "utf8").trim());
			if (Number.isFinite(launcherPid) && launcherPid !== pid) {
				process.kill(launcherPid, "SIGKILL");
			}
		} catch {
			// Ignore cleanup failures.
		}
	}
});

test("openPdfInZathura wires an inverse SyncTeX editor command when provided", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	const synctexCommand = "node callback.mjs --file '%{input}' --line '%{line}'";
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, {
		command: fakeZathura,
		timeoutMs: 1000,
		synctexEditorCommand: synctexCommand,
	});

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
		`--synctex-editor-command=${synctexCommand}`,
		"--fork",
		pdf,
	]);
});

test("openPdfInZathura does not reuse an existing viewer that lacks the current SyncTeX command", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	const synctexCommand = "node callback.mjs --file '%{input}' --line '%{line}'";
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const staleViewer = spawn("bash", ["-c", "exec -a zathura bash -c 'while true; do sleep 30; done' dummy --fork \"$1\"", "bash", pdf], {
		stdio: "ignore",
	});
	try {
		await waitForProcessArgs(staleViewer.pid!, pdf);

		await openPdfInZathura(pdf, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			synctexEditorCommand: synctexCommand,
			reuseExisting: true,
		});

		assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
			`--synctex-editor-command=${synctexCommand}`,
			"--fork",
			pdf,
		]);
	} finally {
		await stopProcess(staleViewer);
	}
});

test("openPdfInZathura reuses an existing viewer that already has the current SyncTeX command", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	const synctexCommand = "node callback.mjs --file '%{input}' --line '%{line}'";
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const currentViewer = spawn("bash", [
		"-c",
		"exec -a zathura bash -c 'while true; do sleep 30; done' dummy \"--synctex-editor-command=$2\" --fork \"$1\"",
		"bash",
		pdf,
		synctexCommand,
	], { stdio: "ignore" });
	try {
		await waitForProcessArgs(currentViewer.pid!, synctexCommand);

		const reusedPid = await openPdfInZathura(pdf, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			synctexEditorCommand: synctexCommand,
			reuseExisting: true,
		});

		assert.equal(reusedPid, currentViewer.pid);
		assert.equal(existsSync(argsFile), false);
	} finally {
		await stopProcess(currentViewer);
	}
});

test("openPdfInZathura reports when a required persistent viewer exits immediately", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, "#!/bin/sh\nexit 0\n");
	chmodSync(fakeZathura, 0o700);

	await assert.rejects(
		() => openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000, requirePersistentViewer: true }),
		/zathura exited before a persistent viewer was available/,
	);
});

test("openPdfInZathura surfaces zathura launch failures", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, "#!/bin/sh\necho 'no display' >&2\nexit 7\n");
	chmodSync(fakeZathura, 0o700);

	await assert.rejects(
		() => openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000 }),
		/zathura failed to open .*exited 7[\s\S]*no display/,
	);
});

test("openPdfInZathura does not leave a live child handle after the launch settles", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\n(sleep 30) &\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const before = activeChildProcessHandles();
	await openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000 });
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(activeChildProcessHandles(), before);
});

test("closePdfInZathura sends SIGTERM to matching zathura processes", () => {
	const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const closedPids = closePdfInZathura("/tmp/paper.pdf", {
		findPids: () => [101, 202],
		killProcess: (pid, signal) => killed.push({ pid, signal }),
	});

	assert.deepEqual(closedPids, [101, 202]);
	assert.deepEqual(killed, [
		{ pid: 101, signal: "SIGTERM" },
		{ pid: 202, signal: "SIGTERM" },
	]);
});

test("closeTrackedPdf closes and removes a tracked PDF", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");
	const result = await closeTrackedPdf(trackedPdf.id, tracker, {
		findPids: () => [303],
		killProcess: () => {},
	});

	assert.deepEqual(result, {
		pdf: "/tmp/paper.pdf",
		pdfId: trackedPdf.id,
		closed: true,
		closedPids: [303],
		wasTracked: true,
	});
	assert.equal(tracker.getById(trackedPdf.id), undefined);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), undefined);
});

test("closeTrackedPdf closes only the tracked PID when multiple windows share a PDF path", async () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 101);
	const second = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 202);
	const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const result = await closeTrackedPdf(first.id, tracker, {
		findPids: () => [101, 202],
		killProcess: (pid, signal) => killed.push({ pid, signal }),
	});

	assert.deepEqual(result, {
		pdf: "/tmp/paper.pdf",
		pdfId: first.id,
		closed: true,
		closedPids: [101],
		wasTracked: true,
	});
	assert.deepEqual(killed, [{ pid: 101, signal: "SIGTERM" }]);
	assert.equal(tracker.getById(first.id), undefined);
	assert.equal(tracker.getById(second.id), second);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), second);
});

test("closeTrackedPdf refuses direct close when legacy adapter is disabled", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");
	const previousMode = process.env.PDF_PREVIEW_ZATHURA_LEGACY;
	process.env.PDF_PREVIEW_ZATHURA_LEGACY = "0";
	try {
		await assert.rejects(
			() => closeTrackedPdf(trackedPdf.id, tracker, {
				findPids: () => [303],
				killProcess: () => {},
			}),
			/Default preview flow does not use direct Zathura control for close/,
		);
	} finally {
		if (previousMode === undefined) {
			delete process.env.PDF_PREVIEW_ZATHURA_LEGACY;
		} else {
			process.env.PDF_PREVIEW_ZATHURA_LEGACY = previousMode;
		}
	}
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

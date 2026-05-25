import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReadablePdfFile,
	inferDefaultSourceFileForPdf,
	jumpToTrackedPdf,
	normalizePdfFilePath,
	openAndTrackPdf,
	openPdfInZathura,
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

test("PdfTracker assigns short session-local IDs and reuses the same path ID", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	const repeated = tracker.trackOpenedPdf("/tmp/one.pdf");
	const second = tracker.trackOpenedPdf("/tmp/two.pdf");

	assert.equal(first.id, 1);
	assert.equal(repeated.id, first.id);
	assert.equal(second.id, 2);
	assert.equal(tracker.getById(first.id)?.path, "/tmp/one.pdf");
	assert.equal(tracker.getByPath("/tmp/two.pdf")?.id, second.id);
});

test("PdfTracker stores and updates tracked default source files", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	assert.equal(first.sourceFile, undefined);

	const repeated = tracker.trackOpenedPdf("/tmp/one.pdf", "/tmp/main.tex");
	assert.equal(repeated.id, first.id);
	assert.equal(repeated.sourceFile, "/tmp/main.tex");
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

test("jumpToTrackedPdf asks for source_file when no default source is known", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");

	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 1, undefined, tracker),
		/No default source_file is known.*Pass source_file explicitly/,
	);
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

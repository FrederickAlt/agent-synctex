import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReadablePdfFile,
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

test("openAndTrackPdf normalizes, opens, and tracks a PDF", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
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
	assert.equal(tracker.getByPath(realPdfPath), trackedPdf);
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

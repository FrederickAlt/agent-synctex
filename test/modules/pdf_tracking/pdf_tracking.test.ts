import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReadablePdfFile,
	assertReadableSourceFile,
	inferDefaultSourceFileForPdf,
} from "../../../src/modules/pdf_tracking/pdf_tracking.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pdf-tracking-test-"));
}

function writeMinimalPdf(path: string): void {
	writeFileSync(path, "%PDF-1.7\n% test\n%%EOF\n");
}

test("assertReadablePdfFile accepts a readable PDF file", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	assert.doesNotThrow(() => assertReadablePdfFile(pdf));
});

test("assertReadablePdfFile rejects missing, directory, and non-PDF paths clearly", () => {
	const dir = tempDir();
	assert.throws(() => assertReadablePdfFile(join(dir, "missing.pdf")), /Cannot stat PDF file/);
	assert.throws(() => assertReadablePdfFile(dir), /regular file/);

	const textFile = join(dir, "not-a-pdf.pdf");
	writeFileSync(textFile, "not a pdf");
	assert.throws(() => assertReadablePdfFile(textFile), /must point to a PDF file/);
});

test("assertReadableSourceFile accepts a readable current-user regular file", () => {
	const dir = tempDir();
	const source = join(dir, "main.tex");
	writeFileSync(source, "\\documentclass{article}\n");

	assert.doesNotThrow(() => assertReadableSourceFile(source));
});

test("assertReadableSourceFile rejects missing, directory, and symlink paths clearly", () => {
	const dir = tempDir();
	assert.throws(() => assertReadableSourceFile(join(dir, "missing.tex")), /Cannot stat source_file/);
	assert.throws(() => assertReadableSourceFile(dir), /regular file/);

	const source = join(dir, "main.tex");
	const link = join(dir, "main-link.tex");
	writeFileSync(source, "\\documentclass{article}\n");
	symlinkSync(source, link);
	assert.throws(() => assertReadableSourceFile(link), /must not be a symlink/);
});

test("inferDefaultSourceFileForPdf prefers a readable same-basename source", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(join(dir, "paper.synctex"), "Input:1:main.tex\n");
	writeFileSync(join(dir, "main.tex"), "alternate source\n");

	assert.equal(inferDefaultSourceFileForPdf(pdf), source);
});

test("inferDefaultSourceFileForPdf uses unique SyncTeX input records when basename source is absent", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "main.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(join(dir, "paper.synctex"), "SyncTeX Version:1\nInput:1:main.tex\n");

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
	writeFileSync(join(dir, "paper.synctex.gz"), gzipSync("Input:1:main.tex\nInput:2:chapter.tex\n"));

	assert.equal(inferDefaultSourceFileForPdf(pdf), undefined);
});

test("inferDefaultSourceFileForPdf chooses a unique basename match among multiple SyncTeX inputs", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const sourceDir = join(dir, "src");
	mkdirSync(sourceDir);
	const source = join(sourceDir, "paper.tex");
	const chapter = join(sourceDir, "chapter.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(chapter, "chapter\n");
	writeFileSync(join(dir, "paper.synctex"), `Input:1:${source}\nInput:2:${chapter}\n`);

	assert.equal(inferDefaultSourceFileForPdf(pdf), source);
});

test("inferDefaultSourceFileForPdf ignores unreadable or non-tex SyncTeX inputs", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);
	mkdirSync(join(dir, "not-a-source.tex"));
	writeFileSync(join(dir, "paper.synctex"), "Input:1:missing.tex\nInput:2:not-a-source.tex\nInput:3:notes.txt\n");

	assert.equal(inferDefaultSourceFileForPdf(pdf), undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateInlineDisplayColumns, mergeInlinePreviewArtifacts, rasterizePdfPage, rasterizePdfPages } from "./inline_preview.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function createMiniPng(width: number, height: number): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdrLength = Buffer.alloc(4);
	ihdrLength.writeUInt32BE(13, 0);
	const ihdrType = Buffer.from("IHDR");
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	ihdrData[8] = 8;
	ihdrData[9] = 6;
	ihdrData[10] = 0;
	ihdrData[11] = 0;
	ihdrData[12] = 0;
	const ihdrCrc = Buffer.alloc(4);
	const iendLength = Buffer.alloc(4);
	const iendType = Buffer.from("IEND");
	const iendCrc = Buffer.alloc(4);
	return Buffer.concat([signature, ihdrLength, ihdrType, ihdrData, ihdrCrc, iendLength, iendType, iendCrc]);
}

function writeExecutable(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`);
	chmodSync(path, 0o700);
}

async function withPath<T>(path: string, run: () => Promise<T>): Promise<T> {
	const previousPath = process.env.PATH;
	process.env.PATH = path;
	try {
		return await run();
	} finally {
		process.env.PATH = previousPath;
	}
}

const nodeBinary = process.execPath;

function pngWriterForMutool(pngBase64: string): string {
	return `"${nodeBinary}" - "$@" <<'NODE'\nconst fs = require(\"node:fs\");\nconst args = process.argv.slice(2);\nconst outIndex = args.indexOf(\"-o\");\nif (outIndex < 0 || !args[outIndex + 1]) process.exit(1);\nfs.writeFileSync(args[outIndex + 1], Buffer.from(\"${pngBase64}\", \"base64\"));\nNODE`;
}

function pngWriterForPdftoppm(pngBase64: string): string {
	return `"${nodeBinary}" - "$@" <<'NODE'\nconst fs = require(\"node:fs\");\nconst args = process.argv.slice(2);\nconst outPrefix = args.at(-1);\nif (!outPrefix) process.exit(1);\nfs.writeFileSync(outPrefix + \".png\", Buffer.from(\"${pngBase64}\", \"base64\"));\nNODE`;
}

function writePdfInfoCommand(path: string, output: string): void {
	writeExecutable(path, `printf '%s\\n' \"${output}\"`);
}

function writeMagickTrim(path: string, pngBase64: string): void {
	writeExecutable(path, `"${nodeBinary}" - "$@" <<'NODE'\nconst fs = require(\"node:fs\");\nconst args = process.argv.slice(2);\nconst positional = args.filter((arg) => !arg.startsWith(\"-\"));\nconst out = positional.at(-1);\nif (!out) process.exit(1);\nfs.writeFileSync(out, Buffer.from(\"${pngBase64}\", \"base64\"));\nNODE`);
}

function writeMagickAppend(path: string, pngBase64: string): void {
	writeExecutable(path, `"${nodeBinary}" - "$@" <<'NODE'\nconst fs = require(\"node:fs\");\nconst out = process.argv.at(-1);\nif (!out) process.exit(1);\nfs.writeFileSync(out, Buffer.from(\"${pngBase64}\", \"base64\"));\nNODE`);
}

test("rasterizePdfPage uses mutool when available", async () => {
	const bin = tempDir("inline-preview-bin-");
	const pdf = join(tempDir("inline-preview-pdf-"), "input.pdf");
	writeFileSync(pdf, "%PDF-1.4\n");
	const mutoolPng = createMiniPng(128, 64).toString("base64");
	writeExecutable(join(bin, "mutool"), pngWriterForMutool(mutoolPng));

	const artifact = await withPath(bin, () => rasterizePdfPage(pdf, { page: 1, dpi: 150 }));

	assert.equal(artifact.renderer, "mutool");
	assert.equal(artifact.page, 1);
	assert.equal(artifact.dpi, 150);
	assert.equal(artifact.trimmed, false);
	assert.equal(artifact.fullPageWidthPx, 128);
	assert.equal(artifact.fullPageHeightPx, 64);
	assert.equal(artifact.widthPx, 128);
	assert.equal(artifact.heightPx, 64);
	const data = readFileSync(artifact.pngPath, "utf8");
	assert.match(data, /PNG/);
});

test("rasterizePdfPage falls back to pdftoppm", async () => {
	const bin = tempDir("inline-preview-bin-");
	const pdf = join(tempDir("inline-preview-pdf-"), "input.pdf");
	writeFileSync(pdf, "%PDF-1.4\n");
	const pdftoppmPng = createMiniPng(96, 45).toString("base64");
	writeExecutable(join(bin, "pdftoppm"), pngWriterForPdftoppm(pdftoppmPng));

	const artifact = await withPath(bin, () => rasterizePdfPage(pdf, { page: 2, dpi: 96 }));

	assert.equal(artifact.renderer, "pdftoppm");
	assert.equal(artifact.page, 2);
	assert.equal(artifact.dpi, 96);
	assert.equal(artifact.fullPageWidthPx, 96);
	assert.equal(artifact.fullPageHeightPx, 45);
	assert.equal(artifact.widthPx, 96);
	assert.equal(artifact.heightPx, 45);
});

test("rasterizePdfPage keeps full and trimmed dimensions when trim is available", async () => {
	const bin = tempDir("inline-preview-bin-");
	const pdf = join(tempDir("inline-preview-pdf-"), "input.pdf");
	writeFileSync(pdf, "%PDF-1.4\n");
	const fullPng = createMiniPng(300, 200).toString("base64");
	const trimmedPng = createMiniPng(120, 80).toString("base64");
	writeExecutable(join(bin, "mutool"), pngWriterForMutool(fullPng));
	writeMagickTrim(join(bin, "magick"), trimmedPng);

	const artifact = await withPath(bin, () => rasterizePdfPage(pdf, { page: 1, dpi: 72 }));

	assert.equal(artifact.fullPageWidthPx, 300);
	assert.equal(artifact.fullPageHeightPx, 200);
	assert.equal(artifact.widthPx, 120);
	assert.equal(artifact.heightPx, 80);
	assert.equal(artifact.trimmed, true);
});

test("rasterizePdfPages uses pdfinfo page count", async () => {
	const bin = tempDir("inline-preview-bin-");
	const pdf = join(tempDir("inline-preview-pdf-"), "input.pdf");
	writeFileSync(pdf, "%PDF-1.4\n");
	writePdfInfoCommand(join(bin, "pdfinfo"), "Pages: 3");
	const pdftoppmPng = createMiniPng(100, 50).toString("base64");
	writeExecutable(join(bin, "pdftoppm"), pngWriterForPdftoppm(pdftoppmPng));

	const artifacts = await withPath(bin, () => rasterizePdfPages(pdf, { dpi: 120 }));

	assert.equal(artifacts.length, 3);
	assert.equal(artifacts[0].page, 1);
	assert.equal(artifacts[1].page, 2);
	assert.equal(artifacts[2].page, 3);
	for (const artifact of artifacts) {
		assert.equal(artifact.widthPx, 100);
		assert.equal(artifact.heightPx, 50);
	}
});

test("rasterizePdfPages falls back to a single page when page count is unavailable", async () => {
	const bin = tempDir("inline-preview-bin-");
	const pdf = join(tempDir("inline-preview-pdf-"), "input.pdf");
	writeFileSync(pdf, "%PDF-1.4\n");
	const pdftoppmPng = createMiniPng(77, 44).toString("base64");
	writeExecutable(join(bin, "pdftoppm"), pngWriterForPdftoppm(pdftoppmPng));

	const artifacts = await withPath(bin, () => rasterizePdfPages(pdf, { dpi: 100 }));

	assert.equal(artifacts.length, 1);
	assert.equal(artifacts[0].page, 1);
});

test("mergeInlinePreviewArtifacts vertically appends multiple pages when ImageMagick is available", async () => {
	const bin = tempDir("inline-preview-bin-");
	const first = join(tempDir("inline-preview-pages-"), "p1.png");
	const second = join(tempDir("inline-preview-pages-"), "p2.png");
	writeFileSync(first, createMiniPng(100, 50));
	writeFileSync(second, createMiniPng(120, 60));
	writeMagickAppend(join(bin, "magick"), createMiniPng(120, 110).toString("base64"));

	const artifacts = await withPath(bin, () => mergeInlinePreviewArtifacts([
		{ pngPath: first, page: 1, dpi: 150, renderer: "mutool", trimmed: true, fullPageWidthPx: 200, fullPageHeightPx: 300, widthPx: 100, heightPx: 50 },
		{ pngPath: second, page: 2, dpi: 150, renderer: "mutool", trimmed: false, fullPageWidthPx: 180, fullPageHeightPx: 300, widthPx: 120, heightPx: 60 },
	]));

	assert.equal(artifacts.length, 1);
	assert.equal(artifacts[0].page, 1);
	assert.equal(artifacts[0].trimmed, true);
	assert.equal(artifacts[0].fullPageWidthPx, 200);
	assert.equal(artifacts[0].fullPageHeightPx, 600);
	assert.equal(artifacts[0].widthPx, 120);
	assert.equal(artifacts[0].heightPx, 110);
});

test("mergeInlinePreviewArtifacts leaves pages separate without ImageMagick", async () => {
	const artifacts = [
		{ pngPath: "p1.png", page: 1, dpi: 150, renderer: "mutool" as const, trimmed: false, fullPageWidthPx: 100, fullPageHeightPx: 100, widthPx: 100, heightPx: 100 },
		{ pngPath: "p2.png", page: 2, dpi: 150, renderer: "mutool" as const, trimmed: false, fullPageWidthPx: 100, fullPageHeightPx: 100, widthPx: 100, heightPx: 100 },
	];

	const merged = await withPath(tempDir("inline-preview-bin-"), () => mergeInlinePreviewArtifacts(artifacts));

	assert.equal(merged, artifacts);
});

test("calculateInlineDisplayColumns scales relative to full page width", () => {
	assert.equal(calculateInlineDisplayColumns(80, { fullPageWidthPx: 160, widthPx: 80 }), 40);
	assert.equal(calculateInlineDisplayColumns(80, { fullPageWidthPx: 80, widthPx: 160 }), 80);
	assert.equal(calculateInlineDisplayColumns(80, { fullPageWidthPx: 0, widthPx: 80 }), 80);
	assert.equal(calculateInlineDisplayColumns(101, { fullPageWidthPx: 300, widthPx: 90 }), 31);
});

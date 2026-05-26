import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rasterizePdfPage } from "./inline_preview.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
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

test("rasterizePdfPage uses mutool when available", async () => {
	const bin = tempDir("inline-preview-bin-");
	const pdf = join(tempDir("inline-preview-pdf-"), "input.pdf");
	writeFileSync(pdf, "%PDF-1.4\n");
	writeExecutable(join(bin, "mutool"), String.raw`
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift || true
done
printf 'mutool png' > "$out"
`);

	const artifact = await withPath(bin, () => rasterizePdfPage(pdf, { page: 1, dpi: 150 }));

	assert.equal(artifact.renderer, "mutool");
	assert.equal(artifact.page, 1);
	assert.equal(artifact.dpi, 150);
	assert.equal(artifact.trimmed, false);
	assert.equal(readFileSync(artifact.pngPath, "utf8"), "mutool png");
});

test("rasterizePdfPage falls back to pdftoppm", async () => {
	const bin = tempDir("inline-preview-bin-");
	const pdf = join(tempDir("inline-preview-pdf-"), "input.pdf");
	writeFileSync(pdf, "%PDF-1.4\n");
	writeExecutable(join(bin, "pdftoppm"), String.raw`
prefix=""
while [ "$#" -gt 0 ]; do
  prefix="$1"
  shift || true
done
printf 'pdftoppm png' > "$prefix.png"
`);

	const artifact = await withPath(bin, () => rasterizePdfPage(pdf, { page: 2, dpi: 96 }));

	assert.equal(artifact.renderer, "pdftoppm");
	assert.equal(artifact.page, 2);
	assert.equal(artifact.dpi, 96);
	assert.equal(readFileSync(artifact.pngPath, "utf8"), "pdftoppm png");
});

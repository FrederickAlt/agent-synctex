import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { resolveReverseSynctexBox } from "../../../src/modules/synctex/synctex_resolution.ts";
import { getCachedSyncTeXPageLeafBoxes } from "../../../src/modules/synctex/latex_workshop/worker.ts";

const UNIT = 65781.76;

function sync(value: number): number {
	return Math.round(value * UNIT);
}

function pageLeaf(line: number, h: number, v: number, width = 10, height = 10): string[] {
	return [
		`(1,${line}:${sync(h)},${sync(v)}:${sync(width)},${sync(height)},0`,
		`x1,${line}:${sync(h)},${sync(v)}:${sync(width)}`,
		")",
	];
}

function message(overrides: Partial<{ h: number; v: number; W: number; H: number; pdf_text_spans: Array<{ page: number; h: number; v: number; W: number; H: number; text: string }> }> = {}) {
	return { type: "reverse_synctex_box" as const, pdf_id: 7, request_id: 3, page: 1, h: 0, v: 100, W: 10, H: 10, ...overrides };
}

function writeFixture(source: string, leaves: string[]): { dir: string; pdfPath: string; sourcePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "reverse-synctex-box-"));
	const pdfPath = join(dir, "paper.pdf");
	const sourcePath = join(dir, "main.tex");
	writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
	writeFileSync(sourcePath, source);
	writeFileSync(join(dir, "paper.synctex"), ["SyncTeX Version:1", `Input:1:${sourcePath}`, "X Offset:0", "Y Offset:0", "{1", ...leaves, "}1"].join("\n"));
	return { dir, pdfPath, sourcePath };
}

test("box reverse SyncTeX seeds from the smallest supported span and stops before a failing box", () => {
	const fixture = writeFixture([
		"\\begin{document}",
		"prior text",
		"seed text",
		"transparent source line",
		"later text",
		"outside selection",
		"more source",
		"more source",
		"more source",
		"\\end{document}",
	].join("\n"), [
		...pageLeaf(3, 0, 100),
		...pageLeaf(5, 0, 100),
		...pageLeaf(6, 6, 100), // 40% covered: stops before the structural line at 10.
		...pageLeaf(10, 0, 100),
	]);
	try {
		const result = resolveReverseSynctexBox({ message: message(), pdf: { pdfId: 7, pdfPath: fixture.pdfPath, workspaceCwd: fixture.dir } });
		assert.deepEqual(result.source_spans, [{ source_file: fixture.sourcePath, start_line: 3, end_line: 5 }]);
		assert.deepEqual(result.ranges?.map((range) => Math.round(range.h)), [0]);
		assert.equal(result.ranges?.length, 1);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("box reverse SyncTeX accepts exactly 50% coverage and rejects less", () => {
	const fixture = writeFixture("selected text\n", pageLeaf(1, 0, 100));
	try {
		const input = { pdf: { pdfId: 7, pdfPath: fixture.pdfPath, workspaceCwd: fixture.dir } };
		const box = getCachedSyncTeXPageLeafBoxes(fixture.pdfPath, 1)[0];
		assert.ok(box);
		const selection = { h: box.h, v: box.v, W: box.W / 2, H: box.H };
		const result = resolveReverseSynctexBox({ ...input, message: message(selection) });
		assert.deepEqual(result.source_spans, [{ source_file: fixture.sourcePath, start_line: 1, end_line: 1 }]);
		assert.throws(() => resolveReverseSynctexBox({ ...input, message: message({ ...selection, W: box.W * 0.49 }) }), /50% forward-coverage/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("box reverse SyncTeX uses one-dimensional glyph markers but ignores zero-by-zero markers", () => {
	const mapped = writeFixture("glyph-mapped text\n", pageLeaf(1, 0, 100, 0));
	const transparent = writeFixture("zero-by-zero marker\n", pageLeaf(1, 0, 100, 0, 0));
	try {
		const result = resolveReverseSynctexBox({ message: message(), pdf: { pdfId: 7, pdfPath: mapped.pdfPath, workspaceCwd: mapped.dir } });
		assert.deepEqual(result.source_spans, [{ source_file: mapped.sourcePath, start_line: 1, end_line: 1 }]);
		assert.throws(() => resolveReverseSynctexBox({ message: message(), pdf: { pdfId: 7, pdfPath: transparent.pdfPath, workspaceCwd: transparent.dir } }), /50% forward-coverage/);
	} finally {
		rmSync(mapped.dir, { recursive: true, force: true });
		rmSync(transparent.dir, { recursive: true, force: true });
	}
});

test("box reverse SyncTeX rejects an expanded span with unselected source geometry", () => {
	const fixture = writeFixture("selected prose\n\\[\nformula outside selection\n\\]\n", [
		...pageLeaf(1, 0, 100, 0),
		...pageLeaf(2, 0, 100, 0),
		...pageLeaf(3, 0, 70, 0),
	]);
	try {
		const selection = message();
		const result = resolveReverseSynctexBox({ message: selection, pdf: { pdfId: 7, pdfPath: fixture.pdfPath, workspaceCwd: fixture.dir } });
		assert.deepEqual(result.source_spans, [{ source_file: fixture.sourcePath, start_line: 1, end_line: 1 }]);
		assert.deepEqual(result.ranges, [{ page: selection.page, h: selection.h, v: selection.v, W: selection.W, H: selection.H }]);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("box reverse SyncTeX resumes growth from normalized span boundaries", () => {
	const fixture = writeFixture([
		"outside before",
		"before equation",
		"\\begin{equation}",
		"x = y",
		"\\end{equation}",
		"after equation",
		"outside after",
	].join("\n"), [
		...pageLeaf(1, 6, 100),
		...pageLeaf(2, 0, 100),
		...pageLeaf(3, 0, 100, 6),
		...pageLeaf(6, 0, 100),
		...pageLeaf(7, 6, 100),
	]);
	try {
		const result = resolveReverseSynctexBox({ message: message({ W: 6 }), pdf: { pdfId: 7, pdfPath: fixture.pdfPath, workspaceCwd: fixture.dir } });
		assert.deepEqual(result.source_spans, [{ source_file: fixture.sourcePath, start_line: 2, end_line: 6 }]);
		assert.equal(result.ranges?.length, 1);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("box reverse SyncTeX applies full and partial PDF text match bonuses", () => {
	const full = writeFixture("unrelated candidate text\nfailing bridge\nThe unique matching phrase is here\n", [
		...pageLeaf(1, 0, 100),
		...pageLeaf(2, 30, 100),
		...pageLeaf(3, 20, 100),
	]);
	const partial = writeFixture("unrelated candidate text\nfailing bridge\nThe fragment appears in this source\n", [
		...pageLeaf(1, 0, 100),
		...pageLeaf(2, 30, 100),
		...pageLeaf(3, 20, 100),
	]);
	try {
		const fullResult = resolveReverseSynctexBox({
			message: message({ W: 30, pdf_text_spans: [{ page: 1, h: 20, v: 100, W: 10, H: 10, text: "unique matching phrase" }] }),
			pdf: { pdfId: 7, pdfPath: full.pdfPath, workspaceCwd: full.dir },
		});
		assert.equal(fullResult.line, 3);
		const partialResult = resolveReverseSynctexBox({
			message: message({ W: 30, pdf_text_spans: [{ page: 1, h: 20, v: 100, W: 10, H: 10, text: "noise fragment appears noise" }] }),
			pdf: { pdfId: 7, pdfPath: partial.pdfPath, workspaceCwd: partial.dir },
		});
		assert.equal(partialResult.line, 3);
	} finally {
		rmSync(full.dir, { recursive: true, force: true });
		rmSync(partial.dir, { recursive: true, force: true });
	}
});

test("warm whole-page box resolution considers every marker within the latency budget", () => {
	const count = 1_000;
	const fixture = writeFixture(`${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`, Array.from({ length: count }, (_, index) => pageLeaf(index + 1, (index % 50) * 12, 990 - Math.floor(index / 50) * 12)).flat());
	try {
		const input = { message: message({ v: 1000, W: 1000, H: 1000 }), pdf: { pdfId: 7, pdfPath: fixture.pdfPath, workspaceCwd: fixture.dir } };
		assert.equal(getCachedSyncTeXPageLeafBoxes(fixture.pdfPath, 1).length, count);
		resolveReverseSynctexBox(input);
		const startedAt = performance.now();
		const result = resolveReverseSynctexBox(input);
		const elapsedMs = performance.now() - startedAt;
		assert.equal(result.ranges?.length, 1, "the result should retain the user selection geometry");
		assert.deepEqual(result.source_spans, [{ source_file: fixture.sourcePath, start_line: 1, end_line: count }]);
		assert.ok(elapsedMs < 100, `warm whole-page resolution took ${elapsedMs.toFixed(1)}ms`);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("box reverse SyncTeX rejects overly dense selections rather than sampling markers", () => {
	const fixture = writeFixture("line one\n", Array.from({ length: 5_001 }, () => pageLeaf(1, 0, 100)).flat());
	try {
		assert.throws(() => resolveReverseSynctexBox({ message: message(), pdf: { pdfId: 7, pdfPath: fixture.pdfPath, workspaceCwd: fixture.dir } }), /too dense to resolve exhaustively/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

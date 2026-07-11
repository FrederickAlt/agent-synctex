import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capturePdfMarkSourceAnchor, capturePdfMarkSourceAnchors, pdfMarkSourceRange, pdfMarkSourceRanges, rebasePdfMark, sourceChangedSincePdf } from "../../src/modules/pdf_mark_rebase.ts";
import type { ViewerHostPdfAnnotationMessage } from "../../src/modules/viewer_host_protocol.ts";

function mark(sourceFile: string): ViewerHostPdfAnnotationMessage {
	return {
		type: "pdf_annotation",
		pdf_id: 1,
		annotation_id: "mark",
		page: 1,
		x: 1,
		y: 1,
		source_file: sourceFile,
		line: 3,
		source_span: { source_file: sourceFile, start_line: 2, end_line: 4 },
	};
}

test("PDF mark anchors normalize source lines and retain bounded source span text", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-mark-anchor-"));
	try {
		const sourceFile = join(dir, "main.tex");
		writeFileSync(sourceFile, "one\ntwo\nthree\nfour\n");
		const sourceMark = mark(sourceFile);

		assert.deepEqual(pdfMarkSourceRange(sourceMark), { sourceFile, startLine: 2, endLine: 4 });
		assert.deepEqual(capturePdfMarkSourceAnchor(sourceMark), {
			sourceFile,
			startLine: 2,
			endLine: 4,
			lines: ["two", "three", "four"],
		});
		assert.deepEqual(pdfMarkSourceRange({ ...sourceMark, source_span: undefined }), { sourceFile, startLine: 3, endLine: 3 });
		assert.equal(capturePdfMarkSourceAnchor(mark(dir)), undefined, "non-regular source paths are never read as anchors");
		const multiRangeMark: ViewerHostPdfAnnotationMessage = {
			...sourceMark,
			source_spans: [
				{ source_file: sourceFile, start_line: 1, end_line: 1 },
				{ source_file: sourceFile, start_line: 3, end_line: 4 },
			],
		};
		assert.deepEqual(pdfMarkSourceRanges(multiRangeMark), [
			{ sourceFile, startLine: 1, endLine: 1 },
			{ sourceFile, startLine: 3, endLine: 4 },
		]);
		assert.deepEqual(capturePdfMarkSourceAnchors(multiRangeMark), [
			{ sourceFile, startLine: 1, endLine: 1, lines: ["one"] },
			{ sourceFile, startLine: 3, endLine: 4, lines: ["three", "four"] },
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("multi-range PDF marks rebase atomically", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-mark-multi-rebase-"));
	try {
		const sourceFile = join(dir, "main.tex");
		const pdfFile = join(dir, "main.pdf");
		writeFileSync(pdfFile, "%PDF-1.4\n%%EOF\n");
		writeFileSync(sourceFile, "one\ntwo\nthree\nfour\nfive\nsix\n");
		const sourceMark: ViewerHostPdfAnnotationMessage = {
			...mark(sourceFile),
			source_spans: [
				{ source_file: sourceFile, start_line: 2, end_line: 2 },
				{ source_file: sourceFile, start_line: 5, end_line: 5 },
			],
		};
		const anchors = capturePdfMarkSourceAnchors(sourceMark);
		assert.ok(anchors);
		writeFileSync(sourceFile, "inserted\none\ntwo\nthree\nfour\nfive\nsix\n");
		const resolveForward = ((input: { sourceFile: string; line: number }) => ({
			page: 1,
			x: input.line,
			y: 100,
			width: 10,
			height: 10,
			ranges: [{ page: 1, h: input.line, v: 100, W: 10, H: 10 }],
			indicator: true,
			sourceFile: input.sourceFile,
			line: input.line,
			sourceLine: `line ${input.line}`,
			sidecarPath: "fake.synctex",
			branch: "js_fallback",
			diagnostics: {},
		})) as never;
		const rebased = rebasePdfMark({ mark: sourceMark, anchors, pdfPath: pdfFile, cwd: dir, resolveForward });
		assert.ok(rebased);
		assert.deepEqual(rebased.mark.source_spans, [
			{ source_file: sourceFile, start_line: 3, end_line: 3 },
			{ source_file: sourceFile, start_line: 6, end_line: 6 },
		]);
		assert.deepEqual(rebased.forward.ranges, [
			{ page: 1, h: 3, v: 100, W: 10, H: 10 },
			{ page: 1, h: 6, v: 100, W: 10, H: 10 },
		]);

		writeFileSync(sourceFile, "inserted\none\ntwo\ntwo\nthree\nfour\nfive\nsix\n");
		assert.equal(rebasePdfMark({ mark: sourceMark, anchors, pdfPath: pdfFile, cwd: dir, resolveForward }), undefined, "one ambiguous span clears the full mark");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PDF marks report source drift only when their source is newer than the tracked PDF", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-mark-source-drift-"));
	try {
		const sourceFile = join(dir, "main.tex");
		const pdfFile = join(dir, "main.pdf");
		writeFileSync(sourceFile, "source\n");
		writeFileSync(pdfFile, "%PDF-1.4\n%%EOF\n");
		const pdfMtimeMs = statSync(pdfFile).mtimeMs;
		utimesSync(sourceFile, new Date(pdfMtimeMs + 2_000), new Date(pdfMtimeMs + 2_000));

		assert.equal(sourceChangedSincePdf({ ...mark(sourceFile), source_span: undefined, line: 1 }, pdfMtimeMs), true);
		utimesSync(sourceFile, new Date(pdfMtimeMs - 2_000), new Date(pdfMtimeMs - 2_000));
		assert.equal(sourceChangedSincePdf({ ...mark(sourceFile), source_span: undefined, line: 1 }, pdfMtimeMs), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

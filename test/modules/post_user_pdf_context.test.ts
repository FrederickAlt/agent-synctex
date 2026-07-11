import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type PdfAnnotationEvent } from "../../src/modules/pdf_events.ts";
import { collectPostUserPdfContextFromEvents, pdfAnnotationEventsFromViewerMarks } from "../../src/modules/post_user_pdf_context.ts";

test("PDF annotation context keeps multi-range annotations separate and limits all excerpts to 50 lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-multi-range-context-"));
	try {
		const sourceFile = join(dir, "main.tex");
		writeFileSync(sourceFile, `${Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
		const events: PdfAnnotationEvent[] = [
			{
				type: "pdf_annotation", sequence: 1, pdf_id: 1, annotation_id: "multi", timestamp: "2026-07-11T00:00:00.000Z",
				source_file: sourceFile, line: 1,
				source_spans: [
					{ source_file: sourceFile, start_line: 1, end_line: 30 },
					{ source_file: sourceFile, start_line: 51, end_line: 80 },
					{ source_file: sourceFile, start_line: 31, end_line: 32 },
				],
				page: 1, x: 1, y: 1, comment: "First message.",
			},
			{
				type: "pdf_annotation", sequence: 2, pdf_id: 1, annotation_id: "other", timestamp: "2026-07-11T00:00:01.000Z",
				source_file: sourceFile, line: 13, source_line: "line 13", page: 1, x: 2, y: 2, comment: "Second message.",
			},
		];

		const result = collectPostUserPdfContextFromEvents(events, { cwd: dir });

		assert.equal(result.eventCount, 2);
		assert.match(result.text, /- main\.tex:1-30, main\.tex:51-80, main\.tex:31-32/);
		assert.match(result.text, /line 30/);
		assert.match(result.text, /line 51/);
		assert.doesNotMatch(result.text, /line 71/);
		assert.match(result.text, /excerpt truncated to the 50-source-line total budget per annotation/);
		assert.match(result.text, /source excerpt omitted: 50-source-line total budget per annotation exhausted/);
		assert.match(result.text, /- main\.tex:13\n  Already read TeX source excerpt:\n  ```tex\n  line 13\n  ```\n  Messages:\n  - Second message\./);
		assert.equal((result.text.match(/Messages:/g) ?? []).length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("viewer multi-range marks retain every span and singular ranges do not display a redundant end line", () => {
	const [event] = pdfAnnotationEventsFromViewerMarks([{
		type: "pdf_annotation", pdf_id: 1, annotation_id: "a1", page: 1, x: 1, y: 1,
		source_file: "/tmp/main.tex", line: 13,
		source_spans: [
			{ source_file: "/tmp/main.tex", start_line: 13, end_line: 13 },
			{ source_file: "/tmp/other.tex", start_line: 20, end_line: 21 },
		],
	}]);

	assert.deepEqual(event?.source_spans, [
		{ source_file: "/tmp/main.tex", start_line: 13, end_line: 13 },
		{ source_file: "/tmp/other.tex", start_line: 20, end_line: 21 },
	]);
	assert.equal(collectPostUserPdfContextFromEvents([event!]).text, "## PDF marks from the User\n\n- /tmp/main.tex:13, /tmp/other.tex:20-21");
});

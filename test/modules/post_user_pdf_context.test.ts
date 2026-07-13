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

test("PDF annotation context renders bounded readable SyncTeX debug diagnostics", () => {
	const diagnostics = {
		top_proposals: [
			{ source_file: "/tmp/main.tex", line: 42, column: 0, score: -900, provenance: "synctex_reverse" },
			{ source_file: "/tmp/main.tex", line: 43, column: 0, score: 10, provenance: "selection_text_context" },
			{ source_file: "/tmp/main.tex", line: 44, column: 0, score: 20, provenance: "synctex_reverse" },
			{ source_file: "/tmp/main.tex", line: 45, column: 0, score: 30, provenance: "synctex_reverse" },
		],
		selected_score: -900,
		forward_groups: [{
			proposal: { kind: "ranked", provenance: "synctex_reverse", source_file: "/tmp/main.tex", line: 42, column: 0, rank: 0, structural: false },
			proposal_selected: true,
			proposal_order: { index: 0, geometry_tier: 0, total: -900, exact_lookup_preferred: true, same_page_box_count: 1, rank: 0, line: 42, source_file: "/tmp/main.tex" },
			origin: "synctex_exact",
			lookup_line: 42,
			semantic_penalty: 0,
			pdf_text_span_semantic_penalty: 0,
			selection_text_context_semantic_penalty: 0,
			blank_source_line_penalty: 0,
			original_box_count: 1,
			filtered_box_count: 1,
			same_page_box_count: 1,
			rejected_invalid: 0,
			rejected_absurd: 0,
			contains_click: true,
			geometry_tier: 0,
			click_containment_bonus: -1000,
			text_containment_bonus: 0,
			score: -900,
			group_order: { index: 0, geometry_tier: 0, total: -900, exact_lookup_preferred: true },
			selected: true,
			box_score_count: 1,
			box_scores_truncated: false,
			box_scores: [{
				box: { page: 1, h: 10, v: 20, W: 30, H: 4 }, contains_click: true, geometry_tier: 0,
				distance: 0, distance_squared: 0, distance_multiplier: 0.96, distance_term: 0,
				area: 120, area_term: 2, tiny_penalty: 0, semantic_penalty: 0,
				pdf_text_span_semantic_penalty: 0, selection_text_context_semantic_penalty: 0, blank_source_line_penalty: 0,
				click_containment_bonus: -1000, text_containment_bonus: 0, end_document_penalty: 0,
				total: -998, order: 0, selected: true,
				tree_candidate: {
					leaf: { page: 1, source_file: "/tmp/main.tex", line: 42, h: 10, v: 20, W: 30, H: 4 },
					box: { type: "hbox", page: 1, source_file: "/tmp/main.tex", line: 42, h: 10, v: 20, W: 30, H: 4 },
					ancestors: [{ type: "vbox", page: 1, source_file: "/tmp/main.tex", line: 40, h: 0, v: 30, W: 100, H: 20 }],
				},
			}],
		}],
	};
	const result = collectPostUserPdfContextFromEvents([{
		type: "pdf_annotation", sequence: 1, pdf_id: 1, annotation_id: "debug", timestamp: "2026-07-12T00:00:00.000Z",
		source_file: "/tmp/main.tex", line: 42, page: 1, x: 10, y: 20,
		synctex_diagnostics: diagnostics,
	} as unknown as PdfAnnotationEvent]);

	assert.match(result.text, /SyncTeX debug diagnostics \(bounded\):/);
	assert.match(result.text, /selected proposal score: -900/);
	assert.match(result.text, /top proposal #1: \/tmp\/main\.tex:42:0; provenance=synctex_reverse; score=-900/);
	assert.match(result.text, /forward group \* #1: synctex_exact lookup line 42; proposal=synctex_reverse; score=-900/);
	assert.match(result.text, /box \* #1: page 1 \[10, 20, 30, 4\]; score=-998/);
	assert.match(result.text, /parsed tree: leaf \/tmp\/main\.tex:42; box hbox; ancestors=1/);
	assert.doesNotMatch(result.text, /top proposal #4/);
});

test("viewer debug diagnostics survive PDF annotation event conversion", () => {
	const diagnostics = {
		top_proposals: [{ source_file: "/tmp/main.tex", line: 13, column: 0, score: -5, provenance: "synctex_reverse" }],
		forward_groups: [],
	};
	const [event] = pdfAnnotationEventsFromViewerMarks([{
		type: "pdf_annotation", pdf_id: 1, annotation_id: "debug-a1", page: 1, x: 1, y: 1,
		source_file: "/tmp/main.tex", line: 13, synctex_diagnostics: diagnostics,
	} as unknown as import("../../src/modules/viewer_host_protocol.ts").ViewerHostPdfAnnotationMessage]);
	diagnostics.top_proposals[0]!.score = 999;

	assert.equal(event?.synctex_diagnostics?.top_proposals[0]?.score, -5);
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

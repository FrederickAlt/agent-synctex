import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	validateMcpToViewerHostMessage,
	validateViewerHostToMcpMessage,
	type McpToViewerHostMessage,
	type ViewerHostToMcpMessage,
} from "../../src/modules/viewer_host_protocol.ts";

function assertValidationError(fn: () => unknown, pattern: RegExp): void {
	assert.throws(fn, (error) => error instanceof Error && pattern.test(error.message));
}

test("Viewer Host protocol validates representative MCP to Host messages", () => {
	const messages: McpToViewerHostMessage[] = [
		{ type: "hello", protocol_version: 3 },
		{ type: "open_pdf", pdf_id: 123, pdf_path: "/tmp/main.pdf", title: "main.pdf", workspace_cwd: "/tmp" },
		{ type: "focus_pdf", pdf_id: 123 },
		{ type: "synctex_forward", pdf_id: 123, page: 2, x: 100, y: 500, width: 250, height: 12, source_file: "/tmp/main.tex", line: 42, source_line: "hello" },
		{ type: "synctex_forward", pdf_id: 123, page: 2, x: 100, y: 500, indicator: true, source_file: "/tmp/main.tex", line: 42 },
		{ type: "synctex_forward", pdf_id: 123, page: 2, x: 100, y: 500, ranges: [{ page: 2, h: 10, v: 20, W: 30, H: 4 }, { page: 2, h: 30, v: 40, W: 10, H: 3 }], source_file: "/tmp/main.tex", line: 42 },
		{ type: "pdf_maybe_updated", pdf_id: 123 },
		{ type: "compile_status", pdf_id: 123, running: false, continuous: true, severity: "error", message: "compile failed", inject_text: "compile failed" },
		{ type: "report_error", pdf_id: 123, code: "mark_fetch_failed", title: "Could not fetch PDF marks", detail: "claim failed", inject_text: "PDF mark delivery failed: claim failed" },
		{ type: "report_error", code: "host_failure", title: "Viewer Host failed", detail: "socket disconnected" },
		{ type: "reverse_synctex_hover_result", pdf_id: 123, request_id: 7, page: 2, x: 100, y: 500, source_file: "/tmp/main.tex", line: 42, column: 0, source_line: "hello", rect: { left: 10, top: 20, right: 30, bottom: 40 }, precision: "verified", selected_score: 4, nearest_candidate: { source_file: "/tmp/main.tex", line: 78, column: 0, source_line: "\\end{document}", score: 1000, structural: true, distance: 0 }, repaired: { source_file: "/tmp/main.tex", line: 42, column: 0, source_line: "hello", precision: "verified", score: 4 }, candidates: [{ source_file: "/tmp/main.tex", line: 78, column: 0, source_line: "\\end{document}", score: 1000, structural: true, distance: 0 }, { source_file: "/tmp/main.tex", line: 42, column: 0, source_line: "hello", score: 4, structural: false, distance: 4 }], forward: { attempted: true, contains_click: true, boxes_considered: 2, boxes_filtered: 1, chosen_box: { page: 2, h: 10, v: 20, W: 30, H: 4 } } },
		{ type: "reverse_synctex_hover_result", pdf_id: 123, request_id: 8, page: 2, x: 100, y: 500, error: "no result" },
	];

	for (const message of messages) {
		assert.deepEqual(validateMcpToViewerHostMessage(message), message);
	}
});

test("Viewer Host protocol validates representative Host to MCP messages", () => {
	const messages: ViewerHostToMcpMessage[] = [
		{ type: "ready", protocol_version: 3, origin: "http://127.0.0.1:43125", instance_id: "instance-1" },
		{ type: "viewer_loaded", pdf_id: 123 },
		{ type: "viewer_tab_closed", pdf_id: 123 },
		{ type: "reverse_synctex", pdf_id: 123, page: 2, x: 100, y: 500 },
		{ type: "reverse_synctex", pdf_id: 123, page: 2, x: 100, y: 500, textBeforeSelection: "before", textAfterSelection: "after" },
		{ type: "reverse_synctex", pdf_id: 123, page: 2, x: 100, y: 500, selectedText: "chosen", selectionStartX: 95, selectionStartY: 500, selectionEndX: 150, selectionEndY: 500 },
		{ type: "pdf_annotation", pdf_id: 123, annotation_id: "a1", page: 2, x: 100, y: 500, h: 90, v: 510, W: 40, H: 12, ranges: [{ page: 2, h: 90, v: 510, W: 40, H: 12 }], source_file: "/tmp/main.tex", line: 42, source_line: "hello", source_spans: [{ source_file: "/tmp/main.tex", start_line: 40, end_line: 42 }, { source_file: "/tmp/other.tex", start_line: 7, end_line: 7 }], comment: "please check" },
		{ type: "pdf_annotation_deleted", pdf_id: 123, annotation_id: "a1" },
		{ type: "selection_debug", pdf_id: 123, phase: "send", page: 2, text: "chosen", details: { phase: "send", selectionTextLength: 6 } },
		{ type: "compile_action", pdf_id: 123, action: "inject_diagnostic", inject_text: "compile failed" },
		{ type: "reverse_synctex_hover", pdf_id: 123, request_id: 7, page: 2, x: 100, y: 500, textBeforeSelection: "before", textAfterSelection: "after" },
		{ type: "reverse_synctex_forward_probe", pdf_id: 123, request_id: 8, page: 2, x: 100, y: 500, page_height: 792, pdf_text_spans: [{ page: 2, h: 90, v: 510, W: 40, H: 12, text: "Heading" }], textBeforeSelection: "before", textAfterSelection: "after" },
		{ type: "reverse_synctex_box", pdf_id: 123, request_id: 9, page: 2, h: 90, v: 510, W: 40, H: 12, pdf_text_spans: [{ page: 2, h: 90, v: 510, W: 40, H: 12, text: "Heading" }] },
	];

	for (const message of messages) {
		assert.deepEqual(validateViewerHostToMcpMessage(message), message);
	}
});

test("Viewer Host protocol derives scalar geometry from validated same-page annotation ranges", () => {
	const message = { type: "pdf_annotation", pdf_id: 1, annotation_id: "ranges", page: 2, x: 90, y: 510, ranges: [{ page: 2, h: 90, v: 510, W: 40, H: 12 }, { page: 2, h: 140, v: 510, W: 20, H: 12 }], source_file: "/tmp/main.tex", line: 42 };
	assert.deepEqual(validateViewerHostToMcpMessage(message), { ...message, h: 90, v: 510, W: 40, H: 12 });
	assert.throws(() => validateViewerHostToMcpMessage({ ...message, ranges: [{ page: 3, h: 90, v: 510, W: 40, H: 12 }] }), /annotation page/);
});

test("Viewer Host protocol retains bounded SyncTeX diagnostics on PDF annotations", () => {
	const diagnostics = {
		top_proposals: [{
			kind: "ranked", provenance: "synctex_reverse", source_file: "/tmp/main.tex", line: 42, column: 0, rank: 0, structural: false,
			geometry_tier: 0, score: -900, precision: "verified", same_page_box_count: 1, contains_click: true,
			click_containment_bonus: -1000, text_containment_bonus: 0, forward_lookup_mode: "exact",
		}],
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
				box: { page: 2, h: 10, v: 20, W: 30, H: 4 },
				contains_click: true,
				geometry_tier: 0,
				distance: 0,
				distance_squared: 0,
				distance_multiplier: 0.96,
				distance_term: 0,
				area: 120,
				area_term: 2,
				tiny_penalty: 0,
				semantic_penalty: 0,
				pdf_text_span_semantic_penalty: 0,
				selection_text_context_semantic_penalty: 0,
				blank_source_line_penalty: 0,
				click_containment_bonus: -1000,
				text_containment_bonus: 0,
				end_document_penalty: 0,
				total: -998,
				order: 0,
				selected: true,
				tree_candidate: {
					leaf: { page: 2, source_file: "/tmp/main.tex", line: 42, h: 10, v: 20, W: 30, H: 4 },
					box: { type: "hbox", page: 2, source_file: "/tmp/main.tex", line: 42, h: 10, v: 20, W: 30, H: 4 },
					ancestors: [{ type: "vbox", page: 2, source_file: "/tmp/main.tex", line: 42, h: 0, v: 30, W: 100, H: 20 }],
				},
			}],
		}],
	};
	const message = {
		type: "pdf_annotation",
		pdf_id: 123,
		annotation_id: "debug-a1",
		page: 2,
		x: 100,
		y: 500,
		source_file: "/tmp/main.tex",
		line: 42,
		synctex_diagnostics: diagnostics,
	};

	assert.deepEqual(validateViewerHostToMcpMessage(message), message);
	assertValidationError(() => validateViewerHostToMcpMessage({
		...message,
		synctex_diagnostics: { ...diagnostics, top_proposals: Array.from({ length: 4 }, () => diagnostics.top_proposals[0]) },
	}), /synctex_diagnostics\.top_proposals/);
});

test("Viewer Host protocol module stays framework-neutral", () => {
	const source = readFileSync("src/modules/viewer_host_protocol.ts", "utf8");
	assert.doesNotMatch(source, /from ["'][^"']*(pdfjs|browser|dom)[^"']*["']/i);
	assert.doesNotMatch(source, /\b(window|document|HTMLElement|WebSocket)\b/);
});

test("Viewer Host protocol validation rejects malformed boundary messages", () => {
	const invalidMcpMessages: Array<[unknown, RegExp]> = [
		[{}, /type/],
		[{ type: "bogus" }, /unknown message type/],
		[{ type: "open_pdf", pdf_id: 0, pdf_path: "/tmp/main.pdf" }, /pdf_id/],
		[{ type: "open_pdf", pdf_id: 1, pdf_path: "" }, /pdf_path/],
		[{ type: "open_pdf", pdf_id: 1, pdf_path: "/tmp/main.pdf", workspace_cwd: "" }, /workspace_cwd/],
		[{ type: "synctex_forward", pdf_id: 1, page: 0, x: 1, y: 1, line: 1 }, /page/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: Number.NaN, y: 1, line: 1 }, /x/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: -1, line: 1 }, /y/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: 1, width: -1, line: 1 }, /width/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: 1, ranges: [] }, /ranges/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: 1, ranges: {} }, /ranges/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: 1, ranges: [{ page: 1, h: -1, v: 2, W: 3, H: 4 }] }, /ranges\[0\]\.h/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: 1, line: 0 }, /line/],
		[{ type: "reverse_synctex_hover_result", pdf_id: 1, request_id: 1, page: 1, x: 1, y: 1 }, /requires source_file/],
		[{ type: "reverse_synctex_hover_result", pdf_id: 1, request_id: 1, page: 1, x: 1, y: 1, source_file: "/tmp/main.tex", line: 1, column: 0, rect: { left: -1, top: 1, right: 2, bottom: 3 } }, /rect\.left/],
		[{ type: "compile_status", pdf_id: 1, running: false, continuous: false, severity: "warning" }, /severity/],
		[{ type: "report_error", pdf_id: 0, code: "failure", title: "Failed", detail: "detail" }, /pdf_id/],
		[{ type: "report_error", code: "", title: "Failed", detail: "detail" }, /code/],
		[{ type: "report_error", code: "failure", title: "", detail: "detail" }, /title/],
		[{ type: "report_error", code: "failure", title: "Failed", detail: "" }, /detail/],
		[{ type: "report_error", code: "failure", title: "Failed", detail: "detail", inject_text: 42 }, /inject_text/],
	];

	for (const [message, pattern] of invalidMcpMessages) {
		assertValidationError(() => validateMcpToViewerHostMessage(message), pattern);
	}

	const invalidHostMessages: Array<[unknown, RegExp]> = [
		[{}, /type/],
		[{ type: "bogus" }, /unknown message type/],
		[{ type: "viewer_loaded", pdf_id: -1 }, /pdf_id/],
		[{ type: "reverse_synctex", pdf_id: 1, page: 1, x: Number.POSITIVE_INFINITY, y: 1 }, /x/],
		[{ type: "reverse_synctex", pdf_id: 1, page: 1, x: 1, y: 1, textBeforeSelection: 1 }, /textBeforeSelection/],
		[{ type: "reverse_synctex", pdf_id: 1, page: 1, x: 1, y: 1, selectedText: 1 }, /selectedText/],
		[{ type: "reverse_synctex", pdf_id: 1, page: 1, x: 1, y: 1, selectionStartX: -1 }, /selectionStartX/],
		[{ type: "pdf_annotation", pdf_id: 1, annotation_id: "", page: 1, x: 1, y: 1, source_file: "/tmp/main.tex", line: 1 }, /annotation_id/],
		[{ type: "pdf_annotation", pdf_id: 1, annotation_id: "a1", page: 1, x: 1, y: 1, source_file: "/tmp/main.tex", line: 0 }, /line/],
		[{ type: "pdf_annotation", pdf_id: 1, annotation_id: "a1", page: 1, x: 1, y: 1, source_file: "/tmp/main.tex", line: 1, source_span: { source_file: "/tmp/main.tex", start_line: 3, end_line: 2 } }, /source_span\.end_line/],
		[{ type: "pdf_annotation", pdf_id: 1, annotation_id: "a1", page: 1, x: 1, y: 1, source_file: "/tmp/main.tex", line: 1, source_spans: [] }, /source_spans/],
		[{ type: "pdf_annotation", pdf_id: 1, annotation_id: "a1", page: 1, x: 1, y: 1, h: 1, v: 2, W: 0, H: 3, source_file: "/tmp/main.tex", line: 1 }, /W/],
		[{ type: "reverse_synctex_box", pdf_id: 1, request_id: 1, page: 1, h: 1, v: 1, W: 0, H: 3 }, /W/],
		[{ type: "reverse_synctex_box", pdf_id: 1, request_id: 1, page: 1, h: 1, v: 1, W: 2, H: 3, pdf_text_spans: [{ page: 1, h: 1, v: 1, W: 2, H: 3, text: "" }] }, /pdf_text_spans\[0\]\.text/],
		[{ type: "pdf_annotation_deleted", pdf_id: 1, annotation_id: "" }, /annotation_id/],
		[{ type: "selection_debug", pdf_id: 1, phase: "", text: "chosen", details: {} }, /phase/],
		[{ type: "selection_debug", pdf_id: 1, phase: "send", text: 1, details: {} }, /text/],
		[{ type: "selection_debug", pdf_id: 1, phase: "send", text: "chosen", details: [] }, /details/],
		[{ type: "reverse_synctex_hover", pdf_id: 1, request_id: 0, page: 1, x: 1, y: 1 }, /request_id/],
		[{ type: "reverse_synctex_hover", pdf_id: 1, request_id: 1, page: 1, x: -1, y: 1 }, /x/],
		[{ type: "reverse_synctex_forward_probe", pdf_id: 1, request_id: 0, page: 1, x: 1, y: 1 }, /request_id/],
		[{ type: "reverse_synctex_forward_probe", pdf_id: 1, request_id: 1, page: 1, x: 1, y: 1, page_height: 0 }, /page_height/],
		[{ type: "reverse_synctex_forward_probe", pdf_id: 1, request_id: 1, page: 1, x: 1, y: 1, pdf_text_spans: [{ page: 1, h: 1, v: 1, W: 2, H: 3, text: "" }] }, /pdf_text_spans\[0\]\.text/],
		[{ type: "compile_action", pdf_id: 1, action: "restart" }, /compile action/],
	];

	for (const [message, pattern] of invalidHostMessages) {
		assertValidationError(() => validateViewerHostToMcpMessage(message), pattern);
	}
});

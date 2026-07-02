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
		{ type: "hello", protocol_version: 1 },
		{ type: "open_pdf", pdf_id: 123, pdf_path: "/tmp/main.pdf", title: "main.pdf", workspace_cwd: "/tmp" },
		{ type: "focus_pdf", pdf_id: 123 },
		{ type: "synctex_forward", pdf_id: 123, page: 2, x: 100, y: 500, width: 250, height: 12, source_file: "/tmp/main.tex", line: 42 },
		{ type: "synctex_forward", pdf_id: 123, page: 2, x: 100, y: 500, indicator: true, source_file: "/tmp/main.tex", line: 42 },
		{ type: "synctex_forward", pdf_id: 123, page: 2, x: 100, y: 500, ranges: [{ page: 2, h: 10, v: 20, W: 30, H: 4 }, { page: 2, h: 30, v: 40, W: 10, H: 3 }], source_file: "/tmp/main.tex", line: 42 },
		{ type: "pdf_maybe_updated", pdf_id: 123 },
		{ type: "reverse_synctex_hover_result", pdf_id: 123, request_id: 7, page: 2, x: 100, y: 500, source_file: "/tmp/main.tex", line: 42, column: 0, source_line: "hello", rect: { left: 10, top: 20, right: 30, bottom: 40 }, precision: "verified", raw: { source_file: "/tmp/main.tex", line: 78, column: 0, source_line: "\\end{document}", score: 1000, structural: true, distance: 0 }, repaired: { source_file: "/tmp/main.tex", line: 42, column: 0, source_line: "hello", precision: "verified" }, candidates: [{ source_file: "/tmp/main.tex", line: 78, column: 0, source_line: "\\end{document}", score: 1000, structural: true, distance: 0 }, { source_file: "/tmp/main.tex", line: 42, column: 0, source_line: "hello", score: 4, structural: false, distance: 4 }], forward: { attempted: true, contains_click: true, boxes_considered: 2, boxes_filtered: 1, chosen_box: { page: 2, h: 10, v: 20, W: 30, H: 4 } } },
		{ type: "reverse_synctex_hover_result", pdf_id: 123, request_id: 8, page: 2, x: 100, y: 500, error: "no result" },
		{ type: "reverse_synctex_forward_probe_result", pdf_id: 123, request_id: 9, click_page: 2, click_x: 100, click_y: 500, reverse_source_file: "/tmp/main.tex", reverse_line: 42, reverse_column: 0, reverse_source_line: "hello", page: 2, x: 90, y: 480, ranges: [{ page: 2, h: 10, v: 20, W: 30, H: 4 }], source_file: "/tmp/main.tex", line: 42 },
		{ type: "reverse_synctex_forward_probe_result", pdf_id: 123, request_id: 10, click_page: 2, click_x: 100, click_y: 500, error: "no result" },
	];

	for (const message of messages) {
		assert.deepEqual(validateMcpToViewerHostMessage(message), message);
	}
});

test("Viewer Host protocol validates representative Host to MCP messages", () => {
	const messages: ViewerHostToMcpMessage[] = [
		{ type: "ready", protocol_version: 1, origin: "http://127.0.0.1:43125" },
		{ type: "viewer_loaded", pdf_id: 123 },
		{ type: "viewer_tab_closed", pdf_id: 123 },
		{ type: "reverse_synctex", pdf_id: 123, page: 2, x: 100, y: 500 },
		{ type: "reverse_synctex", pdf_id: 123, page: 2, x: 100, y: 500, textBeforeSelection: "before", textAfterSelection: "after" },
		{ type: "reverse_synctex", pdf_id: 123, page: 2, x: 100, y: 500, selectedText: "chosen", selectionStartX: 95, selectionStartY: 500, selectionEndX: 150, selectionEndY: 500 },
		{ type: "selection_debug", pdf_id: 123, phase: "send", page: 2, text: "chosen", details: { phase: "send", selectionTextLength: 6 } },
		{ type: "reverse_synctex_hover", pdf_id: 123, request_id: 7, page: 2, x: 100, y: 500, textBeforeSelection: "before", textAfterSelection: "after" },
		{ type: "reverse_synctex_forward_probe", pdf_id: 123, request_id: 8, page: 2, x: 100, y: 500, textBeforeSelection: "before", textAfterSelection: "after" },
	];

	for (const message of messages) {
		assert.deepEqual(validateViewerHostToMcpMessage(message), message);
	}
});

test("Viewer Host protocol module stays framework-neutral", () => {
	const source = readFileSync("src/modules/viewer_host_protocol.ts", "utf8");
	assert.doesNotMatch(source, /from ["'][^"']*(tauri|pdfjs|browser|dom)[^"']*["']/i);
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
		[{ type: "reverse_synctex_forward_probe_result", pdf_id: 1, request_id: 1, click_page: 1, click_x: 1, click_y: 1 }, /requires reverse source/],
		[{ type: "reverse_synctex_forward_probe_result", pdf_id: 1, request_id: 1, click_page: 1, click_x: -1, click_y: 1, error: "bad" }, /click_x/],
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
		[{ type: "selection_debug", pdf_id: 1, phase: "", text: "chosen", details: {} }, /phase/],
		[{ type: "selection_debug", pdf_id: 1, phase: "send", text: 1, details: {} }, /text/],
		[{ type: "selection_debug", pdf_id: 1, phase: "send", text: "chosen", details: [] }, /details/],
		[{ type: "reverse_synctex_hover", pdf_id: 1, request_id: 0, page: 1, x: 1, y: 1 }, /request_id/],
		[{ type: "reverse_synctex_hover", pdf_id: 1, request_id: 1, page: 1, x: -1, y: 1 }, /x/],
		[{ type: "reverse_synctex_forward_probe", pdf_id: 1, request_id: 0, page: 1, x: 1, y: 1 }, /request_id/],
	];

	for (const [message, pattern] of invalidHostMessages) {
		assertValidationError(() => validateViewerHostToMcpMessage(message), pattern);
	}
});

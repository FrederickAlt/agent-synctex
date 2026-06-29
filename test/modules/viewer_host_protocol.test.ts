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
		{ type: "open_pdf", pdf_id: 123, pdf_path: "/tmp/main.pdf", title: "main.pdf" },
		{ type: "focus_pdf", pdf_id: 123 },
		{ type: "synctex_forward", pdf_id: 123, page: 2, x: 100, y: 500, source_file: "/tmp/main.tex", line: 42 },
		{ type: "pdf_maybe_updated", pdf_id: 123 },
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
		[{ type: "synctex_forward", pdf_id: 1, page: 0, x: 1, y: 1, line: 1 }, /page/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: Number.NaN, y: 1, line: 1 }, /x/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: -1, line: 1 }, /y/],
		[{ type: "synctex_forward", pdf_id: 1, page: 1, x: 1, y: 1, line: 0 }, /line/],
	];

	for (const [message, pattern] of invalidMcpMessages) {
		assertValidationError(() => validateMcpToViewerHostMessage(message), pattern);
	}

	const invalidHostMessages: Array<[unknown, RegExp]> = [
		[{}, /type/],
		[{ type: "bogus" }, /unknown message type/],
		[{ type: "viewer_loaded", pdf_id: -1 }, /pdf_id/],
		[{ type: "reverse_synctex", pdf_id: 1, page: 1, x: Number.POSITIVE_INFINITY, y: 1 }, /x/],
	];

	for (const [message, pattern] of invalidHostMessages) {
		assertValidationError(() => validateViewerHostToMcpMessage(message), pattern);
	}
});

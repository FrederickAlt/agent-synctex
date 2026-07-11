import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { PdfEventStore, type PdfAnnotationEvent, type PdfEvent, type ReverseSynctexPdfEventInput } from "../../src/modules/pdf_events.ts";
import { ViewerHostMcpService, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import { collectPostUserPdfContextFromEvents } from "../../src/modules/post_user_pdf_context.ts";
import type { ReverseSynctexLocation } from "../../src/modules/synctex/forward_synctex.ts";
import type { McpToViewerHostMessage, ViewerHostControlResponse } from "../../src/modules/viewer_host_protocol.ts";

test("fetch_pdf_context formats PDF annotation comments as concise source-cited marks", async () => {
	const events: PdfEvent[] = [
		{
			type: "selection_debug",
			sequence: 7,
			pdf_id: 34942382,
			timestamp: "2026-06-29T12:00:00.000Z",
			phase: "send",
			text: "debug text",
			details: {},
		},
		{
			type: "pdf_annotation",
			sequence: 8,
			pdf_id: 34942382,
			annotation_id: "annotation-1",
			timestamp: "2026-06-29T12:00:00.000Z",
			source_file: "/tmp/paper/main.tex",
			line: 42,
			source_line: "E = mc^2",
			pdf_mark: "E = mc²",
			page: 3,
			x: 110,
			y: 220,
			comment: "Please justify this step.",
		},
	];

	const response = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 12,
		method: "tools/call",
		params: { name: "fetch_pdf_context", arguments: { pdf_id: 34942382, max_events: 5 } },
	}), {
		fetchPdfContext: (request) => collectPostUserPdfContextFromEvents(events, { pdfId: request.pdf_id, maxEvents: request.max_events, clearViewer: true }),
	});

	assert.ok(response && "result" in response);
	const result = response.result as { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> };
	const text = result.content?.[0]?.text ?? "";
	assert.equal(text, "## PDF marks from the User\n\n- /tmp/paper/main.tex:42\n  Already read TeX source excerpt: `E = mc^2`\n  Messages:\n  - Please justify this step.");
	assert.deepEqual(result.details, { pdf_ids: [34942382], event_count: 1, cleared: true });
	assert.doesNotMatch(text, /selection_debug|page=3|E = mc²/);
});

test("PDF mark context preserves separate annotations on one source line", () => {
	const events: PdfEvent[] = [
		{ type: "pdf_annotation", sequence: 1, pdf_id: 1, annotation_id: "left", timestamp: "2026-07-11T00:00:00.000Z", source_file: "/tmp/paper/main.tex", line: 42, source_line: "The shared source line.", pdf_mark: "First PDF box.", page: 1, x: 10, y: 20, comment: "First user message." },
		{ type: "pdf_annotation", sequence: 2, pdf_id: 1, annotation_id: "right", timestamp: "2026-07-11T00:00:01.000Z", source_file: "/tmp/paper/main.tex", line: 42, source_line: "The shared source line.", pdf_mark: "Second PDF box.", page: 1, x: 90, y: 20, comment: "Second user message." },
	];

	const result = collectPostUserPdfContextFromEvents(events, { pdfId: 1, clearViewer: true });

	assert.equal(result.eventCount, 2);
	assert.equal(result.text, "## PDF marks from the User\n\n- /tmp/paper/main.tex:42\n  Already read TeX source excerpt: `The shared source line.`\n  Messages:\n  - First user message.\n- /tmp/paper/main.tex:42\n  Already read TeX source excerpt: `The shared source line.`\n  Messages:\n  - Second user message.");
});

test("PDF mark context warns when source changed after PDF compilation", () => {
	const result = collectPostUserPdfContextFromEvents([{
		type: "pdf_annotation",
		sequence: 1,
		pdf_id: 1,
		annotation_id: "stale",
		timestamp: "2026-07-11T00:00:00.000Z",
		source_file: "/tmp/missing-stale.tex",
		line: 3,
		source_line: "stale source line",
		source_stale: true,
		page: 1,
		x: 1,
		y: 1,
	}], { clearViewer: true });

	assert.match(result.text, /Warning: this source changed after the displayed PDF was compiled/);
	assert.match(result.text, /Already read TeX source excerpt: `stale source line`/);
});

test("PDF mark context preserves long user comments without truncation or omission", () => {
	const comment = [
		"What we actually should prove is that (\\mathfrak z^{(t)}_s) exists and is deterministic.",
		"The middle of this comment is intentionally long: " + "boundary-law-detail ".repeat(600),
		"UNMISTAKABLE COMMENT REMAINDER: use it to define the boundary laws.",
	].join("\n");
	const result = collectPostUserPdfContextFromEvents([{
		type: "pdf_annotation",
		sequence: 1,
		pdf_id: 77,
		annotation_id: "long-comment",
		timestamp: "2026-07-10T12:00:00.000Z",
		source_file: "/tmp/paper/main.tex",
		line: 9,
		source_line: "A marked equation.",
		page: 1,
		x: 10,
		y: 20,
		comment,
	}], { maxEvents: 1, clearViewer: true });

	assert.equal(result.eventCount, 1, "a long comment must not cause the entire mark to be omitted");
	assert.ok(result.text.includes(comment.replace(/\n/g, "\n    ")), "the exact comment, including indented continuation lines, must reach the hook context");
	assert.match(result.text, /UNMISTAKABLE COMMENT REMAINDER/);
});

test("PDF mark context keeps absolute source paths outside cwd", () => {
	const result = collectPostUserPdfContextFromEvents([{
		type: "pdf_annotation",
		sequence: 1,
		pdf_id: 1,
		annotation_id: "outside",
		timestamp: "2026-06-29T12:00:00.000Z",
		source_file: "/tmp/outside/main.tex",
		line: 3,
		source_line: "outside",
		page: 1,
		x: 1,
		y: 1,
	}], { cwd: "/tmp/workspace", clearViewer: true });

	assert.equal(result.text, "## PDF marks from the User\n\n- /tmp/outside/main.tex:3\n  Already read TeX source excerpt: `outside`");
});

test("PDF mark context normalizes a mark without a source span to a singular line range", () => {
	const result = collectPostUserPdfContextFromEvents([{
		type: "pdf_annotation",
		sequence: 1,
		pdf_id: 1,
		annotation_id: "line",
		timestamp: "2026-06-29T12:00:00.000Z",
		source_file: "/tmp/workspace/main.tex",
		line: 157,
		source_line: "}",
		page: 1,
		x: 1,
		y: 1,
	}], { cwd: "/tmp/workspace", clearViewer: true });

	assert.equal(result.text, "## PDF marks from the User\n\n- main.tex:157\n  Already read TeX source excerpt: `}`");
});

test("PDF mark context keeps overlapping source spans with their annotations", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-mark-range-union-"));
	try {
		const sourceFile = join(dir, "main.tex");
		writeFileSync(sourceFile, "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
		const events: PdfAnnotationEvent[] = [[2, 4], [4, 6], [6, 8]].map(([start_line, end_line], index) => ({
			type: "pdf_annotation", sequence: index + 1, pdf_id: 1, annotation_id: String(index), timestamp: "2026-07-11T00:00:00.000Z",
			source_file: sourceFile, line: start_line, source_span: { source_file: sourceFile, start_line, end_line }, page: 1, x: 1, y: 1,
		}));

		assert.equal(collectPostUserPdfContextFromEvents(events, { cwd: dir }).text, "## PDF marks from the User\n\n- main.tex:2-4\n  Already read TeX source excerpt:\n  ```tex\n  two\n  three\n  four\n  ```\n- main.tex:4-6\n  Already read TeX source excerpt:\n  ```tex\n  four\n  five\n  six\n  ```\n- main.tex:6-8\n  Already read TeX source excerpt:\n  ```tex\n  six\n  seven\n  eight\n  ```");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PDF mark context keeps disjoint source spans separate", () => {
	const sourceFile = "/tmp/missing-disjoint.tex";
	const events: PdfAnnotationEvent[] = [[1, 2], [4, 5]].map(([start_line, end_line], index) => ({
		type: "pdf_annotation", sequence: index + 1, pdf_id: 1, annotation_id: String(index), timestamp: "2026-07-11T00:00:00.000Z",
		source_file: sourceFile, line: start_line, source_span: { source_file: sourceFile, start_line, end_line }, page: 1, x: 1, y: 1,
	}));

	assert.equal(collectPostUserPdfContextFromEvents(events).text, "## PDF marks from the User\n\n- /tmp/missing-disjoint.tex:1-2\n- /tmp/missing-disjoint.tex:4-5");
});

test("PDF mark context truncates already read TeX source excerpts at 50 lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-mark-range-truncation-"));
	try {
		const sourceFile = join(dir, "main.tex");
		writeFileSync(sourceFile, `${Array.from({ length: 51 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
		const result = collectPostUserPdfContextFromEvents([{ type: "pdf_annotation", sequence: 1, pdf_id: 1, annotation_id: "long", timestamp: "2026-07-11T00:00:00.000Z", source_file: sourceFile, line: 1, source_span: { source_file: sourceFile, start_line: 1, end_line: 51 }, page: 1, x: 1, y: 1 }], { cwd: dir });

		assert.match(result.text, /line 50/);
		assert.doesNotMatch(result.text, /line 51/);
		assert.match(result.text, /excerpt truncated to 50 lines/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PDF mark context falls back to stored source lines when source reading fails", () => {
	const result = collectPostUserPdfContextFromEvents([{
		type: "pdf_annotation", sequence: 1, pdf_id: 1, annotation_id: "missing", timestamp: "2026-07-11T00:00:00.000Z",
		source_file: "/tmp/missing-source.tex", line: 9, source_line: "\\section{Fallback}", page: 1, x: 1, y: 1,
	}]);

	assert.equal(result.text, "## PDF marks from the User\n\n- /tmp/missing-source.tex:9\n  Already read TeX source excerpt: `\\section{Fallback}`");
});

test("PDF mark context delivers every selected event without a hidden output budget", () => {
	const events: PdfEvent[] = Array.from({ length: 20 }, (_, index) => ({
		type: "pdf_annotation" as const,
		sequence: index + 1,
		pdf_id: 1,
		annotation_id: `mark-${index}`,
		timestamp: "2026-06-29T12:00:00.000Z",
		source_file: "/tmp/workspace/main.tex",
		line: index + 1,
		source_line: `line ${index + 1}`,
		page: 1,
		x: 1,
		y: 1,
		comment: "x".repeat(500),
	}));
	const result = collectPostUserPdfContextFromEvents(events, { cwd: "/tmp/workspace", maxEvents: 20 });
	assert.equal(result.eventCount, events.length);
	assert.equal(result.events.length, result.eventCount);
	assert.match(result.text, /main\.tex:20/);
	assert.ok(result.text.length > 8_000, "the old implicit output budget must not truncate comments or omit marks");
});

function eventInput(pdfId: number, line: number): ReverseSynctexPdfEventInput {
	return {
		type: "reverse_synctex",
		pdf_id: pdfId,
		source_file: `/tmp/${pdfId}.tex`,
		line,
		column: 1,
		timestamp: `2026-06-29T12:00:${String(line).padStart(2, "0")}.000Z`,
	};
}

class SelectionDebugTestClient implements ViewerHostClient {
	readonly origin = "http://127.0.0.1:1";
	readonly messages: McpToViewerHostMessage[] = [];
	async send(message: McpToViewerHostMessage): Promise<void | ViewerHostControlResponse> {
		this.messages.push(message);
		return undefined;
	}
}

test("Viewer Host MCP service fetches context and clears consumed viewer annotations", async () => {
	const dir = mkdtempSync(join(tmpdir(), "viewer-host-fetch-context-clear-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		const client = new SelectionDebugTestClient();
		const service = new ViewerHostMcpService({ client, makePdfId: () => 513 });
		await service.openPdf({ protocol_version: 1, request_id: "open", operation: "open_pdf", created_at_ns: 1, workspace_context: { cwd: dir }, details: { pdf_path: pdfPath } });
		service.handleHostMessage({
			type: "pdf_annotation",
			pdf_id: 513,
			annotation_id: "a1",
			page: 1,
			x: 10,
			y: 20,
			source_file: join(dir, "main.tex"),
			line: 7,
			source_line: "marked source",
			source_span: { source_file: join(dir, "main.tex"), start_line: 5, end_line: 8 },
			comment: "user note",
		});

		const result = await service.fetchPdfContext({ pdf_id: 513, max_events: 5, cwd: dir });

		assert.equal(result.text, "## PDF marks from the User\n\n- main.tex:5-8\n  Already read TeX source excerpt: `marked source`\n  Messages:\n  - user note");
		assert.deepEqual(client.messages.at(-1), { type: "clear_pdf_annotations", pdf_id: 513 });
		assert.deepEqual(await service.getPdfEvents({ pdf_id: 513, max_events: 5 }), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Viewer Host MCP service discards pending marks when the owning viewer tab closes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "viewer-host-tab-close-context-clear-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		const service = new ViewerHostMcpService({ client: new SelectionDebugTestClient(), makePdfId: () => 88 });
		await service.openPdf({ protocol_version: 1, request_id: "open", operation: "open_pdf", created_at_ns: 1, workspace_context: { cwd: dir }, details: { pdf_path: pdfPath } });
		service.handleHostMessage({ type: "pdf_annotation", pdf_id: 88, annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(dir, "main.tex"), line: 7, source_line: "marked source", comment: "user note" });
		service.handleHostMessage({ type: "viewer_tab_closed", pdf_id: 88 });

		const result = await service.fetchPdfContext({ pdf_id: 88, max_events: 5, cwd: dir });

		assert.equal(result.text, "");
		assert.equal(result.eventCount, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Viewer Host MCP service accepts and stores selection debug messages", async () => {
	const dir = mkdtempSync(join(tmpdir(), "viewer-host-selection-debug-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		const service = new ViewerHostMcpService({ client: new SelectionDebugTestClient(), makePdfId: () => 77 });
		await service.openPdf({ protocol_version: 1, request_id: "open", operation: "open_pdf", created_at_ns: 1, workspace_context: { cwd: dir }, details: { pdf_path: pdfPath } });
		service.handleHostMessage({
			type: "selection_debug",
			pdf_id: 77,
			phase: "send",
			page: 2,
			text: "browser selection",
			details: { selectionTextLength: 17, selectedPayloadTextLength: 17 },
		});

		const events = await service.getPdfEvents({ pdf_id: 77, max_events: 5, debug: true });
		assert.equal(events.length, 1);
		assert.equal(events[0]?.type, "selection_debug");
		assert.equal(events[0]?.phase, "send");
		assert.deepEqual(events[0]?.details, { selectionTextLength: 17, selectedPayloadTextLength: 17 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fakeReverseLocation(input: { pdfPath: string; page: number; x: number; y: number; textBeforeSelection?: string; textAfterSelection?: string }, sourcePath: string, line: number, rawLine?: number): ReverseSynctexLocation {
	return {
		page: input.page,
		x: input.x,
		y: input.y,
		sourceFile: sourcePath,
		line,
		column: 4,
		sourceLine: `line ${line}`,
		sidecarPath: input.pdfPath.replace(/\.pdf$/i, ".synctex"),
		precision: rawLine === undefined ? "line" : "verified",
		...(rawLine === undefined ? {} : { rawMappedSourceFile: `${sourcePath}.raw`, rawMappedLine: rawLine, rawMappedColumn: 0, rawMappedSourceLine: "\\end{document}" }),
		diagnostics: {
			branch: "js",
			lookupInput: { pdfPath: input.pdfPath, page: input.page, x: input.x, y: input.y, sidecarPath: input.pdfPath.replace(/\.pdf$/i, ".synctex") },
			native: { command: "synctex", args: [], cwd: join(sourcePath, ".."), attempted: false, role: "fallback" },
			js: { attempted: true, role: "primary" },
			context: { hasSelectionContext: input.textBeforeSelection !== undefined || input.textAfterSelection !== undefined, ...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }), ...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }) },
			candidates: [],
			selected: { sourceFile: sourcePath, line, column: 4, sourceLine: `line ${line}` },
			precision: rawLine === undefined ? "line" : "verified",
			...(rawLine === undefined ? {} : { textRepair: { used: true, status: "unique", fragmentsTried: ["Browser EXACT"], matchCount: 1, selectedFragment: "Browser EXACT", line, column: 4 }, rawWinner: { line: rawLine, sourceLine: "\\end{document}" }, topCandidates: [{ line: rawLine, sourceLine: "\\end{document}" }] }),
		},
	};
}

test("Viewer Host MCP service maps selected range endpoints through robust reverse context and preserves exact selected_text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "viewer-host-selection-robust-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(sourcePath, "source without browser exact selection\n");
		const calls: Array<{ x: number; textBeforeSelection?: string; textAfterSelection?: string }> = [];
		const service = new ViewerHostMcpService({
			client: new SelectionDebugTestClient(),
			makePdfId: () => 128,
			reverseSynctexMapper: (input) => {
				calls.push({ x: input.x, ...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }), ...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }) });
				if (input.x === 10) return fakeReverseLocation(input, sourcePath, 66, 78);
				if (input.x === 20) return fakeReverseLocation(input, sourcePath, 67, 79);
				return fakeReverseLocation(input, sourcePath, 65);
			},
		});
		await service.openPdf({ protocol_version: 1, request_id: "open", operation: "open_pdf", created_at_ns: 1, workspace_context: { cwd: dir }, details: { pdf_path: pdfPath } });
		service.handleHostMessage({
			type: "reverse_synctex",
			pdf_id: 128,
			page: 2,
			x: 15,
			y: 200,
			textBeforeSelection: "Before ",
			textAfterSelection: " After",
			selectedText: "Browser EXACT",
			selectionStartX: 10,
			selectionStartY: 201,
			selectionEndX: 20,
			selectionEndY: 202,
		});

		const events = await service.getPdfEvents({ pdf_id: 128, max_events: 5 });
		const event = events[0] as Extract<PdfEvent, { type: "reverse_synctex" }> | undefined;
		assert.equal(event?.selected_text, "Browser EXACT");
		assert.deepEqual(calls.map((call) => ({ x: call.x, before: call.textBeforeSelection, after: call.textAfterSelection })), [
			{ x: 15, before: "Before ", after: " After" },
			{ x: 10, before: "Before ", after: "Browser EXACT" },
			{ x: 20, before: "Browser EXACT", after: " After" },
		]);
		assert.equal(event?.selection_start?.line, 66);
		assert.equal(event?.selection_start?.precision, "verified");
		assert.equal(event?.selection_start?.repair, "text_context");
		assert.equal(event?.selection_start?.raw_mapped_source_file, `${sourcePath}.raw`);
		assert.equal(event?.selection_start?.raw_mapped_line, 78);
		assert.equal(event?.selection_start?.raw_mapped_source_line, "\\end{document}");
		assert.equal(event?.selection_end?.line, 67);
		assert.equal(event?.selection_end?.raw_mapped_line, 79);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PdfEventStore default reads return unread events once while stale reads preserve old events", () => {
	const store = new PdfEventStore();
	const first = store.appendReverseSynctexEvent(eventInput(1, 10));
	const second = store.appendReverseSynctexEvent(eventInput(1, 11));

	assert.deepEqual(store.getEvents({ pdf_id: 1, max_events: 5 }), [first, second]);
	assert.deepEqual(store.getEvents({ pdf_id: 1, max_events: 5 }), []);
	assert.deepEqual(store.getEvents({ pdf_id: 1, max_events: 5, stale: true }), [first, second]);
});

test("PdfEventStore pdf_id reads mark only matching PDF events read", () => {
	const store = new PdfEventStore();
	const pdfOne = store.appendReverseSynctexEvent(eventInput(1, 10));
	const pdfTwo = store.appendReverseSynctexEvent(eventInput(2, 20));

	assert.deepEqual(store.getEvents({ pdf_id: 1, max_events: 5 }), [pdfOne]);
	assert.deepEqual(store.getEvents({ max_events: 5 }), [pdfTwo]);
});

test("PdfEventStore max_events returns oldest unread page and leaves overflow unread", () => {
	const store = new PdfEventStore();
	const first = store.appendReverseSynctexEvent(eventInput(1, 10));
	const second = store.appendReverseSynctexEvent(eventInput(1, 11));
	const third = store.appendReverseSynctexEvent(eventInput(1, 12));

	assert.deepEqual(store.getEvents({ max_events: 2 }), [first, second]);
	assert.deepEqual(store.getEvents({ max_events: 2 }), [third]);
});

test("PdfEventStore bounds retained history and forgets read state for evicted events", () => {
	const store = new PdfEventStore({ maxEvents: 2 });
	store.appendReverseSynctexEvent(eventInput(1, 1));
	store.appendReverseSynctexEvent(eventInput(1, 2));
	store.appendReverseSynctexEvent(eventInput(1, 3));
	assert.deepEqual(store.getEvents({ max_events: 10, stale: true }).map((event) => event.sequence), [2, 3]);
	assert.deepEqual(store.getEvents({ max_events: 10 }).map((event) => event.sequence), [2, 3]);
});

test("fetch_pdf_context schema is advertised while raw get_pdf_events remains hidden", async () => {
	const listResponse = await handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
	assert.ok(listResponse && "result" in listResponse);
	const tools = (listResponse.result as { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> }).tools ?? [];
	assert.equal(tools.find((candidate) => candidate.name === "get_pdf_events"), undefined);
	const tool = tools.find((candidate) => candidate.name === "fetch_pdf_context");
	assert.equal(tool?.inputSchema?.properties?.clear, undefined);
	assert.deepEqual(tool?.inputSchema?.properties?.max_events, { type: "integer", minimum: 1 });

	const accepted = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "fetch_pdf_context", arguments: { max_events: 1 } },
	}), { getPdfEvents: () => [] });
	assert.ok(accepted && "result" in accepted);

	const rejectedUnknown = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "fetch_pdf_context", arguments: { clear: true } },
	}), { fetchPdfContext: () => ({ text: "", pdfIds: [], eventCount: 0, cleared: false, events: [] }) });
	assert.ok(rejectedUnknown && "error" in rejectedUnknown);
	assert.match(rejectedUnknown.error.message, /unknown argument: clear/);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { PdfEventStore, type PdfEvent, type ReverseSynctexPdfEventInput } from "../../src/modules/pdf_events.ts";
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
	assert.equal(text, "## PDF marks from Agent SyncTeX\n\n- `/tmp/paper/main.tex:42` — `E = mc^2`\n  User comment: Please justify this step.");
	assert.deepEqual(result.details, { pdf_ids: [34942382], event_count: 1, cleared: true });
	assert.doesNotMatch(text, /selection_debug|page=3/);
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

	assert.equal(result.text, "## PDF marks from Agent SyncTeX\n\n- `/tmp/outside/main.tex:3` — `outside`");
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
			comment: "user note",
		});

		const result = await service.fetchPdfContext({ pdf_id: 513, max_events: 5, cwd: dir });

		assert.equal(result.text, "## PDF marks from Agent SyncTeX\n\n- `main.tex:7` — `marked source`\n  User comment: user note");
		assert.deepEqual(client.messages.at(-1), { type: "clear_pdf_annotations", pdf_id: 513 });
		assert.deepEqual(await service.getPdfEvents({ pdf_id: 513, max_events: 5 }), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Viewer Host MCP service accepts and stores selection debug messages", async () => {
	const service = new ViewerHostMcpService({ client: new SelectionDebugTestClient() });
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

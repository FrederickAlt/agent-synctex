import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { PdfEventStore, type PdfEvent, type ReverseSynctexPdfEventInput } from "../../src/modules/pdf_events.ts";
import { ViewerHostMcpService, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import type { ReverseSynctexLocation } from "../../src/modules/synctex/forward_synctex.ts";
import type { McpToViewerHostMessage, ViewerHostControlResponse } from "../../src/modules/viewer_host_protocol.ts";

test("get_pdf_events text exposes reverse SyncTeX event details", async () => {
	const event: PdfEvent = {
		type: "reverse_synctex",
		sequence: 7,
		pdf_id: 34942382,
		source_file: "/tmp/paper/main.tex",
		line: 42,
		column: 1,
		source_line: "\\section{Visible target}",
		timestamp: "2026-06-29T12:00:00.000Z",
		page: 3,
		x: 110,
		y: 220,
		selected_text: "chosen formula",
		precision: "verified",
		repair: "text_context",
		selection_start: { source_file: "/tmp/paper/main.tex", line: 40, column: 2, source_line: "\\begin{align}", page: 3, x: 100, y: 210, precision: "verified", repair: "text_context", raw_mapped_source_file: "/tmp/paper/raw.tex", raw_mapped_line: 43, raw_mapped_source_line: "\\end{align}", synctex_diagnostics: { topCandidates: [{ line: 43 }, { line: 40 }] } },
		selection_end: { source_file: "/tmp/paper/main.tex", line: 42, column: 12, source_line: "  a &= b + c\\\\", page: 3, x: 130, y: 220, precision: "text", raw_mapped_line: 43, raw_mapped_source_line: "\\end{align}" },
		raw_mapped_line: 43,
		raw_mapped_column: 9,
		raw_mapped_source_line: "\\end{align}",
		normalized_formula_span: {
			source_file: "/tmp/paper/main.tex",
			start_line: 40,
			end_line: 43,
		},
		normalized_formula_excerpt: "\\begin{align}\n  a &= b + c\\\\\n\\end{align}",
		synctex_diagnostics: {
			branch: "js_fallback",
			precision: "verified",
			textRepair: { used: true },
			selected: { sourceFile: "/tmp/paper/main.tex", line: 42, column: 1, sourceLine: "\\section{Visible target}" },
			context: { hasSelectionContext: true, textBeforeSelection: "formula body", textAfterSelection: "closing delimiter" },
			candidates: [
				{ kind: "initial_candidate", sourceFile: "/tmp/paper/main.tex", line: 43, column: 9 },
				{ kind: "formula_normalized", sourceFile: "/tmp/paper/main.tex", line: 42, column: 1 },
			],
		},
	};

	const response = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "get_pdf_events", arguments: { pdf_id: event.pdf_id, max_events: 5 } },
	}), {
		getPdfEvents: () => [event],
	});

	assert.ok(response && "result" in response);
	assert.deepEqual((response.result as { details?: { events?: PdfEvent[] } }).details, { events: [event] });

	const text = (response.result as { content?: Array<{ type: string; text: string }> }).content?.[0]?.text ?? "";
	assert.match(text, /Returned 1 PDF event\(s\) for pdf_id=34942382\./);
	assert.match(text, /reverse_synctex/);
	assert.match(text, /pdf_id=34942382/);
	assert.match(text, /source_file=\/tmp\/paper\/main\.tex/);
	assert.match(text, /line=42/);
	assert.match(text, /source_line=\\section\{Visible target\}/);
	assert.match(text, /page=3/);
	assert.match(text, /precision=verified/);
	assert.match(text, /repair=text_context/);
	assert.doesNotMatch(text, /\bx=110\b/);
	assert.doesNotMatch(text, /\by=220\b/);
	assert.equal((response.result as { details?: { events?: PdfEvent[] } }).details?.events?.[0]?.x, 110);
	assert.equal((response.result as { details?: { events?: PdfEvent[] } }).details?.events?.[0]?.y, 220);
	assert.match(text, /selected_text=chosen formula/);
	assert.match(text, /selection_start=\/tmp\/paper\/main\.tex:line=40:column=2:precision=verified:repair=text_context:initial_candidate_source_file=\/tmp\/paper\/raw\.tex:initial_candidate_line=43/);
	assert.match(text, /selection_end=\/tmp\/paper\/main\.tex:line=42:column=12:precision=text:initial_candidate_line=43/);
	assert.doesNotMatch(text, /topCandidates/);
	assert.doesNotMatch(text, /raw_mapped_/);
	assert.match(text, /initial_candidate_line=43/);
	assert.match(text, /initial_candidate_column=9/);
	assert.match(text, /initial_candidate_source_line=\\end\{align\}/);
	assert.match(text, /normalized_formula_span=40-43/);
	assert.match(text, /normalized_formula_excerpt=\\begin\{align\} a &= b \+ c\\\\ \\end\{align\}/);
	assert.match(text, /synctex_diagnostics=branch=js_fallback/);
	assert.match(text, /selected=\/tmp\/paper\/main\.tex:line=42:column=1/);
	assert.match(text, /context=selection=true;before=formula body;after=closing delimiter/);
	assert.match(text, /candidates=2/);
});

test("get_pdf_events text exposes PDF annotation comments", async () => {
	const event: PdfEvent = {
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
	};

	const response = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "get_pdf_events", arguments: { pdf_id: event.pdf_id, max_events: 5 } },
	}), {
		getPdfEvents: () => [event],
	});

	assert.ok(response && "result" in response);
	assert.deepEqual((response.result as { details?: { events?: PdfEvent[] } }).details, { events: [event] });
	const text = (response.result as { content?: Array<{ type: string; text: string }> }).content?.[0]?.text ?? "";
	assert.match(text, /pdf_annotation/);
	assert.match(text, /annotation_id=annotation-1/);
	assert.match(text, /source_line=E = mc\^2/);
	assert.match(text, /comment=Please justify this step\./);
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

test("get_pdf_events text formats selection debug compactly while retaining full details", async () => {
	const event: PdfEvent = {
		type: "selection_debug",
		sequence: 3,
		pdf_id: 88,
		timestamp: "2026-07-01T00:00:00.000Z",
		phase: "post_send_audit",
		page: 1,
		text: "selected text",
		details: {
			phase: "post_send_audit",
			selectionTextLength: 13,
			sentText: "selected text",
			currentText: "changed text",
			changed: true,
			rangeStartNode: { type: "text", text: "full node text retained" },
		},
	};

	const response = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "get_pdf_events", arguments: { pdf_id: event.pdf_id, max_events: 5, debug: true } },
	}), {
		getPdfEvents: () => [event],
	});

	assert.ok(response && "result" in response);
	assert.deepEqual((response.result as { details?: { events?: PdfEvent[] } }).details, { events: [event] });
	const text = (response.result as { content?: Array<{ type: string; text: string }> }).content?.[0]?.text ?? "";
	assert.match(text, /selection_debug/);
	assert.match(text, /phase=post_send_audit/);
	assert.match(text, /page=1/);
	assert.match(text, /selection_text_len=13/);
	assert.match(text, /selection_text=selected text/);
	assert.doesNotMatch(text, /full node text retained/);
});

class SelectionDebugTestClient implements ViewerHostClient {
	readonly origin = "http://127.0.0.1:1";
	async send(_message: McpToViewerHostMessage): Promise<void | ViewerHostControlResponse> {
		return undefined;
	}
}

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

test("get_pdf_events schema accepts stale and debug booleans and rejects invalid values", async () => {
	const listResponse = await handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
	assert.ok(listResponse && "result" in listResponse);
	const tools = (listResponse.result as { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> }).tools ?? [];
	const tool = tools.find((candidate) => candidate.name === "get_pdf_events");
	assert.deepEqual(tool?.inputSchema?.properties?.stale, { type: "boolean" });
	assert.deepEqual(tool?.inputSchema?.properties?.debug, { type: "boolean" });

	const accepted = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "get_pdf_events", arguments: { max_events: 1, stale: true, debug: true } },
	}), { getPdfEvents: () => [] });
	assert.ok(accepted && "result" in accepted);

	const rejectedStale = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "get_pdf_events", arguments: { max_events: 1, stale: "yes" } },
	}), { getPdfEvents: () => [] });
	assert.ok(rejectedStale && "error" in rejectedStale);
	assert.match(rejectedStale.error.message, /stale must be a boolean/);

	const rejectedDebug = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 4,
		method: "tools/call",
		params: { name: "get_pdf_events", arguments: { max_events: 1, debug: "yes" } },
	}), { getPdfEvents: () => [] });
	assert.ok(rejectedDebug && "error" in rejectedDebug);
	assert.match(rejectedDebug.error.message, /debug must be a boolean/);
});

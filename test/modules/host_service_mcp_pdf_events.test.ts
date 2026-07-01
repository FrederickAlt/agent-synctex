import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import type { PdfEvent } from "../../src/modules/pdf_events.ts";

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
		selection_start: { source_file: "/tmp/paper/main.tex", line: 40, column: 2, source_line: "\\begin{align}", page: 3, x: 100, y: 210 },
		selection_end: { source_file: "/tmp/paper/main.tex", line: 42, column: 12, source_line: "  a &= b + c\\\\", page: 3, x: 130, y: 220 },
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
			selected: { sourceFile: "/tmp/paper/main.tex", line: 42, column: 1, sourceLine: "\\section{Visible target}" },
			context: { hasSelectionContext: true, textBeforeSelection: "formula body", textAfterSelection: "closing delimiter" },
			candidates: [
				{ kind: "raw", sourceFile: "/tmp/paper/main.tex", line: 43, column: 9 },
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
	assert.match(text, /x=110/);
	assert.match(text, /y=220/);
	assert.match(text, /selected_text=chosen formula/);
	assert.match(text, /selection_start=\/tmp\/paper\/main\.tex:line=40:column=2/);
	assert.match(text, /selection_end=\/tmp\/paper\/main\.tex:line=42:column=12/);
	assert.match(text, /raw_mapped_line=43/);
	assert.match(text, /raw_mapped_column=9/);
	assert.match(text, /raw_mapped_source_line=\\end\{align\}/);
	assert.match(text, /normalized_formula_span=40-43/);
	assert.match(text, /normalized_formula_excerpt=\\begin\{align\} a &= b \+ c\\\\ \\end\{align\}/);
	assert.match(text, /synctex_diagnostics=branch=js_fallback/);
	assert.match(text, /selected=\/tmp\/paper\/main\.tex:line=42:column=1/);
	assert.match(text, /context=selection=true;before=formula body;after=closing delimiter/);
	assert.match(text, /candidates=2/);
});

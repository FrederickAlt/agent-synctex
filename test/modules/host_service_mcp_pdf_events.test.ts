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
});

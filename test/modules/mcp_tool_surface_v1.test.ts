import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";

function request(id: number, method: string, params: Record<string, unknown> = {}): string {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

test("v1 tools/list exposes Viewer Host tools and omits raw event and close tools", async () => {
	const response = await handleMcpRequest(request(1, "tools/list")) as unknown as { result: { tools: Array<{ name: string }> } };
	const names = response.result.tools.map((tool) => tool.name);

	assert.deepEqual(names, [
		"show_latex",
		"compile_latex_file",
		"open_pdf",
		"jump_pdf",
		"fetch_pdf_context",
	]);
	assert.equal(names.includes("get_pdf_events"), false);
	assert.equal(names.includes("close_pdf"), false);
});

test("hook-aware tools/list hides manual PDF context tool", async () => {
	const response = await handleMcpRequest(request(3, "tools/list"), {}, { hooksEnabled: true }) as unknown as { result: { tools: Array<{ name: string }> } };
	const names = response.result.tools.map((tool) => tool.name);

	assert.deepEqual(names, [
		"show_latex",
		"compile_latex_file",
		"open_pdf",
		"jump_pdf",
	]);
	assert.equal(names.includes("fetch_pdf_context"), false);
	assert.equal(names.includes("get_pdf_events"), false);

	const callResponse = await handleMcpRequest(request(4, "tools/call", {
		name: "fetch_pdf_context",
		arguments: {},
	}), { fetchPdfContext: () => ({ text: "should not be called", pdfIds: [], eventCount: 0, cleared: false, events: [] }) }, { hooksEnabled: true }) as unknown as { result: { isError?: boolean; content: Array<{ text: string }> } };
	assert.equal(callResponse.result.isError, true);
	assert.match(callResponse.result.content[0].text, /Tool not implemented by runtime: fetch_pdf_context/);
});

test("removed close_pdf tool behaves like an unsupported MCP tool", async () => {
	const response = await handleMcpRequest(request(2, "tools/call", {
		name: "close_pdf",
		arguments: { pdf_id: 1 },
	})) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: unknown };

	assert.equal(response.error, undefined);
	assert.equal(response.result?.isError, true);
	assert.match(response.result?.content?.[0]?.text ?? "", /Tool not implemented by runtime: close_pdf/);
});

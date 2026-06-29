import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";

function request(id: number, method: string, params: Record<string, unknown> = {}): string {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

test("v1 tools/list exposes Viewer Host tools and omits public close_pdf", async () => {
	const response = await handleMcpRequest(request(1, "tools/list")) as unknown as { result: { tools: Array<{ name: string }> } };
	const names = response.result.tools.map((tool) => tool.name);

	assert.deepEqual(names, [
		"show_latex",
		"compile_latex_file",
		"open_pdf",
		"jump_pdf",
		"set_latex_preamble",
		"get_pdf_events",
	]);
	assert.equal(names.includes("close_pdf"), false);
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

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest, MCP_ERROR_INVALID_PARAMS } from "../../src/modules/host_service_mcp.ts";
import { FakeViewerHostClient, ViewerHostMcpService } from "../../src/modules/viewer_host_client.ts";

function writeFakeLatexmk(binDir: string, recordFile: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(
		compilerPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const sourceArg = args[args.length - 1];
const sourcePath = path.resolve(process.cwd(), sourceArg);
const base = sourcePath.replace(/\\.tex$/, "");
fs.writeFileSync(base + ".log", "LaTeX Warning: Reference missing undefined on input line 1.\\nOutput written on " + path.basename(base) + ".pdf (1 page).\\n");
fs.writeFileSync(base + ".pdf", "%PDF-1.4\\n% fake pdf\\n");
if (args.includes("-synctex=1")) fs.writeFileSync(base + ".synctex", "SyncTeX Version:1\\nInput:1:" + sourcePath + "\\n");
process.exit(0);
`,
		{ mode: 0o700 },
	);
	chmodSync(compilerPath, 0o700);
}

async function withPath(pathPrefix: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env.PATH;
	process.env.PATH = `${pathPrefix}:${previous ?? ""}`;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

async function callShowLatex(args: Record<string, unknown>, service: ViewerHostMcpService): Promise<Record<string, unknown>> {
	const response = await handleMcpRequest(JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "show_latex", arguments: args },
	}), service.pdfOperations);
	assert.ok(response);
	return response as unknown as Record<string, unknown>;
}

test("show_latex schema exposes source, compiler, preamble, and warning controls but no inline or raster controls", async () => {
	const response = await handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
	assert.ok(response && "result" in response);
	const tools = (response.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools;
	const showLatex = tools.find((tool) => tool.name === "show_latex");
	assert.ok(showLatex);
	assert.deepEqual(Object.keys(showLatex.inputSchema.properties).sort(), ["compiler", "hide_warnings", "preamble_root_file", "source", "workspace_context"]);
	assert.equal(showLatex.inputSchema.properties.inline, undefined);
	assert.equal(showLatex.inputSchema.properties.open_pdf, undefined);
	assert.equal(showLatex.inputSchema.properties.fixed_preview, undefined);
});

test("show_latex rejects empty source and legacy inline arguments before compiling or opening a viewer", async () => {
	const client = new FakeViewerHostClient();
	const service = new ViewerHostMcpService({ client });
	try {
		let response = await callShowLatex({ source: "   " }, service);
		assert.equal((response.error as { code?: number }).code, MCP_ERROR_INVALID_PARAMS);
		assert.match((response.error as { message?: string }).message ?? "", /source must be a non-empty string/);
		response = await callShowLatex({ source: "x", inline: false }, service);
		assert.equal((response.error as { code?: number }).code, MCP_ERROR_INVALID_PARAMS);
		assert.match((response.error as { message?: string }).message ?? "", /show_latex unknown argument: inline/);
		assert.deepEqual(client.messages, []);
	} finally {
		await service.stop();
	}
});

test("show_latex uses preamble_root_file to wrap source, compiles once with SyncTeX, registers Viewer Host PDF, and returns viewer metadata", async () => {
	const dir = mkdtempSync(join(tmpdir(), "show-latex-viewer-flow-"));
	const binDir = join(dir, "bin");
	const recordFile = join(dir, "latexmk-records.jsonl");
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 4242 });
	writeFakeLatexmk(binDir, recordFile);
	writeFileSync(join(dir, "praeamble.tex"), "\\documentclass{article}\n\\usepackage{physics}\n\\newcommand{\\runtimeMacro}{R}\n");
	writeFileSync(join(dir, "main.tex"), "\\input{praeamble}\n\\begin{document}\nHello\n\\end{document}\n");
	try {
		await withPath(binDir, async () => {
			const response = await callShowLatex({
				source: "\\[\\runtimeMacro + x\\]",
				compiler: "pdflatex",
				preamble_root_file: "main.tex",
				workspace_context: { cwd: dir, workspace_root: dir },
			}, service);
			assert.equal(response.error, undefined);
			const result = response.result as { isError?: boolean; content: Array<{ text: string }>; details: Record<string, unknown> };
			assert.equal(result.isError, undefined);
			assert.equal(result.details.pdf_id, 4242);
			assert.equal(result.details.pdf, undefined);
			assert.equal(typeof result.details.source, "string");
			assert.equal(typeof result.details.source_dir, "string");
			assert.equal(typeof result.details.log, "string");
			assert.equal(result.details.warning_count, 1);
			assert.equal(result.details.warnings, undefined);
			assert.equal(result.details.warnings_hidden, true);
			assert.equal(result.details.viewer_url, undefined);
			assert.match(result.content[0].text, /^ok_with_warnings: pdf_id=4242 warnings=1\nLog: .*\.log\nEditable source: \.agent-synctex\/tmp\/[A-Za-z0-9]{6}\.tex$/);
			assert.doesNotMatch(result.content[0].text, /LaTeX Warning|Warnings:/);
			assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|viewer_url/);
			assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf"]);
			assert.equal(result.details.inline, undefined);
			assert.equal(result.details.inline_preview, undefined);
			assert.equal(result.details.inline_previews, undefined);
			assert.equal(result.details.image_path, undefined);

			const sourceText = readFileSync(String(result.details.source), "utf8");
			assert.match(sourceText, /\\usepackage\{physics\}/);
			assert.match(sourceText, /\\begin\{document\}/);
			assert.match(sourceText, /\\runtimeMacro \+ x/);
			assert.doesNotMatch(sourceText, /\\usepackage(?:\[[^\]]*\])?\{preview\}/);
			assert.notEqual(result.details.pdf, join(dir, "tex-actions.pdf"));

			const compilerRecords = readFileSync(recordFile, "utf8").trim().split(/\n/).map((line) => JSON.parse(line) as { args: string[]; cwd: string });
			assert.equal(compilerRecords.length, 1);
			assert.ok(compilerRecords[0].args.includes("-synctex=1"));
			assert.ok(compilerRecords[0].args.includes("-view=none"));
			assert.ok(compilerRecords[0].args.some((arg) => arg.includes("pdflatex")));
		});
	} finally {
		await service.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

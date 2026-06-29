import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { FakeViewerHostClient, ViewerHostMcpService } from "../../src/modules/viewer_host_client.ts";

function writeFakePdf(path: string, body = "1 0 obj"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
}

function writeForwardSynctexFixture(baseDir: string): { pdfPath: string; sourcePath: string } {
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nJump target text.\n\\end{document}\n");
	writeFileSync(join(baseDir, "paper.synctex"), [
		"SyncTeX Version:1",
		"Input:1:main.tex",
		"Output:pdf",
		"Unit:1",
		"Content:",
		"{1",
		"h1,3:7208960,14417920:1000000,500000,0",
		"}",
		"Postamble:",
		"Count:0",
		"",
	].join("\n"));
	return { pdfPath, sourcePath };
}

function writeFakeLatexmk(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(
		compilerPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const texFile = process.argv[process.argv.length - 1];
const outDir = path.dirname(texFile);
const name = path.basename(texFile).replace(/\\.tex$/, "");
fs.writeFileSync(path.join(outDir, name + ".log"), "fake log\\n");
fs.writeFileSync(path.join(outDir, name + ".pdf"), "%PDF-1.4\\n%%EOF\\n");
process.exit(0);
`,
	);
	chmodSync(compilerPath, 0o700);
}

async function withPath<T>(pathValue: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.PATH;
	process.env.PATH = pathValue;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

function callTool(id: number, name: string, args: Record<string, unknown>, service: ViewerHostMcpService) {
	return handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), service.pdfOperations);
}

test("open_pdf uses an MCP-owned pdf_id and routes open/focus messages through Viewer Host Client", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-open-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 77 });
	try {
		const first = await callTool(1, "open_pdf", { pdf_file_path: pdfPath }, service) as { result?: { details?: Record<string, unknown> } };
		const second = await callTool(2, "open_pdf", { pdf_file_path: pdfPath }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(first.result?.details?.pdf_id, 77);
		assert.equal(second.result?.details?.pdf_id, 77);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "focus_pdf"]);
		assert.deepEqual(client.messages[0], { type: "open_pdf", pdf_id: 77, pdf_path: pdfPath, title: basename(pdfPath) });
		assert.deepEqual(client.messages[1], { type: "focus_pdf", pdf_id: 77 });
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("jump_pdf maps SyncTeX in MCP and sends synctex_forward through Viewer Host Client", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-jump-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 5 });
	try {
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		const response = await callTool(2, "jump_pdf", { pdf_id: 5, line: 3, source_file: sourcePath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.handled, true);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "synctex_forward"]);
		assert.deepEqual(client.messages[1], {
			type: "synctex_forward",
			pdf_id: 5,
			page: 1,
			x: 110,
			y: 220,
			source_file: sourcePath,
			line: 3,
		});
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("viewer_tab_closed host messages do not delete MCP-owned pdf_id state", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tab-close-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 9 });
	try {
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		service.handleHostMessage({ type: "viewer_tab_closed", pdf_id: 9 });
		const response = await callTool(2, "jump_pdf", { pdf_id: 9, line: 3, source_file: sourcePath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.handled, true);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "synctex_forward"]);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("show_latex and compile_latex_file(open_pdf=true) route viewer opens through Viewer Host Client", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-compile-"));
	const runtimeDir = join(baseDir, "runtime");
	const projectDir = join(baseDir, "project");
	const binDir = join(baseDir, "bin");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	writeFakeLatexmk(binDir);
	const latexFile = join(projectDir, "paper.tex");
	writeFileSync(latexFile, "\\documentclass{article}\n\\begin{document}File\\end{document}\n");
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	let nextPdfId = 10;
	const service = new ViewerHostMcpService({ client, makePdfId: () => nextPdfId++ });
	const previousMcpTmpdir = process.env.MCP_TMPDIR;
	process.env.MCP_TMPDIR = runtimeDir;
	try {
		await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => {
			const show = await callTool(1, "show_latex", { source: "Hello", workspace_context: { cwd: projectDir } }, service) as { result?: { details?: Record<string, unknown> } };
			const compile = await callTool(2, "compile_latex_file", { latex_file_path: latexFile, open_pdf: true, workspace_context: { cwd: projectDir } }, service) as { result?: { details?: Record<string, unknown> } };

			assert.equal(show.result?.details?.pdf_id, 10);
			assert.equal(compile.result?.details?.pdf_id, 11);
		});
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "open_pdf"]);
	} finally {
		if (previousMcpTmpdir === undefined) delete process.env.MCP_TMPDIR;
		else process.env.MCP_TMPDIR = previousMcpTmpdir;
		rmSync(baseDir, { recursive: true, force: true });
	}
});

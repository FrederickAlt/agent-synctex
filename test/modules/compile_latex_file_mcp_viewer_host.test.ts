import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { FakeViewerHostClient, ViewerHostMcpService } from "../../src/modules/viewer_host_client.ts";

function writeFakeLatexmk(binDir: string, stateDir: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(
		compilerPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stateDir = ${JSON.stringify(stateDir)};
const texFile = process.argv[process.argv.length - 1];
const countPath = path.join(stateDir, "count.txt");
const count = (Number.parseInt(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0", 10) || 0) + 1;
fs.writeFileSync(countPath, String(count));
const outDir = path.resolve(path.dirname(texFile));
const name = path.basename(texFile, path.extname(texFile));
const logPath = path.join(outDir, name + ".log");
if (fs.existsSync(path.join(stateDir, "fail"))) {
  fs.writeFileSync(logPath, "! Undefined control sequence.\\nl.3 \\bad\\n");
  process.exit(12);
}
fs.writeFileSync(logPath, "LaTeX Warning: Reference x undefined on input line 1.\\nOutput written on " + name + ".pdf (1 page, " + (100 + count) + " bytes).\\n");
const sourcePath = path.resolve(texFile);
const pdfPath = path.join(outDir, name + ".pdf");
const flsPath = path.join(outDir, name + ".fls");
fs.writeFileSync(pdfPath, "%PDF-1.4\\ncompile " + count + " " + "x".repeat(count) + "\\n%%EOF\\n");
fs.writeFileSync(path.join(outDir, name + ".aux"), "aux " + count + "\\n");
fs.writeFileSync(flsPath, ["PWD " + outDir, "INPUT " + sourcePath, "OUTPUT " + logPath, "OUTPUT " + pdfPath, "OUTPUT " + flsPath, ""].join("\\n"));
process.exit(0);
`,
		{ mode: 0o700 },
	);
	chmodSync(compilerPath, 0o700);
}

async function withPath<T>(pathValue: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env.PATH;
	process.env.PATH = pathValue;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

function callCompile(args: Record<string, unknown>, service: ViewerHostMcpService): Promise<unknown> {
	return handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "compile_latex_file", arguments: args } }), service.pdfOperations);
}

test("compile_latex_file performs one fake one-shot compile and returns source/pdf/log diagnostics", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "compile-file-mcp-once-"));
	const stateDir = join(baseDir, "state");
	writeFakeLatexmk(join(baseDir, "bin"), stateDir);
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n");
	const service = new ViewerHostMcpService({ client: new FakeViewerHostClient() });
	try {
		await withPath(`${join(baseDir, "bin")}:${process.env.PATH ?? ""}`, async () => {
			const response = await callCompile({ latex_file_path: "paper.tex", compiler: "lualatex", hide_warnings: false, workspace_context: { cwd: baseDir } }, service) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
			assert.equal(response.result?.isError, undefined);
			const details = response.result?.details ?? {};
			assert.equal(details.source, join(baseDir, "paper.tex"));
			assert.equal(details.pdf, undefined);
			assert.equal(details.log, join(baseDir, "paper.log"));
			assert.equal(details.compile_status, "ok_with_warnings");
			assert.equal(details.warning_count, 1);
			assert.match(response.result?.content?.[0]?.text ?? "", /Warnings:\n- LaTeX Warning: Reference x undefined/);
			assert.equal(details.pdf_id, undefined);
			assert.equal(readFileSync(join(stateDir, "count.txt"), "utf8"), "1");
		});
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("compile_latex_file compile-only calls reuse fresh one-shot results until a dependency changes", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "compile-file-mcp-cache-"));
	const stateDir = join(baseDir, "state");
	writeFakeLatexmk(join(baseDir, "bin"), stateDir);
	const sourcePath = join(baseDir, "paper.tex");
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n");
	utimesSync(sourcePath, 1, 1);
	const service = new ViewerHostMcpService({ client: new FakeViewerHostClient() });
	try {
		await withPath(`${join(baseDir, "bin")}:${process.env.PATH ?? ""}`, async () => {
			await callCompile({ latex_file_path: "paper.tex", workspace_context: { cwd: baseDir } }, service);
			await callCompile({ latex_file_path: "paper.tex", workspace_context: { cwd: baseDir } }, service);
			assert.equal(readFileSync(join(stateDir, "count.txt"), "utf8"), "1");

			writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}Changed\\end{document}\n");
			utimesSync(sourcePath, 3, 3);
			await callCompile({ latex_file_path: "paper.tex", workspace_context: { cwd: baseDir } }, service);
			assert.equal(readFileSync(join(stateDir, "count.txt"), "utf8"), "2");
		});
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("compile_latex_file clean=true removes same-basename artifacts before compiling once", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "compile-file-mcp-clean-"));
	const stateDir = join(baseDir, "state");
	writeFakeLatexmk(join(baseDir, "bin"), stateDir);
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n");
	for (const extension of [".aux", ".log", ".pdf", ".toc"]) {
		writeFileSync(join(baseDir, `paper${extension}`), `stale ${extension}\n`);
	}
	const service = new ViewerHostMcpService({ client: new FakeViewerHostClient() });
	try {
		await withPath(`${join(baseDir, "bin")}:${process.env.PATH ?? ""}`, async () => {
			const response = await callCompile({ latex_file_path: "paper.tex", clean: true, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: { cleaned_artifacts?: string[] } } };
			const cleaned = response.result?.details?.cleaned_artifacts ?? [];
			assert.ok(cleaned.includes(join(baseDir, "paper.pdf")));
			assert.ok(cleaned.includes(join(baseDir, "paper.log")));
			assert.ok(cleaned.includes(join(baseDir, "paper.toc")));
			assert.equal(readFileSync(join(stateDir, "count.txt"), "utf8"), "1");
			assert.equal(existsSync(join(baseDir, "paper.pdf")), true);
		});
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("compile_latex_file open_pdf uses Viewer Host and reuses an already tracked PDF", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "compile-file-mcp-open-reuse-"));
	const stateDir = join(baseDir, "state");
	writeFakeLatexmk(join(baseDir, "bin"), stateDir);
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n");
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 42 });
	try {
		await withPath(`${join(baseDir, "bin")}:${process.env.PATH ?? ""}`, async () => {
			const first = await callCompile({ latex_file_path: "paper.tex", open_pdf: true, workspace_context: { cwd: baseDir } }, service) as { result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
			assert.equal(first.result?.details?.pdf_id, 42);
			assert.equal(first.result?.details?.viewer_url, undefined);
			assert.match(first.result?.content?.[0]?.text ?? "", /^ok_with_warnings: pdf_id=42 warnings=1\nLog: .*paper\.log$/);
			assert.doesNotMatch(first.result?.content?.[0]?.text ?? "", /LaTeX Warning|Warnings:/);
			assert.equal(first.result?.details?.warnings, undefined);
			assert.equal(first.result?.details?.warnings_hidden, true);
			assert.doesNotMatch(JSON.stringify(first.result), /127\.0\.0\.1|viewer_url/);

			const second = await callCompile({ latex_file_path: "paper.tex", open_pdf: true, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };
			assert.equal(second.result?.details?.pdf_id, 42);
			assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "focus_pdf"]);
			assert.equal(readFileSync(join(stateDir, "count.txt"), "utf8"), "1");
		});
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("compile_latex_file surfaces fake compiler failures with log and diagnostics", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "compile-file-mcp-fail-"));
	const stateDir = join(baseDir, "state");
	writeFakeLatexmk(join(baseDir, "bin"), stateDir);
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\\bad\\end{document}\n");
	writeFileSync(join(stateDir, "fail"), "1");
	const service = new ViewerHostMcpService({ client: new FakeViewerHostClient() });
	try {
		await withPath(`${join(baseDir, "bin")}:${process.env.PATH ?? ""}`, async () => {
			const response = await callCompile({ latex_file_path: "paper.tex", workspace_context: { cwd: baseDir } }, service) as { result?: { isError?: boolean; details?: Record<string, unknown> } };
			assert.equal(response.result?.isError, true);
			assert.equal(response.result?.details?.source, join(baseDir, "paper.tex"));
			assert.equal(typeof response.result?.details?.log, "string");
			assert.equal(response.result?.details?.error_code, "failed_no_pdf");
			assert.ok(Array.isArray(response.result?.details?.diagnostics));
			assert.equal(readFileSync(join(stateDir, "count.txt"), "utf8"), "1");
		});
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("compile_latex_file rejects removed continuous input", async () => {
	const service = new ViewerHostMcpService({ client: new FakeViewerHostClient() });
	try {
		const response = await callCompile({ latex_file_path: "paper.tex", continuous: true, workspace_context: { cwd: tmpdir() } }, service) as { error?: { code: number; message: string } };
		assert.equal(response.error?.code, -32602);
		assert.match(response.error?.message ?? "", /unknown argument: continuous/);
	} finally {
		await service.stop();
	}
});

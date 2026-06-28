import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PdfJsViewerBrokerClient } from "../../src/modules/pdfjs_viewer_broker.ts";
import { TexActionsStdioMcpRuntime } from "../../src/modules/stdio_mcp_runtime.ts";
import type { HostServiceCompileRequest, HostServiceCompileResponseEnvelope, HostServiceCompileSnippetRequest, HostServiceCompileSnippetResponseEnvelope, HostServiceOpenRequest, HostServiceOpenResponseEnvelope } from "../../src/modules/host_service_protocol.ts";
import { collectMcpFrames, encodeMcpFrame } from "../helpers/mcp_frames.ts";

async function withRuntimeEnv<T>(runtimeRoot: string, fn: () => Promise<T>): Promise<T> {
	const previousMcpTmpdir = process.env.MCP_TMPDIR;
	const previousAgentId = process.env.TEX_ACTIONS_AGENT_ID;
	process.env.MCP_TMPDIR = runtimeRoot;
	process.env.TEX_ACTIONS_AGENT_ID = "stdio-test-agent";
	try {
		return await fn();
	} finally {
		if (previousMcpTmpdir === undefined) delete process.env.MCP_TMPDIR;
		else process.env.MCP_TMPDIR = previousMcpTmpdir;
		if (previousAgentId === undefined) delete process.env.TEX_ACTIONS_AGENT_ID;
		else process.env.TEX_ACTIONS_AGENT_ID = previousAgentId;
	}
}

test("actual tex-actions-mcp entrypoint answers initialize and tools/list over stdio without a daemon", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-entrypoint-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(cwd, { recursive: true });
	const scriptPath = resolve(process.cwd(), "scripts", "tex-actions-mcp.ts");
	const child = spawn(process.execPath, [scriptPath], {
		cwd,
		env: { ...process.env, MCP_TMPDIR: runtimeRoot, TEX_ACTIONS_AGENT_ID: "entrypoint-test-agent" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exitPromise = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});

	try {
		const output = collectMcpFrames(child.stdout as PassThrough, 2, 2_000);
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
		const frames = await output;
		const initialize = frames[0] as { id: number; result: { serverInfo: { name: string }; capabilities: { tools: { listChanged: boolean } } } };
		const toolsList = frames[1] as { id: number; result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> } };
		assert.equal(initialize.id, 1);
		assert.equal(initialize.result.serverInfo.name, "tex-actions");
		assert.equal(initialize.result.capabilities.tools.listChanged, false);
		assert.equal(toolsList.id, 2);
		const names = toolsList.result.tools.map((tool) => tool.name);
		assert.deepEqual(names, ["show_latex", "compile_latex_file", "open_pdf", "jump_pdf", "close_pdf", "set_latex_preamble", "get_pdf_events"]);
		const showLatexProperties = toolsList.result.tools.find((tool) => tool.name === "show_latex")?.inputSchema.properties ?? {};
		assert.deepEqual(Object.keys(showLatexProperties).sort(), ["compiler", "source"]);
		assert.equal(toolsList.result.tools.find((tool) => tool.name === "compile_latex_file")?.inputSchema.properties?.continuous, undefined);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 300))]);
		child.kill("SIGKILL");
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.doesNotMatch(stderr, /daemon is unavailable|ENOENT|ECONNREFUSED/i);
});

test("stdio viewer URL survives MCP transport shutdown after open_pdf", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-entrypoint-viewer-linger-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	const binDir = join(baseDir, "bin");
	const pdfPath = join(baseDir, "paper.pdf");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(pdfPath, "%PDF-1.4\n% entrypoint viewer linger test\n%%EOF\n");
	writeFileSync(join(binDir, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const scriptPath = resolve(process.cwd(), "scripts", "tex-actions-mcp.ts");
	const child = spawn(process.execPath, [scriptPath], {
		cwd,
		env: {
			...process.env,
			MCP_TMPDIR: runtimeRoot,
			TEX_ACTIONS_AGENT_ID: "entrypoint-viewer-linger-test-agent",
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exitPromise = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});

	try {
		const output = collectMcpFrames(child.stdout as PassThrough, 2, 5_000);
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_pdf", arguments: { pdf_file_path: pdfPath } } }));
		const frames = await output;
		const openResponse = frames[1] as { id: number; result?: { details?: { viewer_url?: unknown; pdf_id?: unknown } }; error?: unknown };
		assert.equal(openResponse.id, 2);
		assert.equal(openResponse.error, undefined);
		const viewerUrl = openResponse.result?.details?.viewer_url;
		const pdfId = openResponse.result?.details?.pdf_id;
		assert.equal(typeof viewerUrl, "string");
		assert.equal(typeof pdfId, "number");

		child.stdin.end();
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (child.exitCode === null) child.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (child.exitCode === null) child.kill("SIGKILL");
		await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 300))]);

		try {
			const viewerResponse = await fetch(viewerUrl as string);
			assert.equal(viewerResponse.status, 200);
			assert.match(await viewerResponse.text(), /PDF\.js viewer/);
			const pdfResponse = await fetch((viewerUrl as string).replace(`/viewer/${pdfId}`, `/pdf/${pdfId}`));
			assert.equal(pdfResponse.status, 200);
			assert.match(pdfResponse.headers.get("content-type") ?? "", /application\/pdf/);
		} catch (error) {
			assert.fail(`returned viewer_url became unreachable after MCP transport shutdown: ${error instanceof Error ? error.message : String(error)}`);
		}
	} finally {
		child.kill("SIGKILL");
		await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 300))]);
		await new PdfJsViewerBrokerClient({ socketPath: join(runtimeRoot, "pdfjs-viewer-broker.sock") }).shutdown().catch(() => undefined);
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.doesNotMatch(stderr, /daemon is unavailable|ENOENT|ECONNREFUSED/i);
});

test("actual tex-actions-mcp entrypoint keeps returned PDF.js viewer URL reachable while process remains alive", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-entrypoint-viewer-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	const binDir = join(baseDir, "bin");
	const pdfPath = join(baseDir, "paper.pdf");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(pdfPath, "%PDF-1.4\n% entrypoint viewer test\n%%EOF\n");
	writeFileSync(join(binDir, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const scriptPath = resolve(process.cwd(), "scripts", "tex-actions-mcp.ts");
	const child = spawn(process.execPath, [scriptPath], {
		cwd,
		env: {
			...process.env,
			MCP_TMPDIR: runtimeRoot,
			TEX_ACTIONS_AGENT_ID: "entrypoint-viewer-test-agent",
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exitPromise = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});

	try {
		const output = collectMcpFrames(child.stdout as PassThrough, 2, 5_000);
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_pdf", arguments: { pdf_file_path: pdfPath } } }));
		const frames = await output;
		const openResponse = frames[1] as { id: number; result?: { details?: { viewer_url?: unknown; pdf_id?: unknown } }; error?: unknown };
		assert.equal(openResponse.id, 2);
		assert.equal(openResponse.error, undefined);
		const viewerUrl = openResponse.result?.details?.viewer_url;
		const pdfId = openResponse.result?.details?.pdf_id;
		assert.equal(typeof viewerUrl, "string");
		assert.equal(typeof pdfId, "number");
		assert.equal(child.exitCode, null, "MCP process must still be alive before probing returned viewer_url");

		const viewerResponse = await fetch(viewerUrl as string);
		assert.equal(viewerResponse.status, 200);
		assert.match(await viewerResponse.text(), /PDF\.js viewer/);
		const pdfResponse = await fetch((viewerUrl as string).replace(`/viewer/${pdfId}`, `/pdf/${pdfId}`));
		assert.equal(pdfResponse.status, 200);
		assert.match(pdfResponse.headers.get("content-type") ?? "", /application\/pdf/);
		assert.equal(child.exitCode, null, "MCP process must remain alive after probing returned viewer_url");
	} finally {
		child.kill("SIGTERM");
		await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 300))]);
		child.kill("SIGKILL");
		await new PdfJsViewerBrokerClient({ socketPath: join(runtimeRoot, "pdfjs-viewer-broker.sock") }).shutdown().catch(() => undefined);
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.doesNotMatch(stderr, /daemon is unavailable|ENOENT|ECONNREFUSED/i);
});

test("stdio runtime rejects invalid get_pdf_events calls with normal JSON-RPC validation", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-invalid-get-events-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const runtime = new TexActionsStdioMcpRuntime({ stdin, stdout, stderr: new PassThrough(), launchCwd });
		try {
			runtime.start();
			const output = collectMcpFrames(stdout, 1);
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", method: "tools/call", params: { name: "get_pdf_events", arguments: {} } }));
			const [response] = await output as Array<{ id: null; error?: { code: number; message: string }; result?: unknown }>;
			assert.equal(response.id, null);
			assert.equal(response.result, undefined);
			assert.equal(response.error?.code, -32600);
			assert.match(response.error?.message ?? "", /Missing request id/);
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("stdio runtime rejects get_pdf_events arguments that violate its schema", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-invalid-get-events-args-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const runtime = new TexActionsStdioMcpRuntime({ stdin, stdout, stderr: new PassThrough(), launchCwd });
		try {
			runtime.start();
			const invalidArguments = [
				"bad",
				{},
				{ max_events: 0 },
				{ max_events: 1.5 },
				{ max_events: "1" },
				{ pdf_id: 0, max_events: 1 },
				{ pdf_id: "1", max_events: 1 },
				{ since_event_id: "cursor-1", max_events: 1 },
				{ unknown: true, max_events: 1 },
			];
			const output = collectMcpFrames(stdout, invalidArguments.length);
			for (const [index, args] of invalidArguments.entries()) {
				stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 20 + index, method: "tools/call", params: { name: "get_pdf_events", arguments: args } }));
			}
			const responses = await output as Array<{ id: number; error?: { code: number; message: string }; result?: unknown }>;
			assert.equal(responses.length, invalidArguments.length);
			for (const [index, response] of responses.entries()) {
				assert.equal(response.id, 20 + index);
				assert.equal(response.result, undefined);
				assert.equal(response.error?.code, -32602);
			}
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("stdio runtime accepts valid get_pdf_events arguments", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-valid-get-events-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const runtime = new TexActionsStdioMcpRuntime({ stdin, stdout, stderr: new PassThrough(), launchCwd });
		try {
			runtime.start();
			const validArguments = [
				{ max_events: 1 },
				{ pdf_id: 1, max_events: 1 },
				{ pdf_id: 2, max_events: 5 },
			];
			const output = collectMcpFrames(stdout, validArguments.length);
			for (const [index, args] of validArguments.entries()) {
				stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 30 + index, method: "tools/call", params: { name: "get_pdf_events", arguments: args } }));
			}
			const responses = await output as Array<{ id: number; result?: { details?: { events?: unknown[] } }; error?: unknown }>;
			assert.equal(responses.length, validArguments.length);
			for (const [index, response] of responses.entries()) {
				assert.equal(response.id, 30 + index);
				assert.equal(response.error, undefined);
				assert.deepEqual(response.result?.details, { events: [] });
			}
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("stdio runtime resolves relative PDF paths from the MCP launch cwd", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-cwd-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	let observedOpenRequest: HostServiceOpenRequest | undefined;
	await withRuntimeEnv(runtimeRoot, async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const runtime = new TexActionsStdioMcpRuntime({
			stdin,
			stdout,
			stderr: new PassThrough(),
			launchCwd,
			pdfOperations: {
				async openPdf(request) {
					observedOpenRequest = request;
					return {
						protocol_version: 1,
						request_id: request.request_id,
						operation: "open_pdf",
						status: "ok",
						generated_at_ns: 1,
						status_details: { protocol_version: 1, supported: true, service_available: true, workspace_context: request.workspace_context, request_id: request.request_id, operation: "open_pdf", backend: "fake", backend_path: "fake", capabilities: { open: true, close: true, forward_search: true, inverse_search: false, reuse: true }, owned: true, reused: false, pdf: request.details.pdf_path, pdf_id: 7 },
					} satisfies HostServiceOpenResponseEnvelope;
				},
			},
		});
		try {
			runtime.start();
			const output = collectMcpFrames(stdout, 1);
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "open_pdf", arguments: { pdf_file_path: "build/out.pdf" } } }));
			await output;
		} finally {
			runtime.close();
		}
	});
	try {
		assert.equal(observedOpenRequest?.workspace_context.cwd, launchCwd);
		assert.equal(observedOpenRequest?.details.pdf_path, join(launchCwd, "build/out.pdf"));
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("stdio runtime injects launch-cwd workspace context into compile_latex_file calls", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-compile-cwd-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	let observedCompileRequest: HostServiceCompileRequest | undefined;
	await withRuntimeEnv(runtimeRoot, async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const runtime = new TexActionsStdioMcpRuntime({
			stdin,
			stdout,
			stderr: new PassThrough(),
			launchCwd,
			pdfOperations: {
				compileService: {
					async compileLatexFileRequest(request: HostServiceCompileRequest): Promise<HostServiceCompileResponseEnvelope> {
						observedCompileRequest = request;
						return {
							protocol_version: 1,
							request_id: request.request_id,
							operation: "compile_latex_file",
							status: "ok",
							generated_at_ns: 1,
							status_details: { protocol_version: 1, supported: true, service_available: true, workspace_context: request.workspace_context, request_id: request.request_id, operation: "compile_latex_file", source: join(request.workspace_context.cwd, request.details.latex_file_path), pdf: join(request.workspace_context.cwd, "paper.pdf"), log: join(request.workspace_context.cwd, "paper.log"), artifact_paths: [], clean: false, cleaned_artifacts: [], compile_status: "ok", warning_count: 0 },
						};
					},
				} as never,
			},
		});
		try {
			runtime.start();
			const output = collectMcpFrames(stdout, 1);
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "compile_latex_file", arguments: { latex_file_path: "paper.tex" } } }));
			await output;
		} finally {
			runtime.close();
		}
	});
	try {
		assert.equal(observedCompileRequest?.workspace_context.cwd, launchCwd);
		assert.equal(observedCompileRequest?.workspace_context.workspace_root, join(runtimeRoot, "agents", "stdio-test-agent"));
		assert.equal(observedCompileRequest?.details.latex_file_path, "paper.tex");
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("stdio runtime seeds runtime preamble with preamble.tex before praeamble.tex and set_latex_preamble updates it", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-preamble-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		writeFileSync(join(launchCwd, "preamble.tex"), "\\usepackage{array}\n");
		writeFileSync(join(launchCwd, "praeamble.tex"), "\\usepackage{booktabs}\n");
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const runtime = new TexActionsStdioMcpRuntime({ stdin, stdout, stderr: new PassThrough(), launchCwd });
		try {
			runtime.start();
			const runtimePreamblePath = join(runtimeRoot, "agents", "stdio-test-agent", "preamble.tex");
			assert.equal(readFileSync(runtimePreamblePath, "utf8"), "\\usepackage{array}\n");
			const output = collectMcpFrames(stdout, 1);
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_latex_preamble", arguments: { latex_preamble: "\\usepackage{mathtools}" } } }));
			await output;
			assert.equal(readFileSync(runtimePreamblePath, "utf8"), "\\usepackage{mathtools}\n");
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("set_latex_preamble updates preamble seen by subsequent show_latex snippets", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-snippet-preamble-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	let observedSnippetPreamble = "";
	await withRuntimeEnv(runtimeRoot, async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const runtime = new TexActionsStdioMcpRuntime({
			stdin,
			stdout,
			stderr: new PassThrough(),
			launchCwd,
			pdfOperations: {
				compileService: {
					async compileLatexSnippetRequest(request: HostServiceCompileSnippetRequest): Promise<HostServiceCompileSnippetResponseEnvelope> {
						observedSnippetPreamble = readFileSync(join(request.workspace_context.workspace_root!, "preamble.tex"), "utf8");
						return {
							protocol_version: 1,
							request_id: request.request_id,
							operation: "compile_latex_snippet",
							status: "ok",
							generated_at_ns: 1,
							status_details: { protocol_version: 1, supported: true, service_available: true, workspace_context: request.workspace_context, request_id: request.request_id, operation: "compile_latex_snippet", source: join(request.workspace_context.workspace_root!, "snippet.tex"), pdf: join(request.workspace_context.workspace_root!, "snippet.pdf"), log: join(request.workspace_context.workspace_root!, "snippet.log"), artifact_paths: [], clean: false, cleaned_artifacts: [], compile_status: "ok", warning_count: 0 },
						};
					},
				} as never,
			},
		});
		try {
			runtime.start();
			let output = collectMcpFrames(stdout, 1);
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "set_latex_preamble", arguments: { latex_preamble: "\\usepackage{physics}" } } }));
			await output;
			output = collectMcpFrames(stdout, 1);
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "show_latex", arguments: { source: "\\[x\\]" } } }));
			await output;
		} finally {
			runtime.close();
		}
	});
	try {
		assert.equal(observedSnippetPreamble, "\\usepackage{physics}\n");
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("stdio runtime falls back to launch-cwd praeamble.tex when preamble.tex is absent", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-praeamble-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		writeFileSync(join(launchCwd, "praeamble.tex"), "\\usepackage{fallback}\n");
		const runtime = new TexActionsStdioMcpRuntime({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), launchCwd });
		try {
			runtime.start();
			assert.equal(readFileSync(join(runtimeRoot, "agents", "stdio-test-agent", "preamble.tex"), "utf8"), "\\usepackage{fallback}\n");
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

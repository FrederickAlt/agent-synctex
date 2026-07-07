import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { TexActionsStdioMcpRuntime } from "../../src/modules/stdio_mcp_runtime.ts";
import type { HostServiceCompileRequest, HostServiceCompileResponseEnvelope, HostServiceCompileSnippetRequest, HostServiceCompileSnippetResponseEnvelope, HostServiceOpenRequest, HostServiceOpenResponseEnvelope } from "../../src/modules/host_service_protocol.ts";
import { collectMcpFrames, encodeMcpFrame } from "../helpers/mcp_frames.ts";

interface TestWebSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
}

function socketCtor(): new (url: string) => TestWebSocket {
	const ctor = (globalThis as { WebSocket?: new (url: string) => TestWebSocket }).WebSocket;
	assert.ok(ctor, "global WebSocket must be available in the Node test runtime");
	return ctor;
}

async function openViewerSocket(viewerSocketUrl: string): Promise<TestWebSocket> {
	const WebSocket = socketCtor();
	const socket = new WebSocket(viewerSocketUrl);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timer = setTimeout(() => rejectOpen(new Error("timed out opening viewer socket")), 2_000);
		socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timer); rejectOpen(new Error("viewer socket errored before open")); }, { once: true });
	});
	return socket;
}

function writeReverseSynctexFixture(baseDir: string): { pdfPath: string; sourcePath: string } {
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "project", "main.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n% stdio reverse fixture\n%%EOF\n");
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nReverse target text.\n\\end{document}\n");
	writeFileSync(join(baseDir, "paper.synctex"), [
		"SyncTeX Version:1",
		"Input:1:main.tex",
		"Output:pdf",
		"Unit:1",
		"Content:",
		"{1",
		"(1,3:7208960,14417920:1000000,500000,0",
		"h1,3:7208960,14417920:1000000",
		")",
		"}1",
		"Postamble:",
		"Count:0",
		"",
	].join("\n"));
	return { pdfPath, sourcePath };
}

function writeFakeBrowserLauncher(baseDir: string): { command: string; logPath: string } {
	const command = join(baseDir, "fake-browser-launcher.js");
	const logPath = join(baseDir, "browser-launches.jsonl");
	writeFileSync(command, `#!/usr/bin/env node
const fs = require("node:fs");
const appUrl = process.argv[2];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  appUrl,
  origin: appUrl ? new URL(appUrl).origin : undefined,
  argv: process.argv.slice(2)
}) + "\\n");
`);
	chmodSync(command, 0o700);
	return { command, logPath };
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!existsSync(path)) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function waitForMissingFile(path: string, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (existsSync(path)) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path} to be removed`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

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

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
	}
}

test("stdio runtime closes hook bridge when stdio closes", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-stdio-close-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	try {
		await withRuntimeEnv(runtimeRoot, async () => {
			const stdin = new PassThrough();
			const runtime = new TexActionsStdioMcpRuntime({ stdin, stdout: new PassThrough(), stderr: new PassThrough(), launchCwd, hookMode: { kind: "hook-capable", harness: "codex" }, pdfOperations: {} });
			runtime.start();
			const discoveryPath = join(runtimeRoot, "agents", "stdio-test-agent", "hook-context-bridge.json");
			try {
				await waitForFile(discoveryPath);
				stdin.end();
				await waitForMissingFile(discoveryPath);
			} finally {
				runtime.close();
			}
		});
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("stdio runtime prints viewer URL to the agent when no live browser viewer is detected", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-viewer-url-agent-"));
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const userMessages: string[] = [];
	const runtime = new TexActionsStdioMcpRuntime({
		stdin,
		stdout,
		stderr,
		launchCwd: baseDir,
		hookMode: { kind: "no-hooks" },
		viewerUrlFallbackWriter: (message) => userMessages.push(message),
		pdfOperations: {
			openPdf: async () => ({
				protocol_version: 1,
				request_id: "open-test",
				operation: "open_pdf",
				status: "ok",
				generated_at_ns: 1,
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: "viewer-host-client",
					backend_identity_ok: true,
					pdf_id: 9,
					viewer_url: "http://127.0.0.1:44417/viewer-lw/9",
					browser_launch: { attempted: true, confirmed: false, active_viewer_clients: 0 },
				},
			} as unknown as HostServiceOpenResponseEnvelope),
		},
	});
	try {
		runtime.start();
		const output = collectMcpFrames(stdout, 1);
		stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "open_pdf", arguments: { pdf_file_path: "/tmp/paper.pdf" } } }));
		const [toolResult] = await output as Array<{ result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
		assert.equal(toolResult.result?.content?.[0]?.text, "open_pdf ok: pdf_id=9\nNo browser viewer was detected after launch; pass this Viewer URL to the user: http://127.0.0.1:44417/viewer-lw/9");
		assert.doesNotMatch(JSON.stringify(toolResult.result?.details), /127\.0\.0\.1|viewer_url/);
		assert.deepEqual(userMessages, ["Agent SyncTeX: no browser viewer was detected after launch; pass this Viewer URL to the user: http://127.0.0.1:44417/viewer-lw/9\n"]);
	} finally {
		runtime.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("stdio runtime hides fetch_pdf_context when user/global managed hooks are installed", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-global-hooks-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	const home = join(baseDir, "home");
	mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
	mkdirSync(launchCwd, { recursive: true });
	writeFileSync(join(home, ".claude", "hooks", "agent-synctex-fetch-info.sh"), "# Managed by agent-synctex\n");
	try {
		await withHome(home, async () => await withRuntimeEnv(runtimeRoot, async () => {
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const runtime = new TexActionsStdioMcpRuntime({ stdin, stdout, stderr: new PassThrough(), launchCwd, hookMode: { kind: "hook-capable", harness: "claude" }, pdfOperations: {} });
			try {
				runtime.start();
				const output = collectMcpFrames(stdout, 1);
				stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
				const [toolsList] = await output as Array<{ result: { tools: Array<{ name: string }> } }>;
				assert.equal(toolsList.result.tools.some((tool) => tool.name === "fetch_pdf_context"), false);
			} finally {
				runtime.close();
			}
		}));
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("actual agent-synctex mcp --harness codex exits when stdio closes", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-entrypoint-codex-close-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(cwd, { recursive: true });
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	const child = spawn(process.execPath, [scriptPath, "mcp", "--harness", "codex", "--cwd", cwd], {
		cwd,
		env: { ...process.env, MCP_TMPDIR: runtimeRoot, TEX_ACTIONS_AGENT_ID: "entrypoint-codex-close-agent" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
		child.once("exit", (code) => resolveExit(code));
		child.once("error", rejectExit);
	});

	try {
		await waitForFile(join(runtimeRoot, "agents", "entrypoint-codex-close-agent", "hook-context-bridge.json"));
		child.stdin.end();
		const exitCode = await Promise.race([
			exitPromise,
			new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 2_000)),
		]);
		assert.notEqual(exitCode, "timeout", "MCP process should exit after Codex closes stdio");
		assert.equal(exitCode, 0);
	} finally {
		child.kill("SIGKILL");
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.equal(stderr, "");
});


test("actual agent-synctex mcp entrypoint answers initialize and tools/list over stdio without a daemon", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-entrypoint-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(cwd, { recursive: true });
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	const child = spawn(process.execPath, [scriptPath, "mcp", "--no-hooks"], {
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
		assert.deepEqual(names, ["show_latex", "compile_latex_file", "open_pdf", "jump_pdf", "set_latex_preamble", "fetch_pdf_context"]);
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

test("actual agent-synctex mcp entrypoint routes open_pdf to the Viewer Host boundary without owning PDF serving", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-entrypoint-viewer-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	const pdfPath = join(baseDir, "paper.pdf");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(pdfPath, "%PDF-1.4\n% entrypoint viewer test\n%%EOF\n");
	const fakeBrowser = writeFakeBrowserLauncher(baseDir);
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	const child = spawn(process.execPath, [scriptPath, "mcp", "--no-hooks"], {
		cwd,
		env: {
			...process.env,
			MCP_TMPDIR: runtimeRoot,
			TEX_ACTIONS_AGENT_ID: "entrypoint-viewer-test-agent",
			AGENT_SYNCTEX_BROWSER_COMMAND: fakeBrowser.command,
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
		const openResponse = frames[1] as { id: number; result?: { content?: Array<{ text?: string }>; details?: { viewer_url?: unknown; pdf_id?: unknown }; _meta?: Record<string, unknown> }; error?: unknown };
		assert.equal(openResponse.id, 2);
		assert.equal(openResponse.error, undefined);
		const pdfId = openResponse.result?.details?.pdf_id;
		assert.equal(openResponse.result?.details?.viewer_url, undefined);
		assert.equal(openResponse.result?._meta?.["agent-synctex/viewer_url"], undefined);
		assert.equal(typeof pdfId, "number");
		await waitForFile(fakeBrowser.logPath);
		const appLaunches = readFileSync(fakeBrowser.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { appUrl?: unknown; origin?: unknown });
		const origin = appLaunches[0]?.origin as string;
		const viewerUrl = `${origin}/viewer-lw/${pdfId}`;
		assert.match(viewerUrl, /^http:\/\/127\.0\.0\.1:\d+\/viewer-lw\/\d+$/);
		assert.equal(openResponse.result?.content?.[0]?.text, `open_pdf ok: pdf_id=${pdfId}\nNo browser viewer was detected after launch; pass this Viewer URL to the user: ${viewerUrl}`);
		assert.doesNotMatch(JSON.stringify(openResponse.result?.details), /127\.0\.0\.1|viewer_url/);
		assert.equal(viewerUrl.includes(pdfPath), false, "viewer URL must not expose raw PDF paths");
		assert.match(stderr, /Agent SyncTeX: no browser viewer was detected after launch; pass this Viewer URL to the user: http:\/\/127\.0\.0\.1:\d+\/viewer-lw\/\d+/);
		const viewer = await fetch(viewerUrl);
		assert.equal(viewer.status, 200, "returned viewer URL should remain reachable while the Host is alive");
		const config = await fetch(`${origin}/config/${pdfId}.json`);
		assert.equal(config.status, 200, "default stdio runtime should launch a real Viewer Host control target, not use FakeViewerHostClient");
		const configBody = await config.json() as { pdf_id?: unknown; pdf_url?: unknown };
		assert.equal(configBody.pdf_id, pdfId);
		assert.equal(typeof configBody.pdf_url, "string");
		assert.equal(appLaunches[0]?.origin, origin);
		assert.equal(appLaunches[0]?.appUrl, `${origin}/viewer-lw`, "default stdio runtime must launch/focus the stable direct browser viewer URL");
		assert.equal(child.exitCode, null, "MCP process must remain alive after routing open_pdf through the Viewer Host boundary");
	} finally {
		child.kill("SIGTERM");
		await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 300))]);
		child.kill("SIGKILL");
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.doesNotMatch(stderr, /daemon is unavailable|ENOENT|ECONNREFUSED/i);
});

test("actual agent-synctex mcp entrypoint bridges reverse SyncTeX events from the real Viewer Host process", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-entrypoint-reverse-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(cwd, { recursive: true });
	const { pdfPath, sourcePath } = writeReverseSynctexFixture(baseDir);
	const fakeBrowser = writeFakeBrowserLauncher(baseDir);
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	const child = spawn(process.execPath, [scriptPath, "mcp", "--no-hooks"], {
		cwd,
		env: {
			...process.env,
			MCP_TMPDIR: runtimeRoot,
			TEX_ACTIONS_AGENT_ID: "entrypoint-reverse-test-agent",
			AGENT_SYNCTEX_BROWSER_COMMAND: fakeBrowser.command,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let socket: TestWebSocket | undefined;
	const exitPromise = new Promise<void>((resolveExit) => {
		child.once("exit", () => resolveExit());
		child.once("error", () => resolveExit());
	});

	try {
		const initialOutput = collectMcpFrames(child.stdout as PassThrough, 2, 5_000);
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
		child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_pdf", arguments: { pdf_file_path: pdfPath } } }));
		const [, openFrame] = await initialOutput as Array<{ id?: unknown; result?: { content?: Array<{ text?: string }>; details?: { pdf_id?: unknown; viewer_url?: unknown }; _meta?: Record<string, unknown> } }>;
		const pdfId = openFrame.result?.details?.pdf_id;
		assert.equal(openFrame.result?.details?.viewer_url, undefined);
		assert.equal(openFrame.result?._meta?.["agent-synctex/viewer_url"], undefined);
		assert.equal(typeof pdfId, "number");
		await waitForFile(fakeBrowser.logPath);
		const appLaunches = readFileSync(fakeBrowser.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { origin?: unknown });
		const origin = appLaunches[0]?.origin as string;
		assert.equal(openFrame.result?.content?.[0]?.text, `open_pdf ok: pdf_id=${pdfId}\nNo browser viewer was detected after launch; pass this Viewer URL to the user: ${origin}/viewer-lw/${pdfId}`);
		assert.doesNotMatch(JSON.stringify(openFrame.result?.details), /127\.0\.0\.1|viewer_url/);
		const configResponse = await fetch(`${origin}/config/${pdfId}.json`);
		assert.equal(configResponse.status, 200);
		const config = await configResponse.json() as { viewer_socket_url?: unknown };
		assert.equal(typeof config.viewer_socket_url, "string");

		socket = await openViewerSocket(config.viewer_socket_url as string);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 110, y: 220, source_file: sourcePath, line: 3, source_line: "Reverse target text.", comment: "Please check this." }));

		let text = "";
		let details: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const output = collectMcpFrames(child.stdout as PassThrough, 1, 2_000);
			child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 10 + attempt, method: "tools/call", params: { name: "fetch_pdf_context", arguments: { pdf_id: pdfId, max_events: 5 } } }));
			const [contextFrame] = await output as Array<{ result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
			text = contextFrame.result?.content?.[0]?.text ?? "";
			details = contextFrame.result?.details;
			if (/User comment: Please check this\./.test(text)) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.equal(text.includes(`${sourcePath}:3`), true);
		assert.match(text, /`Reverse target text\.`/);
		assert.match(text, /User comment: Please check this\./);
		assert.deepEqual(details, { pdf_ids: [pdfId], event_count: 1, cleared: true });
	} finally {
		socket?.close();
		child.kill("SIGTERM");
		await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 300))]);
		child.kill("SIGKILL");
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("stdio runtime rejects invalid fetch_pdf_context calls with normal JSON-RPC validation", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-invalid-fetch-context-"));
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
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", method: "tools/call", params: { name: "fetch_pdf_context", arguments: {} } }));
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

test("stdio runtime rejects fetch_pdf_context arguments that violate its schema", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-invalid-fetch-context-args-"));
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
				{ max_events: 0 },
				{ max_events: 1.5 },
				{ max_events: "1" },
				{ pdf_id: 0, max_events: 1 },
				{ pdf_id: "1", max_events: 1 },
				{ clear: true },
				{ unknown: true, max_events: 1 },
			];
			const output = collectMcpFrames(stdout, invalidArguments.length);
			for (const [index, args] of invalidArguments.entries()) {
				stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 20 + index, method: "tools/call", params: { name: "fetch_pdf_context", arguments: args } }));
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

test("stdio runtime accepts valid fetch_pdf_context arguments", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-valid-fetch-context-"));
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
				{},
				{ max_events: 1 },
				{ pdf_id: 1, max_events: 1 },
				{ pdf_id: 2, max_events: 5 },
			];
			const output = collectMcpFrames(stdout, validArguments.length);
			for (const [index, args] of validArguments.entries()) {
				stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 30 + index, method: "tools/call", params: { name: "fetch_pdf_context", arguments: args } }));
			}
			const responses = await output as Array<{ id: number; result?: { details?: Record<string, unknown> }; error?: unknown }>;
			assert.equal(responses.length, validArguments.length);
			for (const [index, response] of responses.entries()) {
				assert.equal(response.id, 30 + index);
				assert.equal(response.error, undefined);
				assert.deepEqual(response.result?.details, { pdf_ids: [], event_count: 0, cleared: false });
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

test("stdio runtime ignores launch-cwd preamble files and set_latex_preamble updates the runtime preamble", async () => {
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
			assert.equal(existsSync(runtimePreamblePath), false);
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

test("stdio runtime ignores launch-cwd praeamble.tex when there is no LaTeX root", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-praeamble-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		writeFileSync(join(launchCwd, "praeamble.tex"), "\\usepackage{fallback}\n");
		const runtime = new TexActionsStdioMcpRuntime({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), launchCwd });
		try {
			runtime.start();
			assert.equal(existsSync(join(runtimeRoot, "agents", "stdio-test-agent", "preamble.tex")), false);
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("stdio runtime auto-loads the preamble when launch cwd has one LaTeX root", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-single-root-preamble-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		writeFileSync(join(launchCwd, "macros.tex"), "\\usepackage{amsmath}\n\\newcommand{\\fromInput}{I}\n");
		writeFileSync(join(launchCwd, "main.tex"), "\\documentclass{article}\n\\input{macros}\n\\newcommand{\\mainMacro}{M}\n\\begin{document}\nHello\n\\end{document}\n");
		const runtime = new TexActionsStdioMcpRuntime({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), launchCwd });
		try {
			runtime.start();
			const preamble = readFileSync(join(runtimeRoot, "agents", "stdio-test-agent", "preamble.tex"), "utf8");
			assert.match(preamble, /\\documentclass\{article\}/);
			assert.match(preamble, /\\usepackage\{amsmath\}/);
			assert.match(preamble, /\\newcommand\{\\mainMacro\}/);
			assert.doesNotMatch(preamble, /\\begin\{document\}/);
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("stdio runtime silently skips auto-load when launch cwd has multiple roots and root_file can choose one", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "stdio-mcp-multi-root-preamble-"));
	const launchCwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(launchCwd, { recursive: true });
	await withRuntimeEnv(runtimeRoot, async () => {
		writeFileSync(join(launchCwd, "main.tex"), "\\documentclass{article}\n\\newcommand{\\mainMacro}{M}\n\\begin{document}\nMain\n\\end{document}\n");
		writeFileSync(join(launchCwd, "supplement.tex"), "\\documentclass{article}\n\\newcommand{\\suppMacro}{S}\n\\begin{document}\nSupp\n\\end{document}\n");
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let stderrText = "";
		stderr.on("data", (chunk) => { stderrText += String(chunk); });
		const runtime = new TexActionsStdioMcpRuntime({ stdin, stdout, stderr, launchCwd });
		try {
			runtime.start();
			const runtimePreamblePath = join(runtimeRoot, "agents", "stdio-test-agent", "preamble.tex");
			assert.equal(existsSync(runtimePreamblePath), false);
			assert.equal(stderrText, "");
			const output = collectMcpFrames(stdout, 1);
			stdin.write(encodeMcpFrame({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "set_latex_preamble", arguments: { root_file: "supplement.tex" } } }));
			await output;
			const preamble = readFileSync(runtimePreamblePath, "utf8");
			assert.match(preamble, /\\newcommand\{\\suppMacro\}/);
			assert.doesNotMatch(preamble, /\\newcommand\{\\mainMacro\}/);
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

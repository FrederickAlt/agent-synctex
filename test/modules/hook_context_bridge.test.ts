import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { resolveTexActionsHookInstanceCandidates } from "../../src/modules/agent_runtime_context.ts";
import { fetchHookContext, hookContextBridgeDiscoveryPath, startHookContextBridge } from "../../src/modules/hook_context_bridge.ts";
import { TexActionsStdioMcpRuntime } from "../../src/modules/stdio_mcp_runtime.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

async function withRuntimeEnv<T>(runtimeRoot: string, agentId: string, fn: () => Promise<T>): Promise<T> {
	const previousMcpTmpdir = process.env.MCP_TMPDIR;
	const previousAgentId = process.env.TEX_ACTIONS_AGENT_ID;
	process.env.MCP_TMPDIR = runtimeRoot;
	process.env.TEX_ACTIONS_AGENT_ID = agentId;
	try {
		return await fn();
	} finally {
		if (previousMcpTmpdir === undefined) delete process.env.MCP_TMPDIR;
		else process.env.MCP_TMPDIR = previousMcpTmpdir;
		if (previousAgentId === undefined) delete process.env.TEX_ACTIONS_AGENT_ID;
		else process.env.TEX_ACTIONS_AGENT_ID = previousAgentId;
	}
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!existsSync(path)) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

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

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

test("fetchHookContext returns empty text when no bridge discovery exists", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-empty-"));
	try {
		await withRuntimeEnv(join(baseDir, "runtime"), "missing-bridge-agent", async () => {
			assert.equal(await fetchHookContext({ prompt: "hello" }), "");
		});
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook context bridge requires bearer token and returns formatted context through discovery", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-bridge-"));
	const runtimeDir = join(baseDir, "runtime", "agents", "bridge-agent");
	mkdirSync(runtimeDir, { recursive: true });
	const bridge = startHookContextBridge({
		runtimeDir,
		fetchContext: async () => ({
			text: "## PDF marks from the User\n\n- `main.tex:42` — `x`\n  User comment: note",
			pdfIds: [1],
			eventCount: 1,
			cleared: true,
			events: [],
		}),
	});
	try {
		const discovery = await bridge.ready;
		const unauthorized = await fetch(discovery.url, { method: "POST" });
		assert.equal(unauthorized.status, 401);
		await withRuntimeEnv(join(baseDir, "runtime"), "bridge-agent", async () => {
			assert.equal(await fetchHookContext({ prompt: "please use marks" }), "## PDF marks from the User\n\n- `main.tex:42` — `x`\n  User comment: note");
		});
	} finally {
		await bridge.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook context discovery uses this process namespace and does not scan harness-level bridges", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-instance-"));
	const runtimeRoot = join(baseDir, "runtime");
	const instanceId = resolveTexActionsHookInstanceCandidates()[0];
	assert.ok(instanceId);
	const ownedBridge = startHookContextBridge({
		runtimeDir: join(runtimeRoot, "agents", instanceId),
		fetchContext: async () => ({ text: "owned marks", pdfIds: [1], eventCount: 1, cleared: true, events: [] }),
	});
	const harnessBridge = startHookContextBridge({
		runtimeDir: join(runtimeRoot, "agents", "agent-synctex-codex"),
		fetchContext: async () => ({ text: "wrong marks", pdfIds: [2], eventCount: 1, cleared: true, events: [] }),
	});
	try {
		await Promise.all([ownedBridge.ready, harnessBridge.ready]);
		assert.equal(await fetchHookContext({ runtimeRoot, prompt: "next prompt" }), "owned marks");
	} finally {
		await ownedBridge.close();
		await harnessBridge.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook context discovery returns empty instead of scanning unrelated bridges", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-no-scan-"));
	const runtimeRoot = join(baseDir, "runtime");
	const bridge = startHookContextBridge({
		runtimeDir: join(runtimeRoot, "agents", "agent-synctex-codex"),
		fetchContext: async () => ({ text: "wrong marks", pdfIds: [2], eventCount: 1, cleared: true, events: [] }),
	});
	try {
		await bridge.ready;
		assert.equal(await fetchHookContext({ runtimeRoot, prompt: "next prompt" }), "");
	} finally {
		await bridge.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("stdio runtime with hooks starts bridge and fetch-info drains it", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-runtime-"));
	const runtimeRoot = join(baseDir, "runtime");
	await withRuntimeEnv(runtimeRoot, "stdio-hooks-agent", async () => {
		const runtime = new TexActionsStdioMcpRuntime({
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			launchCwd: baseDir,
			hooksEnabled: true,
			pdfOperations: {
				fetchPdfContext: async () => ({
					text: "## PDF marks from the User\n\n- `main.tex:7` — `y`",
					pdfIds: [9],
					eventCount: 1,
					cleared: true,
					events: [],
				}),
			},
		});
		try {
			runtime.start();
			await waitForFile(hookContextBridgeDiscoveryPath(join(runtimeRoot, "agents", "stdio-hooks-agent")));
			assert.equal(await fetchHookContext({ prompt: "next prompt" }), "## PDF marks from the User\n\n- `main.tex:7` — `y`");
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("actual agent-synctex mcp --harness writes bridge discovery file", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-entrypoint-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(cwd, { recursive: true });
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	const child = spawn(process.execPath, [scriptPath, "mcp", "--harness", "claude"], {
		cwd,
		env: { ...process.env, MCP_TMPDIR: runtimeRoot, TEX_ACTIONS_AGENT_ID: "entrypoint-hooks-agent" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exitPromise = new Promise<void>((resolveExit) => {
		child.once("exit", () => resolveExit());
		child.once("error", () => resolveExit());
	});
	try {
		await waitForFile(hookContextBridgeDiscoveryPath(join(runtimeRoot, "agents", "entrypoint-hooks-agent")));
	} finally {
		child.kill("SIGTERM");
		await Promise.race([exitPromise, new Promise((resolveWait) => setTimeout(resolveWait, 300))]);
		child.kill("SIGKILL");
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("fetchHookContext falls back to persistent Viewer Host when MCP bridge is gone", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-persistent-host-"));
	const runtimeRoot = join(baseDir, "runtime");
	const runtimeDir = join(runtimeRoot, "agents", "agent-synctex-codex");
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	mkdirSync(runtimeDir, { recursive: true });
	writeFileSync(pdfPath, "%PDF-1.4\n% fallback\n%%EOF\n");
	writeFileSync(sourcePath, "Marked source line.\n");
	const registry = new ViewerHostPdfRegistry();
	const controlToken = "persistent-fallback-control-token";
	const server = new ViewerHostServer({ registry, controlToken });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 12, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		writeFileSync(join(runtimeDir, "viewer-host.json"), JSON.stringify({ origin: server.origin, app_url: server.appUrl, control_token: controlToken, updated_at: new Date().toISOString() }) + "\n");
		const config = await (await fetch(`${server.origin}/config/12.json`)).json() as { viewer_socket_url: string };
		socket = await openViewerSocket(config.viewer_socket_url);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: sourcePath, line: 1, source_line: "Marked source line.", comment: "fallback note" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		const context = await fetchHookContext({ runtimeRoot, agentId: "agent-synctex-codex", cwd: baseDir });
		assert.equal(context, "## PDF marks from the User\n\n- `main.tex:1` — `Marked source line.`\n  User comment: fallback note");
		assert.equal(await fetchHookContext({ runtimeRoot, agentId: "agent-synctex-codex", cwd: baseDir }), "");
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("agent-synctex fetch-info prints bridge context", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "agent-synctex-fetch-context-"));
	const runtimeRoot = join(baseDir, "runtime");
	const runtimeDir = join(runtimeRoot, "agents", "agent-synctex-codex");
	mkdirSync(runtimeDir, { recursive: true });
	const bridge = startHookContextBridge({
		runtimeDir,
		fetchContext: async () => ({
			text: "## PDF marks from the User\n\n- `main.tex:9` — `z`",
			pdfIds: [2],
			eventCount: 1,
			cleared: true,
			events: [],
		}),
	});
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	try {
		await bridge.ready;
		const child = spawn(process.execPath, [scriptPath, "fetch-info", "--harness", "codex", "--agent-id", "agent-synctex-codex"], {
			env: { ...process.env, MCP_TMPDIR: runtimeRoot, TEX_ACTIONS_AGENT_ID: "unused-legacy-agent" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stdin.end("prompt");
		const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
		assert.equal(code, 0);
		assert.equal(stdout, "## PDF marks from the User\n\n- `main.tex:9` — `z`");
	} finally {
		await bridge.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("agent-synctex fetch-info exits 0 with empty output when bridge is unavailable", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "agent-synctex-fetch-empty-"));
	const runtimeRoot = join(baseDir, "runtime");
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	const child = spawn(process.execPath, [scriptPath, "fetch-info", "--harness", "codex"], {
		env: { ...process.env, MCP_TMPDIR: runtimeRoot, TEX_ACTIONS_AGENT_ID: "no-bridge" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.on("data", (chunk) => { stdout += String(chunk); });
	child.stdin.end("prompt");
	const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
	try {
		assert.equal(code, 0);
		assert.equal(stdout, "");
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

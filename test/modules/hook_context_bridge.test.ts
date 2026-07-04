import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fetchHookContext, hookContextBridgeDiscoveryPath, startHookContextBridge } from "../../src/modules/hook_context_bridge.ts";
import { TexActionsStdioMcpRuntime } from "../../src/modules/stdio_mcp_runtime.ts";

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
			text: "## PDF marks from Agent SyncTeX\n\n- `main.tex:42` — `x`\n  User comment: note",
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
			assert.equal(await fetchHookContext({ prompt: "please use marks" }), "## PDF marks from Agent SyncTeX\n\n- `main.tex:42` — `x`\n  User comment: note");
		});
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
					text: "## PDF marks from Agent SyncTeX\n\n- `main.tex:7` — `y`",
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
			assert.equal(await fetchHookContext({ prompt: "next prompt" }), "## PDF marks from Agent SyncTeX\n\n- `main.tex:7` — `y`");
		} finally {
			runtime.close();
		}
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("actual tex-actions-mcp --with-hooks writes bridge discovery file", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-entrypoint-"));
	const cwd = join(baseDir, "project");
	const runtimeRoot = join(baseDir, "runtime");
	mkdirSync(cwd, { recursive: true });
	const scriptPath = resolve(process.cwd(), "scripts", "tex-actions-mcp.ts");
	const child = spawn(process.execPath, [scriptPath, "--with-hooks"], {
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

test("agent-synctex fetch-info prints bridge context", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "agent-synctex-fetch-context-"));
	const runtimeRoot = join(baseDir, "runtime");
	const runtimeDir = join(runtimeRoot, "agents", "cli-bridge-agent");
	mkdirSync(runtimeDir, { recursive: true });
	const bridge = startHookContextBridge({
		runtimeDir,
		fetchContext: async () => ({
			text: "## PDF marks from Agent SyncTeX\n\n- `main.tex:9` — `z`",
			pdfIds: [2],
			eventCount: 1,
			cleared: true,
			events: [],
		}),
	});
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	try {
		await bridge.ready;
		const child = spawn(process.execPath, [scriptPath, "fetch-info"], {
			env: { ...process.env, MCP_TMPDIR: runtimeRoot, TEX_ACTIONS_AGENT_ID: "cli-bridge-agent" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stdin.end("prompt");
		const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
		assert.equal(code, 0);
		assert.equal(stdout, "## PDF marks from Agent SyncTeX\n\n- `main.tex:9` — `z`");
	} finally {
		await bridge.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("agent-synctex fetch-info exits 0 with empty output when bridge is unavailable", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "agent-synctex-fetch-empty-"));
	const runtimeRoot = join(baseDir, "runtime");
	const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
	const child = spawn(process.execPath, [scriptPath, "fetch-info"], {
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

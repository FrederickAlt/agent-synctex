import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgentSynctexCli } from "../../src/modules/installer/cli.ts";

function tempProject(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function runCli(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const code = await runAgentSynctexCli([...args, "--cwd", cwd], {
		stdout: { write(chunk: string | Uint8Array): boolean { stdout += String(chunk); return true; } },
		stderr: { write(chunk: string | Uint8Array): boolean { stderr += String(chunk); return true; } },
	});
	return { code, stdout, stderr };
}

async function withInstallerHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousClineSettings = process.env.CLINE_MCP_SETTINGS_PATH;
	const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.CLINE_MCP_SETTINGS_PATH;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousClineSettings === undefined) delete process.env.CLINE_MCP_SETTINGS_PATH;
		else process.env.CLINE_MCP_SETTINGS_PATH = previousClineSettings;
		if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
	}
}

function assertMcpServerLaunch(server: { command?: unknown; args?: unknown }, harness: string, extraArgs: string[] = []): void {
	assert.equal(server.command, process.execPath);
	assert.ok(Array.isArray(server.args));
	assert.match(String(server.args[0]), /agent-synctex\.(?:js|ts)$/);
	assert.deepEqual(server.args.slice(1), ["mcp", "--harness", harness, ...extraArgs]);
}

function assertOpencodeMcpCommand(command: unknown, harness: string): void {
	assert.ok(Array.isArray(command));
	assert.equal(command[0], process.execPath);
	assert.match(String(command[1]), /agent-synctex\.(?:js|ts)$/);
	assert.deepEqual(command.slice(2), ["mcp", "--harness", harness]);
}

function assertCodexMcpConfigLaunch(config: string, harness: string): void {
	assert.match(config, new RegExp(`command = ${escapeRegExp(JSON.stringify(process.execPath))}`));
	assert.match(config, new RegExp(`args = \\[[^\\n]*agent-synctex\\.(?:js|ts)","mcp","--harness","${escapeRegExp(harness)}"`));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("default all installer writes user/global MCP config and hooks for detected harness directories", async () => {
	const cwd = tempProject("agent-synctex-global-cwd-{}");
	const home = tempProject("agent-synctex-global-home-{}");
	try {
		await withInstallerHome(home, async () => {
			mkdirSync(join(home, ".claude"), { recursive: true });
			mkdirSync(join(home, ".codex"), { recursive: true });
			mkdirSync(join(home, "Documents", "Cline"), { recursive: true });
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			mkdirSync(join(home, ".config", "opencode"), { recursive: true });
			const result = await runCli(cwd, ["install", "--harness", "all"]);
			assert.equal(result.code, 0, result.stderr);

			const claudeMcp = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
			assertMcpServerLaunch(claudeMcp.mcpServers["agent-synctex"], "claude");
			assert.match(readFileSync(join(home, ".claude", "hooks", "agent-synctex-fetch-info.sh"), "utf8"), /agent-synctex fetch-info --harness 'claude'/);

			const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
			assertCodexMcpConfigLaunch(codexConfig, "codex");
			const codexHooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
			assert.equal(codexHooks.hooks.UserPromptSubmit[0].hooks[0].command, join(home, ".codex", "hooks", "agent-synctex-user-prompt-submit.mjs"));
			assert.equal(codexHooks.hooks.PreToolUse[0].matcher, "mcp__agent[-_]synctex__.*");
			assert.equal(codexHooks.hooks.PreToolUse[0].hooks[0].command, join(home, ".codex", "hooks", "agent-synctex-pre-tool-use.mjs"));
			assert.match(readFileSync(join(home, ".codex", "hooks", "agent-synctex-user-prompt-submit.mjs"), "utf8"), /hookEventName: "UserPromptSubmit"/);
			assert.match(readFileSync(join(home, ".codex", "hooks", "agent-synctex-pre-tool-use.mjs"), "utf8"), /updatedInput/);

			const clineMcp = JSON.parse(readFileSync(join(home, ".cline", "data", "settings", "cline_mcp_settings.json"), "utf8"));
			assertMcpServerLaunch(clineMcp.mcpServers["agent-synctex"], "cline");
			assert.match(readFileSync(join(home, "Documents", "Cline", "Hooks", "UserPromptSubmit"), "utf8"), /agent-synctex fetch-info --harness 'cline'/);

			const piMcp = JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf8"));
			assertMcpServerLaunch(piMcp.mcpServers["agent-synctex"], "pi");
			assert.equal(piMcp.mcpServers["agent-synctex"].lifecycle, "keep-alive");
			const piExtension = readFileSync(join(home, ".pi", "agent", "extensions", "agent-synctex-post-user.ts"), "utf8");
			assert.match(piExtension, /spawnSync\("agent-synctex", args/);
			assert.match(piExtension, /spawnSync\(shell, \["-lc", "exec agent-synctex/);
			assert.match(piExtension, /Agent SyncTeX hook failed: " \+ context\.error/);
			assert.match(piExtension, /args = \["fetch-info", "--harness", "pi"\]/);
			assert.match(piExtension, /pi\.on\("tool_call"/);
			assert.match(piExtension, /sessionIdFromContext/);
			assert.match(piExtension, /args\.push\("--agent-id", sessionId\)/);

			const opencode = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
			assertOpencodeMcpCommand(opencode.mcp["agent-synctex"].command, "opencode");
			assert.match(readFileSync(join(home, ".config", "opencode", "plugins", "agent-synctex-post-user.ts"), "utf8"), /spawnSync\("agent-synctex", \["fetch-info", "--harness", "opencode"\]/);
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("all installer skips harnesses without a scope directory", async () => {
	const cwd = tempProject("agent-synctex-all-skip-cwd-{}");
	const home = tempProject("agent-synctex-all-skip-home-{}");
	try {
		await withInstallerHome(home, async () => {
			mkdirSync(join(home, ".claude"), { recursive: true });
			const result = await runCli(cwd, ["install", "--harness", "all"]);
			assert.equal(result.code, 0, result.stderr);

			assert.equal(existsSync(join(home, ".claude.json")), true);
			assert.equal(existsSync(join(home, ".codex", "config.toml")), false);
			assert.equal(existsSync(join(home, ".cline", "data", "settings", "cline_mcp_settings.json")), false);
			assert.equal(existsSync(join(home, ".pi", "agent", "mcp.json")), false);
			assert.equal(existsSync(join(home, ".config", "opencode", "opencode.json")), false);
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});


test("combined local install writes MCP config and hooks without user/global paths", async () => {
	const cwd = tempProject("agent-synctex-local-combined-{}");
	const home = tempProject("agent-synctex-local-home-{}");
	try {
		await withInstallerHome(home, async () => {
			const result = await runCli(cwd, ["install", "--harness", "claude", "--local"]);
			assert.equal(result.code, 0, result.stderr);
			const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
			assertMcpServerLaunch(mcp.mcpServers["agent-synctex"], "claude");
			assert.equal(existsSync(join(cwd, ".claude", "hooks", "agent-synctex-fetch-info.sh")), true);
			assert.equal(existsSync(join(home, ".claude.json")), false);
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});


test("combined local install with --no-hooks writes manual MCP config only", async () => {
	const cwd = tempProject("agent-synctex-local-no-hooks-{}");
	try {
		const result = await runCli(cwd, ["install", "--harness", "claude", "--local", "--no-hooks"]);
		assert.equal(result.code, 0, result.stderr);
		const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
		assertMcpServerLaunch(mcp.mcpServers["agent-synctex"], "claude", ["--no-hooks"]);
		assert.equal(existsSync(join(cwd, ".claude", "hooks", "agent-synctex-fetch-info.sh")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("Claude installer stages MCP config, hook config, and atomic uninstall", async () => {
	const cwd = tempProject("agent-synctex-claude-{}");
	try {
		assert.equal((await runCli(cwd, ["install", "mcp", "--harness", "claude", "--local"])).code, 0);
		const mcpOnly = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
		assertMcpServerLaunch(mcpOnly.mcpServers["agent-synctex"], "claude");

		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "claude", "--local"])).code, 0);
		const mcpWithHooks = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
		assertMcpServerLaunch(mcpWithHooks.mcpServers["agent-synctex"], "claude");
		const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
		assert.equal(settings.hooks.UserPromptSubmit.length, 1);
		assert.match(readFileSync(join(cwd, ".claude", "hooks", "agent-synctex-fetch-info.sh"), "utf8"), /Managed by agent-synctex/);

		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "claude", "--local"])).code, 0);
		const settingsAfterSecondInstall = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
		assert.equal(settingsAfterSecondInstall.hooks.UserPromptSubmit.length, 1);

		assert.equal((await runCli(cwd, ["uninstall", "--harness", "claude", "--local"])).code, 0);
		const removedMcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
		assert.equal(removedMcp.mcpServers, undefined);
		assert.equal(existsSync(join(cwd, ".claude", "hooks", "agent-synctex-fetch-info.sh")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("OpenCode installer writes chat.message plugin wrapper", async () => {
	const cwd = tempProject("agent-synctex-opencode-{}");
	try {
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "opencode", "--local"])).code, 0);
		assert.equal((await runCli(cwd, ["install", "mcp", "--harness", "opencode", "--local"])).code, 0);
		const config = JSON.parse(readFileSync(join(cwd, "opencode.json"), "utf8"));
		assertOpencodeMcpCommand(config.mcp["agent-synctex"].command, "opencode");
		const plugin = readFileSync(join(cwd, ".opencode", "plugins", "agent-synctex-post-user.ts"), "utf8");
		assert.match(plugin, /"chat\.message"/);
		assert.match(plugin, /output\.parts/);
		assert.match(plugin, /agent-synctex/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Pi installer combined install reports MCP config once and writes standalone before_agent_start extension wrapper", async () => {
	const cwd = tempProject("agent-synctex-pi-{}");
	try {
		const combined = await runCli(cwd, ["install", "--harness", "pi", "--local"]);
		assert.equal(combined.code, 0, combined.stderr);
		assert.equal((combined.stdout.match(/installed agent-synctex MCP config/g) ?? []).length, 1);
		rmSync(join(cwd, ".pi"), { recursive: true, force: true });
		assert.equal((await runCli(cwd, ["install", "mcp", "--harness", "pi", "--local"])).code, 0);
		const mcp = JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8"));
		assertMcpServerLaunch(mcp.mcpServers["agent-synctex"], "pi");
		assert.equal(mcp.mcpServers["agent-synctex"].lifecycle, "keep-alive");
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "pi", "--local"])).code, 0);
		const extension = readFileSync(join(cwd, ".pi", "extensions", "agent-synctex-post-user.ts"), "utf8");
		assert.match(extension, /before_agent_start/);
		assert.match(extension, /agent-synctex/);
		assert.match(extension, /fetch-info", "--harness", "pi"/);
		assert.match(extension, /systemPromptOptions\?\.cwd/);
		assert.match(extension, /args\.push\("--cwd", cwd\)/);
		assert.match(extension, /args\.push\("--agent-id", sessionId\)/);
		assert.match(extension, /pi\.on\("tool_call"/);
		assert.match(extension, /_agent_synctex/);
		assert.match(extension, /process\.env\.SHELL\?\.trim\(\) \|\| "\/bin\/sh"/);
		assert.match(extension, /Agent SyncTeX hook failed/);
		assert.doesNotMatch(extension, /registerTool/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Codex and Cline installers write new single-CLI MCP and hook commands", async () => {
	const cwd = tempProject("agent-synctex-codex-cline-{}");
	try {
		assert.equal((await runCli(cwd, ["install", "mcp", "--harness", "codex", "--local"])).code, 0);
		assertCodexMcpConfigLaunch(readFileSync(join(cwd, ".codex", "config.toml"), "utf8"), "codex");
		mkdirSync(join(cwd, ".codex"), { recursive: true });
		writeFileSync(join(cwd, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ type: "command", command: "./.codex/hooks/agent-synctex-fetch-info.sh" }] } }) + "\n");
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "codex", "--local"])).code, 0);
		assert.match(readFileSync(join(cwd, ".codex", "hooks", "agent-synctex-user-prompt-submit.mjs"), "utf8"), /--agent-id/);
		assert.match(readFileSync(join(cwd, ".codex", "hooks", "agent-synctex-pre-tool-use.mjs"), "utf8"), /_agent_synctex/);
		assert.equal(existsSync(join(cwd, ".codex", "hooks", "agent-synctex-fetch-info.sh")), false);
		const codexHooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf8"));
		assert.equal(codexHooks.hooks.UserPromptSubmit.length, 1);
		assert.equal(codexHooks.hooks.UserPromptSubmit[0].hooks[0].type, "command");
		assert.equal(codexHooks.hooks.PreToolUse.length, 1);
		assert.equal(codexHooks.hooks.PreToolUse[0].matcher, "mcp__agent[-_]synctex__.*");

		assert.equal((await runCli(cwd, ["install", "mcp", "--harness", "cline", "--no-hooks", "--local"])).code, 0);
		const clineMcp = JSON.parse(readFileSync(join(cwd, ".cline_mcp_settings.json"), "utf8"));
		assertMcpServerLaunch(clineMcp.mcpServers["agent-synctex"], "cline", ["--no-hooks"]);
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "cline", "--local"])).code, 0);
		assert.match(readFileSync(join(cwd, ".clinerules", "hooks", "UserPromptSubmit"), "utf8"), /agent-synctex fetch-info --harness 'cline'/);
		const clineMcpAfterHooks = JSON.parse(readFileSync(join(cwd, ".cline_mcp_settings.json"), "utf8"));
		assertMcpServerLaunch(clineMcpAfterHooks.mcpServers["agent-synctex"], "cline");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("viewer native installer commands are not part of the CLI", async () => {
	const cwd = tempProject("agent-synctex-no-viewer-installer-{}");
	try {
		const install = await runCli(cwd, ["install", "viewer"]);
		assert.equal(install.code, 1);
		assert.match(install.stderr, /install subcommand must be mcp or hooks/);

		const uninstall = await runCli(cwd, ["uninstall", "viewer"]);
		assert.equal(uninstall.code, 1);
		assert.match(uninstall.stderr, /Unknown uninstall target: viewer/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

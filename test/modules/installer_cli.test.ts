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

test("default installer writes user/global MCP config and hooks for all harnesses", async () => {
	const cwd = tempProject("agent-synctex-global-cwd-{}");
	const home = tempProject("agent-synctex-global-home-{}");
	try {
		await withInstallerHome(home, async () => {
			const result = await runCli(cwd, ["install", "--harness", "all"]);
			assert.equal(result.code, 0, result.stderr);

			const claudeMcp = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
			assert.deepEqual(claudeMcp.mcpServers["agent-synctex"].args, ["mcp", "--harness", "claude"]);
			assert.match(readFileSync(join(home, ".claude", "hooks", "agent-synctex-fetch-info.sh"), "utf8"), /agent-synctex fetch-info --harness 'claude'/);

			const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
			assert.match(codexConfig, /command = "agent-synctex"\nargs = \["mcp", "--harness", "codex"\]/);
			const codexHooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
			assert.equal(codexHooks.hooks.UserPromptSubmit[0].hooks[0].command, join(home, ".codex", "hooks", "agent-synctex-fetch-info.sh"));
			assert.match(readFileSync(join(home, ".codex", "hooks", "agent-synctex-fetch-info.sh"), "utf8"), /hookSpecificOutput: \{ hookEventName: "UserPromptSubmit", additionalContext:/);

			const clineMcp = JSON.parse(readFileSync(join(home, ".cline", "data", "settings", "cline_mcp_settings.json"), "utf8"));
			assert.deepEqual(clineMcp.mcpServers["agent-synctex"].args, ["mcp", "--harness", "cline"]);
			assert.match(readFileSync(join(home, "Documents", "Cline", "Hooks", "UserPromptSubmit"), "utf8"), /agent-synctex fetch-info --harness 'cline'/);

			const piMcp = JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf8"));
			assert.deepEqual(piMcp.mcpServers["agent-synctex"].args, ["mcp", "--harness", "pi"]);
			assert.equal(piMcp.mcpServers["agent-synctex"].lifecycle, "keep-alive");
			const piExtension = readFileSync(join(home, ".pi", "agent", "extensions", "agent-synctex-post-user.ts"), "utf8");
			assert.match(piExtension, /spawnSync\("agent-synctex", args/);
			assert.match(piExtension, /spawnSync\(shell, \["-lc", "exec agent-synctex/);
			assert.match(piExtension, /Agent SyncTeX hook failed: " \+ context\.error/);
			assert.match(piExtension, /args = \["fetch-info", "--harness", "pi"\]/);

			const opencode = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
			assert.deepEqual(opencode.mcp["agent-synctex"].command, ["agent-synctex", "mcp", "--harness", "opencode"]);
			assert.match(readFileSync(join(home, ".config", "opencode", "plugins", "agent-synctex-post-user.ts"), "utf8"), /spawnSync\("agent-synctex", \["fetch-info", "--harness", "opencode"\]/);
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
			assert.deepEqual(mcp.mcpServers["agent-synctex"].args, ["mcp", "--harness", "claude"]);
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
		assert.deepEqual(mcp.mcpServers["agent-synctex"].args, ["mcp", "--harness", "claude", "--no-hooks"]);
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
		assert.deepEqual(mcpOnly.mcpServers["agent-synctex"].args, ["mcp", "--harness", "claude"]);

		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "claude", "--local"])).code, 0);
		const mcpWithHooks = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
		assert.deepEqual(mcpWithHooks.mcpServers["agent-synctex"].args, ["mcp", "--harness", "claude"]);
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
		assert.deepEqual(config.mcp["agent-synctex"].command, ["agent-synctex", "mcp", "--harness", "opencode"]);
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
		assert.deepEqual(mcp.mcpServers["agent-synctex"].args, ["mcp", "--harness", "pi"]);
		assert.equal(mcp.mcpServers["agent-synctex"].lifecycle, "keep-alive");
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "pi", "--local"])).code, 0);
		const extension = readFileSync(join(cwd, ".pi", "extensions", "agent-synctex-post-user.ts"), "utf8");
		assert.match(extension, /before_agent_start/);
		assert.match(extension, /agent-synctex/);
		assert.match(extension, /fetch-info", "--harness", "pi"/);
		assert.match(extension, /systemPromptOptions\?\.cwd/);
		assert.match(extension, /args\.push\("--cwd", cwd\)/);
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
		assert.match(readFileSync(join(cwd, ".codex", "config.toml"), "utf8"), /command = "agent-synctex"\nargs = \["mcp", "--harness", "codex"\]/);
		mkdirSync(join(cwd, ".codex"), { recursive: true });
		writeFileSync(join(cwd, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ type: "command", command: "./.codex/hooks/agent-synctex-fetch-info.sh" }] } }) + "\n");
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "codex", "--local"])).code, 0);
		assert.match(readFileSync(join(cwd, ".codex", "hooks", "agent-synctex-fetch-info.sh"), "utf8"), /agent-synctex fetch-info --harness 'codex'/);
		const codexHooks = JSON.parse(readFileSync(join(cwd, ".codex", "hooks.json"), "utf8"));
		assert.equal(codexHooks.hooks.UserPromptSubmit.length, 1);
		assert.equal(codexHooks.hooks.UserPromptSubmit[0].hooks[0].type, "command");

		assert.equal((await runCli(cwd, ["install", "mcp", "--harness", "cline", "--no-hooks", "--local"])).code, 0);
		const clineMcp = JSON.parse(readFileSync(join(cwd, ".cline_mcp_settings.json"), "utf8"));
		assert.deepEqual(clineMcp.mcpServers["agent-synctex"].args, ["mcp", "--harness", "cline", "--no-hooks"]);
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "cline", "--local"])).code, 0);
		assert.match(readFileSync(join(cwd, ".clinerules", "hooks", "UserPromptSubmit"), "utf8"), /agent-synctex fetch-info --harness 'cline'/);
		const clineMcpAfterHooks = JSON.parse(readFileSync(join(cwd, ".cline_mcp_settings.json"), "utf8"));
		assert.deepEqual(clineMcpAfterHooks.mcpServers["agent-synctex"].args, ["mcp", "--harness", "cline"]);
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

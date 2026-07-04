import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("Claude installer stages MCP config, hook config, and atomic uninstall", async () => {
	const cwd = tempProject("agent-synctex-claude-{}");
	try {
		assert.equal((await runCli(cwd, ["install", "mcp", "--harness", "claude"])).code, 0);
		const mcpOnly = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
		assert.deepEqual(mcpOnly.mcpServers["agent-synctex"].args, []);

		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "claude"])).code, 0);
		const mcpWithHooks = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
		assert.deepEqual(mcpWithHooks.mcpServers["agent-synctex"].args, ["--with-hooks"]);
		const settings = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
		assert.equal(settings.hooks.UserPromptSubmit.length, 1);
		assert.match(readFileSync(join(cwd, ".claude", "hooks", "agent-synctex-fetch-info.sh"), "utf8"), /Managed by agent-synctex/);

		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "claude"])).code, 0);
		const settingsAfterSecondInstall = JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8"));
		assert.equal(settingsAfterSecondInstall.hooks.UserPromptSubmit.length, 1);

		assert.equal((await runCli(cwd, ["uninstall", "--harness", "claude"])).code, 0);
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
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "opencode"])).code, 0);
		const config = JSON.parse(readFileSync(join(cwd, "opencode.jsonc"), "utf8"));
		assert.deepEqual(config.mcp["agent-synctex"].command, ["tex-actions-mcp", "--with-hooks"]);
		const plugin = readFileSync(join(cwd, ".opencode", "plugins", "agent-synctex-post-user.ts"), "utf8");
		assert.match(plugin, /"chat\.message"/);
		assert.match(plugin, /output\.parts/);
		assert.match(plugin, /agent-synctex/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Pi installer writes standalone before_agent_start extension wrapper", async () => {
	const cwd = tempProject("agent-synctex-pi-{}");
	try {
		assert.equal((await runCli(cwd, ["install", "hooks", "--harness", "pi"])).code, 0);
		const extension = readFileSync(join(cwd, ".pi", "extensions", "agent-synctex-post-user.ts"), "utf8");
		assert.match(extension, /before_agent_start/);
		assert.match(extension, /agent-synctex/);
		assert.match(extension, /fetch-info/);
		assert.doesNotMatch(extension, /registerTool/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { MANAGED_MARKER, agentSynctexMcpLaunchConfig, change, homePath, isRecord, managedCodexPreToolUseScript, managedCodexUserPromptSubmitScript, pathExists, projectPath, readJsonObject, readText, removeManagedFile, removeManagedTomlBlock, scopePath, upsertManagedTomlBlock, writeJsonObject, writeText } from "../config_edit.ts";

const MCP_BLOCK_ID = "mcp:codex";

function userPromptHookScriptPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".codex", "hooks", "agent-synctex-user-prompt-submit.mjs"], [".codex", "hooks", "agent-synctex-user-prompt-submit.mjs"]);
}

function preToolUseHookScriptPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".codex", "hooks", "agent-synctex-pre-tool-use.mjs"], [".codex", "hooks", "agent-synctex-pre-tool-use.mjs"]);
}

function userPromptHookCommand(ctx: InstallerContext): string {
	return ctx.scope === "user" ? homePath(".codex", "hooks", "agent-synctex-user-prompt-submit.mjs") : "./.codex/hooks/agent-synctex-user-prompt-submit.mjs";
}

function preToolUseHookCommand(ctx: InstallerContext): string {
	return ctx.scope === "user" ? homePath(".codex", "hooks", "agent-synctex-pre-tool-use.mjs") : "./.codex/hooks/agent-synctex-pre-tool-use.mjs";
}

function hooksJsonPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".codex", "hooks.json"], [".codex", "hooks.json"]);
}

function mcpPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".codex", "config.toml"], [".codex", "config.toml"]);
}

export const codexAdapter: HarnessAdapter = {
	id: "codex",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".codex"))) return { id: "codex", detected: true, reason: ".codex/ exists" };
		return { id: "codex", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertCodexMcp(ctx);
	},
	installHooks(ctx): InstallChange[] {
		const changes: InstallChange[] = [];
		const userPromptScriptPath = userPromptHookScriptPath(ctx);
		const preToolUseScriptPath = preToolUseHookScriptPath(ctx);
		writeText(ctx, userPromptScriptPath, managedCodexUserPromptSubmitScript(), 0o755);
		writeText(ctx, preToolUseScriptPath, managedCodexPreToolUseScript(), 0o755);
		changes.push(change("installed Codex UserPromptSubmit hook script", userPromptScriptPath));
		changes.push(change("installed Codex PreToolUse session injection hook script", preToolUseScriptPath));
		changes.push(...upsertCodexHook(ctx));
		changes.push(...removeManagedFile(ctx, legacyHookScriptPath(ctx)));
		changes.push(...removeNoHooksFromManagedMcp(ctx));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeManagedTomlBlock(ctx, mcpPath(ctx), MCP_BLOCK_ID),
			...removeCodexHook(ctx),
			...removeManagedFile(ctx, userPromptHookScriptPath(ctx)),
			...removeManagedFile(ctx, preToolUseHookScriptPath(ctx)),
			...removeManagedFile(ctx, legacyHookScriptPath(ctx)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "codex", level: "warning", message: "Codex command hooks may need to be reviewed/trusted before they run." }];
	},
};

function upsertCodexMcp(ctx: InstallerContext): InstallChange[] {
	const launchConfig = agentSynctexMcpLaunchConfig("codex", ctx.noHooks);
	const body = `
[mcp_servers.agent-synctex]
command = ${JSON.stringify(launchConfig.command)}
args = ${JSON.stringify(launchConfig.args)}
`;
	return upsertManagedTomlBlock(ctx, mcpPath(ctx), MCP_BLOCK_ID, body);
}

function legacyHookScriptPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".codex", "hooks", "agent-synctex-fetch-info.sh"], [".codex", "hooks", "agent-synctex-fetch-info.sh"]);
}

function upsertCodexHook(ctx: InstallerContext): InstallChange[] {
	const path = hooksJsonPath(ctx);
	const config = readJsonObject(path);
	const hooks = isRecord(config.hooks) ? { ...config.hooks } : {};
	const existingUserPrompt = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry)) : [];
	existingUserPrompt.push({ hooks: [{ type: "command", command: userPromptHookCommand(ctx) }] });
	hooks.UserPromptSubmit = existingUserPrompt;
	const existingPreToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.filter((entry) => !isManagedHookEntry(entry)) : [];
	existingPreToolUse.push({ matcher: "mcp__agent[-_]synctex__.*", hooks: [{ type: "command", command: preToolUseHookCommand(ctx) }] });
	hooks.PreToolUse = existingPreToolUse;
	config.hooks = hooks;
	writeJsonObject(ctx, path, config);
	return [change("installed Codex UserPromptSubmit and PreToolUse hook entries", path)];
}

function removeNoHooksFromManagedMcp(ctx: InstallerContext): InstallChange[] {
	const path = mcpPath(ctx);
	const current = readText(path);
	if (current === undefined || !current.includes(MANAGED_MARKER) || !current.includes("--no-hooks")) return [];
	return upsertCodexMcp({ ...ctx, noHooks: false });
}

function removeCodexHook(ctx: InstallerContext): InstallChange[] {
	const path = hooksJsonPath(ctx);
	if (!pathExists(path)) return [];
	const config = readJsonObject(path);
	if (!isRecord(config.hooks)) return [];
	let changed = false;
	const hooks = { ...config.hooks };
	for (const hookName of ["UserPromptSubmit", "PreToolUse"]) {
		if (!Array.isArray(hooks[hookName])) continue;
		const next = hooks[hookName].filter((entry) => !isManagedHookEntry(entry));
		if (next.length === hooks[hookName].length) continue;
		changed = true;
		if (next.length === 0) delete hooks[hookName];
		else hooks[hookName] = next;
	}
	if (!changed) return [];
	config.hooks = hooks;
	writeJsonObject(ctx, path, config);
	return [change("removed Codex hook entries", path)];
}

function isManagedHookEntry(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	if (typeof entry.command === "string" && isManagedCodexHookCommand(entry.command)) return true;
	if (!Array.isArray(entry.hooks)) return false;
	return entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && isManagedCodexHookCommand(hook.command));
}

function isManagedCodexHookCommand(command: string): boolean {
	return command.includes("agent-synctex-fetch-info.sh")
		|| command.includes("agent-synctex-user-prompt-submit.mjs")
		|| command.includes("agent-synctex-pre-tool-use.mjs");
}

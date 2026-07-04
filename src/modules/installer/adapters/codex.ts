import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { agentIdForHarness, change, isRecord, managedShellScript, pathExists, projectPath, readJsonObject, removeManagedFile, removeManagedTomlBlock, upsertManagedTomlBlock, writeJsonObject, writeText } from "../config_edit.ts";

const HOOK_SCRIPT = ".codex/hooks/agent-synctex-fetch-info.sh";
const HOOK_COMMAND = `./${HOOK_SCRIPT}`;
const MCP_BLOCK_ID = "mcp:codex";

export const codexAdapter: HarnessAdapter = {
	id: "codex",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".codex"))) return { id: "codex", detected: true, reason: ".codex/ exists" };
		return { id: "codex", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertCodexMcp(ctx, false);
	},
	installHooks(ctx): InstallChange[] {
		const changes = upsertCodexMcp(ctx, true);
		const scriptPath = projectPath(ctx, HOOK_SCRIPT);
		writeText(ctx, scriptPath, managedShellScript(agentIdForHarness("codex"), "claude"), 0o755);
		changes.push(change("installed Codex UserPromptSubmit hook script", scriptPath));
		changes.push(...upsertCodexHook(ctx));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeManagedTomlBlock(ctx, projectPath(ctx, ".codex", "config.toml"), MCP_BLOCK_ID),
			...removeCodexHook(ctx),
			...removeManagedFile(ctx, projectPath(ctx, HOOK_SCRIPT)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "codex", level: "warning", message: "Codex project hooks may need to be trusted with /hooks before they run." }];
	},
};

function upsertCodexMcp(ctx: InstallerContext, hooksEnabled: boolean): InstallChange[] {
	const args = hooksEnabled ? "[\"--with-hooks\"]" : "[]";
	const body = `
[mcp_servers.agent-synctex]
command = "tex-actions-mcp"
args = ${args}

[mcp_servers.agent-synctex.env]
TEX_ACTIONS_AGENT_ID = "${agentIdForHarness("codex")}"
`;
	return upsertManagedTomlBlock(ctx, projectPath(ctx, ".codex", "config.toml"), MCP_BLOCK_ID, body);
}

function upsertCodexHook(ctx: InstallerContext): InstallChange[] {
	const path = projectPath(ctx, ".codex", "hooks.json");
	const config = readJsonObject(path);
	const hooks = isRecord(config.hooks) ? { ...config.hooks } : {};
	const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry)) : [];
	existing.push({ type: "command", command: HOOK_COMMAND });
	hooks.UserPromptSubmit = existing;
	config.hooks = hooks;
	writeJsonObject(ctx, path, config);
	return [change("installed Codex UserPromptSubmit hook entry", path)];
}

function removeCodexHook(ctx: InstallerContext): InstallChange[] {
	const path = projectPath(ctx, ".codex", "hooks.json");
	if (!pathExists(path)) return [];
	const config = readJsonObject(path);
	if (!isRecord(config.hooks) || !Array.isArray(config.hooks.UserPromptSubmit)) return [];
	const next = config.hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry));
	if (next.length === config.hooks.UserPromptSubmit.length) return [];
	const hooks = { ...config.hooks };
	if (next.length === 0) delete hooks.UserPromptSubmit;
	else hooks.UserPromptSubmit = next;
	config.hooks = hooks;
	writeJsonObject(ctx, path, config);
	return [change("removed Codex UserPromptSubmit hook entry", path)];
}

function isManagedHookEntry(entry: unknown): boolean {
	return isRecord(entry) && typeof entry.command === "string" && entry.command.includes("agent-synctex-fetch-info.sh");
}

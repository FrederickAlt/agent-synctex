import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { MANAGED_MARKER, change, homePath, isRecord, managedShellScript, pathExists, projectPath, readJsonObject, readText, removeManagedFile, removeManagedTomlBlock, scopePath, upsertManagedTomlBlock, writeJsonObject, writeText } from "../config_edit.ts";

const MCP_BLOCK_ID = "mcp:codex";

function hookScriptPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".codex", "hooks", "agent-synctex-fetch-info.sh"], [".codex", "hooks", "agent-synctex-fetch-info.sh"]);
}

function hookCommand(ctx: InstallerContext): string {
	return ctx.scope === "user" ? homePath(".codex", "hooks", "agent-synctex-fetch-info.sh") : "./.codex/hooks/agent-synctex-fetch-info.sh";
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
		const scriptPath = hookScriptPath(ctx);
		writeText(ctx, scriptPath, managedShellScript("codex", "codex"), 0o755);
		changes.push(change("installed Codex UserPromptSubmit hook script", scriptPath));
		changes.push(...upsertCodexHook(ctx));
		changes.push(...removeNoHooksFromManagedMcp(ctx));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeManagedTomlBlock(ctx, mcpPath(ctx), MCP_BLOCK_ID),
			...removeCodexHook(ctx),
			...removeManagedFile(ctx, hookScriptPath(ctx)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "codex", level: "warning", message: "Codex command hooks may need to be reviewed/trusted before they run." }];
	},
};

function upsertCodexMcp(ctx: InstallerContext): InstallChange[] {
	const args = `["mcp", "--harness", "codex"${ctx.noHooks ? ", \"--no-hooks\"" : ""}]`;
	const body = `
[mcp_servers.agent-synctex]
command = "agent-synctex"
args = ${args}
`;
	return upsertManagedTomlBlock(ctx, mcpPath(ctx), MCP_BLOCK_ID, body);
}

function upsertCodexHook(ctx: InstallerContext): InstallChange[] {
	const path = hooksJsonPath(ctx);
	const config = readJsonObject(path);
	const hooks = isRecord(config.hooks) ? { ...config.hooks } : {};
	const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry)) : [];
	existing.push({ hooks: [{ type: "command", command: hookCommand(ctx) }] });
	hooks.UserPromptSubmit = existing;
	config.hooks = hooks;
	writeJsonObject(ctx, path, config);
	return [change("installed Codex UserPromptSubmit hook entry", path)];
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
	if (!isRecord(entry)) return false;
	if (typeof entry.command === "string" && entry.command.includes("agent-synctex-fetch-info.sh")) return true;
	if (!Array.isArray(entry.hooks)) return false;
	return entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes("agent-synctex-fetch-info.sh"));
}

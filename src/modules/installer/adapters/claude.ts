import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { MCP_SERVER_NAME, change, isRecord, managedShellScript, mcpServerHasNoHooks, pathExists, projectPath, readJsonObject, removeManagedFile, removeMcpServersJson, scopePath, upsertMcpServersJson, writeJsonObject, writeText } from "../config_edit.ts";

function hookScriptPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".claude", "hooks", "agent-synctex-fetch-info.sh"], [".claude", "hooks", "agent-synctex-fetch-info.sh"]);
}

function hookSettingsPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".claude", "settings.json"], [".claude", "settings.json"]);
}

function mcpPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".mcp.json"], [".claude.json"]);
}

export const claudeAdapter: HarnessAdapter = {
	id: "claude",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".claude"))) return { id: "claude", detected: true, reason: ".claude/ exists" };
		if (pathExists(projectPath(ctx, ".mcp.json"))) return { id: "claude", detected: true, reason: ".mcp.json exists" };
		return { id: "claude", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertMcpServersJson(ctx, mcpPath(ctx), "claude", ctx.noHooks);
	},
	installHooks(ctx): InstallChange[] {
		const changes: InstallChange[] = [];
		const scriptPath = hookScriptPath(ctx);
		writeText(ctx, scriptPath, managedShellScript("claude", "claude"), 0o755);
		changes.push(change("installed Claude UserPromptSubmit hook script", scriptPath));
		changes.push(...upsertClaudeHook(ctx, scriptPath));
		changes.push(...removeNoHooksFromManagedMcp(ctx));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeMcpServersJson(ctx, mcpPath(ctx)),
			...removeClaudeHook(ctx),
			...removeManagedFile(ctx, hookScriptPath(ctx)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "claude", level: pathExists(mcpPath(ctx)) ? "ok" : "warning", message: `Claude MCP config path is ${mcpPath(ctx)}` }];
	},
};

function upsertClaudeHook(ctx: InstallerContext, scriptPath: string): InstallChange[] {
	const path = hookSettingsPath(ctx);
	const settings = readJsonObject(path);
	const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
	const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry)) : [];
	existing.push({ matcher: "", hooks: [{ type: "command", command: scriptPath }] });
	hooks.UserPromptSubmit = existing;
	settings.hooks = hooks;
	writeJsonObject(ctx, path, settings);
	return [change("installed Claude UserPromptSubmit hook entry", path)];
}

function removeClaudeHook(ctx: InstallerContext): InstallChange[] {
	const path = hookSettingsPath(ctx);
	if (!pathExists(path)) return [];
	const settings = readJsonObject(path);
	if (!isRecord(settings.hooks) || !Array.isArray(settings.hooks.UserPromptSubmit)) return [];
	const next = settings.hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry));
	if (next.length === settings.hooks.UserPromptSubmit.length) return [];
	const hooks = { ...settings.hooks };
	if (next.length === 0) delete hooks.UserPromptSubmit;
	else hooks.UserPromptSubmit = next;
	settings.hooks = hooks;
	writeJsonObject(ctx, path, settings);
	return [change("removed Claude UserPromptSubmit hook entry", path)];
}

function removeNoHooksFromManagedMcp(ctx: InstallerContext): InstallChange[] {
	const path = mcpPath(ctx);
	if (!pathExists(path)) return [];
	const config = readJsonObject(path);
	if (!mcpServerHasNoHooks(config)) return [];
	return upsertMcpServersJson(ctx, path, "claude", false);
}

function isManagedHookEntry(entry: unknown): boolean {
	if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
	return entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes("agent-synctex-fetch-info.sh"));
}

import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { agentIdForHarness, change, isRecord, managedShellScript, pathExists, projectPath, readJsonObject, removeManagedFile, removeMcpServersJson, upsertMcpServersJson, writeJsonObject, writeText } from "../config_edit.ts";

const HOOK_SCRIPT = ".claude/hooks/agent-synctex-fetch-info.sh";
const HOOK_COMMAND = `./${HOOK_SCRIPT}`;

export const claudeAdapter: HarnessAdapter = {
	id: "claude",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".claude"))) return { id: "claude", detected: true, reason: ".claude/ exists" };
		if (pathExists(projectPath(ctx, ".mcp.json"))) return { id: "claude", detected: true, reason: ".mcp.json exists" };
		return { id: "claude", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertMcpServersJson(ctx, projectPath(ctx, ".mcp.json"), "claude", false);
	},
	installHooks(ctx): InstallChange[] {
		const changes = upsertMcpServersJson(ctx, projectPath(ctx, ".mcp.json"), "claude", true);
		const scriptPath = projectPath(ctx, HOOK_SCRIPT);
		writeText(ctx, scriptPath, managedShellScript(agentIdForHarness("claude"), "claude"), 0o755);
		changes.push(change("installed Claude UserPromptSubmit hook script", scriptPath));
		changes.push(...upsertClaudeHook(ctx));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeMcpServersJson(ctx, projectPath(ctx, ".mcp.json")),
			...removeClaudeHook(ctx),
			...removeManagedFile(ctx, projectPath(ctx, HOOK_SCRIPT)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "claude", level: pathExists(projectPath(ctx, ".mcp.json")) ? "ok" : "warning", message: "Claude project MCP config is .mcp.json" }];
	},
};

function upsertClaudeHook(ctx: InstallerContext): InstallChange[] {
	const path = projectPath(ctx, ".claude", "settings.json");
	const settings = readJsonObject(path);
	const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
	const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry)) : [];
	existing.push({ matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND }] });
	hooks.UserPromptSubmit = existing;
	settings.hooks = hooks;
	writeJsonObject(ctx, path, settings);
	return [change("installed Claude UserPromptSubmit hook entry", path)];
}

function removeClaudeHook(ctx: InstallerContext): InstallChange[] {
	const path = projectPath(ctx, ".claude", "settings.json");
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

function isManagedHookEntry(entry: unknown): boolean {
	if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
	return entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes("agent-synctex-fetch-info.sh"));
}

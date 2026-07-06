import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { change, clineMcpSettingsPath, isRecord, managedShellScript, mcpServerHasNoHooks, pathExists, projectPath, readJsonObject, readText, removeManagedFile, removeMcpServersJson, scopePath, upsertMcpServersJson, writeText } from "../config_edit.ts";

function hookPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".clinerules", "hooks", "UserPromptSubmit"], ["Documents", "Cline", "Hooks", "UserPromptSubmit"]);
}

export const clineAdapter: HarnessAdapter = {
	id: "cline",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".clinerules"))) return { id: "cline", detected: true, reason: ".clinerules/ exists" };
		if (pathExists(projectPath(ctx, ".cline_mcp_settings.json"))) return { id: "cline", detected: true, reason: ".cline_mcp_settings.json exists" };
		return { id: "cline", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertMcpServersJson(ctx, clineMcpSettingsPath(ctx), "cline", ctx.noHooks);
	},
	installHooks(ctx): InstallChange[] {
		const changes: InstallChange[] = [];
		const target = hookPath(ctx);
		const current = readText(target);
		if (current !== undefined && !current.includes("Managed by agent-synctex")) {
			changes.push(change("skipped unmanaged Cline UserPromptSubmit hook; remove or merge it manually", target));
			return changes;
		}
		writeText(ctx, target, managedShellScript("cline", "cline"), 0o755);
		changes.push(change("installed Cline UserPromptSubmit hook", target));
		changes.push(...removeNoHooksFromManagedMcp(ctx));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeMcpServersJson(ctx, clineMcpSettingsPath(ctx)),
			...removeManagedFile(ctx, hookPath(ctx)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "cline", level: pathExists(hookPath(ctx)) ? "ok" : "warning", message: `Cline hook path is ${hookPath(ctx)}.` }];
	},
};

function removeNoHooksFromManagedMcp(ctx: InstallerContext): InstallChange[] {
	const path = clineMcpSettingsPath(ctx);
	if (!pathExists(path)) return [];
	const config = readJsonObject(path);
	if (!mcpServerHasNoHooks(config)) return [];
	return upsertMcpServersJson(ctx, path, "cline", false);
}

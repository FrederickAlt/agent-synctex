import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange } from "../types.ts";
import { agentIdForHarness, change, managedShellScript, pathExists, projectPath, readText, removeManagedFile, removeMcpServersJson, upsertMcpServersJson, writeText } from "../config_edit.ts";

const HOOK_FILE = ".clinerules/hooks/UserPromptSubmit";

export const clineAdapter: HarnessAdapter = {
	id: "cline",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".clinerules"))) return { id: "cline", detected: true, reason: ".clinerules/ exists" };
		if (pathExists(projectPath(ctx, ".cline_mcp_settings.json"))) return { id: "cline", detected: true, reason: ".cline_mcp_settings.json exists" };
		return { id: "cline", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertMcpServersJson(ctx, projectPath(ctx, ".cline_mcp_settings.json"), "cline", false);
	},
	installHooks(ctx): InstallChange[] {
		const changes = upsertMcpServersJson(ctx, projectPath(ctx, ".cline_mcp_settings.json"), "cline", true);
		const hookPath = projectPath(ctx, HOOK_FILE);
		const current = readText(hookPath);
		if (current !== undefined && !current.includes("Managed by agent-synctex")) {
			changes.push(change("skipped unmanaged Cline UserPromptSubmit hook; remove or merge it manually", hookPath));
			return changes;
		}
		writeText(ctx, hookPath, managedShellScript(agentIdForHarness("cline"), "cline"), 0o755);
		changes.push(change("installed Cline UserPromptSubmit hook", hookPath));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeMcpServersJson(ctx, projectPath(ctx, ".cline_mcp_settings.json")),
			...removeManagedFile(ctx, projectPath(ctx, HOOK_FILE)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "cline", level: pathExists(projectPath(ctx, HOOK_FILE)) ? "ok" : "warning", message: "Cline hook path is .clinerules/hooks/UserPromptSubmit." }];
	},
};

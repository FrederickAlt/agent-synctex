import { join } from "node:path";
import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { change, mcpServerHasNoHooks, pathExists, piAgentDir, projectPath, readJsonObject, removeManagedFile, removeMcpServersJson, upsertMcpServersJson, writeText } from "../config_edit.ts";
import { piExtensionSource } from "../pi_extension_source.ts";

function extensionPath(ctx: InstallerContext): string {
	return ctx.scope === "user" ? join(piAgentDir(), "extensions", "agent-synctex-post-user.ts") : projectPath(ctx, ".pi", "extensions", "agent-synctex-post-user.ts");
}

function mcpPath(ctx: InstallerContext): string {
	return ctx.scope === "user" ? join(piAgentDir(), "mcp.json") : projectPath(ctx, ".pi", "mcp.json");
}

export const piAdapter: HarnessAdapter = {
	id: "pi",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".pi"))) return { id: "pi", detected: true, reason: ".pi/ exists" };
		return { id: "pi", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertMcpServersJson(ctx, mcpPath(ctx), "pi", ctx.noHooks, { lifecycle: "keep-alive" });
	},
	installHooks(ctx): InstallChange[] {
		const target = extensionPath(ctx);
		writeText(ctx, target, piExtensionSource());
		return [
			change("installed standalone Pi before_agent_start extension wrapper", target),
			...removeNoHooksFromManagedMcp(ctx),
			change("Pi MCP is configured through pi-mcp-adapter mcp.json"),
		];
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeMcpServersJson(ctx, mcpPath(ctx)),
			...removeManagedFile(ctx, extensionPath(ctx)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "pi", level: pathExists(extensionPath(ctx)) ? "ok" : "warning", message: "Pi hook support is a standalone extension wrapper around before_agent_start." }];
	},
};

function removeNoHooksFromManagedMcp(ctx: InstallerContext): InstallChange[] {
	const path = mcpPath(ctx);
	if (!pathExists(path)) return [];
	const config = readJsonObject(path);
	if (!mcpServerHasNoHooks(config)) return [];
	return upsertMcpServersJson(ctx, path, "pi", false, { lifecycle: "keep-alive" });
}

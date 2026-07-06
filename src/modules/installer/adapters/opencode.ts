import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange, InstallerContext } from "../types.ts";
import { change, opencodeMcpHasNoHooks, parseJsoncObject, pathExists, projectPath, removeManagedFile, removeOpencodeMcp, scopePath, upsertOpencodeMcp, writeText } from "../config_edit.ts";

function pluginPath(ctx: InstallerContext): string {
	return scopePath(ctx, [".opencode", "plugins", "agent-synctex-post-user.ts"], [".config", "opencode", "plugins", "agent-synctex-post-user.ts"]);
}

function mcpPath(ctx: InstallerContext): string {
	return scopePath(ctx, ["opencode.json"], [".config", "opencode", "opencode.json"]);
}

export const opencodeAdapter: HarnessAdapter = {
	id: "opencode",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".opencode"))) return { id: "opencode", detected: true, reason: ".opencode/ exists" };
		if (pathExists(projectPath(ctx, "opencode.json")) || pathExists(projectPath(ctx, "opencode.jsonc"))) return { id: "opencode", detected: true, reason: "opencode config exists" };
		return { id: "opencode", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertOpencodeMcp(ctx, mcpPath(ctx), "opencode", ctx.noHooks);
	},
	installHooks(ctx): InstallChange[] {
		const target = pluginPath(ctx);
		writeText(ctx, target, opencodePluginSource());
		return [change("installed OpenCode chat.message plugin", target), ...removeNoHooksFromManagedMcp(ctx)];
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeOpencodeMcp(ctx, mcpPath(ctx)),
			...removeManagedFile(ctx, pluginPath(ctx)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "opencode", level: pathExists(pluginPath(ctx)) ? "ok" : "warning", message: "OpenCode hook uses the chat.message plugin." }];
	},
};

function removeNoHooksFromManagedMcp(ctx: InstallerContext): InstallChange[] {
	const path = mcpPath(ctx);
	if (!pathExists(path)) return [];
	const config = parseJsoncObject(path);
	if (!opencodeMcpHasNoHooks(config)) return [];
	return upsertOpencodeMcp(ctx, path, "opencode", false);
}

function opencodePluginSource(): string {
	return `import { spawnSync } from "node:child_process";

// Managed by agent-synctex.
function fetchPdfContext(prompt: string): string {
	const result = spawnSync("agent-synctex", ["fetch-info", "--harness", "opencode"], {
		input: prompt,
		encoding: "utf8",
	});
	return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

export const AgentSynctexPostUser = async () => ({
	"chat.message": async (input: any, output: any) => {
		const parts = Array.isArray(output.parts) ? output.parts : [];
		const prompt = parts
			.filter((part: any) => part?.type === "text")
			.map((part: any) => String(part.text ?? ""))
			.join("\n");
		const context = fetchPdfContext(prompt);
		if (!context) return;
		const now = Date.now();
		parts.push({
			id: \`agent-synctex-pdf-context-\${now}\`,
			messageID: input.messageID ?? output.message?.id,
			sessionID: input.sessionID,
			type: "text",
			text: \`\n\n\${context}\`,
			time: { start: now, end: now },
		});
		output.parts = parts;
	},
});
`;
}

import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange } from "../types.ts";
import { agentIdForHarness, change, pathExists, projectPath, removeManagedFile, removeOpencodeMcp, upsertOpencodeMcp, writeText } from "../config_edit.ts";

const PLUGIN_FILE = ".opencode/plugins/agent-synctex-post-user.ts";

export const opencodeAdapter: HarnessAdapter = {
	id: "opencode",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".opencode"))) return { id: "opencode", detected: true, reason: ".opencode/ exists" };
		if (pathExists(projectPath(ctx, "opencode.jsonc"))) return { id: "opencode", detected: true, reason: "opencode.jsonc exists" };
		return { id: "opencode", detected: false };
	},
	installMcp(ctx): InstallChange[] {
		return upsertOpencodeMcp(ctx, projectPath(ctx, "opencode.jsonc"), false);
	},
	installHooks(ctx): InstallChange[] {
		const changes = upsertOpencodeMcp(ctx, projectPath(ctx, "opencode.jsonc"), true);
		const pluginPath = projectPath(ctx, PLUGIN_FILE);
		writeText(ctx, pluginPath, opencodePluginSource(agentIdForHarness("opencode")));
		changes.push(change("installed OpenCode chat.message plugin", pluginPath));
		return changes;
	},
	uninstall(ctx): InstallChange[] {
		return [
			...removeOpencodeMcp(ctx, projectPath(ctx, "opencode.jsonc")),
			...removeManagedFile(ctx, projectPath(ctx, PLUGIN_FILE)),
		];
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "opencode", level: pathExists(projectPath(ctx, PLUGIN_FILE)) ? "ok" : "warning", message: "OpenCode hook uses the chat.message plugin in .opencode/plugins/." }];
	},
};

function opencodePluginSource(agentId: string): string {
	return `import { spawnSync } from "node:child_process";

// Managed by agent-synctex.
function fetchPdfContext(prompt: string): string {
	const result = spawnSync("agent-synctex", ["fetch-info"], {
		input: prompt,
		encoding: "utf8",
		env: { ...process.env, TEX_ACTIONS_AGENT_ID: ${JSON.stringify(agentId)} },
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

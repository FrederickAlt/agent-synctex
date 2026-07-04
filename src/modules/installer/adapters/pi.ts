import type { DoctorFinding, HarnessAdapter, HarnessDetection, InstallChange } from "../types.ts";
import { agentIdForHarness, change, pathExists, projectPath, removeManagedFile, writeText } from "../config_edit.ts";

const EXTENSION_FILE = ".pi/extensions/agent-synctex-post-user.ts";

export const piAdapter: HarnessAdapter = {
	id: "pi",
	detect(ctx): HarnessDetection {
		if (pathExists(projectPath(ctx, ".pi"))) return { id: "pi", detected: true, reason: ".pi/ exists" };
		return { id: "pi", detected: false };
	},
	installMcp(): InstallChange[] {
		return [change("Pi uses an extension wrapper for hook injection; configure/start tex-actions-mcp --with-hooks in the Pi MCP environment.")];
	},
	installHooks(ctx): InstallChange[] {
		const extensionPath = projectPath(ctx, EXTENSION_FILE);
		writeText(ctx, extensionPath, piExtensionSource(agentIdForHarness("pi")));
		return [
			change("installed standalone Pi before_agent_start extension wrapper", extensionPath),
			change("Pi extension communicates with the private Agent SyncTeX hook bridge via agent-synctex fetch-info"),
		];
	},
	uninstall(ctx): InstallChange[] {
		return removeManagedFile(ctx, projectPath(ctx, EXTENSION_FILE));
	},
	doctor(ctx): DoctorFinding[] {
		return [{ harness: "pi", level: pathExists(projectPath(ctx, EXTENSION_FILE)) ? "ok" : "warning", message: "Pi hook support is a standalone extension wrapper around before_agent_start." }];
	},
};

function piExtensionSource(agentId: string): string {
	return `import { spawnSync } from "node:child_process";

// Managed by agent-synctex.
function textFromPromptEvent(event: any): string {
	if (typeof event?.prompt === "string") return event.prompt;
	if (typeof event?.message === "string") return event.message;
	if (typeof event?.message?.content === "string") return event.message.content;
	return "";
}

function fetchPdfContext(prompt: string): string {
	const result = spawnSync("agent-synctex", ["fetch-info"], {
		input: prompt,
		encoding: "utf8",
		env: { ...process.env, TEX_ACTIONS_AGENT_ID: ${JSON.stringify(agentId)} },
	});
	return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

export default function(pi: any): void {
	pi.on("before_agent_start", async (event: any) => {
		const context = fetchPdfContext(textFromPromptEvent(event));
		if (!context) return;
		return {
			message: {
				customType: "pdf-viewer-context",
				content: context,
				display: true,
			},
		};
	});
}
`;
}

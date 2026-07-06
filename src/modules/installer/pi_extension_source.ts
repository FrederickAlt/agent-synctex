export function piExtensionSource(): string {
	return `import { spawnSync } from "node:child_process";

// Managed by agent-synctex.
function textFromPromptEvent(event: any): string {
	if (typeof event?.prompt === "string") return event.prompt;
	if (typeof event?.message === "string") return event.message;
	if (typeof event?.message?.content === "string") return event.message.content;
	return "";
}

function cwdFromEvent(event: any): string | undefined {
	if (typeof event?.cwd === "string" && event.cwd) return event.cwd;
	if (typeof event?.systemPromptOptions?.cwd === "string" && event.systemPromptOptions.cwd) return event.systemPromptOptions.cwd;
	return undefined;
}

function fetchPdfContext(prompt: string, cwd: string | undefined): string {
	const args = ["fetch-info", "--harness", "pi"];
	if (cwd) args.push("--cwd", cwd);
	const result = spawnSync("agent-synctex", args, {
		input: prompt,
		encoding: "utf8",
		...(cwd ? { cwd } : {}),
	});
	return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

export default function(pi: any): void {
	pi.on("before_agent_start", async (event: any) => {
		const cwd = cwdFromEvent(event);
		const context = fetchPdfContext(textFromPromptEvent(event), cwd);
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

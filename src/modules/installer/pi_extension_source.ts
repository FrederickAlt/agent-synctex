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

function fetchPdfContext(prompt: string, cwd: string | undefined): { text: string; error?: string } {
	const args = ["fetch-info", "--harness", "pi"];
	if (cwd) args.push("--cwd", cwd);
	const options = {
		input: prompt,
		encoding: "utf8" as const,
		...(cwd ? { cwd } : {}),
	};
	const direct = spawnSync("agent-synctex", args, options);
	if (direct.status === 0) return { text: (direct.stdout ?? "").trim() };
	if ((direct.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
		return { text: "", error: resultError(direct) };
	}
	const shell = process.env.SHELL?.trim() || "/bin/sh";
	const viaShell = spawnSync(shell, ["-lc", "exec agent-synctex \\"$@\\"", "agent-synctex", ...args], options);
	return viaShell.status === 0 ? { text: (viaShell.stdout ?? "").trim() } : { text: "", error: resultError(viaShell) };
}

function resultError(result: ReturnType<typeof spawnSync>): string {
	if (result.error) return result.error.message;
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
	return stderr || "agent-synctex fetch-info exited with status " + (result.status ?? "unknown");
}

export default function(pi: any): void {
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const cwd = cwdFromEvent(event);
		const context = fetchPdfContext(textFromPromptEvent(event), cwd);
		if (!context.text) {
			if (context.error) ctx?.ui?.notify?.("Agent SyncTeX hook failed: " + context.error, "warning");
			return;
		}
		return {
			message: {
				customType: "pdf-viewer-context",
				content: context.text,
				display: true,
			},
		};
	});
}
`;
}

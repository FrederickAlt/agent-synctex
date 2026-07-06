import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "./types.ts";
import { MANAGED_MARKER, piAgentDir } from "./config_edit.ts";

export function areHarnessHooksInstalled(harness: HarnessId, cwd = process.cwd()): boolean {
	return hookCandidatePaths(harness, cwd).some((path) => {
		try {
			return existsSync(path) && readFileSync(path, "utf8").includes(MANAGED_MARKER);
		} catch {
			return false;
		}
	});
}

function hookCandidatePaths(harness: HarnessId, cwd: string): string[] {
	switch (harness) {
		case "claude":
			return [join(cwd, ".claude", "hooks", "agent-synctex-fetch-info.sh"), join(homedir(), ".claude", "hooks", "agent-synctex-fetch-info.sh")];
		case "codex":
			return [join(cwd, ".codex", "hooks", "agent-synctex-fetch-info.sh"), join(homedir(), ".codex", "hooks", "agent-synctex-fetch-info.sh")];
		case "cline":
			return [join(cwd, ".clinerules", "hooks", "UserPromptSubmit"), join(homedir(), "Documents", "Cline", "Hooks", "UserPromptSubmit")];
		case "pi":
			return [join(cwd, ".pi", "extensions", "agent-synctex-post-user.ts"), join(piAgentDir(), "extensions", "agent-synctex-post-user.ts")];
		case "opencode":
			return [join(cwd, ".opencode", "plugins", "agent-synctex-post-user.ts"), join(homedir(), ".config", "opencode", "plugins", "agent-synctex-post-user.ts")];
	}
}

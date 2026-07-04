import type { HarnessAdapter } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { clineAdapter } from "./cline.ts";
import { codexAdapter } from "./codex.ts";
import { opencodeAdapter } from "./opencode.ts";
import { piAdapter } from "./pi.ts";

export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [
	claudeAdapter,
	codexAdapter,
	clineAdapter,
	piAdapter,
	opencodeAdapter,
];

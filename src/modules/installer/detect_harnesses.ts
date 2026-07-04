import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { HARNESS_ADAPTERS } from "./adapters/index.ts";
import type { HarnessAdapter, HarnessId, HarnessSelection, InstallerContext } from "./types.ts";

export async function selectHarnessAdapters(ctx: InstallerContext, selection: HarnessSelection): Promise<HarnessAdapter[]> {
	if (selection === "all") return [...HARNESS_ADAPTERS];
	if (selection !== "auto") {
		const adapter = HARNESS_ADAPTERS.find((candidate) => candidate.id === selection);
		if (!adapter) throw new Error(`Unknown harness: ${selection}`);
		return [adapter];
	}
	const detected = [];
	for (const adapter of HARNESS_ADAPTERS) {
		const result = await adapter.detect(ctx);
		if (result.detected) detected.push(adapter);
	}
	if (detected.length === 1) return detected;
	if (detected.length === 0) throw new Error("No supported harness detected. Pass --harness claude|codex|cline|pi|opencode|all.");
	if (ctx.yes) return detected;
	throw new Error(`Multiple harnesses detected (${detected.map((adapter) => adapter.id).join(", ")}). Pass --harness explicitly or use --harness all.`);
}

export function isHarnessId(value: string): value is HarnessId {
	return ["claude", "codex", "cline", "pi", "opencode"].includes(value);
}

export function commandOnPath(command: string, envPath = process.env.PATH ?? ""): boolean {
	return envPath.split(delimiter).some((dir) => existsSync(join(dir, command)));
}

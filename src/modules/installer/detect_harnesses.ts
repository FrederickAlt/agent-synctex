import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { HARNESS_ADAPTERS } from "./adapters/index.ts";
import { homePath, piAgentDir, projectPath } from "./config_edit.ts";
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

export async function selectInstallHarnessAdapters(ctx: InstallerContext, selection: HarnessSelection): Promise<HarnessAdapter[]> {
	if (selection !== "all") return selectHarnessAdapters(ctx, selection);
	return HARNESS_ADAPTERS.filter((adapter) => directoryExists(harnessDirectoryPath(ctx, adapter.id)));
}

function directoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function harnessDirectoryPath(ctx: InstallerContext, harness: HarnessId): string {
	if (ctx.scope === "project") {
		switch (harness) {
			case "claude": return projectPath(ctx, ".claude");
			case "codex": return projectPath(ctx, ".codex");
			case "cline": return projectPath(ctx, ".clinerules");
			case "pi": return projectPath(ctx, ".pi");
			case "opencode": return projectPath(ctx, ".opencode");
		}
	}
	switch (harness) {
		case "claude": return homePath(".claude");
		case "codex": return homePath(".codex");
		case "cline": return homePath("Documents", "Cline");
		case "pi": return piAgentDir();
		case "opencode": return homePath(".config", "opencode");
	}
}

export function isHarnessId(value: string): value is HarnessId {
	return ["claude", "codex", "cline", "pi", "opencode"].includes(value);
}

export function commandOnPath(command: string, envPath = process.env.PATH ?? ""): boolean {
	return envPath.split(delimiter).some((dir) => existsSync(join(dir, command)));
}

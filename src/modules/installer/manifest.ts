import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId, InstallChange, InstallerContext } from "./types.ts";

const MANIFEST_VERSION = 1;

export interface HarnessManifestEntry {
	harness: HarnessId;
	mcpInstalled: boolean;
	hooksInstalled: boolean;
	updatedAt: string;
	changes: InstallChange[];
}

export interface InstallManifest {
	version: typeof MANIFEST_VERSION;
	harnesses: Partial<Record<HarnessId, HarnessManifestEntry>>;
}

export function manifestPath(ctx: InstallerContext): string {
	return join(ctx.cwd, ".agent-synctex", "install-manifest.json");
}

export function readManifest(ctx: InstallerContext): InstallManifest {
	const path = manifestPath(ctx);
	if (!existsSync(path)) return { version: MANIFEST_VERSION, harnesses: {} };
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallManifest>;
	return {
		version: MANIFEST_VERSION,
		harnesses: raw.harnesses ?? {},
	};
}

export function recordManifest(ctx: InstallerContext, harness: HarnessId, patch: { mcpInstalled?: boolean; hooksInstalled?: boolean; changes: InstallChange[] }): void {
	if (ctx.dryRun) return;
	const manifest = readManifest(ctx);
	const current = manifest.harnesses[harness];
	manifest.harnesses[harness] = {
		harness,
		mcpInstalled: patch.mcpInstalled ?? current?.mcpInstalled ?? false,
		hooksInstalled: patch.hooksInstalled ?? current?.hooksInstalled ?? false,
		updatedAt: new Date().toISOString(),
		changes: patch.changes,
	};
	const path = manifestPath(ctx);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
}

export function removeManifestHarness(ctx: InstallerContext, harness: HarnessId): void {
	if (ctx.dryRun) return;
	const manifest = readManifest(ctx);
	delete manifest.harnesses[harness];
	const path = manifestPath(ctx);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
}

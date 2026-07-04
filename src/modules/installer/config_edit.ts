import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { InstallChange, InstallerContext } from "./types.ts";

export const MCP_SERVER_NAME = "agent-synctex";
export const MANAGED_MARKER = "Managed by agent-synctex";

export function agentIdForHarness(harness: string): string {
	return `agent-synctex-${harness}`;
}

export function mcpServerConfig(harness: string, hooksEnabled: boolean): Record<string, unknown> {
	return {
		command: "tex-actions-mcp",
		args: hooksEnabled ? ["--with-hooks"] : [],
		env: { TEX_ACTIONS_AGENT_ID: agentIdForHarness(harness) },
	};
}

export function change(description: string, path?: string): InstallChange {
	return path === undefined ? { description } : { description, path };
}

export function pathExists(path: string): boolean {
	return existsSync(path);
}

export function readText(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function ensureParent(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

export function writeText(ctx: InstallerContext, path: string, text: string, mode?: number): void {
	if (ctx.dryRun) return;
	backupExistingFile(ctx, path);
	ensureParent(path);
	writeFileSync(path, text);
	if (mode !== undefined) chmodSync(path, mode);
}

export function removeFile(ctx: InstallerContext, path: string): void {
	if (ctx.dryRun) return;
	rmSync(path, { force: true });
}

export function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function writeJsonObject(ctx: InstallerContext, path: string, value: Record<string, unknown>): void {
	writeText(ctx, path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function parseJsoncObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf8");
	return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
}

export function writeJsoncObject(ctx: InstallerContext, path: string, value: Record<string, unknown>): void {
	writeText(ctx, path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function upsertMcpServersJson(ctx: InstallerContext, path: string, harness: string, hooksEnabled: boolean): InstallChange[] {
	const config = readJsonObject(path);
	const current = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
	current[MCP_SERVER_NAME] = mcpServerConfig(harness, hooksEnabled);
	config.mcpServers = current;
	writeJsonObject(ctx, path, config);
	return [change(`installed ${MCP_SERVER_NAME} MCP config${hooksEnabled ? " with --with-hooks" : ""}`, path)];
}

export function removeMcpServersJson(ctx: InstallerContext, path: string): InstallChange[] {
	if (!existsSync(path)) return [];
	const config = readJsonObject(path);
	if (!isRecord(config.mcpServers) || !(MCP_SERVER_NAME in config.mcpServers)) return [];
	const nextServers = { ...config.mcpServers };
	delete nextServers[MCP_SERVER_NAME];
	if (Object.keys(nextServers).length === 0) delete config.mcpServers;
	else config.mcpServers = nextServers;
	writeJsonObject(ctx, path, config);
	return [change(`removed ${MCP_SERVER_NAME} MCP config`, path)];
}

export function upsertOpencodeMcp(ctx: InstallerContext, path: string, hooksEnabled: boolean): InstallChange[] {
	const config = parseJsoncObject(path);
	const current = isRecord(config.mcp) ? { ...config.mcp } : {};
	current[MCP_SERVER_NAME] = {
		type: "local",
		command: ["tex-actions-mcp", ...(hooksEnabled ? ["--with-hooks"] : [])],
		enabled: true,
		env: { TEX_ACTIONS_AGENT_ID: agentIdForHarness("opencode") },
	};
	config.mcp = current;
	writeJsoncObject(ctx, path, config);
	return [change(`installed ${MCP_SERVER_NAME} OpenCode MCP config${hooksEnabled ? " with --with-hooks" : ""}`, path)];
}

export function removeOpencodeMcp(ctx: InstallerContext, path: string): InstallChange[] {
	if (!existsSync(path)) return [];
	const config = parseJsoncObject(path);
	if (!isRecord(config.mcp) || !(MCP_SERVER_NAME in config.mcp)) return [];
	const next = { ...config.mcp };
	delete next[MCP_SERVER_NAME];
	if (Object.keys(next).length === 0) delete config.mcp;
	else config.mcp = next;
	writeJsoncObject(ctx, path, config);
	return [change(`removed ${MCP_SERVER_NAME} OpenCode MCP config`, path)];
}

export function upsertManagedTomlBlock(ctx: InstallerContext, path: string, blockId: string, body: string): InstallChange[] {
	const start = `# ${MANAGED_MARKER}: ${blockId} start`;
	const end = `# ${MANAGED_MARKER}: ${blockId} end`;
	const block = `${start}\n${body.trim()}\n${end}`;
	const current = readText(path) ?? "";
	const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
	const next = pattern.test(current)
		? current.replace(pattern, block)
		: `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
	writeText(ctx, path, next);
	return [change(`installed managed TOML block ${blockId}`, path)];
}

export function removeManagedTomlBlock(ctx: InstallerContext, path: string, blockId: string): InstallChange[] {
	if (!existsSync(path)) return [];
	const start = `# ${MANAGED_MARKER}: ${blockId} start`;
	const end = `# ${MANAGED_MARKER}: ${blockId} end`;
	const current = readFileSync(path, "utf8");
	const pattern = new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");
	if (!pattern.test(current)) return [];
	writeText(ctx, path, current.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n"));
	return [change(`removed managed TOML block ${blockId}`, path)];
}

export function managedShellScript(commandName: string, jsonWrapper: "claude" | "cline"): string {
	const agentId = commandName;
	if (jsonWrapper === "cline") {
		return `#!/usr/bin/env bash\n# ${MANAGED_MARKER}\nset -euo pipefail\ncontext="$(TEX_ACTIONS_AGENT_ID=${shellQuote(agentId)} agent-synctex fetch-info || true)"\nif [ -z "$context" ]; then exit 0; fi\nHOOK_CONTEXT="$context" node -e 'process.stdout.write(JSON.stringify({ contextModification: process.env.HOOK_CONTEXT || "" }))'\n`;
	}
	return `#!/usr/bin/env bash\n# ${MANAGED_MARKER}\nset -euo pipefail\ncontext="$(TEX_ACTIONS_AGENT_ID=${shellQuote(agentId)} agent-synctex fetch-info || true)"\nif [ -z "$context" ]; then exit 0; fi\nHOOK_CONTEXT="$context" node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: process.env.HOOK_CONTEXT || "" } }))'\n`;
}

export function removeManagedFile(ctx: InstallerContext, path: string): InstallChange[] {
	const current = readText(path);
	if (current === undefined || !current.includes(MANAGED_MARKER)) return [];
	removeFile(ctx, path);
	return [change("removed managed file", path)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectPath(ctx: InstallerContext, ...parts: string[]): string {
	return join(ctx.cwd, ...parts);
}

function backupExistingFile(ctx: InstallerContext, path: string): void {
	if (!existsSync(path)) return;
	const hash = createHash("sha256").update(path).digest("hex").slice(0, 12);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = join(ctx.cwd, ".agent-synctex", "backups", `${basename(path)}.${hash}.${timestamp}.bak`);
	ensureParent(backupPath);
	writeFileSync(backupPath, readFileSync(path));
}

function stripJsonComments(raw: string): string {
	let output = "";
	let inString = false;
	let quote = "";
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index]!;
		const next = raw[index + 1];
		if (inString) {
			output += char;
			if (char === "\\") {
				if (next !== undefined) {
					output += next;
					index += 1;
				}
			} else if (char === quote) {
				inString = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			quote = char;
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < raw.length && raw[index] !== "\n") index += 1;
			output += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
			index += 1;
			continue;
		}
		output += char;
	}
	return output.replace(/,\s*([}\]])/g, "$1");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

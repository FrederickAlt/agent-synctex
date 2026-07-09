import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessId, InstallChange, InstallerContext } from "./types.ts";

export const MCP_SERVER_NAME = "agent-synctex";
export const MANAGED_MARKER = "Managed by agent-synctex";

export function agentIdForHarness(harness: string): string {
	return `agent-synctex-${harness}`;
}

export function agentSynctexMcpLaunchConfig(harness: HarnessId, noHooks: boolean): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: [agentSynctexCliScriptPath(), "mcp", "--harness", harness, ...(noHooks ? ["--no-hooks"] : [])],
	};
}

export function mcpServerConfig(harness: HarnessId, noHooks: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...agentSynctexMcpLaunchConfig(harness, noHooks),
		...extra,
	};
}

function agentSynctexCliScriptPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDir, "../../../scripts/agent-synctex.js"),
		resolve(moduleDir, "../../../dist/scripts/agent-synctex.js"),
		resolve(moduleDir, "../../../scripts/agent-synctex.ts"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? resolve(moduleDir, "../../../scripts/agent-synctex.js");
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

export function upsertMcpServersJson(ctx: InstallerContext, path: string, harness: HarnessId, noHooks: boolean, extra: Record<string, unknown> = {}): InstallChange[] {
	const config = readJsonObject(path);
	const current = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
	current[MCP_SERVER_NAME] = mcpServerConfig(harness, noHooks, extra);
	config.mcpServers = current;
	writeJsonObject(ctx, path, config);
	return [change(`installed ${MCP_SERVER_NAME} MCP config${noHooks ? " in --no-hooks mode" : ""}`, path)];
}

export function mcpServerHasNoHooks(config: Record<string, unknown>): boolean {
	if (!isRecord(config.mcpServers)) return false;
	const server = config.mcpServers[MCP_SERVER_NAME];
	if (!isRecord(server) || !Array.isArray(server.args)) return false;
	return server.args.includes("--no-hooks");
}

export function opencodeMcpHasNoHooks(config: Record<string, unknown>): boolean {
	if (!isRecord(config.mcp)) return false;
	const server = config.mcp[MCP_SERVER_NAME];
	if (!isRecord(server) || !Array.isArray(server.command)) return false;
	return server.command.includes("--no-hooks");
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

export function upsertOpencodeMcp(ctx: InstallerContext, path: string, harness: HarnessId, noHooks: boolean): InstallChange[] {
	const config = parseJsoncObject(path);
	const current = isRecord(config.mcp) ? { ...config.mcp } : {};
	const launchConfig = agentSynctexMcpLaunchConfig(harness, noHooks);
	current[MCP_SERVER_NAME] = {
		type: "local",
		command: [launchConfig.command, ...launchConfig.args],
		enabled: true,
	};
	config.mcp = current;
	writeJsoncObject(ctx, path, config);
	return [change(`installed ${MCP_SERVER_NAME} OpenCode MCP config${noHooks ? " in --no-hooks mode" : ""}`, path)];
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

export function managedShellScript(harness: HarnessId, jsonWrapper: "claude" | "codex" | "cline"): string {
	const fetchCommand = `agent-synctex fetch-info --harness ${shellQuote(harness)}`;
	if (jsonWrapper === "cline") {
		return `#!/usr/bin/env bash\n# ${MANAGED_MARKER}\nset -euo pipefail\ncontext="$(${fetchCommand} || true)"\nif [ -z "$context" ]; then exit 0; fi\nHOOK_CONTEXT="$context" node -e 'process.stdout.write(JSON.stringify({ contextModification: process.env.HOOK_CONTEXT || "" }))'\n`;
	}
	if (jsonWrapper === "codex") {
		return managedCodexUserPromptSubmitScript();
	}
	return `#!/usr/bin/env bash\n# ${MANAGED_MARKER}\nset -euo pipefail\ncontext="$(${fetchCommand} || true)"\nif [ -z "$context" ]; then exit 0; fi\nHOOK_CONTEXT="$context" node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: process.env.HOOK_CONTEXT || "" } }))'\n`;
}

export function managedCodexUserPromptSubmitScript(): string {
	return `#!/usr/bin/env node\n// ${MANAGED_MARKER}\nimport { spawnSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\n\nconst raw = readFileSync(0, "utf8");\nlet event;\ntry { event = raw.trim() ? JSON.parse(raw) : {}; } catch { event = { prompt: raw }; }\nconst prompt = typeof event?.prompt === "string" ? event.prompt : "";\nconst sessionId = typeof event?.session_id === "string" && event.session_id.trim() ? event.session_id : undefined;\nconst args = ["fetch-info", "--harness", "codex"];\nif (sessionId) args.push("--agent-id", sessionId);\nconst result = spawnSync("agent-synctex", args, { input: prompt, encoding: "utf8" });\nif (result.status !== 0) process.exit(0);\nconst context = String(result.stdout ?? "").trim();\nif (!context) process.exit(0);\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));\n`;
}

export function managedCodexPreToolUseScript(): string {
	return `#!/usr/bin/env node\n// ${MANAGED_MARKER}\nimport { readFileSync } from "node:fs";\n\nconst raw = readFileSync(0, "utf8");\nlet event;\ntry { event = raw.trim() ? JSON.parse(raw) : {}; } catch { process.exit(0); }\nconst input = event?.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input) ? event.tool_input : {};\nconst sessionId = typeof event?.session_id === "string" && event.session_id.trim() ? event.session_id : undefined;\nif (!sessionId) process.exit(0);\nconst updatedInput = {\n  ...input,\n  _agent_synctex: {\n    harness: "codex",\n    session_id: sessionId,\n    turn_id: event?.turn_id,\n    tool_use_id: event?.tool_use_id,\n    cwd: process.cwd(),\n  },\n  _codex: {\n    session_id: sessionId,\n    turn_id: event?.turn_id,\n    tool_use_id: event?.tool_use_id,\n  },\n};\nprocess.stdout.write(JSON.stringify({\n  hookSpecificOutput: {\n    hookEventName: "PreToolUse",\n    permissionDecision: "allow",\n    updatedInput,\n  },\n}));\n`;
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

export function homePath(...parts: string[]): string {
	return join(homedir(), ...parts);
}

export function scopePath(ctx: InstallerContext, projectParts: string[], userParts: string[]): string {
	return ctx.scope === "user" ? homePath(...userParts) : projectPath(ctx, ...projectParts);
}

export function clineMcpSettingsPath(ctx: InstallerContext): string {
	return ctx.scope === "user" && process.env.CLINE_MCP_SETTINGS_PATH?.trim()
		? process.env.CLINE_MCP_SETTINGS_PATH
		: scopePath(ctx, [".cline_mcp_settings.json"], [".cline", "data", "settings", "cline_mcp_settings.json"]);
}

export function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || homePath(".pi", "agent");
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
		if (char === "\"" || char === "'") {
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

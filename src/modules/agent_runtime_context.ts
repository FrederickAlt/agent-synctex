import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HostServiceWorkspaceContext } from "./host_service_protocol.ts";
import { getMcpTmpDir } from "./runtime_paths.ts";

export const TEX_ACTIONS_AGENT_ID_ENV_VAR = "TEX_ACTIONS_AGENT_ID";

let processStableAgentId: string | undefined;

function processStableUuid(): string {
	processStableAgentId ??= randomUUID();
	return processStableAgentId;
}

function rawPiSessionId(ctx?: ExtensionContext): string | undefined {
	const rawSessionId = (ctx as { session_id?: unknown } | undefined)?.session_id;
	return typeof rawSessionId === "string" && rawSessionId.trim().length > 0
		? rawSessionId
		: undefined;
}

export function sanitizeTexActionsAgentId(agentId: string): string {
	const sanitized = agentId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
	if (!sanitized || sanitized === "." || sanitized === "..") {
		return "agent";
	}
	return sanitized;
}

export function resolveTexActionsAgentId(ctx?: ExtensionContext): string {
	const envAgentId = process.env[TEX_ACTIONS_AGENT_ID_ENV_VAR];
	return sanitizeTexActionsAgentId(
		(envAgentId && envAgentId.trim().length > 0)
			? envAgentId
			: rawPiSessionId(ctx) ?? processStableUuid(),
	);
}

export function resolveTexActionsAgentRuntimeDir(agentId: string): string {
	return resolve(getMcpTmpDir(), "agents", sanitizeTexActionsAgentId(agentId));
}

export function ensureTexActionsAgentRuntimeDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

export function resolveAgentWorkspaceContext(ctx?: ExtensionContext): HostServiceWorkspaceContext {
	const agentId = resolveTexActionsAgentId(ctx);
	const agentRuntimeDir = resolveTexActionsAgentRuntimeDir(agentId);
	ensureTexActionsAgentRuntimeDir(agentRuntimeDir);
	return {
		cwd: ctx?.cwd ?? process.cwd(),
		session_id: agentId,
		workspace_root: agentRuntimeDir,
	};
}

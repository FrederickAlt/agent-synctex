import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { HostServiceWorkspaceContext } from "./host_service_protocol.ts";
import { getMcpTmpDir } from "./runtime_paths.ts";

export const TEX_ACTIONS_AGENT_ID_ENV_VAR = "TEX_ACTIONS_AGENT_ID";

let processStableAgentId: string | undefined;

function processStableUuid(): string {
	processStableAgentId ??= randomUUID();
	return processStableAgentId;
}

interface AgentWorkspaceContextSource {
	cwd?: string;
	session_id?: unknown;
}

function rawPiSessionId(ctx?: AgentWorkspaceContextSource): string | undefined {
	const rawSessionId = ctx?.session_id;
	if (typeof rawSessionId === "string" && rawSessionId.trim().length > 0) return rawSessionId;
	const sessionManager = (ctx as { sessionManager?: { getSessionId?: unknown } } | undefined)?.sessionManager;
	const getSessionId = sessionManager?.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const sessionId = getSessionId.call(sessionManager);
		return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId : undefined;
	} catch {
		return undefined;
	}
}

export function sanitizeTexActionsAgentId(agentId: string): string {
	const sanitized = agentId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
	if (!sanitized || sanitized === "." || sanitized === "..") {
		return "agent";
	}
	return sanitized;
}

export function resolveTexActionsAgentId(ctx?: AgentWorkspaceContextSource): string {
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

export function resolveAgentWorkspaceContext(ctx?: AgentWorkspaceContextSource): HostServiceWorkspaceContext {
	return resolveAgentWorkspaceContextForAgentId(resolveTexActionsAgentId(ctx), ctx?.cwd);
}

export function resolveAgentWorkspaceContextForAgentId(agentId: string, cwd = process.cwd()): HostServiceWorkspaceContext {
	const sanitizedAgentId = sanitizeTexActionsAgentId(agentId);
	const agentRuntimeDir = resolveTexActionsAgentRuntimeDir(sanitizedAgentId);
	ensureTexActionsAgentRuntimeDir(agentRuntimeDir);
	return {
		cwd,
		session_id: sanitizedAgentId,
		workspace_root: agentRuntimeDir,
	};
}

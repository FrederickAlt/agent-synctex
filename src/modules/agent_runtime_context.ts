import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { HostServiceWorkspaceContext } from "./host_service_protocol.ts";
import { getMcpTmpDir } from "./runtime_paths.ts";

export const TEX_ACTIONS_AGENT_ID_ENV_VAR = "TEX_ACTIONS_AGENT_ID";
export const AGENT_SYNCTEX_INSTANCE_ID_ENV_VAR = "AGENT_SYNCTEX_INSTANCE_ID";

const MAX_LINEAGE_CANDIDATES = 8;

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

export function explicitTexActionsAgentId(): string | undefined {
	const instanceId = process.env[AGENT_SYNCTEX_INSTANCE_ID_ENV_VAR];
	if (instanceId?.trim()) return sanitizeTexActionsAgentId(instanceId);
	const legacyAgentId = process.env[TEX_ACTIONS_AGENT_ID_ENV_VAR];
	return legacyAgentId?.trim() ? sanitizeTexActionsAgentId(legacyAgentId) : undefined;
}

export function resolveTexActionsAgentId(ctx?: AgentWorkspaceContextSource): string {
	return sanitizeTexActionsAgentId(explicitTexActionsAgentId() ?? rawPiSessionId(ctx) ?? processStableUuid());
}

export function resolveTexActionsHookInstanceId(ctx?: AgentWorkspaceContextSource): string {
	return explicitTexActionsAgentId() ?? rawPiSessionId(ctx) ?? resolveProcessLineageTexActionsAgentIds()[0] ?? sanitizeTexActionsAgentId(`process-${process.pid}-${processStableUuid()}`);
}

export function resolveTexActionsHookInstanceCandidates(ctx?: AgentWorkspaceContextSource): string[] {
	const explicit = explicitTexActionsAgentId() ?? rawPiSessionId(ctx);
	if (explicit) return [sanitizeTexActionsAgentId(explicit)];
	return uniqueStrings(resolveProcessLineageTexActionsAgentIds());
}

export function resolveProcessLineageTexActionsAgentIds(): string[] {
	const identities = processLineageIdentities(process.pid, MAX_LINEAGE_CANDIDATES);
	return identities.map((identity) => sanitizeTexActionsAgentId(`lineage-${identity.pid}-${identity.startTime ?? "unknown"}`));
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

export function resolveHookAgentWorkspaceContext(ctx?: AgentWorkspaceContextSource): HostServiceWorkspaceContext {
	return resolveAgentWorkspaceContextForAgentId(resolveTexActionsHookInstanceId(ctx), ctx?.cwd);
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

interface ProcessIdentity {
	pid: number;
	ppid?: number;
	startTime?: string;
}

function processLineageIdentities(startPid: number, maxCount: number): ProcessIdentity[] {
	const identities: ProcessIdentity[] = [];
	const seen = new Set<number>();
	let nextPid = parentPidFor(startPid);
	while (nextPid !== undefined && nextPid > 0 && !seen.has(nextPid) && identities.length < maxCount) {
		seen.add(nextPid);
		const identity = readProcessIdentity(nextPid) ?? { pid: nextPid };
		identities.push(identity);
		nextPid = identity.ppid;
	}
	return identities;
}

function parentPidFor(pid: number): number | undefined {
	if (pid === process.pid) return process.ppid > 0 ? process.ppid : undefined;
	return readProcessIdentity(pid)?.ppid;
}

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
	if (process.platform === "linux") return readLinuxProcessIdentity(pid);
	if (process.platform === "darwin") return readDarwinProcessIdentity(pid);
	return undefined;
}

function readDarwinProcessIdentity(pid: number): ProcessIdentity | undefined {
	const result = spawnSync("ps", ["-o", "ppid=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	return parseDarwinProcessIdentity(pid, result.stdout);
}

export function parseDarwinProcessIdentity(pid: number, output: string): ProcessIdentity | undefined {
	const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(output);
	if (!match) return undefined;
	const ppid = Number(match[1]);
	return {
		pid,
		...(Number.isInteger(ppid) && ppid > 0 ? { ppid } : {}),
		...(match[2] ? { startTime: match[2].replace(/\s+/g, "-") } : {}),
	};
}

function readLinuxProcessIdentity(pid: number): ProcessIdentity | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen < 0) return undefined;
		const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
		const ppid = Number(fields[1]);
		const startTime = fields[19];
		return {
			pid,
			...(Number.isInteger(ppid) && ppid > 0 ? { ppid } : {}),
			...(startTime ? { startTime } : {}),
		};
	} catch {
		return undefined;
	}
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

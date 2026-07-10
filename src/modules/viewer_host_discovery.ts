import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VIEWER_HOST_DISCOVERY_FILE_NAME = "viewer-host.json";

export interface PersistentViewerHostState {
	origin: string;
	viewer_url: string;
	pid?: number;
	instance_id?: string;
	shutdown_token?: string;
	control_token?: string;
	heartbeat_token?: string;
	owner_id?: string;
	heartbeat_lease_ms?: number;
	cwd?: string;
	updated_at: string;
	browser_opened_at?: string;
	browser_open_in_progress_at?: string;
	browser_open_attempted_at?: string;
}

export function persistentViewerHostStatePath(agentRuntimeDir: string): string {
	return join(agentRuntimeDir, VIEWER_HOST_DISCOVERY_FILE_NAME);
}

export function readPersistentViewerHostState(agentRuntimeDir: string): PersistentViewerHostState | undefined {
	try {
		const parsed = JSON.parse(readFileSync(persistentViewerHostStatePath(agentRuntimeDir), "utf8")) as Partial<PersistentViewerHostState>;
		if (typeof parsed.origin !== "string" || !isLoopbackViewerHostOrigin(parsed.origin)) return undefined;
		const origin = parsed.origin.replace(/\/$/, "");
		if (typeof parsed.viewer_url !== "string" || !parsed.viewer_url.startsWith(`${origin}/viewer-lw`)) return undefined;
		return {
			origin,
			viewer_url: parsed.viewer_url,
			...(typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? { pid: parsed.pid } : {}),
			...(nonEmptyString(parsed.instance_id) === undefined ? {} : { instance_id: parsed.instance_id }),
			...(nonEmptyString(parsed.shutdown_token) === undefined ? {} : { shutdown_token: parsed.shutdown_token }),
			...(nonEmptyString(parsed.control_token) === undefined ? {} : { control_token: parsed.control_token }),
			...(nonEmptyString(parsed.heartbeat_token) === undefined ? {} : { heartbeat_token: parsed.heartbeat_token }),
			...(nonEmptyString(parsed.owner_id) === undefined ? {} : { owner_id: parsed.owner_id }),
			...(typeof parsed.heartbeat_lease_ms === "number" && Number.isInteger(parsed.heartbeat_lease_ms) && parsed.heartbeat_lease_ms > 0 ? { heartbeat_lease_ms: parsed.heartbeat_lease_ms } : {}),
			...(nonEmptyString(parsed.cwd) === undefined ? {} : { cwd: parsed.cwd }),
			updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
			...(typeof parsed.browser_opened_at === "string" ? { browser_opened_at: parsed.browser_opened_at } : {}),
			...(typeof parsed.browser_open_in_progress_at === "string" ? { browser_open_in_progress_at: parsed.browser_open_in_progress_at } : {}),
			...(typeof parsed.browser_open_attempted_at === "string" ? { browser_open_attempted_at: parsed.browser_open_attempted_at } : {}),
		};
	} catch {
		return undefined;
	}
}

export function writePersistentViewerHostState(agentRuntimeDir: string, state: PersistentViewerHostState): void {
	mkdirSync(agentRuntimeDir, { recursive: true, mode: 0o700 });
	chmodSync(agentRuntimeDir, 0o700);
	writeFileSync(persistentViewerHostStatePath(agentRuntimeDir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export function updatePersistentViewerHostState(agentRuntimeDir: string, update: (state: PersistentViewerHostState) => PersistentViewerHostState): void {
	const current = readPersistentViewerHostState(agentRuntimeDir);
	if (current) writePersistentViewerHostState(agentRuntimeDir, update(current));
}

export function isLoopbackViewerHostOrigin(origin: string): boolean {
	try {
		const parsed = new URL(origin);
		return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port !== "" && parsed.pathname === "/";
	} catch {
		return false;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

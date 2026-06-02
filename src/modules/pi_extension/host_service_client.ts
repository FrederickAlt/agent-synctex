import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HostServiceWorkspaceContext } from "../host_service_protocol.ts";
import { defaultHostServiceSocketPath, HOST_SERVICE_SOCKET_PATH_ENV_VAR, HostServiceClient } from "../host_service.ts";

export const HOST_SERVICE_SESSION_ENV_VAR = HOST_SERVICE_SOCKET_PATH_ENV_VAR;
export const HOST_SERVICE_REQUEST_TIMEOUT_MS = 5_000;

export interface HostServiceCallbackTargetWorkspace {
	cwd: string;
	session_id?: string;
}

export function hostServiceSocketPath(): string {
	const override = process.env[HOST_SERVICE_SESSION_ENV_VAR];
	if (override) {
		return override;
	}
	return defaultHostServiceSocketPath();
}

export function createHostServiceClient(socketPath = hostServiceSocketPath(), requestTimeoutMs = HOST_SERVICE_REQUEST_TIMEOUT_MS): HostServiceClient {
	return new HostServiceClient({ socketPath, requestTimeoutMs });
}

export function extractHostServiceErrorCode(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = /\(code=([^\)]+)\)/.exec(message);
	return match?.[1];
}

export function hostServiceWorkspaceContextForSession(ctx: ExtensionContext): HostServiceWorkspaceContext {
	const context: HostServiceWorkspaceContext = {
		cwd: ctx.cwd,
	};
	const rawSessionId = (ctx as { session_id?: unknown }).session_id;
	if (typeof rawSessionId === "string" && rawSessionId.length > 0) {
		context.session_id = rawSessionId;
	}

	return context;
}

export function hostServiceWorkspaceContextForRequest(ctx?: ExtensionContext): HostServiceWorkspaceContext {
	if (ctx) {
		return hostServiceWorkspaceContextForSession(ctx);
	}
	return { cwd: process.cwd() };
}

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { HostServiceWorkspaceContext } from "../host_service_protocol.ts";
import { resolveAgentWorkspaceContext } from "../agent_runtime_context.ts";
import { defaultHostServiceSocketPath, HOST_SERVICE_SOCKET_PATH_ENV_VAR, HostServiceClient } from "../host_service.ts";

export const HOST_SERVICE_SESSION_ENV_VAR = HOST_SERVICE_SOCKET_PATH_ENV_VAR;
export const HOST_SERVICE_REQUEST_TIMEOUT_MS = 5_000;
export const HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS = 300_000;

export type HostServiceCallbackTargetWorkspace = HostServiceWorkspaceContext;

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
	return resolveAgentWorkspaceContext(ctx);
}

export function hostServiceWorkspaceContextForRequest(ctx?: ExtensionContext): HostServiceWorkspaceContext {
	return resolveAgentWorkspaceContext(ctx);
}

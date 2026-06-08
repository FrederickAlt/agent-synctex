import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { errorMessage } from "./error_utils.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
import { cleanupTerminalRefresh, clearTerminalInvalidators, installTerminalRefreshForSession } from "./inline_renderer.ts";
import { resolveAgentWorkspaceContext } from "../agent_runtime_context.ts";
import { initializeLatexPreambleFile } from "./latex_preamble_manager.ts";
import { createHostServiceClient, hostServiceSocketPath, hostServiceWorkspaceContextForSession } from "./host_service_client.ts";
import { contextSessionKey } from "./context_session.ts";
import { createLogger } from "../logging.ts";

const logger = createLogger("pi-extension.lifecycle");
const SESSION_HEARTBEAT_INTERVAL_MS = 10_000;
const sessionHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

function notifyHostServiceError(ctx: ExtensionContext, operation: string, error: unknown): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`Host Service ${operation} failed: ${errorMessage(error)}. Expected socket ${hostServiceSocketPath()}`, "error");
}

function stopSessionHeartbeat(sessionKey: string): void {
	const timer = sessionHeartbeatTimers.get(sessionKey);
	if (!timer) {
		return;
	}
	clearInterval(timer);
	sessionHeartbeatTimers.delete(sessionKey);
}

async function startSessionHeartbeat(ctx: ExtensionContext): Promise<void> {
	const sessionKey = contextSessionKey(ctx);
	stopSessionHeartbeat(sessionKey);
	const workspaceContext = hostServiceWorkspaceContextForSession(ctx);
	const client = createHostServiceClient();
	await client.requestSessionHeartbeat(workspaceContext);
	await client.requestPendingNotifications(workspaceContext);
	const timer = setInterval(() => {
		void client.requestSessionHeartbeat(workspaceContext).catch((error) => {
			logger.warn("session_heartbeat.error", { error });
		});
	}, SESSION_HEARTBEAT_INTERVAL_MS);
	timer.unref?.();
	sessionHeartbeatTimers.set(sessionKey, timer);
}

export function registerLifecycleHandlers(
	pi: ExtensionAPI,
	callbackManager: SynctexCallbackManager,
): void {
	pi.on("session_start", async (_event, ctx) => {
		logger.info("session_start.begin", { has_ui: Boolean(ctx?.hasUI), cwd: ctx?.cwd });
		cleanupTerminalRefresh();
		installTerminalRefreshForSession(Boolean(ctx?.hasUI), ctx?.ui);
		try {
			if (ctx) {
				const workspaceContext = resolveAgentWorkspaceContext(ctx);
				initializeLatexPreambleFile({ cwd: ctx.cwd, runtimeDirectory: workspaceContext.workspace_root });
				await startSessionHeartbeat(ctx);
				await callbackManager.rotateSynctexCallbacks(ctx);
				await callbackManager.ensureHostServiceCallbackTarget(ctx);
				logger.info("session_start.end", { cwd: ctx.cwd, workspace_root: workspaceContext.workspace_root });
			} else {
				logger.info("session_start.end", { has_context: false });
			}
		} catch (error) {
			logger.error("session_start.error", { error });
			if (ctx) {
				stopSessionHeartbeat(contextSessionKey(ctx));
				notifyHostServiceError(ctx, "startup", error);
			} else {
				console.error(`Host Service startup failed: ${errorMessage(error)}`);
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		logger.info("session_shutdown.begin", { has_context: Boolean(ctx), cwd: ctx?.cwd });
		cleanupTerminalRefresh();
		clearTerminalInvalidators();
		if (ctx) {
			const contextKey = callbackManager.contextKeyForContext(ctx);
			stopSessionHeartbeat(contextSessionKey(ctx));
			try {
				await callbackManager.unregisterHostServiceCallbackTarget(contextKey);
			} catch (error) {
				logger.error("session_shutdown.unregister_callback.error", { error });
				notifyHostServiceError(ctx, "cleanup", error);
			}
		} else {
			for (const sessionKey of sessionHeartbeatTimers.keys()) {
				stopSessionHeartbeat(sessionKey);
			}
			await callbackManager.unregisterAllHostServiceCallbacks();
		}
		await callbackManager.shutdownSynctexCallbacks();
		logger.info("session_shutdown.end", { has_context: Boolean(ctx) });
	});
}

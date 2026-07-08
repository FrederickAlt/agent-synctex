import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { errorMessage } from "./error_utils.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
import { cleanupTerminalRefresh, clearTerminalInvalidators, installTerminalRefreshForSession } from "./inline_renderer.ts";
import { resolveAgentWorkspaceContext } from "../agent_runtime_context.ts";
import { createHostServiceClient, hostServiceSocketPath, hostServiceWorkspaceContextForSession } from "./host_service_client.ts";
import { contextSessionKey } from "./context_session.ts";
import { createLogger } from "../logging.ts";

const logger = createLogger("pi-extension.lifecycle");
const DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS = 10_000;
export const SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR = "TEX_ACTIONS_SESSION_HEARTBEAT_INTERVAL_MS";
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

function sessionHeartbeatIntervalMs(): number {
	const raw = process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR];
	if (raw === undefined) {
		return DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS;
}

function isUnsupportedHeartbeatError(error: unknown): boolean {
	const message = errorMessage(error);
	return /unsupported operation: session_heartbeat/.test(message)
		|| /Malformed host service response payload:.*session_heartbeat/.test(message);
}

function notifyUnsupportedHeartbeat(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify("Host Service is too old for session heartbeats; restart the Host Service to enable session lease support.", "warning");
}

function isUnsupportedPendingNotificationsError(error: unknown): boolean {
	const message = errorMessage(error);
	return /unsupported operation: get_pending_notifications/.test(message)
		|| /Malformed host service response payload:.*get_pending_notifications/.test(message);
}

async function injectPendingSystemInfo(ctx: ExtensionContext): Promise<void> {
	const client = createHostServiceClient();
	try {
		const pending = await client.requestPendingNotifications(hostServiceWorkspaceContextForSession(ctx));
		const messages = pending.notifications.map((notification) => notification.message).filter((message) => message.trim());
		if (messages.length > 0) {
			ctx.ui.pasteToEditor(messages.join("\n\n"));
		}
	} catch (error) {
		if (isUnsupportedPendingNotificationsError(error)) {
			logger.warn("pending_notifications.unsupported", { error });
			return;
		}
		throw error;
	}
}

async function startSessionHeartbeat(ctx: ExtensionContext): Promise<void> {
	const sessionKey = contextSessionKey(ctx);
	stopSessionHeartbeat(sessionKey);
	const workspaceContext = hostServiceWorkspaceContextForSession(ctx);
	const client = createHostServiceClient();
	try {
		await client.requestSessionHeartbeat(workspaceContext);
	} catch (error) {
		if (isUnsupportedHeartbeatError(error)) {
			logger.warn("session_heartbeat.unsupported", { error });
			notifyUnsupportedHeartbeat(ctx);
			return;
		}
		throw error;
	}
	const timer = setInterval(() => {
		void client.requestSessionHeartbeat(workspaceContext).catch((error) => {
			logger.warn("session_heartbeat.error", { error });
		});
	}, sessionHeartbeatIntervalMs());
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
				await startSessionHeartbeat(ctx);
				await injectPendingSystemInfo(ctx);
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
			try {
				await injectPendingSystemInfo(ctx);
			} catch (error) {
				logger.error("session_shutdown.pending_notifications.error", { error });
				notifyHostServiceError(ctx, "pending notification retrieval", error);
			}
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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { errorMessage } from "./error_utils.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
import { cleanupTerminalRefresh, clearTerminalInvalidators, installTerminalRefreshForSession } from "./inline_renderer.ts";
import { hostServiceSocketPath } from "./host_service_client.ts";

function notifyHostServiceError(ctx: ExtensionContext, operation: string, error: unknown): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`Host Service ${operation} failed: ${errorMessage(error)}. Expected socket ${hostServiceSocketPath()}`, "error");
}

export function registerLifecycleHandlers(
	pi: ExtensionAPI,
	callbackManager: SynctexCallbackManager,
): void {
	pi.on("session_start", async (_event, ctx) => {
		cleanupTerminalRefresh();
		installTerminalRefreshForSession(Boolean(ctx?.hasUI), ctx?.ui);
		try {
			if (ctx) {
				await callbackManager.rotateSynctexCallbacks(ctx);
				await callbackManager.ensureHostServiceCallbackTarget(ctx);
			}
		} catch (error) {
			if (ctx) {
				notifyHostServiceError(ctx, "startup", error);
			} else {
				console.error(`Host Service startup failed: ${errorMessage(error)}`);
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cleanupTerminalRefresh();
		clearTerminalInvalidators();
		if (ctx) {
			const contextKey = callbackManager.contextKeyForContext(ctx);
			try {
				await callbackManager.unregisterHostServiceCallbackTarget(contextKey);
			} catch (error) {
				notifyHostServiceError(ctx, "cleanup", error);
			}
		} else {
			await callbackManager.unregisterAllHostServiceCallbacks();
		}
		await callbackManager.shutdownSynctexCallbacks();
	});
}

import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { contextSessionKey } from "./context_session.ts";
import { SynctexCallbackServer, type SynctexPasteTarget } from "../synctex/synctex.ts";
import { getMcpTmpDir } from "./runtime_paths.ts";
import { createHostServiceClient, hostServiceSocketPath, type HostServiceCallbackTargetWorkspace } from "./host_service_client.ts";

const HOST_SERVICE_CALLBACK_TARGET_PREFIX = "pi";

function resolveSynctexCallbackScriptPath(): string {
	const candidates: string[] = [];

	try {
		const extDir = dirname(fileURLToPath(new URL("./", import.meta.url)));
		candidates.push(resolve(extDir, "../../../scripts", "pi_synctex_callback.mjs"));
	} catch {
		// extension root detection unavailable in this runtime mode
	}

	candidates.push(resolve(process.cwd(), "scripts", "pi_synctex_callback.mjs"));
	candidates.push(resolve(process.cwd(), ".pi", "extensions", "pdf-preview", "scripts", "pi_synctex_callback.mjs"));
	candidates.push(resolve(homedir(), ".pi", "agent", "extensions", "pdf-preview", "scripts", "pi_synctex_callback.mjs"));

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	return candidates[0] ?? "/tmp/pi_synctex_callback.mjs";
}

export interface RegisteredHostServiceTarget {
	targetId: string;
	workspaceContext: HostServiceCallbackTargetWorkspace;
	socketPath: string;
}

export class SynctexCallbackManager {
	private readonly callbackScriptPath = resolveSynctexCallbackScriptPath();
	private readonly synctexCallbacksByContext = new Map<string, SynctexCallbackServer>();
	private readonly synctexCallbackServers = new Set<SynctexCallbackServer>();
	private readonly hostServiceSessionTargets = new Map<string, RegisteredHostServiceTarget>();

	contextKeyForContext(ctx: ExtensionContext): string {
		return contextSessionKey(ctx);
	}

	targetIdForContext(ctx: ExtensionContext): string {
		return `${HOST_SERVICE_CALLBACK_TARGET_PREFIX}:${this.contextKeyForContext(ctx)}`;
	}

	callbackTargetForContext(ctx: ExtensionContext): SynctexPasteTarget {
		return {
			cwd: ctx.cwd,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		};
	}

	hostServiceWorkspaceContextForSession(ctx: ExtensionContext): HostServiceCallbackTargetWorkspace {
		const context: HostServiceCallbackTargetWorkspace = { cwd: ctx.cwd };
		const rawSessionId = (ctx as { session_id?: unknown }).session_id;
		if (typeof rawSessionId === "string" && rawSessionId.length > 0) {
			context.session_id = rawSessionId;
		}
		return context;
	}

	private createSynctexCallbackServer(): SynctexCallbackServer {
		return new SynctexCallbackServer({ callbackScriptPath: this.callbackScriptPath, tmpDir: getMcpTmpDir() });
	}

	async rotateSynctexCallbacks(ctx: ExtensionContext): Promise<SynctexCallbackServer> {
		const key = this.contextKeyForContext(ctx);
		const previous = this.synctexCallbacksByContext.get(key);
		const next = this.createSynctexCallbackServer();
		this.synctexCallbacksByContext.set(key, next);
		this.synctexCallbackServers.add(next);
		if (previous) this.synctexCallbackServers.delete(previous);
		await previous?.close();
		await next.ensureStarted(this.callbackTargetForContext(ctx));
		return next;
	}

	async ensureSynctexCallbacks(ctx: ExtensionContext): Promise<SynctexCallbackServer> {
		const key = this.contextKeyForContext(ctx);
		let server = this.synctexCallbacksByContext.get(key);
		if (!server) {
			server = this.createSynctexCallbackServer();
			this.synctexCallbacksByContext.set(key, server);
			this.synctexCallbackServers.add(server);
		}
		await server.ensureStarted(this.callbackTargetForContext(ctx));
		return server;
	}

	async ensureHostServiceCallbackTarget(ctx: ExtensionContext): Promise<string> {
		const contextKey = this.contextKeyForContext(ctx);
		const targetId = this.targetIdForContext(ctx);
		const workspaceContext = this.hostServiceWorkspaceContextForSession(ctx);

		if (this.hostServiceSessionTargets.has(contextKey)) {
			const client = createHostServiceClient(hostServiceSocketPath());
			try {
				const resolved = await client.requestResolveCallbackTarget(workspaceContext, targetId);
				if (resolved.callback_available) return targetId;
			} catch {
				// Fall back to re-registering the target if possible.
			}
		}

		await this.registerHostServiceCallbackTarget(ctx);
		return targetId;
	}

	async registerHostServiceCallbackTarget(ctx: ExtensionContext): Promise<void> {
		const contextKey = this.contextKeyForContext(ctx);
		const targetId = this.targetIdForContext(ctx);
		const workspaceContext = this.hostServiceWorkspaceContextForSession(ctx);
		const callbackServer = await this.ensureSynctexCallbacks(ctx);
		const socketPath = hostServiceSocketPath();
		const client = createHostServiceClient(socketPath);

		await client.requestStatus(workspaceContext);
		await client.requestRegisterCallbackTarget(workspaceContext, {
			target_id: targetId,
			target: callbackServer.callbackConfig,
		});

		this.hostServiceSessionTargets.set(contextKey, {
			targetId,
			workspaceContext,
			socketPath,
		});
	}

	async unregisterHostServiceCallbackTarget(contextKey: string): Promise<void> {
		const registration = this.hostServiceSessionTargets.get(contextKey);
		if (!registration) return;

		this.hostServiceSessionTargets.delete(contextKey);
		const client = createHostServiceClient(registration.socketPath);
		await client.requestUnregisterCallbackTarget(registration.workspaceContext, registration.targetId);
	}

	async unregisterAllHostServiceCallbacks(): Promise<void> {
		const contextKeys = [...this.hostServiceSessionTargets.keys()];
		await Promise.allSettled(contextKeys.map((contextKey) => this.unregisterHostServiceCallbackTarget(contextKey)));
	}

	async shutdownSynctexCallbacks(ctx?: ExtensionContext): Promise<void> {
		if (ctx) {
			const key = this.contextKeyForContext(ctx);
			const server = this.synctexCallbacksByContext.get(key);
			if (!server) return;
			this.synctexCallbacksByContext.delete(key);
			this.synctexCallbackServers.delete(server);
			await server.close();
			return;
		}

		const servers = [...this.synctexCallbackServers];
		this.synctexCallbacksByContext.clear();
		this.synctexCallbackServers.clear();
		await Promise.all(servers.map((server) => server.close()));
	}
}

export function createSynctexCallbackManager(): SynctexCallbackManager {
	return new SynctexCallbackManager();
}

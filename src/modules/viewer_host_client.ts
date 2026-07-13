import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadablePdfFile, assertReadableSourceFile, inferDefaultSourceFileForPdf } from "./pdf_tracking/pdf_tracking.ts";
import { mapReverseSynctex } from "./synctex/forward_synctex.ts";
import { resolveForwardSynctexJump, reverseSynctexHoverResult, reverseSynctexPdfEventFromViewerMessage, type ReverseSynctexMapper } from "./synctex/synctex_resolution.ts";
import { PdfEventStore, type GetPdfEventsRequest, type PdfEvent } from "./pdf_events.ts";
import { collectPostUserPdfContextFromEvents, pdfAnnotationEventsFromViewerMarks, type FetchPdfContextRequest, type PostUserPdfContextResult } from "./post_user_pdf_context.ts";
import type { AcknowledgedPdfMark, PendingPdfMarkClaim } from "./pending_pdf_marks.ts";
import type {
	HostServiceJumpRequest,
	HostServiceJumpResponseEnvelope,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
	HostServiceWorkspaceContext,
} from "./host_service_protocol.ts";
import type { HostServiceMcpPdfOperations } from "./host_service_mcp.ts";
import {
	VIEWER_HOST_CONTROL_TOKEN_HEADER,
	VIEWER_HOST_HEARTBEAT_TOKEN_HEADER,
	VIEWER_HOST_PROTOCOL_VERSION,
	VIEWER_HOST_SHUTDOWN_TOKEN_HEADER,
	validateMcpToViewerHostMessage,
	validateViewerHostToMcpMessage,
	type McpToViewerHostMessage,
	type ViewerHostControlResponse,
	type ViewerHostReverseSynctexHoverMessage,
	type ViewerHostReverseSynctexMessage,
	type ViewerHostToMcpMessage,
} from "./viewer_host_protocol.ts";
import { ViewerHostControlClient } from "./viewer_host_control_client.ts";
import { ViewerHostMarksClient } from "./viewer_host_marks_client.ts";
import { persistentViewerHostStatePath, readPersistentViewerHostState, updatePersistentViewerHostState, writePersistentViewerHostState, type PersistentViewerHostState } from "./viewer_host_discovery.ts";
import { ViewerFailureReporter, type ViewerFailureContext } from "./viewer_failure_reporter.ts";
import { createLogger } from "./logging.ts";

const VIEWER_HOST_BACKEND_NAME = "viewer-host-client";
const logger = createLogger("viewer-host.mcp-service");
const VIEWER_HOST_CAPABILITIES = {
	open: true,
	close: false,
	forward_search: true,
	inverse_search: true,
	reuse: true,
};
const MIN_PDF_ID = 1;
const MAX_PDF_ID = 99_999_999;
const DEFAULT_VIEWER_HOST_READY_TIMEOUT_MS = 10_000;
const DEFAULT_VIEWER_HOST_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_BROWSER_OPEN_ACK_TIMEOUT_MS = 2_000;
const BROWSER_OPEN_ACK_POLL_INTERVAL_MS = 100;
const DEFAULT_VIEWER_HOST_HEARTBEAT_LEASE_MS = 5_000;
const DEFAULT_VIEWER_HOST_HEARTBEAT_INTERVAL_MS = 1_000;
const BROWSER_OPEN_IN_PROGRESS_TTL_MS = 30_000;
const DEFAULT_VIEWER_HOST_OWNER_ID = `mcp-${process.pid}-${randomBytes(16).toString("base64url")}`;

interface BrowserOpenState {
	inProgressUntilMs?: number;
}

const browserOpenStateByOrigin = new Map<string, BrowserOpenState>();
const viewerHostStartupByRuntimeDir = new Map<string, Promise<ViewerHostClient>>();

interface TrackedViewerHostPdf {
	pdfId: number;
	pdfPath: string;
	workspaceCwd: string;
	createdAtNs: number;
	revision: number;
	viewerUrl: string;
	debugSynctexEnabled: boolean;
	fileSnapshot?: { size: number; mtimeMs: number };
}

type ViewerCompileAction = Extract<ViewerHostToMcpMessage, { type: "compile_action" }>;
type ViewerCompileActionHandler = (message: ViewerCompileAction, record: TrackedViewerHostPdf) => Promise<void> | void;

export interface ViewerHostClient {
	readonly origin: string;
	send(message: McpToViewerHostMessage): Promise<void | ViewerHostControlResponse>;
	drainEvents?(pdfIds?: readonly number[], eventTypes?: readonly ViewerHostToMcpMessage["type"][]): Promise<ViewerHostToMcpMessage[]>;
	claimPdfMarks?(pdfIds?: readonly number[], maxMarks?: number): Promise<PendingPdfMarkClaim>;
	acknowledgePdfMarks?(claimId: string, consumed: readonly AcknowledgedPdfMark[]): Promise<AcknowledgedPdfMark[]>;
	close?(): Promise<void> | void;
	shutdownHost?(): Promise<void> | void;
}

export type ViewerHostClientFactory = () => ViewerHostClient | Promise<ViewerHostClient>;

export interface BrowserViewerLaunchTarget {
	origin: string;
	viewerUrl: string;
}

export interface BrowserViewerLauncher {
	launchOrFocus(target: BrowserViewerLaunchTarget): Promise<void> | void;
	close?(): Promise<void> | void;
}

export interface SystemBrowserViewerLauncherOptions {
	command?: string;
	args?: string[];
}

export function resolveSystemBrowserOpenConfig(viewerUrl: string, options: SystemBrowserViewerLauncherOptions = {}, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
	if (options.command !== undefined) return { command: options.command, args: [...(options.args ?? []), viewerUrl] };
	if (process.env.AGENT_SYNCTEX_BROWSER_COMMAND?.trim()) return { command: process.env.AGENT_SYNCTEX_BROWSER_COMMAND, args: [viewerUrl] };
	if (platform === "darwin") return { command: "open", args: [viewerUrl] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", viewerUrl] };
	return { command: "xdg-open", args: [viewerUrl] };
}

export class SystemBrowserViewerLauncher implements BrowserViewerLauncher {
	private readonly options: SystemBrowserViewerLauncherOptions;

	constructor(options: SystemBrowserViewerLauncherOptions = {}) {
		this.options = options;
	}

	async launchOrFocus(target: BrowserViewerLaunchTarget): Promise<void> {
		const config = this.resolveConfig(target.viewerUrl);
		const child = spawn(config.command, config.args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += String(chunk);
			if (stderr.length > 2_048) stderr = stderr.slice(-2_048);
		});
		await waitForSpawn(child, `failed to open browser viewer ${target.viewerUrl}`);
		const earlyExit = await waitForEarlyProcessExit(child, 750);
		if (earlyExit && earlyExit.code !== 0) {
			throw new Error(`browser opener ${config.command} exited ${earlyExit.signal ? `with signal ${earlyExit.signal}` : `with code ${earlyExit.code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
		}
		if (!earlyExit) child.stderr?.destroy();
		child.unref();
	}

	private resolveConfig(viewerUrl: string): { command: string; args: string[] } {
		return resolveSystemBrowserOpenConfig(viewerUrl, this.options);
	}
}

interface ActiveViewerHostSession {
	client: ViewerHostClient;
	generation: number;
}

interface ViewerHostSendResult {
	session: ActiveViewerHostSession;
	response?: ViewerHostControlResponse;
}

interface ClaimedHostPdfMarks {
	claim: PendingPdfMarkClaim;
	client: Required<Pick<ViewerHostClient, "acknowledgePdfMarks">>;
}

export class FakeViewerHostClient implements ViewerHostClient {
	readonly origin: string;
	readonly messages: McpToViewerHostMessage[] = [];

	constructor(options: { origin?: string } = {}) {
		this.origin = options.origin ?? "http://127.0.0.1:43125";
	}

	async send(message: McpToViewerHostMessage): Promise<void> {
		this.messages.push(validateMcpToViewerHostMessage(message));
	}
}

export interface ViewerHostProcessLauncherOptions {
	command?: string;
	args?: string[];
	readyTimeoutMs?: number;
	shutdownTimeoutMs?: number;
	browserOpenAckTimeoutMs?: number;
	heartbeatLeaseMs?: number;
	heartbeatIntervalMs?: number;
	viewerHostOwnerId?: string;
	browserLauncher?: BrowserViewerLauncher;
	agentRuntimeDir?: string;
	workspaceCwd?: string;
	requestTimeoutMs?: number;
}

interface ViewerHostReadyLine {
	type: "ready";
	origin: string;
	viewer_url: string;
	instance_id: string;
}

interface BrowserOpenCoordinator {
	begin(): boolean;
	confirmed(): void;
}

interface ViewerHostHeartbeatOptions {
	ownerId: string;
	token: string;
	intervalMs: number;
}

class HttpViewerHostProcessClient implements ViewerHostClient {
	readonly origin: string;
	private readonly viewerUrl: string;
	private readonly browserLauncher: BrowserViewerLauncher;
	private readonly browserOpenAckTimeoutMs: number;
	private readonly controlClient: ViewerHostControlClient;
	private readonly marksClient: ViewerHostMarksClient;
	private readonly controlToken: string | undefined;
	private readonly closeHost: (() => Promise<void>) | undefined;
	private readonly shutdownHostHandler: (() => Promise<void>) | undefined;
	private readonly browserOpenCoordinator: BrowserOpenCoordinator;
	private readonly heartbeat: ViewerHostHeartbeatOptions | undefined;
	private readonly requestTimeoutMs: number;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private heartbeatInFlight = false;
	private launchBrowserOnNextOpen: boolean;
	private closed = false;
	private hostShutdownStarted = false;

	constructor(options: { origin: string; viewerUrl: string; browserLauncher: BrowserViewerLauncher; controlToken?: string; closeHost?: () => Promise<void>; shutdownHost?: () => Promise<void>; launchBrowserOnNextOpen?: boolean; browserOpenCoordinator?: BrowserOpenCoordinator; browserOpenAckTimeoutMs?: number; heartbeat?: ViewerHostHeartbeatOptions; requestTimeoutMs?: number }) {
		this.origin = options.origin.replace(/\/$/, "");
		this.viewerUrl = options.viewerUrl;
		this.browserLauncher = options.browserLauncher;
		this.browserOpenAckTimeoutMs = options.browserOpenAckTimeoutMs ?? DEFAULT_BROWSER_OPEN_ACK_TIMEOUT_MS;
		this.controlToken = options.controlToken;
		this.controlClient = new ViewerHostControlClient({ origin: this.origin, controlToken: this.controlToken, requestTimeoutMs: options.requestTimeoutMs });
		this.marksClient = new ViewerHostMarksClient({ origin: this.origin, controlToken: this.controlToken, requestTimeoutMs: options.requestTimeoutMs });
		this.closeHost = options.closeHost;
		this.shutdownHostHandler = options.shutdownHost;
		this.launchBrowserOnNextOpen = options.launchBrowserOnNextOpen ?? true;
		this.browserOpenCoordinator = options.browserOpenCoordinator ?? createMemoryBrowserOpenCoordinator(this.origin);
		this.heartbeat = options.heartbeat;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
		this.startHeartbeat();
	}

	async send(message: McpToViewerHostMessage): Promise<ViewerHostControlResponse> {
		if (this.closed) throw new Error("Viewer Host process is closed");
		const response = await this.controlClient.send(message);
		if (response.ok === true && (message.type === "open_pdf" || message.type === "focus_pdf")) {
			return await this.annotateBrowserOpenStatus(response);
		}
		return response;
	}

	private async annotateBrowserOpenStatus(response: ViewerHostControlResponse): Promise<ViewerHostControlResponse> {
		if (response.ok !== true || !("result" in response)) return response;
		const alreadyActiveCount = await this.activeViewerClientCount();
		if (alreadyActiveCount > 0) {
			this.launchBrowserOnNextOpen = false;
			return { ...response, result: { ...response.result, browser_open_attempted: false, browser_open_confirmed: true, active_viewer_clients: alreadyActiveCount } };
		}

		let browserOpenError: string | undefined;
		let browserOpenAttempted = false;
		if (this.launchBrowserOnNextOpen && this.browserOpenCoordinator.begin()) {
			browserOpenAttempted = true;
			try {
				await this.browserLauncher.launchOrFocus({ origin: this.origin, viewerUrl: this.viewerUrl });
			} catch (error) {
				browserOpenError = error instanceof Error ? error.message : String(error);
			}
		}
		const activeCount = await this.waitForActiveViewerClient(this.browserOpenAckTimeoutMs);
		const confirmed = activeCount > 0;
		if (confirmed) {
			this.launchBrowserOnNextOpen = false;
			this.browserOpenCoordinator.confirmed();
		}
		return {
			...response,
			result: {
				...response.result,
				browser_open_attempted: browserOpenAttempted,
				browser_open_confirmed: confirmed,
				active_viewer_clients: activeCount,
				...(browserOpenError === undefined ? {} : { browser_open_error: browserOpenError }),
			},
		};
	}

	private async waitForActiveViewerClient(timeoutMs: number): Promise<number> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		let count = await this.activeViewerClientCount();
		while (count <= 0 && Date.now() < deadline) {
			await sleep(Math.min(BROWSER_OPEN_ACK_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
			count = await this.activeViewerClientCount();
		}
		return count;
	}

	private async activeViewerClientCount(): Promise<number> {
		try {
			const response = await this.controlClient.send({ type: "hello", protocol_version: VIEWER_HOST_PROTOCOL_VERSION });
			if (response.ok === true && "message" in response && typeof response.message.active_viewer_clients === "number") {
				return response.message.active_viewer_clients;
			}
		} catch {
			return 0;
		}
		return 0;
	}

	private startHeartbeat(): void {
		if (this.heartbeat === undefined) return;
		void this.sendHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			void this.sendHeartbeat();
		}, Math.max(50, this.heartbeat.intervalMs));
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer === undefined) return;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private async sendHeartbeat(): Promise<void> {
		if (this.closed || this.heartbeat === undefined || this.heartbeatInFlight) return;
		this.heartbeatInFlight = true;
		try {
			await fetch(`${this.origin}/heartbeat`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[VIEWER_HOST_HEARTBEAT_TOKEN_HEADER]: this.heartbeat.token,
				},
				body: JSON.stringify({ owner_id: this.heartbeat.ownerId }),
				signal: AbortSignal.timeout(Math.max(50, Math.min(this.heartbeat.intervalMs, 1_000))),
			});
		} catch {
			// The lease monitor handles missed heartbeats; individual failures are non-fatal.
		} finally {
			this.heartbeatInFlight = false;
		}
	}

	async drainEvents(pdfIds?: readonly number[], eventTypes?: readonly ViewerHostToMcpMessage["type"][]): Promise<ViewerHostToMcpMessage[]> {
		if (this.closed) return [];
		const body = pdfIds === undefined && eventTypes === undefined ? undefined : JSON.stringify({ ...(pdfIds === undefined ? {} : { pdf_ids: pdfIds }), ...(eventTypes === undefined ? {} : { event_types: eventTypes }) });
		const response = await fetch(`${this.origin}/mcp-events/drain`, {
			method: "POST",
			headers: { ...this.controlHeaders(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body }),
			signal: AbortSignal.timeout(Math.max(1, this.requestTimeoutMs)),
		});
		const payload = await response.json() as { ok?: unknown; events?: unknown; error?: { message?: unknown } };
		if (!response.ok || payload.ok !== true || !Array.isArray(payload.events)) {
			throw new Error(typeof payload.error?.message === "string" ? payload.error.message : "failed to drain Viewer Host MCP events");
		}
		return payload.events.map((event) => validateViewerHostToMcpMessage(event));
	}

	async claimPdfMarks(pdfIds?: readonly number[], maxMarks?: number): Promise<PendingPdfMarkClaim> {
		return this.closed ? { marks: [] } : await this.marksClient.claimPdfMarks(pdfIds, maxMarks);
	}

	async acknowledgePdfMarks(claimId: string, consumed: readonly AcknowledgedPdfMark[]): Promise<AcknowledgedPdfMark[]> {
		return this.closed ? [] : await this.marksClient.acknowledgePdfMarks(claimId, consumed);
	}

	private controlHeaders(): Record<string, string> {
		return this.controlToken === undefined ? {} : { [VIEWER_HOST_CONTROL_TOKEN_HEADER]: this.controlToken };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.stopHeartbeat();
		if (this.closeHost) {
			this.hostShutdownStarted = true;
			await this.closeHost();
		}
	}

	async shutdownHost(): Promise<void> {
		if (this.hostShutdownStarted) return;
		this.hostShutdownStarted = true;
		this.closed = true;
		this.stopHeartbeat();
		if (this.shutdownHostHandler) {
			await this.shutdownHostHandler();
			return;
		}
		await this.closeHost?.();
	}
}

class LocalViewerHostProcessClient extends HttpViewerHostProcessClient {
	constructor(child: ChildProcessWithoutNullStreams, ready: ViewerHostReadyLine, shutdownTimeoutMs: number, browserLauncher: BrowserViewerLauncher, browserOpenAckTimeoutMs: number, controlToken: string) {
		super({
			origin: ready.origin,
			viewerUrl: ready.viewer_url,
			browserLauncher,
			browserOpenAckTimeoutMs,
			controlToken,
			closeHost: async () => {
				await browserLauncher.close?.();
				child.stdin.write("shutdown\n");
				await waitForProcessExitOrKill(child, shutdownTimeoutMs);
			},
		});
	}
}

export function createDefaultViewerHostClientFactory(options: ViewerHostProcessLauncherOptions = {}): ViewerHostClientFactory {
	const viewerHostOwnerId = options.viewerHostOwnerId ?? DEFAULT_VIEWER_HOST_OWNER_ID;
	return async () => launchLocalViewerHostProcess({ ...options, viewerHostOwnerId });
}

function defaultBrowserViewerLauncher(_shutdownTimeoutMs: number): BrowserViewerLauncher {
	return new SystemBrowserViewerLauncher();
}

async function launchLocalViewerHostProcess(options: ViewerHostProcessLauncherOptions): Promise<ViewerHostClient> {
	const start = async (): Promise<ViewerHostClient> => {
		const command = options.command ?? process.execPath;
		const args = options.args ?? [fileURLToPath(new URL("../../scripts/viewer-host-server.ts", import.meta.url))];
		const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_VIEWER_HOST_READY_TIMEOUT_MS;
		const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_VIEWER_HOST_SHUTDOWN_TIMEOUT_MS;
		const browserOpenAckTimeoutMs = options.browserOpenAckTimeoutMs ?? DEFAULT_BROWSER_OPEN_ACK_TIMEOUT_MS;
		const heartbeatLeaseMs = options.heartbeatLeaseMs ?? DEFAULT_VIEWER_HOST_HEARTBEAT_LEASE_MS;
		const heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.min(DEFAULT_VIEWER_HOST_HEARTBEAT_INTERVAL_MS, Math.max(50, Math.floor(heartbeatLeaseMs / 3)));
		const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
		const viewerHostOwnerId = options.viewerHostOwnerId ?? DEFAULT_VIEWER_HOST_OWNER_ID;
		const browserLauncher = options.browserLauncher ?? defaultBrowserViewerLauncher(shutdownTimeoutMs);
		const reusableClient = options.agentRuntimeDir === undefined ? undefined : await reusableViewerHostClient(options.agentRuntimeDir, browserLauncher, browserOpenAckTimeoutMs, shutdownTimeoutMs, viewerHostOwnerId, heartbeatIntervalMs, requestTimeoutMs);
		if (reusableClient) return reusableClient;
		const persistent = options.agentRuntimeDir !== undefined;
		const controlToken = randomBytes(32).toString("base64url");
		const heartbeatToken = persistent ? randomBytes(32).toString("base64url") : undefined;
		const shutdownToken = persistent ? randomBytes(32).toString("base64url") : undefined;
		const instanceId = randomBytes(24).toString("base64url");
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: persistent,
			env: {
				...process.env,
				...(persistent ? {
					AGENT_SYNCTEX_PERSISTENT_VIEWER_HOST: "1",
					AGENT_SYNCTEX_VIEWER_HOST_OWNER_ID: viewerHostOwnerId,
					...(heartbeatToken === undefined ? {} : { AGENT_SYNCTEX_VIEWER_HOST_HEARTBEAT_TOKEN: heartbeatToken }),
					...(shutdownToken === undefined ? {} : { AGENT_SYNCTEX_VIEWER_HOST_SHUTDOWN_TOKEN: shutdownToken }),
					AGENT_SYNCTEX_VIEWER_HOST_HEARTBEAT_LEASE_MS: String(heartbeatLeaseMs),
				} : {}),
				AGENT_SYNCTEX_VIEWER_HOST_CONTROL_TOKEN: controlToken,
				AGENT_SYNCTEX_VIEWER_HOST_INSTANCE_ID: instanceId,
			},
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += String(chunk);
			if (stderr.length > 8_192) stderr = stderr.slice(-8_192);
		});
		try {
			const ready = await readViewerHostReadyLine(child, readyTimeoutMs, () => stderr);
			if (ready.instance_id !== instanceId) throw new Error("Viewer Host Server reported an unexpected instance_id");
			if (!persistent || options.agentRuntimeDir === undefined) {
				return new LocalViewerHostProcessClient(child, ready, shutdownTimeoutMs, browserLauncher, browserOpenAckTimeoutMs, controlToken);
			}
			const state: PersistentViewerHostState = {
				origin: ready.origin,
				viewer_url: ready.viewer_url,
				pid: child.pid,
				instance_id: instanceId,
				...(shutdownToken === undefined ? {} : { shutdown_token: shutdownToken }),
				control_token: controlToken,
				...(heartbeatToken === undefined ? {} : { heartbeat_token: heartbeatToken }),
				owner_id: viewerHostOwnerId,
				heartbeat_lease_ms: heartbeatLeaseMs,
				...(options.workspaceCwd === undefined ? {} : { cwd: resolve(options.workspaceCwd) }),
				updated_at: new Date().toISOString(),
			};
			writePersistentViewerHostState(options.agentRuntimeDir, state);
			child.stdin.end();
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			return new HttpViewerHostProcessClient({
				origin: ready.origin,
				viewerUrl: ready.viewer_url,
				browserLauncher,
				browserOpenAckTimeoutMs,
				controlToken,
				requestTimeoutMs,
				browserOpenCoordinator: createPersistentBrowserOpenCoordinator(options.agentRuntimeDir!, ready.origin),
				shutdownHost: () => shutdownDiscoveredViewerHost(options.agentRuntimeDir!, state, browserLauncher, shutdownTimeoutMs),
				...(heartbeatToken === undefined ? {} : { heartbeat: { ownerId: viewerHostOwnerId, token: heartbeatToken, intervalMs: heartbeatIntervalMs } }),
			});
		} catch (error) {
			child.kill("SIGKILL");
			throw error;
		}
	};

	const startupKey = options.agentRuntimeDir === undefined ? undefined : resolve(options.agentRuntimeDir);
	if (startupKey !== undefined) {
		const existingStartup = viewerHostStartupByRuntimeDir.get(startupKey);
		if (existingStartup) return await existingStartup;
		const startup = start();
		viewerHostStartupByRuntimeDir.set(startupKey, startup);
		try {
			return await startup;
		} finally {
			if (viewerHostStartupByRuntimeDir.get(startupKey) === startup) {
				viewerHostStartupByRuntimeDir.delete(startupKey);
			}
		}
	}
	return await start();
}

function createMemoryBrowserOpenCoordinator(origin: string): BrowserOpenCoordinator {
	const key = origin.replace(/\/$/, "");
	return {
		begin(): boolean {
			const now = Date.now();
			const current = browserOpenStateByOrigin.get(key);
			if (current?.inProgressUntilMs !== undefined && current.inProgressUntilMs > now) return false;
			browserOpenStateByOrigin.set(key, { inProgressUntilMs: now + BROWSER_OPEN_IN_PROGRESS_TTL_MS });
			return true;
		},
		confirmed(): void {
			browserOpenStateByOrigin.delete(key);
		},
	};
}

function createPersistentBrowserOpenCoordinator(agentRuntimeDir: string, origin: string): BrowserOpenCoordinator {
	const memory = createMemoryBrowserOpenCoordinator(origin);
	return {
		begin(): boolean {
			if (!tryAcquireBrowserOpenLock(agentRuntimeDir, origin)) return false;
			if (!memory.begin()) {
				releaseBrowserOpenLock(agentRuntimeDir);
				return false;
			}
			const now = new Date().toISOString();
			updatePersistentViewerHostState(agentRuntimeDir, (current) => ({
				...current,
				browser_open_in_progress_at: now,
				browser_open_attempted_at: now,
				updated_at: now,
			}));
			return true;
		},
		confirmed(): void {
			memory.confirmed();
			releaseBrowserOpenLock(agentRuntimeDir);
			const now = new Date().toISOString();
			updatePersistentViewerHostState(agentRuntimeDir, (current) => {
				const { browser_open_in_progress_at: _browserOpenInProgressAt, ...rest } = current;
				return { ...rest, browser_opened_at: now, updated_at: now };
			});
		},
	};
}

function browserOpenLockPath(agentRuntimeDir: string): string {
	return join(agentRuntimeDir, "viewer-host-browser-open.lock");
}

function tryAcquireBrowserOpenLock(agentRuntimeDir: string, origin: string): boolean {
	const lockPath = browserOpenLockPath(agentRuntimeDir);
	try {
		const status = statSync(lockPath);
		if (Date.now() - status.mtimeMs < BROWSER_OPEN_IN_PROGRESS_TTL_MS) return false;
		rmSync(lockPath, { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
	}
	try {
		writeFileSync(lockPath, `${JSON.stringify({ origin: origin.replace(/\/$/, ""), created_at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

function releaseBrowserOpenLock(agentRuntimeDir: string): void {
	try {
		rmSync(browserOpenLockPath(agentRuntimeDir), { force: true });
	} catch {
		// Best-effort cleanup only.
	}
}

async function reusableViewerHostClient(agentRuntimeDir: string, browserLauncher: BrowserViewerLauncher, browserOpenAckTimeoutMs: number, shutdownTimeoutMs: number, viewerHostOwnerId: string, heartbeatIntervalMs: number, requestTimeoutMs: number): Promise<ViewerHostClient | undefined> {
	const state = readPersistentViewerHostState(agentRuntimeDir);
	if (!state) return undefined;
	if (state.control_token === undefined || state.instance_id === undefined || state.shutdown_token === undefined || state.heartbeat_token === undefined) {
		removePersistentViewerHostState(agentRuntimeDir, state);
		return undefined;
	}
	if (state.owner_id !== viewerHostOwnerId) {
		await retirePersistentViewerHost({ agentRuntimeDir, state, shutdownTimeoutMs, browserLauncher });
		return undefined;
	}
	try {
		const response = await new ViewerHostControlClient({ origin: state.origin, controlToken: state.control_token, requestTimeoutMs }).send({ type: "hello", protocol_version: VIEWER_HOST_PROTOCOL_VERSION });
		if (response.ok === true && "message" in response && response.message.instance_id === state.instance_id && response.message.origin === state.origin) {
			const activeViewerClients = typeof response.message.active_viewer_clients === "number" ? response.message.active_viewer_clients : 0;
			return new HttpViewerHostProcessClient({
				origin: state.origin,
				viewerUrl: state.viewer_url,
				browserLauncher,
				browserOpenAckTimeoutMs,
				controlToken: state.control_token,
				requestTimeoutMs,
				launchBrowserOnNextOpen: activeViewerClients <= 0,
				browserOpenCoordinator: createPersistentBrowserOpenCoordinator(agentRuntimeDir, state.origin),
				heartbeat: { ownerId: viewerHostOwnerId, token: state.heartbeat_token, intervalMs: heartbeatIntervalMs },
				shutdownHost: () => shutdownDiscoveredViewerHost(agentRuntimeDir, state, browserLauncher, shutdownTimeoutMs),
			});
		}
		removePersistentViewerHostState(agentRuntimeDir, state);
	} catch {
		removePersistentViewerHostState(agentRuntimeDir, state);
		return undefined;
	}
	return undefined;
}

interface PersistentViewerHostRetireOptions {
	agentRuntimeDir: string;
	state: PersistentViewerHostState;
	shutdownTimeoutMs: number;
	browserLauncher: BrowserViewerLauncher;
}

async function retirePersistentViewerHost(options: PersistentViewerHostRetireOptions): Promise<void> {
	if (options.state.control_token === undefined || options.state.instance_id === undefined || options.state.shutdown_token === undefined
		|| !await viewerHostIdentityMatches(options.state)) {
		removePersistentViewerHostState(options.agentRuntimeDir, options.state);
		return;
	}
	try {
		await options.browserLauncher.close?.();
	} catch {
		// Browser cleanup must not prevent Host retirement.
	}
	await requestPersistentViewerHostShutdown(options.state, options.shutdownTimeoutMs);
	removePersistentViewerHostState(options.agentRuntimeDir, options.state);
}

async function shutdownDiscoveredViewerHost(agentRuntimeDir: string, state: PersistentViewerHostState, browserLauncher: BrowserViewerLauncher, timeoutMs: number): Promise<void> {
	await retirePersistentViewerHost({ agentRuntimeDir, state, browserLauncher, shutdownTimeoutMs: timeoutMs });
}

async function requestPersistentViewerHostShutdown(state: PersistentViewerHostState & { shutdown_token?: string; control_token?: string; instance_id?: string }, timeoutMs: number): Promise<boolean> {
	if (state.shutdown_token === undefined || state.control_token === undefined || state.instance_id === undefined) return false;
	try {
		const response = await fetch(`${state.origin}/shutdown`, {
			method: "POST",
			headers: { [VIEWER_HOST_SHUTDOWN_TOKEN_HEADER]: state.shutdown_token, [VIEWER_HOST_CONTROL_TOKEN_HEADER]: state.control_token },
			signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
		});
		if (!response.ok) return false;
		const payload = await response.json() as { ok?: unknown; instance_id?: unknown };
		if (payload.ok !== true || payload.instance_id !== state.instance_id) return false;
	} catch {
		return false;
	}
	return await waitForViewerHostInstanceUnavailable(state, timeoutMs);
}

async function waitForViewerHostInstanceUnavailable(state: PersistentViewerHostState, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (true) {
		const remainingMs = deadline - Date.now();
		if (!await viewerHostIdentityMatches(state, Math.min(100, Math.max(1, remainingMs)))) return true;
		if (remainingMs <= 0) return false;
		await sleep(Math.min(50, Math.max(1, remainingMs)));
	}
}

async function viewerHostIdentityMatches(state: PersistentViewerHostState, timeoutMs = 250): Promise<boolean> {
	if (state.control_token === undefined || state.instance_id === undefined) return false;
	try {
		const response = await new ViewerHostControlClient({ origin: state.origin, controlToken: state.control_token, requestTimeoutMs: timeoutMs })
			.send({ type: "hello", protocol_version: VIEWER_HOST_PROTOCOL_VERSION });
		return response.ok === true && "message" in response
			&& response.message.origin === state.origin
			&& response.message.instance_id === state.instance_id
			&& response.message.protocol_version === VIEWER_HOST_PROTOCOL_VERSION;
	} catch {
		return false;
	}
}

function removePersistentViewerHostState(agentRuntimeDir: string, expected: PersistentViewerHostState): void {
	const current = readPersistentViewerHostState(agentRuntimeDir);
	if (!current) return;
	if (current.origin !== expected.origin.replace(/\/$/, "")) return;
	if (expected.instance_id !== undefined) {
		if (current.instance_id !== expected.instance_id) return;
	} else {
		if (current.instance_id !== undefined) return;
		if (expected.pid !== undefined && current.pid !== expected.pid) return;
	}
	try {
		rmSync(persistentViewerHostStatePath(agentRuntimeDir), { force: true });
	} catch {
		// Best-effort cleanup only.
	}
}

async function readViewerHostReadyLine(child: ChildProcessWithoutNullStreams, timeoutMs: number, stderrText: () => string): Promise<ViewerHostReadyLine> {
	return await new Promise<ViewerHostReadyLine>((resolveReady, rejectReady) => {
		let buffer = "";
		let settled = false;
		const timer = setTimeout(() => rejectOnce(new Error("timed out waiting for Viewer Host Server startup")), timeoutMs);
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectReady(error);
		};
		const resolveOnce = (ready: ViewerHostReadyLine) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveReady(ready);
		};
		child.once("error", (error) => rejectOnce(new Error(`failed to start Viewer Host Server: ${error.message}`)));
		child.once("exit", (code, signal) => {
			rejectOnce(new Error(`Viewer Host Server exited before reporting ready (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${stderrText() ? `: ${stderrText()}` : ""}`));
		});
		child.stdout.on("data", (chunk) => {
			buffer += String(chunk);
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline).trim();
			try {
				const parsed = JSON.parse(line) as Partial<ViewerHostReadyLine>;
				if (parsed.type !== "ready" || typeof parsed.origin !== "string" || typeof parsed.viewer_url !== "string" || typeof parsed.instance_id !== "string" || !parsed.instance_id) {
					throw new Error("expected ready message with origin, viewer_url, and instance_id");
				}
				resolveOnce({ type: "ready", origin: parsed.origin, viewer_url: parsed.viewer_url, instance_id: parsed.instance_id });
			} catch (error) {
				rejectOnce(new Error(`invalid Viewer Host Server startup message: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForSpawn(child: ChildProcess, errorPrefix: string): Promise<void> {
	await new Promise<void>((resolveSpawn, rejectSpawn) => {
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			child.off("spawn", onSpawn);
			child.off("error", onError);
			callback();
		};
		const onSpawn = () => settle(resolveSpawn);
		const onError = (error: Error) => settle(() => rejectSpawn(new Error(`${errorPrefix}: ${error.message}`)));
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

async function waitForEarlyProcessExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
	if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
	return await new Promise((resolveWait) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolveWait(undefined);
		}, timeoutMs);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(timer);
			resolveWait({ code, signal });
		};
		child.once("exit", onExit);
	});
}

async function waitForProcessExitOrKill(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveWait) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveWait();
		}, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveWait();
		});
	});
}

export interface ViewerHostMcpServiceOptions {
	client?: ViewerHostClient;
	clientFactory?: ViewerHostClientFactory;
	eventStore?: PdfEventStore;
	makePdfId?: () => number;
	nowNs?: () => number;
	reverseSynctexMapper?: ReverseSynctexMapper;
	agentRuntimeDir?: string;
	workspaceCwd?: string;
}

export class ViewerHostMcpService {
	private readonly clientFactory: ViewerHostClientFactory;
	private activeSession: ActiveViewerHostSession | undefined;
	private reconnectRequired = false;
	private nextGeneration = 0;
	private sendQueue: Promise<void> = Promise.resolve();
	private readonly registeredGenerationByPdfId = new Map<number, number>();
	private readonly eventStore: PdfEventStore;
	private readonly makePdfId: () => number;
	private readonly nowNs: () => number;
	private readonly reverseSynctexMapper: ReverseSynctexMapper;
	private readonly failureReporter: ViewerFailureReporter;
	private readonly recordsById = new Map<number, TrackedViewerHostPdf>();
	private readonly recordsByPath = new Map<string, TrackedViewerHostPdf>();
	private compileActionHandler: ViewerCompileActionHandler | undefined;
	private eventDrainTimer: ReturnType<typeof setInterval> | undefined;
	private eventDrainInFlight = false;
	readonly pdfOperations: HostServiceMcpPdfOperations;

	constructor(options: ViewerHostMcpServiceOptions = {}) {
		if (options.client && options.clientFactory) {
			throw new Error("ViewerHostMcpService accepts either client or clientFactory, not both");
		}
		if (options.client) {
			this.activeSession = { client: options.client, generation: this.allocateGeneration() };
			this.clientFactory = async () => options.client!;
		} else {
			this.clientFactory = options.clientFactory ?? createDefaultViewerHostClientFactory({ agentRuntimeDir: options.agentRuntimeDir, workspaceCwd: options.workspaceCwd });
		}
		this.eventStore = options.eventStore ?? new PdfEventStore();
		this.makePdfId = options.makePdfId ?? (() => randomInt(MIN_PDF_ID, MAX_PDF_ID + 1));
		this.nowNs = options.nowNs ?? (() => Date.now() * 1_000_000);
		this.reverseSynctexMapper = options.reverseSynctexMapper ?? mapReverseSynctex;
		this.failureReporter = new ViewerFailureReporter(async (message) => {
			await this.sendWithReconnect({
				type: "report_error",
				...(message.pdf_id === undefined ? {} : { pdf_id: message.pdf_id }),
				code: message.code,
				title: message.title,
				detail: message.detail,
				...(message.inject_text === undefined ? {} : { inject_text: message.inject_text }),
			}, { reregisterBeforeSend: message.pdf_id !== undefined });
		});
		this.pdfOperations = {
			openPdf: (request) => this.openPdf(request),
			jumpPdf: (request) => this.jumpPdf(request),
			getPdfEvents: (request) => this.getPdfEvents(request),
			fetchPdfContext: (request) => this.fetchPdfContext(request),
			markTrackedPdfUpdated: (pdfPath) => this.markTrackedPdfUpdated(pdfPath),
		};
	}

	setCompileActionHandler(handler: ViewerCompileActionHandler | undefined): void {
		this.compileActionHandler = handler;
		if (handler !== undefined) this.ensureEventDrainPolling();
	}

	async sendCompileStatus(message: Omit<Extract<McpToViewerHostMessage, { type: "compile_status" }>, "type">): Promise<void> {
		await this.sendWithReconnect({ type: "compile_status", ...message }, { reregisterBeforeSend: true });
	}

	async reportViewerFailure(error: unknown, context: ViewerFailureContext): Promise<void> {
		await this.failureReporter.report(error, context);
	}

	async openPdf(request: HostServiceOpenRequest): Promise<HostServiceOpenResponseEnvelope> {
		const pdfPath = this.resolvePdfPath(request.details.pdf_path, request.workspace_context);
		try {
			assertReadablePdfFile(pdfPath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return this.openError(request, pdfPath, reason, reason.includes("must point to a PDF file") ? "invalid_pdf" : "invalid_request");
		}

		try {
			const opened = await this.enqueueLifecycle(async () => {
				const debugSynctexEnabled = request.details.debug_synctex === true;
				const hasDebugSynctexOption = request.details.debug_synctex !== undefined;
				const existing = this.recordsByPath.get(pdfPath);
				if (existing) {
					if (hasDebugSynctexOption) existing.debugSynctexEnabled = debugSynctexEnabled;
					const focused = await this.sendWithReconnectLocked({ type: "focus_pdf", pdf_id: existing.pdfId }, { reregisterBeforeSend: true });
					if (hasDebugSynctexOption) await this.sendWithReconnectLocked({ type: "set_debug_synctex", pdf_id: existing.pdfId, enabled: debugSynctexEnabled }, { reregisterBeforeSend: false });
					return { record: existing, reused: true, browserLaunch: this.browserLaunchDetails(focused.response) };
				}

				const session = await this.ensureSession();
				const record = this.createPdfRecord(pdfPath, request.workspace_context.cwd, session.client, debugSynctexEnabled);
				const registered = await this.sendWithReconnectLocked({ type: "open_pdf", pdf_id: record.pdfId, pdf_path: record.pdfPath, title: basename(record.pdfPath), workspace_cwd: record.workspaceCwd, ...(record.debugSynctexEnabled ? { debug_synctex: true } : {}) }, { reregisterBeforeSend: false });
				this.setRecordViewerUrl(record, registered.session);
				this.commitPdfRecord(record);
				return { record, reused: false, browserLaunch: this.browserLaunchDetails(registered.response) };
			});
			return this.openOk(request, opened.record, opened.reused, opened.browserLaunch);
		} catch (error) {
			const reason = viewerHostUnavailableReason(error);
			return this.openError(request, pdfPath, reason, "viewer_host_unavailable", this.recordsByPath.get(pdfPath));
		}
	}

	async jumpPdf(request: HostServiceJumpRequest): Promise<HostServiceJumpResponseEnvelope> {
		let record: TrackedViewerHostPdf | undefined;
		let sourceFile: string | undefined;
		try {
			record = this.getRecord(request.pdf_id);
			sourceFile = request.source_file ?? inferDefaultSourceFileForPdf(record.pdfPath);
			if (!sourceFile) {
				throw new Error(`No default source_file is known for tracked pdf_id=${request.pdf_id}. Pass source_file explicitly.`);
			}
			sourceFile = isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(request.workspace_context.cwd, sourceFile);
			assertReadableSourceFile(sourceFile);
			assertReadablePdfFile(record.pdfPath);
			if (request.debug_synctex !== undefined) {
				record.debugSynctexEnabled = request.debug_synctex === true;
				await this.sendWithReconnect({ type: "set_debug_synctex", pdf_id: record.pdfId, enabled: record.debugSynctexEnabled }, { reregisterBeforeSend: true });
			}
			const jump = resolveForwardSynctexJump({ pdfPath: record.pdfPath, sourceFile, line: request.line, cwd: request.workspace_context.cwd });
			await this.sendWithReconnect({
				type: "synctex_forward",
				pdf_id: record.pdfId,
				page: jump.page,
				x: jump.x,
				y: jump.y,
				...(jump.width === undefined ? {} : { width: jump.width }),
				...(jump.height === undefined ? {} : { height: jump.height }),
				...(jump.ranges === undefined ? {} : { ranges: jump.ranges }),
				...(jump.indicator === undefined ? {} : { indicator: jump.indicator }),
				source_file: jump.sourceFile,
				line: jump.line,
				source_line: jump.sourceLine,
			}, { reregisterBeforeSend: true });
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "ok",
				generated_at_ns: this.nowNs(),
				status_details: {
					protocol_version: request.protocol_version,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: VIEWER_HOST_BACKEND_NAME,
					backend_path: VIEWER_HOST_BACKEND_NAME,
					backend_identity_ok: true,
					handled: true,
					reopened: false,
					pdf: record.pdfPath,
					pdf_id: record.pdfId,
					source_file: jump.sourceFile,
					line: jump.line,
					source_line: jump.sourceLine,
					page: jump.page,
					x: jump.x,
					y: jump.y,
					synctex_branch: jump.branch,
					synctex_diagnostics: jump.diagnostics,
					...(jump.width === undefined ? {} : { width: jump.width }),
					...(jump.height === undefined ? {} : { height: jump.height }),
					...(jump.ranges === undefined ? {} : { ranges: jump.ranges }),
					viewer_notifications: 0,
					handle: record.viewerUrl,
					reason: "sent synctex_forward to Viewer Host Client",
					managed_record: this.managedRecord(record, false),
				},
			};
		} catch (error) {
			let surfacedError = error;
			const originalReason = error instanceof Error ? error.message : String(error);
			if (record !== undefined) {
				try {
					await this.reportViewerFailure(error, {
						pdfId: record.pdfId,
						code: "synctex_jump_failed",
						title: "Could not jump to the LaTeX source",
						detail: originalReason,
						injectText: `PDF source jump failed: ${originalReason}`,
					});
				} catch (reportingError) {
					surfacedError = new AggregateError(
						[error instanceof Error ? error : new Error(String(error)), reportingError instanceof Error ? reportingError : new Error(String(reportingError))],
						`${originalReason}; additionally failed to report the failure to the viewer: ${reportingError instanceof Error ? reportingError.message : String(reportingError)}`,
					);
				}
			}
			const reason = surfacedError instanceof Error ? surfacedError.message : String(surfacedError);
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: this.nowNs(),
				error: reason,
				status_details: {
					protocol_version: request.protocol_version,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: VIEWER_HOST_BACKEND_NAME,
					backend_path: VIEWER_HOST_BACKEND_NAME,
					backend_identity_ok: true,
					handled: false,
					reopened: false,
					pdf: record?.pdfPath,
					pdf_id: request.pdf_id,
					source_file: sourceFile,
					line: request.line,
					error_code: this.jumpErrorCode(reason),
					reason,
				},
			};
		}
	}

	async getPdfEvents(request: GetPdfEventsRequest): Promise<PdfEvent[]> {
		await this.drainHostEvents();
		return this.eventStore.getEvents(request);
	}

	async fetchPdfContext(request: FetchPdfContextRequest): Promise<PostUserPdfContextResult> {
		await this.drainHostEvents(["pdf_annotation", "pdf_annotation_deleted"]);
		const maxEvents = Math.min(request.max_events ?? 20, 20);
		const localEvents = this.eventStore.getPdfAnnotationEvents({
			...(request.pdf_id === undefined ? {} : { pdf_id: request.pdf_id }),
			max_events: maxEvents,
		});
		const claimed = await this.claimHostPdfMarks(request, maxEvents - localEvents.length);
		const hostEvents = claimed === undefined ? [] : pdfAnnotationEventsFromViewerMarks(claimed.claim.marks)
			.map((event, index) => ({ ...event, sequence: localEvents.length + index + 1 }));
		const result = collectPostUserPdfContextFromEvents([...localEvents, ...hostEvents], {
			...(request.pdf_id === undefined ? {} : { pdfId: request.pdf_id }),
			maxEvents,
			clearViewer: true,
			cwd: request.cwd,
		});
		if (claimed?.claim.claimId !== undefined) {
			const claimedKeys = new Set(claimed.claim.marks.map((mark) => `${mark.pdf_id}\0${mark.annotation_id}`));
			const consumed = result.events
				.filter((event) => claimedKeys.has(`${event.pdf_id}\0${event.annotation_id}`))
				.map((event) => ({ pdf_id: event.pdf_id, annotation_id: event.annotation_id }));
			await claimed.client.acknowledgePdfMarks(claimed.claim.claimId, consumed);
		} else if (claimed === undefined && result.cleared) {
			for (const pdfId of result.pdfIds) {
				await this.sendWithReconnect({ type: "clear_pdf_annotations", pdf_id: pdfId }, { reregisterBeforeSend: true });
			}
		}
		return result;
	}

	private async claimHostPdfMarks(request: FetchPdfContextRequest, maxMarks: number): Promise<ClaimedHostPdfMarks | undefined> {
		if (this.recordsById.size === 0) return undefined;
		return await this.enqueueLifecycle(async () => {
			const session = await this.ensureSession();
			if (session.client.claimPdfMarks === undefined || session.client.acknowledgePdfMarks === undefined) return undefined;
			await this.reregisterKnownPdfs(session);
			const pdfIds = request.pdf_id === undefined ? Array.from(this.recordsById.keys()) : [request.pdf_id];
			const claim = maxMarks <= 0 ? { marks: [] } : await session.client.claimPdfMarks(pdfIds, maxMarks);
			return {
				claim,
				client: session.client as ViewerHostClient & Required<Pick<ViewerHostClient, "acknowledgePdfMarks">>,
			};
		});
	}

	async markTrackedPdfUpdated(pdfPath: string): Promise<{ tracked: boolean; pdfId?: number }> {
		const record = this.recordsByPath.get(resolve(pdfPath));
		if (!record) return { tracked: false };
		return await this.failureReporter.capture({
			pdfId: record.pdfId,
			code: "pdf_refresh_failed",
			title: "Could not refresh the PDF",
		}, async () => {
			await this.sendWithReconnect({ type: "pdf_maybe_updated", pdf_id: record.pdfId }, { reregisterBeforeSend: true });
			return { tracked: true, pdfId: record.pdfId };
		});
	}

	handleHostMessage(message: ViewerHostToMcpMessage): void {
		const parsed = validateViewerHostToMcpMessage(message);
		if ("pdf_id" in parsed && !this.recordsById.has(parsed.pdf_id)) return;
		if (parsed.type === "reverse_synctex") {
			this.appendReverseSynctexEvent(parsed);
		} else if (parsed.type === "pdf_annotation") {
			this.eventStore.appendPdfAnnotationEvent({
				type: "pdf_annotation",
				pdf_id: parsed.pdf_id,
				annotation_id: parsed.annotation_id,
				timestamp: new Date().toISOString(),
				source_file: parsed.source_file,
				line: parsed.line,
				...(parsed.source_line === undefined ? {} : { source_line: parsed.source_line }),
				...(parsed.source_span === undefined ? {} : { source_span: parsed.source_span }),
				...(parsed.synctex_diagnostics === undefined ? {} : { synctex_diagnostics: structuredClone(parsed.synctex_diagnostics) }),
				page: parsed.page,
				x: parsed.x,
				y: parsed.y,
				...(parsed.comment === undefined ? {} : { comment: parsed.comment }),
			});
		} else if (parsed.type === "viewer_tab_closed") {
			this.eventStore.clearPdfEvents(parsed.pdf_id);
		} else if (parsed.type === "reverse_synctex_hover") {
			void this.sendReverseSynctexHoverResult(parsed).catch(() => undefined);
		} else if (parsed.type === "selection_debug") {
			this.eventStore.appendSelectionDebugEvent({
				type: "selection_debug",
				pdf_id: parsed.pdf_id,
				timestamp: new Date().toISOString(),
				phase: parsed.phase,
				...(parsed.page === undefined ? {} : { page: parsed.page }),
				text: parsed.text,
				details: parsed.details,
			});
		} else if (parsed.type === "compile_action") {
			const record = this.recordsById.get(parsed.pdf_id);
			if (!record) return;
			void (async () => {
				await this.compileActionHandler?.(parsed, record);
			})().catch((error) => {
				this.reportBackgroundFailure(error, {
					pdfId: record.pdfId,
					code: "viewer_action_failed",
					title: "Could not handle the viewer action",
					detail: error instanceof Error ? error.message : String(error),
					injectText: `Viewer action ${parsed.action} failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			});
		}
	}

	private reportBackgroundFailure(error: unknown, context: ViewerFailureContext): void {
		void this.reportViewerFailure(error, context).catch((reportingError) => {
			logger.error("viewer_failure_delivery_failed", { code: context.code, pdf_id: context.pdfId, error, reportingError });
		});
	}

	private async drainHostEvents(eventTypes?: readonly ViewerHostToMcpMessage["type"][]): Promise<void> {
		const pdfIds = [...this.recordsById.keys()];
		if (pdfIds.length === 0) return;
		const events = await this.activeSession?.client.drainEvents?.(pdfIds, eventTypes) ?? [];
		for (const event of events) {
			this.handleHostMessage(event);
		}
	}

	private ensureEventDrainPolling(): void {
		if (this.eventDrainTimer !== undefined) return;
		this.eventDrainTimer = setInterval(() => {
			if (this.eventDrainInFlight) return;
			this.eventDrainInFlight = true;
			void this.drainHostEvents(["compile_action"]).catch(() => undefined).finally(() => {
				this.eventDrainInFlight = false;
			});
		}, 500);
		this.eventDrainTimer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.eventDrainTimer !== undefined) {
			clearInterval(this.eventDrainTimer);
			this.eventDrainTimer = undefined;
		}
		await this.enqueueLifecycle(async () => {
			const client = this.activeSession?.client;
			this.activeSession = undefined;
			this.reconnectRequired = false;
			this.recordsById.clear();
			this.recordsByPath.clear();
			this.registeredGenerationByPdfId.clear();
			if (!client) return;
			if (client.shutdownHost) await client.shutdownHost();
			else await client.close?.();
		});
	}

	private allocateGeneration(): number {
		this.nextGeneration += 1;
		return this.nextGeneration;
	}

	private async ensureSession(forceReconnect = false): Promise<ActiveViewerHostSession> {
		if (forceReconnect || this.reconnectRequired || !this.activeSession) {
			if (forceReconnect || this.reconnectRequired) {
				await this.activeSession?.client.close?.();
			}
			this.activeSession = { client: await this.clientFactory(), generation: this.allocateGeneration() };
			this.reconnectRequired = false;
		}
		return this.activeSession;
	}

	private async sendWithReconnect(message: McpToViewerHostMessage, options: { reregisterBeforeSend: boolean }): Promise<void> {
		await this.enqueueLifecycle(async () => {
			await this.sendWithReconnectLocked(message, options);
		});
	}

	private async sendWithReconnectLocked(message: McpToViewerHostMessage, options: { reregisterBeforeSend: boolean }): Promise<ViewerHostSendResult> {
		try {
			return await this.sendOnActiveSession(message, options.reregisterBeforeSend);
		} catch (error) {
			this.reconnectRequired = true;
			const firstReason = error instanceof Error ? error.message : String(error);
			try {
				return await this.sendOnActiveSession(message, true, true);
			} catch (retryError) {
				this.reconnectRequired = true;
				const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
				throw new Error(`${firstReason}; after relaunch/reconnect: ${retryReason}`);
			}
		}
	}

	private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.sendQueue.then(operation, operation);
		this.sendQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async sendOnActiveSession(message: McpToViewerHostMessage, reregisterBeforeSend: boolean, forceReconnect = false): Promise<ViewerHostSendResult> {
		const session = await this.ensureSession(forceReconnect);
		if (reregisterBeforeSend) {
			await this.reregisterKnownPdfs(session);
		}
		if (message.type === "open_pdf" && this.registeredGenerationByPdfId.get(message.pdf_id) === session.generation) {
			return { session };
		}
		const response = await this.sendToClient(session.client, message);
		if (message.type === "open_pdf" && this.activeSession === session) {
			this.registeredGenerationByPdfId.set(message.pdf_id, session.generation);
			this.updateViewerUrlsForSession(session);
		}
		return { session, response };
	}

	private async reregisterKnownPdfs(session: ActiveViewerHostSession): Promise<void> {
		const reregistered: number[] = [];
		for (const record of this.recordsById.values()) {
			if (this.registeredGenerationByPdfId.get(record.pdfId) === session.generation) continue;
			await this.sendToClient(session.client, { type: "open_pdf", pdf_id: record.pdfId, pdf_path: record.pdfPath, title: basename(record.pdfPath), workspace_cwd: record.workspaceCwd, ...(record.debugSynctexEnabled ? { debug_synctex: true } : {}) });
			reregistered.push(record.pdfId);
		}
		if (this.activeSession !== session) return;
		for (const pdfId of reregistered) {
			this.registeredGenerationByPdfId.set(pdfId, session.generation);
		}
		if (reregistered.length > 0) {
			this.updateViewerUrlsForSession(session);
		}
	}

	private async sendToClient(client: ViewerHostClient, message: McpToViewerHostMessage): Promise<ViewerHostControlResponse | undefined> {
		const response = await client.send(validateMcpToViewerHostMessage(message));
		if (isViewerHostControlResponse(response) && !response.ok) {
			throw new Error(response.error.message);
		}
		return isViewerHostControlResponse(response) ? response : undefined;
	}

	private updateViewerUrlsForSession(session: ActiveViewerHostSession): void {
		const origin = session.client.origin.replace(/\/$/, "");
		for (const record of this.recordsById.values()) {
			record.viewerUrl = `${origin}/viewer-lw/${record.pdfId}`;
		}
	}

	private async sendReverseSynctexHoverResult(message: ViewerHostReverseSynctexHoverMessage): Promise<void> {
		const record = this.getRecord(message.pdf_id);
		try {
			await this.sendWithReconnect(reverseSynctexHoverResult({ message, pdf: { pdfId: record.pdfId, pdfPath: record.pdfPath, workspaceCwd: record.workspaceCwd } }), { reregisterBeforeSend: true });
		} catch (error) {
			await this.sendWithReconnect({
				type: "reverse_synctex_hover_result",
				pdf_id: message.pdf_id,
				request_id: message.request_id,
				page: message.page,
				x: message.x,
				y: message.y,
				error: error instanceof Error ? error.message : String(error),
			}, { reregisterBeforeSend: true });
		}
	}

	private appendReverseSynctexEvent(message: ViewerHostReverseSynctexMessage): void {
		const record = this.getRecord(message.pdf_id);
		this.eventStore.appendReverseSynctexEvent(reverseSynctexPdfEventFromViewerMessage({
			message,
			pdf: { pdfId: record.pdfId, pdfPath: record.pdfPath, workspaceCwd: record.workspaceCwd },
			reverseSynctexMapper: this.reverseSynctexMapper,
		}));
	}

	private resolvePdfPath(pdfPath: string, workspaceContext: HostServiceWorkspaceContext): string {
		return isAbsolute(pdfPath) ? resolve(pdfPath) : resolve(workspaceContext.cwd, pdfPath);
	}

	private createPdfRecord(pdfPath: string, workspaceCwd: string, client: ViewerHostClient, debugSynctexEnabled: boolean): TrackedViewerHostPdf {
		const normalizedPath = resolve(pdfPath);
		const pdfId = this.allocatePdfId();
		const record: TrackedViewerHostPdf = {
			pdfId,
			pdfPath: normalizedPath,
			workspaceCwd: resolve(workspaceCwd),
			createdAtNs: this.nowNs(),
			revision: 1,
			viewerUrl: "",
			debugSynctexEnabled,
			fileSnapshot: snapshotPdf(normalizedPath),
		};
		this.setRecordViewerUrl(record, { client });
		return record;
	}

	private commitPdfRecord(record: TrackedViewerHostPdf): void {
		this.recordsById.set(record.pdfId, record);
		this.recordsByPath.set(record.pdfPath, record);
	}

	private setRecordViewerUrl(record: TrackedViewerHostPdf, session: Pick<ActiveViewerHostSession, "client">): void {
		const origin = session.client.origin.replace(/\/$/, "");
		record.viewerUrl = `${origin}/viewer-lw/${record.pdfId}`;
	}

	private allocatePdfId(): number {
		for (let attempt = 0; attempt < 64; attempt += 1) {
			const candidate = this.makePdfId();
			if (!Number.isInteger(candidate) || candidate < MIN_PDF_ID || candidate > MAX_PDF_ID) {
				throw new Error(`Invalid generated pdf_id=${String(candidate)}`);
			}
			if (!this.recordsById.has(candidate)) return candidate;
		}
		throw new Error("Unable to allocate unique pdf_id");
	}

	private getRecord(pdfId: number): TrackedViewerHostPdf {
		const record = this.recordsById.get(pdfId);
		if (!record) throw new Error(`Unknown pdf_id=${pdfId}: no MCP-owned PDF record found`);
		return record;
	}

	private browserLaunchDetails(response: ViewerHostControlResponse | undefined): Record<string, unknown> | undefined {
		if (response?.ok !== true || !("result" in response)) return undefined;
		if (response.result.browser_open_confirmed === undefined && response.result.browser_open_attempted === undefined) return undefined;
		return {
			...(response.result.browser_open_attempted === undefined ? {} : { attempted: response.result.browser_open_attempted }),
			...(response.result.browser_open_confirmed === undefined ? {} : { confirmed: response.result.browser_open_confirmed }),
			...(response.result.active_viewer_clients === undefined ? {} : { active_viewer_clients: response.result.active_viewer_clients }),
			...(response.result.browser_open_error === undefined ? {} : { error: response.result.browser_open_error }),
		};
	}

	private openOk(request: HostServiceOpenRequest, record: TrackedViewerHostPdf, reused: boolean, browserLaunch?: Record<string, unknown>): HostServiceOpenResponseEnvelope {
		return {
			protocol_version: request.protocol_version,
			request_id: request.request_id,
			operation: "open_pdf",
			status: "ok",
			generated_at_ns: this.nowNs(),
			status_details: {
				...this.openStatusBase(request, record.pdfPath),
				supported: true,
				service_available: true,
				owned: true,
				reused,
				handle: record.viewerUrl,
				pdf_id: record.pdfId,
				revision: record.revision,
				viewer_url: record.viewerUrl,
				...(browserLaunch === undefined ? {} : { browser_launch: browserLaunch }),
				managed_record: this.managedRecord(record, reused),
			},
		};
	}

	private openError(request: HostServiceOpenRequest, pdfPath: string, reason: string, errorCode: string, record?: TrackedViewerHostPdf): HostServiceOpenResponseEnvelope {
		return {
			protocol_version: request.protocol_version,
			request_id: request.request_id,
			operation: "open_pdf",
			status: "error",
			generated_at_ns: this.nowNs(),
			error: reason,
			status_details: {
				...this.openStatusBase(request, pdfPath),
				supported: false,
				service_available: false,
				owned: record !== undefined,
				reused: record !== undefined,
				...(record === undefined ? {} : { pdf_id: record.pdfId, revision: record.revision, viewer_url: record.viewerUrl, handle: record.viewerUrl, managed_record: this.managedRecord(record, true) }),
				error_code: errorCode,
				reason,
			},
		};
	}

	private openStatusBase(request: HostServiceOpenRequest, pdfPath: string) {
		return {
			protocol_version: request.protocol_version,
			workspace_context: request.workspace_context,
			request_id: request.request_id,
			operation: "open_pdf" as const,
			backend: VIEWER_HOST_BACKEND_NAME,
			backend_path: VIEWER_HOST_BACKEND_NAME,
			capabilities: VIEWER_HOST_CAPABILITIES,
			pdf: pdfPath,
		};
	}

	private managedRecord(record: TrackedViewerHostPdf, reused: boolean) {
		return {
			id: record.pdfId,
			pdfPath: record.pdfPath,
			viewerHandle: record.viewerUrl,
			viewerBackend: VIEWER_HOST_BACKEND_NAME,
			viewerOwned: false,
			createdAtNs: record.createdAtNs,
			reused,
			capabilities: VIEWER_HOST_CAPABILITIES,
			backendPath: VIEWER_HOST_BACKEND_NAME,
			defaultSourcePath: inferDefaultSourceFileForPdf(record.pdfPath),
			metadata: { viewer_host_origin: viewerOriginForRecord(record) ?? this.activeSession?.client.origin, revision: record.revision, file_snapshot: record.fileSnapshot },
		};
	}

	private jumpErrorCode(reason: string): string {
		if (/Viewer Host unavailable|control channel|relaunch|reconnect|registration rejected/i.test(reason)) return "viewer_host_unavailable";
		if (/missing SyncTeX sidecar/i.test(reason)) return "synctex_missing";
		if (/No SyncTeX mapping found/i.test(reason)) return "synctex_unmapped";
		if (/Unknown pdf_id/i.test(reason)) return "invalid_request";
		if (/source_file/i.test(reason)) return "invalid_request";
		return "synctex_failed";
	}
}

function viewerOriginForRecord(record: TrackedViewerHostPdf): string | undefined {
	try {
		return new URL(record.viewerUrl).origin;
	} catch {
		return undefined;
	}
}

function isViewerHostControlResponse(value: unknown): value is ViewerHostControlResponse {
	return typeof value === "object" && value !== null && "ok" in value;
}

function viewerHostUnavailableReason(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Viewer Host unavailable: ${reason}`;
}

function snapshotPdf(pdfPath: string): { size: number; mtimeMs: number } | undefined {
	try {
		const status = statSync(pdfPath);
		if (!status.isFile()) return undefined;
		return { size: status.size, mtimeMs: status.mtimeMs };
	} catch {
		return undefined;
	}
}

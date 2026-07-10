import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, URL } from "node:url";
import { validateMcpToViewerHostMessage, validateViewerHostToMcpMessage, VIEWER_HOST_CONTROL_TOKEN_HEADER, VIEWER_HOST_HEARTBEAT_TOKEN_HEADER, VIEWER_HOST_PROTOCOL_VERSION, VIEWER_HOST_SHUTDOWN_TOKEN_HEADER, type ViewerHostControlResponse, type ViewerHostSynctexForwardMessage, type ViewerHostToMcpMessage } from "./viewer_host_protocol.ts";
import { prewarmSynctexForPdf, reverseSynctexForwardProbeResult, reverseSynctexHoverResult } from "./synctex/synctex_resolution.ts";
import { DEFAULT_VIEWER_HOST_ACCESS_POLICY, type ViewerHostAccessPolicy, type ViewerHostServerAddress } from "./viewer_host_access_policy.ts";
import type { ViewerHostFileSnapshot, ViewerHostPdfRecord, ViewerHostPdfRegistry } from "./viewer_host_registry.ts";
import { PendingPdfMarkStore, type AcknowledgedPdfMark } from "./pending_pdf_marks.ts";
import { inferDefaultSourceFileForPdf } from "./pdf_tracking/pdf_tracking.ts";
import { ViewerHostEventBacklog, type ViewerHostEventFilters } from "./viewer_host_event_backlog.ts";
import { ViewerFailureReporter } from "./viewer_failure_reporter.ts";
export type { ViewerHostServerAddress } from "./viewer_host_access_policy.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const MAX_VIEWER_SOCKET_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_MAX_MCP_EVENT_BACKLOG = 500;
const LW_VIEWER_ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "viewer_lw");
const LW_PDFJS_BUILD_ASSETS = new Map<string, { path: string; polyfillModernPromiseHelpers?: boolean }>([
	["/viewer-lw/build/pdf.mjs", { path: resolve(LW_VIEWER_ASSET_ROOT, "build", "pdf.mjs"), polyfillModernPromiseHelpers: true }],
	["/viewer-lw/build/pdf.worker.mjs", { path: resolve(LW_VIEWER_ASSET_ROOT, "build", "pdf.worker.mjs"), polyfillModernPromiseHelpers: true }],
	["/viewer-lw/build/pdf.sandbox.mjs", { path: resolve(LW_VIEWER_ASSET_ROOT, "build", "pdf.sandbox.mjs") }],
]);
const PDFJS_MODERN_PROMISE_HELPERS_POLYFILL = `// PDF.js compatibility polyfills for older WebKit webviews.
if (typeof Promise.withResolvers !== "function") {
	Promise.withResolvers = function withResolvers() {
		let resolve, reject;
		const promise = new Promise((promiseResolve, promiseReject) => {
			resolve = promiseResolve;
			reject = promiseReject;
		});
		return { promise, resolve, reject };
	};
}
if (typeof Promise.try !== "function") {
	Promise.try = function promiseTry(callback, ...args) {
		return new Promise(resolve => resolve(callback(...args)));
	};
}
`;

export interface ViewerHostFileSystem {
	stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
	createReadStream(path: string): Readable;
}

export interface ViewerHostViewerDispatch {
	openPdf(record: ViewerHostPdfRecord): Promise<void> | void;
	focusPdf(record: ViewerHostPdfRecord): Promise<void> | void;
	synctexForward(message: ViewerHostSynctexForwardMessage, record: ViewerHostPdfRecord): Promise<void> | void;
}

export interface ViewerHostControlStatus {
	ready: boolean;
	protocolVersion?: number;
}

export interface ViewerHostPdfChangeDetectionOptions {
	debounceMs?: number;
	pollIntervalMs?: number;
	nowMs?: () => number;
}

export interface ViewerHostPdfRefreshDiagnostic {
	pdf_id: number;
	status: "error";
	code: "pdf_not_readable" | "pdf_not_regular_file";
	message: string;
}

interface ViewerTabEvent {
	type: "open_pdf" | "focus_pdf";
	pdf_id: number;
	title: string;
	revision: number;
	viewer_url: string;
	visible_tab_token: string;
	active: boolean;
}

interface ViewerTabPayload {
	pdf_id: number;
	revision: number;
	viewer_url: string;
	visible_tab_token: string;
}

interface ViewerSocketConnection {
	pdfId: number;
	socket: Socket;
	buffer: Buffer;
	closed: boolean;
}

interface PendingPdfRefreshSnapshot {
	snapshot: ViewerHostFileSnapshot;
	observedAtMs: number;
}

export interface ViewerHostShutdownRequestHandler {
	token: string;
	shutdown(reason: string): Promise<void> | void;
}

export interface ViewerHostHeartbeatRequestHandler {
	token: string;
	ownerId: string;
	heartbeat(): Promise<void> | void;
}

export interface ViewerHostServerOptions {
	registry: ViewerHostPdfRegistry;
	port?: number;
	fileSystem?: ViewerHostFileSystem;
	viewerDispatch?: ViewerHostViewerDispatch;
	verifyPdfMaybeUpdated?: (record: ViewerHostPdfRecord) => Promise<void> | void;
	pdfChangeDetection?: ViewerHostPdfChangeDetectionOptions;
	accessPolicy?: ViewerHostAccessPolicy;
	shutdownRequest?: ViewerHostShutdownRequestHandler;
	heartbeatRequest?: ViewerHostHeartbeatRequestHandler;
	controlToken?: string;
	pendingPdfMarks?: PendingPdfMarkStore;
	instanceId?: string;
	maxMcpEventBacklog?: number;
}

export class ViewerHostServer {
	private readonly registry: ViewerHostPdfRegistry;
	private readonly port: number;
	private readonly fileSystem: ViewerHostFileSystem;
	private readonly viewerDispatch: ViewerHostViewerDispatch;
	private readonly verifyPdfMaybeUpdated: (record: ViewerHostPdfRecord) => Promise<void> | void;
	private readonly pdfChangeDebounceMs: number;
	private readonly pdfChangePollIntervalMs: number;
	private readonly nowMs: () => number;
	private readonly accessPolicy: ViewerHostAccessPolicy;
	private readonly shutdownRequest: ViewerHostShutdownRequestHandler | undefined;
	private readonly heartbeatRequest: ViewerHostHeartbeatRequestHandler | undefined;
	private readonly controlToken: string | undefined;
	private readonly pendingPdfMarks: PendingPdfMarkStore;
	private readonly instanceIdValue: string;
	private readonly failureReporter: ViewerFailureReporter;
	private controlReady = false;
	private controlProtocolVersion: number | undefined;
	private server: Server | undefined;
	private activeSockets = new Set<Socket>();
	private viewerEventClients = new Set<ServerResponse>();
	private readonly mcpEvents: ViewerHostEventBacklog;
	private viewerSocketClientsByPdfId = new Map<number, Set<ViewerSocketConnection>>();
	private viewerSocketTokensByPdfId = new Map<number, string>();
	private visibleViewerTabs = new Map<number, ViewerTabEvent>();
	private activeVisiblePdfId: number | undefined;
	private debugSynctexByPdfId = new Map<number, boolean>();
	private pendingPdfRefreshSnapshots = new Map<number, PendingPdfRefreshSnapshot>();
	private pdfRefreshDiagnostics = new Map<number, ViewerHostPdfRefreshDiagnostic>();
	private pdfChangePollTimer: ReturnType<typeof setInterval> | undefined;
	private pdfChangePollInFlight = false;
	private nextVisibleTabToken = 1;
	private originValue: string | undefined;
	private addressValue: ViewerHostServerAddress | undefined;

	constructor(options: ViewerHostServerOptions) {
		this.registry = options.registry;
		this.port = options.port ?? DEFAULT_PORT;
		this.fileSystem = options.fileSystem ?? { stat: statFile, createReadStream };
		this.viewerDispatch = options.viewerDispatch ?? NOOP_VIEWER_DISPATCH;
		this.verifyPdfMaybeUpdated = options.verifyPdfMaybeUpdated ?? (() => undefined);
		this.pdfChangeDebounceMs = nonNegativeNumber(options.pdfChangeDetection?.debounceMs, 250);
		this.pdfChangePollIntervalMs = nonNegativeNumber(options.pdfChangeDetection?.pollIntervalMs, 1_000);
		this.nowMs = options.pdfChangeDetection?.nowMs ?? (() => Date.now());
		this.accessPolicy = options.accessPolicy ?? DEFAULT_VIEWER_HOST_ACCESS_POLICY;
		this.shutdownRequest = options.shutdownRequest;
		this.heartbeatRequest = options.heartbeatRequest;
		this.controlToken = options.controlToken;
		this.pendingPdfMarks = options.pendingPdfMarks ?? new PendingPdfMarkStore();
		this.instanceIdValue = options.instanceId?.trim() || randomBytes(24).toString("base64url");
		this.mcpEvents = new ViewerHostEventBacklog(options.maxMcpEventBacklog ?? DEFAULT_MAX_MCP_EVENT_BACKLOG);
		this.failureReporter = new ViewerFailureReporter((message) => {
			if (message.pdf_id === undefined) {
				this.broadcastAllViewerSocketMessages(message);
				return;
			}
			this.registry.getPdf(message.pdf_id);
			this.broadcastViewerSocketMessage(message.pdf_id, message);
		});
	}

	get origin(): string {
		if (!this.originValue) throw new Error("Viewer Host Server is not started");
		return this.originValue;
	}

	get address(): ViewerHostServerAddress {
		if (!this.addressValue) throw new Error("Viewer Host Server is not started");
		return this.addressValue;
	}

	get viewerRootUrl(): string {
		return this.accessPolicy.viewerRootUrl(this.origin);
	}

	get instanceId(): string {
		return this.instanceIdValue;
	}

	get controlStatus(): ViewerHostControlStatus {
		return {
			ready: this.controlReady,
			...(this.controlProtocolVersion === undefined ? {} : { protocolVersion: this.controlProtocolVersion }),
		};
	}

	pdfUrl(pdfId: number, revision: number): string {
		return this.accessPolicy.pdfUrl(this.origin, pdfId, revision);
	}

	getConnectedViewerCount(pdfId: number): number {
		this.registry.getPdf(pdfId);
		return this.viewerSocketClientsByPdfId.get(pdfId)?.size ?? 0;
	}

	hasActiveViewerClients(): boolean {
		return this.activeViewerClientCount() > 0;
	}

	private activeViewerClientCount(): number {
		let count = this.viewerEventClients.size;
		for (const clients of this.viewerSocketClientsByPdfId.values()) {
			for (const client of clients) {
				if (!client.closed) count += 1;
			}
		}
		return count;
	}

	sendPdfRefresh(pdfId: number): number {
		const record = this.registry.getPdf(pdfId);
		return this.broadcastViewerSocketMessage(record.pdfId, { type: "pdf_refresh", pdf_id: record.pdfId, revision: record.revision, pdf_url: this.pdfUrl(record.pdfId, record.revision) });
	}

	private scheduleSynctexPrewarm(record: ViewerHostPdfRecord): void {
		const pdfPath = record.pdfPath;
		setImmediate(() => prewarmSynctexForPdf(pdfPath));
	}

	getPdfRefreshDiagnostic(pdfId: number): ViewerHostPdfRefreshDiagnostic | undefined {
		this.registry.getPdf(pdfId);
		const diagnostic = this.pdfRefreshDiagnostics.get(pdfId);
		return diagnostic ? { ...diagnostic } : undefined;
	}

	async verifyPdfChangesNow(pdfId?: number): Promise<void> {
		const records = pdfId === undefined ? this.registry.listPdfs() : [this.registry.getPdf(pdfId)];
		for (const record of records) {
			await this.verifyPdfRecordSnapshot(record);
		}
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((request, response) => {
			void this.handleHttpRequest(request, response).catch(() => {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				textResponse(response, 500, "text/plain; charset=utf-8", "viewer host request failed", request.method === "HEAD");
			});
		});
		server.on("connection", (socket) => {
			this.activeSockets.add(socket);
			socket.once("close", () => this.activeSockets.delete(socket));
		});
		server.on("upgrade", (request, socket, head) => {
			this.handleViewerSocketUpgrade(request, socket as Socket, head);
		});
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ host: this.accessPolicy.bindHost, port: this.port }, () => {
					server.off("error", reject);
					resolve();
				});
			});
		} catch (error) {
			this.server = undefined;
			this.originValue = undefined;
			this.addressValue = undefined;
			for (const socket of this.activeSockets) socket.destroy();
			throw error;
		}
		const address = server.address() as AddressInfo | null;
		if (!address || typeof address === "string") {
			throw new Error("Viewer Host Server did not expose a TCP address");
		}
		this.addressValue = { host: this.accessPolicy.bindHost, port: address.port };
		this.originValue = this.accessPolicy.originForAddress(this.addressValue);
		this.startPdfChangePolling();
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.originValue = undefined;
		this.addressValue = undefined;
		this.controlReady = false;
		this.controlProtocolVersion = undefined;
		this.visibleViewerTabs.clear();
		this.debugSynctexByPdfId.clear();
		this.mcpEvents.clear();
		this.pendingPdfMarks.clear();
		this.pendingPdfRefreshSnapshots.clear();
		this.pdfRefreshDiagnostics.clear();
		this.stopPdfChangePolling();
		this.viewerSocketClientsByPdfId.clear();
		this.viewerSocketTokensByPdfId.clear();
		for (const socket of this.activeSockets) {
			socket.destroy();
		}
		this.viewerEventClients.clear();
		this.activeVisiblePdfId = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${LOCAL_HOST}`);
		if (requestUrl.pathname === "/control") {
			await this.handleControlRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/shutdown") {
			this.handleShutdownRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/heartbeat") {
			void this.handleHeartbeatRequest(request, response).catch((error) => jsonResponse(response, 500, { ok: false, error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } }));
			return;
		}
		if (requestUrl.pathname === "/viewer-events") {
			this.handleViewerEventsRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/viewer-tab-closed") {
			await this.handleViewerTabClosedRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/viewer-tab-selected") {
			await this.handleViewerTabSelectedRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/mcp-events/drain") {
			await this.handleMcpEventsDrainRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/marks/claim") {
			await this.handleMarksClaimRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/marks/ack") {
			await this.handleMarksAckRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/marks/release") {
			await this.handleMarksReleaseRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/synctex/probe") {
			await this.handleSynctexProbeRequest(request, response);
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			textResponse(response, 405, "text/plain; charset=utf-8", "method not allowed", false);
			return;
		}

		if (requestUrl.pathname === "/viewer-lw" || requestUrl.pathname === "/viewer-lw/") {
			const activeTab = this.lastVisibleViewerTab();
			if (!activeTab) {
				this.serveLaTeXWorkshopEmptyViewerShell(response, request.method === "HEAD");
				return;
			}
			response.writeHead(302, { location: `/viewer-lw/${activeTab.pdf_id}`, "cache-control": "no-store" });
			response.end();
			return;
		}

		const lwViewerMatch = /^\/viewer-lw\/(\d+)$/.exec(requestUrl.pathname);
		if (lwViewerMatch) {
			const pdfId = parsePositiveInteger(lwViewerMatch[1]);
			if (pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id", request.method === "HEAD");
				return;
			}
			this.serveLaTeXWorkshopViewerShell(response, pdfId, request.method === "HEAD");
			return;
		}

		const viewerMatch = /^\/viewer\/(\d+)$/.exec(requestUrl.pathname);
		if (viewerMatch) {
			const pdfId = parsePositiveInteger(viewerMatch[1]);
			if (pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id", request.method === "HEAD");
				return;
			}
			const location = `/viewer-lw/${pdfId}${requestUrl.search}`;
			response.writeHead(302, { location, "cache-control": "no-store" });
			response.end();
			return;
		}

		const configMatch = /^\/config\/(\d+)\.json$/.exec(requestUrl.pathname);
		if (configMatch) {
			const pdfId = parsePositiveInteger(configMatch[1]);
			if (pdfId === undefined) {
				textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }), request.method === "HEAD");
				return;
			}
			this.serveViewerConfig(response, pdfId, request.method === "HEAD");
			return;
		}

		if (requestUrl.pathname.startsWith("/viewer-lw/")) {
			this.serveLaTeXWorkshopViewerAsset(response, requestUrl.pathname, request.method === "HEAD");
			return;
		}
		if (requestUrl.pathname.startsWith("/cmaps/") || requestUrl.pathname.startsWith("/standard_fonts/") || requestUrl.pathname.startsWith("/wasm/")) {
			this.servePdfJsDistAsset(response, requestUrl.pathname, request.method === "HEAD");
			return;
		}

		const pdfMatch = /^\/pdf\/(\d+)$/.exec(requestUrl.pathname);
		if (pdfMatch) {
			const pdfId = parsePositiveInteger(pdfMatch[1]);
			const revision = parsePositiveInteger(requestUrl.searchParams.get("revision") ?? undefined);
			if (pdfId === undefined || revision === undefined) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id or revision", request.method === "HEAD");
				return;
			}
			await this.servePdf(response, pdfId, revision, request.method === "HEAD");
			return;
		}

		textResponse(response, 404, "text/plain; charset=utf-8", "not found", request.method === "HEAD");
	}

	private handleViewerEventsRequest(request: IncomingMessage, response: ServerResponse): void {
		if (request.method !== "GET") {
			textResponse(response, 405, "text/plain; charset=utf-8", "viewer event stream requires GET", false);
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		this.viewerEventClients.add(response);
		writeViewerEvent(response, { type: "ready" });
		for (const event of this.visibleViewerTabs.values()) {
			writeViewerEvent(response, { ...event, active: event.pdf_id === this.activeVisiblePdfId });
		}
		request.once("close", () => this.viewerEventClients.delete(response));
	}

	private async handleViewerTabClosedRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const payload = await this.readViewerTabPayload(request, response, "invalid_close_payload");
		if (!payload) return;
		const current = this.visibleViewerTabs.get(payload.pdf_id);
		if (current?.revision === payload.revision && current.viewer_url === payload.viewer_url && current.visible_tab_token === payload.visible_tab_token) {
			this.visibleViewerTabs.delete(payload.pdf_id);
			if (this.activeVisiblePdfId === payload.pdf_id) this.activeVisiblePdfId = this.lastVisibleViewerTab()?.pdf_id;
			this.discardMcpEventsForPdfId(payload.pdf_id);
			this.pendingPdfMarks.clearPdf(payload.pdf_id);
			this.broadcastAnnotationsCleared([payload.pdf_id]);
			this.queueMcpEvent({ type: "viewer_tab_closed", pdf_id: payload.pdf_id });
		}
		textResponse(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }), false);
	}

	private async handleViewerTabSelectedRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			textResponse(response, 405, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "method_not_allowed" }), false);
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "malformed_json" }), false);
			return;
		}
		if (!isViewerTabSelectedPayload(payload)) {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "invalid_select_payload" }), false);
			return;
		}
		const selected = this.visibleViewerTabs.get(payload.pdf_id);
		if (selected) {
			this.activeVisiblePdfId = payload.pdf_id;
			this.broadcastViewerEvent({ ...selected, type: "focus_pdf", active: true });
		}
		textResponse(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }), false);
	}

	private async readViewerTabPayload(request: IncomingMessage, response: ServerResponse, invalidPayloadError: string): Promise<ViewerTabPayload | undefined> {
		if (request.method !== "POST") {
			textResponse(response, 405, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "method_not_allowed" }), false);
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "malformed_json" }), false);
			return;
		}
		if (!isViewerTabPayload(payload)) {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: invalidPayloadError }), false);
			return;
		}
		return payload;
	}

	private async handleMcpEventsDrainRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.isAuthorizedControlRequest(request)) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid Viewer Host control token" } });
			return;
		}
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "MCP event drain requires POST" } });
			return;
		}
		const filters = await this.readMcpEventsDrainFilters(request, response);
		if (response.headersSent) return;
		const events = this.mcpEvents.drain(filters);
		jsonResponse(response, 200, { ok: true, events });
	}

	private async handleMarksClaimRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.isAuthorizedControlRequest(request)) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid Viewer Host control token" } });
			return;
		}
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "mark claim requires POST" } });
			return;
		}
		let payload: unknown = {};
		try {
			const body = await readRequestBody(request);
			if (body.trim()) payload = JSON.parse(body);
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "mark claim body must be valid JSON" } });
			return;
		}
		if (!isRecord(payload)) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_request", message: "mark claim body must be an object" } });
			return;
		}
		if (payload.pdf_ids !== undefined && (!Array.isArray(payload.pdf_ids) || !payload.pdf_ids.every((value) => Number.isInteger(value) && value > 0))) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_pdf_ids", message: "mark claim pdf_ids must be positive integers" } });
			return;
		}
		if (payload.max_marks !== undefined && (!Number.isInteger(payload.max_marks) || Number(payload.max_marks) <= 0)) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_max_marks", message: "mark claim max_marks must be a positive integer" } });
			return;
		}
		const claim = this.pendingPdfMarks.claim({
			...(payload.pdf_ids === undefined ? {} : { pdfIds: new Set(payload.pdf_ids as number[]) }),
			...(payload.max_marks === undefined ? {} : { maxMarks: Number(payload.max_marks) }),
		});
		jsonResponse(response, 200, {
			ok: true,
			marks: claim.marks,
			...(claim.claimId === undefined ? {} : { claim_id: claim.claimId }),
			...(claim.expiresAtMs === undefined ? {} : { lease_expires_at_ms: claim.expiresAtMs }),
		});
	}

	private async handleMarksAckRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.isAuthorizedControlRequest(request)) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid Viewer Host control token" } });
			return;
		}
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "mark acknowledgement requires POST" } });
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "mark acknowledgement body must be valid JSON" } });
			return;
		}
		if (!isRecord(payload) || typeof payload.claim_id !== "string" || !payload.claim_id.trim() || payload.claim_id.length > 256) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_claim_id", message: "mark acknowledgement claim_id must be a non-empty string" } });
			return;
		}
		if (!Array.isArray(payload.consumed) || !payload.consumed.every((entry) => isRecord(entry)
			&& Number.isInteger(entry.pdf_id) && Number(entry.pdf_id) > 0
			&& typeof entry.annotation_id === "string" && entry.annotation_id.length > 0)) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_consumed_marks", message: "mark acknowledgement consumed must list PDF and annotation IDs" } });
			return;
		}
		const acknowledged = this.pendingPdfMarks.acknowledge(payload.claim_id, payload.consumed as AcknowledgedPdfMark[]);
		this.broadcastAcknowledgedMarks(acknowledged);
		jsonResponse(response, 200, { ok: true, acknowledged });
	}

	private async handleMarksReleaseRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.isAuthorizedControlRequest(request)) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid Viewer Host control token" } });
			return;
		}
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "mark release requires POST" } });
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "mark release body must be valid JSON" } });
			return;
		}
		if (!isRecord(payload) || typeof payload.claim_id !== "string" || !payload.claim_id.trim() || payload.claim_id.length > 256) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_claim_id", message: "mark release claim_id must be a non-empty string" } });
			return;
		}
		if (payload.error !== undefined && (typeof payload.error !== "string" || !payload.error.trim() || payload.error.length > 2_000)) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_error", message: "mark release error must be a non-empty string of at most 2000 characters" } });
			return;
		}
		const released = this.pendingPdfMarks.release(payload.claim_id);
		if (typeof payload.error === "string") {
			for (const pdfId of new Set(released.map((mark) => mark.pdf_id))) {
				await this.failureReporter.report(payload.error, {
					pdfId,
					code: "mark_delivery_failed",
					title: "Could not deliver PDF marks",
					detail: payload.error,
					injectText: `PDF mark delivery failed: ${payload.error}`,
				});
			}
		}
		jsonResponse(response, 200, { ok: true, released });
	}

	private async handleSynctexProbeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "SyncTeX probe requires POST" } });
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "SyncTeX probe body must be valid JSON" } });
			return;
		}
		if (!isRecord(payload)) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_request", message: "SyncTeX probe body must be an object" } });
			return;
		}
		const pdfId = parsePositiveInteger(typeof payload.pdf_id === "number" ? String(payload.pdf_id) : undefined);
		if (pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
			jsonResponse(response, 404, { ok: false, error: { code: "unknown_pdf", message: "unknown pdf_id" } });
			return;
		}
		if (request.headers["x-agent-synctex-viewer-token"] !== this.viewerSocketTokenForPdf(pdfId)) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid viewer token" } });
			return;
		}
		let message: Extract<ViewerHostToMcpMessage, { type: "reverse_synctex_forward_probe" }>;
		try {
			const validated = validateViewerHostToMcpMessage({ ...payload, type: "reverse_synctex_forward_probe", pdf_id: pdfId });
			if (validated.type !== "reverse_synctex_forward_probe") throw new Error("invalid SyncTeX probe message");
			message = validated;
		} catch (error) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_probe", message: errorMessage(error) } });
			return;
		}
		try {
			const record = this.registry.getPdf(pdfId);
			jsonResponse(response, 200, { ok: true, result: reverseSynctexForwardProbeResult({ message, pdf: { pdfId: record.pdfId, pdfPath: record.pdfPath, workspaceCwd: record.workspaceCwd } }) });
		} catch (error) {
			jsonResponse(response, 200, {
				ok: true,
				result: { type: "reverse_synctex_forward_probe_result", pdf_id: pdfId, request_id: message.request_id, click_page: message.page, click_x: message.x, click_y: message.y, error: errorMessage(error) },
			});
		}
	}

	private async readMcpEventsDrainFilters(request: IncomingMessage, response: ServerResponse): Promise<ViewerHostEventFilters | undefined> {
		if (request.headers["content-type"] === undefined) return undefined;
		let body = "";
		try {
			body = await readRequestBody(request);
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "MCP event drain body must be valid JSON" } });
			return undefined;
		}
		if (!body.trim()) return undefined;
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "MCP event drain body must be valid JSON" } });
			return undefined;
		}
		if (!isRecord(payload)) return undefined;
		let pdfIds: Set<number> | undefined;
		if (payload.pdf_ids !== undefined) {
			if (!Array.isArray(payload.pdf_ids) || !payload.pdf_ids.every((value) => Number.isInteger(value) && value > 0)) {
				jsonResponse(response, 400, { ok: false, error: { code: "invalid_pdf_ids", message: "MCP event drain pdf_ids must be positive integers" } });
				return undefined;
			}
			pdfIds = new Set(payload.pdf_ids);
		}
		let eventTypes: Set<ViewerHostToMcpMessage["type"]> | undefined;
		if (payload.event_types !== undefined) {
			if (!Array.isArray(payload.event_types) || !payload.event_types.every((value) => typeof value === "string")) {
				jsonResponse(response, 400, { ok: false, error: { code: "invalid_event_types", message: "MCP event drain event_types must be strings" } });
				return undefined;
			}
			eventTypes = new Set(payload.event_types as ViewerHostToMcpMessage["type"][]);
		}
		return { ...(pdfIds === undefined ? {} : { pdfIds }), ...(eventTypes === undefined ? {} : { eventTypes }) };
	}

	private serveLaTeXWorkshopViewerShell(response: ServerResponse, pdfId: number, headOnly: boolean): void {
		this.serveLaTeXWorkshopViewerHtml(response, headOnly, `/config/${pdfId}.json`);
	}

	private serveLaTeXWorkshopEmptyViewerShell(response: ServerResponse, headOnly: boolean): void {
		this.serveLaTeXWorkshopViewerHtml(response, headOnly);
	}

	private serveLaTeXWorkshopViewerHtml(response: ServerResponse, headOnly: boolean, configUrl?: string): void {
		try {
			const bodyTag = configUrl === undefined ? "<body tabindex=\"0\">" : `<body tabindex="0" data-config-url="${configUrl}">`;
			const html = readFileSync(resolve(LW_VIEWER_ASSET_ROOT, "viewer.html"), "utf8")
				.replace("<body tabindex=\"0\">", bodyTag);
			textResponse(response, 200, "text/html; charset=utf-8", html, headOnly);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "LaTeX Workshop viewer shell is not readable", headOnly);
		}
	}

	private serveLaTeXWorkshopViewerAsset(response: ServerResponse, requestPath: string, headOnly: boolean): void {
		const buildAsset = LW_PDFJS_BUILD_ASSETS.get(requestPath);
		if (buildAsset !== undefined) {
			this.serveLocalPdfJsAsset(response, buildAsset.path, headOnly, buildAsset.polyfillModernPromiseHelpers === true);
			return;
		}
		const relativeAssetPath = requestPath.replace(/^\/viewer-lw\//, "");
		if (relativeAssetPath === "" || relativeAssetPath === "viewer.html" || relativeAssetPath.includes("\0")) {
			textResponse(response, 404, "text/plain; charset=utf-8", "not found", headOnly);
			return;
		}
		this.serveStaticFile(response, LW_VIEWER_ASSET_ROOT, relativeAssetPath, headOnly);
	}

	private servePdfJsDistAsset(response: ServerResponse, requestPath: string, headOnly: boolean): void {
		const relativeAssetPath = requestPath.replace(/^\//, "");
		this.serveStaticFile(response, LW_VIEWER_ASSET_ROOT, relativeAssetPath, headOnly);
	}

	private serveStaticFile(response: ServerResponse, root: string, relativeAssetPath: string, headOnly: boolean): void {
		const assetPath = resolve(root, relativeAssetPath);
		const relativeToRoot = relative(root, assetPath);
		if (relativeToRoot.startsWith("..") || relativeToRoot === "" || relativeToRoot.split(sep).includes("..")) {
			textResponse(response, 404, "text/plain; charset=utf-8", "not found", headOnly);
			return;
		}
		try {
			binaryResponse(response, 200, contentTypeForPath(assetPath), readFileSync(assetPath), headOnly);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "asset is not readable", headOnly);
		}
	}

	private serveViewerConfig(response: ServerResponse, pdfId: number, headOnly: boolean): void {
		let record: ViewerHostPdfRecord;
		try {
			record = this.registry.getPdf(pdfId);
		} catch {
			textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }), headOnly);
			return;
		}
		const token = this.viewerSocketTokenForPdf(record.pdfId);
		const viewerSocketUrl = this.accessPolicy.viewerSocketUrl(this.origin, record.pdfId, token);
		const body = JSON.stringify({
			pdf_id: record.pdfId,
			title: record.title,
			revision: record.revision,
			pdf_url: this.pdfUrl(record.pdfId, record.revision),
			viewer_socket_url: viewerSocketUrl,
			ws_url: viewerSocketUrl,
			viewer_socket_token: token,
			debug_synctex: this.debugSynctexByPdfId.get(record.pdfId) === true,
		});
		textResponse(response, 200, "application/json; charset=utf-8", body, headOnly);
	}

	private serveLocalPdfJsAsset(response: ServerResponse, path: string, headOnly: boolean, prependModernPromiseHelpersPolyfill = false): void {
		try {
			const body = readFileSync(path);
			if (prependModernPromiseHelpersPolyfill) {
				textResponse(response, 200, contentTypeForPath(path), `${PDFJS_MODERN_PROMISE_HELPERS_POLYFILL}${body.toString("utf8")}`, headOnly);
				return;
			}
			binaryResponse(response, 200, contentTypeForPath(path), body, headOnly);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "PDF.js asset is not readable", headOnly);
		}
	}

	private hasRegisteredPdf(pdfId: number): boolean {
		try {
			this.registry.getPdf(pdfId);
			return true;
		} catch {
			return false;
		}
	}

	private handleShutdownRequest(request: IncomingMessage, response: ServerResponse): void {
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "shutdown requires POST" } });
			return;
		}
		if (!this.shutdownRequest) {
			jsonResponse(response, 404, { ok: false, error: { code: "shutdown_unavailable", message: "shutdown endpoint is not enabled" } });
			return;
		}
		if (request.headers[VIEWER_HOST_SHUTDOWN_TOKEN_HEADER] !== this.shutdownRequest.token) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid shutdown token" } });
			return;
		}
		const shutdownRequest = this.shutdownRequest;
		response.once("finish", () => {
			setImmediate(() => {
				void Promise.resolve(shutdownRequest.shutdown("http_shutdown")).catch(() => undefined);
			});
		});
		jsonResponse(response, 200, { ok: true, instance_id: this.instanceIdValue });
	}

	private async handleHeartbeatRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "heartbeat requires POST" } });
			return;
		}
		if (!this.heartbeatRequest) {
			jsonResponse(response, 404, { ok: false, error: { code: "heartbeat_unavailable", message: "heartbeat endpoint is not enabled" } });
			return;
		}
		if (request.headers[VIEWER_HOST_HEARTBEAT_TOKEN_HEADER] !== this.heartbeatRequest.token) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid heartbeat token" } });
			return;
		}
		let payload: unknown = {};
		try {
			const raw = await readRequestBody(request);
			payload = raw.trim() ? JSON.parse(raw) : {};
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "heartbeat request body must be valid JSON" } });
			return;
		}
		if (!isRecord(payload) || payload.owner_id !== this.heartbeatRequest.ownerId) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "heartbeat owner mismatch" } });
			return;
		}
		await this.heartbeatRequest.heartbeat();
		jsonResponse(response, 200, { ok: true, owner_id: this.heartbeatRequest.ownerId, active_viewer_clients: this.activeViewerClientCount() });
	}

	private isAuthorizedControlRequest(request: IncomingMessage): boolean {
		return this.controlToken === undefined || request.headers[VIEWER_HOST_CONTROL_TOKEN_HEADER] === this.controlToken;
	}

	private async handleControlRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.isAuthorizedControlRequest(request)) {
			jsonResponse(response, 403, { ok: false, error: { code: "forbidden", message: "invalid Viewer Host control token" } });
			return;
		}
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "control channel requires POST" } });
			return;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "control request body must be valid JSON" } });
			return;
		}

		let message: ReturnType<typeof validateMcpToViewerHostMessage>;
		try {
			message = validateMcpToViewerHostMessage(payload);
		} catch (error) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_message", message: errorMessage(error) } });
			return;
		}

		try {
			jsonResponse(response, 200, await this.dispatchControlMessage(message));
		} catch (error) {
			const message = errorMessage(error);
			const unknownPdf = /^Unknown pdf_id=/.test(message);
			jsonResponse(response, unknownPdf ? 404 : 400, { ok: false, error: { code: unknownPdf ? "unknown_pdf" : "control_dispatch_failed", message } });
		}
	}

	private async dispatchControlMessage(message: ReturnType<typeof validateMcpToViewerHostMessage>): Promise<ViewerHostControlResponse> {
		switch (message.type) {
			case "hello":
				if (message.protocol_version !== VIEWER_HOST_PROTOCOL_VERSION) {
					return { ok: false, error: { code: "unsupported_protocol_version", message: `unsupported protocol_version=${message.protocol_version}` } };
				}
				this.controlReady = true;
				this.controlProtocolVersion = message.protocol_version;
				return { ok: true, message: { type: "ready", protocol_version: VIEWER_HOST_PROTOCOL_VERSION, origin: this.origin, instance_id: this.instanceIdValue, active_viewer_clients: this.activeViewerClientCount() } };
			case "open_pdf": {
				const snapshot = await snapshotRegisteredPdf(this.fileSystem, message.pdf_path);
				const revision = this.nextRegistrationRevision(message.pdf_id, message.pdf_path, snapshot);
				const record = this.registry.registerPdf({
					pdfId: message.pdf_id,
					pdfPath: message.pdf_path,
					title: message.title ?? basename(message.pdf_path),
					revision,
					fileSnapshot: snapshot,
					...(message.workspace_cwd === undefined ? {} : { workspaceCwd: message.workspace_cwd }),
				});
				this.pendingPdfRefreshSnapshots.delete(record.pdfId);
				this.pdfRefreshDiagnostics.delete(record.pdfId);
				this.debugSynctexByPdfId.set(record.pdfId, message.debug_synctex === true);
				await this.viewerDispatch.openPdf(record);
					this.broadcastViewerTabEvent("open_pdf", record);
				this.scheduleSynctexPrewarm(record);
				return { ok: true, result: { type: "open_pdf", pdf_id: record.pdfId, revision: record.revision } };
			}
			case "focus_pdf": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.viewerDispatch.focusPdf(record);
					this.broadcastViewerTabEvent("focus_pdf", record);
				return { ok: true, result: { type: "focus_pdf", pdf_id: record.pdfId } };
			}
			case "set_debug_synctex": {
				const record = this.registry.getPdf(message.pdf_id);
				this.debugSynctexByPdfId.set(record.pdfId, message.enabled);
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "set_debug_synctex", pdf_id: record.pdfId } };
			}
			case "synctex_forward": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.viewerDispatch.synctexForward(message, record);
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "synctex_forward", pdf_id: record.pdfId } };
			}
			case "pdf_maybe_updated": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.verifyPdfChangesNow(record.pdfId);
				await this.verifyPdfMaybeUpdated(record);
				return { ok: true, result: { type: "pdf_maybe_updated", pdf_id: record.pdfId } };
			}
			case "clear_pdf_annotations": {
				const record = this.registry.getPdf(message.pdf_id);
				this.pendingPdfMarks.clearPdf(record.pdfId);
				this.broadcastAnnotationsCleared([record.pdfId]);
				return { ok: true, result: { type: "clear_pdf_annotations", pdf_id: record.pdfId } };
			}
			case "compile_status": {
				const record = this.registry.getPdf(message.pdf_id);
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "compile_status", pdf_id: record.pdfId } };
			}
			case "report_error": {
				if (message.pdf_id !== undefined) this.registry.getPdf(message.pdf_id);
				await this.failureReporter.report(message.detail, {
					code: message.code,
					title: message.title,
					...(message.pdf_id === undefined ? {} : { pdfId: message.pdf_id }),
					detail: message.detail,
					...(message.inject_text === undefined ? {} : { injectText: message.inject_text }),
				});
				return { ok: true, result: { type: "report_error", ...(message.pdf_id === undefined ? {} : { pdf_id: message.pdf_id }) } };
			}
			case "reverse_synctex_hover_result": {
				const record = this.registry.getPdf(message.pdf_id);
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "reverse_synctex_hover_result", pdf_id: record.pdfId } };
			}
		}
	}

	private handleViewerSocketUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${LOCAL_HOST}`);
		const pdfId = parsePositiveInteger(requestUrl.searchParams.get("pdf_id") ?? undefined);
		if (requestUrl.pathname !== "/viewer-socket" || pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
			rejectWebSocketUpgrade(socket, 404, "unknown pdf_id");
			return;
		}
		if (!this.accessPolicy.isAllowedViewerSocketOrigin(request.headers.origin, this.origin)) {
			rejectWebSocketUpgrade(socket, 403, "forbidden origin");
			return;
		}
		const token = requestUrl.searchParams.get("token") ?? "";
		if (token !== this.viewerSocketTokenForPdf(pdfId)) {
			rejectWebSocketUpgrade(socket, 403, "invalid viewer socket token");
			return;
		}
		const headerError = validateWebSocketUpgradeHeaders(request);
		if (headerError) {
			rejectWebSocketUpgrade(socket, 400, headerError);
			return;
		}
		const key = request.headers["sec-websocket-key"] as string;
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"",
			"",
		].join("\r\n"));
		const connection: ViewerSocketConnection = { pdfId, socket, buffer: Buffer.alloc(0), closed: false };
		let clients = this.viewerSocketClientsByPdfId.get(pdfId);
		if (!clients) {
			clients = new Set<ViewerSocketConnection>();
			this.viewerSocketClientsByPdfId.set(pdfId, clients);
		}
		clients.add(connection);
		const cleanup = () => this.cleanupViewerSocket(connection);
		socket.once("close", cleanup);
		socket.once("end", cleanup);
		socket.once("error", cleanup);
		socket.on("data", (chunk) => this.handleViewerSocketData(connection, chunk));
		if (head.length > 0) this.handleViewerSocketData(connection, head);
	}

	private handleViewerSocketData(connection: ViewerSocketConnection, chunk: Buffer): void {
		if (connection.closed) return;
		connection.buffer = Buffer.concat([connection.buffer, chunk]);
		if (connection.buffer.length > MAX_VIEWER_SOCKET_MESSAGE_BYTES + 14) {
			this.closeViewerSocket(connection);
			return;
		}
		while (connection.buffer.length > 0) {
			let frame: { fin: boolean; opcode: number; masked: boolean; payload: Buffer; bytesRead: number } | undefined;
			try {
				frame = readWebSocketFrame(connection.buffer);
			} catch {
				this.closeViewerSocket(connection);
				return;
			}
			if (!frame) return;
			connection.buffer = connection.buffer.subarray(frame.bytesRead);
			if (!frame.fin || !frame.masked) {
				this.closeViewerSocket(connection);
				return;
			}
			if (frame.opcode === 0x8) {
				this.closeViewerSocket(connection);
				return;
			}
			if (frame.opcode === 0x9) {
				sendWebSocketFrame(connection.socket, 0xA, frame.payload);
				continue;
			}
			if (frame.opcode !== 0x1) continue;
			this.handleViewerSocketText(connection, frame.payload.toString("utf8"));
		}
	}

	private handleViewerSocketText(connection: ViewerSocketConnection, text: string): void {
		let payload: unknown;
		try {
			payload = JSON.parse(text);
			if (!isRecord(payload) || (payload.type !== "reverse_synctex" && payload.type !== "pdf_annotation" && payload.type !== "pdf_annotation_deleted" && payload.type !== "selection_debug" && payload.type !== "reverse_synctex_hover" && payload.type !== "compile_action")) return;
			if (payload.pdf_id !== undefined && payload.pdf_id !== connection.pdfId) {
				throw new Error(`${String(payload.type)} pdf_id=${String(payload.pdf_id)} does not match viewer socket pdf_id=${connection.pdfId}`);
			}
			const message = validateViewerHostToMcpMessage({ ...payload, pdf_id: connection.pdfId });
			if (message.type === "pdf_annotation") {
				this.pendingPdfMarks.upsert(message);
				return;
			}
			if (message.type === "pdf_annotation_deleted") {
				this.pendingPdfMarks.delete(message.pdf_id, message.annotation_id);
				return;
			}
			if (message.type === "compile_action" && message.action === "inject_diagnostic" && message.inject_text?.trim()) {
				const record = this.registry.getPdf(message.pdf_id);
				this.pendingPdfMarks.upsert({
					type: "pdf_annotation",
					pdf_id: record.pdfId,
					annotation_id: `compile-diagnostic-${Date.now()}-${randomBytes(6).toString("hex")}`,
					page: 1,
					x: 0,
					y: 0,
					source_file: inferDefaultSourceFileForPdf(record.pdfPath) ?? record.pdfPath,
					line: 1,
					comment: message.inject_text,
				});
				return;
			}
			if (message.type === "reverse_synctex_hover") {
				this.handleReverseSynctexHoverMessage(connection, message);
				return;
			}
			this.queueMcpEvent(message);
		} catch (error) {
			sendViewerSocketJson(connection, { type: "error", code: "invalid_viewer_message", message: errorMessage(error) });
		}
	}

	private discardMcpEventsForPdfId(pdfId: number): void {
		this.mcpEvents.discardPdf(pdfId);
	}

	private queueMcpEvent(message: ViewerHostToMcpMessage): void {
		this.mcpEvents.enqueue(message);
	}

	private broadcastAnnotationsCleared(pdfIds: Iterable<number>): void {
		for (const pdfId of pdfIds) {
			this.broadcastAllViewerSocketMessages({ type: "annotations_cleared", pdf_id: pdfId, pdf_ids: [pdfId] });
		}
	}

	private broadcastAcknowledgedMarks(acknowledged: readonly AcknowledgedPdfMark[]): void {
		const annotationIdsByPdfId = new Map<number, string[]>();
		for (const mark of acknowledged) {
			const annotationIds = annotationIdsByPdfId.get(mark.pdf_id) ?? [];
			annotationIds.push(mark.annotation_id);
			annotationIdsByPdfId.set(mark.pdf_id, annotationIds);
		}
		for (const [pdfId, annotationIds] of annotationIdsByPdfId) {
			this.broadcastAllViewerSocketMessages({ type: "annotations_cleared", pdf_id: pdfId, pdf_ids: [pdfId], annotation_ids: annotationIds });
		}
	}

	private broadcastAllViewerSocketMessages(message: object): number {
		let delivered = 0;
		for (const clients of this.viewerSocketClientsByPdfId.values()) {
			for (const connection of clients) {
				if (connection.closed) continue;
				sendViewerSocketJson(connection, message);
				delivered += 1;
			}
		}
		return delivered;
	}

	private handleReverseSynctexHoverMessage(connection: ViewerSocketConnection, message: Extract<ViewerHostToMcpMessage, { type: "reverse_synctex_hover" }>): void {
		try {
			const record = this.registry.getPdf(connection.pdfId);
			sendViewerSocketJson(connection, reverseSynctexHoverResult({ message, pdf: { pdfId: record.pdfId, pdfPath: record.pdfPath, workspaceCwd: record.workspaceCwd } }));
		} catch (error) {
			sendViewerSocketJson(connection, { type: "reverse_synctex_hover_result", pdf_id: connection.pdfId, request_id: message.request_id, page: message.page, x: message.x, y: message.y, error: errorMessage(error) });
		}
	}

	private closeViewerSocket(connection: ViewerSocketConnection): void {
		if (!connection.closed) sendWebSocketFrame(connection.socket, 0x8, Buffer.alloc(0));
		connection.socket.end();
		this.cleanupViewerSocket(connection);
	}

	private cleanupViewerSocket(connection: ViewerSocketConnection): void {
		if (connection.closed) return;
		connection.closed = true;
		const clients = this.viewerSocketClientsByPdfId.get(connection.pdfId);
		clients?.delete(connection);
		if (clients?.size === 0) this.viewerSocketClientsByPdfId.delete(connection.pdfId);
	}

	private broadcastViewerSocketMessage(pdfId: number, message: object): number {
		const clients = this.viewerSocketClientsByPdfId.get(pdfId);
		if (!clients) return 0;
		let delivered = 0;
		for (const connection of clients) {
			if (connection.closed) continue;
			sendViewerSocketJson(connection, message);
			delivered += 1;
		}
		return delivered;
	}

	private viewerSocketTokenForPdf(pdfId: number): string {
		this.registry.getPdf(pdfId);
		let token = this.viewerSocketTokensByPdfId.get(pdfId);
		if (!token) {
			token = randomBytes(32).toString("base64url");
			this.viewerSocketTokensByPdfId.set(pdfId, token);
		}
		return token;
	}

	private broadcastViewerTabEvent(type: ViewerTabEvent["type"], record: ViewerHostPdfRecord): void {
		const event: ViewerTabEvent = {
			type,
			pdf_id: record.pdfId,
			title: record.title,
			revision: record.revision,
			viewer_url: this.accessPolicy.viewerUrl(record.pdfId, record.revision),
			visible_tab_token: this.createVisibleTabToken(),
			active: true,
		};
		this.visibleViewerTabs.set(record.pdfId, event);
		this.activeVisiblePdfId = record.pdfId;
		this.broadcastViewerEvent(event);
	}

	private createVisibleTabToken(): string {
		const token = `visible-tab-${this.nextVisibleTabToken}`;
		this.nextVisibleTabToken += 1;
		return token;
	}

	private lastVisibleViewerTab(): ViewerTabEvent | undefined {
		if (this.activeVisiblePdfId !== undefined) {
			const active = this.visibleViewerTabs.get(this.activeVisiblePdfId);
			if (active) return active;
		}
		let last: ViewerTabEvent | undefined;
		for (const event of this.visibleViewerTabs.values()) last = event;
		return last;
	}

	private broadcastViewerEvent(event: ViewerTabEvent | { type: "ready" }): void {
		for (const client of this.viewerEventClients) {
			writeViewerEvent(client, event);
		}
	}

	private nextRegistrationRevision(pdfId: number, pdfPath: string, snapshot: { size: number; mtimeMs: number }): number {
		try {
			const existing = this.registry.getPdf(pdfId);
			return existing.pdfPath === resolve(pdfPath) && isSnapshotMatch(existing.fileSnapshot, snapshot) ? existing.revision : existing.revision + 1;
		} catch {
			return 1;
		}
	}

	private startPdfChangePolling(): void {
		if (this.pdfChangePollIntervalMs <= 0 || this.pdfChangePollTimer) return;
		this.pdfChangePollTimer = setInterval(() => {
			if (this.pdfChangePollInFlight) return;
			this.pdfChangePollInFlight = true;
			void this.verifyPdfChangesNow()
				.catch(() => undefined)
				.finally(() => { this.pdfChangePollInFlight = false; });
		}, this.pdfChangePollIntervalMs);
		this.pdfChangePollTimer.unref?.();
	}

	private stopPdfChangePolling(): void {
		if (!this.pdfChangePollTimer) return;
		clearInterval(this.pdfChangePollTimer);
		this.pdfChangePollTimer = undefined;
		this.pdfChangePollInFlight = false;
	}

	private async verifyPdfRecordSnapshot(record: ViewerHostPdfRecord): Promise<void> {
		let snapshot: ViewerHostFileSnapshot;
		try {
			snapshot = await snapshotRegisteredPdf(this.fileSystem, record.pdfPath);
			await assertRegisteredPdfReadable(this.fileSystem, record.pdfPath);
		} catch (error) {
			this.pendingPdfRefreshSnapshots.delete(record.pdfId);
			this.pdfRefreshDiagnostics.set(record.pdfId, diagnosticForSnapshotError(record.pdfId, error));
			return;
		}

		this.pdfRefreshDiagnostics.delete(record.pdfId);
		if (isSnapshotMatch(record.fileSnapshot, snapshot)) {
			this.pendingPdfRefreshSnapshots.delete(record.pdfId);
			return;
		}

		const pending = this.pendingPdfRefreshSnapshots.get(record.pdfId);
		const now = this.nowMs();
		if (!pending || !isSnapshotMatch(pending.snapshot, snapshot)) {
			this.pendingPdfRefreshSnapshots.set(record.pdfId, { snapshot, observedAtMs: now });
			return;
		}
		if (now - pending.observedAtMs < this.pdfChangeDebounceMs) return;

		this.pendingPdfRefreshSnapshots.delete(record.pdfId);
		const updated = this.registry.recordPdfFileChange(record.pdfId, snapshot);
		this.scheduleSynctexPrewarm(updated);
		this.sendPdfRefresh(record.pdfId);
	}

	private async servePdf(response: ServerResponse, pdfId: number, revision: number, headOnly: boolean): Promise<void> {
		let record: ViewerHostPdfRecord;
		try {
			record = this.registry.getPdf(pdfId);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id", headOnly);
			return;
		}
		if (revision !== record.revision) {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown revision", headOnly);
			return;
		}

		let fileStatus: Awaited<ReturnType<ViewerHostFileSystem["stat"]>>;
		try {
			fileStatus = await this.fileSystem.stat(record.pdfPath);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not readable", headOnly);
			return;
		}
		if (!fileStatus.isFile()) {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not a regular file", headOnly);
			return;
		}
		if (!isSnapshotMatch(record.fileSnapshot, fileStatus)) {
			textResponse(response, 409, "text/plain; charset=utf-8", "stale PDF snapshot mismatch", headOnly, { "x-viewer-host-error": "stale_pdf_snapshot" });
			return;
		}

		response.writeHead(200, {
			"content-type": "application/pdf",
			"content-length": fileStatus.size,
			"cache-control": "no-store",
			"content-disposition": contentDispositionForPdf(record.title || basename(record.pdfPath)),
		});
		if (headOnly) {
			response.end();
			return;
		}
		const stream = this.fileSystem.createReadStream(record.pdfPath);
		stream.once("error", () => response.destroy());
		response.once("close", () => stream.destroy());
		stream.pipe(response);
	}
}

const NOOP_VIEWER_DISPATCH: ViewerHostViewerDispatch = {
	openPdf() {},
	focusPdf() {},
	synctexForward() {},
};

function rejectWebSocketUpgrade(socket: Socket, status: number, message: string): void {
	const body = `${message}\n`;
	socket.write([
		`HTTP/1.1 ${status} ${webSocketRejectReason(status)}`,
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${Buffer.byteLength(body, "utf8")}`,
		"",
		body,
	].join("\r\n"));
	socket.destroy();
}

function sendViewerSocketJson(connection: ViewerSocketConnection, message: object): void {
	sendWebSocketFrame(connection.socket, 0x1, Buffer.from(JSON.stringify(message), "utf8"));
}

function sendWebSocketFrame(socket: Socket, opcode: number, payload: Buffer): void {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	socket.write(Buffer.concat([header, payload]));
}

function readWebSocketFrame(buffer: Buffer): { fin: boolean; opcode: number; masked: boolean; payload: Buffer; bytesRead: number } | undefined {
	if (buffer.length < 2) return undefined;
	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	const masked = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < offset + 2) return undefined;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined;
		const bigLength = buffer.readBigUInt64BE(offset);
		if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
		length = Number(bigLength);
		offset += 8;
	}
	if (length > MAX_VIEWER_SOCKET_MESSAGE_BYTES) throw new Error("WebSocket frame is too large");
	const maskLength = masked ? 4 : 0;
	if (buffer.length < offset + maskLength + length) return undefined;
	let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
	if (masked) {
		const mask = buffer.subarray(offset, offset + 4);
		const unmasked = Buffer.alloc(payload.length);
		for (let index = 0; index < payload.length; index += 1) {
			unmasked[index] = payload[index] ^ mask[index % 4];
		}
		payload = unmasked;
	}
	return { fin, opcode, masked, payload, bytesRead: offset + maskLength + length };
}

function validateWebSocketUpgradeHeaders(request: IncomingMessage): string | undefined {
	if (String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") return "invalid websocket upgrade";
	const connection = String(request.headers.connection ?? "").toLowerCase().split(",").map((part) => part.trim());
	if (!connection.includes("upgrade")) return "invalid websocket connection header";
	if (request.headers["sec-websocket-version"] !== "13") return "unsupported websocket version";
	const key = request.headers["sec-websocket-key"];
	if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) return "invalid sec-websocket-key";
	return undefined;
}

function webSocketRejectReason(status: number): string {
	if (status === 400) return "Bad Request";
	if (status === 403) return "Forbidden";
	if (status === 404) return "Not Found";
	return "Rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function snapshotRegisteredPdf(fileSystem: ViewerHostFileSystem, pdfPath: string): Promise<{ size: number; mtimeMs: number }> {
	let fileStatus: Awaited<ReturnType<ViewerHostFileSystem["stat"]>>;
	try {
		fileStatus = await fileSystem.stat(pdfPath);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
	if (!fileStatus.isFile()) {
		throw new ViewerHostSnapshotError("pdf_not_regular_file", "registered PDF is not a regular file");
	}
	return { size: fileStatus.size, mtimeMs: fileStatus.mtimeMs };
}

async function assertRegisteredPdfReadable(fileSystem: ViewerHostFileSystem, pdfPath: string): Promise<void> {
	let stream: Readable;
	try {
		stream = fileSystem.createReadStream(pdfPath);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
	try {
		await waitForReadablePdfOpen(stream);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
}

async function waitForReadablePdfOpen(stream: Readable): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			stream.off("open", succeed);
			stream.off("readable", succeed);
			stream.off("data", succeed);
			stream.off("end", succeed);
			stream.off("error", fail);
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const succeed = () => settle(() => {
			stream.destroy();
			resolve();
		});
		const fail = (error: Error) => settle(() => {
			stream.destroy();
			reject(error);
		});
		stream.once("open", succeed);
		stream.once("readable", succeed);
		stream.once("data", succeed);
		stream.once("end", succeed);
		stream.once("error", fail);
		stream.resume();
	});
}

function writeViewerEvent(response: ServerResponse, event: ViewerTabEvent | { type: "ready" }): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isViewerTabPayload(payload: unknown): payload is ViewerTabPayload {
	return typeof payload === "object"
		&& payload !== null
		&& Number.isInteger((payload as { pdf_id?: unknown }).pdf_id)
		&& (payload as { pdf_id: number }).pdf_id > 0
		&& Number.isInteger((payload as { revision?: unknown }).revision)
		&& (payload as { revision: number }).revision > 0
		&& typeof (payload as { viewer_url?: unknown }).viewer_url === "string"
		&& !!(payload as { viewer_url: string }).viewer_url
		&& typeof (payload as { visible_tab_token?: unknown }).visible_tab_token === "string"
		&& !!(payload as { visible_tab_token: string }).visible_tab_token;
}

function isViewerTabSelectedPayload(payload: unknown): payload is { pdf_id: number } {
	return typeof payload === "object"
		&& payload !== null
		&& Number.isInteger((payload as { pdf_id?: unknown }).pdf_id)
		&& (payload as { pdf_id: number }).pdf_id > 0;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > 1_000_000) {
			throw new Error("control request body is too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(json, "utf8"),
		"cache-control": "no-store",
	});
	response.end(json);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class ViewerHostSnapshotError extends Error {
	readonly diagnosticCode: ViewerHostPdfRefreshDiagnostic["code"];

	constructor(diagnosticCode: ViewerHostPdfRefreshDiagnostic["code"], message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ViewerHostSnapshotError";
		this.diagnosticCode = diagnosticCode;
	}
}

function diagnosticForSnapshotError(pdfId: number, error: unknown): ViewerHostPdfRefreshDiagnostic {
	return {
		pdf_id: pdfId,
		status: "error",
		code: error instanceof ViewerHostSnapshotError ? error.diagnosticCode : "pdf_not_readable",
		message: errorMessage(error),
	};
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new Error("PDF change detection timing values must be finite non-negative numbers");
	return value;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function contentTypeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".html": return "text/html; charset=utf-8";
		case ".css": return "text/css; charset=utf-8";
		case ".js":
		case ".mjs": return "text/javascript; charset=utf-8";
		case ".json": return "application/json; charset=utf-8";
		case ".svg": return "image/svg+xml";
		case ".gif": return "image/gif";
		case ".ico": return "image/x-icon";
		case ".bcmap": return "application/octet-stream";
		case ".wasm": return "application/wasm";
		case ".ttf": return "font/ttf";
		case ".pfb": return "application/octet-stream";
		case ".md": return "text/markdown; charset=utf-8";
		case ".ftl":
		case ".txt": return "text/plain; charset=utf-8";
		default: return "application/octet-stream";
	}
}

function textResponse(response: ServerResponse, status: number, contentType: string, body: string, headOnly: boolean, headers: Record<string, string> = {}): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(body, "utf8"),
		"cache-control": "no-store",
		...headers,
	});
	response.end(headOnly ? undefined : body);
}

function binaryResponse(response: ServerResponse, status: number, contentType: string, body: Buffer, headOnly: boolean): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": body.length,
		"cache-control": "no-store",
	});
	response.end(headOnly ? undefined : body);
}

function isSnapshotMatch(expected: { size: number; mtimeMs: number }, actual: { size: number; mtimeMs: number }): boolean {
	return expected.size === actual.size && expected.mtimeMs === actual.mtimeMs;
}

function contentDispositionForPdf(title: string): string {
	const filename = safePdfFilename(title.endsWith(".pdf") ? title : `${title}.pdf`);
	return `inline; filename="${asciiFallbackFilename(filename)}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

function safePdfFilename(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim() || "document.pdf";
}

function asciiFallbackFilename(value: string): string {
	return safePdfFilename(value).replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "_").trim() || "document.pdf";
}

function rfc5987Encode(value: string): string {
	return encodeURIComponent(value)
		.replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(/\*/g, "%2A");
}

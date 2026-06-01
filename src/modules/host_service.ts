import {
	accessSync,
	chmodSync,
	constants,
	lstatSync,
	mkdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";

export interface HostServiceWorkspaceContext {
	cwd: string;
	workspace_root?: string;
	session_id?: string;
}

export interface HostServiceStatusRequest {
	protocol_version: number;
	request_id: string;
	operation: "status";
	created_at_ns: number;
	workspace_context: HostServiceWorkspaceContext;
}

export interface HostServiceViewerBackendCapabilities {
	open: boolean;
	close: boolean;
	forward_search: boolean;
	inverse_search: boolean;
	reuse: boolean;
}

export interface HostServiceStatusResponseDetails {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	service_name: string;
	socket_path: string;
	service_instance_started_ns: number;
	service_instance_id: string;
	workspace_context: HostServiceWorkspaceContext;
	request_id: string;
	operation: "status";
	uptime_ns: number;
	total_requests: number;
	error_code?: string;
	viewer_backend_name?: string;
	viewer_backend_available?: boolean;
	viewer_backend_capabilities?: HostServiceViewerBackendCapabilities;
}

export interface HostServiceResponseEnvelope {
	protocol_version: number;
	request_id: string;
	operation: string;
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: HostServiceStatusResponseDetails;
}

export interface HostServiceManagedViewerRecord {
	id: number;
	pdfPath: string;
	viewerHandle: string;
	viewerBackend: string;
	viewerOwned: boolean;
	createdAtNs: number;
	metadata?: Record<string, unknown>;
}

export interface HostServiceManagedViewerRecordInput {
	pdfPath: string;
	viewerHandle: string;
	viewerBackend: string;
	viewerOwned: boolean;
	metadata?: Record<string, unknown>;
}

export interface HostServicePdfIdRegistryOptions {
	minPdfId?: number;
	maxPdfId?: number;
	makePdfId?: () => number;
	maxAllocationAttempts?: number;
}

export interface HostServiceClientOptions {
	socketPath?: string;
	requestTimeoutMs?: number;
	requestIdFactory?: () => string;
}

export interface ViewerBackendAdapter {
	readonly name: string;
	readonly capabilities: HostServiceViewerBackendCapabilities;
	isAvailable(): boolean;
}

export interface FakeViewerBackendOptions {
	name?: string;
	available?: boolean;
	capabilities?: Partial<HostServiceViewerBackendCapabilities>;
}

export interface HostServiceServerOptions {
	socketPath?: string;
	serviceName?: string;
	serviceInstanceId?: string;
	viewerBackend?: ViewerBackendAdapter;
}

const PROTOCOL_VERSION = 1;
const DEFAULT_HOST_SERVICE_SOCKET_PATH = resolve(
	process.env.XDG_RUNTIME_DIR || process.env.HOME || process.cwd(),
	"agent-synctex",
	"host-service.sock",
);
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const REQUIRED_DIRECTORY_MODE = 0o700;
const REQUIRED_SOCKET_MODE = 0o600;
const MAX_PAYLOAD_BYTES = 16_384;
const STARTUP_SOCKET_CHECK_TIMEOUT_MS = 250;
const ACTIVE_CONNECTION_TIMEOUT_MS = 10_000;
const FALLBACK_WORKSPACE_CONTEXT: HostServiceWorkspaceContext = { cwd: "/" };
export const MIN_ACTIVE_PDF_ID = 1;
export const MAX_ACTIVE_PDF_ID = 99_999_999;
const DEFAULT_MIN_ACTIVE_PDF_ID = MIN_ACTIVE_PDF_ID;
const DEFAULT_MAX_ACTIVE_PDF_ID = MAX_ACTIVE_PDF_ID;
const DEFAULT_ACTIVE_PDF_ID_ALLOCATION_ATTEMPTS = 64;

const DEFAULT_FAKE_VIEWER_BACKEND_NAME = "fake-viewer";
const DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES: HostServiceViewerBackendCapabilities = {
	open: true,
	close: true,
	forward_search: true,
	inverse_search: false,
	reuse: true,
};

function cloneCapabilities(overrides?: Partial<HostServiceViewerBackendCapabilities>): HostServiceViewerBackendCapabilities {
	return {
		open: overrides?.open ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.open,
		close: overrides?.close ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.close,
		forward_search: overrides?.forward_search ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.forward_search,
		inverse_search: overrides?.inverse_search ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.inverse_search,
		reuse: overrides?.reuse ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.reuse,
	};
}

export class FakeViewerBackend implements ViewerBackendAdapter {
	readonly name: string;
	readonly capabilities: HostServiceViewerBackendCapabilities;
	private available: boolean;

	constructor(options: FakeViewerBackendOptions = {}) {
		this.name = options.name ?? DEFAULT_FAKE_VIEWER_BACKEND_NAME;
		this.available = options.available ?? true;
		this.capabilities = cloneCapabilities(options.capabilities);
	}

	isAvailable(): boolean {
		return this.available;
	}

	setAvailable(available: boolean): void {
		this.available = available;
	}
}

export function defaultHostServiceSocketPath(): string {
	return DEFAULT_HOST_SERVICE_SOCKET_PATH;
}

export class HostServicePdfIdRegistry {
	private readonly minPdfId: number;
	private readonly maxPdfId: number;
	private readonly makePdfId: () => number;
	private readonly maxAllocationAttempts: number;
	private readonly activeRecords = new Map<number, HostServiceManagedViewerRecord>();
	private readonly staleRecords = new Map<number, HostServiceManagedViewerRecord>();
	private readonly closedRecords = new Map<number, HostServiceManagedViewerRecord>();

	constructor(options: HostServicePdfIdRegistryOptions = {}) {
		this.minPdfId = options.minPdfId ?? DEFAULT_MIN_ACTIVE_PDF_ID;
		this.maxPdfId = options.maxPdfId ?? DEFAULT_MAX_ACTIVE_PDF_ID;
		if (
			!Number.isInteger(this.minPdfId) ||
			!Number.isInteger(this.maxPdfId) ||
			this.minPdfId < MIN_ACTIVE_PDF_ID ||
			this.maxPdfId > MAX_ACTIVE_PDF_ID ||
			this.maxPdfId < this.minPdfId
		) {
			throw new Error("invalid pdf id range");
		}
		this.makePdfId = options.makePdfId ?? (() => this.minPdfId + Math.floor(Math.random() * (this.maxPdfId - this.minPdfId + 1)));
		this.maxAllocationAttempts = options.maxAllocationAttempts ?? DEFAULT_ACTIVE_PDF_ID_ALLOCATION_ATTEMPTS;
		if (!Number.isInteger(this.maxAllocationAttempts) || this.maxAllocationAttempts <= 0) {
			throw new Error("invalid maxAllocationAttempts");
		}
	}

	trackRecord(record: HostServiceManagedViewerRecordInput): HostServiceManagedViewerRecord {
		const id = this.allocatePdfId();
		const nowNs = Date.now() * 1_000_000;
		const managedRecord: HostServiceManagedViewerRecord = {
			id,
			pdfPath: record.pdfPath,
			viewerHandle: record.viewerHandle,
			viewerBackend: record.viewerBackend,
			viewerOwned: record.viewerOwned,
			createdAtNs: nowNs,
			metadata: record.metadata,
		};
		this.activeRecords.set(id, managedRecord);
		return managedRecord;
	}

	registerRecord(record: HostServiceManagedViewerRecordInput): HostServiceManagedViewerRecord {
		return this.trackRecord(record);
	}

	get activeCount(): number {
		return this.activeRecords.size;
	}

	getActiveRecord(pdfId: number): HostServiceManagedViewerRecord {
		const activeRecord = this.activeRecords.get(pdfId);
		if (activeRecord) {
			return activeRecord;
		}
		if (this.staleRecords.has(pdfId)) {
			throw new Error(`Stale pdf_id=${pdfId}: reopen this PDF record before retrying`);
		}
		if (this.closedRecords.has(pdfId)) {
			throw new Error(`Closed pdf_id=${pdfId}: this record has been removed and is no longer active`);
		}
		throw new Error(`Unknown pdf_id=${pdfId}: no active pdf record found`);
	}

	markRecordStale(pdfId: number): HostServiceManagedViewerRecord {
		const activeRecord = this.activeRecords.get(pdfId);
		if (!activeRecord) {
			this.getActiveRecord(pdfId); // throws clear, classification-rich error for non-active IDs
			throw new Error(`Unable to mark pdf_id=${pdfId} as stale`);
		}
		this.activeRecords.delete(pdfId);
		this.staleRecords.set(pdfId, activeRecord);
		return activeRecord;
	}

	removeRecord(pdfId: number): HostServiceManagedViewerRecord {
		const activeRecord = this.activeRecords.get(pdfId);
		if (activeRecord) {
			this.activeRecords.delete(pdfId);
			this.closedRecords.set(pdfId, activeRecord);
			return activeRecord;
		}
		if (this.staleRecords.has(pdfId)) {
			throw new Error(`Stale pdf_id=${pdfId}: reopen this PDF record before retrying`);
		}
		if (this.closedRecords.has(pdfId)) {
			throw new Error(`Closed pdf_id=${pdfId}: this record has been removed and is no longer active`);
		}
		throw new Error(`Unknown pdf_id=${pdfId}: no active pdf record found`);
	}

	closeRecord(pdfId: number): HostServiceManagedViewerRecord {
		return this.removeRecord(pdfId);
	}

	clear(): void {
		this.activeRecords.clear();
		this.staleRecords.clear();
	}

	private allocatePdfId(): number {
		const collisions: number[] = [];
		for (let attempt = 0; attempt < this.maxAllocationAttempts; attempt += 1) {
			const candidate = this.makePdfId();
			if (
				!Number.isInteger(candidate) ||
				candidate < MIN_ACTIVE_PDF_ID ||
				candidate > MAX_ACTIVE_PDF_ID ||
				candidate < this.minPdfId ||
				candidate > this.maxPdfId
			) {
				throw new Error(`Invalid generated pdf_id=${String(candidate)}; expected integer in ${this.minPdfId}..${this.maxPdfId}`);
			}
			if (
				this.activeRecords.has(candidate) ||
				this.staleRecords.has(candidate) ||
				this.closedRecords.has(candidate)
			) {
				collisions.push(candidate);
				continue;
			}
			return candidate;
		}
		throw new Error(`Unable to allocate unique active pdf_id after ${this.maxAllocationAttempts} attempts (collisions: ${collisions.join(", ")})`);
	}
}

export class HostServiceClient {
	private readonly socketPath: string;
	readonly requestTimeoutMs: number;
	private readonly makeRequestId: () => string;

	constructor(options: HostServiceClientOptions = {}) {
		this.socketPath = resolve(options.socketPath ?? DEFAULT_HOST_SERVICE_SOCKET_PATH);
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.makeRequestId = options.requestIdFactory ?? (() => `host-${crypto.randomUUID()}`);
	}

	async requestStatus(
		workspaceContext: HostServiceWorkspaceContext,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<HostServiceStatusResponseDetails> {
		const context = normalizeWorkspaceContext(workspaceContext);
		const requestId = this.makeRequestId();
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: requestId,
				operation: "status",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (!isValidStatusResponse(response, requestId)) {
			throw new Error(`Malformed host service status response payload: ${JSON.stringify(response)}`);
		}
		if (response.status !== "ok") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		return response.status_details;
	}

	private async request(
		request: HostServiceStatusRequest,
		signal: AbortSignal | undefined,
		requestTimeoutMs: number,
	): Promise<HostServiceResponseEnvelope> {
		if (!isValidWorkspaceContext(request.workspace_context)) {
			throw new Error("host service request requires valid workspace_context.cwd");
		}
		if (signal?.aborted) {
			throw new Error("host service request cancelled before submit");
		}
		validateHostServiceSocketDirectory(dirname(this.socketPath));

		const payload = `${JSON.stringify(request)}\n`;
		if (payload.length > MAX_PAYLOAD_BYTES) {
			throw new Error("host service request too large");
		}

		let abortUnsub: (() => void) | undefined;
		const requestPromise = new Promise<HostServiceResponseEnvelope>((resolve, reject) => {
			let settled = false;
			let raw = "";
			const finish = (value: HostServiceResponseEnvelope | Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (value instanceof Error) {
					reject(value);
				} else {
					resolve(value);
				}
			};

			const socket = createConnection({ path: this.socketPath });
			const timer = setTimeout(() => {
				finish(new Error("host service request timed out; is the host service running?"));
				socket.destroy();
			}, requestTimeoutMs);
			timer.unref?.();

			if (signal) {
				abortUnsub = () => {
					finish(new Error("host service request aborted"));
					socket.destroy();
				};
				signal.addEventListener("abort", abortUnsub, { once: true });
			}

			socket.setEncoding("utf8");
			socket.setTimeout(requestTimeoutMs, () => {
				finish(new Error("host service request timed out; is the host service running?"));
				socket.destroy();
			});

			socket.on("connect", () => {
				socket.write(payload);
			});
			socket.on("data", (chunk) => {
				raw += String(chunk);
				if (raw.length > MAX_PAYLOAD_BYTES) {
					finish(new Error("host service response too large"));
					socket.destroy();
					return;
				}
				const lineBreak = raw.indexOf("\n");
				if (lineBreak < 0) return;
				try {
					const response = parseResponse(raw.slice(0, lineBreak).trim(), request.request_id);
					finish(response);
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
				socket.destroy();
			});
			socket.once("close", () => {
				if (!settled && !raw.trim()) {
					finish(new Error("host service disconnected without response"));
				} else {
					finishIfNotSettled();
				}
			});
			socket.once("error", (error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
					finish(new Error("host service socket unavailable; is the host service running?"));
					return;
				}
				finish(error instanceof Error ? error : new Error(String(error)));
			});

			const finishIfNotSettled = () => {
				if (!settled && raw.trim()) {
					try {
						const response = parseResponse(raw.trim(), request.request_id);
						finish(response);
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				}
			};
		});

		const response = await requestPromise.finally(() => {
			if (signal && abortUnsub) {
				signal.removeEventListener("abort", abortUnsub);
			}
		});
		return response;
	}
}

export class HostServiceServer {
	readonly socketPath: string;
	readonly serviceName: string;
	private readonly protocolVersion = PROTOCOL_VERSION;
	private readonly viewerBackend: ViewerBackendAdapter;
	private server: Server | null = null;
	private startedAtNs = 0;
	private serviceInstanceId: string;
	private totalRequests = 0;
	private socketOwnedByServer = false;
	private readonly activeConnections = new Set<Socket>();

	constructor(options: HostServiceServerOptions = {}) {
		this.socketPath = resolve(options.socketPath ?? DEFAULT_HOST_SERVICE_SOCKET_PATH);
		this.serviceName = options.serviceName ?? "agent-synctex-host-service";
		this.serviceInstanceId = options.serviceInstanceId ?? `host-service-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
		this.viewerBackend = options.viewerBackend ?? new FakeViewerBackend();
	}

	async start(): Promise<void> {
		if (this.server) {
			return;
		}
		this.socketOwnedByServer = false;
		await this.prepareSocketPath();
		this.startedAtNs = Date.now() * 1_000_000;
		const server = createServer((socket) => {
			this.handleConnection(socket);
		});
		this.server = server;

		await new Promise<void>((resolve, reject) => {
			const finalizeError = (error: Error) => {
				if (this.server === server) {
					this.server = null;
				}
				reject(error);
			};
			server.once("error", finalizeError);
			server.listen(this.socketPath, () => {
				try {
					chmodSync(this.socketPath, REQUIRED_SOCKET_MODE);
					this.socketOwnedByServer = true;
					resolve();
				} catch (error) {
					this.server = null;
					finalizeError(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		for (const socket of this.activeConnections) {
			socket.destroy();
		}
		if (!server) {
			this.removeSocketPath();
			return;
		}

		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		this.removeSocketPath();
	}

	private handleConnection(socket: Socket): void {
		this.activeConnections.add(socket);
		socket.setEncoding("utf8");
		socket.setTimeout(ACTIVE_CONNECTION_TIMEOUT_MS, () => {
			socket.destroy();
		});
		let raw = "";
		const handleData = (chunk: string | Buffer) => {
			raw += String(chunk);
			if (raw.length > MAX_PAYLOAD_BYTES) {
				socket.end(buildErrorResponse(this.protocolVersion, this.socketPath, this.serviceName, this.serviceInstanceId, "", "request too large", "invalid_request"));
				socket.destroy();
				return;
			}
			const lineBreak = raw.indexOf("\n");
			if (lineBreak < 0) {
				return;
			}
			socket.off("data", handleData);
			socket.removeAllListeners("timeout");
			this.respondToRequest(raw.slice(0, lineBreak).trim(), socket);
		};
		socket.on("data", handleData);
		socket.once("close", () => {
			this.activeConnections.delete(socket);
		});
		socket.on("error", () => {
			socket.destroy();
		});
	}

	private respondToRequest(raw: string, socket: Socket): void {
		let requestPayload: unknown;
		let request: HostServiceStatusRequest;
		try {
			requestPayload = parseRequest(raw);
			request = validateStatusRequest(requestPayload);
		} catch (error) {
			const requestId = getRequestIdFromPayload(requestPayload);
			socket.end(buildErrorResponse(
				this.protocolVersion,
				this.socketPath,
				this.serviceName,
				this.serviceInstanceId,
				requestId,
				error instanceof Error ? error.message : String(error),
				"invalid_request",
			));
			return;
		}

		if (request.operation !== "status") {
			socket.end(buildErrorResponse(
				this.protocolVersion,
				this.socketPath,
				this.serviceName,
				this.serviceInstanceId,
				request.request_id,
				`unsupported operation: ${request.operation}`,
				"unsupported_operation",
			));
			return;
		}

		this.totalRequests += 1;
		const nowNs = Date.now() * 1_000_000;
		const viewerBackendAvailable = this.viewerBackend.isAvailable();
		const response: HostServiceResponseEnvelope = {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: request.operation,
			status: "ok",
			generated_at_ns: nowNs,
			status_details: {
				protocol_version: this.protocolVersion,
				supported: true,
				service_available: viewerBackendAvailable,
				service_name: this.serviceName,
				socket_path: this.socketPath,
				service_instance_started_ns: this.startedAtNs,
				service_instance_id: this.serviceInstanceId,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: request.operation,
				uptime_ns: nowNs - this.startedAtNs,
				total_requests: this.totalRequests,
				viewer_backend_name: this.viewerBackend.name,
				viewer_backend_available: viewerBackendAvailable,
				viewer_backend_capabilities: this.viewerBackend.capabilities,
			},
		};
		socket.end(`${JSON.stringify(response)}\n`);
	}

	private async prepareSocketPath(): Promise<void> {
		const baseDir = dirname(this.socketPath);
		ensureDirectory(baseDir);
		let existing: ReturnType<typeof lstatSync>;
		try {
			existing = lstatSync(this.socketPath);
		} catch (error) {
			if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		if (existing.isSymbolicLink()) {
			throw new Error(`host service socket path is a symlink: ${this.socketPath}`);
		}
		if (!existing.isSocket()) {
			throw new Error(`host service socket path has unsupported file type: ${this.socketPath}`);
		}

		const socketProbeResult = await isSocketPathSafeToReclaim(this.socketPath);
		if (!socketCanBeReclaimable(socketProbeResult)) {
			throw new Error(`host service socket path is already in use by a running service: ${this.socketPath}`);
		}
		rmSync(this.socketPath, { force: true });
	}

	private removeSocketPath(): void {
		if (!this.socketOwnedByServer) {
			return;
		}
		try {
			const st = lstatSync(this.socketPath);
			if (st.isSocket()) {
				rmSync(this.socketPath, { force: true });
			}
		} catch (error) {
			if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		} finally {
			this.socketOwnedByServer = false;
			this.activeConnections.clear();
		}
	}
}

function socketCanBeReclaimable(result: SocketProbeResult): result is "stale" {
	return result === "stale";
}

function isValidWorkspaceContext(value: unknown): value is HostServiceWorkspaceContext {
	if (!isStringRecord(value)) return false;
	if (typeof value.cwd !== "string" || !value.cwd.trim()) return false;
	if (value.workspace_root !== undefined && typeof value.workspace_root !== "string") return false;
	if (value.session_id !== undefined && typeof value.session_id !== "string") return false;
	return true;
}

function normalizeWorkspaceContext(context: HostServiceWorkspaceContext): HostServiceWorkspaceContext {
	if (!isValidWorkspaceContext(context)) {
		throw new Error("invalid workspace_context; cwd is required");
	}
	return {
		cwd: context.cwd,
		workspace_root: context.workspace_root,
		session_id: context.session_id,
	};
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseRequest(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("Malformed host service request payload");
	}
}

function getRequestIdFromPayload(payload: unknown): string {
	if (isStringRecord(payload) && typeof payload.request_id === "string") {
		return payload.request_id;
	}
	return "";
}

function parseResponse(raw: string, expectedRequestId: string): HostServiceResponseEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Malformed host service response payload: ${raw}`);
	}
	if (!isValidStatusResponse(parsed, expectedRequestId)) {
		throw new Error(`Malformed host service response payload: ${raw}`);
	}
	return parsed;
}

function validateStatusRequest(value: unknown): HostServiceStatusRequest {
	if (!isStringRecord(value)) {
		throw new Error("invalid request payload");
	}
	if (value.protocol_version !== PROTOCOL_VERSION) {
		throw new Error("unsupported protocol version");
	}
	if (typeof value.request_id !== "string" || !value.request_id.trim()) {
		throw new Error("missing request_id");
	}
	if (value.operation !== "status") {
		throw new Error(`unsupported operation: ${String(value.operation)}`);
	}
	if (typeof value.created_at_ns !== "number") {
		throw new Error("missing created_at_ns");
	}
	if (!isValidWorkspaceContext(value.workspace_context)) {
		throw new Error("invalid workspace_context");
	}
	return {
		protocol_version: PROTOCOL_VERSION,
		request_id: value.request_id,
		operation: "status",
		created_at_ns: value.created_at_ns,
		workspace_context: value.workspace_context,
	};
}

function isValidStatusResponse(response: unknown, expectedRequestId: string): response is HostServiceResponseEnvelope {
	if (!isStringRecord(response)) {
		return false;
	}
	if (typeof response.protocol_version !== "number" || response.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof response.request_id !== "string" || response.request_id !== expectedRequestId) {
		return false;
	}
	if (response.status !== "ok" && response.status !== "error") {
		return false;
	}
	if (response.operation !== "status") {
		return false;
	}
	if (typeof response.generated_at_ns !== "number") {
		return false;
	}
	if (response.error !== undefined && typeof response.error !== "string") {
		return false;
	}
	const details = response.status_details;
	if (!isStringRecord(details)) {
		return false;
	}
	if (typeof details.protocol_version !== "number" || details.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof details.supported !== "boolean") {
		return false;
	}
	if (typeof details.service_available !== "boolean") {
		return false;
	}
	if (typeof details.service_name !== "string" || !details.service_name) {
		return false;
	}
	if (typeof details.socket_path !== "string" || !details.socket_path) {
		return false;
	}
	if (typeof details.service_instance_started_ns !== "number") {
		return false;
	}
	if (typeof details.service_instance_id !== "string" || !details.service_instance_id) {
		return false;
	}
	if (!isValidWorkspaceContext(details.workspace_context)) {
		return false;
	}
	if (typeof details.request_id !== "string" || details.request_id !== expectedRequestId) {
		return false;
	}
	if (details.operation !== "status") {
		return false;
	}
	if (typeof details.uptime_ns !== "number") {
		return false;
	}
	if (typeof details.total_requests !== "number") {
		return false;
	}
	if (details.error_code !== undefined && typeof details.error_code !== "string") {
		return false;
	}
	if (details.viewer_backend_name !== undefined && typeof details.viewer_backend_name !== "string") {
		return false;
	}
	if (details.viewer_backend_available !== undefined && typeof details.viewer_backend_available !== "boolean") {
		return false;
	}
	if (details.viewer_backend_capabilities !== undefined && !isValidViewerBackendCapabilities(details.viewer_backend_capabilities)) {
		return false;
	}
	if (response.status === "error" && response.error === undefined) {
		return false;
	}
	return true;
}

function isValidViewerBackendCapabilities(value: unknown): value is HostServiceViewerBackendCapabilities {
	if (!isStringRecord(value)) {
		return false;
	}
	return (
		typeof value.open === "boolean"
		&& typeof value.close === "boolean"
		&& typeof value.forward_search === "boolean"
		&& typeof value.inverse_search === "boolean"
		&& typeof value.reuse === "boolean"
	);
}

function buildErrorResponse(
	protocolVersion: number,
	socketPath: string,
	serviceName: string,
	serviceInstanceId: string,
	requestId: string,
	errorText: string,
	errorCode: string,
): string {
	const nowNs = Date.now() * 1_000_000;
	const response: HostServiceResponseEnvelope = {
		protocol_version: protocolVersion,
		request_id: requestId,
		operation: "status",
		status: "error",
		generated_at_ns: nowNs,
		error: errorText,
		status_details: {
			protocol_version: protocolVersion,
			supported: false,
			service_available: false,
			service_name: serviceName,
			socket_path: socketPath,
			service_instance_started_ns: nowNs,
			service_instance_id: serviceInstanceId,
			workspace_context: FALLBACK_WORKSPACE_CONTEXT,
			request_id: requestId,
			operation: "status",
			uptime_ns: 0,
			total_requests: 0,
			error_code: errorCode,
		},
	};
	return `${JSON.stringify(response)}\n`;
}

function ensureDirectory(path: string): void {
	try {
		lstatSync(path);
		assertDirectorySafe(path);
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			mkdirSync(path, { recursive: true, mode: REQUIRED_DIRECTORY_MODE });
			chmodSync(path, REQUIRED_DIRECTORY_MODE);
			assertDirectorySafe(path);
			return;
		}
		throw error;
	}
}

function assertDirectorySafe(path: string): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) {
		throw new Error(`host service path is a symlink: ${path}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`host service path is not a directory: ${path}`);
	}
	if (process.getuid?.() !== undefined && st.uid !== process.getuid()) {
		throw new Error(`host service path is not owned by current user: ${path}`);
	}
	if ((st.mode & 0o777) !== REQUIRED_DIRECTORY_MODE) {
		chmodSync(path, REQUIRED_DIRECTORY_MODE);
	}
	if ((statSync(path).mode & 0o777) !== REQUIRED_DIRECTORY_MODE) {
		throw new Error(`host service path mode check failed after correction: ${path}`);
	}
}

function validateHostServiceSocketDirectory(dir: string): void {
	assertDirectorySafe(dir);
	// directory read/write/execute check is enforced by accessSync to guarantee current user visibility.
	accessSync(dir, constants.F_OK | constants.R_OK | constants.W_OK | constants.X_OK);
}

type SocketProbeResult = "stale" | "in_use";

async function isSocketPathSafeToReclaim(socketPath: string): Promise<SocketProbeResult> {
	return new Promise<SocketProbeResult>((resolve, reject) => {
		let settled = false;
		const resolveIfUnsettled = (result: SocketProbeResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const rejectIfUnsettled = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		const socket = createConnection({ path: socketPath });
		const timer = setTimeout(() => {
			rejectIfUnsettled(new Error(`host service socket path probe timed out: ${socketPath}`));
			socket.destroy();
		}, STARTUP_SOCKET_CHECK_TIMEOUT_MS);
		timer.unref?.();
		socket.once("connect", () => {
			resolveIfUnsettled("in_use");
			socket.destroy();
		});
		socket.once("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ECONNREFUSED") {
				resolveIfUnsettled("stale");
				return;
			}
			if (code) {
				rejectIfUnsettled(new Error(`host service socket path is not safe to replace (${code}): ${socketPath}`));
				return;
			}
			rejectIfUnsettled(new Error(`host service socket path probe failed for unknown reason: ${socketPath}`));
		});
		socket.once("close", () => {
			if (!settled) {
				rejectIfUnsettled(new Error(`host service socket path probe closed before verdict: ${socketPath}`));
			}
		});
	});
}

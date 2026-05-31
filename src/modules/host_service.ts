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

export interface HostServiceClientOptions {
	socketPath?: string;
	requestTimeoutMs?: number;
	requestIdFactory?: () => string;
}

export interface HostServiceServerOptions {
	socketPath?: string;
	serviceName?: string;
	serviceInstanceId?: string;
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

export function defaultHostServiceSocketPath(): string {
	return DEFAULT_HOST_SERVICE_SOCKET_PATH;
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
		const response = await this.request(
			{
				protocol_version: PROTOCOL_VERSION,
				request_id: this.makeRequestId(),
				operation: "status",
				created_at_ns: Date.now() * 1_000_000,
				workspace_context: context,
			},
			signal,
			requestTimeoutMs ?? this.requestTimeoutMs,
		);
		if (response.status !== "ok") {
			const suffix = response.status_details.error_code ? ` (code=${response.status_details.error_code})` : "";
			throw new Error(`${response.error || "host service returned error status"}${suffix}`);
		}
		if (!isValidStatusResponse(response)) {
			throw new Error(`Malformed host service status response payload: ${JSON.stringify(response)}`);
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
					const response = parseResponse(raw.slice(0, lineBreak).trim());
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
						const response = parseResponse(raw.trim());
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
		let request: HostServiceStatusRequest;
		try {
			request = validateStatusRequest(parseRequest(raw));
		} catch (error) {
			socket.end(buildErrorResponse(
				this.protocolVersion,
				this.socketPath,
				this.serviceName,
				this.serviceInstanceId,
				"",
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
		const response: HostServiceResponseEnvelope = {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: request.operation,
			status: "ok",
			generated_at_ns: nowNs,
			status_details: {
				protocol_version: this.protocolVersion,
				supported: true,
				service_available: true,
				service_name: this.serviceName,
				socket_path: this.socketPath,
				service_instance_started_ns: this.startedAtNs,
				service_instance_id: this.serviceInstanceId,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: request.operation,
				uptime_ns: nowNs - this.startedAtNs,
				total_requests: this.totalRequests,
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

function parseResponse(raw: string): HostServiceResponseEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Malformed host service response payload: ${raw}`);
	}
	if (!isValidStatusResponse(parsed)) {
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

function isValidStatusResponse(response: unknown): response is HostServiceResponseEnvelope {
	if (!isStringRecord(response)) {
		return false;
	}
	if (typeof response.protocol_version !== "number" || response.protocol_version !== PROTOCOL_VERSION) {
		return false;
	}
	if (typeof response.request_id !== "string") {
		return false;
	}
	if (response.status !== "ok" && response.status !== "error") {
		return false;
	}
	if (typeof response.operation !== "string" || !response.operation) {
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
	if (typeof details.protocol_version !== "number") {
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
	if (typeof details.service_instance_id !== "string") {
		return false;
	}
	if (!isValidWorkspaceContext(details.workspace_context)) {
		return false;
	}
	if (typeof details.request_id !== "string") {
		return false;
	}
	if (details.operation !== response.operation) {
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
	const isError = response.status === "error";
	if (!isError && response.request_id.trim().length === 0) {
		return false;
	}
	if (!isError && !details.request_id.trim()) {
		return false;
	}
	if (!isError && !details.service_instance_id) {
		return false;
	}
	if (isError && response.error === undefined) {
		return false;
	}
	return true;
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

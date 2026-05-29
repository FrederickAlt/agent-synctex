import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	renameSync,
	statSync,
	chmodSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ViewerServiceBackendInfo {
	name: string;
	available: boolean;
	path?: string;
}

export interface ViewerServiceProtocolDirectories {
	base: string;
	requests: string;
	results: string;
	state: string;
}

export interface ViewerServiceDiagnostics {
	log_tail: string;
	recent_events: string[];
}

export interface SynctexCallbackConfig {
	kind: "pi-synctex-callback-v1";
	transport: "unix";
	socket_path: string;
	token: string;
}

export interface ViewerServiceOpenCapabilities {
	open: boolean;
	close: boolean;
	forward_search: boolean;
	inverse_search: boolean;
	reuse: boolean;
}

export interface ViewerServiceStatus {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	backend: ViewerServiceBackendInfo;
	protocol_directories: ViewerServiceProtocolDirectories;
	diagnostics: ViewerServiceDiagnostics;
	service_instance_started_ns: number;
	request_id: string;
	operation: string;
}

interface ViewerServiceOpenResultBase {
	protocol_version: number;
	supported: boolean;
	service_available: boolean;
	backend: string;
	capabilities: ViewerServiceOpenCapabilities;
	owned: boolean;
	reused: boolean;
	handle?: string;
	pid?: number;
	pid_diagnostic?: string;
	protocol_directories: ViewerServiceProtocolDirectories;
	service_instance_started_ns: number;
	request_id: string;
	operation: string;
	error_code?: string;
}

export interface ViewerServiceOpenResult extends ViewerServiceOpenResultBase {
	handle: string;
}

export interface ViewerServiceResultEnvelope {
	protocol_version: number;
	request_id: string;
	operation: string;
	status: "ok" | "error";
	generated_at_ns: number;
	error?: string;
	status_details: ViewerServiceStatus | ViewerServiceOpenResultBase;
}

export interface ViewerServiceOpenRequestDetails {
	pdf_path: string;
	callback: SynctexCallbackConfig;
	reuse_existing?: boolean;
	require_persistent_viewer?: boolean;
}

export interface ViewerServiceRequest {
	protocol_version: number;
	request_id: string;
	operation: string;
	created_at_ns: number;
	details?: Record<string, unknown>;
}

export interface ViewerServiceClientOptions {
	requestTimeoutMs?: number;
	pollIntervalMs?: number;
	requestIdFactory?: () => string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const REQUIRED_FILE_MODE = 0o600;
const REQUIRED_DIRECTORY_MODE = 0o700;

function atomicWriteJson(path: string, value: unknown): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: REQUIRED_DIRECTORY_MODE });
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
	const payload = `${JSON.stringify(value)}\n`;
	try {
		writeFileSync(tmp, payload, { encoding: "utf8", mode: REQUIRED_FILE_MODE, flag: "wx" });
		renameSync(tmp, path);
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
	}
}

function safeUnlink(path: string): void {
	rmSync(path, { force: true });
}

function assertOwnedAndSecureDir(path: string, label: string): void {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(path);
	} catch (error) {
		throw new Error(`viewer service ${label} directory does not exist: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (st.isSymbolicLink()) {
		throw new Error(`viewer service ${label} directory is a symlink: ${path}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`viewer service ${label} directory is not a directory: ${path}`);
	}

	const uid = process.getuid?.();
	if (uid === undefined || st.uid !== uid) {
		throw new Error(`viewer service ${label} directory is not owned by current user: ${path}`);
	}
	if ((st.mode & 0o777) !== REQUIRED_DIRECTORY_MODE) {
		chmodSync(path, REQUIRED_DIRECTORY_MODE);
	}

	const hardened = statSync(path).mode & 0o777;
	if (hardened !== REQUIRED_DIRECTORY_MODE) {
		throw new Error(`viewer service ${label} directory mode check failed after correction: ${path}`);
	}
}

function ensureDirectory(path: string, label: string): void {
	try {
		lstatSync(path);
		assertOwnedAndSecureDir(path, label);
		return;
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			mkdirSync(path, { recursive: true, mode: REQUIRED_DIRECTORY_MODE });
			chmodSync(path, REQUIRED_DIRECTORY_MODE);
			assertOwnedAndSecureDir(path, label);
			return;
		}
		throw error;
	}
}

export class ViewerServiceClient {
	private readonly protocolVersion = 1;
	private readonly requestDir: string;
	private readonly resultDir: string;
	private readonly stateFile: string;
	private readonly tmpDir: string;
	readonly requestTimeoutMs: number;
	readonly pollIntervalMs: number;
	private readonly makeRequestId: () => string;

	constructor(tmpDir: string, options: ViewerServiceClientOptions = {}) {
		this.tmpDir = tmpDir;
		this.requestDir = resolve(tmpDir, "viewer-requests");
		this.resultDir = resolve(tmpDir, "viewer-results");
		this.stateFile = resolve(tmpDir, "viewer-state.json");
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.makeRequestId = options.requestIdFactory ?? (() => `viewer-${crypto.randomUUID()}`);
	}

	async requestStatus(signal?: AbortSignal, requestTimeoutMs?: number): Promise<ViewerServiceStatus> {
		const timeoutMs = requestTimeoutMs ?? this.requestTimeoutMs;
		const result = await this.request("status", {}, signal, timeoutMs);
		if (result.status !== "ok") {
			throw new Error(result.error || "viewer service returned error status");
		}
		return result.status_details as ViewerServiceStatus;
	}

	async requestOpenPdf(
		pdfPath: string,
		callback: SynctexCallbackConfig,
		options: { reuseExisting?: boolean; requirePersistentViewer?: boolean } = {},
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<ViewerServiceOpenResult> {
		const timeoutMs = requestTimeoutMs ?? this.requestTimeoutMs;
		const result = await this.request(
			"open",
			{
				pdf_path: pdfPath,
				callback,
				reuse_existing: options.reuseExisting ?? true,
				require_persistent_viewer: options.requirePersistentViewer ?? false,
			},
			signal,
			timeoutMs,
		);
		if (result.status !== "ok") {
			const errorCode = "error_code" in result.status_details && typeof result.status_details.error_code === "string"
				? result.status_details.error_code
				: undefined;
			const suffix = errorCode ? ` (code=${errorCode})` : "";
			throw new Error(`${result.error || "viewer service returned error status"}${suffix}`);
		}
		const openResult = result.status_details;
		if (!isValidOpenResult(openResult)) {
			throw new Error("viewer service open response malformed");
		}
		if (typeof openResult.handle !== "string" || !openResult.handle) {
			throw new Error("viewer service open response missing handle");
		}
		return openResult as ViewerServiceOpenResult;
	}

	private async request(
		operation: string,
		payload: Record<string, unknown>,
		signal: AbortSignal | undefined,
		requestTimeoutMs: number,
	): Promise<ViewerServiceResultEnvelope> {
		this.ensureDirectories();
		this.verifyAccess();
		if (signal?.aborted) {
			throw new Error("viewer service request cancelled before submit");
		}

		const requestId = this.makeRequestId();
		if (!isValidRequestId(requestId)) {
			throw new Error(`viewer service generated invalid request id: ${requestId}`);
		}
		const requestPath = this.requestPath(requestId);
		const resultPath = this.resultPath(requestId);
		safeUnlink(resultPath);

		let abortError: Error | null = null;
		const onAbort = () => {
			abortError = new Error("viewer service request aborted");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			this.writeRequest(
				requestPath,
				{
					protocol_version: this.protocolVersion,
					request_id: requestId,
					operation,
					created_at_ns: Date.now() * 1_000_000,
					details: payload,
				},
			);
			return await this.waitForMatchingResult(requestId, operation, resultPath, signal, requestTimeoutMs);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.cleanup(requestPath, resultPath);
			if (abortError) {
				throw abortError;
			}
		}
	}

	private async waitForMatchingResult(
		requestId: string,
		operation: string,
		sentResultPath: string,
		signal: AbortSignal | undefined,
		requestTimeoutMs: number,
	): Promise<ViewerServiceResultEnvelope> {
		const deadline = Date.now() + requestTimeoutMs;
		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new Error("viewer service request aborted");
			}
			const response = this.tryReadResult(sentResultPath);
			if (response) {
				if (response.request_id !== requestId) {
					throw new Error(
						`viewer service result id mismatch (expected ${requestId}, got ${response.request_id})`,
					);
				}
				if (response.operation !== operation) {
					throw new Error(
						`viewer service result operation mismatch (expected ${operation}, got ${response.operation})`,
					);
				}
				if (response.protocol_version !== this.protocolVersion) {
					throw new Error(`viewer service protocol version mismatch: ${response.protocol_version}`);
				}
				return response;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
		}
		throw new Error("viewer service request timed out; is the viewer service running?");
	}

	private tryReadResult(path: string): ViewerServiceResultEnvelope | null {
		let raw: string;
		try {
			const st = lstatSync(path);
			if (!st.isFile() || (st.mode & 0o777) !== REQUIRED_FILE_MODE) {
				return null;
			}
			raw = readFileSync(path, "utf8").trim();
		} catch {
			return null;
		}
		if (!raw) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`Malformed viewer service result payload: ${raw}`);
		}
		if (!isValidResult(parsed)) {
			throw new Error(`Malformed viewer service result payload: ${raw}`);
		}
		return parsed;
	}

	private writeRequest(path: string, request: ViewerServiceRequest): void {
		atomicWriteJson(path, request);
	}

	private verifyAccess(): void {
		try {
			accessSync(this.requestDir, constants.F_OK | constants.R_OK | constants.W_OK);
			accessSync(this.resultDir, constants.F_OK | constants.R_OK | constants.W_OK);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`viewer service path not accessible: ${message}`);
		}
	}

	private assertProtocolDirectoriesSecure(): void {
		assertOwnedAndSecureDir(this.tmpDir, "base");
		assertOwnedAndSecureDir(this.requestDir, "request");
		assertOwnedAndSecureDir(this.resultDir, "result");
	}

	private cleanup(requestPath: string, resultPath: string): void {
		safeUnlink(requestPath);
		safeUnlink(resultPath);
	}

	private ensureDirectories(): void {
		ensureDirectory(this.tmpDir, "base");
		ensureDirectory(this.requestDir, "request");
		ensureDirectory(this.resultDir, "result");
		if (!existsSync(dirname(this.stateFile))) {
			mkdirSync(dirname(this.stateFile), { recursive: true, mode: REQUIRED_DIRECTORY_MODE });
		}
		assertOwnedAndSecureDir(dirname(this.stateFile), "state");
		this.assertProtocolDirectoriesSecure();
	}

	private requestPath(requestId: string): string {
		return join(this.requestDir, `${requestId}.json`);
	}

	private resultPath(requestId: string): string {
		return join(this.resultDir, `${requestId}.json`);
	}
}

function isValidRequestId(requestId: unknown): requestId is string {
	return typeof requestId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(requestId);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isValidOpenResult(details: unknown): details is ViewerServiceOpenResultBase & Record<string, unknown> {
	if (!isStringRecord(details)) return false;
	if (!isStringRecord(details.protocol_directories)) return false;
	const protocolDirectories = details.protocol_directories;
	if (typeof protocolDirectories.base !== "string") return false;
	if (typeof protocolDirectories.requests !== "string") return false;
	if (typeof protocolDirectories.results !== "string") return false;
	if (typeof protocolDirectories.state !== "string") return false;
	if (typeof details.service_instance_started_ns !== "number") return false;
	if (!isValidRequestId(details.request_id)) return false;
	if (typeof details.operation !== "string" || !details.operation) return false;
	if (typeof details.protocol_version !== "number") return false;
	if (typeof details.supported !== "boolean") return false;
	if (typeof details.service_available !== "boolean") return false;
	if (typeof details.backend !== "string" || !details.backend) return false;
	if (!isStringRecord(details.capabilities)) return false;
	const capabilities = details.capabilities;
	if (typeof capabilities.open !== "boolean") return false;
	if (typeof capabilities.close !== "boolean") return false;
	if (typeof capabilities.forward_search !== "boolean") return false;
	if (typeof capabilities.inverse_search !== "boolean") return false;
	if (typeof capabilities.reuse !== "boolean") return false;
	if (typeof details.owned !== "boolean") return false;
	if (typeof details.reused !== "boolean") return false;
	if (details.handle !== undefined && (typeof details.handle !== "string" || !details.handle)) return false;
	if (details.pid !== undefined && typeof details.pid !== "number") return false;
	if (details.pid_diagnostic !== undefined && typeof details.pid_diagnostic !== "string") return false;
	if (details.error_code !== undefined && typeof details.error_code !== "string") return false;
	return true;
}

function isValidStatusResult(details: unknown): details is ViewerServiceStatus & Record<string, unknown> {
	if (!isStringRecord(details)) return false;
	if (typeof details.protocol_version !== "number") return false;
	if (typeof details.service_instance_started_ns !== "number") return false;
	if (!isValidRequestId(details.request_id)) return false;
	if (typeof details.operation !== "string" || !details.operation) return false;
	if (typeof details.supported !== "boolean") return false;
	if (typeof details.service_available !== "boolean") return false;
	if (!isStringRecord(details.backend)) return false;
	const backend = details.backend;
	if (typeof backend.name !== "string" || !backend.name) return false;
	if (typeof backend.available !== "boolean") return false;
	if (backend.path !== undefined && typeof backend.path !== "string") return false;
	if (!isStringRecord(details.protocol_directories)) return false;
	const protocolDirectories = details.protocol_directories;
	if (typeof protocolDirectories.base !== "string") return false;
	if (typeof protocolDirectories.requests !== "string") return false;
	if (typeof protocolDirectories.results !== "string") return false;
	if (typeof protocolDirectories.state !== "string") return false;
	if (!isStringRecord(details.diagnostics)) return false;
	const diagnostics = details.diagnostics;
	if (typeof diagnostics.log_tail !== "string") return false;
	if (!Array.isArray(diagnostics.recent_events)) return false;
	if (!diagnostics.recent_events.every((event) => typeof event === "string")) return false;
	return true;
}

function isValidResult(value: unknown): value is ViewerServiceResultEnvelope {
	if (!isStringRecord(value)) return false;
	const candidate = value;
	if (typeof candidate.protocol_version !== "number") return false;
	if (!isValidRequestId(candidate.request_id)) return false;
	if (typeof candidate.operation !== "string" || !candidate.operation) return false;
	if (candidate.status !== "ok" && candidate.status !== "error") return false;
	if (typeof candidate.generated_at_ns !== "number") return false;
	if (!isStringRecord(candidate.status_details)) return false;
	const details = candidate.status_details;
	if (candidate.operation === "open") {
		return isValidOpenResult(details);
	}
	return isValidStatusResult(details);
}

export function viewerServiceRequestPath(baseDir: string, requestId: string): string {
	return join(resolve(baseDir), "viewer-requests", `${requestId}.json`);
}

export function viewerServiceResultPath(baseDir: string, requestId: string): string {
	return join(resolve(baseDir), "viewer-results", `${requestId}.json`);
}

export function viewerServiceStatePath(baseDir: string): string {
	return join(resolve(baseDir), "viewer-state.json");
}

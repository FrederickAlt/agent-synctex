import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	readSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
	createSynctexCallbackCommand,
	type SynctexCallbackConfig,
} from "./synctex/synctex.ts";
import type {
	HostServiceCallbackTarget,
	HostServiceViewerBackendCapabilities,
} from "./host_service.ts";

export interface ViewerBackendOperationResult<T extends Record<string, unknown> = Record<string, unknown>> {
	status: "ok" | "error";
	error?: string;
	status_details: T;
}

export interface ViewerBackendAdapter {
	readonly name: string;
	readonly capabilities: HostServiceViewerBackendCapabilities;
	isAvailable(): boolean;
	status(requestId: string, operation: string): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	open(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	close(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	forwardSearch(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	closeAll(requestId?: string): Promise<void>;
}

const PROTOCOL_VERSION = 1;
const DEFAULT_FAKE_VIEWER_BACKEND_NAME = "fake-viewer";
const BACKEND_NAME = "zathura";
const MIN_OPEN_HEADER_BYTES = 5;
const VIEWER_BACKEND_PATH_ENV = "ZATHURA_VIEWER_PATH";
const NODE_PATH_FALLBACK = "/usr/bin/node";
const SYNCTEX_CALLBACK_KIND: SynctexCallbackConfig["kind"] = "pi-synctex-callback-v1";
const SYNCTEX_CALLBACK_TRANSPORT: SynctexCallbackConfig["transport"] = "unix";

const DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES: HostServiceViewerBackendCapabilities = {
	open: true,
	close: true,
	forward_search: true,
	inverse_search: false,
	reuse: true,
};

const ZATHURA_VIEWER_BACKEND_CAPABILITIES: HostServiceViewerBackendCapabilities = cloneCapabilities({
	inverse_search: true,
});

interface ProcessIdentity {
	comm?: string;
	start_time?: number;
	exe?: string;
	cmdline?: string[];
}

interface ZathuraSession {
	pdfPath: string;
	handle: string;
	backendPath: string;
	callback: HostServiceCallbackTarget;
	pid: number;
	owned: boolean;
	process?: ChildProcess;
	identity?: ProcessIdentity;
}

function cloneCapabilities(overrides?: Partial<HostServiceViewerBackendCapabilities>): HostServiceViewerBackendCapabilities {
	return {
		open: overrides?.open ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.open,
		close: overrides?.close ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.close,
		forward_search: overrides?.forward_search ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.forward_search,
		inverse_search: overrides?.inverse_search ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.inverse_search,
		reuse: overrides?.reuse ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES.reuse,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number";
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function normalizeCallback(callback: unknown): HostServiceCallbackTarget | undefined {
	if (!isRecord(callback)) return;
	const kind = callback.kind;
	const transport = callback.transport;
	const socketPath = callback.socket_path;
	const token = callback.token;
	if (kind !== SYNCTEX_CALLBACK_KIND || transport !== SYNCTEX_CALLBACK_TRANSPORT) return;
	if (!isString(socketPath) || !socketPath) return;
	if (!isString(token) || !token) return;
	return {
		kind,
		transport,
		socket_path: socketPath,
		token,
	};
}

function callbackKey(callback: HostServiceCallbackTarget): string {
	return `${callback.kind}|${callback.transport}|${callback.socket_path}|${callback.token}`;
}

function defaultCallbackScriptPath(): string {
	return resolve(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"scripts",
		"pi_synctex_callback.mjs",
	);
}

function defaultNodePath(): string {
	return process.execPath ?? NODE_PATH_FALLBACK;
}

function validateOpenRequest(details: Record<string, unknown>): string | undefined {
	if (!isString(details.pdf_path) || !details.pdf_path.trim()) {
		return "missing or invalid pdf_path";
	}
	if (normalizeCallback(details.callback) === undefined) {
		return "missing or invalid callback";
	}
	if (details.reuse_existing !== undefined && !isBoolean(details.reuse_existing)) {
		return "reuse_existing must be a boolean";
	}
	if (details.require_persistent_viewer !== undefined && !isBoolean(details.require_persistent_viewer)) {
		return "require_persistent_viewer must be a boolean";
	}
	return;
}

function validateCloseRequest(details: Record<string, unknown>): string | undefined {
	if (!isString(details.handle) || !details.handle) {
		return "missing or invalid handle";
	}
	if (!isString(details.backend) || !details.backend) {
		return "missing or invalid backend";
	}
	return;
}

function validateForwardRequest(details: Record<string, unknown>): string | undefined {
	if (!isString(details.handle) || !details.handle) {
		return "missing or invalid handle";
	}
	if (!isString(details.backend) || !details.backend) {
		return "missing or invalid backend";
	}
	if (!isString(details.source_file) || !details.source_file) {
		return "missing or invalid source_file";
	}
	if (!isNumber(details.line) || !Number.isInteger(details.line) || details.line < 1) {
		return "line must be a positive integer";
	}
	if (details.synctex_pid !== undefined && (!isNumber(details.synctex_pid) || !Number.isInteger(details.synctex_pid) || details.synctex_pid < 1)) {
		return "invalid synctex_pid";
	}
	return;
}

function openAndValidatePdf(rawPdfPath: string): { normalizedPath: string; error?: string } {
	const normalizedPath = resolve(rawPdfPath);
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	let fd: number | undefined;
	try {
		fd = openSync(normalizedPath, flags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			return { normalizedPath, error: "pdf_path must not be a symlink" };
		}
		return { normalizedPath, error: `cannot open pdf_path: ${normalizedPath}` };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			return { normalizedPath, error: `pdf_path must be a regular file: ${normalizedPath}` };
		}
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
			return { normalizedPath, error: `pdf_path is not owned by current user: ${normalizedPath}` };
		}
		const header = Buffer.alloc(MIN_OPEN_HEADER_BYTES);
		const bytesRead = readSync(fd, header, 0, MIN_OPEN_HEADER_BYTES, 0);
		if (bytesRead < MIN_OPEN_HEADER_BYTES || header.toString("utf8") !== "%PDF-") {
			return { normalizedPath, error: `pdf_path is not a PDF file: ${normalizedPath}` };
		}
		return { normalizedPath };
	} finally {
		closeSync(fd);
	}
}

function openAndValidateSource(rawSourcePath: string): { normalizedPath: string; error?: string } {
	const normalizedPath = resolve(rawSourcePath);
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	let fd: number | undefined;
	try {
		fd = openSync(normalizedPath, flags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			return { normalizedPath, error: "source_file must not be a symlink" };
		}
		return { normalizedPath, error: `cannot open source_file: ${normalizedPath}` };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			return { normalizedPath, error: `source_file must be a regular file: ${normalizedPath}` };
		}
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
			return { normalizedPath, error: `source_file is not owned by current user: ${normalizedPath}` };
		}
		return { normalizedPath };
	} finally {
		closeSync(fd);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function snapshotProcessIdentity(pid: number): ProcessIdentity | undefined {
	if (pid <= 0) return;
	const procRoot = join("/", "proc", String(pid));
	const identity: ProcessIdentity = {};
	try {
		const statText = readFileSync(join(procRoot, "stat"), "utf8");
		const open = statText.indexOf("(");
		const close = statText.lastIndexOf(")");
		if (open !== -1 && close !== -1 && close > open) {
			identity.comm = statText.slice(open + 1, close);
			const tail = statText.slice(close + 2).split(/\s+/);
			const startTime = Number(tail[19]);
			if (Number.isInteger(startTime)) {
				identity.start_time = startTime;
			}
		}
	} catch {
		return;
	}
	try {
		const cmdline = readFileSync(join(procRoot, "cmdline"));
		identity.cmdline = cmdline.toString("utf8").split("\u0000").filter(Boolean);
	} catch {
		// best effort only
	}
	try {
		identity.exe = readlinkSync(join(procRoot, "exe"));
	} catch {
		// best effort only
	}
	if (Object.keys(identity).length === 0) return;
	return identity;
}

function isPidAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			return true;
		}
		return false;
	}
	return true;
}

function commandLineEquals(left: string[] | undefined, right: string[] | undefined): boolean {
	if (left === undefined || right === undefined) {
		return left === right;
	}
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i += 1) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function isProcessIdentityMatch(
	pid: number,
	session: ZathuraSession,
	markers: readonly ("comm" | "start_time" | "exe" | "cmdline")[],
): boolean {
	if (!session.identity) return false;
	const current = snapshotProcessIdentity(pid);
	if (!current) return false;
	for (const marker of markers) {
		const expected = session.identity[marker];
		if (expected === undefined) continue;
		if (marker === "cmdline") {
			if (!commandLineEquals(expected as string[] | undefined, current.cmdline)) return false;
			continue;
		}
		if (current[marker] !== expected) return false;
	}
	return true;
}

function iterPidsForViewerCommand(viewerPath: string, allowWrapped: boolean): number[] {
	const viewerName = basename(viewerPath);
	const pids: number[] = [];
	for (const dirent of readdirSync(join("/", "proc"))) {
		if (!/^[0-9]+$/.test(dirent)) continue;
		const pid = Number(dirent);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		let commandlineText: string;
		try {
			commandlineText = readFileSync(join("/", "proc", dirent, "cmdline")).toString("utf8");
		} catch {
			continue;
		}
		const parts = commandlineText.split("\u0000").filter(Boolean);
		if (parts.length === 0) continue;
		const names = parts.map((part) => basename(part));
		if (!allowWrapped) {
			if (names[0] !== viewerName) continue;
		} else if (!names.includes(viewerName)) {
			continue;
		}
		pids.push(pid);
	}
	return pids;
}

function iterPidsForPdf(viewerPath: string, pdfPaths: string[], allowWrapped: boolean): number[] {
	if (pdfPaths.length === 0) return [];
	const normalizedPaths = pdfPaths.map((pdfPath) => resolve(pdfPath));
	const matches: number[] = [];
	for (const pid of iterPidsForViewerCommand(viewerPath, allowWrapped)) {
		let args: string[];
		try {
			args = readFileSync(join("/", "proc", String(pid), "cmdline"), "utf8").split("\u0000").filter(Boolean);
		} catch {
			continue;
		}
		for (const normalizedPath of normalizedPaths) {
			if (args.some((arg) => arg === normalizedPath || arg.endsWith(`/${normalizedPath}`))) {
				matches.push(pid);
				break;
			}
		}
	}
	return matches;
}

function findSessionPidWithIdentity(
	viewerPath: string,
	pdfPath: string,
	session: ZathuraSession,
	excludePid?: number,
): number | undefined {
	const hints = new Set<string>([resolve(pdfPath)]);
	for (const arg of session.identity?.cmdline ?? []) {
		const procFdPrefix = `${String.fromCharCode(47)}proc${String.fromCharCode(47)}self${String.fromCharCode(47)}fd${String.fromCharCode(47)}`;
		if (arg.startsWith(procFdPrefix)) {
			hints.add(arg);
		}
	}
	for (const pid of iterPidsForPdf(viewerPath, [...hints], true)) {
		if (excludePid !== undefined && pid === excludePid) continue;
		if (isProcessIdentityMatch(pid, session, ["comm", "exe"])) {
			return pid;
		}
	}
	for (const pid of iterPidsForViewerCommand(viewerPath, true)) {
		if (excludePid !== undefined && pid === excludePid) continue;
		if (isProcessIdentityMatch(pid, session, ["comm", "exe"])) {
			return pid;
		}
	}
	return;
}

function forwardDiagnostic(
	label: string,
	command: string[],
	synctexPid: number | undefined,
	completed?: { status: number | null; stdout?: string; stderr?: string },
	error?: string,
): Record<string, unknown> {
	const detail: Record<string, unknown> = {
		label,
		command,
	};
	if (synctexPid !== undefined) detail.synctex_pid = synctexPid;
	if (completed !== undefined) {
		detail.returncode = completed.status;
		if (completed.stdout) detail.stdout = completed.stdout.slice(0, 1024);
		if (completed.stderr) detail.stderr = completed.stderr.slice(0, 1024);
	}
	if (error !== undefined) detail.error = error;
	return detail;
}

function openStatusDetails(partial: {
	backendAvailable?: boolean;
	handle?: string;
	owned: boolean;
	reused: boolean;
	backendPath: string;
	pid?: number;
	errorCode?: string;
	reason?: string;
	pidDiagnostic?: string;
	capabilities?: HostServiceViewerBackendCapabilities;
}): Record<string, unknown> {
	return {
		protocol_version: PROTOCOL_VERSION,
		supported: partial.backendAvailable !== false,
		service_available: partial.backendAvailable !== false,
		backend: partial.backendPath,
		backend_path: partial.backendPath,
		capabilities: partial.capabilities ?? DEFAULT_FAKE_VIEWER_BACKEND_CAPABILITIES,
		handle: partial.handle,
		owned: partial.owned,
		reused: partial.reused,
		pid: partial.pid,
		pid_diagnostic: partial.pidDiagnostic,
		error_code: partial.errorCode,
		reason: partial.reason,
	};
}

function closeStatusDetails(partial: {
	handle?: string;
	closed: boolean;
	reason?: string;
	errorCode?: string;
	backendIdentityOk?: boolean;
}): Record<string, unknown> {
	return {
		protocol_version: PROTOCOL_VERSION,
		supported: true,
		service_available: true,
		backend: BACKEND_NAME,
		backend_identity_ok: partial.backendIdentityOk ?? true,
		closed: partial.closed,
		handle: partial.handle,
		reason: partial.reason,
		error_code: partial.errorCode,
	};
}

function forwardStatusDetails(partial: {
	handle?: string;
	handled: boolean;
	reason?: string;
	errorCode?: string;
	diagnostics?: Array<Record<string, unknown>>;
	backendIdentityOk?: boolean;
}): Record<string, unknown> {
	return {
		protocol_version: PROTOCOL_VERSION,
		supported: true,
		service_available: true,
		backend: BACKEND_NAME,
		backend_identity_ok: partial.backendIdentityOk ?? true,
		handle: partial.handle,
		handled: partial.handled,
		reason: partial.reason,
		error_code: partial.errorCode,
		diagnostics: partial.diagnostics,
	};
}

export interface FakeViewerBackendOptions {
	name?: string;
	available?: boolean;
	capabilities?: Partial<HostServiceViewerBackendCapabilities>;
}

interface FakeSession {
	path: string;
	handle: string;
	callback: HostServiceCallbackTarget;
	pid: number;
}

export class FakeViewerBackend implements ViewerBackendAdapter {
	readonly name: string;
	readonly capabilities: HostServiceViewerBackendCapabilities;
	private available: boolean;
	private openCount = 0;
	private sessions = new Map<string, FakeSession>();

	constructor(options: FakeViewerBackendOptions = {}) {
		this.name = options.name ?? DEFAULT_FAKE_VIEWER_BACKEND_NAME;
		this.capabilities = cloneCapabilities(options.capabilities);
		this.available = options.available ?? true;
	}

	isAvailable(): boolean {
		return this.available;
	}

	async closeAll(_requestId = "service-shutdown"): Promise<void> {
		this.sessions.clear();
	}

	setAvailable(available: boolean): void {
		this.available = available;
	}

	private keyFor(pdfPath: string, callback: HostServiceCallbackTarget): string {
		return `${pdfPath}\n${callbackKey(callback)}`;
	}

	private findSessionByHandle(handle: string): string | undefined {
		for (const [key, session] of this.sessions) {
			if (session.handle === handle) return key;
		}
		return;
	}

	async status(requestId: string, operation: string): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		return {
			status: this.available ? "ok" : "error",
			error: this.available ? undefined : "viewer backend is unavailable",
			status_details: {
				protocol_version: PROTOCOL_VERSION,
				supported: true,
				service_available: this.available,
			},
		};
	}

	async open(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		if (!this.isAvailable()) {
			return {
				status: "error",
				error: "viewer backend is unavailable",
				status_details: openStatusDetails({
					backendPath: this.name,
					owned: false,
					reused: false,
					backendAvailable: false,
					errorCode: "backend_unavailable",
				}),
			};
		}
		if (!this.capabilities.open) {
			return {
				status: "error",
				error: "backend does not support open",
				status_details: openStatusDetails({
					backendPath: this.name,
					owned: false,
					reused: false,
					errorCode: "unsupported_operation",
				}),
			};
		}
		const validationError = validateOpenRequest(details);
		if (validationError) {
			return {
				status: "error",
				error: validationError,
				status_details: openStatusDetails({
					backendPath: this.name,
					owned: false,
					reused: false,
					errorCode: validationError.includes("callback") ? "callback_invalid" : "invalid_request",
					reason: validationError,
				}),
			};
		}
		const callback = normalizeCallback(details.callback)!;
		const reuseExisting = details.reuse_existing !== false;
		const pdfPath = resolve(details.pdf_path as string);
		if (reuseExisting) {
			const key = this.keyFor(pdfPath, callback);
			const existing = this.sessions.get(key);
			if (existing) {
				return {
					status: "ok",
					status_details: openStatusDetails({
						backendPath: this.name,
						owned: true,
						reused: true,
						pid: existing.pid,
						handle: existing.handle,
						capabilities: this.capabilities,
					}),
				};
			}
		}
		this.openCount += 1;
		const handle = `${this.name}:${this.openCount}:${randomUUID()}`;
		this.sessions.set(this.keyFor(pdfPath, callback), {
			path: pdfPath,
			handle,
			callback,
			pid: 123456,
		});
		return {
			status: "ok",
			status_details: openStatusDetails({
				backendPath: this.name,
				owned: true,
				reused: false,
				pid: 123456,
				handle,
				capabilities: this.capabilities,
			}),
		};
	}

	async close(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		if (!this.capabilities.close) {
			return {
				status: "error",
				error: "backend does not support close",
				status_details: {
					...closeStatusDetails({
						closed: false,
						errorCode: "unsupported_operation",
					}),
					backend: this.name,
				},
			};
		}
		const validationError = validateCloseRequest(details);
		if (validationError) {
			return {
				status: "error",
				error: validationError,
				status_details: {
					...closeStatusDetails({ closed: false, reason: validationError, errorCode: "invalid_request", backendIdentityOk: false }),
					backend: this.name,
				},
			};
		}
		const handle = details.handle as string;
		if (details.backend !== this.name) {
			return {
				status: "error",
				error: "backend identity mismatch for viewer handle",
				status_details: {
					...closeStatusDetails({
						closed: false,
						errorCode: "backend_mismatch",
						reason: "backend_mismatch",
						backendIdentityOk: false,
						handle,
					}),
					backend: this.name,
				},
			};
		}
		const sessionKey = this.findSessionByHandle(handle);
		if (sessionKey === undefined) {
			return {
				status: "error",
				error: "viewer handle not recognized",
				status_details: {
					...closeStatusDetails({ closed: false, errorCode: "unknown_handle", backendIdentityOk: false, handle }),
					backend: this.name,
				},
			};
		}
		this.sessions.delete(sessionKey);
		return {
			status: "ok",
			status_details: closeStatusDetails({
				closed: true,
				handle,
				backendIdentityOk: true,
			}),
		};
	}

	async forwardSearch(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		if (!this.capabilities.forward_search) {
			return {
				status: "error",
				error: "backend does not support forward_search",
				status_details: {
					...forwardStatusDetails({
						handled: false,
						errorCode: "unsupported_operation",
						reason: "unsupported",
					}),
					backend: this.name,
				},
			};
		}
		const validationError = validateForwardRequest(details);
		if (validationError) {
			return {
				status: "error",
				error: validationError,
				status_details: {
					...forwardStatusDetails({ handled: false, reason: validationError, errorCode: "invalid_request", backendIdentityOk: false, handle: details.handle as string }),
					backend: this.name,
				},
			};
		}
		return {
			status: "error",
			error: "viewer handle not recognized",
			status_details: {
				...forwardStatusDetails({ handled: false, errorCode: "handle_not_found", backendIdentityOk: false, handle: details.handle as string }),
				backend: this.name,
			},
		};
	}
}

export interface ZathuraViewerBackendOptions {
	executablePath?: string;
	callbackScriptPath?: string;
	nodePath?: string;
}

export class ZathuraViewerBackend implements ViewerBackendAdapter {
	readonly name = BACKEND_NAME;
	readonly capabilities: HostServiceViewerBackendCapabilities;
	readonly executablePath?: string;
	readonly callbackScriptPath: string;
	readonly nodePath: string;
	private openCount = 0;
	private sessions = new Map<string, ZathuraSession>();
	private handleToPath = new Map<string, string>();

	constructor(options: ZathuraViewerBackendOptions = {}) {
		this.capabilities = { ...ZATHURA_VIEWER_BACKEND_CAPABILITIES };
		this.executablePath = options.executablePath;
		this.callbackScriptPath = options.callbackScriptPath ?? defaultCallbackScriptPath();
		this.nodePath = options.nodePath ?? defaultNodePath();
	}

	isAvailable(): boolean {
		const resolvedPath = this.resolvePath();
		if (!resolvedPath) return false;
		try {
			accessSync(resolvedPath, constants.X_OK);
		} catch {
			return false;
		}
		return true;
	}

	async status(requestId: string, operation: string): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		const available = this.isAvailable();
		return {
			status: available ? "ok" : "error",
			error: available ? undefined : "viewer backend is unavailable",
			status_details: {
				protocol_version: PROTOCOL_VERSION,
				supported: this.capabilities.open,
				service_available: available,
			},
		};
	}

	private resolvePath(): string {
		if (this.executablePath && this.executablePath.length > 0) {
			return this.executablePath;
		}
		const explicit = process.env[VIEWER_BACKEND_PATH_ENV];
		if (explicit && explicit.length > 0) {
			return explicit;
		}
		for (const candidate of ["/usr/bin/zathura", "/usr/local/bin/zathura", "/bin/zathura"] as const) {
			if (existsSync(candidate)) return candidate;
		}
		for (const entry of (process.env.PATH ?? "").split(":")) {
			if (!entry) continue;
			const candidate = join(entry, "zathura");
			if (existsSync(candidate)) return candidate;
		}
		return "zathura";
	}

	private buildCallbackCommand(callback: HostServiceCallbackTarget): string {
		return createSynctexCallbackCommand({
			nodePath: this.nodePath,
			callbackScriptPath: this.callbackScriptPath,
			socketPath: callback.socket_path,
			token: callback.token,
		});
	}

	private makeHandle(): string {
		this.openCount += 1;
		return `${BACKEND_NAME}:${this.openCount}:${randomUUID()}`;
	}

	private sessionKey(pdfPath: string): string {
		return resolve(pdfPath);
	}

	private callbackMatch(session: ZathuraSession, callback: HostServiceCallbackTarget): boolean {
		return callbackKey(session.callback) === callbackKey(callback);
	}

	private removeSession(pdfPath: string): void {
		const session = this.sessions.get(pdfPath);
		if (session) {
			this.handleToPath.delete(session.handle);
		}
		this.sessions.delete(pdfPath);
	}

	private findSession(handle: string): ZathuraSession | undefined {
		const pdfPath = this.handleToPath.get(handle);
		if (!pdfPath) return;
		return this.sessions.get(pdfPath);
	}

	private async retireSession(session: ZathuraSession, requestId: string): Promise<void> {
		try {
			await this.close(requestId, {
				handle: session.handle,
				backend: this.name,
			});
		} catch {
			this.removeSession(session.pdfPath);
		}
	}

	private async isReusableSession(
		pdfPath: string,
		callback: HostServiceCallbackTarget,
	): Promise<ZathuraSession | undefined> {
		const session = this.sessions.get(pdfPath);
		if (!session) return;
		if (!this.callbackMatch(session, callback)) {
			await this.retireSession(session, "backend-session-callback-mismatch");
			return;
		}
		if (!isPidAlive(session.pid)) {
			await this.retireSession(session, "backend-session-stale-pid");
			return;
		}
		if (session.process !== undefined) {
			if (session.process.killed || !isPidAlive(session.pid)) {
				await this.retireSession(session, "backend-session-stale-process");
				return;
			}
		}
		if (isProcessIdentityMatch(session.pid, session, ["comm", "start_time", "exe", "cmdline"])) {
			return session;
		}
		await this.retireSession(session, "backend-session-identity-mismatch");
		return;
	}

	async closeAll(requestId = "service-shutdown"): Promise<void> {
		for (const session of [...this.sessions.values()]) {
			await this.close(requestId, {
				handle: session.handle,
				backend: this.name,
			});
		}
	}

	private buildOpenSession(
		handle: string,
		backendPath: string,
		pdfPath: string,
		callback: HostServiceCallbackTarget,
		pid: number,
		process?: ChildProcess,
	): ZathuraSession {
		return {
			handle,
			pdfPath,
			backendPath,
			callback,
			pid,
			owned: true,
			process,
			identity: snapshotProcessIdentity(pid),
		};
	}

	private async waitForProcessExit(processHandle: ChildProcess, timeoutMs: number): Promise<void> {
		if (processHandle.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			let done = false;
			const onExit = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				processHandle.off("exit", onExit);
				resolve();
			}, timeoutMs);
			processHandle.once("exit", onExit);
		});
	}

	private runForwardSearch(
		viewerPath: string,
		line: number,
		sourceFile: string,
		pdfPath: string,
		synctexPid: number | undefined,
		timeoutMs: number,
	): { command: string[]; completed?: { status: number | null; stdout: string; stderr: string }; error?: string } {
		const args = [
			"--synctex-forward",
			`${line}:1:${sourceFile}`,
			...(synctexPid !== undefined ? [`--synctex-pid=${synctexPid}`] : []),
			pdfPath,
		];
		const command = [viewerPath, ...args];
		try {
			const completed = spawnSync(command[0], command.slice(1), {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeoutMs,
			});
			return {
				command,
				completed: {
					status: completed.status,
					stdout: String(completed.stdout ?? ""),
					stderr: String(completed.stderr ?? ""),
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
				return { command, error: `viewer command timed out: ${(error as Error).message}` };
			}
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { command, error: "viewer backend is unavailable" };
			}
			return { command, error: `failed to invoke viewer command: ${(error as Error).message}` };
		}
	}

	async open(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		const validationError = validateOpenRequest(details);
		if (validationError) {
			return {
				status: "error",
				error: validationError,
				status_details: openStatusDetails({
					backendPath: this.resolvePath(),
					owned: false,
					reused: false,
					errorCode: validationError.includes("callback") ? "callback_invalid" : "invalid_request",
					reason: validationError,
					capabilities: this.capabilities,
				}),
			};
		}

		const pdfValidation = openAndValidatePdf(details.pdf_path as string);
		if (pdfValidation.error) {
			return {
				status: "error",
				error: pdfValidation.error,
					status_details: openStatusDetails({
					backendPath: this.resolvePath(),
					owned: false,
					reused: false,
					errorCode: "invalid_pdf",
					reason: pdfValidation.error,
					capabilities: this.capabilities,
				}),
			};
		}
		const pdfPath = pdfValidation.normalizedPath;
		const callback = normalizeCallback(details.callback)!;
		const backendPath = this.resolvePath();
		if (!this.isAvailable()) {
			return {
				status: "error",
				error: "viewer backend is unavailable",
				status_details: openStatusDetails({
					backendPath,
					owned: false,
					reused: false,
					errorCode: "backend_unavailable",
					reason: "backend unavailable",
					backendAvailable: false,
					capabilities: this.capabilities,
				}),
			};
		}
		const reuseExisting = details.reuse_existing !== false;
		const requirePersistent = details.require_persistent_viewer === true;
		if (reuseExisting) {
			const reusable = await this.isReusableSession(pdfPath, callback);
			if (reusable) {
				return {
					status: "ok",
					status_details: openStatusDetails({
						backendPath,
						owned: reusable.owned,
						reused: true,
						pid: reusable.pid,
						handle: reusable.handle,
						backendAvailable: true,
						capabilities: this.capabilities,
					}),
				};
			}
		}
		const currentSession = this.sessions.get(pdfPath);
		if (currentSession) {
			await this.retireSession(currentSession, "backend-session-replaced");
		}
		const callbackCommand = this.buildCallbackCommand(callback);
		const handle = this.makeHandle();
		let child: ChildProcess;
		try {
			child = spawn(backendPath, [`--synctex-editor-command=${callbackCommand}`, pdfPath], {
				stdio: "ignore",
			});
		} catch (error) {
			return {
				status: "error",
				error: `failed to launch viewer: ${error}`,
				status_details: openStatusDetails({
					backendPath,
					handle,
					owned: false,
					reused: false,
					errorCode: "launch_failed",
					reason: `${error}`,
					capabilities: this.capabilities,
				}),
			};
		}
		await sleep(50);
		let owned = false;
		let ownedPid: number | undefined;
		let pidDiagnostic: string | undefined;
		if (child.pid && isPidAlive(child.pid)) {
			owned = true;
			ownedPid = child.pid;
		} else {
			ownedPid = iterPidsForPdf(backendPath, [pdfPath], false)[0];
			if (ownedPid !== undefined && isPidAlive(ownedPid)) {
				owned = true;
			} else {
				pidDiagnostic = "no persistent process discovered";
			}
		}
		if (!owned || !ownedPid) {
			if (requirePersistent) {
				return {
					status: "error",
					error: "viewer did not produce a persistent viewer process",
					status_details: openStatusDetails({
						backendPath,
						handle,
						owned: false,
						reused: false,
						pidDiagnostic,
						errorCode: "launch_failed",
						capabilities: this.capabilities,
					}),
				};
			}
			return {
				status: "ok",
				status_details: openStatusDetails({
					backendPath,
					handle,
					owned: false,
					reused: false,
					pidDiagnostic,
					capabilities: this.capabilities,
				}),
			};
		}
		const session: ZathuraSession = this.buildOpenSession(handle, backendPath, pdfPath, callback, ownedPid, child);
		this.sessions.set(pdfPath, session);
		this.handleToPath.set(handle, pdfPath);
		return {
			status: "ok",
			status_details: openStatusDetails({
				backendPath,
				handle,
				owned,
				reused: false,
				pid: ownedPid,
				pidDiagnostic,
				capabilities: this.capabilities,
			}),
		};
	}

	async close(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		const validationError = validateCloseRequest(details);
		if (validationError) {
			return {
				status: "error",
				error: validationError,
				status_details: {
					...closeStatusDetails({
						closed: false,
						reason: validationError,
						errorCode: "invalid_request",
						backendIdentityOk: false,
					}),
					backend: this.name,
				},
			};
		}
		const handle = details.handle as string;
		const backend = details.backend as string;
		if (backend !== this.name) {
			return {
				status: "error",
				error: "backend identity mismatch for viewer handle",
				status_details: {
					...closeStatusDetails({
						closed: false,
						errorCode: "backend_mismatch",
						reason: "backend mismatch",
						backendIdentityOk: false,
						handle,
					}),
					backend: this.name,
				},
			};
		}
		const session = this.findSession(handle);
		if (!session) {
			return {
				status: "error",
				error: "viewer handle not recognized",
				status_details: {
					...closeStatusDetails({ closed: false, errorCode: "unknown_handle", backendIdentityOk: false, handle }),
					backend: this.name,
				},
			};
		}
		if (!session.owned) {
			return {
				status: "ok",
				status_details: {
					...closeStatusDetails({ closed: false, reason: "not_service_owned", backendIdentityOk: true, handle }),
					backend: this.name,
				},
			};
		}
		if (!isPidAlive(session.pid) || !isProcessIdentityMatch(session.pid, session, ["comm", "start_time", "exe", "cmdline"])) {
			this.removeSession(session.pdfPath);
			return {
				status: "ok",
				status_details: {
					...closeStatusDetails({
						closed: false,
						reason: "not_running",
						backendIdentityOk: true,
						handle,
					}),
					backend: this.name,
				},
			};
		}
		if (session.process && !session.process.killed) {
			try {
				session.process.kill("SIGTERM");
				await this.waitForProcessExit(session.process, 1000);
				if (session.process.exitCode === null) {
					session.process.kill("SIGKILL");
					await this.waitForProcessExit(session.process, 500);
				}
			} catch (error) {
				return {
					status: "error",
					error: `could not stop viewer pid ${session.pid}`,
					status_details: {
						...closeStatusDetails({
							closed: false,
							reason: "backend_unavailable",
							errorCode: "backend_unavailable",
							handle,
							backendIdentityOk: true,
						}),
						backend: this.name,
					},
				};
			}
			this.removeSession(session.pdfPath);
			return {
				status: "ok",
				status_details: {
					...closeStatusDetails({ closed: true, handle, backendIdentityOk: true }),
					backend: this.name,
				},
			};
		}
		try {
			process.kill(session.pid, "SIGTERM");
			this.removeSession(session.pdfPath);
			return {
				status: "ok",
				status_details: {
					...closeStatusDetails({ closed: true, handle, backendIdentityOk: true }),
					backend: this.name,
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				this.removeSession(session.pdfPath);
				return {
					status: "ok",
					status_details: {
						...closeStatusDetails({ closed: false, reason: "not_running", handle, backendIdentityOk: true }),
						backend: this.name,
					},
				};
			}
			return {
				status: "error",
				error: `could not send SIGTERM to viewer pid ${session.pid}`,
				status_details: {
					...closeStatusDetails({
						closed: false,
						reason: "backend_unavailable",
						errorCode: "backend_unavailable",
						handle,
						backendIdentityOk: true,
					}),
					backend: this.name,
				},
			};
		}
	}

	async forwardSearch(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>> {
		const validationError = validateForwardRequest(details);
		if (validationError) {
			return {
				status: "error",
				error: validationError,
				status_details: {
					...forwardStatusDetails({ handled: false, reason: validationError, errorCode: "invalid_request", backendIdentityOk: false, handle: details.handle as string }),
					backend: this.name,
				},
			};
		}
		const handle = details.handle as string;
		const backend = details.backend as string;
		if (backend !== this.name) {
			return {
				status: "error",
				error: "backend identity mismatch for viewer handle",
				status_details: {
					...forwardStatusDetails({ handled: false, reason: "backend mismatch", errorCode: "backend_mismatch", backendIdentityOk: false, handle }),
					backend: this.name,
				},
			};
		}
		const session = this.findSession(handle);
		if (!session) {
			return {
				status: "error",
				error: "viewer handle not recognized",
				status_details: {
					...forwardStatusDetails({ handled: false, errorCode: "handle_not_found", reason: "handle_not_found", backendIdentityOk: false, handle }),
					backend: this.name,
				},
			};
		}
		const sourceValidation = openAndValidateSource(details.source_file as string);
		if (sourceValidation.error) {
			return {
				status: "error",
				error: sourceValidation.error,
				status_details: {
					...forwardStatusDetails({
						handled: false,
						reason: sourceValidation.error,
						errorCode: "invalid_source_file",
						backendIdentityOk: false,
						handle,
					}),
					backend: this.name,
				},
			};
		}
		const requestedPid = isNumber(details.synctex_pid) ? details.synctex_pid : undefined;
		const line = details.line as number;
		const diagnostics: Array<Record<string, unknown>> = [];
		const attempt = (pid: number | undefined, label: string) => {
			const attemptResult = this.runForwardSearch(session.backendPath, line, sourceValidation.normalizedPath, session.pdfPath, pid, 10_000);
			if (attemptResult.error) {
				diagnostics.push(forwardDiagnostic(label, attemptResult.command, pid, undefined, attemptResult.error));
				return { handled: false, reason: attemptResult.error };
			}
			diagnostics.push(forwardDiagnostic(label, attemptResult.command, pid, attemptResult.completed, undefined));
			const rc = attemptResult.completed?.status ?? 1;
			return {
				handled: rc === 0,
				reason: rc === 0 ? undefined : `viewer forward_search failed (returncode=${rc})`,
			};
		};
		const first = attempt(requestedPid, "tracked");
		if (first.handled) {
			return {
				status: "ok",
				status_details: {
					...forwardStatusDetails({ handled: true, backendIdentityOk: true, handle }),
					backend: this.name,
				},
			};
		}
		if (requestedPid !== undefined) {
			const rediscovered = findSessionPidWithIdentity(session.backendPath, session.pdfPath, session, requestedPid);
			if (rediscovered !== undefined) {
				const rediscovery = attempt(rediscovered, "rediscovered");
				if (rediscovery.handled) {
					session.pid = rediscovered;
					session.identity = snapshotProcessIdentity(rediscovered);
					return {
						status: "ok",
						status_details: {
							...forwardStatusDetails({ handled: true, backendIdentityOk: true, handle }),
							backend: this.name,
						},
					};
				}
			}
		}
		const last = diagnostics.at(-1);
		const finalReason = typeof last?.error === "string"
			? `viewer forward_search failed (${String(last.error)})`
			: typeof last?.returncode === "number"
				? `viewer forward_search failed (returncode=${last.returncode})`
				: "viewer forward_search failed";
		return {
			status: "error",
			error: finalReason,
			status_details: {
				...forwardStatusDetails({
					handled: false,
					reason: finalReason,
					errorCode: "backend_unavailable",
					handle,
					diagnostics,
				}),
				backend: this.name,
			},
		};
	}
}

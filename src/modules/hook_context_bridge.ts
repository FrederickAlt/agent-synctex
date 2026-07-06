import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getMcpTmpDir } from "./runtime_paths.ts";
import { sanitizeTexActionsAgentId } from "./agent_runtime_context.ts";
import { collectPostUserPdfContextFromEvents, type FetchPdfContextRequest, type PostUserPdfContextResult } from "./post_user_pdf_context.ts";
import type { PdfAnnotationEvent, PdfEvent } from "./pdf_events.ts";
import { VIEWER_HOST_CONTROL_TOKEN_HEADER, validateViewerHostToMcpMessage } from "./viewer_host_protocol.ts";

export const HOOK_CONTEXT_BRIDGE_FILE_NAME = "hook-context-bridge.json";
const HOOK_CONTEXT_BRIDGE_VERSION = 1;
const MAX_HOOK_PAYLOAD_BYTES = 64 * 1024;

export interface HookContextBridgeDiscovery {
	version: typeof HOOK_CONTEXT_BRIDGE_VERSION;
	pid: number;
	url: string;
	token: string;
	createdAt: string;
}

export interface HookContextBridgeHandle {
	readonly ready: Promise<HookContextBridgeDiscovery>;
	close(): Promise<void>;
}

export interface HookContextBridgeOptions {
	runtimeDir: string;
	fetchContext(request: FetchPdfContextRequest): Promise<PostUserPdfContextResult> | PostUserPdfContextResult;
	now?: () => Date;
}

export function hookContextBridgeDiscoveryPath(runtimeDir: string): string {
	return join(runtimeDir, HOOK_CONTEXT_BRIDGE_FILE_NAME);
}

export function startHookContextBridge(options: HookContextBridgeOptions): HookContextBridgeHandle {
	mkdirSync(options.runtimeDir, { recursive: true, mode: 0o700 });
	const discoveryPath = hookContextBridgeDiscoveryPath(options.runtimeDir);
	const token = randomBytes(32).toString("base64url");
	const server = createServer((request, response) => {
		void handleHookContextRequest(request, response, token, options.fetchContext).catch((error) => {
			textResponse(response, 500, error instanceof Error ? error.message : String(error));
		});
	});
	let discovery: HookContextBridgeDiscovery | undefined;
	let closed = false;
	const ready = new Promise<HookContextBridgeDiscovery>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			if (closed) return;
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("hook context bridge did not bind to a TCP port"));
				return;
			}
			discovery = {
				version: HOOK_CONTEXT_BRIDGE_VERSION,
				pid: process.pid,
				url: `http://127.0.0.1:${address.port}/fetch_info`,
				token,
				createdAt: (options.now?.() ?? new Date()).toISOString(),
			};
			writeFileSync(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`, { mode: 0o600 });
			chmodSync(discoveryPath, 0o600);
			resolve(discovery);
		});
	});
	return {
		ready,
		async close(): Promise<void> {
			closed = true;
			if (existsSync(discoveryPath)) unlinkSync(discoveryPath);
			await new Promise<void>((resolve) => {
				try {
					server.close(() => resolve());
				} catch {
					resolve();
				}
			});
		},
	};
}

export interface FetchHookContextOptions {
	runtimeRoot?: string;
	agentId?: string;
	prompt?: string;
	cwd?: string;
	fetchImpl?: typeof fetch;
}

export async function fetchHookContext(options: FetchHookContextOptions = {}): Promise<string> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const discoveries = findHookContextBridgeDiscoveries(options);
	for (const discovery of discoveries) {
		try {
			const response = await fetchImpl(discovery.url, {
				method: "POST",
				headers: {
					"authorization": `Bearer ${discovery.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ prompt: options.prompt ?? "" }),
			});
			if (!response.ok) continue;
			const text = (await response.text()).trim();
			if (text) return text;
		} catch {
			continue;
		}
	}
	return await fetchPersistentViewerHostContext(options);
}

export function findHookContextBridgeDiscoveries(options: Pick<FetchHookContextOptions, "runtimeRoot" | "agentId"> = {}): HookContextBridgeDiscovery[] {
	const runtimeRoot = options.runtimeRoot ?? getMcpTmpDir();
	const agentId = options.agentId ?? process.env.TEX_ACTIONS_AGENT_ID;
	if (agentId && agentId.trim()) {
		const path = hookContextBridgeDiscoveryPath(join(runtimeRoot, "agents", sanitizeTexActionsAgentId(agentId)));
		const discovery = readDiscoveryFile(path);
		return discovery ? [discovery] : [];
	}
	const agentsDir = join(runtimeRoot, "agents");
	let entries: Array<{ path: string; mtimeMs: number }> = [];
	try {
		entries = readdirSync(agentsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => hookContextBridgeDiscoveryPath(join(agentsDir, entry.name)))
			.map((path) => ({ path, mtimeMs: safeMtimeMs(path) }))
			.filter((entry) => entry.mtimeMs >= 0)
			.sort((left, right) => right.mtimeMs - left.mtimeMs);
	} catch {
		return [];
	}
	return entries.map((entry) => readDiscoveryFile(entry.path)).filter((entry): entry is HookContextBridgeDiscovery => entry !== undefined);
}

async function handleHookContextRequest(
	request: IncomingMessage,
	response: ServerResponse,
	token: string,
	fetchContext: HookContextBridgeOptions["fetchContext"],
): Promise<void> {
	if (request.url !== "/fetch_info") {
		textResponse(response, 404, "not found");
		return;
	}
	if (request.method !== "POST") {
		textResponse(response, 405, "method not allowed");
		return;
	}
	if (bearerToken(request.headers.authorization) !== token) {
		textResponse(response, 401, "unauthorized");
		return;
	}
	await readRequestBody(request);
	const result = await fetchContext({ max_events: 20 });
	textResponse(response, 200, result.text);
}

function bearerToken(value: string | string[] | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(value.trim());
	return match?.[1];
}

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		request.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_HOOK_PAYLOAD_BYTES) {
				reject(new Error("hook payload too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function textResponse(response: ServerResponse, status: number, text: string): void {
	if (response.headersSent) return;
	response.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(text, "utf8"),
		"cache-control": "no-store",
	});
	response.end(text);
}

async function fetchPersistentViewerHostContext(options: FetchHookContextOptions): Promise<string> {
	const runtimeRoot = options.runtimeRoot ?? getMcpTmpDir();
	const agentId = options.agentId ?? process.env.TEX_ACTIONS_AGENT_ID;
	if (!agentId?.trim()) return "";
	const state = readPersistentViewerHostState(join(runtimeRoot, "agents", sanitizeTexActionsAgentId(agentId)));
	if (!state) return "";
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(`${state.origin}/mcp-events/drain`, { method: "POST", headers: { [VIEWER_HOST_CONTROL_TOKEN_HEADER]: state.controlToken } });
		const payload = await response.json() as { ok?: unknown; events?: unknown[] };
		if (!response.ok || payload.ok !== true || !Array.isArray(payload.events)) return "";
		const events = hostMessagesToPdfEvents(payload.events);
		const result = collectPostUserPdfContextFromEvents(events, { maxEvents: 20, clearViewer: true, cwd: options.cwd ?? process.cwd() });
		if (result.cleared) {
			await Promise.allSettled(result.pdfIds.map((pdfId) => fetchImpl(`${state.origin}/control`, {
				method: "POST",
				headers: { "content-type": "application/json", [VIEWER_HOST_CONTROL_TOKEN_HEADER]: state.controlToken },
				body: JSON.stringify({ type: "clear_pdf_annotations", pdf_id: pdfId }),
			})));
		}
		return result.text;
	} catch {
		return "";
	}
}

function hostMessagesToPdfEvents(messages: unknown[]): PdfEvent[] {
	let sequence = 0;
	const events: PdfAnnotationEvent[] = [];
	for (const message of messages) {
		let parsed: ReturnType<typeof validateViewerHostToMcpMessage>;
		try {
			parsed = validateViewerHostToMcpMessage(message);
		} catch {
			continue;
		}
		if (parsed.type !== "pdf_annotation") continue;
		sequence += 1;
		events.push({
			type: "pdf_annotation",
			sequence,
			pdf_id: parsed.pdf_id,
			annotation_id: parsed.annotation_id,
			timestamp: new Date().toISOString(),
			source_file: parsed.source_file,
			line: parsed.line,
			...(parsed.source_line === undefined ? {} : { source_line: parsed.source_line }),
			page: parsed.page,
			x: parsed.x,
			y: parsed.y,
			...(parsed.comment === undefined ? {} : { comment: parsed.comment }),
		});
	}
	return events;
}

function readPersistentViewerHostState(runtimeDir: string): { origin: string; controlToken: string } | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(runtimeDir, "viewer-host.json"), "utf8")) as { origin?: unknown; control_token?: unknown };
		if (typeof raw.origin !== "string" || !raw.origin.startsWith("http://127.0.0.1:")) return undefined;
		if (typeof raw.control_token !== "string" || raw.control_token.length < 16) return undefined;
		return { origin: raw.origin.replace(/\/$/, ""), controlToken: raw.control_token };
	} catch {
		return undefined;
	}
}

function readDiscoveryFile(path: string): HookContextBridgeDiscovery | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HookContextBridgeDiscovery>;
		if (raw.version !== HOOK_CONTEXT_BRIDGE_VERSION) return undefined;
		if (typeof raw.url !== "string" || !raw.url.startsWith("http://127.0.0.1:")) return undefined;
		if (typeof raw.token !== "string" || raw.token.length < 16) return undefined;
		if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return undefined;
		if (typeof raw.createdAt !== "string") return undefined;
		return raw as HookContextBridgeDiscovery;
	} catch {
		return undefined;
	}
}

function safeMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return -1;
	}
}

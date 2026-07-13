import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { createDefaultViewerHostClientFactory, ViewerHostMcpService, type BrowserViewerLauncher, type BrowserViewerLaunchTarget, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import type { McpToViewerHostMessage, ViewerHostControlResponse, ViewerHostToMcpMessage } from "../../src/modules/viewer_host_protocol.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

function writeFakePdf(path: string, body = "body"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
}

function writeSynctexFixture(baseDir: string): { pdfPath: string; sourcePath: string } {
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	copyFileSync(join(process.cwd(), "test/fixtures/synctex-forward/main.tex"), sourcePath);
	copyFileSync(join(process.cwd(), "test/fixtures/synctex-forward/paper.synctex"), join(baseDir, "paper.synctex"));
	return { pdfPath, sourcePath };
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

function socketCtor(): new (url: string) => TestWebSocket {
	const ctor = (globalThis as { WebSocket?: new (url: string) => TestWebSocket }).WebSocket;
	assert.ok(ctor, "global WebSocket must be available in the Node test runtime");
	return ctor;
}

interface TestWebSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
}

async function getViewerSocketToken(origin: string, pdfId: number): Promise<string> {
	const response = await fetch(`${origin}/config/${pdfId}.json`);
	assert.equal(response.status, 200);
	const config = await response.json() as { viewer_socket_token?: unknown; viewer_socket_url?: unknown };
	assert.equal(typeof config.viewer_socket_token, "string");
	const token = String(config.viewer_socket_token);
	assert.match(String(config.viewer_socket_url), new RegExp(`/viewer-socket\\?pdf_id=${pdfId}&token=`));
	return token;
}

async function openViewerSocket(origin: string, pdfId: number, token: string, initialVisibleMarks: readonly Record<string, unknown>[] = []): Promise<TestWebSocket> {
	const WebSocket = socketCtor();
	const socket = new WebSocket(`${origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${pdfId}&token=${encodeURIComponent(token)}`);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out opening viewer socket for pdf_id=${pdfId}`)), 2_000);
		socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`viewer socket errored before open for pdf_id=${pdfId}`)); }, { once: true });
	});
	const visibleMarks = new Map<string, Record<string, unknown>>();
	for (const mark of initialVisibleMarks) {
		if (typeof mark.annotation_id === "string") visibleMarks.set(mark.annotation_id, mark);
	}
	socket.addEventListener("message", (event) => {
		const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
		const message = JSON.parse(data) as Record<string, unknown>;
		if (message.type === "pdf_annotations_snapshot_request") {
			const maxMarks = Number.isInteger(Number(message.max_marks)) && Number(message.max_marks) > 0 ? Number(message.max_marks) : visibleMarks.size;
			socket.send(JSON.stringify({
				type: "pdf_annotations_snapshot",
				pdf_id: message.pdf_id,
				request_id: message.request_id,
				annotations: Array.from(visibleMarks.values()).slice(0, maxMarks),
			}));
		} else if (message.type === "annotations_cleared") {
			const ids = Array.isArray(message.annotation_ids) ? new Set(message.annotation_ids.filter((id): id is string => typeof id === "string")) : undefined;
			if (ids === undefined) visibleMarks.clear();
			else for (const id of ids) visibleMarks.delete(id);
		}
	});
	return {
		get readyState() { return socket.readyState; },
		send(data: string) {
			const message = JSON.parse(data) as Record<string, unknown>;
			if (message.type === "pdf_annotation" && typeof message.annotation_id === "string") visibleMarks.set(message.annotation_id, message);
			else if (message.type === "pdf_annotation_deleted" && typeof message.annotation_id === "string") visibleMarks.delete(message.annotation_id);
			socket.send(data);
		},
		close() { socket.close(); },
		addEventListener: socket.addEventListener.bind(socket),
	};
}

interface TestMarkClaim {
	claim_id?: string;
	marks: Array<{ pdf_id: number; annotation_id: string; [key: string]: unknown }>;
}

async function claimMarks(origin: string, options: { pdf_ids?: number[]; max_marks?: number } = {}): Promise<TestMarkClaim> {
	const response = await fetch(`${origin}/marks/claim`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(options),
	});
	assert.equal(response.status, 200);
	return await response.json() as TestMarkClaim;
}

async function acknowledgeMarks(origin: string, claim: TestMarkClaim, consumed = claim.marks): Promise<Array<{ pdf_id: number; annotation_id: string }>> {
	assert.equal(typeof claim.claim_id, "string");
	const response = await fetch(`${origin}/marks/ack`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ claim_id: claim.claim_id, consumed: consumed.map((mark) => ({ pdf_id: mark.pdf_id, annotation_id: mark.annotation_id })) }),
	});
	assert.equal(response.status, 200);
	const payload = await response.json() as { acknowledged?: Array<{ pdf_id: number; annotation_id: string }> };
	return payload.acknowledged ?? [];
}

async function expectSocketRejected(origin: string, pdfId: number, token?: string): Promise<void> {
	const WebSocket = socketCtor();
	const tokenQuery = token === undefined ? "" : `&token=${encodeURIComponent(token)}`;
	const socket = new WebSocket(`${origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${pdfId}${tokenQuery}`);
	let opened = false;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for viewer socket rejection")), 2_000);
		socket.addEventListener("open", () => { opened = true; clearTimeout(timer); reject(new Error("viewer socket opened unexpectedly")); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timer); resolve(); }, { once: true });
		socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
	assert.equal(opened, false);
}

async function rawWebSocketUpgradeStatus(origin: string, path: string, headers: Record<string, string>): Promise<number> {
	const url = new URL(origin);
	const socket = new Socket();
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.connect(Number(url.port), url.hostname, () => {
				socket.off("error", reject);
				resolve();
			});
		});
		const key = Buffer.from("1234567890abcdef").toString("base64");
		socket.write([
			`GET ${path} HTTP/1.1`,
			`Host: ${url.host}`,
			"Upgrade: websocket",
			"Connection: Upgrade",
			"Sec-WebSocket-Version: 13",
			`Sec-WebSocket-Key: ${key}`,
			...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			"",
			"",
		].join("\r\n"));
		const response = await new Promise<string>((resolve, reject) => {
			let data = "";
			const timer = setTimeout(() => reject(new Error("timed out waiting for raw websocket upgrade response")), 2_000);
			socket.on("data", (chunk) => {
				data += chunk.toString("utf8");
				if (data.includes("\r\n\r\n")) {
					clearTimeout(timer);
					resolve(data);
				}
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		const status = /^HTTP\/1\.1 (\d+)/.exec(response)?.[1];
		assert.ok(status, response);
		return Number(status);
	} finally {
		socket.destroy();
	}
}

async function nextJsonMessage(socket: TestWebSocket, predicate: (message: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for viewer socket message")), 2_000);
		const listen = () => {
			socket.addEventListener("message", (event) => {
				const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
				const message = JSON.parse(data) as Record<string, unknown>;
				if (message.type === "pdf_annotations_snapshot_request" || !predicate(message)) {
					listen();
					return;
				}
				clearTimeout(timer);
				resolve(message);
			}, { once: true });
		};
		listen();
	});
}

async function assertNoMessage(socket: TestWebSocket): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, 150);
		socket.addEventListener("message", (event) => {
			clearTimeout(timer);
			reject(new Error(`unexpected viewer socket message: ${String(event.data)}`));
		}, { once: true });
	});
}

class HttpViewerHostClient implements ViewerHostClient {
	readonly origin: string;
	private readonly client: ViewerHostControlClient;

	constructor(origin: string) {
		this.origin = origin;
		this.client = new ViewerHostControlClient({ origin });
	}

	async send(message: McpToViewerHostMessage): Promise<void> {
		const response: ViewerHostControlResponse = await this.client.send(message);
		if (!response.ok) throw new Error(response.error.message);
	}

	async drainEvents(pdfIds?: readonly number[], eventTypes?: readonly ViewerHostToMcpMessage["type"][]): Promise<ViewerHostToMcpMessage[]> {
		const response = await fetch(`${this.origin}/mcp-events/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...(pdfIds === undefined ? {} : { pdf_ids: pdfIds }), ...(eventTypes === undefined ? {} : { event_types: eventTypes }) }),
		});
		const payload = await response.json() as { events?: ViewerHostToMcpMessage[] };
		return payload.events ?? [];
	}
}

class RecordingBrowserLauncher implements BrowserViewerLauncher {
	readonly targets: BrowserViewerLaunchTarget[] = [];

	async launchOrFocus(target: BrowserViewerLaunchTarget): Promise<void> {
		this.targets.push(target);
	}
}

function callTool(id: number, name: string, args: Record<string, unknown>, service: ViewerHostMcpService) {
	return handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), service.pdfOperations);
}

test("Viewer Host browser open is attempted once per service session even without browser ack", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-single-browser-open-"));
	const runtimeDir = join(baseDir, "runtime");
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	writeFakePdf(firstPdf, "first");
	writeFakePdf(secondPdf, "second");
	const launcher = new RecordingBrowserLauncher();
	const service = new ViewerHostMcpService({ clientFactory: createDefaultViewerHostClientFactory({ agentRuntimeDir: runtimeDir, browserLauncher: launcher, browserOpenAckTimeoutMs: 25 }) });
	try {
		const first = await service.pdfOperations.openPdf!({ protocol_version: 1, request_id: "first", operation: "open_pdf", created_at_ns: 1, workspace_context: { cwd: baseDir }, details: { pdf_path: firstPdf } });
		const second = await service.pdfOperations.openPdf!({ protocol_version: 1, request_id: "second", operation: "open_pdf", created_at_ns: 2, workspace_context: { cwd: baseDir }, details: { pdf_path: secondPdf } });
		assert.equal(first.status, "ok");
		assert.equal(second.status, "ok");
		assert.equal(launcher.targets.length, 1);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("viewer sockets accept registered pdf_id clients and reject unknown pdf_id clients cleanly", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-register-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 12, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		const token = await getViewerSocketToken(server.origin, 12);

		await expectSocketRejected(server.origin, 12);
		await expectSocketRejected(server.origin, 12, "not-the-token");
		assert.equal(await rawWebSocketUpgradeStatus(server.origin, `/viewer-socket?pdf_id=12&token=${encodeURIComponent(token)}`, { Origin: "http://evil.example" }), 403);
		socket = await openViewerSocket(server.origin, 12, token);
		assert.equal(server.getConnectedViewerCount(12), 1);
		await expectSocketRejected(server.origin, 404, token);
		assert.throws(() => server.getConnectedViewerCount(404), /Unknown pdf_id=404/);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("synctex_forward and pdf_refresh messages are delivered only to viewer sockets for the target pdf_id", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-targeted-"));
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	writeFakePdf(firstPdf, "first");
	writeFakePdf(secondPdf, "second");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let firstSocket: TestWebSocket | undefined;
	let firstPeerSocket: TestWebSocket | undefined;
	let secondSocket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 1, pdfPath: firstPdf, title: basename(firstPdf), revision: 2, fileSnapshot: snapshotPdf(firstPdf) });
		registry.registerPdf({ pdfId: 2, pdfPath: secondPdf, title: basename(secondPdf), revision: 5, fileSnapshot: snapshotPdf(secondPdf) });
		await server.start();
		const firstToken = await getViewerSocketToken(server.origin, 1);
		const secondToken = await getViewerSocketToken(server.origin, 2);
		firstSocket = await openViewerSocket(server.origin, 1, firstToken);
		firstPeerSocket = await openViewerSocket(server.origin, 1, firstToken);
		secondSocket = await openViewerSocket(server.origin, 2, secondToken);
		const control = new ViewerHostControlClient({ origin: server.origin });

		const firstSynctexMessage = nextJsonMessage(firstSocket);
		const firstPeerSynctexMessage = nextJsonMessage(firstPeerSocket);
		const unexpectedSecondSynctexMessage = assertNoMessage(secondSocket);
		assert.deepEqual(await control.send({ type: "synctex_forward", pdf_id: 1, page: 3, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7 }), { ok: true, result: { type: "synctex_forward", pdf_id: 1 } });
		const expectedSynctex = { type: "synctex_forward", pdf_id: 1, page: 3, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7 };
		assert.deepEqual(await firstSynctexMessage, expectedSynctex);
		assert.deepEqual(await firstPeerSynctexMessage, expectedSynctex);
		await unexpectedSecondSynctexMessage;

		const secondRefreshMessage = nextJsonMessage(secondSocket);
		const unexpectedFirstRefreshMessage = assertNoMessage(firstSocket);
		const unexpectedFirstPeerRefreshMessage = assertNoMessage(firstPeerSocket);
		server.sendPdfRefresh(2);
		assert.deepEqual(await secondRefreshMessage, { type: "pdf_refresh", pdf_id: 2, revision: 5, pdf_url: `${server.origin}/pdf/2?revision=5` });
		await unexpectedFirstRefreshMessage;
		await unexpectedFirstPeerRefreshMessage;
	} finally {
		firstSocket?.close();
		firstPeerSocket?.close();
		secondSocket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF refresh preserves annotation geometry and reverse-resolves source spans from that geometry", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-annotation-geometry-refresh-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath, "before");
	writeFileSync(sourcePath, "old\nnew target\n");
	const registry = new ViewerHostPdfRegistry();
	const resolvedBoxes: Array<Record<string, unknown>> = [];
	const server = new ViewerHostServer({
		registry,
		pdfChangeDetection: { debounceMs: 0, pollIntervalMs: 60_000 },
		waitForSynctexReady: async () => true,
		resolveReverseBox: ({ message }) => {
			resolvedBoxes.push({ ...message });
			return { type: "reverse_synctex_box_result", pdf_id: message.pdf_id, request_id: message.request_id, page: message.page, h: message.h, v: message.v, W: message.W, H: message.H, ranges: [{ page: message.page, h: message.h, v: message.v, W: message.W, H: message.H }], source_file: sourcePath, line: 2, source_spans: [{ source_file: sourcePath, start_line: 2, end_line: 2 }] };
		},
	});
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 71, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		socket = await openViewerSocket(server.origin, 71, await getViewerSocketToken(server.origin, 71));
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "fixed", page: 1, x: 10, y: 40, h: 10, v: 40, W: 30, H: 12, ranges: [{ page: 1, h: 10, v: 40, W: 30, H: 12 }], source_file: sourcePath, line: 1, source_spans: [{ source_file: sourcePath, start_line: 1, end_line: 1 }], comment: "keep me" }));
		await new Promise((resolve) => setTimeout(resolve, 25));
		writeFakePdf(pdfPath, "after recompilation with changed size");
		const rebasedMessage = nextJsonMessage(socket, (message) => message.type === "annotations_rebased");
		await server.verifyPdfChangesNow(71);
		await server.verifyPdfChangesNow(71);
		assert.deepEqual(resolvedBoxes, [{ type: "reverse_synctex_box", pdf_id: 71, request_id: 2, page: 1, h: 10, v: 40, W: 30, H: 12 }]);
		assert.deepEqual(await rebasedMessage, { type: "annotations_rebased", pdf_id: 71, annotations: [{ annotation_id: "fixed", message: { page: 1, h: 10, v: 40, W: 30, H: 12, ranges: [{ page: 1, h: 10, v: 40, W: 30, H: 12 }], source_file: sourcePath, line: 2, source_spans: [{ source_file: sourcePath, start_line: 2, end_line: 2 }], source_stale: false } }] });
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("failed annotation refresh broadcasts stale state and a later refresh clears it", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-annotation-stale-recovery-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath, "one");
	writeFileSync(sourcePath, "old\nrecovered\n");
	const registry = new ViewerHostPdfRegistry();
	let ready = false;
	const server = new ViewerHostServer({ registry, pdfChangeDetection: { debounceMs: 0, pollIntervalMs: 60_000 }, waitForSynctexReady: async () => ready, resolveReverseBox: ({ message }) => ({ type: "reverse_synctex_box_result", pdf_id: message.pdf_id, request_id: message.request_id, page: message.page, h: message.h, v: message.v, W: message.W, H: message.H, source_file: sourcePath, line: 2, source_spans: [{ source_file: sourcePath, start_line: 2, end_line: 2 }] }) });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 72, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		socket = await openViewerSocket(server.origin, 72, await getViewerSocketToken(server.origin, 72));
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "stale", page: 1, x: 10, y: 40, h: 10, v: 40, W: 30, H: 12, source_file: sourcePath, line: 1, comment: "keep" }));
		await new Promise((resolve) => setTimeout(resolve, 25));
		writeFakePdf(pdfPath, "two changed");
		const staleUpdate = nextJsonMessage(socket, (message) => message.type === "annotations_rebased");
		await server.verifyPdfChangesNow(72); await server.verifyPdfChangesNow(72);
		assert.deepEqual(await staleUpdate, { type: "annotations_rebased", pdf_id: 72, annotations: [{ annotation_id: "stale", message: { source_stale: true } }] });
		ready = true;
		writeFakePdf(pdfPath, "three changed again");
		const recoveredUpdate = nextJsonMessage(socket, (message) => message.type === "annotations_rebased");
		await server.verifyPdfChangesNow(72); await server.verifyPdfChangesNow(72);
		const recovered = await recoveredUpdate as { annotations: Array<{ message: { source_stale?: boolean } }> };
		assert.equal(recovered.annotations[0]?.message.source_stale, false);
	} finally { socket?.close(); await server.stop(); rmSync(baseDir, { recursive: true, force: true }); }
});

test("compile status broadcasts to viewer sockets and compile actions drain to MCP", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-compile-action-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 23, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		socket = await openViewerSocket(server.origin, 23, await getViewerSocketToken(server.origin, 23));
		const control = new ViewerHostControlClient({ origin: server.origin });

		const statusMessage = nextJsonMessage(socket);
		assert.deepEqual(await control.send({ type: "compile_status", pdf_id: 23, running: false, continuous: true, severity: "error", message: "compile failed", inject_text: "compile failed" }), { ok: true, result: { type: "compile_status", pdf_id: 23 } });
		assert.deepEqual(await statusMessage, { type: "compile_status", pdf_id: 23, running: false, continuous: true, severity: "error", message: "compile failed", inject_text: "compile failed" });

		socket.send(JSON.stringify({ type: "compile_action", action: "continuous_on" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const response = await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" });
		const payload = await response.json() as { ok?: boolean; events?: unknown[] };
		assert.equal(payload.ok, true);
		assert.deepEqual(payload.events, [{ type: "compile_action", pdf_id: 23, action: "continuous_on" }]);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("reported failures reach the target viewer with optional agent-forwarding text", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-reported-failure-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 25, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		socket = await openViewerSocket(server.origin, 25, await getViewerSocketToken(server.origin, 25));
		const control = new ViewerHostControlClient({ origin: server.origin });

		const viewerFailure = nextJsonMessage(socket);
		assert.deepEqual(await control.send({
			type: "report_error",
			pdf_id: 25,
			code: "mark_fetch_failed",
			title: "Could not fetch PDF marks",
			detail: "The Viewer Host rejected the mark claim.",
			inject_text: "PDF mark delivery failed: claim rejected",
		}), { ok: true, result: { type: "report_error", pdf_id: 25 } });
		assert.deepEqual(await viewerFailure, {
			type: "viewer_error",
			pdf_id: 25,
			code: "mark_fetch_failed",
			title: "Could not fetch PDF marks",
			detail: "The Viewer Host rejected the mark claim.",
			inject_text: "PDF mark delivery failed: claim rejected",
		});
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host bounds its transient MCP event backlog", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-bounded-events-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, maxMcpEventBacklog: 2 });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 24, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		socket = await openViewerSocket(server.origin, 24, await getViewerSocketToken(server.origin, 24));
		socket.send(JSON.stringify({ type: "compile_action", action: "compile" }));
		socket.send(JSON.stringify({ type: "compile_action", action: "stop" }));
		socket.send(JSON.stringify({ type: "compile_action", action: "continuous_on" }));
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		const payload = await (await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" })).json() as { events?: unknown[] };
		assert.deepEqual(payload.events, [
			{ type: "compile_action", pdf_id: 24, action: "stop" },
			{ type: "compile_action", pdf_id: 24, action: "continuous_on" },
		]);

		socket.send(JSON.stringify({ type: "compile_action", action: "status" }));
		socket.send(JSON.stringify({ type: "selection_debug", phase: "one", text: "", details: {} }));
		socket.send(JSON.stringify({ type: "selection_debug", phase: "two", text: "", details: {} }));
		socket.send(JSON.stringify({ type: "selection_debug", phase: "three", text: "", details: {} }));
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		const afterDiagnostics = await (await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" })).json() as { events?: unknown[] };
		assert.deepEqual(afterDiagnostics.events, [
			{ type: "compile_action", pdf_id: 24, action: "status" },
			{ type: "selection_debug", pdf_id: 24, phase: "three", text: "", details: {} },
		]);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("mark claims wait for a freshly opened visible viewer socket before snapshot", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-fresh-viewer-snapshot-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	writeFileSync(sourcePath, "fresh mark\n");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		const opened = await client.send({ type: "open_pdf", pdf_id: 51, pdf_path: pdfPath, title: basename(pdfPath) });
		assert.deepEqual(opened, { ok: true, result: { type: "open_pdf", pdf_id: 51, revision: 1 } });

		const claimPromise = claimMarks(server.origin, { pdf_ids: [51] });
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		socket = await openViewerSocket(server.origin, 51, await getViewerSocketToken(server.origin, 51), [
			{ type: "pdf_annotation", annotation_id: "fresh", page: 1, x: 1, y: 2, source_file: sourcePath, line: 1 },
		]);

		const claim = await claimPromise;
		assert.deepEqual(claim.marks.map(({ source_stale: _sourceStale, ...mark }) => mark), [{ type: "pdf_annotation", pdf_id: 51, annotation_id: "fresh", page: 1, x: 1, y: 2, source_file: sourcePath, line: 1 }]);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("unscoped mark claims do not wait on inactive visible tabs without sockets", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-inactive-visible-no-socket-"));
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	const secondSource = join(baseDir, "second.tex");
	writeFakePdf(firstPdf, "first");
	writeFakePdf(secondPdf, "second");
	writeFileSync(secondSource, "second mark\n");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 61, pdf_path: firstPdf, title: basename(firstPdf) })).ok, true);
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 62, pdf_path: secondPdf, title: basename(secondPdf) })).ok, true);
		socket = await openViewerSocket(server.origin, 62, await getViewerSocketToken(server.origin, 62));
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "second-mark", page: 1, x: 1, y: 2, source_file: secondSource, line: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		const claim = await claimMarks(server.origin);
		assert.deepEqual(claim.marks.map(({ source_stale: _sourceStale, ...mark }) => mark), [{ type: "pdf_annotation", pdf_id: 62, annotation_id: "second-mark", page: 1, x: 1, y: 2, source_file: secondSource, line: 1 }]);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("generic event drains do not consume or clear pending PDF marks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-filtered-drain-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	writeFileSync(join(baseDir, "main.tex"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 31, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		socket = await openViewerSocket(server.origin, 31, await getViewerSocketToken(server.origin, 31));
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7, comment: "keep me" }));
		socket.send(JSON.stringify({ type: "compile_action", action: "status" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		const filteredResponse = await fetch(`${server.origin}/mcp-events/drain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pdf_ids: [31], event_types: ["compile_action"] }) });
		const filteredPayload = await filteredResponse.json() as { ok?: boolean; events?: unknown[] };
		assert.equal(filteredPayload.ok, true);
		assert.deepEqual(filteredPayload.events, [{ type: "compile_action", pdf_id: 31, action: "status" }]);
		await assertNoMessage(socket);

		const allResponse = await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" });
		const allPayload = await allResponse.json() as { ok?: boolean; events?: unknown[] };
		assert.equal(allPayload.ok, true);
		assert.deepEqual(allPayload.events, []);
		const claim = await claimMarks(server.origin, { pdf_ids: [31] });
		assert.deepEqual(claim.marks.map(({ source_stale: _sourceStale, ...mark }) => mark), [{ type: "pdf_annotation", pdf_id: 31, annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7, comment: "keep me" }]);
		await assertNoMessage(socket);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("multi-range annotation socket payloads retain every normalized source span", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-multi-range-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const firstSource = join(baseDir, "first.tex");
	const secondSource = join(baseDir, "second.tex");
	writeFakePdf(pdfPath);
	writeFileSync(firstSource, "one\ntwo\nthree\n");
	writeFileSync(secondSource, "one\ntwo\nthree\nfour\nfive\n");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 32, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		socket = await openViewerSocket(server.origin, 32, await getViewerSocketToken(server.origin, 32));
		socket.send(JSON.stringify({
			type: "pdf_annotation",
			annotation_id: "multi",
			page: 1,
			x: 10,
			y: 20,
			source_file: firstSource,
			line: 2,
			source_spans: [
				{ source_file: firstSource, start_line: 2, end_line: 2 },
				{ source_file: secondSource, start_line: 3, end_line: 5 },
			],
		}));
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		const claim = await claimMarks(server.origin, { pdf_ids: [32] });
		assert.deepEqual(claim.marks[0]?.source_spans, [
			{ source_file: firstSource, start_line: 2, end_line: 2 },
			{ source_file: secondSource, start_line: 3, end_line: 5 },
		]);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF annotation socket payloads are coalesced for mark claims and targeted acknowledgement", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-annotation-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	writeFileSync(join(baseDir, "main.tex"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 33, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		const token = await getViewerSocketToken(server.origin, 33);
		socket = await openViewerSocket(server.origin, 33, token);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7, source_line: "old", comment: "old" }));
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7, source_line: "new", comment: "new" }));
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a2", page: 1, x: 30, y: 40, source_file: join(baseDir, "main.tex"), line: 8, comment: "removed" }));
		socket.send(JSON.stringify({ type: "pdf_annotation_deleted", annotation_id: "a2" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		const clearMessage = nextJsonMessage(socket, (message) => message.type === "annotations_cleared");
		const claim = await claimMarks(server.origin);
		assert.deepEqual(claim.marks, [{ type: "pdf_annotation", pdf_id: 33, annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7, source_line: "new", comment: "new" }]);
		assert.deepEqual(await acknowledgeMarks(server.origin, claim), [{ pdf_id: 33, annotation_id: "a1" }]);
		assert.deepEqual(await clearMessage, { type: "annotations_cleared", pdf_id: 33, pdf_ids: [33], annotation_ids: ["a1"] });
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("mark claims can be scoped to owned pdf_ids without consuming other marks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-drain-owned-"));
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	writeFakePdf(firstPdf, "first");
	writeFakePdf(secondPdf, "second");
	writeFileSync(join(baseDir, "first.tex"), "first\n");
	writeFileSync(join(baseDir, "second.tex"), "first\nsecond\n");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let firstSocket: TestWebSocket | undefined;
	let secondSocket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 41, pdfPath: firstPdf, title: basename(firstPdf), revision: 1, fileSnapshot: snapshotPdf(firstPdf) });
		registry.registerPdf({ pdfId: 42, pdfPath: secondPdf, title: basename(secondPdf), revision: 1, fileSnapshot: snapshotPdf(secondPdf) });
		await server.start();
		firstSocket = await openViewerSocket(server.origin, 41, await getViewerSocketToken(server.origin, 41));
		secondSocket = await openViewerSocket(server.origin, 42, await getViewerSocketToken(server.origin, 42));
		firstSocket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(baseDir, "first.tex"), line: 1 }));
		secondSocket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a2", page: 1, x: 30, y: 40, source_file: join(baseDir, "second.tex"), line: 2 }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		const firstClearMessage = nextJsonMessage(firstSocket, (message) => message.type === "annotations_cleared");
		const scopedClaim = await claimMarks(server.origin, { pdf_ids: [41] });
		assert.deepEqual(scopedClaim.marks.map((mark) => mark.pdf_id), [41]);
		await acknowledgeMarks(server.origin, scopedClaim);
		assert.deepEqual(await firstClearMessage, { type: "annotations_cleared", pdf_id: 41, pdf_ids: [41], annotation_ids: ["a1"] });

		const secondClearMessage = nextJsonMessage(secondSocket, (message) => message.type === "annotations_cleared");
		const remainingClaim = await claimMarks(server.origin);
		assert.deepEqual(remainingClaim.marks.map((mark) => mark.pdf_id), [42]);
		await acknowledgeMarks(server.origin, remainingClaim);
		assert.deepEqual(await secondClearMessage, { type: "annotations_cleared", pdf_id: 42, pdf_ids: [42], annotation_ids: ["a2"] });
	} finally {
		firstSocket?.close();
		secondSocket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("closing a visible viewer tab discards queued marks and clears viewer annotations", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tab-close-clear-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 33, pdf_path: pdfPath, title: "Paper" })).ok, true);
		const token = await getViewerSocketToken(server.origin, 33);
		socket = await openViewerSocket(server.origin, 33, token);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: join(baseDir, "main.tex"), line: 7, source_line: "marked", comment: "note" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		const clearMessage = nextJsonMessage(socket, (message) => message.type === "annotations_cleared");
		const closeResponse = await fetch(`${server.origin}/viewer-tab-closed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pdf_id: 33, revision: 1, viewer_url: "/viewer-lw/33?revision=1", visible_tab_token: "visible-tab-1" }),
		});

		assert.equal(closeResponse.status, 200);
		assert.deepEqual(await clearMessage, { type: "annotations_cleared", pdf_id: 33, pdf_ids: [33] });
		assert.deepEqual((await claimMarks(server.origin)).marks, []);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("clear_pdf_annotations reaches active viewer sockets for inactive PDFs", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-clear-inactive-"));
	const activePdfPath = join(baseDir, "active.pdf");
	const inactivePdfPath = join(baseDir, "inactive.pdf");
	writeFakePdf(activePdfPath, "active");
	writeFakePdf(inactivePdfPath, "inactive");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 33, pdfPath: inactivePdfPath, title: basename(inactivePdfPath), revision: 1, fileSnapshot: snapshotPdf(inactivePdfPath) });
		registry.registerPdf({ pdfId: 34, pdfPath: activePdfPath, title: basename(activePdfPath), revision: 1, fileSnapshot: snapshotPdf(activePdfPath) });
		await server.start();
		const token = await getViewerSocketToken(server.origin, 34);
		socket = await openViewerSocket(server.origin, 34, token);
		const clearMessage = nextJsonMessage(socket, (message) => message.type === "annotations_cleared");
		const response = await new ViewerHostControlClient({ origin: server.origin }).send({ type: "clear_pdf_annotations", pdf_id: 33 });
		assert.deepEqual(response, { ok: true, result: { type: "clear_pdf_annotations", pdf_id: 33 } });
		assert.deepEqual(await clearMessage, { type: "annotations_cleared", pdf_id: 33, pdf_ids: [33] });
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX viewer socket payloads flow through Host to MCP event store", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-reverse-"));
	const { pdfPath, sourcePath } = writeSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({ registry });
	let socket: TestWebSocket | undefined;
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 112 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		const token = await getViewerSocketToken(server.origin, 112);
		socket = await openViewerSocket(server.origin, 112, token);

		socket.send(JSON.stringify({
			type: "reverse_synctex",
			page: 1,
			x: 144.27,
			y: 155.27,
			textBeforeSelection: "First paragraph",
			textAfterSelection: " text that should wrap a little and create boxes.",
			selectedText: "First paragraph",
			selectionStartX: 144.27,
			selectionStartY: 155.27,
			selectionEndX: 145.27,
			selectionEndY: 155.27,
		}));

		let events: Array<Record<string, unknown>> = [];
		for (let attempt = 0; attempt < 20; attempt += 1) {
			events = await service.getPdfEvents({ pdf_id: 112, max_events: 5 }) as unknown as Array<Record<string, unknown>>;
			if (events.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.equal(events.length, 1);
		const event = events[0];
		assert.deepEqual({ ...event, synctex_diagnostics: undefined, selection_start: undefined, selection_end: undefined, precision: undefined, repair: undefined, raw_mapped_source_file: undefined, raw_mapped_line: undefined, raw_mapped_column: undefined, raw_mapped_source_line: undefined }, {
			type: "reverse_synctex",
			sequence: 1,
			pdf_id: 112,
			source_file: sourcePath,
			line: 3,
			column: 6,
			source_line: "First paragraph text that should wrap a little and create boxes.",
			timestamp: event?.timestamp,
			page: 1,
			x: 144.27,
			y: 155.27,
			selected_text: "First paragraph",
			synctex_diagnostics: undefined,
			selection_start: undefined,
			selection_end: undefined,
			precision: undefined,
			repair: undefined,
			raw_mapped_source_file: undefined,
			raw_mapped_line: undefined,
			raw_mapped_column: undefined,
			raw_mapped_source_line: undefined,
		});
		assert.equal((event?.selection_start as Record<string, unknown>).source_file, sourcePath);
		assert.equal((event?.selection_end as Record<string, unknown>).source_file, sourcePath);
		const diagnostics = event?.synctex_diagnostics as {
			context: { hasSelectionContext: boolean; textBeforeSelection?: string };
			candidates: Array<{ kind: string }>;
			proposalScores?: Array<{ provenance: "synctex_reverse" | "selection_text_context"; line: number }>;
			selected: { sourceFile: string; line: number; column: number };
		};
		assert.equal(diagnostics.context.hasSelectionContext, true);
		assert.equal(diagnostics.context.textBeforeSelection, "First paragraph");
		assert.deepEqual(diagnostics.candidates.map((candidate) => candidate.kind), ["initial_candidate", "context_corrected"]);
		assert.deepEqual(diagnostics.proposalScores?.[0] === undefined ? undefined : [diagnostics.proposalScores[0].line, diagnostics.proposalScores[0].provenance], [3, "selection_text_context"]);
		assert.equal(diagnostics.proposalScores?.some((proposal) => proposal.line === 3 && proposal.provenance === "selection_text_context"), true);
		assert.equal(diagnostics.selected.sourceFile, sourcePath);
		assert.equal(diagnostics.selected.line, 3);
		assert.equal(diagnostics.selected.column, 6);
		assert.match(String(event?.timestamp), /^\d{4}-\d{2}-\d{2}T/);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("viewer socket disconnect cleanup does not unregister PDFs or invalidate pdf_ids", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-disconnect-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 6, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		const token = await getViewerSocketToken(server.origin, 6);
		const socket = await openViewerSocket(server.origin, 6, token);
		assert.equal(server.getConnectedViewerCount(6), 1);

		socket.close();
		for (let attempt = 0; attempt < 20 && server.getConnectedViewerCount(6) !== 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.equal(server.getConnectedViewerCount(6), 0);
		assert.equal(registry.getPdf(6).pdfId, 6);
		assert.equal((await fetch(`${server.origin}/config/6.json`)).status, 200);
		assert.equal((await fetch(server.pdfUrl(6, 1), { method: "HEAD" })).status, 200);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostMcpService, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import type { McpToViewerHostMessage, ViewerHostControlResponse } from "../../src/modules/viewer_host_protocol.ts";
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

async function openViewerSocket(origin: string, pdfId: number, token: string): Promise<TestWebSocket> {
	const WebSocket = socketCtor();
	const socket = new WebSocket(`${origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${pdfId}&token=${encodeURIComponent(token)}`);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out opening viewer socket for pdf_id=${pdfId}`)), 2_000);
		socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`viewer socket errored before open for pdf_id=${pdfId}`)); }, { once: true });
	});
	return socket;
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

async function nextJsonMessage(socket: TestWebSocket): Promise<Record<string, unknown>> {
	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for viewer socket message")), 2_000);
		socket.addEventListener("message", (event) => {
			clearTimeout(timer);
			const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
			resolve(JSON.parse(data) as Record<string, unknown>);
		}, { once: true });
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
}

function callTool(id: number, name: string, args: Record<string, unknown>, service: ViewerHostMcpService) {
	return handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), service.pdfOperations);
}

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

test("reverse SyncTeX viewer socket payloads flow through Host to MCP event store and get_pdf_events details", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-socket-reverse-"));
	const { pdfPath, sourcePath } = writeSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({
		registry,
		mcpEventSink: (message) => service?.handleHostMessage(message),
	});
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

		let details: { events?: Array<Record<string, unknown>> } | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(2, "get_pdf_events", { pdf_id: 112, max_events: 5 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			details = response.result?.details;
			if ((details?.events?.length ?? 0) > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.equal(details?.events?.length, 1);
		const event = details?.events?.[0];
		assert.deepEqual({ ...event, synctex_diagnostics: undefined, selection_start: undefined, selection_end: undefined, precision: undefined, repair: undefined, raw_mapped_source_file: undefined, raw_mapped_line: undefined, raw_mapped_column: undefined, raw_mapped_source_line: undefined }, {
			type: "reverse_synctex",
			sequence: 1,
			pdf_id: 112,
			source_file: sourcePath,
			line: 3,
			column: "First paragraph".length,
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
			selected: { sourceFile: string; line: number; column: number };
		};
		assert.equal(diagnostics.context.hasSelectionContext, true);
		assert.equal(diagnostics.context.textBeforeSelection, "First paragraph");
		assert.deepEqual(diagnostics.candidates.map((candidate) => candidate.kind), ["raw", "context_corrected"]);
		assert.equal(diagnostics.selected.sourceFile, sourcePath);
		assert.equal(diagnostics.selected.line, 3);
		assert.equal(diagnostics.selected.column, "First paragraph".length);
		assert.match(String(details?.events?.[0]?.timestamp), /^\d{4}-\d{2}-\d{2}T/);
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

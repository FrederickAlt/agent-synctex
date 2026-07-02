import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { PdfJsViewerMcpService, type BrowserLauncher } from "../../src/modules/pdfjs_viewer_mcp_service.ts";
import { PdfJsViewerRegistry } from "../../src/modules/pdfjs_viewer_registry.ts";
import { mapReverseSynctex } from "../../src/modules/synctex/forward_synctex.ts";

function writeFakePdf(path: string, body = "1 0 obj"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
}

function forceMtime(path: string, mtimeMs: number): void {
	const seconds = mtimeMs / 1000;
	utimesSync(path, seconds, seconds);
}

function writeFakeNativeSynctex(binDir: string, stdout: string, status = 0): void {
	mkdirSync(binDir, { recursive: true });
	const commandPath = join(binDir, "synctex");
	writeFileSync(commandPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${status});\n`);
	chmodSync(commandPath, 0o700);
}

async function withPath<T>(pathValue: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.PATH;
	process.env.PATH = pathValue;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

function writeForwardSynctexFixture(baseDir: string): { pdfPath: string; sourcePath: string } {
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	const fixtureDir = resolve("test/fixtures/synctex-forward");
	copyFileSync(join(fixtureDir, "main.tex"), sourcePath);
	copyFileSync(join(fixtureDir, "paper.synctex"), join(baseDir, "paper.synctex"));
	return { pdfPath, sourcePath };
}

function websocketAcceptKey(key: string): string {
	return createHash("sha1")
		.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
}

async function connectRawWebSocket(url: URL): Promise<Socket> {
	const socket = new Socket();
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.connect(Number(url.port), url.hostname, () => {
			socket.off("error", reject);
			resolve();
		});
	});
	const key = randomBytes(16).toString("base64");
	socket.write([
		`GET ${url.pathname}${url.search} HTTP/1.1`,
		`Host: ${url.host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Version: 13",
		`Sec-WebSocket-Key: ${key}`,
		"",
		"",
	].join("\r\n"));
	let response = "";
	while (!response.includes("\r\n\r\n")) {
		const [chunk] = await once(socket, "data") as [Buffer];
		response += chunk.toString("utf8");
	}
	assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
	assert.equal(response.toLowerCase().includes(`sec-websocket-accept: ${websocketAcceptKey(key).toLowerCase()}`), true);
	return socket;
}

function encodeClientWebSocketTextFrame(message: string): Buffer {
	const payload = Buffer.from(message, "utf8");
	const mask = Buffer.from([1, 2, 3, 4]);
	const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
	const masked = Buffer.alloc(payload.length);
	for (let index = 0; index < payload.length; index += 1) {
		masked[index] = payload[index] ^ mask[index % 4];
	}
	return Buffer.concat([header, mask, masked]);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 500;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(await predicate(), true);
}

class FakeBrowserLauncher implements BrowserLauncher {
	readonly urls: string[] = [];
	private readonly result: Awaited<ReturnType<BrowserLauncher["open"]>>;
	constructor(result: Awaited<ReturnType<BrowserLauncher["open"]>>) {
		this.result = result;
	}
	async open(url: string): ReturnType<BrowserLauncher["open"]> {
		this.urls.push(url);
		return this.result;
	}
}

test("PDF.js MCP service open_pdf validates local PDFs, returns viewer_url, and launches through injected browser boundary", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-open-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const launcher = new FakeBrowserLauncher({ ok: true, command: "fake-browser" });
	const service = new PdfJsViewerMcpService({ browserLauncher: launcher, registry: new PdfJsViewerRegistry({ makePdfId: () => 1 }) });
	try {
		const response = await service.openPdf({
			protocol_version: 1,
			request_id: "open-1",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});

		assert.equal(response.status, "ok");
		assert.equal(response.status_details.pdf, pdfPath);
		assert.equal(response.status_details.pdf_id, 1);
		assert.equal(response.status_details.revision, 1);
		assert.equal(response.status_details.managed_record?.metadata?.revision, 1);
		assert.match(response.status_details.viewer_url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/viewer\/1$/);
		assert.deepEqual(launcher.urls, [response.status_details.viewer_url]);
		assert.deepEqual(response.status_details.browser_launch, { ok: true, command: "fake-browser" });
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service open_pdf reports browser launch failure as diagnostics while still returning viewer_url", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-launch-fail-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: false, command: "fake-browser", error: "spawn failed" }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 1 }),
	});
	try {
		const response = await service.openPdf({
			protocol_version: 1,
			request_id: "open-2",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});

		assert.equal(response.status, "ok");
		assert.equal(response.status_details.pdf, pdfPath);
		assert.equal(response.status_details.pdf_id, 1);
		assert.match(response.status_details.viewer_url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/viewer\/1$/);
		assert.deepEqual(response.status_details.browser_launch, { ok: false, command: "fake-browser", error: "spawn failed" });
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service close_pdf untracks the record and reports best-effort viewer notification", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-close-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	let nextPdfId = 1;
	const registry = new PdfJsViewerRegistry({ makePdfId: () => nextPdfId++ });
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry,
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-3",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const notifications: string[] = [];
		const clientId = registry.addClient(pdfId, { send: (message) => notifications.push(message) });
		const close = await service.closePdf({
			protocol_version: 1,
			request_id: "close-3",
			operation: "close_pdf",
			created_at_ns: 2,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
		});

		assert.equal(close.status, "ok");
		assert.equal(close.status_details.closed, true);
		assert.equal(close.status_details.pdf_id, pdfId);
		assert.equal(close.status_details.viewer_notifications, 1);
		assert.deepEqual(JSON.parse(notifications[0]), { type: "pdf_closed", pdf_id: pdfId });
		assert.equal(registry.clientRecord(clientId), undefined);
		assert.match(close.status_details.reason ?? "", /browser windows may remain open/);

		const reopen = await service.openPdf({
			protocol_version: 1,
			request_id: "open-4",
			operation: "open_pdf",
			created_at_ns: 3,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		assert.notEqual(reopen.status_details.pdf_id, pdfId);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service debounces changed file snapshots before sending pdf_refresh", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-refresh-debounce-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "first");
	forceMtime(pdfPath, 1_000);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 21 });
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry,
		pdfRefresh: { autoStart: false, stabilityDebounceMs: 50 },
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-refresh-debounce",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const record = registry.getActiveRecord(pdfId);
		const notifications: string[] = [];
		registry.addClient(pdfId, { send: (message) => notifications.push(message) });

		writeFakePdf(pdfPath, "second body is larger");
		forceMtime(pdfPath, 2_000);
		await service.pollTrackedPdfChanges(100);
		await service.pollTrackedPdfChanges(130);
		assert.deepEqual(notifications, []);
		assert.equal(record.revision, 1);

		await service.pollTrackedPdfChanges(151);
		assert.equal(record.revision, 2);
		assert.equal(notifications.length, 1);
		assert.deepEqual(JSON.parse(notifications[0]), {
			type: "pdf_refresh",
			pdf_id: pdfId,
			revision: 2,
			pdf_url: `${record.viewerUrl.replace(/\/viewer\/\d+$/, "")}/pdf/${pdfId}?revision=2`,
		});
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service resets refresh debounce until the PDF snapshot is stable", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-refresh-stable-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "first");
	forceMtime(pdfPath, 1_000);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 22 });
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry,
		pdfRefresh: { autoStart: false, stabilityDebounceMs: 50 },
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-refresh-stable",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const notifications: string[] = [];
		registry.addClient(pdfId, { send: (message) => notifications.push(message) });

		writeFakePdf(pdfPath, "second");
		forceMtime(pdfPath, 2_000);
		await service.pollTrackedPdfChanges(100);
		writeFakePdf(pdfPath, "third body changes while debouncing");
		forceMtime(pdfPath, 3_000);
		await service.pollTrackedPdfChanges(140);
		await service.pollTrackedPdfChanges(189);
		assert.deepEqual(notifications, []);

		await service.pollTrackedPdfChanges(191);
		assert.equal(registry.getActiveRecord(pdfId).revision, 2);
		assert.equal(JSON.parse(notifications[0]).revision, 2);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service clears pending refresh debounce state when closing a tracked PDF", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-refresh-close-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "first");
	forceMtime(pdfPath, 1_000);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 25 });
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry,
		pdfRefresh: { autoStart: false, stabilityDebounceMs: 50 },
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-refresh-close",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		writeFakePdf(pdfPath, "second body");
		forceMtime(pdfPath, 2_000);
		await service.pollTrackedPdfChanges(100);
		assert.equal((service as unknown as { pendingRefreshes: Map<number, unknown> }).pendingRefreshes.has(pdfId), true);

		const close = await service.closePdf({
			protocol_version: 1,
			request_id: "close-refresh-close",
			operation: "close_pdf",
			created_at_ns: 2,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
		});

		assert.equal(close.status, "ok");
		assert.equal((service as unknown as { pendingRefreshes: Map<number, unknown> }).pendingRefreshes.has(pdfId), false);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service ignores missing tracked files during refresh polling", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-refresh-missing-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 23 });
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry,
		pdfRefresh: { autoStart: false, stabilityDebounceMs: 1 },
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-refresh-missing",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const notifications: string[] = [];
		registry.addClient(pdfId, { send: (message) => notifications.push(message) });

		unlinkSync(pdfPath);
		await service.pollTrackedPdfChanges(100);
		await service.pollTrackedPdfChanges(200);

		assert.equal(registry.getActiveRecord(pdfId).revision, 1);
		assert.deepEqual(notifications, []);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service markTrackedPdfUpdated refreshes an already tracked PDF immediately", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-mark-updated-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "first");
	forceMtime(pdfPath, 1_000);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 24 });
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry,
		pdfRefresh: { autoStart: false, stabilityDebounceMs: 1 },
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-mark-updated",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const notifications: string[] = [];
		registry.addClient(pdfId, { send: (message) => notifications.push(message) });

		writeFakePdf(pdfPath, "second body");
		forceMtime(pdfPath, 2_000);
		const result = await service.markTrackedPdfUpdated(pdfPath);

		assert.deepEqual(result, { tracked: true, refreshed: true, pdfId, revision: 2, viewerNotifications: 1 });
		assert.equal(JSON.parse(notifications[0]).type, "pdf_refresh");
		assert.equal(JSON.parse(notifications[0]).revision, 2);

		assert.deepEqual(await service.markTrackedPdfUpdated(pdfPath), { tracked: true, refreshed: false, pdfId, revision: 2, viewerNotifications: 0 });
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service jump_pdf maps SyncTeX, notifies viewers, and returns source-line verification", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-jump-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	let nextPdfId = 21;
	const registry = new PdfJsViewerRegistry({ makePdfId: () => nextPdfId++ });
	const launcher = new FakeBrowserLauncher({ ok: true });
	const service = new PdfJsViewerMcpService({ browserLauncher: launcher, registry });
	try {
		const binDir = join(baseDir, "bin");
		writeFakeNativeSynctex(binDir, [
			"SyncTeX result begin",
			"Output:1",
			"Page:6",
			"x:111",
			"y:222",
			"h:110",
			"v:220",
			"W:44",
			"H:7",
			"Output:2",
			"Page:6",
			"x:333",
			"y:444",
			"h:330",
			"v:440",
			"W:22",
			"H:5",
			"SyncTeX result end",
		].join("\n"));
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-jump",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const notifications: string[] = [];
		registry.addClient(pdfId, { send: (message) => notifications.push(message) });

		const jump = await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-1",
			operation: "jump_pdf",
			created_at_ns: 2,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
			line: 3,
			source_file: sourcePath,
		}));

		assert.equal(jump.status, "ok");
		assert.equal(jump.status_details.handled, true);
		assert.equal(jump.status_details.pdf_id, pdfId);
		assert.equal(jump.status_details.source_file, sourcePath);
		assert.equal(jump.status_details.line, 3);
		assert.equal(jump.status_details.source_line, "First paragraph text that should wrap a little and create boxes.");
		assert.equal(jump.status_details.page, 6);
		assert.equal(jump.status_details.x, 111);
		assert.equal(jump.status_details.y, 222);
		assert.equal(jump.status_details.synctex_branch, "native");
		const forwardDiagnostics = jump.status_details.synctex_diagnostics as {
			branch: string;
			native: { command: string; stdout: string; parsedRectangles: unknown[] };
			jsFallback?: unknown;
		};
		assert.equal(forwardDiagnostics.branch, "native");
		assert.equal(forwardDiagnostics.native.command, "synctex");
		assert.match(forwardDiagnostics.native.stdout, /SyncTeX result begin/);
		assert.deepEqual(forwardDiagnostics.native.parsedRectangles, [
			{ page: 6, h: 110, v: 220, W: 44, H: 7 },
			{ page: 6, h: 330, v: 440, W: 22, H: 5 },
		]);
		assert.equal(forwardDiagnostics.jsFallback, undefined);
		assert.deepEqual(jump.status_details.ranges, [
			{ page: 6, h: 110, v: 220, W: 44, H: 7 },
			{ page: 6, h: 330, v: 440, W: 22, H: 5 },
		]);
		assert.equal(Object.hasOwn(jump.status_details, "width"), false);
		assert.equal(Object.hasOwn(jump.status_details, "height"), false);
		assert.equal(jump.status_details.viewer_notifications, 1);
		assert.equal(jump.status_details.reason, "notified_viewers=1");

		const notification = JSON.parse(notifications[0] ?? "{}") as Record<string, unknown>;
		assert.equal(notification.type, "synctex");
		assert.equal(notification.pdf_id, pdfId);
		assert.equal(notification.page, 6);
		assert.equal(notification.x, jump.status_details.x);
		assert.equal(notification.y, jump.status_details.y);
		assert.equal(notification.source_file, sourcePath);
		assert.equal(notification.line, 3);
		assert.deepEqual(notification.ranges, jump.status_details.ranges);
		assert.equal(launcher.urls.length, 1, "jump_pdf must not launch or command a native viewer");
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service maps reverse_synctex WebSocket clicks into stored get_pdf_events results", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-reverse-synctex-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 51 }),
		pdfRefresh: { autoStart: false },
		reverseSynctexMapper: (input) => {
			if (input.x === 999999) throw new Error("stubbed endpoint mapping failure");
			return mapReverseSynctex(input);
		},
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-reverse",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const origin = new URL(open.status_details.viewer_url ?? "").origin;
		const wsUrl = new URL(`/ws?pdf_id=${pdfId}`, origin);
		wsUrl.protocol = "ws:";
		const socket = await connectRawWebSocket(wsUrl);

		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({ type: "reverse_synctex", page: 0, x: 144.27, y: 155.27 })));
		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({
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
		})));

		let events: Array<Record<string, unknown>> = [];
		await waitFor(async () => {
			const response = await handleMcpRequest(JSON.stringify({
				jsonrpc: "2.0",
				id: 70,
				method: "tools/call",
				params: { name: "get_pdf_events", arguments: { pdf_id: pdfId, max_events: 5 } },
			}), service.pdfOperations);
			assert.ok(response && "result" in response);
			events = ((response.result as { details?: { events?: Array<Record<string, unknown>> } }).details?.events) ?? [];
			return events.length === 1;
		});

		assert.equal(events.length, 1);
		const event = events[0];
		assert.equal(event.type, "reverse_synctex");
		assert.equal(event.sequence, 1);
		assert.equal(event.pdf_id, pdfId);
		assert.equal(event.source_file, sourcePath);
		assert.equal(event.line, 3);
		assert.equal(event.column, 6);
		assert.equal(event.source_line, "First paragraph text that should wrap a little and create boxes.");
		assert.equal(event.selected_text, "First paragraph");
		assert.equal((event.selection_start as Record<string, unknown>).source_file, sourcePath);
		assert.equal((event.selection_end as Record<string, unknown>).source_file, sourcePath);
		const reverseDiagnostics = event.synctex_diagnostics as {
			context: { hasSelectionContext: boolean; textBeforeSelection?: string; textAfterSelection?: string };
			candidates: Array<{ kind: string; line: number; column: number }>;
			selected: { line: number; column: number; sourceFile: string; score?: number };
		};
		assert.equal(reverseDiagnostics.context.hasSelectionContext, true);
		assert.equal(reverseDiagnostics.context.textBeforeSelection, "First paragraph");
		assert.deepEqual(reverseDiagnostics.candidates.map((candidate) => candidate.kind), ["initial_candidate", "context_corrected"]);
		assert.equal(typeof reverseDiagnostics.selected.score, "number");
		assert.deepEqual({ ...reverseDiagnostics.selected, score: undefined }, { sourceFile: sourcePath, line: 3, column: 6, sourceLine: "First paragraph text that should wrap a little and create boxes.", score: undefined });
		assert.equal(typeof event.timestamp, "string");
		assert.equal("callback" in event, false);
		assert.equal("socket_path" in event, false);
		assert.equal("synctex_callback_command" in event, false);

		const secondRead = await handleMcpRequest(JSON.stringify({
			jsonrpc: "2.0",
			id: 71,
			method: "tools/call",
			params: { name: "get_pdf_events", arguments: { pdf_id: pdfId, max_events: 5, stale: true } },
		}), service.pdfOperations);
		assert.ok(secondRead && "result" in secondRead);
		assert.deepEqual(((secondRead.result as { details: { events: Array<Record<string, unknown>> } }).details.events).map((item) => item.sequence), [1]);
		const text = (secondRead.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
		assert.match(text, /selected_text=First paragraph/);
		assert.match(text, /selection_start=.*line=3:column=0/);
		assert.match(text, /selection_end=.*line=3:column=14/);

		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({
			type: "reverse_synctex",
			page: 1,
			x: 144.27,
			y: 155.27,
			selectedText: "bad endpoint",
			selectionStartX: 999999,
			selectionStartY: 999999,
			selectionEndX: 144.27,
			selectionEndY: 155.27,
		})));
		let endpointFailureEvent: Record<string, unknown> | undefined;
		await waitFor(async () => {
			const response = await handleMcpRequest(JSON.stringify({
				jsonrpc: "2.0",
				id: 72,
				method: "tools/call",
				params: { name: "get_pdf_events", arguments: { pdf_id: pdfId, max_events: 5 } },
			}), service.pdfOperations);
			assert.ok(response && "result" in response);
			const nextEvents = ((response.result as { details?: { events?: Array<Record<string, unknown>> } }).details?.events) ?? [];
			endpointFailureEvent = nextEvents.at(-1);
			return endpointFailureEvent?.selected_text === "bad endpoint";
		});
		assert.equal(endpointFailureEvent?.line, 3, "main point event should still be stored when a selected range has endpoint mapping work");
		assert.equal(endpointFailureEvent?.selected_text, "bad endpoint");
		assert.equal(endpointFailureEvent?.selection_start_error, "stubbed endpoint mapping failure");
		assert.equal(endpointFailureEvent?.selection_start, undefined);
		assert.ok(endpointFailureEvent?.selection_end, "successful endpoint should still be exposed");

		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({
			type: "reverse_synctex",
			page: 1,
			x: 144.27,
			y: 155.27,
			selectedText: "text that should wrap",
			selectionStartX: 999999,
			selectionStartY: 999999,
			selectionEndX: 999999,
			selectionEndY: 999999,
		})));
		let repairedEndpointEvent: Record<string, unknown> | undefined;
		await waitFor(async () => {
			const response = await handleMcpRequest(JSON.stringify({
				jsonrpc: "2.0",
				id: 73,
				method: "tools/call",
				params: { name: "get_pdf_events", arguments: { pdf_id: pdfId, max_events: 5 } },
			}), service.pdfOperations);
			assert.ok(response && "result" in response);
			const nextEvents = ((response.result as { details?: { events?: Array<Record<string, unknown>> } }).details?.events) ?? [];
			repairedEndpointEvent = nextEvents.at(-1);
			return repairedEndpointEvent?.selected_text === "text that should wrap";
		});
		assert.equal(repairedEndpointEvent?.selected_text, "text that should wrap");
		assert.equal((repairedEndpointEvent?.selection_start as Record<string, unknown>).line, 3);
		assert.equal((repairedEndpointEvent?.selection_start as Record<string, unknown>).column, 16);
		assert.equal((repairedEndpointEvent?.selection_end as Record<string, unknown>).line, 3);
		assert.equal((repairedEndpointEvent?.selection_end as Record<string, unknown>).column, 36);
		assert.equal(repairedEndpointEvent?.selection_start_error, undefined);
		socket.end();
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service maps selected range endpoints through robust reverse context and preserves exact selected_text", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-selection-robust-"));
	const { pdfPath } = writeForwardSynctexFixture(baseDir);
	const calls: Array<{ x: number; textBeforeSelection?: string; textAfterSelection?: string }> = [];
	const sourcePath = join(baseDir, "main.tex");
	const makeLocation = (input: { page: number; x: number; y: number; textBeforeSelection?: string; textAfterSelection?: string }, line: number, rawLine?: number) => ({
		page: input.page,
		x: input.x,
		y: input.y,
		sourceFile: sourcePath,
		line,
		column: 4,
		sourceLine: `line ${line}`,
		sidecarPath: join(baseDir, "paper.synctex"),
		precision: rawLine === undefined ? "line" : "verified",
		...(rawLine === undefined ? {} : { rawMappedSourceFile: sourcePath, rawMappedLine: rawLine, rawMappedColumn: 0, rawMappedSourceLine: "\\end{document}" }),
		diagnostics: {
			branch: "js",
			lookupInput: { pdfPath, page: input.page, x: input.x, y: input.y, sidecarPath: join(baseDir, "paper.synctex") },
			native: { command: "synctex", args: [], cwd: baseDir, attempted: false, role: "fallback" as const },
			js: { attempted: true, role: "primary" as const },
			context: { hasSelectionContext: input.textBeforeSelection !== undefined || input.textAfterSelection !== undefined, ...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }), ...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }) },
			candidates: [],
			selected: { sourceFile: sourcePath, line, column: 4, sourceLine: `line ${line}` },
			precision: rawLine === undefined ? "line" : "verified",
			...(rawLine === undefined ? {} : { textRepair: { used: true, status: "unique" as const, fragmentsTried: ["Browser EXACT"], matchCount: 1, selectedFragment: "Browser EXACT", line, column: 4 }, rawWinner: { line: rawLine, sourceLine: "\\end{document}" }, topCandidates: [{ line: rawLine, sourceLine: "\\end{document}" }] }),
		},
	}) as ReturnType<typeof mapReverseSynctex>;
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 128 }),
		pdfRefresh: { autoStart: false },
		reverseSynctexMapper: (input) => {
			calls.push({ x: input.x, ...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }), ...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }) });
			if (input.x === 10) return makeLocation(input, 66, 78);
			if (input.x === 20) return makeLocation(input, 67, 79);
			return makeLocation(input, 65);
		},
	});
	try {
		const open = await service.openPdf({ protocol_version: 1, request_id: "open-selection-robust", operation: "open_pdf", created_at_ns: 1, workspace_context: { cwd: baseDir }, details: { pdf_path: pdfPath } });
		const pdfId = open.status_details.pdf_id ?? 0;
		const origin = new URL(open.status_details.viewer_url ?? "").origin;
		const wsUrl = new URL(`/ws?pdf_id=${pdfId}`, origin);
		wsUrl.protocol = "ws:";
		const socket = await connectRawWebSocket(wsUrl);
		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({
			type: "reverse_synctex",
			page: 2,
			x: 15,
			y: 200,
			textBeforeSelection: "Before ",
			textAfterSelection: " After",
			selectedText: "Browser EXACT",
			selectionStartX: 10,
			selectionStartY: 201,
			selectionEndX: 20,
			selectionEndY: 202,
		})));

		let event: Record<string, unknown> | undefined;
		await waitFor(async () => {
			const response = await handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 128, method: "tools/call", params: { name: "get_pdf_events", arguments: { pdf_id: pdfId, max_events: 5 } } }), service.pdfOperations);
			assert.ok(response && "result" in response);
			event = ((response.result as { details?: { events?: Array<Record<string, unknown>> } }).details?.events ?? [])[0];
			return event?.selected_text === "Browser EXACT";
		});
		assert.equal(event?.selected_text, "Browser EXACT");
		assert.deepEqual(calls.map((call) => ({ x: call.x, before: call.textBeforeSelection, after: call.textAfterSelection })), [
			{ x: 15, before: "Before ", after: " After" },
			{ x: 10, before: "Before ", after: "Browser EXACT" },
			{ x: 20, before: "Browser EXACT", after: " After" },
		]);
		const start = event?.selection_start as Record<string, unknown>;
		assert.equal(start.line, 66);
		assert.equal(start.precision, "verified");
		assert.equal(start.repair, "text_context");
		assert.equal(start.raw_mapped_line, 78);
		assert.equal(start.raw_mapped_source_line, "\\end{document}");
		assert.ok((start.synctex_diagnostics as Record<string, unknown>).topCandidates);
		const end = event?.selection_end as Record<string, unknown>;
		assert.equal(end.line, 67);
		assert.equal(end.raw_mapped_line, 79);
		socket.end();
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service get_pdf_events details include normalized formula excerpt for closing delimiter hits", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-reverse-formula-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	writeFileSync(sourcePath, ["\\begin{equation}", "  a = b + c", "\\end{equation}", ""].join("\n"));
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 53 }),
		pdfRefresh: { autoStart: false },
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-reverse-formula",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const origin = new URL(open.status_details.viewer_url ?? "").origin;
		const wsUrl = new URL(`/ws?pdf_id=${pdfId}`, origin);
		wsUrl.protocol = "ws:";
		const socket = await connectRawWebSocket(wsUrl);

		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({ type: "reverse_synctex", page: 1, x: 144.27, y: 155.27 })));

		let events: Array<Record<string, unknown>> = [];
		await waitFor(async () => {
			const response = await handleMcpRequest(JSON.stringify({
				jsonrpc: "2.0",
				id: 73,
				method: "tools/call",
				params: { name: "get_pdf_events", arguments: { pdf_id: pdfId, max_events: 5 } },
			}), service.pdfOperations);
			assert.ok(response && "result" in response);
			events = ((response.result as { details?: { events?: Array<Record<string, unknown>> } }).details?.events) ?? [];
			return events.length === 1;
		});

		assert.equal(events[0]?.raw_mapped_line, 3);
		assert.equal(events[0]?.raw_mapped_source_line, "\\end{equation}");
		assert.deepEqual(events[0]?.normalized_formula_span, { source_file: sourcePath, start_line: 1, end_line: 3 });
		assert.equal(events[0]?.normalized_formula_excerpt, "\\begin{equation}\n  a = b + c\n\\end{equation}");
		socket.end();
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service preserves reverse_synctex WebSocket frames split across TCP chunks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-reverse-synctex-split-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 52 }),
		pdfRefresh: { autoStart: false },
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-reverse-split",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;
		const origin = new URL(open.status_details.viewer_url ?? "").origin;
		const wsUrl = new URL(`/ws?pdf_id=${pdfId}`, origin);
		wsUrl.protocol = "ws:";
		const socket = await connectRawWebSocket(wsUrl);

		const frame = encodeClientWebSocketTextFrame(JSON.stringify({ type: "reverse_synctex", page: 1, x: 144.27, y: 155.27 }));
		const splitAt = Math.floor(frame.length / 2);
		socket.write(frame.subarray(0, splitAt));
		await new Promise((resolve) => setTimeout(resolve, 20));
		socket.write(frame.subarray(splitAt));

		let events: Array<Record<string, unknown>> = [];
		await waitFor(async () => {
			const response = await handleMcpRequest(JSON.stringify({
				jsonrpc: "2.0",
				id: 72,
				method: "tools/call",
				params: { name: "get_pdf_events", arguments: { pdf_id: pdfId, max_events: 5 } },
			}), service.pdfOperations);
			assert.ok(response && "result" in response);
			events = ((response.result as { details?: { events?: Array<Record<string, unknown>> } }).details?.events) ?? [];
			return events.length === 1;
		});

		assert.equal(events[0].source_file, sourcePath);
		assert.equal(events[0].line, 3);
		socket.end();
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service jump_pdf accepts symlink source_file when its realpath matches SyncTeX input", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-jump-symlink-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const symlinkPath = join(baseDir, "linked-main.tex");
	symlinkSync(sourcePath, symlinkPath);
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 24 }),
	});
	try {
		await service.openPdf({
			protocol_version: 1,
			request_id: "open-symlink",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});

		const jump = await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-symlink",
			operation: "jump_pdf",
			created_at_ns: 2,
			workspace_context: { cwd: baseDir },
			pdf_id: 24,
			line: 3,
			source_file: symlinkPath,
		});

		assert.equal(jump.status, "ok");
		assert.equal(jump.status_details.source_file, symlinkPath);
		assert.equal(jump.status_details.source_line, "First paragraph text that should wrap a little and create boxes.");
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js MCP service jump_pdf reports clear errors for unknown pdf_id, missing source, missing sidecar, and unmappable lines", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-jump-errors-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 31 });
	const service = new PdfJsViewerMcpService({ browserLauncher: new FakeBrowserLauncher({ ok: true }), registry });
	try {
		const unknown = await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-unknown",
			operation: "jump_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			pdf_id: 999,
			line: 3,
			source_file: sourcePath,
		});
		assert.equal(unknown.status, "error");
		assert.match(unknown.error ?? "", /Unknown pdf_id=999/);

		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-errors",
			operation: "open_pdf",
			created_at_ns: 2,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;

		const missingSource = await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-missing-source",
			operation: "jump_pdf",
			created_at_ns: 3,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
			line: 3,
			source_file: join(baseDir, "missing.tex"),
		});
		assert.equal(missingSource.status, "error");
		assert.match(missingSource.error ?? "", /Cannot stat source_file/);

		unlinkSync(join(baseDir, "paper.synctex"));
		const missingSidecar = await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-missing-sidecar",
			operation: "jump_pdf",
			created_at_ns: 4,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
			line: 3,
			source_file: sourcePath,
		});
		assert.equal(missingSidecar.status, "error");
		assert.match(missingSidecar.error ?? "", /missing SyncTeX sidecar/);

		writeForwardSynctexFixture(baseDir);
		const unmappedSourcePath = join(baseDir, "unmapped.tex");
		writeFileSync(unmappedSourcePath, "Readable source absent from SyncTeX inputs.\n");
		const unmappable = await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-unmappable",
			operation: "jump_pdf",
			created_at_ns: 5,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
			line: 1,
			source_file: unmappedSourcePath,
		});
		assert.equal(unmappable.status, "error");
		assert.match(unmappable.error ?? "", /No usable SyncTeX mapping found.*unmapped\.tex:1/i);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("MCP jump_pdf resolves relative source_file against workspace_context.cwd", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-jump-relative-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 41 }),
	});
	try {
		await service.openPdf({
			protocol_version: 1,
			request_id: "open-relative",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const response = await handleMcpRequest(JSON.stringify({
			jsonrpc: "2.0",
			id: 12,
			method: "tools/call",
			params: { name: "jump_pdf", arguments: { pdf_id: 41, line: 3, source_file: "main.tex", workspace_context: { cwd: baseDir } } },
		}), service.pdfOperations);

		assert.ok(response && "result" in response);
		const result = response.result as { details: { source_file: string; source_line: string }; content: Array<{ text: string }> };
		assert.equal(result.details.source_file, sourcePath);
		assert.equal(result.details.source_line, "First paragraph text that should wrap a little and create boxes.");
		assert.match(result.content[0].text, /line 3 contains:\nFirst paragraph text that should wrap a little and create boxes\./);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("MCP close_pdf tool is removed even when PDF.js service has an internal close operation", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-close-tool-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	let nextPdfId = 1;
	const registry = new PdfJsViewerRegistry({ makePdfId: () => nextPdfId++ });
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry,
	});
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "open-close-tool",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		const pdfId = open.status_details.pdf_id ?? 0;

		const response = await handleMcpRequest(JSON.stringify({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "close_pdf", arguments: { pdf_id: pdfId } },
		}), service.pdfOperations);

		assert.ok(response && "result" in response);
		const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Tool not implemented by runtime: close_pdf/);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("MCP open_pdf tool returns pdf_id, pdf, and viewer_url from the PDF.js service", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-mcp-tool-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const service = new PdfJsViewerMcpService({
		browserLauncher: new FakeBrowserLauncher({ ok: true }),
		registry: new PdfJsViewerRegistry({ makePdfId: () => 1 }),
	});
	try {
		const response = await handleMcpRequest(JSON.stringify({
			jsonrpc: "2.0",
			id: 10,
			method: "tools/call",
			params: { name: "open_pdf", arguments: { pdf_file_path: "paper.pdf", workspace_context: { cwd: baseDir } } },
		}), service.pdfOperations);

		assert.equal(response?.id, 10);
		assert.equal("error" in (response ?? {}), false);
		assert.ok(response && "result" in response);
		const result = response.result as { details: { pdf_id: number; pdf: string; viewer_url: string }; content: Array<{ text: string }> };
		assert.equal(result.details.pdf, pdfPath);
		assert.equal(result.details.pdf_id, 1);
		assert.match(result.details.viewer_url, /^http:\/\/127\.0\.0\.1:\d+\/viewer\/1$/);
		assert.match(result.content[0].text, /viewer_url=http:\/\/127\.0\.0\.1:/);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

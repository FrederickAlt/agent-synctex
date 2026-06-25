import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { PdfJsViewerMcpService, type BrowserLauncher } from "../../src/modules/pdfjs_viewer_mcp_service.ts";
import { PdfJsViewerRegistry } from "../../src/modules/pdfjs_viewer_registry.ts";

function writeFakePdf(path: string, body = "1 0 obj"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
}

function forceMtime(path: string, mtimeMs: number): void {
	const seconds = mtimeMs / 1000;
	utimesSync(path, seconds, seconds);
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

test("MCP close_pdf tool reports PDF.js untrack/notify semantics without claiming browser closure", async () => {
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
		registry.addClient(pdfId, { send: () => undefined });

		const response = await handleMcpRequest(JSON.stringify({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "close_pdf", arguments: { pdf_id: pdfId } },
		}), service.pdfOperations);

		assert.ok(response && "result" in response);
		const result = response.result as { details: { viewer_notifications: number }; content: Array<{ text: string }> };
		assert.equal(result.details.viewer_notifications, 1);
		assert.match(result.content[0].text, /untracked/);
		assert.match(result.content[0].text, /notified_viewers=1/);
		assert.match(result.content[0].text, /browser_windows_may_remain_open/);
		assert.doesNotMatch(result.content[0].text, /\bclosed\b/);
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

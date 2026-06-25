import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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

function writeForwardSynctexFixture(baseDir: string): { pdfPath: string; sourcePath: string } {
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nJump target text.\n\\end{document}\n% unmapped tail 1\n% unmapped tail 2\n% unmapped tail 3\n");
	writeFileSync(join(baseDir, "paper.synctex"), [
		"SyncTeX Version:1",
		"Input:1:main.tex",
		"Output:pdf",
		"Unit:1",
		"Content:",
		"{1",
		"h1,3:7208960,14417920:1000000,500000,0",
		"}",
		"Postamble:",
		"Count:0",
		"",
	].join("\n"));
	return { pdfPath, sourcePath };
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

		const jump = await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-1",
			operation: "jump_pdf",
			created_at_ns: 2,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
			line: 3,
			source_file: sourcePath,
		});

		assert.equal(jump.status, "ok");
		assert.equal(jump.status_details.handled, true);
		assert.equal(jump.status_details.pdf_id, pdfId);
		assert.equal(jump.status_details.source_file, sourcePath);
		assert.equal(jump.status_details.line, 3);
		assert.equal(jump.status_details.source_line, "Jump target text.");
		assert.equal(jump.status_details.page, 1);
		assert.equal(jump.status_details.x, 110);
		assert.equal(jump.status_details.y, 220);
		assert.equal(jump.status_details.viewer_notifications, 1);
		assert.equal(jump.status_details.reason, "notified_viewers=1");
		assert.deepEqual(JSON.parse(notifications[0]), {
			type: "synctex",
			pdf_id: pdfId,
			page: 1,
			x: 110,
			y: 220,
			source_file: sourcePath,
			line: 3,
		});
		assert.equal(launcher.urls.length, 1, "jump_pdf must not launch or command a native viewer");
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
		assert.equal(jump.status_details.source_line, "Jump target text.");
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
		const unmappable = await service.jumpPdf({
			protocol_version: 1,
			request_id: "jump-unmappable",
			operation: "jump_pdf",
			created_at_ns: 5,
			workspace_context: { cwd: baseDir },
			pdf_id: pdfId,
			line: 7,
			source_file: sourcePath,
		});
		assert.equal(unmappable.status, "error");
		assert.match(unmappable.error ?? "", /No SyncTeX mapping found.*main\.tex:7/i);
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
		assert.equal(result.details.source_line, "Jump target text.");
		assert.match(result.content[0].text, /line 3 contains:\nJump target text\./);
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

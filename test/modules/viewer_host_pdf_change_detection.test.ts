import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

interface TestWebSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
}

function socketCtor(): new (url: string) => TestWebSocket {
	const ctor = (globalThis as { WebSocket?: new (url: string) => TestWebSocket }).WebSocket;
	assert.ok(ctor, "global WebSocket must be available in the Node test runtime");
	return ctor;
}

function writeFakePdf(path: string, body: string, mtimeSeconds: number): { size: number; mtimeMs: number } {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
	utimesSync(path, mtimeSeconds, mtimeSeconds);
	return snapshotPdf(path);
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

async function getViewerSocketToken(origin: string, pdfId: number): Promise<string> {
	const response = await fetch(`${origin}/config/${pdfId}.json`);
	assert.equal(response.status, 200);
	const config = await response.json() as { viewer_socket_token?: unknown };
	assert.equal(typeof config.viewer_socket_token, "string");
	return String(config.viewer_socket_token);
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
		const timer = setTimeout(resolve, 120);
		socket.addEventListener("message", (event) => {
			clearTimeout(timer);
			reject(new Error(`unexpected viewer socket message: ${String(event.data)}`));
		}, { once: true });
	});
}

test("Viewer Host file-change verification does not refresh unchanged registered PDFs", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-refresh-unchanged-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const initialSnapshot = writeFakePdf(pdfPath, "initial stable body", 1_700_000_001);
	let nowMs = 10_000;
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, pdfChangeDetection: { debounceMs: 50, pollIntervalMs: 0, nowMs: () => nowMs } });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 1, pdfPath, title: basename(pdfPath), revision: 3, fileSnapshot: initialSnapshot });
		await server.start();
		socket = await openViewerSocket(server.origin, 1, await getViewerSocketToken(server.origin, 1));

		await server.verifyPdfChangesNow();
		nowMs += 100;
		await server.verifyPdfChangesNow();

		assert.equal(registry.getPdf(1).revision, 3);
		assert.deepEqual(registry.getPdf(1).fileSnapshot, initialSnapshot);
		assert.equal(server.getPdfRefreshDiagnostic(1), undefined);
		await assertNoMessage(socket);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host increments revision and broadcasts pdf_refresh after a stable size/mtime change", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-refresh-stable-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "initial", 1_700_000_010);
	let nowMs = 20_000;
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, pdfChangeDetection: { debounceMs: 75, pollIntervalMs: 0, nowMs: () => nowMs } });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 2, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		socket = await openViewerSocket(server.origin, 2, await getViewerSocketToken(server.origin, 2));

		const changedSnapshot = writeFakePdf(pdfPath, "changed content with deterministic size", 1_700_000_011);
		await server.verifyPdfChangesNow();
		assert.equal(registry.getPdf(2).revision, 1, "first changed snapshot only starts debounce");
		nowMs += 74;
		await server.verifyPdfChangesNow();
		assert.equal(registry.getPdf(2).revision, 1, "snapshot must be stable for the full debounce window");
		nowMs += 1;
		const refresh = nextJsonMessage(socket);
		await server.verifyPdfChangesNow();

		assert.equal(registry.getPdf(2).revision, 2);
		assert.deepEqual(registry.getPdf(2).fileSnapshot, changedSnapshot);
		assert.equal(registry.getPdf(2).workspaceCwd, baseDir, "file refresh must preserve workspace identity used by reverse SyncTeX");
		assert.deepEqual(await refresh, { type: "pdf_refresh", pdf_id: 2, revision: 2, pdf_url: `${server.origin}/pdf/2?revision=2` });
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host debounces rapid repeated PDF changes and refreshes once for the latest stable snapshot", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-refresh-debounce-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "initial", 1_700_000_020);
	let nowMs = 30_000;
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, pdfChangeDetection: { debounceMs: 100, pollIntervalMs: 0, nowMs: () => nowMs } });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 3, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		socket = await openViewerSocket(server.origin, 3, await getViewerSocketToken(server.origin, 3));

		writeFakePdf(pdfPath, "short intermediate", 1_700_000_021);
		await server.verifyPdfChangesNow();
		nowMs += 60;
		const latestSnapshot = writeFakePdf(pdfPath, "latest stable body with different size", 1_700_000_022);
		await server.verifyPdfChangesNow();
		nowMs += 99;
		await server.verifyPdfChangesNow();
		assert.equal(registry.getPdf(3).revision, 1);
		nowMs += 1;
		const refresh = nextJsonMessage(socket);
		await server.verifyPdfChangesNow();

		assert.equal(registry.getPdf(3).revision, 2);
		assert.deepEqual(registry.getPdf(3).fileSnapshot, latestSnapshot);
		assert.deepEqual(await refresh, { type: "pdf_refresh", pdf_id: 3, revision: 2, pdf_url: `${server.origin}/pdf/3?revision=2` });
		await assertNoMessage(socket);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host records diagnostics for missing PDFs without crashing or incrementing revision", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-refresh-missing-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "initial", 1_700_000_030);
	let nowMs = 40_000;
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, pdfChangeDetection: { debounceMs: 25, pollIntervalMs: 0, nowMs: () => nowMs } });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 4, pdfPath, title: basename(pdfPath), revision: 5, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		socket = await openViewerSocket(server.origin, 4, await getViewerSocketToken(server.origin, 4));
		rmSync(pdfPath);

		await server.verifyPdfChangesNow();
		nowMs += 100;
		await server.verifyPdfChangesNow();

		assert.equal(registry.getPdf(4).revision, 5);
		assert.deepEqual(server.getPdfRefreshDiagnostic(4), {
			pdf_id: 4,
			status: "error",
			code: "pdf_not_readable",
			message: "registered PDF is not readable",
		});
		await assertNoMessage(socket);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host records diagnostics when stat succeeds but read-open fails before refresh", async () => {
	let nowMs = 45_000;
	let readOpenAttempts = 0;
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({
		registry,
		fileSystem: {
			async stat() {
				return { size: 20, mtimeMs: 2, isFile: () => true };
			},
			createReadStream() {
				readOpenAttempts += 1;
				const stream = new Readable({ read() {} });
				queueMicrotask(() => stream.destroy(Object.assign(new Error("EACCES: permission denied, open '/virtual/unreadable.pdf'"), { code: "EACCES" })));
				return stream;
			},
		},
		pdfChangeDetection: { debounceMs: 25, pollIntervalMs: 0, nowMs: () => nowMs },
	});
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 8, pdfPath: "/virtual/unreadable.pdf", title: "unreadable.pdf", revision: 1, fileSnapshot: { size: 10, mtimeMs: 1 } });
		await server.start();
		socket = await openViewerSocket(server.origin, 8, await getViewerSocketToken(server.origin, 8));

		await server.verifyPdfChangesNow();
		nowMs += 25;

		assert.equal(readOpenAttempts, 1);
		assert.equal(registry.getPdf(8).revision, 1);
		assert.deepEqual(registry.getPdf(8).fileSnapshot, { size: 10, mtimeMs: 1 });
		assert.deepEqual(server.getPdfRefreshDiagnostic(8), {
			pdf_id: 8,
			status: "error",
			code: "pdf_not_readable",
			message: "registered PDF is not readable",
		});
		await assertNoMessage(socket);
	} finally {
		socket?.close();
		await server.stop();
	}
});

test("pdf_maybe_updated triggers Host verification but does not directly increment revision", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-refresh-hint-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "initial", 1_700_000_040);
	let nowMs = 50_000;
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, pdfChangeDetection: { debounceMs: 50, pollIntervalMs: 0, nowMs: () => nowMs } });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 5, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		socket = await openViewerSocket(server.origin, 5, await getViewerSocketToken(server.origin, 5));
		const client = new ViewerHostControlClient({ origin: server.origin });

		writeFakePdf(pdfPath, "changed via maybe updated", 1_700_000_041);
		assert.deepEqual(await client.send({ type: "pdf_maybe_updated", pdf_id: 5 }), { ok: true, result: { type: "pdf_maybe_updated", pdf_id: 5 } });
		assert.equal(registry.getPdf(5).revision, 1, "hint verifies and starts debounce, but does not directly bump revision");
		await assertNoMessage(socket);

		nowMs += 50;
		const refresh = nextJsonMessage(socket);
		assert.deepEqual(await client.send({ type: "pdf_maybe_updated", pdf_id: 5 }), { ok: true, result: { type: "pdf_maybe_updated", pdf_id: 5 } });
		assert.equal(registry.getPdf(5).revision, 2);
		assert.deepEqual(await refresh, { type: "pdf_refresh", pdf_id: 5, revision: 2, pdf_url: `${server.origin}/pdf/5?revision=2` });
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host refresh broadcasts from file-change detection are targeted to viewers for the changed pdf_id", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-refresh-targeted-"));
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	writeFakePdf(firstPdf, "first initial", 1_700_000_050);
	writeFakePdf(secondPdf, "second initial", 1_700_000_050);
	let nowMs = 60_000;
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, pdfChangeDetection: { debounceMs: 10, pollIntervalMs: 0, nowMs: () => nowMs } });
	let firstSocket: TestWebSocket | undefined;
	let secondSocket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 6, pdfPath: firstPdf, title: basename(firstPdf), revision: 1, fileSnapshot: snapshotPdf(firstPdf) });
		registry.registerPdf({ pdfId: 7, pdfPath: secondPdf, title: basename(secondPdf), revision: 8, fileSnapshot: snapshotPdf(secondPdf) });
		await server.start();
		firstSocket = await openViewerSocket(server.origin, 6, await getViewerSocketToken(server.origin, 6));
		secondSocket = await openViewerSocket(server.origin, 7, await getViewerSocketToken(server.origin, 7));

		writeFakePdf(secondPdf, "second changed only", 1_700_000_051);
		await server.verifyPdfChangesNow();
		nowMs += 10;
		const secondRefresh = nextJsonMessage(secondSocket);
		const firstNoRefresh = assertNoMessage(firstSocket);
		await server.verifyPdfChangesNow();

		assert.equal(registry.getPdf(6).revision, 1);
		assert.equal(registry.getPdf(7).revision, 9);
		assert.deepEqual(await secondRefresh, { type: "pdf_refresh", pdf_id: 7, revision: 9, pdf_url: `${server.origin}/pdf/7?revision=9` });
		await firstNoRefresh;
	} finally {
		firstSocket?.close();
		secondSocket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

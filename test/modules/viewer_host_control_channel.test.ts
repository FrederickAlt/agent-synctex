import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostPdfRegistry, type ViewerHostPdfRecord } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer, type ViewerHostViewerDispatch } from "../../src/modules/viewer_host_server.ts";
import { VIEWER_HOST_CONTROL_TOKEN_HEADER, type ViewerHostSynctexForwardMessage } from "../../src/modules/viewer_host_protocol.ts";

function writeFakePdf(path: string, body = "body"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

async function readHttp(url: string): Promise<{ status: number; body: Buffer }> {
	const response = await fetch(url);
	return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

class FakeViewerDispatch implements ViewerHostViewerDispatch {
	readonly events: Array<{ type: string; pdfId: number; revision?: number; payload?: unknown }> = [];

	async openPdf(record: ViewerHostPdfRecord): Promise<void> {
		this.events.push({ type: "open_pdf", pdfId: record.pdfId, revision: record.revision });
	}

	async focusPdf(record: ViewerHostPdfRecord): Promise<void> {
		this.events.push({ type: "focus_pdf", pdfId: record.pdfId, revision: record.revision });
	}

	async synctexForward(message: ViewerHostSynctexForwardMessage, record: ViewerHostPdfRecord): Promise<void> {
		this.events.push({ type: "synctex_forward", pdfId: record.pdfId, revision: record.revision, payload: message });
	}
}

test("Viewer Host control channel accepts hello and records protocol readiness", async () => {
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });

		const response = await client.send({ type: "hello", protocol_version: 3 });

		assert.deepEqual(response, { ok: true, message: { type: "ready", protocol_version: 3, origin: server.origin, instance_id: server.instanceId, active_viewer_clients: 0 } });
		assert.deepEqual(server.controlStatus, { ready: true, protocolVersion: 3 });
	} finally {
		await server.stop();
	}
});

test("Viewer Host control client bounds stalled requests and rejects malformed responses", async () => {
	const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		const fallback = setTimeout(() => reject(new Error("test fetch did not abort")), 1_000);
		if (signal?.aborted) {
			clearTimeout(fallback);
			reject(signal.reason);
		} else signal?.addEventListener("abort", () => {
			clearTimeout(fallback);
			reject(signal.reason);
		}, { once: true });
	})) as typeof fetch;
	const stalledClient = new ViewerHostControlClient({ origin: "http://127.0.0.1:43125", fetchImpl: stalledFetch, requestTimeoutMs: 20 });
	await assert.rejects(() => stalledClient.send({ type: "hello", protocol_version: 3 }));

	const malformedClient = new ViewerHostControlClient({
		origin: "http://127.0.0.1:43125",
		fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
	});
	await assert.rejects(() => malformedClient.send({ type: "hello", protocol_version: 3 }), /malformed JSON/);

	const invalidClient = new ViewerHostControlClient({
		origin: "http://127.0.0.1:43125",
		fetchImpl: (async () => new Response(JSON.stringify({ ok: true, message: { type: "ready", protocol_version: 3, origin: "http://127.0.0.1:43125" } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
	});
	await assert.rejects(() => invalidClient.send({ type: "hello", protocol_version: 3 }), /instance_id/);
});

test("Viewer Host MCP endpoints require the configured owner token", async () => {
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, controlToken: "owner-token" });
	try {
		await server.start();
		const unauthorized = await fetch(`${server.origin}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "hello", protocol_version: 3 }) });
		assert.equal(unauthorized.status, 403);
		const unauthorizedDrain = await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" });
		assert.equal(unauthorizedDrain.status, 403);
		assert.equal((await fetch(`${server.origin}/marks/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
		assert.equal((await fetch(`${server.origin}/marks/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim_id: "claim", consumed: [] }) })).status, 403);

		const client = new ViewerHostControlClient({ origin: server.origin, controlToken: "owner-token" });
		assert.equal((await client.send({ type: "hello", protocol_version: 3 })).ok, true);
		const authorizedDrain = await fetch(`${server.origin}/mcp-events/drain`, { method: "POST", headers: { [VIEWER_HOST_CONTROL_TOKEN_HEADER]: "owner-token" } });
		assert.equal(authorizedDrain.status, 200);
	} finally {
		await server.stop();
	}
});


test("Viewer Host control channel registers and re-registers open_pdf with MCP-provided ids", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-control-open-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "first");
	const registry = new ViewerHostPdfRegistry();
	const viewerDispatch = new FakeViewerDispatch();
	const server = new ViewerHostServer({ registry, viewerDispatch });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });

		const first = await client.send({ type: "open_pdf", pdf_id: 33, pdf_path: pdfPath, title: "paper.pdf" });
		assert.equal(first.ok, true);
		assert.deepEqual(registry.getPdf(33), {
			pdfId: 33,
			pdfPath,
			title: "paper.pdf",
			revision: 1,
			fileSnapshot: snapshotPdf(pdfPath),
			registeredAtNs: registry.getPdf(33).registeredAtNs,
			updatedAtNs: registry.getPdf(33).updatedAtNs,
		});

		writeFakePdf(pdfPath, "second body");
		const second = await client.send({ type: "open_pdf", pdf_id: 33, pdf_path: pdfPath, title: "Renamed" });
		assert.equal(second.ok, true);
		assert.equal(registry.getPdf(33).title, "Renamed");
		assert.deepEqual(registry.getPdf(33).fileSnapshot, snapshotPdf(pdfPath));
		assert.deepEqual(viewerDispatch.events.map((event) => event.type), ["open_pdf", "open_pdf"]);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host control channel bumps revision when re-registering a changed PDF snapshot", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-control-reregister-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "first body");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });

		const first = await client.send({ type: "open_pdf", pdf_id: 44, pdf_path: pdfPath, title: "paper.pdf" });
		assert.deepEqual(first, { ok: true, result: { type: "open_pdf", pdf_id: 44, revision: 1 } });
		const oldUrl = server.pdfUrl(44, 1);
		assert.equal(registry.getPdf(44).revision, 1);

		const identical = await client.send({ type: "open_pdf", pdf_id: 44, pdf_path: pdfPath, title: "paper.pdf" });
		assert.deepEqual(identical, { ok: true, result: { type: "open_pdf", pdf_id: 44, revision: 1 } });
		assert.equal(registry.getPdf(44).revision, 1);

		writeFakePdf(pdfPath, "changed body");
		const currentBytes = Buffer.from(`%PDF-1.4\nchanged body\n%%EOF\n`, "utf8");
		const second = await client.send({ type: "open_pdf", pdf_id: 44, pdf_path: pdfPath, title: "paper.pdf" });

		assert.deepEqual(second, { ok: true, result: { type: "open_pdf", pdf_id: 44, revision: 2 } });
		assert.equal(registry.getPdf(44).revision, 2);
		assert.equal((await readHttp(oldUrl)).status, 404);
		const current = await readHttp(server.pdfUrl(44, 2));
		assert.equal(current.status, 200);
		assert.deepEqual(current.body, currentBytes);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host control channel focuses registered PDFs and reports unknown ids clearly", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-control-focus-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const viewerDispatch = new FakeViewerDispatch();
	const server = new ViewerHostServer({ registry, viewerDispatch });
	try {
		registry.registerPdf({ pdfId: 4, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });

		assert.deepEqual(await client.send({ type: "focus_pdf", pdf_id: 4 }), { ok: true, result: { type: "focus_pdf", pdf_id: 4 } });
		const before = registry.listPdfs();
		const unknown = await client.send({ type: "focus_pdf", pdf_id: 404 });

		assert.equal(unknown.ok, false);
		assert.deepEqual(unknown.error, { code: "unknown_pdf", message: "Unknown pdf_id=404: no Viewer Host PDF registration found" });
		assert.deepEqual(registry.listPdfs(), before);
		assert.deepEqual(viewerDispatch.events.map((event) => `${event.type}:${event.pdfId}`), ["focus_pdf:4"]);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host control channel dispatches synctex_forward and pdf_maybe_updated without directly bumping revision", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-control-synctex-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const viewerDispatch = new FakeViewerDispatch();
	const maybeUpdated: number[] = [];
	const server = new ViewerHostServer({
		registry,
		viewerDispatch,
		verifyPdfMaybeUpdated: async (record) => { maybeUpdated.push(record.pdfId); },
	});
	try {
		registry.registerPdf({ pdfId: 8, pdfPath, title: basename(pdfPath), revision: 2, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });

		const synctex = { type: "synctex_forward", pdf_id: 8, page: 2, x: 100, y: 500, source_file: join(baseDir, "main.tex"), line: 42 } as const;
		assert.deepEqual(await client.send(synctex), { ok: true, result: { type: "synctex_forward", pdf_id: 8 } });
		assert.deepEqual(await client.send({ type: "pdf_maybe_updated", pdf_id: 8 }), { ok: true, result: { type: "pdf_maybe_updated", pdf_id: 8 } });

		assert.deepEqual(viewerDispatch.events, [{ type: "synctex_forward", pdfId: 8, revision: 2, payload: synctex }]);
		assert.deepEqual(maybeUpdated, [8]);
		assert.equal(registry.getPdf(8).revision, 2);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host control channel returns deterministic errors for malformed messages without registry mutation", async () => {
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });

		assert.deepEqual(await client.send({ type: "bogus", pdf_id: 1 }), { ok: false, error: { code: "invalid_message", message: "unknown message type: bogus" } });
		assert.deepEqual(await client.send({ type: "open_pdf", pdf_id: 0, pdf_path: "/tmp/paper.pdf" }), { ok: false, error: { code: "invalid_message", message: "pdf_id must be a positive integer" } });
		assert.deepEqual(await client.send({ type: "hello", protocol_version: 1 }), { ok: false, error: { code: "unsupported_protocol_version", message: "unsupported protocol_version=1" } });
		assert.deepEqual(await client.send({ type: "open_pdf", pdf_id: 1, pdf_path: "/tmp/definitely-missing-viewer-host.pdf" }), { ok: false, error: { code: "control_dispatch_failed", message: "registered PDF is not readable" } });
		const nonFileDir = mkdtempSync(join(tmpdir(), "viewer-host-control-non-file-"));
		mkdirSync(join(nonFileDir, "not-a-pdf.pdf"));
		assert.deepEqual(await client.send({ type: "open_pdf", pdf_id: 2, pdf_path: join(nonFileDir, "not-a-pdf.pdf") }), { ok: false, error: { code: "control_dispatch_failed", message: "registered PDF is not a regular file" } });
		rmSync(nonFileDir, { recursive: true, force: true });
		const badJson = await fetch(`${server.origin}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
		assert.equal(badJson.status, 400);
		assert.deepEqual(await badJson.json(), { ok: false, error: { code: "malformed_json", message: "control request body must be valid JSON" } });
		assert.deepEqual(registry.listPdfs(), []);
		assert.deepEqual(server.controlStatus, { ready: false });
	} finally {
		await server.stop();
	}
});

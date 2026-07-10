import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

function writeFakePdf(path: string, body = "body"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

type ViewerEventMessage = Record<string, unknown>;

async function readViewerEventSnapshot(origin: string, count = 2): Promise<ViewerEventMessage[]> {
	const controller = new AbortController();
	const response = await fetch(`${origin}/viewer-events`, { signal: controller.signal });
	assert.equal(response.status, 200);
	assert.ok(response.body);
	const reader = response.body.getReader();
	let buffer = "";
	const messages: ViewerEventMessage[] = [];
	try {
		while (messages.length < count) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += Buffer.from(value).toString("utf8");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data: "));
				if (dataLine) messages.push(JSON.parse(dataLine.slice("data: ".length)) as ViewerEventMessage);
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		controller.abort();
		reader.releaseLock();
	}
	return messages;
}

async function postJson(origin: string, path: string, body: Record<string, unknown>): Promise<Response> {
	return await fetch(`${origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("direct viewer event stream replays PDFs opened before it connects and legacy app routes stay removed", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tabs-late-connect-"));
	const pdfPath = join(baseDir, "first.pdf");
	writeFakePdf(pdfPath, "first");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 7, pdf_path: pdfPath, title: "Already open" })).ok, true);

		const snapshot = await readViewerEventSnapshot(server.origin);
		assert.deepEqual(snapshot.map((message) => message.type), ["ready", "open_pdf"]);
		assert.deepEqual(snapshot[1], {
			type: "open_pdf",
			pdf_id: 7,
			title: "Already open",
			revision: 1,
			viewer_url: "/viewer-lw/7?revision=1",
			visible_tab_token: "visible-tab-1",
			active: true,
		});

		assert.equal((await fetch(`${server.origin}/app`)).status, 404);
		assert.equal((await fetch(`${server.origin}/app-events`)).status, 404);
		assert.equal((await fetch(`${server.origin}/app-tab-closed`)).status, 404);
		assert.equal((await fetch(`${server.origin}/app-tab-selected`)).status, 404);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host ignores stale direct-viewer close notifications by revision and tab token", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tabs-stale-close-"));
	const pdfPath = join(baseDir, "first.pdf");
	writeFakePdf(pdfPath, "first");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 11, pdf_path: pdfPath, title: "First" })).ok, true);
		const first = (await readViewerEventSnapshot(server.origin)).find((message) => message.type === "open_pdf");
		assert.equal(typeof first?.visible_tab_token, "string");

		writeFakePdf(pdfPath, "changed body with different size");
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 11, pdf_path: pdfPath, title: "First v2" })).ok, true);
		const second = (await readViewerEventSnapshot(server.origin)).find((message) => message.type === "open_pdf");
		assert.equal(second?.revision, 2);
		assert.notEqual(second?.visible_tab_token, first?.visible_tab_token);

		const staleRevision = await postJson(server.origin, "/viewer-tab-closed", {
			pdf_id: 11,
			revision: 1,
			viewer_url: "/viewer-lw/11?revision=1",
			visible_tab_token: first?.visible_tab_token,
		});
		assert.equal(staleRevision.status, 200);

		const staleToken = await postJson(server.origin, "/viewer-tab-closed", {
			pdf_id: 11,
			revision: 2,
			viewer_url: "/viewer-lw/11?revision=2",
			visible_tab_token: first?.visible_tab_token,
		});
		assert.equal(staleToken.status, 200);

		const root = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(root.status, 302);
		assert.equal(root.headers.get("location"), "/viewer-lw/11");
		assert.equal(registry.getPdf(11).revision, 2);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("direct viewer selection and close update the stable root without unregistering PDFs", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-active-direct-route-"));
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	writeFakePdf(firstPdf, "first");
	writeFakePdf(secondPdf, "second");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		const empty = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(empty.status, 200);

		assert.equal((await client.send({ type: "open_pdf", pdf_id: 1, pdf_path: firstPdf, title: "First" })).ok, true);
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 2, pdf_path: secondPdf, title: "Second" })).ok, true);
		const snapshot = await readViewerEventSnapshot(server.origin, 3);
		const first = snapshot.find((event) => event.pdf_id === 1);
		const second = snapshot.find((event) => event.pdf_id === 2);
		assert.ok(first && second);

		let root = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(root.headers.get("location"), "/viewer-lw/2");
		const select = await postJson(server.origin, "/viewer-tab-selected", { pdf_id: 1 });
		assert.equal(select.status, 200);
		root = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(root.headers.get("location"), "/viewer-lw/1");

		const closeFirst = await postJson(server.origin, "/viewer-tab-closed", {
			pdf_id: 1,
			revision: first.revision,
			viewer_url: first.viewer_url,
			visible_tab_token: first.visible_tab_token,
		});
		assert.equal(closeFirst.status, 200);
		root = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(root.headers.get("location"), "/viewer-lw/2");

		const closeSecond = await postJson(server.origin, "/viewer-tab-closed", {
			pdf_id: 2,
			revision: second.revision,
			viewer_url: second.viewer_url,
			visible_tab_token: second.visible_tab_token,
		});
		assert.equal(closeSecond.status, 200);
		root = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(root.status, 200);
		assert.doesNotMatch(await root.text(), /data-config-url=/);

		assert.equal(registry.getPdf(1).pdfPath, firstPdf);
		assert.equal(registry.getPdf(2).pdfPath, secondPdf);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("viewer event and tab endpoints validate their HTTP methods", async () => {
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		assert.equal((await fetch(`${server.origin}/viewer-events`, { method: "POST" })).status, 405);
		assert.equal((await fetch(`${server.origin}/viewer-tab-selected`)).status, 405);
		assert.equal((await fetch(`${server.origin}/viewer-tab-closed`)).status, 405);
	} finally {
		await server.stop();
	}
});

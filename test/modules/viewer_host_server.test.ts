import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { test } from "node:test";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

const require = createRequire(import.meta.url);

function writeFakePdf(path: string, suffix = "body"): Buffer {
	const bytes = Buffer.from(`%PDF-1.4\n${suffix}\n%%EOF\n`, "utf8");
	writeFileSync(path, bytes);
	return bytes;
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

async function readHttp(url: string, init?: RequestInit): Promise<{ status: number; contentType: string; body: Buffer; headers: Headers }> {
	const response = await fetch(url, init);
	return {
		status: response.status,
		contentType: response.headers.get("content-type") ?? "",
		body: Buffer.from(await response.arrayBuffer()),
		headers: response.headers,
	};
}

function assertHostLoadedWebCode(label: string, body: string): void {
	assert.doesNotMatch(body, /https?:\/\//, `${label} must not reference external URLs`);
	assert.doesNotMatch(body, /__TAURI__|@tauri-apps|window\.require|require\(|node:fs|from\s+["']fs["']|from\s+["']node:fs["']|mcp/i, `${label} must not depend on Tauri, Node filesystem APIs, or MCP internals`);
}

async function assertPortCanBeRebound(port: number): Promise<void> {
	const server = createServer((_request, response) => response.end("ok"));
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port }, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

test("Viewer Host Server binds to 127.0.0.1 only and serves registered PDF bytes by pdf_id and revision", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-server-get-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const pdfBytes = writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 12, pdfPath, title: "paper.pdf", revision: 3, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();

		assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.equal(server.address.host, "127.0.0.1");
		assert.equal(server.pdfUrl(12, 3), `${server.origin}/pdf/12?revision=3`);

		const pdf = await readHttp(server.pdfUrl(12, 3));
		assert.equal(pdf.status, 200);
		assert.match(pdf.contentType, /application\/pdf/);
		assert.equal(pdf.headers.get("content-length"), String(pdfBytes.length));
		assert.equal(pdf.headers.get("cache-control"), "no-store");
		assert.deepEqual(pdf.body, pdfBytes);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server serves Host-loaded Viewer Client shell, per-PDF viewer config, and PDF.js assets", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-client-routes-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 109, pdfPath, title: "paper.pdf", revision: 2, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();

		const app = await readHttp(`${server.origin}/app`);
		assert.equal(app.status, 200);
		assert.match(app.contentType, /text\/html/);
		const appHtml = app.body.toString("utf8");
		assert.match(appHtml, /Viewer Client/i);
		assert.match(appHtml, /id="tab-list"/);
		assert.match(appHtml, /id="viewer-panels"/);
		assert.match(appHtml, /\/assets\/viewer-client-tabs\.js/);
		assertHostLoadedWebCode("Viewer Client shell", appHtml);

		const tabShellScript = await readHttp(`${server.origin}/assets/viewer-client-tabs.js`);
		assert.equal(tabShellScript.status, 200);
		assert.match(tabShellScript.contentType, /javascript/);
		const tabShellScriptBody = tabShellScript.body.toString("utf8");
		assert.match(tabShellScriptBody, /EventSource\("\/app-events"\)/);
		assert.match(tabShellScriptBody, /data-close-pdf-id/);
		assertHostLoadedWebCode("tab shell script", tabShellScriptBody);

		const viewer = await readHttp(`${server.origin}/viewer/109`);
		assert.equal(viewer.status, 200);
		assert.match(viewer.contentType, /text\/html/);
		const viewerHtml = viewer.body.toString("utf8");
		assert.match(viewerHtml, /PDF\.js viewer/i);
		assert.match(viewerHtml, /\/config\/109\.json/);
		assert.match(viewerHtml, /href="\/pdf\/109\?revision=2"/);
		assertHostLoadedWebCode("per-PDF viewer page", viewerHtml);

		const configResponse = await readHttp(`${server.origin}/config/109.json`);
		assert.equal(configResponse.status, 200);
		assert.match(configResponse.contentType, /application\/json/);
		const config = JSON.parse(configResponse.body.toString("utf8")) as Record<string, unknown>;
		assert.equal(config.pdf_id, 109);
		assert.equal(config.revision, 2);
		assert.equal(config.pdf_url, `${server.origin}/pdf/109?revision=2`);
		assert.equal(typeof config.viewer_socket_token, "string");
		const viewerSocketUrl = `${server.origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=109&token=${encodeURIComponent(String(config.viewer_socket_token))}`;
		assert.equal(config.viewer_socket_url, viewerSocketUrl);
		assert.equal(config.ws_url, viewerSocketUrl);

		const viewerScript = await readHttp(`${server.origin}/assets/viewer.js`);
		assert.equal(viewerScript.status, 200);
		assert.match(viewerScript.contentType, /javascript/);
		const viewerScriptBody = viewerScript.body.toString("utf8");
		assert.match(viewerScriptBody, /getDocument/);
		assert.match(viewerScriptBody, /convertToPdfPoint/);
		assert.match(viewerScriptBody, /viewportHeight: canvas\.offsetHeight/);
		assert.match(viewerScriptBody, /input\.viewportHeight - input\.viewportY/);
		assert.match(viewerScriptBody, /convertToViewportPoint/);
		assertHostLoadedWebCode("viewer script", viewerScriptBody);

		const pdfJs = await readHttp(`${server.origin}/assets/pdf.mjs`);
		assert.equal(pdfJs.status, 200);
		assert.match(pdfJs.contentType, /javascript/);
		assert.equal(pdfJs.body.toString("utf8"), readFileSync(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"), "utf8"));

		const worker = await readHttp(`${server.origin}/assets/pdf.worker.mjs`);
		assert.equal(worker.status, 200);
		assert.match(worker.contentType, /javascript/);
		assert.equal(worker.body.toString("utf8"), readFileSync(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8"));

		assert.equal((await readHttp(`${server.origin}/viewer/999`)).status, 404);
		assert.equal((await readHttp(`${server.origin}/config/999.json`)).status, 404);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server rejects GET when the registered revision file snapshot is stale", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-server-stale-get-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "original body");
	const originalSnapshot = snapshotPdf(pdfPath);
	const changedBytes = writeFakePdf(pdfPath, "changed body that must not be served");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 21, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: originalSnapshot });
		await server.start();

		const response = await readHttp(server.pdfUrl(21, 1));
		assert.equal(response.status, 409);
		assert.match(response.body.toString("utf8"), /stale|mismatch/i);
		assert.notDeepEqual(response.body, changedBytes);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server rejects HEAD when the registered revision file snapshot is stale", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-server-stale-head-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath, "original body");
	const originalSnapshot = snapshotPdf(pdfPath);
	writeFakePdf(pdfPath, "changed body that must not be served");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 22, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: originalSnapshot });
		await server.start();

		const response = await readHttp(server.pdfUrl(22, 1), { method: "HEAD" });
		assert.equal(response.status, 409);
		assert.equal(response.headers.get("x-viewer-host-error"), "stale_pdf_snapshot");
		assert.equal(response.body.length, 0);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server HEAD returns registered PDF metadata without opening body bytes", async () => {
	const registry = new ViewerHostPdfRegistry();
	let streamOpenCount = 0;
	const server = new ViewerHostServer({
		registry,
		fileSystem: {
			async stat() {
				return { size: 12_345, mtimeMs: 1, isFile: () => true };
			},
			createReadStream() {
				streamOpenCount += 1;
				throw new Error("HEAD must not open a PDF body stream");
			},
		},
	});
	try {
		registry.registerPdf({ pdfId: 8, pdfPath: "/virtual/paper.pdf", title: "paper.pdf", revision: 1, fileSnapshot: { size: 12_345, mtimeMs: 1 } });
		await server.start();

		const head = await readHttp(server.pdfUrl(8, 1), { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.match(head.contentType, /application\/pdf/);
		assert.equal(head.headers.get("content-length"), "12345");
		assert.equal(head.body.length, 0);
		assert.equal(streamOpenCount, 0);
	} finally {
		await server.stop();
	}
});

test("Viewer Host Server rejects unknown ids, raw filesystem paths, and traversal-style PDF requests", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-server-reject-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const pdfBytes = writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 4, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();

		const cases = [
			`${server.origin}/pdf/999?revision=1`,
			`${server.origin}/pdf/${encodeURIComponent(pdfPath)}?revision=1`,
			`${server.origin}/pdf/..%2F..%2Fetc%2Fpasswd?revision=1`,
			`${server.origin}/${encodeURIComponent(pdfPath)}`,
			`${server.origin}/pdf/4/../../etc/passwd?revision=1`,
			`${server.origin}/pdf/4?revision=2`,
		];

		for (const url of cases) {
			const response = await readHttp(url);
			assert.notEqual(response.status, 200, url);
			assert.notDeepEqual(response.body, pdfBytes, url);
		}
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server shutdown closes sockets and releases the port", async () => {
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	await server.start();
	const port = server.address.port;
	const socket = new Socket();
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.connect(port, "127.0.0.1", () => {
				socket.off("error", reject);
				resolve();
			});
		});
		const closed = once(socket, "close");
		await server.stop();
		await closed;
		await assertPortCanBeRebound(port);
	} finally {
		socket.destroy();
		await server.stop();
	}
});

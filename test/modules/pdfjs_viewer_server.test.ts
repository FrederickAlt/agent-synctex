import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { test } from "node:test";
import { PdfJsViewerRegistry } from "../../src/modules/pdfjs_viewer_registry.ts";
import { PdfJsViewerServer } from "../../src/modules/pdfjs_viewer_server.ts";

function writeFakePdf(path: string, suffix = "body"): Buffer {
	const bytes = Buffer.from(`%PDF-1.4\n${suffix}\n%%EOF\n`, "utf8");
	writeFileSync(path, bytes);
	return bytes;
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

function assertNoExternalUrls(label: string, body: string): void {
	assert.doesNotMatch(body, /https?:\/\//, `${label} must not reference external URLs`);
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

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 500;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(predicate(), true);
}

async function readWebSocketTextFrame(socket: Socket): Promise<string> {
	const [chunk] = await once(socket, "data") as [Buffer];
	const firstLength = chunk[1] & 0x7f;
	let offset = 2;
	let payloadLength = firstLength;
	if (firstLength === 126) {
		payloadLength = chunk.readUInt16BE(offset);
		offset += 2;
	} else if (firstLength === 127) {
		payloadLength = Number(chunk.readBigUInt64BE(offset));
		offset += 8;
	}
	return chunk.subarray(offset, offset + payloadLength).toString("utf8");
}

function encodeClientWebSocketTextFrame(message: string): Buffer {
	const payload = Buffer.from(message, "utf8");
	const mask = Buffer.from([1, 2, 3, 4]);
	const maskBit = 0x80;
	if (payload.length < 126) {
		const header = Buffer.from([0x81, maskBit | payload.length]);
		const maskedPayload = Buffer.alloc(payload.length);
		for (let index = 0; index < payload.length; index += 1) {
			maskedPayload[index] = payload[index] ^ mask[index % 4];
		}
		return Buffer.concat([header, mask, maskedPayload]);
	}
	const header = Buffer.alloc(4);
	header[0] = 0x81;
	header[1] = maskBit | 126;
	header.writeUInt16BE(payload.length, 2);
	const maskedPayload = Buffer.alloc(payload.length);
	for (let index = 0; index < payload.length; index += 1) {
		maskedPayload[index] = payload[index] ^ mask[index % 4];
	}
	return Buffer.concat([header, mask, maskedPayload]);
}

test("PDF.js viewer server serves shell/config/assets and registered PDF bytes only", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-server-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const pdfBytes = writeFakePdf(pdfPath);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 5 });
	const server = new PdfJsViewerServer({ registry });
	try {
		await server.start();
		const record = registry.registerPdf({ pdfPath, viewerUrl: server.viewerUrl(5) });

		const shell = await readHttp(record.viewerUrl);
		assert.equal(shell.status, 200);
		assert.match(shell.contentType, /text\/html/);
		assert.match(shell.body.toString("utf8"), /PDF\.js/);
		assertNoExternalUrls("viewer shell", shell.body.toString("utf8"));

		const config = await readHttp(`${server.origin}/config/${record.pdfId}.json`);
		assert.equal(config.status, 200);
		assert.match(config.contentType, /application\/json/);
		assert.equal(JSON.parse(config.body.toString("utf8")).pdf_id, record.pdfId);

		const asset = await readHttp(`${server.origin}/assets/viewer.js`);
		assert.equal(asset.status, 200);
		assert.match(asset.contentType, /javascript/);
		const viewerScript = asset.body.toString("utf8");
		assertNoExternalUrls("viewer script", viewerScript);
		assert.match(viewerScript, /pdf_refresh/);
		assert.match(viewerScript, /synctex/);
		assert.match(viewerScript, /window\.scrollTo/);
		assert.doesNotMatch(viewerScript, /location\.reload|viewer_reload/);

		const pdfJs = await readHttp(`${server.origin}/assets/pdf.mjs`);
		assert.equal(pdfJs.status, 200);
		assert.match(pdfJs.contentType, /javascript/);
		const pdfWorker = await readHttp(`${server.origin}/assets/pdf.worker.mjs`);
		assert.equal(pdfWorker.status, 200);
		assert.match(pdfWorker.contentType, /javascript/);

		const pdf = await readHttp(`${server.origin}/pdf/${record.pdfId}`);
		assert.equal(pdf.status, 200);
		assert.match(pdf.contentType, /application\/pdf/);
		assert.equal(pdf.headers.get("access-control-allow-origin"), null);
		assert.deepEqual(pdf.body, pdfBytes);

		const pdfHead = await readHttp(`${server.origin}/pdf/${record.pdfId}`, { method: "HEAD" });
		assert.equal(pdfHead.status, 200);
		assert.equal(pdfHead.headers.get("content-length"), String(pdfBytes.length));
		assert.equal(pdfHead.body.length, 0);

		assert.equal((await readHttp(`${server.origin}/pdf/999999`)).status, 404);
		assert.notEqual((await readHttp(`${server.origin}/pdf/../paper.pdf`)).status, 200);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js viewer server emits safe Content-Disposition for control-character filenames", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-safe-header-"));
	const pdfPath = join(baseDir, "bad\nname\u0001.pdf");
	writeFakePdf(pdfPath);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 7 });
	const server = new PdfJsViewerServer({ registry });
	try {
		await server.start();
		const record = registry.registerPdf({ pdfPath, viewerUrl: server.viewerUrl(7) });
		const pdf = await readHttp(`${server.origin}/pdf/${record.pdfId}`);

		assert.equal(pdf.status, 200);
		const disposition = pdf.headers.get("content-disposition") ?? "";
		assert.doesNotMatch(disposition, /[\r\n\u0000-\u001f\u007f]/);
		assert.match(disposition, /filename="bad_name_\.pdf"/);
		assert.match(disposition, /filename\*=UTF-8''bad_name_\.pdf/);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js viewer server HEAD uses PDF metadata without opening a read stream", async () => {
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 8 });
	let streamOpenCount = 0;
	const server = new PdfJsViewerServer({
		registry,
		fileSystem: {
			async stat() {
				return { size: 12_345, isFile: () => true };
			},
			createReadStream() {
				streamOpenCount += 1;
				throw new Error("HEAD must not open the PDF stream");
			},
		},
	});
	try {
		await server.start();
		const record = registry.registerPdf({ pdfPath: "/virtual/paper.pdf", viewerUrl: server.viewerUrl(8) });
		const pdfHead = await readHttp(`${server.origin}/pdf/${record.pdfId}`, { method: "HEAD" });

		assert.equal(pdfHead.status, 200);
		assert.equal(pdfHead.headers.get("content-length"), "12345");
		assert.equal(pdfHead.body.length, 0);
		assert.equal(streamOpenCount, 0);
	} finally {
		await server.stop();
	}
});

test("PDF.js viewer server streams registered PDF bytes for GET", async () => {
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 9 });
	let streamOpenCount = 0;
	const server = new PdfJsViewerServer({
		registry,
		fileSystem: {
			async stat() {
				return { size: 10, isFile: () => true };
			},
			createReadStream() {
				streamOpenCount += 1;
				return Readable.from([Buffer.from("%PDF-1.4\nX")]);
			},
		},
	});
	try {
		await server.start();
		const record = registry.registerPdf({ pdfPath: "/virtual/paper.pdf", viewerUrl: server.viewerUrl(9) });
		const pdf = await readHttp(`${server.origin}/pdf/${record.pdfId}`);

		assert.equal(pdf.status, 200);
		assert.equal(pdf.headers.get("content-length"), "10");
		assert.equal(pdf.body.toString("utf8"), "%PDF-1.4\nX");
		assert.equal(streamOpenCount, 1);
	} finally {
		await server.stop();
	}
});

test("PDF.js viewer server delivers synctex notifications to connected WebSocket clients", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-ws-synctex-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 16 });
	const server = new PdfJsViewerServer({ registry });
	try {
		await server.start();
		const record = registry.registerPdf({ pdfPath, viewerUrl: server.viewerUrl(16) });
		const wsUrl = new URL(`/ws?pdf_id=${record.pdfId}`, server.origin);
		wsUrl.protocol = "ws:";
		const socket = await connectRawWebSocket(wsUrl);
		await waitFor(() => registry.clientCount(record.pdfId) === 1);

		const notified = server.notifySynctex(record.pdfId, { page: 2, x: 12.5, y: 34.75, source_file: "/tmp/main.tex", line: 9 });
		const message = JSON.parse(await readWebSocketTextFrame(socket));

		assert.equal(notified, 1);
		assert.deepEqual(message, { type: "synctex", pdf_id: record.pdfId, page: 2, x: 12.5, y: 34.75, source_file: "/tmp/main.tex", line: 9 });
		socket.end();
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js viewer WebSocket associates clients with requested pdf_id and delivers pdf_refresh/removes them on disconnect", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-ws-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 6 });
	const server = new PdfJsViewerServer({ registry });
	try {
		await server.start();
		const record = registry.registerPdf({ pdfPath, viewerUrl: server.viewerUrl(6), fileSnapshot: { size: 10, mtimeMs: 20 } });
		const wsUrl = new URL(`/ws?pdf_id=${record.pdfId}`, server.origin);
		wsUrl.protocol = "ws:";

		const socket = await connectRawWebSocket(wsUrl);
		await waitFor(() => registry.clientCount(record.pdfId) === 1);

		assert.equal(server.notifyPdfRefresh(record.pdfId, 2), 1);
		assert.deepEqual(JSON.parse(await readWebSocketTextFrame(socket)), {
			type: "pdf_refresh",
			pdf_id: record.pdfId,
			revision: 2,
			pdf_url: `${server.origin}/pdf/${record.pdfId}?revision=2`,
		});

		socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
		socket.end();
		await waitFor(() => registry.clientCount(record.pdfId) === 0);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("PDF.js viewer server keeps reverse-synctex callback exceptions from crashing the websocket", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-ws-reverse-exception-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 17 });
	const failureText = "synthetic reverse synctex failure";
	const server = new PdfJsViewerServer({
		registry,
		onReverseSynctex: () => {
			throw new Error(failureText);
		},
	});
	try {
		await server.start();
		const record = registry.registerPdf({ pdfPath, viewerUrl: server.viewerUrl(17) });
		const wsUrl = new URL(`/ws?pdf_id=${record.pdfId}`, server.origin);
		wsUrl.protocol = "ws:";
		const socket = await connectRawWebSocket(wsUrl);
		await waitFor(() => registry.clientCount(record.pdfId) === 1);

		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({ type: "reverse_synctex", page: 1, x: 11, y: 22 })));
		const firstMessage = JSON.parse(await readWebSocketTextFrame(socket));
		assert.deepEqual(firstMessage, { type: "reverse_synctex_error", pdf_id: record.pdfId, error: failureText });

		socket.write(encodeClientWebSocketTextFrame(JSON.stringify({ type: "reverse_synctex", page: 2, x: 33, y: 44 })));
		const secondMessage = JSON.parse(await readWebSocketTextFrame(socket));
		assert.deepEqual(secondMessage, { type: "reverse_synctex_error", pdf_id: record.pdfId, error: failureText });

		socket.end();
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

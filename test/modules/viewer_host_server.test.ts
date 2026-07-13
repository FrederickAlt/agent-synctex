import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Socket } from "node:net";
import { test } from "node:test";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

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
	assert.doesNotMatch(body, /window\.require|require\(|node:fs|from\s+["']fs["']|from\s+["']node:fs["']|mcp/i, `${label} must not depend on Node filesystem APIs or MCP internals`);
}

function readJsonlRecords(dir: string): Record<string, unknown>[] {
	const files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
	return files.flatMap((file) => readFileSync(join(dir, file), "utf8")
		.trim()
		.split(/\n+/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>));
}

async function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(updates)) {
		previous.set(key, process.env[key]);
		const value = updates[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
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

async function waitForWebSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
	return await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
		socket.addEventListener("message", (event) => {
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		}, { once: true });
		socket.addEventListener("error", () => {
			clearTimeout(timeout);
			reject(new Error("WebSocket error"));
		}, { once: true });
	});
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

test("Viewer Host Server accepts authenticated browser viewer logs", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-logs-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const logDir = join(baseDir, "logs");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await withEnv({ PDF_PREVIEW_LOG_LEVEL: "debug", PDF_PREVIEW_LOG_DIR: logDir, PDF_PREVIEW_CONFIG: undefined }, async () => {
			registry.registerPdf({ pdfId: 88, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
			await server.start();
			const config = JSON.parse((await readHttp(`${server.origin}/config/88.json`)).body.toString("utf8")) as { viewer_socket_token: string };
			const forbidden = await readHttp(`${server.origin}/viewer-logs`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-agent-synctex-viewer-token": "wrong" },
				body: JSON.stringify({ pdf_id: 88, level: "info", event: "viewer_socket.connect.start", fields: {} }),
			});
			assert.equal(forbidden.status, 403);

			const accepted = await readHttp(`${server.origin}/viewer-logs`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-agent-synctex-viewer-token": config.viewer_socket_token },
				body: JSON.stringify({
					pdf_id: 88,
					level: "warn",
					event: "viewer_socket.connect.slow",
					fields: { elapsed_ms: 1001, secret_token: "must-not-log" },
				}),
			});
			assert.equal(accepted.status, 200);

			const records = readJsonlRecords(logDir);
			const viewerRecord = records.find((record) => record.component === "viewer-host.viewer" && record.event === "viewer_socket.connect.slow");
			assert.ok(viewerRecord);
			assert.equal(viewerRecord.level, "warn");
			assert.equal(viewerRecord.pdf_id, 88);
			assert.equal(viewerRecord.elapsed_ms, 1001);
			assert.equal(viewerRecord.secret_token, "[redacted]");
		});
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server removes the legacy app shell and serves the direct viewer, config, and PDF.js assets", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-client-routes-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 109, pdfPath, title: "paper.pdf", revision: 2, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();

		const app = await readHttp(`${server.origin}/app`);
		assert.equal(app.status, 404);

		const tabShellScript = await readHttp(`${server.origin}/assets/viewer-client-tabs.js`);
		assert.equal(tabShellScript.status, 404);

		const legacyViewer = await readHttp(`${server.origin}/viewer/109?revision=2`, { redirect: "manual" });
		assert.equal(legacyViewer.status, 302);
		assert.equal(legacyViewer.headers.get("location"), "/viewer-lw/109?revision=2");

		const viewer = await readHttp(`${server.origin}/viewer-lw/109`);
		assert.equal(viewer.status, 200);
		assert.match(viewer.contentType, /text\/html/);
		const viewerHtml = viewer.body.toString("utf8");
		assert.match(viewerHtml, /<title>PDF\.js viewer<\/title>/i);
		assert.match(viewerHtml, /id="toolbarViewer"/);
		assert.match(viewerHtml, /\/config\/109\.json/);
		assert.match(viewerHtml, /\/viewer-lw\/host_lw_adapter\.mjs/);
		assert.doesNotMatch(viewerHtml, /Direct PDF fallback|Open registered PDF bytes directly|Use the direct PDF link/i);

		const configResponse = await readHttp(`${server.origin}/config/109.json`);
		assert.equal(configResponse.status, 200);
		assert.match(configResponse.contentType, /application\/json/);
		const config = JSON.parse(configResponse.body.toString("utf8")) as Record<string, unknown>;
		assert.equal(config.pdf_id, 109);
		assert.equal(config.title, "paper.pdf");
		assert.equal(config.revision, 2);
		assert.equal(config.pdf_url, `${server.origin}/pdf/109?revision=2`);
		assert.equal(typeof config.viewer_socket_token, "string");
		const viewerSocketUrl = `${server.origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=109&token=${encodeURIComponent(String(config.viewer_socket_token))}`;
		assert.equal(config.viewer_socket_url, viewerSocketUrl);
		assert.equal(config.ws_url, viewerSocketUrl);

		assert.equal((await readHttp(`${server.origin}/assets/viewer.js`)).status, 404);
		assert.equal((await readHttp(`${server.origin}/assets/pdf.mjs`)).status, 404);
		assert.equal((await readHttp(`${server.origin}/assets/pdf.worker.mjs`)).status, 404);

		assert.equal((await readHttp(`${server.origin}/viewer/999`, { redirect: "manual" })).status, 404);
		assert.equal((await readHttp(`${server.origin}/config/999.json`)).status, 404);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server hover WebSocket returns robust no-context diagnostics through production backend", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-hover-robust-"));
	const outDir = join(baseDir, "out");
	mkdirSync(outDir);
	const pdfPath = join(outDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	copyFileSync(resolve("test/fixtures/synctex-forward/paper.synctex"), join(outDir, "paper.synctex"));
	writeFileSync(sourcePath, [
		"\\documentclass{article}",
		"\\begin{document}",
		"\\end{document}",
		"% filler",
		"Second paragraph text on a different source line for SyncTeX mapping.",
		"\\end{document}",
	].join("\n"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let socket: WebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 124, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		const config = JSON.parse((await readHttp(`${server.origin}/config/124.json`)).body.toString("utf8")) as { viewer_socket_url: string };
		socket = new WebSocket(config.viewer_socket_url);
		await new Promise<void>((resolveOpen, rejectOpen) => {
			socket!.addEventListener("open", () => resolveOpen(), { once: true });
			socket!.addEventListener("error", () => rejectOpen(new Error("WebSocket open failed")), { once: true });
		});

		socket.send(JSON.stringify({ type: "reverse_synctex_hover", request_id: 7, page: 1, x: 144.27, y: 155.27 }));
		const message = await waitForWebSocketMessage(socket);

		assert.equal(message.type, "reverse_synctex_hover_result");
		assert.equal(message.pdf_id, 124);
		assert.equal(message.request_id, 7);
		assert.equal(message.source_file, sourcePath);
		assert.equal(message.line, 4);
		assert.equal(message.source_line, "% filler");
		assert.equal(message.raw, undefined);
		assert.equal((message.nearest_candidate as { line?: number; structural?: boolean; source_line?: string; score?: number }).line, 3);
		assert.equal((message.nearest_candidate as { line?: number; structural?: boolean; source_line?: string; score?: number }).structural, true);
		assert.equal((message.nearest_candidate as { line?: number; structural?: boolean; source_line?: string; score?: number }).source_line, "\\end{document}");
		assert.equal(typeof (message.nearest_candidate as { score?: number }).score, "number");
		assert.equal(typeof message.selected_score, "number");
		assert.equal((message.repaired as { line?: number; source_line?: string; score?: number }).line, 4);
		assert.equal((message.repaired as { line?: number; source_line?: string; score?: number }).source_line, "% filler");
		assert.equal((message.repaired as { line?: number; source_line?: string; score?: number }).score, message.selected_score);
		assert.ok((message.candidates as Array<{ line?: number }>).some((candidate) => candidate.line === 5));
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host Server exposes bounded full scoring trace only for explicit SyncTeX debug probes", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-probe-debug-trace-"));
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	copyFileSync(resolve("test/fixtures/synctex-forward/main.tex"), sourcePath);
	copyFileSync(resolve("test/fixtures/synctex-forward/paper.synctex"), join(baseDir, "paper.synctex"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 125, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		const config = JSON.parse((await readHttp(`${server.origin}/config/125.json`)).body.toString("utf8")) as { viewer_socket_token: string };
		const probe = async (requestId: number): Promise<Record<string, unknown>> => {
			const response = await fetch(`${server.origin}/synctex/probe`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-agent-synctex-viewer-token": config.viewer_socket_token },
				body: JSON.stringify({ pdf_id: 125, request_id: requestId, page: 1, x: 144.27, y: 155.27 }),
			});
			assert.equal(response.status, 200);
			const body = await response.json() as { ok: boolean; result: Record<string, unknown> };
			assert.equal(body.ok, true);
			return body.result;
		};

		const normal = await probe(1);
		for (const field of ["debug_candidates", "debug_selected_score", "debug_forward_groups"]) {
			assert.equal(Object.hasOwn(normal, field), false, `${field} must remain absent outside explicit debug mode`);
		}

		assert.equal((await new ViewerHostControlClient({ origin: server.origin }).send({ type: "set_debug_synctex", pdf_id: 125, enabled: true })).ok, true);
		const traced = await probe(2);
		const groups = traced.debug_forward_groups as Array<Record<string, unknown>> | undefined;
		assert.ok(groups && groups.length > 0, "debug probes should expose scored forward groups");
		const selected = groups.find((group) => group.selected === true);
		assert.ok(selected, "one trace group should identify the selected proposal/group");
		assert.equal(selected.proposal_selected, true);
		assert.equal(typeof selected.proposal, "object");
		assert.equal((selected.proposal as Record<string, unknown>).provenance, "synctex_reverse", "proposal provenance must remain distinct from forward group origin");
		assert.equal(selected.origin, "synctex_exact", "origin is the forward lookup/box-group flavor rather than proposal provenance");
		const annotationDiagnostics = traced.synctex_diagnostics as { top_proposals?: Array<{ provenance?: string; score?: number }>; selected_score?: number; forward_groups?: Array<Record<string, unknown>> } | undefined;
		assert.ok(annotationDiagnostics, "debug probes should return the bounded annotation diagnostic payload");
		assert.ok((annotationDiagnostics?.top_proposals?.length ?? 0) > 0 && (annotationDiagnostics?.top_proposals?.length ?? 0) <= 3);
		assert.equal(annotationDiagnostics?.top_proposals?.[0]?.provenance, "synctex_reverse");
		assert.equal(typeof annotationDiagnostics?.top_proposals?.[0]?.score, "number");
		assert.equal(annotationDiagnostics?.forward_groups?.length, groups.length);
		assert.equal(typeof annotationDiagnostics?.selected_score, "number");
		assert.equal(typeof selected.pdf_text_span_semantic_penalty, "number");
		assert.equal(typeof selected.selection_text_context_semantic_penalty, "number");
		assert.equal(typeof selected.blank_source_line_penalty, "number");
		assert.equal(typeof selected.original_box_count, "number");
		assert.equal(typeof selected.filtered_box_count, "number");
		assert.equal(typeof selected.same_page_box_count, "number");
		assert.equal(typeof selected.rejected_invalid, "number");
		assert.equal(typeof selected.rejected_absurd, "number");
		assert.equal(typeof selected.group_order, "object");
		assert.equal(typeof selected.proposal_order, "object");
		const boxes = selected.box_scores as Array<Record<string, unknown>> | undefined;
		assert.ok(boxes && boxes.length > 0, "selected groups should expose bounded score arithmetic for their boxes");
		assert.equal(typeof selected.distance_multiplier, "number");
		assert.equal(typeof selected.distance_term, "number");
		assert.equal(typeof boxes[0]?.distance_multiplier, "number");
		assert.equal(typeof boxes[0]?.distance_term, "number");
		assert.equal(typeof boxes[0]?.distance_squared, "number");
		assert.equal(typeof boxes[0]?.area_term, "number");
		assert.equal(typeof boxes[0]?.tiny_penalty, "number");
		assert.equal(typeof boxes[0]?.click_containment_bonus, "number");
		assert.equal(typeof boxes[0]?.text_containment_bonus, "number");
		assert.equal(typeof boxes[0]?.total, "number");
		const box = boxes[0]!;
		assert.ok(Math.abs(Number(box.distance_squared) * Number(box.distance_multiplier) - Number(box.distance_term)) < 1e-9, "distance term should expose its multiplier arithmetic");
		assert.equal(typeof box.pdf_text_span_semantic_penalty, "number");
		assert.equal(typeof box.selection_text_context_semantic_penalty, "number");
		assert.equal(typeof box.blank_source_line_penalty, "number");
		const treeCandidate = box.tree_candidate as { leaf?: { source_file?: string; line?: number }; box?: { type?: string }; ancestors?: unknown[] } | undefined;
		assert.equal(treeCandidate?.leaf?.source_file, "main.tex", "debug box scores should preserve parsed-tree leaf provenance");
		assert.equal(typeof treeCandidate?.leaf?.line, "number");
		assert.equal(typeof treeCandidate?.box?.type, "string");
		assert.ok(Array.isArray(treeCandidate?.ancestors), "debug box scores should preserve the bounded parsed-tree ancestor path");
		const terms = ["distance_term", "area_term", "tiny_penalty", "semantic_penalty", "blank_source_line_penalty", "click_containment_bonus", "text_containment_bonus", "end_document_penalty"]
			.map((field) => Number(box[field] ?? 0));
		assert.ok(Math.abs(terms.reduce((sum, value) => sum + value, 0) - Number(box.total)) < 1e-9, "debug score terms should sum exactly to the selected box total");
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

test("Viewer Host Server HTTP shutdown endpoint requires its local token", async () => {
	const registry = new ViewerHostPdfRegistry();
	let shutdownReason: string | undefined;
	let resolveShutdown: (() => void) | undefined;
	const shutdownRequested = new Promise<void>((resolve) => { resolveShutdown = resolve; });
	const server = new ViewerHostServer({
		registry,
		instanceId: "shutdown-instance",
		shutdownRequest: {
			token: "test-token",
			shutdown: (reason) => {
				shutdownReason = reason;
				resolveShutdown?.();
			},
		},
	});
	try {
		await server.start();
		const forbidden = await readHttp(`${server.origin}/shutdown`, { method: "POST" });
		assert.equal(forbidden.status, 403);

		const accepted = await readHttp(`${server.origin}/shutdown`, { method: "POST", headers: { "x-agent-synctex-shutdown-token": "test-token" } });
		assert.equal(accepted.status, 200);
		assert.deepEqual(JSON.parse(accepted.body.toString("utf8")), { ok: true, instance_id: "shutdown-instance" });
		await Promise.race([
			shutdownRequested,
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out waiting for shutdown handler")), 1_000)),
		]);
		assert.equal(shutdownReason, "http_shutdown");
	} finally {
		await server.stop();
	}
});

test("Viewer Host Server serves side-by-side LaTeX Workshop viewer route and assets", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-routes-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		registry.registerPdf({ pdfId: 141, pdfPath, title: "paper.pdf", revision: 5, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();

		const viewer = await readHttp(`${server.origin}/viewer-lw/141`);
		assert.equal(viewer.status, 200);
		assert.match(viewer.contentType, /text\/html/);
		const html = viewer.body.toString("utf8");
		assert.match(html, /Copyright 2012 Mozilla Foundation/);
		assert.match(html, /Licensed under the Apache License, Version 2\.0/);
		assert.match(html, /data-config-url="\/config\/141\.json"/);
		assert.match(html, /\/viewer-lw\/host_lw_adapter\.mjs/);
		assert.match(html, /worker-src 'self' blob:/);
		assert.match(html, /script-src 'self' 'wasm-unsafe-eval'/);
		assert.doesNotMatch(html, /id="status"|synctex-hover-toggle|Open registered PDF bytes directly/);

		const viewerScript = await readHttp(`${server.origin}/viewer-lw/viewer.mjs`);
		assert.equal(viewerScript.status, 200);
		assert.match(viewerScript.contentType, /javascript/);
		assert.match(viewerScript.body.toString("utf8"), /Copyright 2024 Mozilla Foundation/);
		assert.match(viewerScript.body.toString("utf8"), /Licensed under the Apache License, Version 2\.0/);

		const css = await readHttp(`${server.origin}/viewer-lw/latexworkshop.css`);
		assert.equal(css.status, 200);
		assert.match(css.contentType, /text\/css/);
		assert.match(css.body.toString("utf8"), /LaTeX Workshop|MIT|Copyright/i);

		const image = await readHttp(`${server.origin}/viewer-lw/images/toolbarButton-search.svg`);
		assert.equal(image.status, 200);
		assert.match(image.contentType, /image\/svg\+xml/);

		const pdfJsModule = await readHttp(`${server.origin}/viewer-lw/build/pdf.mjs`);
		assert.equal(pdfJsModule.status, 200);
		assert.match(pdfJsModule.contentType, /javascript/);
		assert.match(pdfJsModule.body.toString("utf8"), /^\/\/ PDF\.js compatibility polyfills for older WebKit webviews\./);
		assert.match(pdfJsModule.body.toString("utf8"), /Promise\.withResolvers/);
		assert.match(pdfJsModule.body.toString("utf8"), /Promise\.try/);
		assert.match(pdfJsModule.body.toString("utf8"), /pdfjsVersion = 5\.7\.284/);

		const worker = await readHttp(`${server.origin}/viewer-lw/build/pdf.worker.mjs`);
		assert.equal(worker.status, 200);
		assert.match(worker.contentType, /javascript/);
		assert.match(worker.body.toString("utf8"), /^\/\/ PDF\.js compatibility polyfills for older WebKit webviews\./);
		assert.match(worker.body.toString("utf8"), /Promise\.withResolvers/);
		assert.match(worker.body.toString("utf8"), /Promise\.try/);
		assert.match(worker.body.toString("utf8"), /pdfjsVersion = 5\.7\.284/);

		const cmap = await readHttp(`${server.origin}/viewer-lw/cmaps/Adobe-Japan1-UCS2.bcmap`);
		assert.equal(cmap.status, 200);
		assert.match(cmap.contentType, /application\/octet-stream/);

		const font = await readHttp(`${server.origin}/viewer-lw/standard_fonts/LiberationSans-Regular.ttf`);
		assert.equal(font.status, 200);
		assert.match(font.contentType, /font\/ttf/);

		const wasm = await readHttp(`${server.origin}/viewer-lw/wasm/qcms_bg.wasm`);
		assert.equal(wasm.status, 200);
		assert.match(wasm.contentType, /application\/wasm/);

		const provenance = await readHttp(`${server.origin}/viewer-lw/README.md`);
		assert.equal(provenance.status, 200);
		assert.match(provenance.contentType, /text\/markdown|application\/octet-stream/);
		assert.match(provenance.body.toString("utf8"), /pdfjsVersion = 5\.7\.284|Version consistency/);

		const license = await readHttp(`${server.origin}/viewer-lw/LICENSE-PDF.js.txt`);
		assert.equal(license.status, 200);
		assert.match(license.contentType, /text\/plain/);
		assert.match(license.body.toString("utf8"), /Apache License/);

		const missing = await readHttp(`${server.origin}/viewer-lw/999`);
		assert.equal(missing.status, 404);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { fetchHookContext, findViewerHostHookDiscoveries } from "../../src/modules/hook_context.ts";
import { persistentViewerHostStatePath, writePersistentViewerHostState } from "../../src/modules/viewer_host_discovery.ts";
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

async function openViewerSocket(viewerSocketUrl: string): Promise<TestWebSocket> {
	const WebSocket = socketCtor();
	const socket = new WebSocket(viewerSocketUrl);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timer = setTimeout(() => rejectOpen(new Error("timed out opening viewer socket")), 2_000);
		socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timer); rejectOpen(new Error("viewer socket errored before open")); }, { once: true });
	});
	return socket;
}

async function nextJsonMessage(socket: TestWebSocket, predicate: (message: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
	return await new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
		const timer = setTimeout(() => rejectMessage(new Error("timed out waiting for viewer socket message")), 2_000);
		const listen = () => {
			socket.addEventListener("message", (event) => {
				const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
				const message = JSON.parse(data) as Record<string, unknown>;
				if (!predicate(message)) {
					listen();
					return;
				}
				clearTimeout(timer);
				resolveMessage(message);
			}, { once: true });
		};
		listen();
	});
}

function sendMarkSnapshot(socket: TestWebSocket, request: Record<string, unknown>, annotations: readonly Record<string, unknown>[]): void {
	socket.send(JSON.stringify({
		type: "pdf_annotations_snapshot",
		pdf_id: request.pdf_id,
		request_id: request.request_id,
		annotations,
	}));
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

function writeDiscovery(runtimeRoot: string, agentId: string, server: ViewerHostServer, controlToken: string, cwd: string): void {
	writePersistentViewerHostState(join(runtimeRoot, "agents", agentId), {
		origin: server.origin,
		viewer_url: server.viewerRootUrl,
		control_token: controlToken,
		cwd: resolve(cwd),
		updated_at: new Date().toISOString(),
	});
}

test("fetchHookContext returns empty text when no Viewer Host discovery exists", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-empty-"));
	try {
		assert.equal(await fetchHookContext({ runtimeRoot: join(baseDir, "runtime"), agentId: "missing", prompt: "hello" }), "");
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("fetchHookContext removes stale Viewer Host discovery after network failure", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-stale-discovery-"));
	const runtimeRoot = join(baseDir, "runtime");
	const runtimeDir = join(runtimeRoot, "agents", "dead-agent");
	try {
		writePersistentViewerHostState(runtimeDir, {
			origin: "http://127.0.0.1:9",
			viewer_url: "http://127.0.0.1:9/viewer-lw",
			control_token: "dead-hook-control-token",
			cwd: baseDir,
			updated_at: new Date().toISOString(),
		});
		const failingFetch: typeof fetch = async () => { throw new TypeError("fetch failed"); };
		await assert.rejects(fetchHookContext({ runtimeRoot, agentId: "dead-agent", cwd: baseDir, fetchImpl: failingFetch }), /fetch failed/);
		assert.equal(existsSync(persistentViewerHostStatePath(runtimeDir)), false);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("agent-synctex fetch-info reports a discovered Viewer Host failure instead of treating it as no marks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-cli-failure-"));
	const runtimeRoot = join(baseDir, "runtime");
	const failingHost = createServer((_request, response) => {
		response.writeHead(503, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: false, error: { code: "mark_claim_failed", message: "simulated mark claim failure" } }));
	});
	let listening = false;
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			failingHost.once("error", rejectListen);
			failingHost.listen(0, "127.0.0.1", () => {
				failingHost.off("error", rejectListen);
				listening = true;
				resolveListen();
			});
		});
		const address = failingHost.address();
		assert.ok(address && typeof address !== "string");
		const origin = `http://127.0.0.1:${address.port}`;
		writePersistentViewerHostState(join(runtimeRoot, "agents", "failing-agent"), {
			origin,
			viewer_url: `${origin}/viewer-lw`,
			control_token: "failing-hook-control-token",
			cwd: baseDir,
			updated_at: new Date().toISOString(),
		});

		const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
		const child = spawn(process.execPath, [scriptPath, "fetch-info", "--harness", "codex", "--agent-id", "failing-agent", "--cwd", baseDir], {
			env: { ...process.env, MCP_TMPDIR: runtimeRoot },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.stdin.end("prompt");
		const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));

		assert.notEqual(code, 0, "a discovered Viewer Host failure must make fetch-info fail");
		assert.equal(stdout, "");
		assert.match(stderr, /simulated mark claim failure/);
	} finally {
		if (listening) await new Promise<void>((resolveClose, rejectClose) => failingHost.close((error) => error ? rejectClose(error) : resolveClose()));
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("socket-connecting mark claim timeouts do not inject hook failures", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-socket-connecting-"));
	const runtimeRoot = join(baseDir, "runtime");
	const failingHost = createServer((_request, response) => {
		response.writeHead(504, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: false, error: { code: "viewer_mark_snapshot_failed", message: "Timed out waiting 1000ms for visible PDF viewer socket connection" } }));
	});
	let listening = false;
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			failingHost.once("error", rejectListen);
			failingHost.listen(0, "127.0.0.1", () => {
				failingHost.off("error", rejectListen);
				listening = true;
				resolveListen();
			});
		});
		const address = failingHost.address();
		assert.ok(address && typeof address !== "string");
		const origin = `http://127.0.0.1:${address.port}`;
		writePersistentViewerHostState(join(runtimeRoot, "agents", "socket-connecting-agent"), {
			origin,
			viewer_url: `${origin}/viewer-lw`,
			control_token: "socket-connecting-control-token",
			cwd: baseDir,
			updated_at: new Date().toISOString(),
		});

		assert.equal(await fetchHookContext({ runtimeRoot, agentId: "socket-connecting-agent", cwd: baseDir }), "");
	} finally {
		if (listening) await new Promise<void>((resolveClose, rejectClose) => failingHost.close((error) => error ? rejectClose(error) : resolveClose()));
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook context claims marks directly from the Viewer Host and acknowledges only delivered annotations", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-direct-"));
	const runtimeRoot = join(baseDir, "runtime");
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n% direct hook\n%%EOF\n");
	writeFileSync(sourcePath, "Marked source line.\n");
	utimesSync(sourcePath, new Date(1_000), new Date(1_000));
	const registry = new ViewerHostPdfRegistry();
	const controlToken = "direct-hook-control-token";
	const server = new ViewerHostServer({ registry, controlToken });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 12, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		writeDiscovery(runtimeRoot, "direct-agent", server, controlToken, baseDir);
		const config = await (await fetch(`${server.origin}/config/12.json`)).json() as { viewer_socket_url: string };
		socket = await openViewerSocket(config.viewer_socket_url);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: sourcePath, line: 1, source_line: "Marked source line.", pdf_mark: "Visible PDF text.", comment: "direct note" }));
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));

		const firstContext = fetchHookContext({ runtimeRoot, agentId: "direct-agent", cwd: baseDir });
		const firstSnapshot = await nextJsonMessage(socket, (message) => message.type === "pdf_annotations_snapshot_request");
		sendMarkSnapshot(socket, firstSnapshot, [{ type: "pdf_annotation", annotation_id: "a1", page: 1, x: 10, y: 20, source_file: sourcePath, line: 1, source_line: "Marked source line.", pdf_mark: "Visible PDF text.", comment: "direct note" }]);
		const cleared = nextJsonMessage(socket, (message) => message.type === "annotations_cleared");
		assert.equal(await firstContext, "## PDF marks from the User\n\n- main.tex:1\n  Already read TeX source excerpt:\n  ```tex\n  Marked source line.\n  ```\n  Messages:\n  - direct note");
		assert.deepEqual(await cleared, { type: "annotations_cleared", pdf_id: 12, pdf_ids: [12], annotation_ids: ["a1"] });
		const emptyContext = fetchHookContext({ runtimeRoot, agentId: "direct-agent", cwd: baseDir });
		const emptySnapshot = await nextJsonMessage(socket, (message) => message.type === "pdf_annotations_snapshot_request");
		sendMarkSnapshot(socket, emptySnapshot, []);
		assert.equal(await emptyContext, "");
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook context waits briefly for a just-visible mark to reach the Viewer Host", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-race-"));
	const runtimeRoot = join(baseDir, "runtime");
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n% race hook\n%%EOF\n");
	writeFileSync(sourcePath, "Delayed visible mark.\n");
	utimesSync(sourcePath, new Date(1_000), new Date(1_000));
	const registry = new ViewerHostPdfRegistry();
	const controlToken = "race-hook-control-token";
	const server = new ViewerHostServer({ registry, controlToken });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 16, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		writeDiscovery(runtimeRoot, "race-agent", server, controlToken, baseDir);
		const config = await (await fetch(`${server.origin}/config/16.json`)).json() as { viewer_socket_url: string };
		socket = await openViewerSocket(config.viewer_socket_url);

		// This models the browser race: the mark is visible in the viewer, but its
		// optimistic WebSocket update has not yet populated the Host queue. Claiming
		// asks the viewer for the current visible marks before reading the queue.
		const context = fetchHookContext({ runtimeRoot, agentId: "race-agent", cwd: baseDir });
		const snapshotRequest = await nextJsonMessage(socket);
		assert.equal(snapshotRequest.type, "pdf_annotations_snapshot_request");
		sendMarkSnapshot(socket, snapshotRequest, [{ type: "pdf_annotation", annotation_id: "race", page: 1, x: 10, y: 20, source_file: sourcePath, line: 1, source_line: "Delayed visible mark.", pdf_mark: "Visible before enqueue." }]);

		assert.match(
			await context,
			/Delayed visible mark\./,
		);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook failures release marks, report the failure to the viewer, and reject instead of returning no marks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-release-"));
	const runtimeRoot = join(baseDir, "runtime");
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n% release hook\n%%EOF\n");
	writeFileSync(sourcePath, "Retryable mark.\n");
	const registry = new ViewerHostPdfRegistry();
	const controlToken = "release-hook-control-token";
	const server = new ViewerHostServer({ registry, controlToken });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 14, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		writeDiscovery(runtimeRoot, "release-agent", server, controlToken, baseDir);
		const config = await (await fetch(`${server.origin}/config/14.json`)).json() as { viewer_socket_url: string };
		socket = await openViewerSocket(config.viewer_socket_url);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "retry", page: 1, x: 10, y: 20, source_file: sourcePath, line: 1, source_line: "Retryable mark.", pdf_mark: "Retryable PDF mark." }));
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));

		let failAcknowledgement = true;
		const fetchImpl: typeof fetch = async (input, init) => {
			if (failAcknowledgement && String(input).endsWith("/marks/ack")) {
				failAcknowledgement = false;
				return new Response(JSON.stringify({ ok: false, error: { message: "simulated acknowledgement failure" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return await fetch(input, init);
		};
		const failedContext = fetchHookContext({ runtimeRoot, agentId: "release-agent", cwd: baseDir, fetchImpl });
		const failedSnapshot = await nextJsonMessage(socket, (message) => message.type === "pdf_annotations_snapshot_request");
		sendMarkSnapshot(socket, failedSnapshot, [{ type: "pdf_annotation", annotation_id: "retry", page: 1, x: 10, y: 20, source_file: sourcePath, line: 1, source_line: "Retryable mark.", pdf_mark: "Retryable PDF mark." }]);
		const viewerError = nextJsonMessage(socket, (message) => message.type === "viewer_error");
		await assert.rejects(failedContext, /simulated acknowledgement failure/);
		assert.deepEqual(await viewerError, {
			type: "viewer_error",
			pdf_id: 14,
			code: "mark_delivery_failed",
			title: "Could not deliver PDF marks",
			detail: "simulated acknowledgement failure",
			inject_text: "PDF mark delivery failed: simulated acknowledgement failure",
		});
		const retryContext = fetchHookContext({ runtimeRoot, agentId: "release-agent", cwd: baseDir });
		const retrySnapshot = await nextJsonMessage(socket, (message) => message.type === "pdf_annotations_snapshot_request");
		sendMarkSnapshot(socket, retrySnapshot, [{ type: "pdf_annotation", annotation_id: "retry", page: 1, x: 10, y: 20, source_file: sourcePath, line: 1, source_line: "Retryable mark.", pdf_mark: "Retryable PDF mark." }]);
		assert.match(await retryContext, /Retryable mark\./);
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook claim failures are reported to open viewers before propagating to the harness", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-claim-failure-"));
	const runtimeRoot = join(baseDir, "runtime");
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n% claim failure hook\n%%EOF\n");
	const registry = new ViewerHostPdfRegistry();
	const controlToken = "claim-failure-control-token";
	const server = new ViewerHostServer({ registry, controlToken });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 15, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		writeDiscovery(runtimeRoot, "claim-failure-agent", server, controlToken, baseDir);
		const config = await (await fetch(`${server.origin}/config/15.json`)).json() as { viewer_socket_url: string };
		socket = await openViewerSocket(config.viewer_socket_url);
		const fetchImpl: typeof fetch = async (input, init) => {
			if (String(input).endsWith("/marks/claim")) {
				return new Response(JSON.stringify({ ok: false, error: { message: "simulated claim failure" } }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			}
			return await fetch(input, init);
		};

		const viewerError = nextJsonMessage(socket);
		await assert.rejects(
			() => fetchHookContext({ runtimeRoot, agentId: "claim-failure-agent", cwd: baseDir, fetchImpl }),
			/simulated claim failure/,
		);
		assert.deepEqual(await viewerError, {
			type: "viewer_error",
			code: "mark_fetch_failed",
			title: "Could not fetch PDF marks",
			detail: "simulated claim failure",
			inject_text: "PDF mark delivery failed: simulated claim failure",
		});
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hook discovery never overrides an explicit agent identity and uses only an unambiguous cwd fallback", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-cwd-"));
	const runtimeRoot = join(baseDir, "runtime");
	const projectCwd = join(baseDir, "project");
	const otherCwd = join(baseDir, "other");
	const pdfPath = join(projectCwd, "paper.pdf");
	const sourcePath = join(projectCwd, "main.tex");
	mkdirSync(projectCwd, { recursive: true });
	mkdirSync(otherCwd, { recursive: true });
	writeFileSync(pdfPath, "%PDF-1.4\n% cwd hook\n%%EOF\n");
	writeFileSync(sourcePath, "CWD source.\n");
	utimesSync(sourcePath, new Date(1_000), new Date(1_000));
	const registry = new ViewerHostPdfRegistry();
	const controlToken = "cwd-hook-control-token";
	const server = new ViewerHostServer({ registry, controlToken });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 13, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		writeDiscovery(runtimeRoot, "cwd-agent", server, controlToken, projectCwd);
		writePersistentViewerHostState(join(runtimeRoot, "agents", "unrelated-agent"), {
			origin: "http://127.0.0.1:65534",
			viewer_url: "http://127.0.0.1:65534/viewer-lw",
			control_token: "unrelated-control-token",
			cwd: otherCwd,
			updated_at: new Date().toISOString(),
		});
		const config = await (await fetch(`${server.origin}/config/13.json`)).json() as { viewer_socket_url: string };
		socket = await openViewerSocket(config.viewer_socket_url);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "cwd", page: 1, x: 1, y: 2, source_file: sourcePath, line: 1, pdf_mark: "CWD PDF mark." }));
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));

		assert.equal(await fetchHookContext({ runtimeRoot, agentId: "missing-session", cwd: projectCwd }), "", "an explicit missing agent must not consume another same-project agent's marks");
		const cwdContext = fetchHookContext({ runtimeRoot, cwd: projectCwd });
		const cwdSnapshot = await nextJsonMessage(socket, (message) => message.type === "pdf_annotations_snapshot_request");
		sendMarkSnapshot(socket, cwdSnapshot, [{ type: "pdf_annotation", annotation_id: "cwd", page: 1, x: 1, y: 2, source_file: sourcePath, line: 1, pdf_mark: "CWD PDF mark." }]);
		assert.equal(await cwdContext, "## PDF marks from the User\n\n- main.tex:1\n  Already read TeX source excerpt:\n  ```tex\n  CWD source.\n  ```");
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("cwd-only hook discovery fails closed when more than one agent owns the project", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-ambiguous-cwd-"));
	const runtimeRoot = join(baseDir, "runtime");
	const projectCwd = join(baseDir, "project");
	mkdirSync(projectCwd, { recursive: true });
	try {
		for (const [agentId, port] of [["agent-a", 65531], ["agent-b", 65532]] as const) {
			writePersistentViewerHostState(join(runtimeRoot, "agents", agentId), {
				origin: `http://127.0.0.1:${port}`,
				viewer_url: `http://127.0.0.1:${port}/viewer-lw`,
				control_token: `${agentId}-control-token`,
				cwd: projectCwd,
				updated_at: new Date().toISOString(),
			});
		}
		assert.deepEqual(findViewerHostHookDiscoveries({ runtimeRoot, agentIdCandidates: ["agent-a", "agent-b"] }), [], "multiple process-lineage matches must fail closed");
		assert.equal(await fetchHookContext({ runtimeRoot, cwd: projectCwd, requestTimeoutMs: 25 }), "");
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("agent-synctex fetch-info consumes direct Viewer Host context without a bridge server", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "hook-context-cli-"));
	const runtimeRoot = join(baseDir, "runtime");
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n% cli hook\n%%EOF\n");
	writeFileSync(sourcePath, "CLI source.\n");
	utimesSync(sourcePath, new Date(1_000), new Date(1_000));
	const registry = new ViewerHostPdfRegistry();
	const controlToken = "cli-hook-control-token";
	const server = new ViewerHostServer({ registry, controlToken });
	let socket: TestWebSocket | undefined;
	try {
		registry.registerPdf({ pdfId: 14, pdfPath, title: basename(pdfPath), revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		writeDiscovery(runtimeRoot, "cli-agent", server, controlToken, baseDir);
		const config = await (await fetch(`${server.origin}/config/14.json`)).json() as { viewer_socket_url: string };
		socket = await openViewerSocket(config.viewer_socket_url);
		socket.send(JSON.stringify({ type: "pdf_annotation", annotation_id: "cli", page: 1, x: 1, y: 2, source_file: sourcePath, line: 1, pdf_mark: "CLI PDF mark." }));
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));

		const scriptPath = resolve(process.cwd(), "scripts", "agent-synctex.ts");
		const child = spawn(process.execPath, [scriptPath, "fetch-info", "--harness", "codex", "--agent-id", "cli-agent", "--cwd", baseDir], {
			env: { ...process.env, MCP_TMPDIR: runtimeRoot },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stdin.end("prompt");
		const cliSnapshot = await nextJsonMessage(socket, (message) => message.type === "pdf_annotations_snapshot_request");
		sendMarkSnapshot(socket, cliSnapshot, [{ type: "pdf_annotation", annotation_id: "cli", page: 1, x: 1, y: 2, source_file: sourcePath, line: 1, pdf_mark: "CLI PDF mark." }]);
		const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
		assert.equal(code, 0);
		assert.equal(stdout, "## PDF marks from the User\n\n- main.tex:1\n  Already read TeX source excerpt:\n  ```tex\n  CLI source.\n  ```");
	} finally {
		socket?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { BrowserViewerAppLauncher, createDefaultViewerHostClientFactory, FakeViewerHostClient, ViewerHostMcpService, type BrowserViewerLaunchTarget, type BrowserViewerLauncher, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import type { McpToViewerHostMessage, ViewerHostControlResponse, ViewerHostToMcpMessage } from "../../src/modules/viewer_host_protocol.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

function writeFakePdf(path: string, body = "1 0 obj"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
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

function writeFakeNativeSynctex(binDir: string, stdout: string, status = 0): void {
	mkdirSync(binDir, { recursive: true });
	const commandPath = join(binDir, "synctex");
	writeFileSync(commandPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${status});\n`);
	chmodSync(commandPath, 0o700);
}

function writeFakeLatexmk(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(
		compilerPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const texFile = process.argv[process.argv.length - 1];
const outDir = path.dirname(texFile);
const name = path.basename(texFile).replace(/\\.tex$/, "");
fs.writeFileSync(path.join(outDir, name + ".log"), "fake log\\n");
fs.writeFileSync(path.join(outDir, name + ".pdf"), "%PDF-1.4\\n%%EOF\\n");
process.exit(0);
`,
	);
	chmodSync(compilerPath, 0o700);
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

function callTool(id: number, name: string, args: Record<string, unknown>, service: ViewerHostMcpService) {
	return handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), service.pdfOperations);
}

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

async function openViewerSocket(origin: string, pdfId: number): Promise<TestWebSocket> {
	const configResponse = await fetch(`${origin}/config/${pdfId}.json`);
	assert.equal(configResponse.status, 200);
	const config = await configResponse.json() as { viewer_socket_token?: unknown };
	assert.equal(typeof config.viewer_socket_token, "string");
	const WebSocket = socketCtor();
	const socket = new WebSocket(`${origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${pdfId}&token=${encodeURIComponent(String(config.viewer_socket_token))}`);
	await new Promise<void>((resolveOpen, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out opening viewer socket for pdf_id=${pdfId}`)), 2_000);
		socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`viewer socket errored before open for pdf_id=${pdfId}`)); }, { once: true });
	});
	return socket;
}

async function nextJsonMessage(socket: TestWebSocket): Promise<Record<string, unknown>> {
	return await new Promise<Record<string, unknown>>((resolveMessage, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for viewer socket message")), 2_000);
		socket.addEventListener("message", (event) => {
			clearTimeout(timer);
			const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
			resolveMessage(JSON.parse(data) as Record<string, unknown>);
		}, { once: true });
	});
}

class HttpViewerHostClient implements ViewerHostClient {
	readonly origin: string;
	private readonly client: ViewerHostControlClient;

	constructor(origin: string) {
		this.origin = origin;
		this.client = new ViewerHostControlClient({ origin });
	}

	async send(message: McpToViewerHostMessage): Promise<void> {
		const response: ViewerHostControlResponse = await this.client.send(message);
		if (!response.ok) throw new Error(response.error.message);
	}
}

class ScriptedViewerHostClient implements ViewerHostClient {
	readonly origin: string;
	readonly messages: McpToViewerHostMessage[] = [];
	failNextMessageType: McpToViewerHostMessage["type"] | undefined;

	constructor(origin: string) {
		this.origin = origin;
	}

	async send(message: McpToViewerHostMessage): Promise<void> {
		if (this.failNextMessageType === message.type) {
			this.failNextMessageType = undefined;
			throw new Error(`control channel unavailable while sending ${message.type}`);
		}
		this.messages.push(message);
	}
}

class RecordingBrowserViewerLauncher implements BrowserViewerLauncher {
	readonly calls: BrowserViewerLaunchTarget[] = [];

	async launchOrFocus(target: BrowserViewerLaunchTarget): Promise<void> {
		this.calls.push(target);
	}
}

class ViewerSocketBrowserLauncher extends RecordingBrowserViewerLauncher {
	private readonly pdfId: number;
	private socket: WebSocket | undefined;

	constructor(pdfId: number) {
		super();
		this.pdfId = pdfId;
	}

	override async launchOrFocus(target: BrowserViewerLaunchTarget): Promise<void> {
		await super.launchOrFocus(target);
		const config = await (await fetch(`${target.origin}/config/${this.pdfId}.json`)).json() as { viewer_socket_url?: unknown };
		if (typeof config.viewer_socket_url !== "string") throw new Error("viewer socket URL missing");
		this.socket = new WebSocket(config.viewer_socket_url);
		await new Promise<void>((resolveOpen, rejectOpen) => {
			const timer = setTimeout(() => rejectOpen(new Error("timed out opening simulated viewer socket")), 1_000);
			this.socket?.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
			this.socket?.addEventListener("error", () => { clearTimeout(timer); rejectOpen(new Error("simulated viewer socket errored")); }, { once: true });
		});
	}

	close(): void {
		this.socket?.close();
	}
}

test("Browser viewer launcher reports immediate opener failures", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-opener-failure-"));
	try {
		const opener = join(baseDir, "fail-open");
		writeFileSync(opener, `#!/bin/sh\necho opener failed >&2\nexit 7\n`);
		chmodSync(opener, 0o700);
		const launcher = new BrowserViewerAppLauncher({ command: opener });
		await assert.rejects(
			() => launcher.launchOrFocus({ origin: "http://127.0.0.1:1", appUrl: "http://127.0.0.1:1/viewer-lw" }),
			/opener .*exited with code 7: opener failed/,
		);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("reverse-forward probe is handled by ViewerHostServer without mcpEventSink or PDF events", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-probe-boundary-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const sinkMessages: ViewerHostToMcpMessage[] = [];
	const server = new ViewerHostServer({
		registry,
		mcpEventSink: (message) => {
			sinkMessages.push(message);
			return service?.handleHostMessage(message);
		},
	});
	let socket: TestWebSocket | undefined;
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 812 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		socket = await openViewerSocket(server.origin, 812);

		socket.send(JSON.stringify({ type: "reverse_synctex_forward_probe", request_id: 1, page: 1, x: 144, y: 155 }));
		const result = await nextJsonMessage(socket);

		assert.equal(result.type, "reverse_synctex_forward_probe_result");
		assert.equal(result.pdf_id, 812);
		assert.equal(result.request_id, 1);
		assert.equal(result.reverse_source_file, sourcePath);
		assert.equal(result.reverse_line, 3);
		assert.equal(result.source_file, sourcePath);
		assert.equal(result.line, 3);
		assert.equal(result.page, 1);
		assert.equal(sinkMessages.length, 0, "debug probe must not be routed through mcpEventSink");

		const events = await service.getPdfEvents({ pdf_id: 812, max_events: 10, stale: true, debug: true });
		assert.equal(events.length, 0, "debug probe must not be appended to the MCP event store");
	} finally {
		socket?.close();
		await service?.stop();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("default Viewer Host client factory reuses agent runtime server origin", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-reuse-"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	const launches: BrowserViewerLaunchTarget[] = [];
	try {
		await server.start();
		writeFileSync(join(baseDir, "viewer-host.json"), JSON.stringify({ origin: server.origin, app_url: server.appUrl, pid: 12345, updated_at: new Date().toISOString() }) + "\n");
		const factory = createDefaultViewerHostClientFactory({
			agentRuntimeDir: baseDir,
			command: join(baseDir, "must-not-launch"),
			browserOpenAckTimeoutMs: 20,
			browserLauncher: { launchOrFocus: (target) => { launches.push(target); } },
		});
		const client = await factory();
		assert.equal(client.origin, server.origin);
		const pdfPath = join(baseDir, "paper.pdf");
		writeFakePdf(pdfPath);
		const response = await client.send({ type: "open_pdf", pdf_id: 345, pdf_path: pdfPath, title: "paper.pdf", workspace_cwd: baseDir });
		assert.equal(response?.ok, true);
		assert.equal(registry.getPdf(345).pdfPath, resolve(pdfPath));
		assert.equal(launches.length, 1);
		assert.equal(launches[0]?.origin, server.origin);
		assert.equal(response?.ok === true && "result" in response ? response.result.browser_open_confirmed : undefined, false);
		assert.equal(JSON.parse(readFileSync(join(baseDir, "viewer-host.json"), "utf8")).browser_opened_at, undefined);
		await client.close?.();
		assert.equal((await fetch(`${server.origin}/config/345.json`)).status, 200, "reused server should not be shut down when client closes");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("default Viewer Host client factory reopens an already-opened reused host when no active viewer is connected", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-reuse-opened-"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	const launches: BrowserViewerLaunchTarget[] = [];
	try {
		await server.start();
		writeFileSync(join(baseDir, "viewer-host.json"), JSON.stringify({ origin: server.origin, app_url: server.appUrl, pid: 12345, updated_at: new Date().toISOString(), browser_opened_at: new Date().toISOString() }) + "\n");
		const factory = createDefaultViewerHostClientFactory({
			agentRuntimeDir: baseDir,
			command: join(baseDir, "must-not-launch"),
			browserOpenAckTimeoutMs: 20,
			browserLauncher: { launchOrFocus: (target) => { launches.push(target); } },
		});
		const client = await factory();
		const pdfPath = join(baseDir, "paper.pdf");
		writeFakePdf(pdfPath);
		const response = await client.send({ type: "open_pdf", pdf_id: 346, pdf_path: pdfPath, title: "paper.pdf", workspace_cwd: baseDir });
		assert.equal(response?.ok, true);
		assert.equal(launches.length, 1);
		assert.equal(response?.ok === true && "result" in response ? response.result.browser_open_confirmed : undefined, false);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("default Viewer Host client factory opens the stable browser viewer before viewer operations", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-launch-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const browserLauncher = new ViewerSocketBrowserLauncher(91);
	const service = new ViewerHostMcpService({
		clientFactory: createDefaultViewerHostClientFactory({
			command: process.execPath,
			args: [resolve(process.cwd(), "scripts", "viewer-host-server.ts")],
			browserOpenAckTimeoutMs: 1_000,
			browserLauncher: browserLauncher,
		}),
		makePdfId: () => 91,
	});
	try {
		const first = await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };
		const second = await callTool(2, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(first.result?.details?.pdf_id, 91);
		assert.equal(second.result?.details?.pdf_id, 91);
		assert.equal(browserLauncher.calls.length, 1, "open/focus operations should only open the stable browser viewer once per host session");
		assert.deepEqual(browserLauncher.calls.map((call) => call.appUrl), browserLauncher.calls.map((call) => `${call.origin}/viewer-lw`));
		assert.match(browserLauncher.calls[0]?.appUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/viewer-lw$/);
		const config = await fetch(`${browserLauncher.calls[0].origin}/config/91.json`);
		assert.equal(config.status, 200, "returned viewer/config URL must remain reachable while the Host is alive");
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("open_pdf uses an MCP-owned pdf_id and routes open/focus messages through Viewer Host Client", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-open-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 77 });
	try {
		const first = await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };
		const second = await callTool(2, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(first.result?.details?.pdf_id, 77);
		assert.equal(second.result?.details?.pdf_id, 77);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "focus_pdf"]);
		assert.deepEqual(client.messages[0], { type: "open_pdf", pdf_id: 77, pdf_path: pdfPath, title: basename(pdfPath), workspace_cwd: baseDir });
		assert.deepEqual(client.messages[1], { type: "focus_pdf", pdf_id: 77 });
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("hidden debug_synctex option toggles reverse SyncTeX debug overlays without appearing in the tool schema", async () => {
	const listResponse = await handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
	const openPdfTool = listResponse.result?.tools?.find((tool) => tool.name === "open_pdf");
	assert.equal(openPdfTool?.inputSchema?.properties?.debug_synctex, undefined);

	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-hidden-debug-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 78 });
	try {
		await callTool(2, "open_pdf", { pdf_file_path: pdfPath, debug_synctex: true, workspace_context: { cwd: baseDir } }, service);
		await callTool(3, "open_pdf", { pdf_file_path: pdfPath, debug_synctex: false, workspace_context: { cwd: baseDir } }, service);

		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "focus_pdf", "set_debug_synctex"]);
		assert.deepEqual(client.messages[0], { type: "open_pdf", pdf_id: 78, pdf_path: pdfPath, title: basename(pdfPath), workspace_cwd: baseDir, debug_synctex: true });
		assert.deepEqual(client.messages[2], { type: "set_debug_synctex", pdf_id: 78, enabled: false });
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("jump_pdf maps SyncTeX in MCP and sends synctex_forward through Viewer Host Client", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-jump-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 5 });
	try {
		const binDir = join(baseDir, "bin");
		writeFakeNativeSynctex(binDir, [
			"SyncTeX result begin",
			"Output:1",
			"Page:4",
			"x:501",
			"y:601",
			"h:500",
			"v:600",
			"W:70",
			"H:9",
			"Output:2",
			"Page:4",
			"x:801",
			"y:901",
			"h:800",
			"v:900",
			"W:30",
			"H:6",
			"SyncTeX result end",
		].join("\n"));
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		const response = await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => await callTool(2, "jump_pdf", { pdf_id: 5, line: 3, source_file: sourcePath, workspace_context: { cwd: baseDir } }, service)) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.handled, true);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "synctex_forward"]);
		const synctexMessage = client.messages[1] as unknown as Record<string, unknown>;
		assert.equal(synctexMessage.page, response.result?.details?.page);
		assert.equal(synctexMessage.x, response.result?.details?.x);
		assert.equal(synctexMessage.y, response.result?.details?.y);
		assert.equal(synctexMessage.page, 4);
		assert.equal(synctexMessage.x, 501);
		assert.equal(synctexMessage.y, 601);
		assert.equal(synctexMessage.indicator, true);
		assert.equal(synctexMessage.source_file, sourcePath);
		assert.equal(synctexMessage.line, 3);
		const expectedRanges = [
			{ page: 4, h: 500, v: 600, W: 70, H: 9 },
			{ page: 4, h: 800, v: 900, W: 30, H: 6 },
		];
		assert.deepEqual(synctexMessage.ranges, expectedRanges);
		assert.deepEqual(response.result?.details?.ranges, expectedRanges);
		assert.match(String(response.result?.details?.synctex_branch), /^(native|js_fallback)$/);
		const diagnostics = response.result?.details?.synctex_diagnostics as {
			branch: string;
			native: { command: string; stdout: string; parsedRectangles: unknown[] };
		};
		assert.equal(diagnostics.branch, "native");
		assert.equal(diagnostics.native.command, "synctex");
		assert.match(diagnostics.native.stdout, /SyncTeX result begin/);
		assert.deepEqual(diagnostics.native.parsedRectangles, expectedRanges);
		assert.equal(Object.hasOwn(client.messages[1] ?? {}, "width"), false, "ViewerHostMcpService.jumpPdf must emit native ranges without legacy width");
		assert.equal(Object.hasOwn(client.messages[1] ?? {}, "height"), false, "ViewerHostMcpService.jumpPdf must emit native ranges without legacy height");
		assert.equal(Object.hasOwn(response.result?.details ?? {}, "width"), false);
		assert.equal(Object.hasOwn(response.result?.details ?? {}, "height"), false);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("jump_pdf exposes JS fallback diagnostics after native SyncTeX failure", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-jump-js-fallback-diagnostics-"));
	const binDir = join(baseDir, "bin");
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const client = new FakeViewerHostClient({ origin: "http://viewer-host.local" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 6 });
	try {
		writeFakeNativeSynctex(binDir, "native failed intentionally", 1);
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		const response = await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => await callTool(2, "jump_pdf", { pdf_id: 6, line: 3, source_file: sourcePath, workspace_context: { cwd: baseDir } }, service)) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.handled, true);
		assert.equal(response.result?.details?.synctex_branch, "js_fallback");
		const diagnostics = response.result?.details?.synctex_diagnostics as {
			branch: string;
			native: { status: number; stdout: string; failureReason: string; parsedRectangles: unknown[] };
			jsFallback: { attempted: boolean; point: { page: number; x: number; y: number; indicator: boolean } };
		};
		assert.equal(diagnostics.branch, "js_fallback");
		assert.equal(diagnostics.native.status, 1);
		assert.equal(diagnostics.native.stdout, "native failed intentionally");
		assert.deepEqual(diagnostics.native.parsedRectangles, []);
		assert.equal(diagnostics.jsFallback.attempted, true);
		assert.deepEqual(diagnostics.jsFallback.point, {
			page: response.result?.details?.page,
			x: response.result?.details?.x,
			y: response.result?.details?.y,
			indicator: true,
		});
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("MCP relaunches and re-registers known PDFs before focusing after a Viewer Host control failure", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-relaunch-focus-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const clients = [
		new ScriptedViewerHostClient("http://127.0.0.1:41001"),
		new ScriptedViewerHostClient("http://127.0.0.1:41002"),
	];
	let launches = 0;
	const service = new ViewerHostMcpService({
		clientFactory: async () => clients[launches++] ?? (() => { throw new Error("unexpected relaunch"); })(),
		makePdfId: () => 41,
	});
	try {
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		clients[0].failNextMessageType = "focus_pdf";

		const response = await callTool(2, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.pdf_id, 41);
		assert.equal(response.result?.details?.reused, true);
		assert.deepEqual(clients[0].messages.map((message) => message.type), ["open_pdf"]);
		assert.deepEqual(clients[1].messages.map((message) => message.type), ["open_pdf", "focus_pdf"]);
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 41, pdf_path: pdfPath, title: basename(pdfPath), workspace_cwd: baseDir });
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("jump_pdf relaunches, re-registers the existing pdf_id, then sends synctex_forward after Viewer Host restart", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-relaunch-jump-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const clients = [
		new ScriptedViewerHostClient("http://127.0.0.1:42001"),
		new ScriptedViewerHostClient("http://127.0.0.1:42002"),
	];
	let launches = 0;
	const service = new ViewerHostMcpService({
		clientFactory: async () => clients[launches++] ?? (() => { throw new Error("unexpected relaunch"); })(),
		makePdfId: () => 52,
	});
	try {
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		clients[0].failNextMessageType = "synctex_forward";

		const response = await callTool(2, "jump_pdf", { pdf_id: 52, line: 3, source_file: sourcePath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.handled, true);
		assert.equal(response.result?.details?.pdf_id, 52);
		assert.deepEqual(clients[1].messages.map((message) => message.type), ["open_pdf", "synctex_forward"]);
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 52, pdf_path: pdfPath, title: basename(pdfPath), workspace_cwd: baseDir });
		assert.equal(clients[1].messages[1]?.type, "synctex_forward");
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("concurrent operations after Host failure share one relaunch and register before focus", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-concurrent-relaunch-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	class DeadAfterOpenClient extends ScriptedViewerHostClient {
		async send(message: McpToViewerHostMessage): Promise<void> {
			if (message.type === "focus_pdf") {
				await new Promise((resolve) => setTimeout(resolve, 20));
				throw new Error("dead host socket");
			}
			await super.send(message);
		}
	}
	const clients = [
		new DeadAfterOpenClient("http://127.0.0.1:42501"),
		new ScriptedViewerHostClient("http://127.0.0.1:42502"),
		new ScriptedViewerHostClient("http://127.0.0.1:42503"),
	];
	let launches = 0;
	const service = new ViewerHostMcpService({
		clientFactory: async () => clients[launches++] ?? (() => { throw new Error("unexpected relaunch"); })(),
		makePdfId: () => 67,
	});
	try {
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);

		const [first, second] = await Promise.all([
			callTool(2, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as Promise<{ result?: { details?: Record<string, unknown> } }>,
			callTool(3, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as Promise<{ result?: { details?: Record<string, unknown> } }>,
		]);

		assert.equal(first.result?.details?.pdf_id, 67);
		assert.equal(second.result?.details?.pdf_id, 67);
		assert.equal(launches, 2, "concurrent reconnects should coalesce onto one relaunched Host client");
		assert.deepEqual(clients[1].messages.map((message) => message.type), ["open_pdf", "focus_pdf", "focus_pdf"]);
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 67, pdf_path: pdfPath, title: basename(pdfPath), workspace_cwd: baseDir });
		assert.deepEqual(clients[2].messages, []);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("new open racing with reconnect joins the same Host generation and registers after re-register", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-reconnect-new-open-"));
	const firstPdfPath = join(baseDir, "first.pdf");
	const secondPdfPath = join(baseDir, "second.pdf");
	writeFakePdf(firstPdfPath, "first");
	writeFakePdf(secondPdfPath, "second");
	class DeadOnFocusClient extends ScriptedViewerHostClient {
		async send(message: McpToViewerHostMessage): Promise<void> {
			if (message.type === "focus_pdf") throw new Error("dead host while focusing");
			await super.send(message);
		}
	}
	const clients = [
		new DeadOnFocusClient("http://127.0.0.1:42601"),
		new ScriptedViewerHostClient("http://127.0.0.1:42602"),
		new ScriptedViewerHostClient("http://127.0.0.1:42603"),
	];
	let launches = 0;
	let unblockReconnect: (() => void) | undefined;
	const reconnectStarted = new Promise<void>((resolveStarted) => {
		unblockReconnect = resolveStarted;
	});
	let releaseReconnect: (() => void) | undefined;
	const reconnectMayFinish = new Promise<void>((resolveRelease) => {
		releaseReconnect = resolveRelease;
	});
	const service = new ViewerHostMcpService({
		clientFactory: async () => {
			const launchIndex = launches++;
			if (launchIndex === 1) {
				unblockReconnect?.();
				await reconnectMayFinish;
			}
			return clients[launchIndex] ?? (() => { throw new Error("unexpected relaunch"); })();
		},
		makePdfId: (() => {
			let next = 70;
			return () => next++;
		})(),
	});
	try {
		await callTool(1, "open_pdf", { pdf_file_path: firstPdfPath, workspace_context: { cwd: baseDir } }, service);
		const focusExisting = callTool(2, "open_pdf", { pdf_file_path: firstPdfPath, workspace_context: { cwd: baseDir } }, service) as Promise<{ result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
		await reconnectStarted;
		const openSecond = callTool(3, "open_pdf", { pdf_file_path: secondPdfPath, workspace_context: { cwd: baseDir } }, service) as Promise<{ result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
		await new Promise((resolve) => setImmediate(resolve));
		releaseReconnect?.();

		const [first, second] = await Promise.all([focusExisting, openSecond]);

		assert.equal(first.result?.details?.pdf_id, 70);
		assert.equal(second.result?.details?.pdf_id, 71);
		assert.equal(second.result?.details?.viewer_url, undefined);
		assert.equal(second.result?.content?.[0]?.text, "open_pdf ok: pdf_id=71");
		assert.doesNotMatch(JSON.stringify(second.result), /127\.0\.0\.1|viewer_url/);
		assert.equal(launches, 2, "new open must not launch a second Host while reconnect is in progress");
		assert.deepEqual(clients[1].messages.map((message) => message.type), ["open_pdf", "focus_pdf", "open_pdf"]);
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 70, pdf_path: firstPdfPath, title: basename(firstPdfPath), workspace_cwd: baseDir });
		assert.deepEqual(clients[1].messages[2], { type: "open_pdf", pdf_id: 71, pdf_path: secondPdfPath, title: basename(secondPdfPath), workspace_cwd: baseDir });
		assert.deepEqual(clients[2].messages, []);
	} finally {
		releaseReconnect?.();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("re-register failure returns a clear tool error without dropping the MCP-owned pdf_id", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-reregister-failure-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	class FailingRegisterClient extends ScriptedViewerHostClient {
		async send(message: McpToViewerHostMessage): Promise<void> {
			if (message.type === "open_pdf") throw new Error("registration rejected by restarted host");
			await super.send(message);
		}
	}
	const clients = [
		new ScriptedViewerHostClient("http://127.0.0.1:43001"),
		new FailingRegisterClient("http://127.0.0.1:43002"),
		new ScriptedViewerHostClient("http://127.0.0.1:43003"),
	];
	let launches = 0;
	let makePdfIdCalls = 0;
	const service = new ViewerHostMcpService({
		clientFactory: async () => clients[launches++] ?? (() => { throw new Error("unexpected relaunch"); })(),
		makePdfId: () => {
			makePdfIdCalls += 1;
			return 88;
		},
	});
	try {
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		clients[0].failNextMessageType = "focus_pdf";

		const failed = await callTool(2, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
		assert.equal(failed.result?.isError, true);
		assert.match(failed.result?.content?.[0]?.text ?? "", /Viewer Host unavailable.*registration rejected by restarted host/i);
		assert.equal(failed.result?.details?.pdf_id, 88);

		const recovered = await callTool(3, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };
		assert.equal(recovered.result?.details?.pdf_id, 88);
		assert.equal(makePdfIdCalls, 1);
		assert.deepEqual(clients[2].messages.map((message) => message.type), ["open_pdf", "focus_pdf"]);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("viewer_tab_closed host messages do not delete MCP-owned pdf_id state", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tab-close-"));
	const { pdfPath, sourcePath } = writeForwardSynctexFixture(baseDir);
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	const service = new ViewerHostMcpService({ client, makePdfId: () => 9 });
	try {
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		service.handleHostMessage({ type: "viewer_tab_closed", pdf_id: 9 });
		const response = await callTool(2, "jump_pdf", { pdf_id: 9, line: 3, source_file: sourcePath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.handled, true);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "synctex_forward"]);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("show_latex and compile_latex_file(open_pdf=true) route viewer opens through Viewer Host Client", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-compile-"));
	const runtimeDir = join(baseDir, "runtime");
	const projectDir = join(baseDir, "project");
	const binDir = join(baseDir, "bin");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	writeFakeLatexmk(binDir);
	const latexFile = join(projectDir, "paper.tex");
	writeFileSync(latexFile, "\\documentclass{article}\n\\begin{document}File\\end{document}\n");
	const client = new FakeViewerHostClient({ origin: "http://127.0.0.1:43125" });
	let nextPdfId = 10;
	const service = new ViewerHostMcpService({ client, makePdfId: () => nextPdfId++ });
	const previousMcpTmpdir = process.env.MCP_TMPDIR;
	process.env.MCP_TMPDIR = runtimeDir;
	try {
		await withPath(`${binDir}:${process.env.PATH ?? ""}`, async () => {
			const show = await callTool(1, "show_latex", { source: "Hello", workspace_context: { cwd: projectDir } }, service) as { result?: { details?: Record<string, unknown> } };
			const compile = await callTool(2, "compile_latex_file", { latex_file_path: latexFile, open_pdf: true, workspace_context: { cwd: projectDir } }, service) as { result?: { details?: Record<string, unknown> } };

			assert.equal(show.result?.details?.pdf_id, 10);
			assert.equal(compile.result?.details?.pdf_id, 11);
		});
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "open_pdf"]);
	} finally {
		if (previousMcpTmpdir === undefined) delete process.env.MCP_TMPDIR;
		else process.env.MCP_TMPDIR = previousMcpTmpdir;
		rmSync(baseDir, { recursive: true, force: true });
	}
});

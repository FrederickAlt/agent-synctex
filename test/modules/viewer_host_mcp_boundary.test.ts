import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { createDefaultViewerHostClientFactory, DesktopViewerAppProcessLauncher, FakeViewerHostClient, resolveDefaultDesktopViewerAppLaunchConfig, ViewerHostMcpService, type DesktopViewerAppLaunchTarget, type DesktopViewerAppLauncher, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import type { McpToViewerHostMessage } from "../../src/modules/viewer_host_protocol.ts";

function writeFakePdf(path: string, body = "1 0 obj"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
}

function writeForwardSynctexFixture(baseDir: string): { pdfPath: string; sourcePath: string } {
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFakePdf(pdfPath);
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nJump target text.\n\\end{document}\n");
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

function writeFakeDesktopAppLauncher(baseDir: string): { command: string; logPath: string } {
	const command = join(baseDir, "fake-desktop-viewer-app.js");
	const logPath = join(baseDir, "desktop-app-launches.jsonl");
	writeFileSync(command, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  appUrl: process.env.PDF_PREVIEW_VIEWER_HOST_APP_URL,
  origin: process.env.PDF_PREVIEW_VIEWER_HOST_ORIGIN,
  custom: process.env.CUSTOM_APP_ENV,
  argv: process.argv.slice(2)
}) + "\\n");
setInterval(() => {}, 1000);
`);
	chmodSync(command, 0o700);
	return { command, logPath };
}

function writeFailingDesktopAppLauncher(baseDir: string): string {
	const command = join(baseDir, "failing-desktop-viewer-app.js");
	writeFileSync(command, `#!/usr/bin/env node
console.error("desktop app startup failed intentionally");
process.exit(42);
`);
	chmodSync(command, 0o700);
	return command;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!existsSync(path)) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function callTool(id: number, name: string, args: Record<string, unknown>, service: ViewerHostMcpService) {
	return handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), service.pdfOperations);
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

class RecordingDesktopViewerAppLauncher implements DesktopViewerAppLauncher {
	readonly calls: DesktopViewerAppLaunchTarget[] = [];

	async launchOrFocus(target: DesktopViewerAppLaunchTarget): Promise<void> {
		this.calls.push(target);
	}
}

test("desktop app process launcher passes the Host /app target through a configurable app command", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-app-process-contract-"));
	const fakeApp = writeFakeDesktopAppLauncher(baseDir);
	const launcher = new DesktopViewerAppProcessLauncher({ command: fakeApp.command, args: ["--from-test"], env: { CUSTOM_APP_ENV: "set" } });
	try {
		await launcher.launchOrFocus({ origin: "http://127.0.0.1:49152", appUrl: "http://127.0.0.1:49152/app" });
		await waitForFile(fakeApp.logPath);
		const launch = JSON.parse(readFileSync(fakeApp.logPath, "utf8").trim()) as { appUrl?: unknown; origin?: unknown; argv?: unknown; custom?: unknown };
		assert.equal(launch.origin, "http://127.0.0.1:49152");
		assert.equal(launch.appUrl, "http://127.0.0.1:49152/app");
		assert.deepEqual(launch.argv, ["--from-test"]);
		assert.equal(launch.custom, "set");
	} finally {
		await launcher.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("default desktop app binary discovery uses the package root, not the user's LaTeX cwd", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-package-root-discovery-"));
	const userLatexCwd = join(baseDir, "latex-project");
	const packageRoot = join(baseDir, "package-root");
	const packageBinary = resolve(packageRoot, "apps", "viewer-desktop-tauri", "src-tauri", "target", "debug", process.platform === "win32" ? "pdf-preview-viewer.exe" : "pdf-preview-viewer");
	mkdirSync(userLatexCwd, { recursive: true });
	mkdirSync(resolve(packageBinary, ".."), { recursive: true });
	writeFileSync(packageBinary, "#!/usr/bin/env sh\nexit 0\n");
	chmodSync(packageBinary, 0o700);
	const env = { ...process.env };
	delete env.PDF_PREVIEW_VIEWER_APP_COMMAND;
	delete env.PDF_PREVIEW_VIEWER_APP_DEV_FALLBACK;
	try {
		const config = resolveDefaultDesktopViewerAppLaunchConfig(env, userLatexCwd, packageRoot);
		assert.equal(config.command, packageBinary);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("default desktop app dev fallback runs npm from the package root", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-dev-fallback-cwd-"));
	const userLatexCwd = join(baseDir, "latex-project");
	const packageRoot = join(baseDir, "package-root");
	mkdirSync(userLatexCwd, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	const env = { ...process.env };
	delete env.PDF_PREVIEW_VIEWER_APP_COMMAND;
	env.PDF_PREVIEW_VIEWER_APP_DEV_FALLBACK = "1";
	try {
		const config = resolveDefaultDesktopViewerAppLaunchConfig(env, userLatexCwd, packageRoot);
		assert.deepEqual(config, { command: "npm", args: ["run", "tauri:viewer:dev"], cwd: packageRoot });
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("open_pdf returns an app-launch error when the desktop app exits immediately", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-app-launch-fails-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const failingApp = writeFailingDesktopAppLauncher(baseDir);
	const service = new ViewerHostMcpService({
		clientFactory: createDefaultViewerHostClientFactory({
			command: process.execPath,
			args: [resolve(process.cwd(), "scripts", "viewer-host-server.ts")],
			desktopAppLauncher: new DesktopViewerAppProcessLauncher({ command: failingApp }),
		}),
		makePdfId: () => 92,
	});
	try {
		const response = await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
		assert.equal(response.result?.isError, true);
		assert.equal(response.result?.details?.error_code, "viewer_host_unavailable");
		assert.equal(response.result?.details?.viewer_url, undefined, "failed app launch must not return an OK headless viewer handle");
		assert.match(response.result?.content?.[0]?.text ?? "", /Desktop Viewer app exited during startup.*code 42.*desktop app startup failed intentionally/i);
	} finally {
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("default Viewer Host client factory launches/focuses the desktop app at Host /app before viewer operations", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-default-app-launch-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const appLauncher = new RecordingDesktopViewerAppLauncher();
	const service = new ViewerHostMcpService({
		clientFactory: createDefaultViewerHostClientFactory({
			command: process.execPath,
			args: [resolve(process.cwd(), "scripts", "viewer-host-server.ts")],
			desktopAppLauncher: appLauncher,
		}),
		makePdfId: () => 91,
	});
	try {
		const first = await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };
		const second = await callTool(2, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(first.result?.details?.pdf_id, 91);
		assert.equal(second.result?.details?.pdf_id, 91);
		assert.equal(appLauncher.calls.length, 2, "open and focus operations should invoke the desktop app launcher/focuser");
		assert.deepEqual(appLauncher.calls.map((call) => call.appUrl), appLauncher.calls.map((call) => `${call.origin}/app`));
		assert.match(appLauncher.calls[0]?.appUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/app$/);
		const config = await fetch(`${appLauncher.calls[0].origin}/config/91.json`);
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
		const first = await callTool(1, "open_pdf", { pdf_file_path: pdfPath }, service) as { result?: { details?: Record<string, unknown> } };
		const second = await callTool(2, "open_pdf", { pdf_file_path: pdfPath }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(first.result?.details?.pdf_id, 77);
		assert.equal(second.result?.details?.pdf_id, 77);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "focus_pdf"]);
		assert.deepEqual(client.messages[0], { type: "open_pdf", pdf_id: 77, pdf_path: pdfPath, title: basename(pdfPath) });
		assert.deepEqual(client.messages[1], { type: "focus_pdf", pdf_id: 77 });
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
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);
		const response = await callTool(2, "jump_pdf", { pdf_id: 5, line: 3, source_file: sourcePath, workspace_context: { cwd: baseDir } }, service) as { result?: { details?: Record<string, unknown> } };

		assert.equal(response.result?.details?.handled, true);
		assert.deepEqual(client.messages.map((message) => message.type), ["open_pdf", "synctex_forward"]);
		assert.deepEqual(client.messages[1], {
			type: "synctex_forward",
			pdf_id: 5,
			page: 1,
			x: 110,
			y: 220,
			source_file: sourcePath,
			line: 3,
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
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 41, pdf_path: pdfPath, title: basename(pdfPath) });
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
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 52, pdf_path: pdfPath, title: basename(pdfPath) });
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
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 67, pdf_path: pdfPath, title: basename(pdfPath) });
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
		const focusExisting = callTool(2, "open_pdf", { pdf_file_path: firstPdfPath, workspace_context: { cwd: baseDir } }, service) as Promise<{ result?: { details?: Record<string, unknown> } }>;
		await reconnectStarted;
		const openSecond = callTool(3, "open_pdf", { pdf_file_path: secondPdfPath, workspace_context: { cwd: baseDir } }, service) as Promise<{ result?: { details?: Record<string, unknown> } }>;
		await new Promise((resolve) => setImmediate(resolve));
		releaseReconnect?.();

		const [first, second] = await Promise.all([focusExisting, openSecond]);

		assert.equal(first.result?.details?.pdf_id, 70);
		assert.equal(second.result?.details?.pdf_id, 71);
		assert.equal(second.result?.details?.viewer_url, "http://127.0.0.1:42602/viewer/71");
		assert.equal(launches, 2, "new open must not launch a second Host while reconnect is in progress");
		assert.deepEqual(clients[1].messages.map((message) => message.type), ["open_pdf", "focus_pdf", "open_pdf"]);
		assert.deepEqual(clients[1].messages[0], { type: "open_pdf", pdf_id: 70, pdf_path: firstPdfPath, title: basename(firstPdfPath) });
		assert.deepEqual(clients[1].messages[2], { type: "open_pdf", pdf_id: 71, pdf_path: secondPdfPath, title: basename(secondPdfPath) });
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

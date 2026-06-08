import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { resolveAgentWorkspaceContext } from "../../../src/modules/agent_runtime_context.ts";
import { contextSessionKey } from "../../../src/modules/pi_extension/context_session.ts";
import { SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR } from "../../../src/modules/pi_extension/lifecycle.ts";
import { HOST_SERVICE_SOCKET_PATH_ENV_VAR, HostServiceClient, HostServiceServer, HostServiceSessionLeaseService } from "../../../src/modules/host_service.ts";

const PI_TUI_STUB_SOURCE = `let capabilityState = { images: null, trueColor: true, hyperlinks: false };

export const setImageCapability = (images) => {
	capabilityState = { ...capabilityState, images };
};

export const getCapabilities = () => ({ ...capabilityState });

export const getCellDimensions = () => ({
	widthPx: 10,
	heightPx: 20,
});

export const getPngDimensions = () => ({
	widthPx: 40,
	heightPx: 20,
});

export const calculateImageRows = (imageDimensions, targetWidthCells, cellDimensions = getCellDimensions()) => {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	return Math.max(1, Math.ceil(scaledHeightPx / cellDimensions.heightPx));
};

export class Text {
	#text;

	constructor(text) {
		this.#text = String(text);
	}

	setText(text) {
		this.#text = String(text);
	}

	render() {
		return [this.#text];
	}

	invalidate() {}
}

export class Container {
	#children = [];

	addChild(child) {
		this.#children.push(child);
	}

	removeChild(child) {
		const index = this.#children.indexOf(child);
		if (index >= 0) this.#children.splice(index, 1);
	}

	render(width) {
		return this.#children.flatMap((child) => child.render(width));
	}

	invalidate() {
		for (const child of this.#children) {
			child.invalidate();
		}
	}
}

export class Image {
	#base64Data;
	constructor(base64Data) {
		this.#base64Data = String(base64Data);
	}

	render() {
		return ["<image:" + this.#base64Data.slice(0, 12) + ">"];
	}

	invalidate() {}
}
`;

const TYPEBOX_STUB_SOURCE = `export const Type = {
	Optional: (schema) => ({ kind: "optional", schema }),
	Union: (schemas) => ({ kind: "union", schemas }),
	Literal: (value) => ({ kind: "literal", value }),
	Object: (properties) => ({ kind: "object", properties }),
	String: (options) => ({ kind: "string", options }),
	Number: (options) => ({ kind: "number", options }),
	Boolean: (options) => ({ kind: "boolean", options }),
};
`;

const ORIGINAL_MCP_TMPDIR = process.env.MCP_TMPDIR;
const ORIGINAL_HOST_SERVICE_SOCKET_PATH = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
const ORIGINAL_SESSION_HEARTBEAT_INTERVAL_MS = process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR];
const MCP_TMPDIR = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-service-"));
process.env.MCP_TMPDIR = MCP_TMPDIR;

let runtimeModulesInstalled = false;
let runtimeModulesRoot: string | undefined;
let compiledIndexModule: Promise<LoadedExtensionModule> | undefined;

type CompiledShowLatexApi = {
	registerTool: (tool: { name: string; [key: string]: unknown }) => void;
	registerCommand: () => void;
	on: (..._args: unknown[]) => void;
};

type SessionLifecycleHandler = (_event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type CompileTool = {
	execute: (
		_toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

type LoadedExtensionModule = {
	default: (api: CompiledShowLatexApi) => void;
};

interface ExtensionSuite {
	start: SessionLifecycleHandler;
	shutdown: SessionLifecycleHandler;
	compileTool: CompileTool;
}

function ensureRuntimeStubsInstalled(): void {
	if (runtimeModulesInstalled) return;

	runtimeModulesRoot = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-test-"));
	const nodeModulesRoot = resolve(runtimeModulesRoot, "node_modules");
	const piTuiRoot = resolve(nodeModulesRoot, "@mariozechner", "pi-tui");
	const typeboxRoot = resolve(nodeModulesRoot, "typebox");

	mkdirSync(nodeModulesRoot, { recursive: true });
	mkdirSync(piTuiRoot, { recursive: true });
	mkdirSync(typeboxRoot, { recursive: true });

	writeFileSync(resolve(piTuiRoot, "package.json"), JSON.stringify({ name: "@mariozechner/pi-tui", type: "module", main: "./index.js" }));
	writeFileSync(resolve(piTuiRoot, "index.js"), PI_TUI_STUB_SOURCE);
	writeFileSync(resolve(typeboxRoot, "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "./index.js" }));
	writeFileSync(resolve(typeboxRoot, "index.js"), TYPEBOX_STUB_SOURCE);

	runtimeModulesInstalled = true;
}

function cleanupRuntimeStubs(): void {
	if (!runtimeModulesInstalled) return;
	if (runtimeModulesRoot) {
		rmSync(runtimeModulesRoot, { recursive: true, force: true });
	}
	runtimeModulesInstalled = false;
	runtimeModulesRoot = undefined;
	compiledIndexModule = undefined;
}

after(() => {
	if (typeof ORIGINAL_MCP_TMPDIR === "undefined") {
		delete process.env.MCP_TMPDIR;
	} else {
		process.env.MCP_TMPDIR = ORIGINAL_MCP_TMPDIR;
	}
	if (typeof ORIGINAL_HOST_SERVICE_SOCKET_PATH === "undefined") {
		delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	} else {
		process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = ORIGINAL_HOST_SERVICE_SOCKET_PATH;
	}
	if (typeof ORIGINAL_SESSION_HEARTBEAT_INTERVAL_MS === "undefined") {
		delete process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR];
	} else {
		process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR] = ORIGINAL_SESSION_HEARTBEAT_INTERVAL_MS;
	}
	rmSync(MCP_TMPDIR, { recursive: true, force: true });
	cleanupRuntimeStubs();
});

function compiledIndexModulePath(): string {
	if (!runtimeModulesRoot) {
		throw new Error("runtime stubs must be installed before compiling index.ts");
	}
	return resolve(runtimeModulesRoot, "index.mjs");
}

function rewriteProjectRelativeImportsForTempModule(outputText: string): string {
	return outputText.replace(/(from\s+["'])(\.[^"']+\.ts)(["'])/g, (_match, prefix: string, specifier: string, suffix: string) => {
		return `${prefix}${pathToFileURL(resolve(process.cwd(), specifier)).href}${suffix}`;
	});
}

async function loadCompiledExtensionModule(): Promise<LoadedExtensionModule> {
	ensureRuntimeStubsInstalled();
	if (!compiledIndexModule) {
		const source = readFileSync(resolve(process.cwd(), "index.ts"), "utf8");
		const transpiled = ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2024,
				jsx: ts.JsxEmit.Preserve,
			},
			fileName: "index.ts",
		});

		const compiledPath = compiledIndexModulePath();
		writeFileSync(compiledPath, rewriteProjectRelativeImportsForTempModule(transpiled.outputText));
		compiledIndexModule = import(pathToFileURL(compiledPath).href);
	}

	return compiledIndexModule;
}

async function captureExtensionHandlersAndTools(): Promise<ExtensionSuite> {
	const extensionModule = await loadCompiledExtensionModule();
	let capturedStart: SessionLifecycleHandler | undefined;
	let capturedShutdown: SessionLifecycleHandler | undefined;
	let capturedCompileTool: CompileTool | undefined;

	extensionModule.default({
		registerTool(tool) {
			if (tool.name === "compile_latex_file") {
				capturedCompileTool = tool as unknown as CompileTool;
			}
		},
		registerCommand() {},
		on(event, handler) {
			if (event === "session_start") {
				capturedStart = handler as SessionLifecycleHandler;
			}
			if (event === "session_shutdown") {
				capturedShutdown = handler as SessionLifecycleHandler;
			}
		},
	});

	if (!capturedStart || !capturedShutdown) {
		throw new Error("Extension lifecycle handlers were not both registered");
	}
	if (!capturedCompileTool) {
		throw new Error("compile_latex_file tool was not registered by index module");
	}

	return { start: capturedStart, shutdown: capturedShutdown, compileTool: capturedCompileTool };
}

function writeFakeCompiler(binDir: string, exitCode = 0): string {
	const scriptPath = resolve(binDir, "lualatex");
	const scriptSource = [
		"#!/usr/bin/env node",
		"const fs = require('node:fs');",
		"const path = require('node:path');",
		"const source = process.argv[process.argv.length - 1];",
		"if (!source) process.exit(1);",
		`const pdf = path.resolve(process.cwd(), source.replace(/\\.tex$/, '.pdf'));`,
		`if (${exitCode} === 0) fs.writeFileSync(pdf, '%PDF-1.7\\n');`,
		`process.exit(${exitCode});`,
	];
	writeFileSync(scriptPath, scriptSource.join("\n") + "\n", { mode: 0o700 });
	chmodSync(scriptPath, 0o700);
	return scriptPath;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSessionContext(cwd: string, notifications: string[]) {
	return {
		hasUI: true,
		cwd,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			onTerminalInput: () => () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
		},
	};
}

async function runSessionStart(handler: SessionLifecycleHandler, ctx: unknown): Promise<void> {
	await handler("session_start", ctx);
}

async function runSessionShutdown(handler: SessionLifecycleHandler, ctx: unknown): Promise<void> {
	await handler("session_shutdown", ctx);
}

function nextHostServiceSocketPath(): string {
	const baseDir = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-service-"));
	const socketDir = resolve(baseDir, "tex-actions");
	mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	return resolve(socketDir, "host-service.sock");
}

async function withHostServiceClient<T>(socketPath: string, fn: (client: HostServiceClient) => Promise<T>): Promise<T> {
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	try {
		return await fn(client);
	} finally {
		// Host service client is stateless.
		void client;
	}
}

async function withHostService<T>(
	socketPath: string,
	fn: (server: HostServiceServer) => Promise<T>,
	options: { sessionLeases?: HostServiceSessionLeaseService } = {},
): Promise<T> {
	const server = new HostServiceServer({ socketPath, serviceName: "tex-actions-issue-51", sessionLeases: options.sessionLeases });
	await server.start();
	try {
		return await fn(server);
	} finally {
		await server.stop();
	}
}

async function withUnsupportedHeartbeatHostService<T>(socketPath: string, fn: () => Promise<T>): Promise<T> {
	const server = createServer((socket) => {
		let raw = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			raw += chunk;
			const lineBreak = raw.indexOf("\n");
			if (lineBreak < 0) return;
			const request = JSON.parse(raw.slice(0, lineBreak)) as Record<string, unknown>;
			const requestId = String(request.request_id ?? "");
			const operation = String(request.operation ?? "status");
			const nowNs = Date.now() * 1_000_000;
			const workspaceContext = request.workspace_context ?? { cwd: "/" };
			const common = {
				protocol_version: 1,
				supported: true,
				service_available: true,
				service_name: "old-host-service-test",
				socket_path: socketPath,
				service_instance_started_ns: nowNs,
				service_instance_id: "old-host-service-test",
				workspace_context: workspaceContext,
				request_id: requestId,
				uptime_ns: 0,
				total_requests: 1,
			};
			if (operation === "session_heartbeat") {
				socket.end(`${JSON.stringify({
					protocol_version: 1,
					request_id: requestId,
					operation: "status",
					status: "error",
					generated_at_ns: nowNs,
					error: "unsupported operation: session_heartbeat",
					status_details: { ...common, operation: "status", supported: false, service_available: false, error_code: "invalid_request" },
				})}\n`);
				return;
			}
			if (operation === "status") {
				socket.end(`${JSON.stringify({
					protocol_version: 1,
					request_id: requestId,
					operation,
					status: "ok",
					generated_at_ns: nowNs,
					status_details: { ...common, operation, viewer_backend_name: "fake", viewer_backend_available: true },
				})}\n`);
				return;
			}
			if (operation === "register_callback_target") {
				socket.end(`${JSON.stringify({
					protocol_version: 1,
					request_id: requestId,
					operation,
					status: "ok",
					generated_at_ns: nowNs,
					status_details: {
						...common,
						operation,
						target_id: request.target_id,
						callback_registered: true,
						callback_replaced: false,
						target: request.target,
					},
				})}\n`);
				return;
			}
			if (operation === "unregister_callback_target") {
				socket.end(`${JSON.stringify({
					protocol_version: 1,
					request_id: requestId,
					operation,
					status: "ok",
					generated_at_ns: nowNs,
					status_details: { ...common, operation, target_id: request.target_id, removed: true },
				})}\n`);
				return;
			}
			socket.end(`${JSON.stringify({
				protocol_version: 1,
				request_id: requestId,
				operation,
				status: "error",
				generated_at_ns: nowNs,
				error: `unsupported operation: ${operation}`,
				status_details: { ...common, operation, supported: false, service_available: false, error_code: "invalid_request" },
			})}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	try {
		return await fn();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}


test("session startup notifies clearly when host service is unavailable", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const hostServiceSocketPath = nextHostServiceSocketPath();
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = hostServiceSocketPath;

	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-no-service-"));
	const contextNotifications: string[] = [];
	const context = createSessionContext(root, contextNotifications);

	await runSessionStart(suite.start, context);
	assert.equal(contextNotifications.length > 0, true);
	assert.match(contextNotifications[0] as string, /Host Service startup failed:/);
	assert.match(contextNotifications[0] as string, /socket_unavailable|socket unavailable|socket/);
	await runSessionShutdown(suite.shutdown, context);
	rmSync(root, { recursive: true, force: true });
});

test("session startup continues clearly when host service is too old for heartbeat", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const socketPath = nextHostServiceSocketPath();
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-old-heartbeat-"));
	const notifications: string[] = [];
	const context = createSessionContext(root, notifications);

	try {
		await withUnsupportedHeartbeatHostService(socketPath, async () => {
			await runSessionStart(suite.start, context);
			assert.equal(notifications.some((message) => /too old for session heartbeats/.test(message)), true);
			assert.equal(notifications.some((message) => /startup failed/.test(message)), false);
			await runSessionShutdown(suite.shutdown, context);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session startup registers host service callback target and shutdown unregisters it", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const socketPath = nextHostServiceSocketPath();
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;

	await withHostService(socketPath, async () => {
		const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-register-"));
		const context = createSessionContext(root, []);
		await runSessionStart(suite.start, context);

		const expectedTargetId = `pi:${contextSessionKey(context as never)}`;
		const workspaceContext = resolveAgentWorkspaceContext(context as never);
		await withHostServiceClient(socketPath, async (client) => {
			const status = await client.requestStatus(workspaceContext);
			assert.equal(status.live_session_count, 1);
			const resolve = await client.requestResolveCallbackTarget(workspaceContext, expectedTargetId);
			assert.equal(resolve.callback_available, true);
			assert.equal(resolve.target?.kind, "pi-synctex-callback-v1");
		});

		await runSessionShutdown(suite.shutdown, context);
		await withHostServiceClient(socketPath, async (client) => {
			const resolveAfterShutdown = await client.requestResolveCallbackTarget(workspaceContext, expectedTargetId);
			assert.equal(resolveAfterShutdown.callback_available, false);
		});

		rmSync(root, { recursive: true, force: true });
	});
});

test("session shutdown stops Pi heartbeat refresh", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const socketPath = nextHostServiceSocketPath();
	const previousInterval = process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR];
	process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR] = "20";
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;

	try {
		await withHostService(
			socketPath,
			async () => {
				const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-heartbeat-stop-"));
				try {
					const context = createSessionContext(root, []);
					const workspaceContext = resolveAgentWorkspaceContext(context as never);
					await runSessionStart(suite.start, context);
					await sleep(120);
					await withHostServiceClient(socketPath, async (client) => {
						const liveStatus = await client.requestStatus(workspaceContext);
						assert.equal(liveStatus.live_session_count, 1);
					});
					await runSessionShutdown(suite.shutdown, context);
					await sleep(120);
					await withHostServiceClient(socketPath, async (client) => {
						const expiredStatus = await client.requestStatus(workspaceContext);
						assert.equal(expiredStatus.live_session_count, 0);
					});
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			},
			{ sessionLeases: new HostServiceSessionLeaseService({ leaseTtlMs: 80 }) },
		);
	} finally {
		if (previousInterval === undefined) {
			delete process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR];
		} else {
			process.env[SESSION_HEARTBEAT_INTERVAL_MS_ENV_VAR] = previousInterval;
		}
	}
});

test("session startup callback target becomes unavailable when callback socket is removed", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const socketPath = nextHostServiceSocketPath();
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;

	await withHostService(socketPath, async () => {
		const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-stale-"));
		const context = createSessionContext(root, []);
		await runSessionStart(suite.start, context);

		const targetId = `pi:${contextSessionKey(context as never)}`;
		const workspaceContext = resolveAgentWorkspaceContext(context as never);
		await withHostServiceClient(socketPath, async (client) => {
			const resolveBefore = await client.requestResolveCallbackTarget(workspaceContext, targetId);
			assert.equal(resolveBefore.callback_available, true);
			if (!resolveBefore.target?.socket_path) {
				throw new Error("expected host service to return callback target socket");
			}
			rmSync(resolveBefore.target.socket_path);
			const resolveAfter = await client.requestResolveCallbackTarget(workspaceContext, targetId);
			assert.equal(resolveAfter.callback_available, false);
		});

		await runSessionShutdown(suite.shutdown, context);
		rmSync(root, { recursive: true, force: true });
	});
});

test("missing host service during shutdown is handled without throwing", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const socketPath = nextHostServiceSocketPath();
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-missing-on-shutdown-"));
	const contextNotifications: string[] = [];
	const context = createSessionContext(root, contextNotifications);
	const server = new HostServiceServer({ socketPath, serviceName: "tex-actions-issue-51" });
	await server.start();
	await runSessionStart(suite.start, context);
	await server.stop();
	await runSessionShutdown(suite.shutdown, context);
	assert.equal(contextNotifications.some((message) => message.includes("cleanup failed")), true);
	rmSync(root, { recursive: true, force: true });
});

test("compile_latex_file fails when host service is unavailable", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-migration-"));
	const sourcePath = resolve(root, "paper.tex");
	writeFileSync(sourcePath, "\\begin{document}ok\\end{document}");
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	const originalPath = process.env.PATH ?? "";
	process.env.PATH = `${binDir}:${originalPath}`;
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = resolve(root, "missing-host-service.sock");
	const notifications: string[] = [];
	const context = createSessionContext(root, notifications);
	let threw = false;

	await runSessionStart(suite.start, context);

	try {
		await suite.compileTool.execute(
			"compile-latex-uses-viewer",
			{ latex_file_path: sourcePath, open_pdf: true },
			undefined,
			undefined,
			context,
		);
	} catch (error) {
		threw = true;
		assert.equal(/host service socket unavailable/.test(error instanceof Error ? error.message : String(error)), true);
	}
	assert.equal(threw, true);
	assert.equal(notifications.length > 0, true);
	await runSessionShutdown(suite.shutdown, context);
	process.env.PATH = originalPath;
	rmSync(root, { recursive: true, force: true });
});

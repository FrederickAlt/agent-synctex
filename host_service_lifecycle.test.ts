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
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import * as ts from "typescript";
import { contextSessionKey } from "./src/modules/pdf_session/pdf_session.ts";
import { HOST_SERVICE_SOCKET_PATH_ENV_VAR, HostServiceClient, HostServiceServer } from "./src/modules/host_service.ts";

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

const FAKE_VIEWER_SERVICE_SCRIPT = String.raw`const fs = require("node:fs");
const path = require("node:path");

const baseDir = process.env.MCP_TMPDIR || resolve(process.env.XDG_RUNTIME_DIR || process.env.HOME || process.cwd(), "tex-actions");
const failOpen = process.env.FAKE_VIEWER_OPEN_FAIL === "1";
const protocolDirectories = {
	base: baseDir,
	requests: path.join(baseDir, "viewer-requests"),
	results: path.join(baseDir, "viewer-results"),
	state: path.join(baseDir, "viewer-state.json"),
};
const capabilities = {
	open: true,
	close: true,
	forward_search: true,
	inverse_search: true,
	reuse: true,
};
const serviceStartedNs = Number(process.hrtime.bigint());
const openRequestSummaryPath = path.join(baseDir, "open-request-summary.json");
const openCountPath = path.join(baseDir, "open-count.json");
const deprecatedDetailKeys = ["synctex_callback_command", "synctex_editor_command", "zathura_args"];
let openCount = 0;

function writeOpenCount() {
	fs.writeFileSync(openCountPath, JSON.stringify({ open_count: openCount }), { mode: 0o600 });
}

function writeResult(filePath, response) {
	const tempPath = filePath + ".tmp";
	fs.writeFileSync(tempPath, JSON.stringify(response), { mode: 0o600 });
	fs.renameSync(tempPath, filePath);
}

function writeOpenSummary(requestId, details, callback, validationError) {
	const detailKeys = details && typeof details === "object" ? Object.keys(details) : [];
	const detailsCallback = callback && typeof callback === "object" ? {
		kind: callback.kind,
		transport: callback.transport,
		socket_path: callback.socket_path,
		token: callback.token,
	} : null;
	fs.writeFileSync(openRequestSummaryPath, JSON.stringify({
		request_id: requestId,
		detail_keys: detailKeys,
		callback: detailsCallback,
		validation_error: validationError || null,
	}), { mode: 0o600 });
}

function validateOpenRequest(request) {
	const details = request?.details;
	if (!details || typeof details !== "object") {
		return "open request details must be an object";
	}
	const forbiddenFields = deprecatedDetailKeys.filter((field) => Object.prototype.hasOwnProperty.call(details, field));
	if (forbiddenFields.length > 0) {
		return "open request details contain deprecated fields: " + forbiddenFields.join(",");
	}
	const callback = details.callback;
	if (!callback || typeof callback !== "object") {
		return "open request callback must be a structured object";
	}
	if (callback.kind !== "pi-synctex-callback-v1") {
		return "callback.kind must be pi-synctex-callback-v1";
	}
	if (callback.transport !== "unix") {
		return "callback.transport must be unix";
	}
	if (typeof callback.socket_path !== "string" || callback.socket_path.length === 0) {
		return "callback.socket_path must be a non-empty string";
	}
	if (typeof callback.token !== "string" || callback.token.length === 0) {
		return "callback.token must be a non-empty string";
	}
	return null;
}

function responseBase(requestId) {
	return {
		protocol_version: 1,
		supported: true,
		service_available: true,
		backend: "fake-viewer",
		backend_identity_ok: true,
		protocol_directories: protocolDirectories,
		service_instance_started_ns: serviceStartedNs,
		request_id: requestId,
		operation: "open",
	};
}

function handleOpenRequest(request) {
	const requestId = request.request_id;
	if (typeof requestId !== "string" || requestId.length === 0) return;
	const responsePath = path.join(protocolDirectories.results, requestId + ".json");
	const details = request.details;
	const callback = details && typeof details === "object" ? details.callback : undefined;
	const validationError = validateOpenRequest(request);
	writeOpenSummary(requestId, details, callback, validationError);

	if (validationError) {
		writeResult(responsePath, {
			protocol_version: 1,
			request_id: requestId,
			operation: "open",
			status: "error",
			generated_at_ns: Number(process.hrtime.bigint()),
			status_details: {
				...responseBase(requestId),
				owned: false,
				reused: false,
				capabilities,
				error_code: "invalid_open_request",
			},
			error: validationError,
		});
		return;
	}

	if (failOpen) {
		writeResult(responsePath, {
			protocol_version: 1,
			request_id: requestId,
			operation: "open",
			status: "error",
			generated_at_ns: Number(process.hrtime.bigint()),
			status_details: {
				...responseBase(requestId),
				owned: false,
				reused: false,
				capabilities,
				error_code: "backend_unavailable",
			},
			error: "fake viewer backend unavailable",
		});
		return;
	}

	openCount += 1;
	writeOpenCount();
	writeResult(responsePath, {
		protocol_version: 1,
		request_id: requestId,
		operation: "open",
		status: "ok",
		generated_at_ns: Number(process.hrtime.bigint()),
		status_details: {
			...responseBase(requestId),
			owned: true,
			reused: false,
			capabilities,
			handle: "fake-viewer-open-" + String(openCount),
			pid: 222222,
		},
	});
}

function handleRequest(fileName) {
	if (!fileName.endsWith(".json")) return;
	const requestPath = path.join(protocolDirectories.requests, fileName);
	const payload = JSON.parse(fs.readFileSync(requestPath, "utf8"));
	if (payload.operation === "status") return;
	if (payload.operation === "open") handleOpenRequest(payload);
}

function scanRequests() {
	let entries;
	try {
		entries = fs.readdirSync(protocolDirectories.requests);
	} catch {
		entries = [];
	}
	for (const entry of entries) {
		try {
			handleRequest(entry);
			fs.rmSync(path.join(protocolDirectories.requests, entry), { force: true });
		} catch {
			/* ignore */
		}
	}
}

for (const directory of [protocolDirectories.requests, protocolDirectories.results]) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
setInterval(scanRequests, 20);
`;

const ORIGINAL_MCP_TMPDIR = process.env.MCP_TMPDIR;
const ORIGINAL_HOST_SERVICE_SOCKET_PATH = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
const MCP_TMPDIR = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-service-"));
process.env.MCP_TMPDIR = MCP_TMPDIR;

let runtimeModulesInstalled = false;
let runtimeModulesRoot: string | undefined;
let compiledIndexModule: Promise<LoadedExtensionModule> | undefined;
let fakeViewerServiceProcess: ChildProcess | undefined;

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

async function withFakeViewerService(mode: "ok" | "backend_unavailable", fn: () => Promise<void>): Promise<void> {
	const serviceDir = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-viewer-service-"));
	const scriptPath = resolve(serviceDir, "service.js");
	writeFileSync(scriptPath, FAKE_VIEWER_SERVICE_SCRIPT, { mode: 0o700 });
	fakeViewerServiceProcess = spawn(process.execPath, [scriptPath], {
		env: { ...process.env, MCP_TMPDIR, FAKE_VIEWER_OPEN_FAIL: mode === "backend_unavailable" ? "1" : "0" },
		stdio: ["ignore", "ignore", "ignore"],
	});
	await new Promise<void>((resolveStart) => setTimeout(resolveStart, 25));
	try {
		await fn();
	} finally {
		await new Promise<void>((resolveStop) => {
			const proc = fakeViewerServiceProcess;
			if (!proc || proc.exitCode !== null) {
				resolveStop();
				return;
			}
			let stopped = false;
			const finish = () => {
				if (stopped) return;
				stopped = true;
				resolveStop();
			};
			proc.once("exit", finish);
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!stopped) proc.kill("SIGINT");
				setTimeout(finish, 25);
			}, 50);
		});
		fakeViewerServiceProcess = undefined;
		rmSync(serviceDir, { recursive: true, force: true });
	}
}

function readOpenSummary(): { detail_keys: string[]; callback?: { kind: string; transport: string; socket_path: string; token: string }; validation_error: string | null } {
	const payload = readFileSync(join(MCP_TMPDIR, "open-request-summary.json"), "utf8").trim();
	if (!payload.length) throw new Error("expected open request summary");
	return JSON.parse(payload) as {
		detail_keys: string[];
		callback?: { kind: string; transport: string; socket_path: string; token: string };
		validation_error: string | null;
	};
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

async function withHostService<T>(socketPath: string, fn: (server: HostServiceServer) => Promise<T>): Promise<T> {
	const server = new HostServiceServer({ socketPath, serviceName: "tex-actions-issue-51" });
	await server.start();
	try {
		return await fn(server);
	} finally {
		await server.stop();
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

test("session startup registers host service callback target and shutdown unregisters it", async () => {
	const suite = await captureExtensionHandlersAndTools();
	const socketPath = nextHostServiceSocketPath();
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;

	await withHostService(socketPath, async () => {
			const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-lifecycle-register-"));
		const context = createSessionContext(root, []);
		await runSessionStart(suite.start, context);

		const expectedTargetId = `pi:${contextSessionKey(context as never)}`;
		await withHostServiceClient(socketPath, async (client) => {
			const resolve = await client.requestResolveCallbackTarget({ cwd: context.cwd }, expectedTargetId);
			assert.equal(resolve.callback_available, true);
			assert.equal(resolve.target?.kind, "pi-synctex-callback-v1");
		});

		await runSessionShutdown(suite.shutdown, context);
		await withHostServiceClient(socketPath, async (client) => {
			const resolveAfterShutdown = await client.requestResolveCallbackTarget({ cwd: context.cwd }, expectedTargetId);
			assert.equal(resolveAfterShutdown.callback_available, false);
		});

		rmSync(root, { recursive: true, force: true });
	});
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
		await withHostServiceClient(socketPath, async (client) => {
			const resolveBefore = await client.requestResolveCallbackTarget({ cwd: root }, targetId);
			assert.equal(resolveBefore.callback_available, true);
			if (!resolveBefore.target?.socket_path) {
				throw new Error("expected host service to return callback target socket");
			}
			rmSync(resolveBefore.target.socket_path);
			const resolveAfter = await client.requestResolveCallbackTarget({ cwd: root }, targetId);
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

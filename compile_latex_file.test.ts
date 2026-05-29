import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import * as ts from "typescript";

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

const baseDir = "/tmp/codex-show-latex";
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
const deprecatedDetailKeys = ["synctex_callback_command", "synctex_editor_command", "zathura_args"];
let openCount = 0;

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
			pid: 111111,
		},
	});
}

function handleRequest(fileName) {
	if (!fileName.endsWith(".json")) return;
	const requestPath = path.join(protocolDirectories.requests, fileName);
	let payload;
	try {
		payload = JSON.parse(fs.readFileSync(requestPath, "utf8"));
	} catch {
		fs.rmSync(requestPath, { force: true });
		return;
	}
	if (payload.operation === "open") {
		handleOpenRequest(payload);
	}
	fs.rmSync(requestPath, { force: true });
}

function tick() {
	let requestFiles;
	try {
		requestFiles = fs.readdirSync(protocolDirectories.requests);
	} catch {
		return;
	}
	for (const entry of requestFiles) {
		handleRequest(entry);
	}
}

const timer = setInterval(tick, 15);
process.on("SIGTERM", () => {
	clearInterval(timer);
	process.exit(0);
});
`;

const MCP_TMPDIR = "/tmp/codex-show-latex";
const MCP_REQUESTS_DIR = join(MCP_TMPDIR, "viewer-requests");
const MCP_RESULTS_DIR = join(MCP_TMPDIR, "viewer-results");
const MCP_OPEN_REQUEST_LOG = join(MCP_TMPDIR, "open-request-summary.json");

type FakeViewerOpenRequestRecord = {
	request_id: string;
	validation_error: string | null;
	callback: {
		kind: string;
		transport: string;
		socket_path: string;
		token: string;
	} | null;
	detail_keys: string[];
};

type CompiledShowLatexApi = {
	registerTool: (tool: { name: string; [key: string]: unknown }) => void;
	registerCommand: () => void;
	on: (..._args: unknown[]) => void;
};

type CompiledShowLatexModule = {
	default: (api: CompiledShowLatexApi) => void;
};

type SessionLifecycleHandler = (_event: unknown, ctx: unknown) => Promise<unknown> | unknown;

let sessionShutdownHandler: SessionLifecycleHandler | undefined;

let compiledIndexModule: Promise<CompiledShowLatexModule> | undefined;
let runtimeModulesInstalled = false;
let runtimeModulesRoot: string | undefined;
let fakeViewerServiceProcess: ReturnType<typeof spawn> | undefined;

function ensureRuntimeStubsInstalled(): void {
	if (runtimeModulesInstalled) return;

	runtimeModulesRoot = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-test-"));
	const nodeModulesRoot = resolve(runtimeModulesRoot, "node_modules");
	const piTuiRoot = resolve(nodeModulesRoot, "@mariozechner", "pi-tui");
	const typeboxRoot = resolve(nodeModulesRoot, "typebox");

	mkdirSync(nodeModulesRoot, { recursive: true });
	mkdirSync(piTuiRoot, { recursive: true });
	mkdirSync(typeboxRoot, { recursive: true });

	writeFileSync(
		resolve(piTuiRoot, "package.json"),
		JSON.stringify({ name: "@mariozechner/pi-tui", type: "module", main: "./index.js" }),
	);
	writeFileSync(resolve(piTuiRoot, "index.js"), PI_TUI_STUB_SOURCE);
	writeFileSync(
		resolve(typeboxRoot, "package.json"),
		JSON.stringify({ name: "typebox", type: "module", main: "./index.js" }),
	);
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
	cleanupRuntimeStubs();
});

function compiledIndexModulePath(): string {
	if (!runtimeModulesRoot) {
		throw new Error("runtime stubs must be installed before compiling index.ts");
	}
	return resolve(runtimeModulesRoot, "index.mjs");
}

function readFakeViewerOpenRequest(): FakeViewerOpenRequestRecord {
	return JSON.parse(readFileSync(MCP_OPEN_REQUEST_LOG, "utf8")) as FakeViewerOpenRequestRecord;
}

function rewriteProjectRelativeImportsForTempModule(outputText: string): string {
	return outputText.replace(/(from\s+["'])(\.[^"']+\.ts)(["'])/g, (_match, prefix: string, specifier: string, suffix: string) => {
		return `${prefix}${pathToFileURL(resolve(process.cwd(), specifier)).href}${suffix}`;
	});
}

async function loadCompiledShowLatexModule(): Promise<CompiledShowLatexModule> {
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

type CompileTool = {
	execute: (
		_toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

async function captureCompileTool(): Promise<CompileTool> {
	const extensionModule = await loadCompiledShowLatexModule();
	let capturedTool: CompileTool | undefined;

	extensionModule.default({
		registerTool(tool) {
			if (tool.name === "compile_latex_file") {
				capturedTool = tool as unknown as CompileTool;
			}
		},
		registerCommand() {},
		on(event, handler) {
			if (event === "session_shutdown") {
				sessionShutdownHandler = handler as SessionLifecycleHandler;
			}
		},
	});

	if (!capturedTool) {
		throw new Error("compile_latex_file tool was not registered by index module");
	}

	return capturedTool;
}

function writeFakeCompiler(binDir: string): string {
	const compilerPath = resolve(binDir, "lualatex");
	writeFileSync(
		compilerPath,
		`#!/usr/bin/env node
	const fs = require("node:fs");
	const path = require("node:path");
	const source = process.argv[process.argv.length - 1];
	if (!source) process.exit(1);
	const pdf = path.resolve(process.cwd(), source.replace(/\\.tex$/, ".pdf"));
	fs.writeFileSync(pdf, "%PDF-1.7\\n");
`,
		{ mode: 0o700 },
	);
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

async function runSessionShutdown(ctx: unknown): Promise<void> {
	if (!sessionShutdownHandler) return;
	await sessionShutdownHandler("session_shutdown", ctx);
}

function withTemporaryProject(): { root: string; sourcePath: string; sourceContent: string } {
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-compile-test-"));
	const sourcePath = resolve(root, "paper.tex");
	writeFileSync(sourcePath, "\\begin{document}ok\\end{document}");
	return { root, sourcePath, sourceContent: "\\begin{document}ok\\end{document}" };
}

function createSessionContext(cwd: string) {
	return {
		hasUI: false,
		cwd,
		ui: {
			notify: () => undefined,
			onTerminalInput: () => () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
		},
	};
}

async function withFakeViewerService(failOpen: boolean, fn: () => Promise<void>): Promise<void> {
	const serviceDir = mkdtempSync(resolve(tmpdir(), "pdf-preview-viewer-service-"));
	const scriptPath = resolve(serviceDir, "service.js");
	mkdirSync(MCP_TMPDIR, { recursive: true, mode: 0o700 });
	mkdirSync(MCP_REQUESTS_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(MCP_RESULTS_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(scriptPath, FAKE_VIEWER_SERVICE_SCRIPT, { mode: 0o700 });
	fakeViewerServiceProcess = spawn(process.execPath, [scriptPath], {
		env: { ...process.env, FAKE_VIEWER_OPEN_FAIL: failOpen ? "1" : "0" },
		stdio: ["ignore", "ignore", "ignore"],
	});

	await new Promise<void>((resolveProcessStart) => setTimeout(resolveProcessStart, 25));

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
				if (!stopped) {
					proc.kill("SIGKILL");
				}
				setTimeout(finish, 25);
			}, 50);
		});
		fakeViewerServiceProcess = undefined;
		rmSync(serviceDir, { recursive: true, force: true });
	}
}

test("compile_latex_file compiles without opening by default", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		const result = await tool.execute("compile-latex-file-only", { latex_file_path: sourcePath }, undefined, undefined, undefined);
		const expectedPdf = resolve(root, "paper.pdf");

		const details = result.details as {
			source: string;
			pdf: string;
			clean: boolean;
			cleaned_artifacts: unknown[];
			viewer_handle?: unknown;
		};
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0].text, `ok: ${expectedPdf}`);
		assert.equal(details.source, sourcePath);
		assert.equal(details.pdf, expectedPdf);
		assert.equal(details.clean, false);
		assert.deepEqual(details.cleaned_artifacts, []);
		assert.equal(details.viewer_handle, undefined);
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file resolves source path with a relative path", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-compile-test-"));
	const src = resolve(root, "nested");
	mkdirSync(src, { recursive: true });
	const sourcePath = resolve(src, "paper.tex");
	writeFileSync(sourcePath, "\\begin{document}ok\\end{document}");
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		const result = await tool.execute(
			"compile-latex-file-relative",
			{ latex_file_path: "nested/paper.tex" },
			undefined,
			undefined,
			createSessionContext(root),
		);
		const details = result.details as { source: string };
		assert.equal(details.source, sourcePath);
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file opens through viewer service when open_pdf=true", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	const context = createSessionContext(root);
	try {
		await withFakeViewerService(false, async () => {
			const result = await tool.execute(
				"compile-latex-file-open",
				{ latex_file_path: sourcePath, open_pdf: true },
				undefined,
				undefined,
				context,
			);

			const details = result.details as {
				source: string;
				pdf: string;
				pdf_id: number;
				pid: number;
				viewer_handle: string;
				viewer_backend: string;
				viewer_owned: boolean;
				viewer_capabilities: { open: boolean; close: boolean; forward_search: boolean; inverse_search: boolean; reuse: boolean };
			};
			assert.equal(details.source, sourcePath);
			assert.equal(details.pdf, resolve(root, "paper.pdf"));
			assert.equal(Number.isInteger(details.pdf_id) && details.pdf_id > 0, true);
			assert.equal(details.pid, 111111);
			assert.equal(result.content[0].text.startsWith(`ok: pdf_id=${details.pdf_id} pid=111111 pdf=${details.pdf}`), true);
			assert.equal(typeof details.viewer_handle, "string");
			assert.equal(details.viewer_handle.startsWith("fake-viewer-open-"), true);
			assert.equal(details.viewer_backend, "fake-viewer");
			assert.equal(details.viewer_owned, true);
			assert.deepEqual(details.viewer_capabilities, {
				open: true,
				close: true,
				forward_search: true,
				inverse_search: true,
				reuse: true,
			});
			const openRequest = readFakeViewerOpenRequest();
			assert.equal(openRequest.validation_error, null);
			assert.equal(openRequest.callback?.kind, "pi-synctex-callback-v1");
			assert.equal(openRequest.callback?.transport, "unix");
			assert.equal(typeof openRequest.callback?.socket_path, "string");
			assert.equal((openRequest.callback?.socket_path?.length ?? 0) > 0, true);
			assert.equal(typeof openRequest.callback?.token, "string");
			assert.equal((openRequest.callback?.token?.length ?? 0) > 0, true);
			assert.equal(openRequest.detail_keys.includes("synctex_callback_command"), false);
			assert.equal(openRequest.detail_keys.includes("synctex_editor_command"), false);
			assert.equal(openRequest.detail_keys.includes("zathura_args"), false);
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file distinguishes open failures from compile failures", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const expectedPdf = resolve(root, "paper.pdf");
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	const context = createSessionContext(root);
	try {
		await withFakeViewerService(true, async () => {
			try {
				await tool.execute(
					"compile-latex-file-open-failure",
					{ latex_file_path: sourcePath, open_pdf: true },
					undefined,
					undefined,
					context,
				);
				assert.fail("expected compile_latex_file with open failure to throw");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/LaTeX compile succeeded but opening failed/.test(message), true);
				assert.equal(/code=backend_unavailable/.test(message), true);
				assert.equal(existsSync(expectedPdf), true, "compiled PDF should exist after open failure");
				const openRequest = readFakeViewerOpenRequest();
				assert.equal(openRequest.validation_error, null);
				assert.equal(openRequest.callback?.kind, "pi-synctex-callback-v1");
				assert.equal(openRequest.callback?.transport, "unix");
				assert.equal((openRequest.callback?.socket_path?.length ?? 0) > 0, true);
				assert.equal((openRequest.callback?.token?.length ?? 0) > 0, true);
				assert.equal(openRequest.detail_keys.includes("synctex_callback_command"), false);
				assert.equal(openRequest.detail_keys.includes("synctex_editor_command"), false);
				assert.equal(openRequest.detail_keys.includes("zathura_args"), false);
			}
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

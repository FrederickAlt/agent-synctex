import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const baseDir = process.env.MCP_TMPDIR || "/tmp/codex-show-latex";
const mode = process.env.FAKE_VIEWER_MODE || "ok";
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
const openRequestLogPath = path.join(baseDir, "open-request-log.jsonl");
const deprecatedDetailKeys = ["synctex_callback_command", "synctex_editor_command", "zathura_args"];
const openSessions = {};
let openCount = 0;

function writeResult(filePath, response) {
	const tempPath = filePath + ".tmp";
	fs.writeFileSync(tempPath, JSON.stringify(response), { mode: 0o600 });
	fs.renameSync(tempPath, filePath);
}

function appendRequestLog(entry) {
	const serialized = JSON.stringify(entry) + "\n";
	fs.appendFileSync(openRequestLogPath, serialized);
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
		return "callback must be an object";
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
	if (typeof details.pdf_path !== "string" || details.pdf_path.length === 0) {
		return "pdf_path must be a non-empty string";
	}
	return null;
}

function responseBase(requestId) {
	return {
		protocol_version: 1,
		supported: true,
		service_available: true,
		backend: "fake-viewer",
		protocol_directories: protocolDirectories,
		service_instance_started_ns: serviceStartedNs,
		request_id: requestId,
		operation: "open",
	};
}

function writeOpenRequestSummary(requestId, details, callback, validationError, reused) {
	appendRequestLog({
		request_id: requestId,
		detail_keys: details && typeof details === "object" ? Object.keys(details) : [],
		pdf_path: details && typeof details === "object" ? details.pdf_path : null,
		callback: callback && typeof callback === "object" ? {
			kind: callback.kind,
			transport: callback.transport,
			socket_path: callback.socket_path,
			token: callback.token,
		} : null,
		validation_error: validationError || null,
		reused,
		mode,
	});
}

function handleOpenRequest(request) {
	const requestId = request.request_id;
	if (typeof requestId !== "string" || requestId.length === 0) return;
	const responsePath = path.join(protocolDirectories.results, requestId + ".json");
	const details = request.details;
	const callback = details && typeof details === "object" ? details.callback : undefined;
	const validationError = validateOpenRequest(request);
	const pdfPath = details && typeof details === "object" ? details.pdf_path : undefined;
	const reused = typeof pdfPath === "string" && Object.prototype.hasOwnProperty.call(openSessions, pdfPath);
	writeOpenRequestSummary(requestId, details, callback, validationError, reused);

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
				backend_identity_ok: true,
				capabilities,
				error_code: "invalid_open_request",
			},
			error: validationError,
		});
		return;
	}

	if (mode === "backend_unavailable") {
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
				backend_identity_ok: false,
				capabilities,
				error_code: "backend_unavailable",
				service_available: false,
			},
			error: "fake viewer backend unavailable",
		});
		return;
	}

	if (mode === "service_unavailable") {
		writeResult(responsePath, {
			protocol_version: 1,
			request_id: requestId,
			operation: "open",
			status: "error",
			generated_at_ns: Number(process.hrtime.bigint()),
			status_details: {
				protocol_version: 1,
				supported: false,
				service_available: false,
				backend: "fake-viewer",
				backend_identity_ok: false,
				protocol_directories: protocolDirectories,
				service_instance_started_ns: serviceStartedNs,
				request_id: requestId,
				operation: "open",
				owned: false,
				reused: false,
				capabilities,
				error_code: "service_unavailable",
			},
			error: "viewer service unavailable",
		});
		return;
	}

	if (mode === "hang") {
		return;
	}

	const handle = (() => {
		if (!reused) {
			openCount += 1;
			openSessions[pdfPath] = "fake-viewer-open-" + String(openCount);
		}
		return openSessions[pdfPath];
	})();

	writeResult(responsePath, {
		protocol_version: 1,
		request_id: requestId,
		operation: "open",
		status: "ok",
		generated_at_ns: Number(process.hrtime.bigint()),
		status_details: {
			...responseBase(requestId),
			owned: true,
			reused,
			capabilities,
			backend_identity_ok: true,
			handle,
			pid: 123456,
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

setInterval(tick, 10);
`;

const ORIGINAL_MCP_TMPDIR = process.env.MCP_TMPDIR;
const MCP_TMPDIR = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-service-"));
process.env.MCP_TMPDIR = MCP_TMPDIR;
const MCP_REQUESTS_DIR = join(MCP_TMPDIR, "viewer-requests");
const MCP_RESULTS_DIR = join(MCP_TMPDIR, "viewer-results");
const MCP_OPEN_REQUEST_LOG = join(MCP_TMPDIR, "open-request-log.jsonl");
const MCP_FIXED_PREVIEW_PDF_PATH = resolve(MCP_TMPDIR, "show-latex.pdf");
const MCP_READY_PATH = resolve(MCP_TMPDIR, "show-latex.ready");

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
	pdf_path: string | null;
	reused: boolean;
	mode: string;
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

type ShowLatexTool = {
	execute: (
		_toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

let sessionShutdownHandler: SessionLifecycleHandler | undefined;
let compiledIndexModule: Promise<CompiledShowLatexModule> | undefined;
let runtimeModulesInstalled = false;
let runtimeModulesRoot: string | undefined;
let fakeViewerServiceProcess: ReturnType<typeof spawn> | undefined;

function ensureRuntimeStubsInstalled(): void {
	if (runtimeModulesInstalled) return;

	runtimeModulesRoot = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-show-"));
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
	if (typeof ORIGINAL_MCP_TMPDIR === "undefined") {
		delete process.env.MCP_TMPDIR;
	} else {
		process.env.MCP_TMPDIR = ORIGINAL_MCP_TMPDIR;
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

async function captureShowLatexTool(): Promise<ShowLatexTool> {
	const extensionModule = await loadCompiledShowLatexModule();
	let capturedTool: ShowLatexTool | undefined;

	extensionModule.default({
		registerTool(tool) {
			if (tool.name === "show_latex") {
				capturedTool = tool as unknown as ShowLatexTool;
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
		throw new Error("show_latex tool was not registered by index module");
	}

	return capturedTool;
}

function writeFakeCompiler(binDir: string, shouldFail = false): string {
	const compilerPath = resolve(binDir, "lualatex");
	const script = shouldFail
		? `#!/usr/bin/env node
const fs = require(\"node:fs\");
const source = process.argv[process.argv.length - 1];
if (!source) process.exit(1);
console.error('compiler failed intentionally');
process.exit(1);
`
		: `#!/usr/bin/env node
const fs = require(\"node:fs\");
const path = require(\"node:path\");
const source = process.argv[process.argv.length - 1];
if (!source) process.exit(1);
const pdf = path.resolve(process.cwd(), source.replace(/\\.tex$/, \".pdf\"));
fs.writeFileSync(pdf, "%PDF-1.7\\n");
`;
	writeFileSync(compilerPath, script, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

async function runSessionShutdown(ctx: unknown): Promise<void> {
	if (!sessionShutdownHandler) return;
	await sessionShutdownHandler("session_shutdown", ctx);
}

function withTemporaryProject(): { root: string; sourceContent: string } {
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-test-"));
	return { root, sourceContent: "\\begin{document}abc\\end{document}" };
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

function readFakeViewerOpenRequests(): FakeViewerOpenRequestRecord[] {
	if (!existsSync(MCP_OPEN_REQUEST_LOG)) return [];
	const raw = readFileSync(MCP_OPEN_REQUEST_LOG, "utf8").trim();
	if (!raw.length) return [];
	return raw
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as FakeViewerOpenRequestRecord);
}

async function withFakeViewerService(mode: "ok" | "backend_unavailable" | "service_unavailable" | "hang", fn: () => Promise<void>): Promise<void> {
	const serviceDir = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-viewer-service-"));
	const scriptPath = resolve(serviceDir, "service.js");
	mkdirSync(MCP_TMPDIR, { recursive: true, mode: 0o700 });
	mkdirSync(MCP_REQUESTS_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(MCP_RESULTS_DIR, { recursive: true, mode: 0o700 });
	rmSync(MCP_OPEN_REQUEST_LOG, { force: true });
	rmSync(MCP_READY_PATH, { force: true });
	writeFileSync(scriptPath, FAKE_VIEWER_SERVICE_SCRIPT, { mode: 0o700 });
	fakeViewerServiceProcess = spawn(process.execPath, [scriptPath], {
		env: { ...process.env, MCP_TMPDIR, FAKE_VIEWER_MODE: mode },
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
				if (!stopped) proc.kill("SIGKILL");
				setTimeout(finish, 25);
			}, 50);
		});
		fakeViewerServiceProcess = undefined;
		rmSync(serviceDir, { recursive: true, force: true });
	}
}

test("show_latex external flow opens through viewer service", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		await withFakeViewerService("ok", async () => {
			const result = await tool.execute(
				"show-latex-external-open",
				{ source: sourceContent, inline: false },
				undefined,
				undefined,
				context,
			);

			const details = result.details as {
				pdf: string;
				operation_pdf: string;
				pdf_id: number;
				inline: boolean;
			};
			assert.equal(result.content.length, 1);
			assert.equal(details.inline, false);
			assert.equal(details.pdf, MCP_FIXED_PREVIEW_PDF_PATH);
			assert.equal(details.operation_pdf === MCP_FIXED_PREVIEW_PDF_PATH, false);
			assert.equal(existsSync(MCP_FIXED_PREVIEW_PDF_PATH), true);
			assert.equal(existsSync(MCP_READY_PATH), false);
			assert.equal(typeof details.pdf_id, "number");
			assert.equal(result.content[0].text, "ok");

			const requests = readFakeViewerOpenRequests();
			assert.equal(requests.length, 1);
			assert.equal(requests[0].validation_error, null);
			assert.equal(requests[0].pdf_path, MCP_FIXED_PREVIEW_PDF_PATH);
			assert.equal(requests[0].detail_keys.includes("callback"), true);
			assert.equal(requests[0].detail_keys.includes("pdf_path"), true);
			assert.equal(requests[0].detail_keys.includes("synctex_callback_command"), false);
			assert.equal(requests[0].detail_keys.includes("synctex_editor_command"), false);
			assert.equal(requests[0].detail_keys.includes("zathura_args"), false);
			assert.equal(requests[0].callback?.kind, "pi-synctex-callback-v1");
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external flow always sends an explicit open request", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		await withFakeViewerService("ok", async () => {
			const first = await tool.execute("show-latex-open-first", { source: sourceContent, inline: false }, undefined, undefined, context);
			const second = await tool.execute("show-latex-open-second", { source: sourceContent, inline: false }, undefined, undefined, context);

			const firstDetails = first.details as { pdf_id: number; pdf: string };
			const secondDetails = second.details as { pdf_id: number; pdf: string };
			assert.equal(firstDetails.pdf, secondDetails.pdf);
			assert.equal(typeof firstDetails.pdf_id, "number");
			assert.equal(firstDetails.pdf_id, secondDetails.pdf_id);

			const requests = readFakeViewerOpenRequests();
			assert.equal(requests.length, 2);
			assert.equal(requests[0].pdf_path, MCP_FIXED_PREVIEW_PDF_PATH);
			assert.equal(requests[1].pdf_path, MCP_FIXED_PREVIEW_PDF_PATH);
			assert.equal(requests[1].reused, true);
			assert.equal(requests[0].request_id === requests[1].request_id, false);
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external flow distinguishes service timeout", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		await withFakeViewerService("hang", async () => {
			try {
				await tool.execute("show-latex-open-timeout", { source: sourceContent, inline: false }, undefined, undefined, context);
				assert.fail("expected show_latex timeout to throw");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/Viewer service request timed out while opening preview/.test(message), true);
				assert.equal(/code=timeout|code=service_timeout/.test(message), false);
			}
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external flow distinguishes backend open failure", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		await withFakeViewerService("backend_unavailable", async () => {
			try {
				await tool.execute("show-latex-open-backend", { source: sourceContent, inline: false }, undefined, undefined, context);
				assert.fail("expected show_latex open failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/Viewer backend unavailable while opening preview/.test(message), true);
				assert.equal(/code=backend_unavailable/.test(message), true);
			}
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external flow distinguishes service unavailable", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		await withFakeViewerService("service_unavailable", async () => {
			try {
				await tool.execute("show-latex-open-service-unavailable", { source: sourceContent, inline: false }, undefined, undefined, context);
				assert.fail("expected show_latex service-unavailable failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/Viewer service unavailable while opening preview \(code=service_unavailable\)/.test(message), true);
			}
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external compile failure is reported distinctly", async () => {
	const { root } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir, true);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	rmSync(MCP_OPEN_REQUEST_LOG, { force: true });

	try {
		try {
			await tool.execute("show-latex-compile-failure", { source: "\\begin{document}bad\\end{document}", inline: false }, undefined, undefined, context);
			assert.fail("expected show_latex compile failure");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert.equal(/LaTeX preview compilation failed/.test(message), true);
			assert.equal(/Viewer service/.test(message), false);
			assert.equal(readFakeViewerOpenRequests().length, 0);
		}
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import {
	FakeViewerBackend,
	HOST_SERVICE_SOCKET_PATH_ENV_VAR,
	HostServiceClient,
	HostServicePdfIdRegistry,
	HostServiceServer,
} from "../../../src/modules/host_service.ts";
import { HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS } from "../../../src/modules/pi_extension/host_service_client.ts";

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
const MCP_TMPDIR = mkdtempSync(resolve(tmpdir(), "pdf-preview-show-latex-service-"));
process.env.MCP_TMPDIR = MCP_TMPDIR;

type CompiledShowLatexApi = {
	registerTool: (tool: { name: string; [key: string]: unknown }) => void;
	registerCommand: () => void;
	on: (..._args: unknown[]) => void;
};

type CompiledShowLatexModule = {
	default: (api: CompiledShowLatexApi) => void;
};

type SessionLifecycleHandler = (_event: unknown, ctx: unknown) => Promise<unknown> | unknown;

let sessionStartHandler: SessionLifecycleHandler | undefined;
let sessionShutdownHandler: SessionLifecycleHandler | undefined;

let compiledIndexModule: Promise<CompiledShowLatexModule> | undefined;
let runtimeModulesInstalled = false;
let runtimeModulesRoot: string | undefined;

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

type ToolInvocation = {
	execute: (
		_toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

type CapturedTools = {
	compileTool: ToolInvocation;
	openPdfTool: ToolInvocation;
	closePdfTool: ToolInvocation;
	jumpPdfTool: ToolInvocation;
};

async function captureTools(): Promise<CapturedTools> {
	const extensionModule = await loadCompiledShowLatexModule();
	let capturedTools: Partial<CapturedTools> = {};

	extensionModule.default({
		registerTool(tool) {
			switch (tool.name) {
				case "compile_latex_file":
					capturedTools = { ...capturedTools, compileTool: tool as unknown as ToolInvocation };
					break;
				case "open_pdf":
					capturedTools = { ...capturedTools, openPdfTool: tool as unknown as ToolInvocation };
					break;
				case "close_pdf":
					capturedTools = { ...capturedTools, closePdfTool: tool as unknown as ToolInvocation };
					break;
				case "jump_pdf":
					capturedTools = { ...capturedTools, jumpPdfTool: tool as unknown as ToolInvocation };
					break;
			}
		},
		registerCommand() {},
		on(event, handler) {
			if (event === "session_start") {
				sessionStartHandler = handler as SessionLifecycleHandler;
			}
			if (event === "session_shutdown") {
				sessionShutdownHandler = handler as SessionLifecycleHandler;
			}
		},
	});

	if (!capturedTools.compileTool || !capturedTools.closePdfTool || !capturedTools.jumpPdfTool) {
		throw new Error("expected compile, close, and jump tools to be registered by index module");
	}

	if (!capturedTools.openPdfTool) {
		throw new Error("open_pdf tool was not registered by index module");
	}

	return {
		compileTool: capturedTools.compileTool,
		openPdfTool: capturedTools.openPdfTool,
		closePdfTool: capturedTools.closePdfTool,
		jumpPdfTool: capturedTools.jumpPdfTool,
	};
}

async function captureCompileTool(): Promise<ToolInvocation> {
	return (await captureTools()).compileTool;
}

type FakeCompilerOptions = {
	exitCode?: number;
	logContents?: string;
	stdoutContents?: string;
	stderrContents?: string;
};

class FakeJumpableViewerBackend extends FakeViewerBackend {
	async forwardSearch(_requestId: string, _details: Record<string, unknown>): Promise<{ status: "ok"; status_details: { backend: string; handled: boolean; backend_identity_ok: boolean } }> {
		return {
			status: "ok",
			status_details: {
				backend: "fake-viewer",
				handled: true,
				backend_identity_ok: true,
			},
		};
	}
}

class FakeUnvalidatedOpenViewerBackend extends FakeViewerBackend {
	private nextHandle = 0;

	async open(_requestId: string, _details: Record<string, unknown>): Promise<{ status: "ok"; status_details: Record<string, unknown> }> {
		this.nextHandle += 1;
		return {
			status: "ok",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend_path: "fake-viewer",
				owned: false,
				reused: false,
				pid: 123456,
				handle: `fake-viewer:${this.nextHandle}`,
			},
		};
	}
}

function writeFakeCompiler(binDir: string, options: FakeCompilerOptions = {}): string {
	const {
		exitCode = 0,
		logContents,
		stdoutContents,
		stderrContents,
	} = options;
	const writeLogLine = logContents === undefined
		? ""
		: `\n\tconst sourceBase = path.basename(source, ".tex");\n\tfs.writeFileSync(path.resolve(process.cwd(), sourceBase + ".log"), ${JSON.stringify(logContents)});`;
	const writeStdout = stdoutContents === undefined ? "" : `\n\tprocess.stdout.write(${JSON.stringify(stdoutContents)});`;
	const writeStderr = stderrContents === undefined ? "" : `\n\tprocess.stderr.write(${JSON.stringify(stderrContents)});`;

	const compilerPath = resolve(binDir, "lualatex");
	writeFileSync(
		compilerPath,
		`#!/usr/bin/env node
	const fs = require("node:fs");
	const path = require("node:path");
	const source = process.argv[process.argv.length - 1];
	if (!source) process.exit(1);
	const pdf = path.resolve(process.cwd(), source.replace(/\\.tex$/, ".pdf"));
	if (${exitCode} === 0) {
		fs.writeFileSync(pdf, "%PDF-1.7\\n");
	}
	${writeLogLine}
	${writeStdout}
	${writeStderr}
	process.exit(${exitCode});
`,
		{ mode: 0o700 },
	);
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

async function runSessionStart(ctx: unknown): Promise<void> {
	if (!sessionStartHandler) return;
	await sessionStartHandler("session_start", ctx);
}

async function runSessionShutdown(ctx: unknown): Promise<void> {
	if (!sessionShutdownHandler) return;
	await sessionShutdownHandler("session_shutdown", ctx);
}

async function withHostService<T>(
	backend: FakeViewerBackend,
	fn: () => Promise<T>,
	options: { managedViewerRecords?: HostServicePdfIdRegistry } = {},
): Promise<T> {
	const serviceDir = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-service-"));
	const socketPath = resolve(serviceDir, "host_service.sock");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
		...(options.managedViewerRecords === undefined ? {} : { managedViewerRecords: options.managedViewerRecords }),
	});
	const previousSocketPath = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	await server.start();
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;
	try {
		return await fn();
	} finally {
		if (typeof previousSocketPath === "undefined") {
			delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		} else {
			process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = previousSocketPath;
		}
		await server.stop();
		rmSync(serviceDir, { recursive: true, force: true });
	}
}

function withHostServiceDefault<T>(fn: () => Promise<T>): Promise<T> {
	return withHostService(new FakeViewerBackend(), fn);
}

function makeFixedHostServicePdfIdRegistry(pdfId: number): HostServicePdfIdRegistry {
	return new HostServicePdfIdRegistry({
		minPdfId: pdfId,
		maxPdfId: pdfId,
		makePdfId: () => pdfId,
	});
}

async function withHostServiceUnavailable<T>(fn: () => Promise<T>): Promise<T> {
	const previousSocketPath = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	const fallbackSocketPath = mkdtempSync(resolve(tmpdir(), "pdf-preview-missing-host-service-"));
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = resolve(fallbackSocketPath, "missing.sock");
	try {
		return await fn();
	} finally {
		if (typeof previousSocketPath === "undefined") {
			delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		} else {
			process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = previousSocketPath;
		}
		rmSync(fallbackSocketPath, { recursive: true, force: true });
	}
}

function withTemporaryProject(): { root: string; sourcePath: string; sourceContent: string } {
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-compile-test-"));
	const sourcePath = resolve(root, "paper.tex");
	writeFileSync(sourcePath, "\\begin{document}ok\\end{document}");
	return { root, sourcePath, sourceContent: "\\begin{document}ok\\end{document}" };
}

function createSessionContext(cwd: string, sessionId?: string) {
	return {
		...(sessionId === undefined ? {} : { session_id: sessionId }),
		hasUI: false,
		cwd,
		ui: {
			notify: () => undefined,
			onTerminalInput: () => () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
		},
		isIdle: () => false,
		signal: new AbortController().signal,
	};
}

function extractCompileFailureLogPath(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(/Log:\s*(\S+)/);
	if (!match) {
		throw new Error(`expected failure to include log path; message was: ${message}`);
	}
	return match[1];
}

function readCompileFailureLog(error: unknown): string {
	const logPath = extractCompileFailureLogPath(error);
	return readFileSync(logPath, "utf8");
}

test("session_start copies project preambles into independent per-session runtime dirs", async () => {
	await captureTools();
	const projectA = mkdtempSync(resolve(tmpdir(), "pdf-preview-preamble-A-"));
	const projectB = mkdtempSync(resolve(tmpdir(), "pdf-preview-preamble-B-"));
	const preambleA = "\\usepackage{array}";
	const preambleB = "\\usepackage{booktabs}";
	writeFileSync(resolve(projectA, "preamble.tex"), preambleA);
	writeFileSync(resolve(projectB, "preamble.tex"), preambleB);
	const contextA = createSessionContext(projectA, "compile-session-A");
	const contextB = createSessionContext(projectB, "compile-session-B");
	const preamblePathA = resolve(MCP_TMPDIR, "agents", "compile-session-A", "preamble.tex");
	const preamblePathB = resolve(MCP_TMPDIR, "agents", "compile-session-B", "preamble.tex");

	try {
		await withHostServiceDefault(async () => {
			await runSessionStart(contextA);
			await runSessionStart(contextB);
			assert.equal(readFileSync(preamblePathA, "utf8"), `${preambleA}\n`);
			assert.equal(readFileSync(preamblePathB, "utf8"), `${preambleB}\n`);
		});
	} finally {
		await runSessionShutdown(contextA);
		await runSessionShutdown(contextB);
		rmSync(projectA, { recursive: true, force: true });
		rmSync(projectB, { recursive: true, force: true });
	}
});

test("compile_latex_file compiles without opening by default", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		await withHostServiceDefault(async () => {
			const result = await tool.execute("compile-latex-file-only", { latex_file_path: sourcePath }, undefined, undefined, undefined);
			const expectedPdf = resolve(root, "paper.pdf");

			const details = result.details as {
				source: string;
				pdf: string;
				log: string;
				clean: boolean;
				cleaned_artifacts: unknown[];
				viewer_handle?: unknown;
			};
			assert.equal(result.content.length, 1);
			assert.equal(result.content[0].text.startsWith(`ok: ${expectedPdf}\nLog: `), true);
			assert.equal(details.source, sourcePath);
			assert.equal(details.pdf, expectedPdf);
			assert.equal(details.log, resolve(root, "paper.log"));
			assert.equal(details.clean, false);
			assert.deepEqual(details.cleaned_artifacts, []);
			assert.equal(details.viewer_handle, undefined);
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file returns warning summaries from successful compiles", async () => {
	const tool = await captureCompileTool();
	const root = mkdtempSync(join(tmpdir(), "pdf-preview-compile-warnings-"));
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const sourcePath = resolve(root, "paper.tex");
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nSee \\ref{foo}.\\end{document}\n");
	const originalPath = process.env.PATH ?? "";
	writeFakeCompiler(binDir, {
		logContents: "LaTeX Warning: Reference `foo' undefined on input line 3.\nOverfull \\hbox (5.0pt too wide) in paragraph at lines 4--5\n",
	});
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		await withHostServiceDefault(async () => {
			const result = await tool.execute("compile-latex-file-warnings", { latex_file_path: sourcePath }, undefined, undefined, undefined);
			const details = result.details as { compile_status?: string; warning_count?: number; warnings?: Array<{ message: string }>; log?: string };
			assert.match(result.content[0].text, /^ok_with_warnings:/);
			assert.match(result.content[0].text, /warnings=2/);
			assert.match(result.content[0].text, /Reference `foo'/);
			assert.equal(details.compile_status, "ok_with_warnings");
			assert.equal(details.warning_count, 2);
			assert.equal(details.warnings?.some((warning) => /Overfull/.test(warning.message)), true);
			assert.equal(details.log, resolve(root, "paper.log"));
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file requests compilation with extended timeout", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const expectedPdf = resolve(root, "paper.pdf");
	const expectedSource = sourcePath;
	const expectedLog = resolve(root, "paper.log");
	let compileTimeoutMs: number | undefined;
	const proto = HostServiceClient.prototype as { requestCompileLatexFile: HostServiceClient["requestCompileLatexFile"] };
	const originalRequestCompileLatexFile = proto.requestCompileLatexFile;
	const fakeResponse: Awaited<ReturnType<HostServiceClient["requestCompileLatexFile"]>> = {
		protocol_version: 1,
		supported: true,
		service_available: true,
		workspace_context: { cwd: root },
		request_id: "compile-timeout-test",
		operation: "compile_latex_file",
		source: expectedSource,
		pdf: expectedPdf,
		log: expectedLog,
		artifact_paths: [expectedPdf],
		clean: false,
		cleaned_artifacts: [],
	};

	try {
		proto.requestCompileLatexFile = async (_request, _workspaceContext, _signal, requestTimeoutMs) => {
			compileTimeoutMs = requestTimeoutMs;
			return fakeResponse;
		};

		const result = await tool.execute("compile-latex-file", { latex_file_path: sourcePath }, undefined, undefined, undefined);
		assert.equal(compileTimeoutMs, HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS);
		const details = result.details as {
			source: string;
			pdf: string;
		};
		assert.equal(details.source, expectedSource);
		assert.equal(details.pdf, expectedPdf);
	} finally {
		proto.requestCompileLatexFile = originalRequestCompileLatexFile;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi tool descriptions document continuous lifecycle boundaries", async () => {
	const { compileTool, closePdfTool } = await captureTools();
	const closeTool = closePdfTool as unknown as { description?: string; promptGuidelines?: string[] };
	const closeText = [closeTool.description, ...(closeTool.promptGuidelines ?? [])].join("\n");
	assert.match(closeText, /does not stop continuous compilation/);
	assert.match(closeText, /continuous=false/);

	const tool = compileTool as unknown as {
		description?: string;
		promptGuidelines?: string[];
		parameters?: { properties?: { continuous?: { schema?: { options?: { description?: string } } } } };
	};
	const text = [tool.description, ...(tool.promptGuidelines ?? []), tool.parameters?.properties?.continuous?.schema?.options?.description].join("\n");
	assert.match(text, /continuous=true/);
	assert.match(text, /continuous=false/);
	assert.match(text, /omit continuous/);
	assert.match(text, /close_pdf does not stop continuous compilation/);
	assert.match(text, /latexmk/);
	assert.match(text, /-norc/);
	assert.match(text, /latexmkrc/);
	assert.match(text, /no shell escape|-no-shell-escape/);
	assert.match(text, /multi-file dependency tracking/);
	assert.match(text, /heartbeat/);
	assert.match(text, /\[system info\]/);
});

test("compile_latex_file passes continuous flag through and renders continuous metadata", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const expectedPdf = resolve(root, "paper.pdf");
	const expectedLog = resolve(root, "paper.log");
	let capturedRequest: Parameters<HostServiceClient["requestCompileLatexFile"]>[0] | undefined;
	let capturedContext: Parameters<HostServiceClient["requestCompileLatexFile"]>[1] | undefined;
	const proto = HostServiceClient.prototype as { requestCompileLatexFile: HostServiceClient["requestCompileLatexFile"] };
	const originalRequestCompileLatexFile = proto.requestCompileLatexFile;
	try {
		proto.requestCompileLatexFile = async (request, workspaceContext) => {
			capturedRequest = request;
			capturedContext = workspaceContext;
			return {
				protocol_version: 1,
				supported: true,
				service_available: true,
				workspace_context: workspaceContext,
				request_id: "continuous-pi-test",
				operation: "compile_latex_file",
				source: sourcePath,
				pdf: expectedPdf,
				log: expectedLog,
				artifact_paths: [expectedPdf],
				clean: false,
				cleaned_artifacts: [],
				continuous: {
					requested: true,
					status: "started",
					root_source: sourcePath,
					session_id: workspaceContext.session_id ?? "",
					subscriber_count: 1,
					pid: 12345,
				},
			};
		};

		const result = await tool.execute(
			"compile-latex-file-continuous",
			{ latex_file_path: sourcePath, continuous: true },
			undefined,
			undefined,
			createSessionContext(root, "pi-continuous-session"),
		);
		assert.equal(capturedRequest?.continuous, true);
		assert.equal(capturedContext?.session_id, "pi-continuous-session");
		assert.match(result.content[0].text, /Continuous: started subscribers=1 pid=12345/);
		assert.equal((result.details as { continuous?: { status?: string } }).continuous?.status, "started");
	} finally {
		proto.requestCompileLatexFile = originalRequestCompileLatexFile;
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
		await withHostServiceDefault(async () => {
			const result = await tool.execute(
				"compile-latex-file-relative",
				{ latex_file_path: "nested/paper.tex" },
				undefined,
				undefined,
				createSessionContext(root),
			);
			const details = result.details as { source: string };
			assert.equal(details.source, sourcePath);
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file opens through host service when open_pdf=true", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	const context = createSessionContext(root);
	try {
		await withHostServiceDefault(async () => {
			await runSessionStart(context);
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
			assert.equal(details.pid, 123456);
			assert.equal(result.content[0].text.startsWith(`ok: pdf_id=${details.pdf_id} pid=123456 pdf=${details.pdf}`), true);
			assert.equal("synctex_callback_command" in (details as Record<string, unknown>), false);
			assert.equal(typeof details.viewer_handle, "string");
			assert.equal(details.viewer_backend, "fake-viewer");
			assert.equal(details.viewer_owned, true);
			assert.equal(details.viewer_capabilities.open, true);
			assert.equal(details.viewer_capabilities.close, true);
			assert.equal(details.viewer_capabilities.forward_search, true);
			assert.equal(details.viewer_capabilities.reuse, true);
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file(open_pdf=true) fails when compile response omits pdf_id", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const socketDir = mkdtempSync(resolve(tmpdir(), "pdf-preview-compile-no-pdf-id-"));
	const socketPath = resolve(socketDir, "host-service.sock");
	const context = createSessionContext(root);
	const previousSocketPath = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	const server = createServer((socket) => {
		socket.on("data", (chunk) => {
			const line = String(chunk).split("\n").find((entry) => entry.trim().length > 0);
			if (!line) {
				return;
			}
			const request = JSON.parse(line);
			const requestId = typeof request.request_id === "string" ? request.request_id : "unknown";
			const workspaceContext = typeof request.workspace_context === "object" && request.workspace_context !== null
				? (request.workspace_context as Record<string, unknown>)
				: { cwd: root };
			const nowNs = Date.now() * 1_000_000;
			const operation = typeof request.operation === "string" ? request.operation : "compile_latex_file";
			if (operation === "status") {
				socket.end(
					`${JSON.stringify({
						protocol_version: 1,
						request_id: requestId,
						operation,
						status: "ok",
						generated_at_ns: nowNs,
						status_details: {
							protocol_version: 1,
							supported: true,
							service_available: true,
							service_name: "fake-host-service",
							socket_path: socketPath,
							service_instance_started_ns: nowNs,
							service_instance_id: "fake-host-service",
							workspace_context: workspaceContext,
							request_id: requestId,
							operation,
							uptime_ns: 0,
							total_requests: 1,
							viewer_backend_name: "fake",
							viewer_backend_available: true,
							viewer_backend_capabilities: {
								open: true,
								close: true,
								forward_search: true,
								inverse_search: true,
								reuse: true,
							},
						},
					})}\n`,
			);
				return;
			}
			if (operation === "register_callback_target") {
				socket.end(
					`${JSON.stringify({
						protocol_version: 1,
						request_id: requestId,
						operation,
						status: "ok",
						generated_at_ns: nowNs,
						status_details: {
							protocol_version: 1,
							supported: true,
							service_available: true,
							service_name: "fake-host-service",
							socket_path: socketPath,
							service_instance_started_ns: nowNs,
							service_instance_id: "fake-host-service",
							workspace_context: workspaceContext,
							request_id: requestId,
							operation,
							target_id: typeof request.target_id === "string" ? request.target_id : "",
							callback_registered: true,
							callback_replaced: false,
							target: request.target,
							uptime_ns: 0,
							total_requests: 1,
						},
					})}\n`,
			);
				return;
			}
			if (operation === "unregister_callback_target") {
				socket.end(
					`${JSON.stringify({
						protocol_version: 1,
						request_id: requestId,
						operation,
						status: "ok",
						generated_at_ns: nowNs,
						status_details: {
							protocol_version: 1,
							supported: true,
							service_available: true,
							service_name: "fake-host-service",
							socket_path: socketPath,
							service_instance_started_ns: nowNs,
							service_instance_id: "fake-host-service",
							workspace_context: workspaceContext,
							request_id: requestId,
							operation,
							target_id: typeof request.target_id === "string" ? request.target_id : "",
							removed: true,
							uptime_ns: 0,
							total_requests: 1,
						},
					})}\n`,
			);
				return;
			}
			socket.end(
				`${JSON.stringify({
					protocol_version: 1,
					request_id: requestId,
					operation: "compile_latex_file",
					status: "ok",
					generated_at_ns: nowNs,
					status_details: {
						protocol_version: 1,
						supported: true,
						service_available: true,
						workspace_context: workspaceContext,
						request_id: requestId,
						service_instance_started_ns: nowNs,
						service_instance_id: "fake-host-service",
						uptime_ns: 0,
						total_requests: 1,
						source: sourcePath,
						pdf: resolve(root, "paper.pdf"),
						log: "",
						clean: false,
						cleaned_artifacts: [],
						artifact_paths: [],
						operation: "compile_latex_file",
					},
				})}\n`,
			);
		});
	});

	let observed: unknown;
	try {
		await new Promise<void>((resolve, reject) => {
			server.listen(socketPath, (error?: Error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
		process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;
		await runSessionStart(context);
		await tool.execute(
			"compile-latex-file-open-missing-pdf-id",
			{ latex_file_path: sourcePath, open_pdf: true },
			undefined,
			undefined,
			context,
		);
	} catch (error) {
		observed = error;
	} finally {
		await runSessionShutdown(context);
		if (previousSocketPath === undefined) {
			delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		} else {
			process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = previousSocketPath;
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error?: Error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
		rmSync(root, { recursive: true, force: true });
		rmSync(socketDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(
		observed.message,
		/host service returned no pdf_id for open_pdf=true compile request/,
	);
});

test("compile_latex_file open results can be used with registered close_pdf and jump_pdf tools", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tools = await captureTools();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	const context = createSessionContext(root);
	const sourceLine = "\\begin{document}ok\\end{document}";
	try {
		await withHostService(new FakeJumpableViewerBackend(), async () => {
			await runSessionStart(context);
			const result = await tools.compileTool.execute(
				"compile-latex-file-open-track",
				{ latex_file_path: sourcePath, open_pdf: true },
				undefined,
				undefined,
				context,
			);
			const details = result.details as {
				pdf_id: number;
				pdf: string;
				source: string;
			};
			const jumpResult = await tools.jumpPdfTool.execute(
				"compile-latex-file-jump",
				{ pdf_id: details.pdf_id, line: 1, source_file: details.source },
				undefined,
				undefined,
				context,
			);
			const closeResult = await tools.closePdfTool.execute(
				"compile-latex-file-close",
				{ pdf_id: details.pdf_id },
				undefined,
				undefined,
				context,
			);
			const jumpDetails = jumpResult.details as {
				pdf_id: number;
				source: string;
				source_line: string;
			};
			const closeDetails = closeResult.details as { pdf_id: number; closed: boolean; reason?: string };

			assert.equal(jumpDetails.pdf_id, details.pdf_id);
			assert.equal(jumpDetails.source, details.source);
			assert.equal(jumpDetails.source_line, sourceLine);
			assert.equal(jumpResult.content[0].text, `line 1 contains:\n${sourceLine}`);
			assert.equal(closeDetails.pdf_id, details.pdf_id);
			assert.equal(closeDetails.closed, true);
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file(open_pdf=true) can be followed by registered jump_pdf and close_pdf tools", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tools = await captureTools();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	const context = createSessionContext(root);
	const sourceLine = "\\begin{document}ok\\end{document}";
	try {
		await withHostService(new FakeJumpableViewerBackend(), async () => {
			await runSessionStart(context);
			const compileResult = await tools.compileTool.execute(
				"compile-latex-file-open-tool-jump-close",
				{ latex_file_path: sourcePath, open_pdf: true },
				undefined,
				undefined,
				context,
			);
			const compileDetails = compileResult.details as {
				pdf_id: number;
				pdf: string;
				source: string;
			};
			const jumpResult = await tools.jumpPdfTool.execute(
				"jump-latex-file-open",
				{
					pdf_id: compileDetails.pdf_id,
					line: 1,
					source_file: compileDetails.source,
				},
				undefined,
				undefined,
				context,
			);
			const jumpDetails = jumpResult.details as {
				pdf_id: number;
				pdf: string;
				source: string;
				source_line: string;
				reopened: boolean;
			};
			const closeResult = await tools.closePdfTool.execute(
				"close-latex-file-open",
				{ pdf_id: compileDetails.pdf_id },
				undefined,
				undefined,
				context,
			);
			const closeDetails = closeResult.details as { pdf_id: number; closed: boolean; reason?: string };

			assert.equal(typeof compileDetails.pdf_id, "number");
			assert.equal(compileDetails.pdf_id > 0, true);
			assert.equal(jumpDetails.pdf_id, compileDetails.pdf_id);
			assert.equal(jumpDetails.pdf, compileDetails.pdf);
			assert.equal(jumpDetails.source, compileDetails.source);
			assert.equal(jumpDetails.reopened, false);
			assert.equal(jumpResult.content[0].text, `line 1 contains:\n${sourceLine}`);
			assert.equal(jumpDetails.source_line, sourceLine);
			assert.equal(closeDetails.pdf_id, compileDetails.pdf_id);
			assert.equal(closeDetails.closed, true);
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("open_pdf exposes host-service PDF IDs and supports jump/close", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tools = await captureTools();
	const context = createSessionContext(root);
	const sourceLine = "\\begin{document}ok\\end{document}";
	const sourcePdfPath = resolve(root, "paper.pdf");
	writeFileSync(sourcePdfPath, "%PDF-1.7\n");
	try {
		await withHostService(
			new FakeJumpableViewerBackend(),
			async () => {
				await runSessionStart(context);
				const openResult = await tools.openPdfTool.execute(
					"open-pdf-tool",
					{ pdf_file_path: sourcePdfPath },
					undefined,
					undefined,
					context,
				);
				const openDetails = openResult.details as {
					pdf_id: number;
					pdf: string;
					source: string;
				};
				assert.equal(openDetails.pdf_id, 7777);
				assert.equal("synctex_callback_command" in (openDetails as Record<string, unknown>), false);
				assert.equal(openResult.content[0].text.includes(`pdf_id=${openDetails.pdf_id}`), true);
				assert.equal(openDetails.pdf, sourcePdfPath);
				assert.equal(openDetails.source, sourcePath);

				const jumpResult = await tools.jumpPdfTool.execute(
					"jump-open-pdf-tool",
					{ pdf_id: openDetails.pdf_id, line: 1, source_file: sourcePath },
					undefined,
					undefined,
					context,
				);
				const jumpDetails = jumpResult.details as { source_line: string };
				assert.equal(jumpResult.content[0].text, `line 1 contains:\n${sourceLine}`);
				assert.equal(jumpDetails.source_line, sourceLine);

				const closeResult = await tools.closePdfTool.execute(
					"close-pdf-tool",
					{ pdf_id: openDetails.pdf_id },
					undefined,
					undefined,
					context,
				);
				const closeDetails = closeResult.details as { closed: boolean; pdf_id: number; reason?: string };
				assert.equal(closeDetails.closed, true);
				assert.equal(closeDetails.pdf_id, openDetails.pdf_id);
			},
			{ managedViewerRecords: makeFixedHostServicePdfIdRegistry(7777) },
		);
	} finally {
		await runSessionShutdown(context);
		rmSync(root, { recursive: true, force: true });
	}
});

test("open_pdf resolves relative pdf_file_path using session cwd", async () => {
	const { root } = withTemporaryProject();
	const tools = await captureTools();
	const context = createSessionContext(root);
	const sourcePdfPath = resolve(root, "relative.pdf");
	writeFileSync(sourcePdfPath, "%PDF-1.7\\n");

	const originalCwd = process.cwd();
	const externalCwd = mkdtempSync(resolve(tmpdir(), "pdf-preview-open-test-"));
	const fixedPdfId = 9001;
	const records = makeFixedHostServicePdfIdRegistry(fixedPdfId);
	try {
		process.chdir(externalCwd);
		await withHostService(
			new FakeJumpableViewerBackend(),
			async () => {
				await runSessionStart(context);
				const openResult = await tools.openPdfTool.execute(
					"open-pdf-relative-cwd",
					{ pdf_file_path: "relative.pdf" },
					undefined,
					undefined,
					context,
				);
				const openDetails = openResult.details as { pdf_id: number; pdf: string };
				assert.equal(openDetails.pdf_id, fixedPdfId);
				assert.equal(openDetails.pdf, sourcePdfPath);
				assert.equal(records.activeCount, 1);
				const closeResult = await tools.closePdfTool.execute(
					"close-pdf-relative-cwd",
					{ pdf_id: openDetails.pdf_id },
					undefined,
					undefined,
					context,
				);
				assert.equal(closeResult.details.closed, true);
				assert.equal(records.activeCount, 0);
			},
			{ managedViewerRecords: records },
		);
	} finally {
		process.chdir(originalCwd);
		rmSync(externalCwd, { recursive: true, force: true });
		await runSessionShutdown(context);
		rmSync(root, { recursive: true, force: true });
	}
});

test("open_pdf closes host-viewer when tracking fails after host open", async () => {
	const { root } = withTemporaryProject();
	const tools = await captureTools();
	const context = createSessionContext(root);
	const fixedPdfId = 9002;
	const records = makeFixedHostServicePdfIdRegistry(fixedPdfId);
	let openError: unknown;
	try {
		await withHostService(
			new FakeUnvalidatedOpenViewerBackend(),
			async () => {
				await runSessionStart(context);
				try {
					await tools.openPdfTool.execute(
						"open-pdf-tracking-failure",
						{ pdf_file_path: "relative-missing.pdf" },
						undefined,
						undefined,
						context,
					);
					assert.fail("open_pdf should reject when opened PDF cannot be tracked");
				} catch (error) {
					openError = error;
				}
				assert.equal(records.activeCount, 0);
			},
			{ managedViewerRecords: records },
		);
	} finally {
		await runSessionShutdown(context);
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(openError !== undefined, true);
	const openMessage = openError instanceof Error ? openError.message : String(openError);
	assert.equal(/Cannot stat PDF file/.test(openMessage), true);
});

test("jump_pdf and close_pdf surface errors for unknown or closed host-service IDs", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tools = await captureTools();
	const context = createSessionContext(root);
	const sourceLine = "\\begin{document}ok\\end{document}";
	writeFileSync(resolve(root, "paper.pdf"), "%PDF-1.7\n");
	writeFileSync(sourcePath, `${sourceLine}\n`);
	const fixedPdfId = 8888;
	try {
		await withHostService(
			new FakeJumpableViewerBackend(),
			async () => {
				await runSessionStart(context);
				const openResult = await tools.openPdfTool.execute(
					"open-pdf-tool-stale",
					{ pdf_file_path: resolve(root, "paper.pdf") },
					undefined,
					undefined,
					context,
				);
				const openDetails = openResult.details as { pdf_id: number; pdf: string };
				assert.equal(openDetails.pdf_id, fixedPdfId);
				const hostServiceClient = new HostServiceClient({ socketPath: process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] });
				await hostServiceClient.requestClosePdf({ cwd: root }, openDetails.pdf_id);

				let staleJumpError: unknown;
				try {
					await tools.jumpPdfTool.execute(
						"jump-pdf-tool-stale",
						{ pdf_id: openDetails.pdf_id, line: 1, source_file: sourcePath },
						undefined,
						undefined,
						context,
					);
					assert.fail("jump_pdf should reject for closed tracked id");
				} catch (error) {
					staleJumpError = error;
				}
				const staleJumpText = staleJumpError instanceof Error ? staleJumpError.message : String(staleJumpError);
				assert.equal(/Closed pdf_id=/.test(staleJumpText), true);

				let staleCloseError: unknown;
				try {
					await tools.closePdfTool.execute(
						"close-pdf-tool-stale",
						{ pdf_id: openDetails.pdf_id },
						undefined,
						undefined,
						context,
					);
					assert.fail("close_pdf should reject for stale closed pdf_id");
				} catch (error) {
					staleCloseError = error;
				}
				const staleCloseText = staleCloseError instanceof Error ? staleCloseError.message : String(staleCloseError);
				assert.equal(/Closed pdf_id=/.test(staleCloseText), true);

				let unknownCloseError: unknown;
				try {
					await tools.closePdfTool.execute(
						"close-pdf-unknown",
						{ pdf_id: 424242 },
						undefined,
						undefined,
						context,
					);
					assert.fail("close_pdf should reject for unknown id");
				} catch (error) {
					unknownCloseError = error;
				}
				const unknownCloseText = unknownCloseError instanceof Error ? unknownCloseError.message : String(unknownCloseError);
				assert.equal(/Unknown pdf_id=/.test(unknownCloseText), true);

				let unknownJumpError: unknown;
				try {
					await tools.jumpPdfTool.execute(
						"jump-pdf-unknown",
						{ pdf_id: 424242, line: 1, source_file: sourcePath },
						undefined,
						undefined,
						context,
					);
					assert.fail("jump_pdf should reject for unknown id");
				} catch (error) {
					unknownJumpError = error;
				}
				const unknownJumpText = unknownJumpError instanceof Error ? unknownJumpError.message : String(unknownJumpError);
				assert.equal(/Unknown pdf_id=/.test(unknownJumpText), true);
			},
			{ managedViewerRecords: makeFixedHostServicePdfIdRegistry(fixedPdfId) },
		);
	} finally {
		await runSessionShutdown(context);
		rmSync(root, { recursive: true, force: true });
	}
});

test("close_pdf and jump_pdf work when the host-service ID is active but not locally tracked", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tools = await captureTools();
	const context = createSessionContext(root);
	const sourceLine = "\\begin{document}ok\\end{document}";
	writeFileSync(resolve(root, "paper.pdf"), "%PDF-1.7\n");
	writeFileSync(sourcePath, `${sourceLine}\n`);
	const fixedPdfId = 9004;
	try {
		await withHostService(
			new FakeJumpableViewerBackend(),
			async () => {
				await runSessionStart(context);
				const openResult = await tools.openPdfTool.execute(
					"open-pdf-tool-untracked",
					{ pdf_file_path: resolve(root, "paper.pdf") },
					undefined,
					undefined,
					context,
				);
				const openDetails = openResult.details as { pdf_id: number; pdf: string };
				assert.equal(openDetails.pdf_id, fixedPdfId);
				const jumpResult = await tools.jumpPdfTool.execute(
					"jump-pdf-tool-untracked",
					{ pdf_id: openDetails.pdf_id, line: 1, source_file: sourcePath },
					undefined,
					undefined,
					context,
				);
				assert.equal(jumpResult.content[0].text, `line 1 contains:\n${sourceLine}`);
				assert.equal(jumpResult.details.pdf, openDetails.pdf);
				const closeResult = await tools.closePdfTool.execute(
					"close-pdf-tool-untracked",
					{ pdf_id: openDetails.pdf_id },
					undefined,
					undefined,
					context,
				);
				assert.equal(closeResult.details.closed, true);
			},
			{ managedViewerRecords: makeFixedHostServicePdfIdRegistry(fixedPdfId) },
		);
	} finally {
		await runSessionShutdown(context);
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file(open_pdf=true) refreshes host-service metadata after service restart", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tools = await captureTools();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	const context = createSessionContext(root);
	const sourceLine = "\\begin{document}ok\\end{document}";
	try {
		await runSessionStart(context);

		await withHostService(
			new FakeJumpableViewerBackend(),
			async () => {
				const firstCompile = await tools.compileTool.execute(
					"compile-latex-file-restart-1",
					{ latex_file_path: sourcePath, open_pdf: true },
					undefined,
					undefined,
					context,
				);
				const firstDetails = firstCompile.details as { pdf_id: number; pdf: string; source: string };
				assert.equal(firstDetails.pdf_id, 1001);
				assert.equal(firstDetails.pdf, resolve(root, "paper.pdf"));
				assert.equal(firstDetails.source, sourcePath);
			},
			{ managedViewerRecords: makeFixedHostServicePdfIdRegistry(1001) },
		);

		await withHostService(
			new FakeJumpableViewerBackend(),
			async () => {
				const secondCompile = await tools.compileTool.execute(
					"compile-latex-file-restart-2",
					{ latex_file_path: sourcePath, open_pdf: true },
					undefined,
					undefined,
					context,
				);
				const secondDetails = secondCompile.details as { pdf_id: number; pdf: string; source: string; };
				assert.equal(secondDetails.pdf_id, 2222);
				assert.equal(secondDetails.pdf, resolve(root, "paper.pdf"));
				assert.equal(secondDetails.source, sourcePath);

				const jumpResult = await tools.jumpPdfTool.execute(
					"jump-latex-file-open-restart",
					{
						pdf_id: secondDetails.pdf_id,
						line: 1,
						source_file: sourcePath,
					},
					undefined,
					undefined,
					context,
				);
				const jumpDetails = jumpResult.details as {
					pdf_id: number;
					pdf: string;
					source: string;
					reopened: boolean;
					source_line: string;
				};

				const closeResult = await tools.closePdfTool.execute(
					"close-latex-file-open-restart",
					{ pdf_id: secondDetails.pdf_id },
					undefined,
					undefined,
					context,
				);
				const closeDetails = closeResult.details as { pdf_id: number; closed: boolean; reason?: string };

				assert.equal(jumpDetails.pdf_id, secondDetails.pdf_id);
				assert.equal(jumpDetails.pdf, resolve(root, "paper.pdf"));
				assert.equal(jumpDetails.source, sourcePath);
				assert.equal(jumpDetails.source_line, sourceLine);
				assert.equal(jumpResult.content[0].text, `line 1 contains:\n${sourceLine}`);
				assert.equal(jumpDetails.reopened === true || jumpDetails.reopened === false, true);
				assert.equal(closeDetails.pdf_id, secondDetails.pdf_id);
				assert.equal(closeDetails.closed, true);
			},
			{ managedViewerRecords: makeFixedHostServicePdfIdRegistry(2222) },
		);
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file reuses tracked PDF when opening compiled output repeatedly", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	const context = createSessionContext(root);
	try {
		await withHostServiceDefault(async () => {
			await runSessionStart(context);
			const first = await tool.execute(
				"compile-latex-file-reuse-1",
				{ latex_file_path: sourcePath, open_pdf: true },
				undefined,
				undefined,
				context,
			);
			const firstDetails = first.details as { pdf_id: number; pdf: string };
			assert.equal(firstDetails.pdf, resolve(root, "paper.pdf"));
			assert.equal(firstDetails.pdf_id > 0, true);

			const second = await tool.execute(
				"compile-latex-file-reuse-2",
				{ latex_file_path: sourcePath, open_pdf: true },
				undefined,
				undefined,
				context,
			);
			const secondDetails = second.details as { pdf_id: number };
			assert.equal(secondDetails.pdf_id, firstDetails.pdf_id);
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
		const unavailableViewer = new FakeViewerBackend({ available: false });
		await withHostService(unavailableViewer, async () => {
			await runSessionStart(context);
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
			}
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file reports host service unavailability", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		await withHostServiceUnavailable(async () => {
			try {
				await tool.execute("compile-latex-file-missing-host-service", { latex_file_path: sourcePath, open_pdf: true }, undefined, undefined, context);
				assert.fail("expected compile_latex_file to fail when host service socket is unavailable");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/host service/.test(message), true);
			}
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file precompile failures preserve resolved source for relative input", async () => {
	const { root } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const context = createSessionContext(root);
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		await withHostServiceDefault(async () => {
			try {
				await tool.execute("compile-latex-file-missing-relative", { latex_file_path: "missing.tex" }, undefined, undefined, context);
				assert.fail("expected compile_latex_file missing relative source failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/LaTeX compile failed/.test(message), true);
				const logText = readCompileFailureLog(error);
				assert.equal(logText.includes(`requested_path: missing.tex`), true);
				assert.equal(logText.includes(`source: ${resolve(root, "missing.tex")}`), true);
				assert.equal(logText.includes("Cannot stat LaTeX file"), true);
			}
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compile_latex_file precompile failures include resolved source in logged context", async () => {
	const { root } = withTemporaryProject();
	const missingSource = resolve(root, "missing.tex");
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		await withHostServiceDefault(async () => {
			try {
				await tool.execute("compile-latex-file-missing", { latex_file_path: missingSource }, undefined, undefined, createSessionContext(root));
				assert.fail("expected compile_latex_file missing source failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/LaTeX compile failed/.test(message), true);
				const logText = readCompileFailureLog(error);
				assert.equal(logText.includes(`requested_path: ${missingSource}`), true);
				assert.equal(logText.includes(`source: ${missingSource}`), true);
				assert.equal(logText.includes("Cannot stat LaTeX file"), true);
			}
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});


test("compile_latex_file preserves source context for invalid compiler and preserves compiler value", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		try {
			await tool.execute("compile-latex-file-invalid-compiler", { latex_file_path: sourcePath, compiler: "bogus" }, undefined, undefined, undefined);
			assert.fail("expected compile_latex_file invalid compiler failure");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert.equal(/LaTeX compile failed/.test(message), true);
			const logText = readCompileFailureLog(error);
			assert.equal(logText.includes(`requested_path: ${sourcePath}`), true);
			assert.equal(logText.includes(`source: ${sourcePath}`), true);
			assert.equal(logText.includes("compiler: bogus"), true);
		}
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});


test("compile_latex_file clean=true removes same-basename artifacts before compile", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const sourceBase = resolve(root, "paper");
	const artifacts = [
		`${sourceBase}.aux`,
		`${sourceBase}.log`,
		`${sourceBase}.out`,
		`${sourceBase}.pdf`,
		`${sourceBase}.synctex`,
		`${sourceBase}.synctex.gz`,
	];
	for (const artifact of artifacts) {
		writeFileSync(artifact, "old artifact");
	}
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		await withHostServiceDefault(async () => {
			const result = await tool.execute("compile-latex-file-clean-artifacts", { latex_file_path: sourcePath, clean: true }, undefined, undefined, undefined);
			const details = result.details as { cleaned_artifacts: string[] };
			for (const artifact of artifacts) {
				assert.equal(details.cleaned_artifacts.includes(artifact), true, `cleaned list should include ${artifact}`);
			}
			const pdfPath = resolve(root, "paper.pdf");
			const pdfContents = readFileSync(pdfPath, "utf8");
			assert.equal(pdfContents, "%PDF-1.7\n");
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});


test("compile_latex_file includes compiler-output tail in failure log on compile failure", async () => {
	const { root, sourcePath } = withTemporaryProject();
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir, {
		exitCode: 7,
		logContents: "project-log-entry\nsecond-log-entry\n",
		stderrContents: "compiler-stderr-line\n",
	});
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		await withHostServiceDefault(async () => {
			try {
				await tool.execute("compile-latex-file-failing", { latex_file_path: sourcePath }, undefined, undefined, undefined);
				assert.fail("expected compile_latex_file nonzero compiler failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/LaTeX compile failed/.test(message), true);
				const logText = readCompileFailureLog(error);
				assert.equal(logText.includes("project-log-entry"), true);
				assert.equal(logText.includes("second-log-entry"), true);
				assert.equal(logText.includes("Last 20 lines"), true);
				assert.equal(logText.includes("--- error ---"), true);
			}
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});


test("compile_latex_file keeps legacy regular-file validation message", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "pdf-preview-compile-test-"));
	const directoryPath = resolve(root, "a-directory");
	mkdirSync(directoryPath, { recursive: true });
	const tool = await captureCompileTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;

	try {
		await withHostServiceDefault(async () => {
			try {
				await tool.execute("compile-latex-file-directory", { latex_file_path: directoryPath }, undefined, undefined, undefined);
				assert.fail("expected compile_latex_file directory source failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/LaTeX compile failed/.test(message), true);
				assert.equal(readCompileFailureLog(error).includes(`latex_file_path must point to a regular file: ${directoryPath}`), true);
			}
		});
	} finally {
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

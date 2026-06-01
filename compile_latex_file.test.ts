import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { closeTrackedPdfForContext, jumpTrackedPdfForContext } from "./src/modules/pdf_session/pdf_session.ts";
import {
	FakeViewerBackend,
	HostServiceClient,
	HostServicePdfIdRegistry,
	HostServiceServer,
} from "./src/modules/host_service.ts";

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
	const previousSocketPath = process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH;
	await server.start();
	process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH = socketPath;
	try {
		return await fn();
	} finally {
		if (typeof previousSocketPath === "undefined") {
			delete process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH;
		} else {
			process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH = previousSocketPath;
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
	const previousSocketPath = process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH;
	const fallbackSocketPath = mkdtempSync(resolve(tmpdir(), "pdf-preview-missing-host-service-"));
	process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH = resolve(fallbackSocketPath, "missing.sock");
	try {
		return await fn();
	} finally {
		if (typeof previousSocketPath === "undefined") {
			delete process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH;
		} else {
			process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH = previousSocketPath;
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
		});
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
test("compile_latex_file open results can be used with internal close/jump tracker helpers", async () => {
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
					viewer_handle: string;
					viewer_backend: string;
				};
				const jump = await jumpTrackedPdfForContext(
					context,
					details.pdf_id,
					1,
					sourcePath,
					undefined,
					{
						requestForwardSearch: async (viewerHandle, viewerBackend, resolvedSourceFile, jumpLine) => {
							assert.equal(viewerHandle, details.viewer_handle);
							assert.equal(viewerBackend, details.viewer_backend);
							assert.equal(resolvedSourceFile, sourcePath);
							assert.equal(jumpLine, 1);
							return { handled: true };
						},
						requestJumpFromHostService: async () => {
							return { handled: true, source_file: sourcePath };
						},
					},
				);
				assert.equal(jump.pdf, details.pdf);
				assert.equal(jump.sourceFile, sourcePath);
				const close = await closeTrackedPdfForContext(
					context,
					details.pdf_id,
					async (viewerHandle, viewerBackend) => {
						assert.equal(viewerHandle, details.viewer_handle);
						assert.equal(viewerBackend, details.viewer_backend);
						return { closed: true };
					},
					undefined,
					async () => {
						return { closed: true };
					},
				);
				assert.equal(close.closed, true);
				assert.equal(close.pdf, resolve(root, "paper.pdf"));
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
			const closeDetails = closeResult.details as { pdf: string; closed: boolean };

			assert.equal(typeof compileDetails.pdf_id, "number");
			assert.equal(compileDetails.pdf_id > 0, true);
			assert.equal(jumpDetails.pdf_id, compileDetails.pdf_id);
			assert.equal(jumpDetails.pdf, compileDetails.pdf);
			assert.equal(jumpDetails.source, compileDetails.source);
			assert.equal(jumpDetails.reopened, false);
			assert.equal(jumpResult.content[0].text, `line 1 contains:\n${sourceLine}`);
			assert.equal(jumpDetails.source_line, sourceLine);
			assert.equal(closeDetails.pdf, compileDetails.pdf);
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
				const closeDetails = closeResult.details as { closed: boolean; pdf: string };
				assert.equal(closeDetails.closed, true);
				assert.equal(closeDetails.pdf, sourcePdfPath);
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
	writeFileSync(resolve(root, "paper.pdf"), "%PDF-1.7\n");
	writeFileSync(sourcePath, "\\begin{document}ok\\end{document}\n");
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
				const hostServiceClient = new HostServiceClient({ socketPath: process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH });
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
			},
			{ managedViewerRecords: makeFixedHostServicePdfIdRegistry(fixedPdfId) },
		);

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
		assert.equal(/Unknown tracked pdf_id/.test(unknownCloseText), true);

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
		assert.equal(/Unknown tracked pdf_id/.test(unknownJumpText), true);
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
				const closeDetails = closeResult.details as { pdf: string; closed: boolean };

				assert.equal(jumpDetails.pdf_id, secondDetails.pdf_id);
				assert.equal(jumpDetails.pdf, resolve(root, "paper.pdf"));
				assert.equal(jumpDetails.source, sourcePath);
				assert.equal(jumpDetails.source_line, sourceLine);
				assert.equal(jumpResult.content[0].text, `line 1 contains:\n${sourceLine}`);
				assert.equal(jumpDetails.reopened === true || jumpDetails.reopened === false, true);
				assert.equal(closeDetails.pdf, resolve(root, "paper.pdf"));
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

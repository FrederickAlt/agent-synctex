import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { HOST_SERVICE_SOCKET_PATH_ENV_VAR, FakeViewerBackend, HostServiceClient, HostServiceServer } from "./src/modules/host_service.ts";
import { HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS } from "./src/modules/pi_extension/host_service_client.ts";

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
const MCP_FIXED_PREVIEW_PDF_PATH = resolve(MCP_TMPDIR, "tex-actions.pdf");

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
	name: string;
	execute: (
		_toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

type ShowLatexToolSet = {
	showLatex: ShowLatexTool;	jumpPdf: ShowLatexTool;	closePdf: ShowLatexTool;	setLatexPreamble: ShowLatexTool;
};

let sessionShutdownHandler: SessionLifecycleHandler | undefined;
let compiledIndexModule: Promise<CompiledShowLatexModule> | undefined;
let runtimeModulesInstalled = false;
let runtimeModulesRoot: string | undefined;

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

async function captureTools(): Promise<ShowLatexToolSet> {
	const extensionModule = await loadCompiledShowLatexModule();
	let capturedShowLatex: ShowLatexTool | undefined;
	let capturedJumpPdf: ShowLatexTool | undefined;
	let capturedClosePdf: ShowLatexTool | undefined;
	let capturedSetLatexPreamble: ShowLatexTool | undefined;

	extensionModule.default({
		registerTool(tool) {
			if (tool.name === "show_latex") {
				capturedShowLatex = tool as unknown as ShowLatexTool;
				return;
			}
			if (tool.name === "jump_pdf") {
				capturedJumpPdf = tool as unknown as ShowLatexTool;
				return;
			}
			if (tool.name === "close_pdf") {
				capturedClosePdf = tool as unknown as ShowLatexTool;
			}
			if (tool.name === "set_latex_preamble") {
				capturedSetLatexPreamble = tool as unknown as ShowLatexTool;
			}
		},
		registerCommand() {},
		on(event, handler) {
			if (event === "session_shutdown") {
				sessionShutdownHandler = handler as SessionLifecycleHandler;
			}
		},
	});

	if (!capturedShowLatex) {
		throw new Error("show_latex tool was not registered by index module");
	}
	if (!capturedJumpPdf) {
		throw new Error("jump_pdf tool was not registered by index module");
	}
	if (!capturedClosePdf) {
		throw new Error("close_pdf tool was not registered by index module");
	}
	if (!capturedSetLatexPreamble) {
		throw new Error("set_latex_preamble tool was not registered by index module");
	}

	return {
		showLatex: capturedShowLatex,
		jumpPdf: capturedJumpPdf,
		closePdf: capturedClosePdf,
		setLatexPreamble: capturedSetLatexPreamble,
	};
}

async function captureShowLatexTool(): Promise<ShowLatexTool> {
	return (await captureTools()).showLatex;
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

function writeFakeMutool(binDir: string): string {
	const mutoolPath = resolve(binDir, "mutool");
	const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/h2MAAAAASUVORK5CYII=";
	const script = `#!/usr/bin/env node
const fs = require(\"node:fs\");
const command = process.argv[2];
const args = process.argv.slice(3);
if (command === \"info\") {
\tconsole.log(\"Pages: 1\");
\tprocess.exit(0);
}
if (command === \"draw\") {
\tconst outputIndex = args.indexOf(\"-o\");
\tif (outputIndex < 0 || !args[outputIndex + 1]) process.exit(1);
\tconst outputPath = args[outputIndex + 1];
\tconst buffer = Buffer.from(\"${pngBase64}\", \"base64\");
\tfs.writeFileSync(outputPath, buffer);
\tprocess.exit(0);
}
process.exit(1);
`;
	writeFileSync(mutoolPath, script, { mode: 0o700 });
	chmodSync(mutoolPath, 0o700);
	return mutoolPath;
}

function writeFakeCompilerWithSourceCapture(binDir: string, captureFile: string): string {
	const compilerPath = resolve(binDir, "lualatex");
	const capturedFile = JSON.stringify(captureFile);
	const script = `#!/usr/bin/env node
const fs = require(\"node:fs\");
const path = require(\"node:path\");
const source = process.argv[process.argv.length - 1];
if (!source) process.exit(1);
const pdf = path.resolve(process.cwd(), source.replace(/\\.tex$/, \".pdf\"));
fs.writeFileSync(pdf, \"%PDF-1.7\\n\");
const sourceText = fs.readFileSync(source, \"utf8\");
fs.writeFileSync(${capturedFile}, sourceText);
`;
	writeFileSync(compilerPath, script, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

function writeFakeCompilerWithSynctexArtifacts(binDir: string): string {
	const compilerPath = resolve(binDir, "lualatex");
	const script = `#!/usr/bin/env node
const fs = require(\"node:fs\");
const path = require(\"node:path\");
const zlib = require(\"node:zlib\");
const source = process.argv[process.argv.length - 1];
if (!source) process.exit(1);
const pdf = path.resolve(process.cwd(), source.replace(/\\.tex$/, \".pdf\"));
const base = pdf.slice(0, -4);
fs.writeFileSync(pdf, \"%PDF-1.7\\n\");
const synctex = base + ".synctex";
const synctexGz = base + ".synctex.gz";
const synctexContent = "SyncTeX Version:1\\nInput:1:" + pdf + "\\n";
fs.writeFileSync(synctex, synctexContent);
fs.writeFileSync(synctexGz, zlib.gzipSync(synctexContent));
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

type HostServiceOpenRequestRecord = {
	requestId: string;
	details?: Record<string, unknown>;
	errors: string | null;
	reused: boolean;
};

class RecordingFakeViewerBackend extends FakeViewerBackend {
	openRequests: HostServiceOpenRequestRecord[] = [];

	override async open(requestId: string, details: Record<string, unknown>): Promise<{ status: "ok" | "error"; error?: string; status_details: Record<string, unknown> }> {
		const response = await super.open(requestId, details);
		const statusDetails = (response as { status_details?: Record<string, unknown> }).status_details;
		this.openRequests.push({
			requestId,
			details,
			errors: response.status === "error" ? (response.error ?? null) : null,
			reused: Boolean(statusDetails?.reused),
		});
		return response as { status: "ok" | "error"; error?: string; status_details: Record<string, unknown> };
	}
}

class BackendUnavailableFakeViewerBackend extends RecordingFakeViewerBackend {
	override isAvailable(): boolean {
		return false;
	}
}

class ServiceUnavailableFakeViewerBackend extends RecordingFakeViewerBackend {
	override async open(requestId: string, details: Record<string, unknown>): Promise<{ status: "ok" | "error"; error?: string; status_details: Record<string, unknown> }> {
		const response = await super.open(requestId, details);
		if (response.status === "error") {
			return response as { status: "ok" | "error"; error?: string; status_details: Record<string, unknown> };
		}
		return {
			status: "error",
			error: "fake host service managed viewer unavailable",
			status_details: {
				...(response.status_details as Record<string, unknown>),
				error_code: "service_unavailable",
				reason: "fake viewer backend service unavailable",
			},
		};
	}
}

class FakeForwardSearchViewerBackend extends RecordingFakeViewerBackend {
	readonly forwardSearchCalls: Array<Record<string, unknown>> = [];

	override async forwardSearch(_requestId: string, details: Record<string, unknown>): Promise<{ status: "ok" | "error"; error?: string; status_details: Record<string, unknown> }> {
		this.forwardSearchCalls.push({ ...details });
		const handle = typeof details.handle === "string" ? details.handle : undefined;
		const handleOk = typeof handle === "string" && handle.length > 0;
		if (!handleOk) {
			return {
				status: "error",
				error: "missing handle",
				status_details: {
					protocol_version: 1,
					supported: false,
					service_available: true,
					backend: this.name,
					backend_path: this.name,
					handle,
					handled: false,
					error_code: "invalid_request",
					reason: "missing handle",
				},
			};
		}
		return {
			status: "ok",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: this.name,
				backend_path: this.name,
				backend_identity_ok: true,
				handle,
				handled: true,
				reason: "forward search handled",
			},
		};
	}
}

class SidecarValidatingFakeViewerBackend extends FakeForwardSearchViewerBackend {
	override async open(requestId: string, details: Record<string, unknown>): Promise<{ status: "ok" | "error"; error?: string; status_details: Record<string, unknown> }> {
		const response = await super.open(requestId, details);
		if (response.status === "error") {
			return response as { status: "ok" | "error"; error?: string; status_details: Record<string, unknown> };
		}

		const pdfPath = typeof details.pdf_path === "string" ? details.pdf_path : "";
		const base = pdfPath.toLowerCase().endsWith(".pdf") ? pdfPath.slice(0, -4) : pdfPath;
		const hasSidecar = existsSync(`${base}.synctex`) || existsSync(`${base}.synctex.gz`);
		if (!hasSidecar) {
			return {
				status: "error",
				error: "missing SyncTeX sidecar for fixed preview PDF",
				status_details: {
					...(response.status_details as Record<string, unknown>),
					error_code: "invalid_request",
					reason: "missing SyncTeX sidecar",
				},
			};
		}
		return response as { status: "ok" | "error"; error?: string; status_details: Record<string, unknown> };
	}
}

class HangingFakeViewerBackend extends RecordingFakeViewerBackend {
	override async open(): Promise<{ status: "ok" | "error"; status_details: Record<string, unknown> }> {
		return await new Promise(() => undefined);
	}
}

type HostServiceMode = "ok" | "backend_unavailable" | "hang" | "service_unavailable";

async function withHostService(mode: HostServiceMode, fn: (backend: { openRequests: HostServiceOpenRequestRecord[] }) => Promise<void>, backendOverride?: FakeViewerBackend): Promise<void> {
	const serviceDir = mkdtempSync(resolve(tmpdir(), "pdf-preview-host-service-"));
	const socketPath = resolve(serviceDir, "host-service.sock");
	const previousSocketPath = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	const defaultBackend = mode === "backend_unavailable"
		? new BackendUnavailableFakeViewerBackend({ name: "fake-host-backend", capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true } })
		: mode === "hang"
			? new HangingFakeViewerBackend({ name: "fake-host-backend", capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true } })
			: mode === "service_unavailable"
				? new ServiceUnavailableFakeViewerBackend({ name: "fake-host-backend", capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true } })
				: new RecordingFakeViewerBackend({ name: "fake-host-backend", capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true } });
	const backend = backendOverride ?? defaultBackend;
	const hostServiceServer = new HostServiceServer({ socketPath, serviceName: "tex-actions-show-latex", viewerBackend: backend as FakeViewerBackend });
	process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = socketPath;
	await hostServiceServer.start();
	try {
		await fn(backend as { openRequests: HostServiceOpenRequestRecord[] });
	} finally {
		if (previousSocketPath === undefined) {
			delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		} else {
			process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = previousSocketPath;
		}
		await hostServiceServer.stop();
		rmSync(serviceDir, { recursive: true, force: true });
	}
}

type HostServiceClientCallCounters = {
	compileLatexSnippet: number;
	compileLatexFile: number;	rasterizePdf: number;	openPdf: number;	closePdf: number;	jumpPdf: number;	status: number;
};

function withHostServiceClientCallTracing(): { counters: HostServiceClientCallCounters; restore(): void } {
	const proto = HostServiceClient.prototype as {
		requestCompileLatexSnippet: HostServiceClient["requestCompileLatexSnippet"];
		requestCompileLatexFile: HostServiceClient["requestCompileLatexFile"];
		requestRasterizePdf: HostServiceClient["requestRasterizePdf"];
		requestOpenPdf: HostServiceClient["requestOpenPdf"];
		requestClosePdf: HostServiceClient["requestClosePdf"];
		requestJumpPdf: HostServiceClient["requestJumpPdf"];
		requestStatus: HostServiceClient["requestStatus"];
	};
	const counters: HostServiceClientCallCounters = {
		compileLatexSnippet: 0,
		compileLatexFile: 0,
		rasterizePdf: 0,
		openPdf: 0,
		closePdf: 0,
		jumpPdf: 0,
		status: 0,
	};

	const originalCompileLatexSnippet = proto.requestCompileLatexSnippet;
	const originalCompileLatexFile = proto.requestCompileLatexFile;
	const originalRasterize = proto.requestRasterizePdf;
	const originalOpenPdf = proto.requestOpenPdf;
	const originalClosePdf = proto.requestClosePdf;
	const originalJumpPdf = proto.requestJumpPdf;
	const originalStatus = proto.requestStatus;

	proto.requestCompileLatexSnippet = async function (...args) {
		counters.compileLatexSnippet += 1;
		return originalCompileLatexSnippet.apply(this, args);
	};
	proto.requestCompileLatexFile = async function (...args) {
		counters.compileLatexFile += 1;
		return originalCompileLatexFile.apply(this, args);
	};
	proto.requestRasterizePdf = async function (...args) {
		counters.rasterizePdf += 1;
		return originalRasterize.apply(this, args);
	};
	proto.requestOpenPdf = async function (...args) {
		counters.openPdf += 1;
		return originalOpenPdf.apply(this, args);
	};
	proto.requestClosePdf = async function (...args) {
		counters.closePdf += 1;
		return originalClosePdf.apply(this, args);
	};
	proto.requestJumpPdf = async function (...args) {
		counters.jumpPdf += 1;
		return originalJumpPdf.apply(this, args);
	};
	proto.requestStatus = async function (...args) {
		counters.status += 1;
		return originalStatus.apply(this, args);
	};

	return {
		counters,
		restore() {
			proto.requestCompileLatexSnippet = originalCompileLatexSnippet;
			proto.requestCompileLatexFile = originalCompileLatexFile;
			proto.requestRasterizePdf = originalRasterize;
			proto.requestOpenPdf = originalOpenPdf;
			proto.requestClosePdf = originalClosePdf;
			proto.requestJumpPdf = originalJumpPdf;
			proto.requestStatus = originalStatus;
		},
	};
}

test("show_latex external flow opens through host service", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		await withHostService("ok", async (backend) => {
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
			assert.equal(typeof details.pdf_id, "number");
			assert.equal(result.content[0].text, "ok");

			assert.equal(backend.openRequests.length, 1);
			const request = backend.openRequests[0];
			assert.equal(request.errors, null);
			const requestDetailKeys = Object.keys(request.details ?? {});
			assert.equal(requestDetailKeys.includes("callback"), true);
			assert.equal(requestDetailKeys.includes("pdf_path"), true);
			assert.equal(requestDetailKeys.includes("reuse_existing"), true);
			assert.equal(requestDetailKeys.includes("require_persistent_viewer"), true);
			const callback = (request.details as { callback?: { kind?: unknown } } | undefined)?.callback as { kind?: unknown } | undefined;
			assert.equal(callback?.kind, "pi-synctex-callback-v1");
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
		await withHostService("ok", async (backend) => {
			const first = await tool.execute("show-latex-open-first", { source: sourceContent, inline: false }, undefined, undefined, context);
			const second = await tool.execute("show-latex-open-second", { source: sourceContent, inline: false }, undefined, undefined, context);

			const firstDetails = first.details as { pdf_id: number; pdf: string };
			const secondDetails = second.details as { pdf_id: number; pdf: string };
			assert.equal(firstDetails.pdf, secondDetails.pdf);
			assert.equal(typeof firstDetails.pdf_id, "number");
			assert.equal(firstDetails.pdf_id, secondDetails.pdf_id);

			assert.equal(backend.openRequests.length, 2);
			assert.equal(backend.openRequests[0].details?.pdf_path, MCP_FIXED_PREVIEW_PDF_PATH);
			assert.equal(backend.openRequests[1].details?.pdf_path, MCP_FIXED_PREVIEW_PDF_PATH);
			assert.equal(backend.openRequests[1].reused, true);
			assert.equal(backend.openRequests[0].requestId === backend.openRequests[1].requestId, false);
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
		await withHostService("hang", async () => {
			try {
				await tool.execute("show-latex-open-timeout", { source: sourceContent, inline: false }, undefined, undefined, context);
				assert.fail("expected show_latex timeout to throw");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/Host service managed viewer request timed out while opening preview/.test(message), true);
				assert.equal(/code=service_timeout/.test(message), true);
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
		await withHostService("backend_unavailable", async () => {
			try {
				await tool.execute("show-latex-open-backend", { source: sourceContent, inline: false }, undefined, undefined, context);
				assert.fail("expected show_latex open failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/Host service managed viewer backend unavailable while opening preview/.test(message), true);
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
		await withHostService("service_unavailable", async (backend) => {
			try {
				await tool.execute("show-latex-open-service", { source: sourceContent, inline: false }, undefined, undefined, context);
				assert.fail("expected show_latex open failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/Host service managed viewer unavailable while opening preview/.test(message), true);
				assert.equal(/code=service_unavailable/.test(message), true);
				assert.equal(backend.openRequests.length, 1);
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

	try {
		await withHostService("ok", async (backend) => {
			try {
				await tool.execute("show-latex-compile-failure", { source: "\\begin{document}bad\\end{document}", inline: false }, undefined, undefined, context);
				assert.fail("expected show_latex compile failure");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.equal(/LaTeX preview compilation failed/.test(message), true);
				assert.equal(/Host service|viewer backend|managed viewer/.test(message), false);
				assert.equal(backend.openRequests.length, 0);
			}
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external flow supports jump_pdf and close_pdf through host service", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const { showLatex, jumpPdf, closePdf } = await captureTools();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		const backend = new FakeForwardSearchViewerBackend({ name: "fake-host-backend", capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true } });
		await withHostService("ok", async () => {
			const openResult = await showLatex.execute(
				"show-latex-jump-open",
				{ source: sourceContent, inline: false },
				undefined,
				undefined,
				context,
			);
			const openDetails = openResult.details as { pdf_id: number; pdf: string; source?: string };
			assert.equal(openDetails.pdf_id > 0, true);
			assert.equal(typeof openDetails.source, "string");

			const jumpResult = await jumpPdf.execute(
				"show-latex-jump",
				{ pdf_id: openDetails.pdf_id, line: 1, source_file: openDetails.source },
				undefined,
				undefined,
				context,
			);
			const jumpDetails = jumpResult.details as { source_line?: string; pdf: string; source?: string };
			assert.equal(jumpDetails.pdf, openDetails.pdf);
			assert.equal(typeof jumpDetails.source, "string");
			assert.equal(jumpDetails.source?.endsWith("snippet.tex"), true);
			assert.equal(typeof jumpDetails.source_line, "string");
			assert.equal(jumpResult.content[0].text.includes("line 1 contains:"), true);

			const closeResult = await closePdf.execute(
				"show-latex-close",
				{ pdf_id: openDetails.pdf_id },
				undefined,
				undefined,
				context,
			);
			const closeDetails = closeResult.details as { closed: boolean; pdf_id: number };
			assert.equal(closeDetails.pdf_id, openDetails.pdf_id);
			assert.equal(closeDetails.closed, true);
		}, backend);
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external flow copies SyncTeX sidecars to fixed preview path", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompilerWithSynctexArtifacts(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		const backend = new SidecarValidatingFakeViewerBackend({
			name: "fake-host-backend",
			capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
		});
		await withHostService("ok", async () => {
			const result = await tool.execute(
				"show-latex-external-sidecar",
				{ source: sourceContent, inline: false },
				undefined,
				undefined,
				context,
			);
			const openDetails = result.details as { pdf_id: number; pdf: string };
			assert.equal(openDetails.pdf_id > 0, true);
			const fixedBase = MCP_FIXED_PREVIEW_PDF_PATH.endsWith(".pdf")
				? MCP_FIXED_PREVIEW_PDF_PATH.slice(0, -4)
				: MCP_FIXED_PREVIEW_PDF_PATH;
			assert.equal(existsSync(`${fixedBase}.synctex`) || existsSync(`${fixedBase}.synctex.gz`), true);
			assert.equal(backend.openRequests.length, 1);
		}, backend);
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("set_latex_preamble is honored by host-service snippet compilation", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const { showLatex, setLatexPreamble } = await captureTools();
	const capturedSourcePath = resolve(root, "captured-snippet-source.txt");
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompilerWithSourceCapture(binDir, capturedSourcePath);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);

	try {
		const preamble = "\\usepackage{array}";
		await withHostService("ok", async () => {
			const preambleResult = await setLatexPreamble.execute(
				"show-latex-set-preamble",
				{
					latex_preamble: preamble,
				},
				undefined,
				undefined,
				context,
			);
			assert.equal((preambleResult as { details: { preambleLength?: number } }).details?.preambleLength, preamble.length);

			await showLatex.execute(
				"show-latex-inline-preamble",
				{ source: sourceContent, inline: false },
				undefined,
				undefined,
				context,
			);
			const renderedSource = readFileSync(capturedSourcePath, "utf8");
			assert.equal(renderedSource.includes(preamble), true);
		});
	} finally {
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex inline flow routes through host service rasterization", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const originalPath = process.env.PATH ?? "";
	const binDir = resolve(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFakeCompiler(binDir);
	writeFakeMutool(binDir);
	process.env.PATH = `${binDir}:${originalPath}`;
	const context = createSessionContext(root);
	const trace = withHostServiceClientCallTracing();

	try {
		await withHostService("ok", async (backend) => {
			const result = await tool.execute("show-latex-inline", { source: sourceContent, inline: true }, undefined, undefined, context);
			const details = result.details as {
				inline?: boolean;
				inline_previews?: unknown[];
				image_path?: string;
			};
			assert.equal(details.inline, true);
			assert.equal(details.inline_previews?.length, 1);
			assert.equal((details.image_path?.length ?? 0) > 0, true);
			assert.equal(backend.openRequests.length, 0);
		});
		assert.equal(trace.counters.compileLatexSnippet, 1);
		assert.equal(trace.counters.rasterizePdf, 1);
		assert.equal(trace.counters.openPdf, 0);
		assert.equal(trace.counters.compileLatexFile, 0);
	} finally {
		trace.restore();
		await runSessionShutdown(context);
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex inline compile snippet uses extended timeout", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	const fakePdf = "__preview__/snippet.pdf";
	const fakePng = "__preview__/snippet-page-1.png";
	let compileTimeoutMs: number | undefined;
	const proto = HostServiceClient.prototype as {
		requestCompileLatexSnippet: HostServiceClient["requestCompileLatexSnippet"];
		requestRasterizePdf: HostServiceClient["requestRasterizePdf"];
	};
	const originalCompile = proto.requestCompileLatexSnippet;
	const originalRasterize = proto.requestRasterizePdf;
	const fakeSnippetResponse: Awaited<ReturnType<HostServiceClient["requestCompileLatexSnippet"]>> = {
		protocol_version: 1,
		supported: true,
		service_available: true,
		workspace_context: { cwd: process.cwd() },
		request_id: "show-latex-snippet-timeout-test",
		operation: "compile_latex_snippet",
		source: "inline.tex",
		pdf: fakePdf,
		log: "inline.log",
		artifact_paths: [fakePdf],
		clean: false,
		cleaned_artifacts: [],
	};
	const fakeRasterizeResponse: Awaited<ReturnType<HostServiceClient["requestRasterizePdf"]>> = {
		protocol_version: 1,
		supported: true,
		service_available: true,
		workspace_context: { cwd: process.cwd() },
		request_id: "show-latex-rasterize-timeout-test",
		operation: "rasterize",
		pdf_path: fakePdf,
		artifacts: [
			{
				pngPath: fakePng,
				page: 1,
				dpi: 150,
				renderer: "mutool",
				trimmed: false,
				fullPageWidthPx: 320,
				fullPageHeightPx: 240,
				widthPx: 320,
				heightPx: 240,
			},
		],
		artifact_paths: [fakePng],
	};

	try {
		proto.requestCompileLatexSnippet = async (_request, _workspaceContext, _signal, requestTimeoutMs) => {
			compileTimeoutMs = requestTimeoutMs;
			return fakeSnippetResponse;
		};
		proto.requestRasterizePdf = async () => fakeRasterizeResponse;

		const result = await tool.execute("show-latex-inline", { source: sourceContent, inline: true }, undefined, undefined, undefined);
		assert.equal(compileTimeoutMs, HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS);
		const details = result.details as {
			inline?: boolean;
			inline_previews?: unknown[];
			image_path?: string;
		};
		assert.equal(details.inline, true);
		assert.equal(details.inline_previews?.length, 1);
		assert.equal((details.image_path?.length ?? 0) > 0, true);
	} finally {
		proto.requestCompileLatexSnippet = originalCompile;
		proto.requestRasterizePdf = originalRasterize;
		rmSync(root, { recursive: true, force: true });
	}
});

test("show_latex external flow uses compile timeout when open is requested", async () => {
	const { root, sourceContent } = withTemporaryProject();
	const tool = await captureShowLatexTool();
	let compileTimeoutMs: number | undefined;
	const context = createSessionContext(root);
	const proto = HostServiceClient.prototype as {
		requestCompileLatexSnippet: HostServiceClient["requestCompileLatexSnippet"];
	};
	const originalCompile = proto.requestCompileLatexSnippet;
	const fakePdf = resolve(root, "snippet.pdf");
	const fakeSnippetResponse: Awaited<ReturnType<HostServiceClient["requestCompileLatexSnippet"]>> = {
		protocol_version: 1,
		supported: true,
		service_available: true,
		workspace_context: { cwd: root },
		request_id: "show-latex-snippet-open-timeout-test",
		operation: "compile_latex_snippet",
		source: resolve(root, "snippet.tex"),
		pdf: fakePdf,
		log: resolve(root, "snippet.log"),
		artifact_paths: [fakePdf],
		clean: false,
		cleaned_artifacts: [],
		pdf_id: 123,
		managed_record: {
			id: 123,
			pdfPath: fakePdf,
			viewerHandle: "fake-viewer",
			viewerBackend: "fake",
			viewerOwned: true,
			createdAtNs: Date.now() * 1_000_000,
			capabilities: {
				open: true,
				close: true,
				forward_search: false,
				inverse_search: false,
				reuse: true,
			},
		},
	};

	try {
		proto.requestCompileLatexSnippet = async (_request, _workspaceContext, _signal, requestTimeoutMs) => {
			compileTimeoutMs = requestTimeoutMs;
			return fakeSnippetResponse;
		};

		const result = await tool.execute(
			"show-latex-external-timeout-test",
			{ source: sourceContent, inline: false },
			undefined,
			undefined,
			context,
		);
		assert.equal(compileTimeoutMs, HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS);
		const details = result.details as {
			inline?: boolean;
			pdf_id?: number;
		};
		assert.equal(details.inline, false);
		assert.equal(details.pdf_id, 123);
	} finally {
		proto.requestCompileLatexSnippet = originalCompile;
		await runSessionShutdown(context);
		rmSync(root, { recursive: true, force: true });
	}
});

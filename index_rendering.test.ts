import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as ts from "typescript";
import {
	createTerminalRefreshPolicy,
	type TerminalInputResult,
	type TerminalRefreshPolicyAdapter,
	type TerminalRefreshPolicyEvent,
	type TerminalRefreshInvalidationRegistry,
} from "./terminal_refresh_policy.ts";
import { KittyPreviewInvalidationRegistry } from "./kitty_placeholder_image.ts";
import { INLINE_PREVIEW_DIR } from "./inline_preview.ts";

const FOCUS_IN_SEQUENCE = "\x1b[I";
const FOCUS_OUT_SEQUENCE = "\x1b[O";

class FakeSignalBus {
	private handlers = {
		SIGWINCH: new Set<() => void>(),
		SIGUSR1: new Set<() => void>(),
	};

	emit(signal: "SIGWINCH" | "SIGUSR1"): void {
		for (const handler of [...this.handlers[signal]]) {
			handler();
		}
	}

	on(signal: "SIGWINCH" | "SIGUSR1", handler: () => void): () => void {
		this.handlers[signal].add(handler);
		return () => this.handlers[signal].delete(handler);
	}
}

class FakeTerminalInput {
	private handler: ((data: string) => TerminalInputResult | undefined) | undefined;

	setHandler(handler: (data: string) => TerminalInputResult | undefined): () => void {
		this.handler = handler;
		return () => {
			this.handler = undefined;
		};
	}

	simulate(data: string): TerminalInputResult | undefined {
		if (!this.handler) return undefined;
		return this.handler(data);
	}

	isActive(): boolean {
		return this.handler !== undefined;
	}
}

class FakeAdapter implements TerminalRefreshPolicyAdapter {
	public tmuxHooks: string[][] = [];
	public outputWrites: string[] = [];
	readonly signalBus = new FakeSignalBus();
	private readonly terminalEnabled: boolean;

	constructor(terminalEnabled: boolean) {
		this.terminalEnabled = terminalEnabled;
	}

	isTmuxKittyTerminal(): boolean {
		return this.terminalEnabled;
	}

	runTmux(args: string[]): void {
		this.tmuxHooks.push(args);
	}

	writeOutput(sequence: string): void {
		this.outputWrites.push(sequence);
	}

	onSignal(signal: "SIGWINCH" | "SIGUSR1", listener: () => void): () => void {
		return this.signalBus.on(signal, listener);
	}
}

class FakeInvalidationRegistry implements TerminalRefreshInvalidationRegistry {
	public rememberCalls: Array<{ key: string; count: number; context: string }> = [];
	public refreshCount = 0;
	public invalidatorCalls: string[] = [];
	public clearCount = 0;
	private invalidators = new Map<string, { invalidate: () => void; context: string }>();

	remember(key: string, invalidate: () => void, context = ""): void {
		this.rememberCalls.push({ key, count: this.invalidators.size + 1, context });
		this.invalidators.set(key, { invalidate, context });
	}

	refresh(): void {
		this.refreshCount++;
		for (const [key, entry] of this.invalidators) {
			entry.invalidate();
			this.invalidatorCalls.push(key);
		}
	}

	clear(): void {
		this.invalidators.clear();
		this.clearCount++;
	}

	snapshot(): readonly { key: string; context: string }[] {
		return [...this.invalidators.entries()].map(([key, entry]) => ({ key, context: entry.context }));
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getInputProcessedEvent(eventLog: TerminalRefreshPolicyEvent[]): TerminalRefreshPolicyEvent | undefined {
	return eventLog.find((entry) => entry.type === "input_processed");
}

function getInvalidationCallEvent(eventLog: TerminalRefreshPolicyEvent[]): TerminalRefreshPolicyEvent | undefined {
	return eventLog.find((entry) => entry.type === "invalidation_called");
}

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

let runtimeModulesInstalled = false;
let runtimeModulesRoot: string | undefined;

type CompiledShowLatexApi = {
	registerTool: (tool: { name: string; [key: string]: unknown }) => void;
	registerCommand: () => void;
	on: () => void;
};

type CompiledShowLatexModule = {
	default: (api: CompiledShowLatexApi) => void;
};

let compiledIndexModule: Promise<CompiledShowLatexModule> | undefined;

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

function compiledIndexModulePath(): string {
	if (!runtimeModulesRoot) throw new Error("runtime stubs must be installed before compiling index.ts");
	return resolve(runtimeModulesRoot, "index.mjs");
}

function rewriteProjectRelativeImportsForTempModule(outputText: string): string {
	return outputText.replace(/(from\s+["'])(\.\/[^"']+\.ts)(["'])/g, (_match, prefix: string, specifier: string, suffix: string) => {
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

async function captureShowLatexTool(): Promise<{ renderResult: Function }> {
	const extensionModule = await loadCompiledShowLatexModule();

	let capturedTool: { renderResult: Function } | undefined;
	extensionModule.default({
		registerTool(tool: { name: string; [key: string]: unknown }) {
			if (tool.name === "show_latex") {
				capturedTool = tool as unknown as { renderResult: Function };
			}
		},
		registerCommand() {},
		on() {},
	});

	if (!capturedTool) {
		throw new Error("show_latex tool not registered by extension module");
	}

	return capturedTool;
}

function createTemporaryPngFile(label: string): string {
	mkdirSync(INLINE_PREVIEW_DIR, { recursive: true });
	const safeLabel = label.trim() ? label : randomUUID();
	const pngPath = resolve(INLINE_PREVIEW_DIR, `${safeLabel}.png`);
	writeFileSync(pngPath, `fake-png-${safeLabel}`);
	return pngPath;
}

function inlinePreviewArtifactMetadata(pngPath: string) {
	return {
		pngPath,
		fullPageWidthPx: 80,
		fullPageHeightPx: 40,
		widthPx: 40,
		heightPx: 20,
	};
}

function flattenRenderedComponent(component: { render: (width: number) => string[] }): string[] {
	return component.render(90);
}

test("focus-in scheduling triggers delayed invalidations and preserves non-focus input", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const terminalInput = new FakeTerminalInput();
	const eventLog: TerminalRefreshPolicyEvent[] = [];
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
		refreshDelayMs: [10, 20],
		eventLog: (event) => eventLog.push(event),
	});

	const context = {
		hasUI: true,
		ui: {
			onTerminalInput: terminalInput.setHandler.bind(terminalInput),
		},
	};
	policy.install(context);

	const result = terminalInput.simulate(`before${FOCUS_IN_SEQUENCE}live`);
	assert.deepEqual(result, { data: "beforelive" });

	policy.rememberInvalidator({ toolCallId: "tool-1", invalidate: () => registry.invalidatorCalls.push("refresh") });

	const scheduled = eventLog.filter((entry) => entry.type === "refresh_scheduled");
	assert.equal(scheduled.length, 2);
	assert.equal((scheduled[0] as { type: "refresh_scheduled"; delayMs: number }).delayMs, 10);
	assert.equal((scheduled[1] as { type: "refresh_scheduled"; delayMs: number }).delayMs, 20);

	await sleep(35);

	assert.equal(registry.refreshCount, 2);
	assert.equal(registry.invalidatorCalls.filter((entry) => entry === "refresh").length, 2);
	const invalidationCalled = getInvalidationCallEvent(eventLog);
	assert.equal((invalidationCalled as { type: "invalidation_called"; count: number }).count, 1);
	const inputProcessed = getInputProcessedEvent(eventLog);
	assert.equal(inputProcessed?.type, "input_processed");
	assert.equal((inputProcessed as { type: "input_processed"; hadFocusIn: boolean; hadFocusOut: boolean; consumed: boolean; remainingLength: number }).hadFocusIn, true);
	assert.equal((inputProcessed as { type: "input_processed"; hadFocusIn: boolean; hadFocusOut: boolean; consumed: boolean; remainingLength: number }).hadFocusOut, false);
	assert.equal((inputProcessed as { type: "input_processed"; hadFocusIn: boolean; hadFocusOut: boolean; consumed: boolean; remainingLength: number }).consumed, false);
	assert.equal((inputProcessed as { type: "input_processed"; hadFocusIn: boolean; hadFocusOut: boolean; consumed: boolean; remainingLength: number }).remainingLength, "beforelive".length);

	policy.cleanup();
});

test("focus-out strips markers, preserves surrounding bytes", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const terminalInput = new FakeTerminalInput();
	const eventLog: TerminalRefreshPolicyEvent[] = [];
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
		eventLog: (event) => eventLog.push(event),
	});

	policy.install({
		hasUI: true,
		ui: {
			onTerminalInput: terminalInput.setHandler.bind(terminalInput),
		},
	});

	const result = terminalInput.simulate(`before${FOCUS_OUT_SEQUENCE}after`);
	assert.deepEqual(result, { data: "beforeafter" });

	await sleep(5);
	assert.equal(eventLog.some((entry) => entry.type === "refresh_scheduled"), false);
	assert.equal(registry.refreshCount, 0);

	const inputProcessed = getInputProcessedEvent(eventLog);
	assert.equal(inputProcessed?.type, "input_processed");
	assert.equal((inputProcessed as { type: "input_processed"; consumed: boolean; remainingLength: number }).consumed, false);
	assert.equal((inputProcessed as { type: "input_processed"; consumed: boolean; remainingLength: number }).remainingLength, "beforeafter".length);

	policy.cleanup();
});

test("cleanup clears timers, disables focus reporting, and removes tmux hooks", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const terminalInput = new FakeTerminalInput();
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
		refreshDelayMs: [50, 100],
	});

	policy.install({
		hasUI: true,
		ui: {
			onTerminalInput: terminalInput.setHandler.bind(terminalInput),
		},
	});

	terminalInput.simulate(`x${FOCUS_IN_SEQUENCE}y`);
	await sleep(10);
	policy.cleanup();

	adapter.signalBus.emit("SIGWINCH");
	await sleep(20);
	assert.equal(registry.refreshCount, 0);
	assert.equal(terminalInput.isActive(), false);
	assert.equal(adapter.outputWrites.includes("\x1b[?1004h"), true);
	assert.equal(adapter.outputWrites.includes("\x1b[?1004l"), true);

	const hookSetCommands = adapter.tmuxHooks.filter((entry) => entry[0] === "set-hook" && entry[1] === "-p");
	assert.equal(hookSetCommands.length, 2);
	const hookUnsetCommands = adapter.tmuxHooks.filter((entry) => entry[0] === "set-hook" && entry[1] === "-up");
	assert.equal(hookUnsetCommands.length, 2);
});

test("tmux hooks are installed and removed with process-specific names", () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
	});

	policy.install({ hasUI: false });
	const expectedPrefix = `pi-pdf-preview-${process.pid}`;
	assert.equal(adapter.tmuxHooks.some((entry) => entry[0] === "set-hook" && entry[1] === "-p" && entry[2].includes(expectedPrefix)), true);
	assert.equal(adapter.tmuxHooks.some((entry) => entry[0] === "set-hook" && entry[1] === "-p" && entry[2].includes("pane-focus-in")), true);
	assert.equal(adapter.tmuxHooks.some((entry) => entry[0] === "set-hook" && entry[1] === "-p" && entry[2].includes("window-layout-changed")), true);

	policy.cleanup();
	assert.equal(adapter.tmuxHooks.some((entry) => entry[0] === "set-hook" && entry[1] === "-up" && entry[2].includes(expectedPrefix)), true);
});


test("non-terminal mode skips hook installation and focus registration", () => {
	const adapter = new FakeAdapter(false);
	const registry = new FakeInvalidationRegistry();
	const terminalInput = new FakeTerminalInput();
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
	});

	policy.install({
		hasUI: true,
		ui: {
			onTerminalInput: terminalInput.setHandler.bind(terminalInput),
		},
	});

	assert.equal(adapter.tmuxHooks.length, 0);
	assert.equal(adapter.outputWrites.length, 0);
	terminalInput.simulate(`x${FOCUS_IN_SEQUENCE}y`);
	assert.equal(terminalInput.isActive(), false, "input handler is not registered outside tmux/kitty terminals");
});

test("focus and signal events drive refresh through fake adapters", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
	});
	const invalidations: string[] = [];
	policy.install({ hasUI: false });
	policy.rememberInvalidator({ toolCallId: "manual", invalidate: () => invalidations.push("manual") });

	adapter.signalBus.emit("SIGUSR1");
	await sleep(0);
	assert.equal(registry.refreshCount, 1);
	assert.deepEqual(invalidations, ["manual"]);

	policy.cleanup();
});


test("invalidation registration logs key context metadata", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const eventLog: TerminalRefreshPolicyEvent[] = [];
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
		eventLog: (event) => eventLog.push(event),
	});

	policy.rememberInvalidator({ toolCallId: "tool-inline", invalidate: () => {} });
	const registration = eventLog.find((event) => event.type === "invalidation_registered") as {
		type: "invalidation_registered";
		key: string;
		context: string;
	} | undefined;
	assert.equal(registration?.type, "invalidation_registered");
	assert.equal(registration?.key, "tool-inline");
	assert.equal(registration?.context, "tool-inline");

	policy.install({ hasUI: false });
	adapter.signalBus.emit("SIGWINCH");
	await sleep(0);
	const invalidationCalled = getInvalidationCallEvent(eventLog);
	assert.equal(invalidationCalled?.type, "invalidation_called");
	assert.equal((invalidationCalled as { type: "invalidation_called"; count: number }).count, 1);
	assert.deepEqual((invalidationCalled as { type: "invalidation_called"; keys: string[] }).keys, ["tool-inline"]);

	policy.cleanup();
});

test("show_latex renderResult chooses tmux/kitty rendering before generic capability fallback", async () => {
	const previousEnv = {
		TMUX: process.env.TMUX,
		KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
		TERM_PROGRAM: process.env.TERM_PROGRAM,
	};
	const tool = await captureShowLatexTool();
	process.env.TMUX = "1";
	process.env.KITTY_WINDOW_ID = "tmux";
	process.env.TERM_PROGRAM = "kitty";

	try {
		const pngPaths = [createTemporaryPngFile("tmux-preview-1"), createTemporaryPngFile("tmux-preview-2")];
		const toolResult = {
			details: {
				inline_previews: pngPaths.map((pngPath) => inlinePreviewArtifactMetadata(pngPath)),
				pdf: "/tmp/fake-preview.pdf",
			},
		};
		const component = tool.renderResult(toolResult, undefined, {}, {
			toolCallId: "tmux-preview",
			invalidate: () => {},
		});
		const lines = flattenRenderedComponent(component);
		const output = lines.join("\n");

		assert.equal(lines.filter((line) => line.includes("\u2713 LaTeX preview")).length, 1);
		assert.equal(output.includes("Inline image display is not supported by this terminal."), false);
		assert.match(output, /\u001bPtmux;/);
	} finally {
		if (previousEnv.TMUX === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = previousEnv.TMUX;
		}
		if (previousEnv.KITTY_WINDOW_ID === undefined) {
			delete process.env.KITTY_WINDOW_ID;
		} else {
			process.env.KITTY_WINDOW_ID = previousEnv.KITTY_WINDOW_ID;
		}
		if (previousEnv.TERM_PROGRAM === undefined) {
			delete process.env.TERM_PROGRAM;
		} else {
			process.env.TERM_PROGRAM = previousEnv.TERM_PROGRAM;
		}
	}
});

test("invalidation diagnostics follow capped registry key set after overflow", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new KittyPreviewInvalidationRegistry(2);
	const eventLog: TerminalRefreshPolicyEvent[] = [];
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
		eventLog: (event) => eventLog.push(event),
	});

	policy.install({ hasUI: false });
	policy.rememberInvalidator({ toolCallId: "tool-a", invalidate: () => {} });
	policy.rememberInvalidator({ toolCallId: "tool-b", invalidate: () => {} });
	policy.rememberInvalidator({ toolCallId: "tool-c", invalidate: () => {} });

	adapter.signalBus.emit("SIGUSR1");
	await sleep(0);

	const invalidationCalled = getInvalidationCallEvent(eventLog);
	assert.equal(invalidationCalled?.type, "invalidation_called");
	const payload = invalidationCalled as { type: "invalidation_called"; count: number; keys: string[]; contextTypes: string[] };
	const expectedKeys = registry.snapshot().map((entry) => entry.key);
	assert.deepEqual(payload.keys, expectedKeys);
	assert.equal(payload.count, expectedKeys.length);
	assert.equal(payload.count, registry.size);
	assert.equal(registry.size, 2);

	policy.cleanup();
});

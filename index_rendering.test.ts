import test from "node:test";
import assert from "node:assert/strict";
import {
	TERMINAL_FOCUS_IN,
	TERMINAL_FOCUS_OUT,
	createTerminalRefreshPolicy,
	type TerminalInputResult,
	type TerminalRefreshPolicyAdapter,
	type TerminalRefreshInvalidationRegistry,
} from "./terminal_refresh_policy.ts";

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
	public rememberCalls: string[] = [];
	public refreshCount = 0;
	public invalidatorCalls: string[] = [];
	public clearCount = 0;
	private invalidators = new Map<string, () => void>();

	remember(key: string, invalidate: () => void): void {
		this.rememberCalls.push(key);
		this.invalidators.set(key, invalidate);
	}

	refresh(): void {
		this.refreshCount++;
		for (const [key, invalidate] of this.invalidators) {
			invalidate();
			this.invalidatorCalls.push(key);
		}
	}

	clear(): void {
		this.invalidators.clear();
		this.clearCount++;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("focus-in scheduling triggers delayed invalidations and preserves non-focus input", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const terminalInput = new FakeTerminalInput();
	const eventLog: Array<{ type: string; [key: string]: unknown }> = [];
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

	const result = terminalInput.simulate(`before${TERMINAL_FOCUS_IN}live`);
	assert.deepEqual(result, { data: "beforelive" });

	policy.rememberInvalidator({ toolCallId: "tool-1", invalidate: () => registry.invalidatorCalls.push("refresh") });

	const scheduled = eventLog.filter((entry) => entry.type === "refresh_scheduled");
	assert.equal(scheduled.length, 2);
	assert.equal(scheduled[0].delayMs, 10);
	assert.equal(scheduled[1].delayMs, 20);

	await sleep(35);

	assert.equal(registry.refreshCount, 2);
	assert.equal(registry.invalidatorCalls.filter((entry) => entry === "tool-1").length, 2);
	assert.equal(eventLog.filter((entry) => entry.type === "invalidation_called").length, 2);
	assert.deepEqual(eventLog.find((entry) => entry.type === "input_processed")?.hasFocusIn, true);
	assert.deepEqual(eventLog.find((entry) => entry.type === "input_processed")?.hasFocusOut, false);

	policy.cleanup();
});

test("focus-out strips markers, preserves surrounding bytes", async () => {
	const adapter = new FakeAdapter(true);
	const registry = new FakeInvalidationRegistry();
	const terminalInput = new FakeTerminalInput();
	const eventLog: Array<{ type: string; [key: string]: unknown }> = [];
	const policy = createTerminalRefreshPolicy({
		adapter,
		invalidatorRegistry: registry,
		refreshDelayMs: [1, 2],
		eventLog: (event) => eventLog.push(event),
	});

	policy.install({
		hasUI: true,
		ui: {
			onTerminalInput: terminalInput.setHandler.bind(terminalInput),
		},
	});

	const result = terminalInput.simulate(`before${TERMINAL_FOCUS_OUT}after`);
	assert.deepEqual(result, { data: "beforeafter" });

	await sleep(5);
	assert.equal(eventLog.some((entry) => entry.type === "refresh_scheduled"), false);
	assert.equal(registry.refreshCount, 0);

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

	terminalInput.simulate(`x${TERMINAL_FOCUS_IN}y`);
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
	terminalInput.simulate(`x${TERMINAL_FOCUS_IN}y`);
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

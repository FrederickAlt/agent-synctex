import { randomUUID } from "node:crypto";


const FOCUS_IN_SEQUENCE = "\x1b[I";
const FOCUS_OUT_SEQUENCE = "\x1b[O";
const FOCUS_REPORT_ENABLE = "\x1b[?1004h";
const FOCUS_REPORT_DISABLE = "\x1b[?1004l";
const DEFAULT_REFRESH_DELAYS: readonly [number, number] = [50, 200];
const FOCUS_WARNING_TEXT = "pdf-preview: terminal focus refresh unavailable; ctx.ui.onTerminalInput is missing";

export interface TerminalInputResult {
	consume?: boolean;
	data?: string;
}

export interface TerminalRefreshPolicyAdapter {
	isTmuxKittyTerminal(): boolean;
	runTmux(args: string[]): void;
	writeOutput(sequence: string): void;
	onSignal(signal: "SIGWINCH" | "SIGUSR1", listener: () => void): () => void;
}

export interface TerminalRefreshPolicyContext {
	hasUI: boolean;
	ui?: {
		onTerminalInput?: (handler: (data: string) => TerminalInputResult | undefined) => () => void;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

export interface TerminalRefreshInvalidationRegistry {
	remember(key: string, invalidate: () => void, context?: string): void;
	refresh(): void;
	clear(): void;
	snapshot(): readonly { key: string; context: string }[];
}

export type TerminalRefreshPolicyEvent =
	| { type: "refresh_scheduled"; delayMs: number }
	| { type: "input_processed"; hadFocusIn: boolean; hadFocusOut: boolean; consumed: boolean; remainingLength: number }
	| { type: "invalidation_registered"; key: string; context: string }
	| { type: "invalidation_called"; count: number; keys: string[]; contextTypes: string[] };

export interface TerminalRefreshPolicy {
	install(context?: TerminalRefreshPolicyContext): void;
	cleanup(): void;
	rememberInvalidator(context: unknown): void;
	clearInvalidators(): void;
}

export interface TerminalRefreshPolicyOptions {
	adapter: TerminalRefreshPolicyAdapter;
	invalidatorRegistry: TerminalRefreshInvalidationRegistry;
	refreshDelayMs?: readonly [number, number];
	eventLog?: (event: TerminalRefreshPolicyEvent) => void;
}

function stripAll(text: string, search: string): string {
	return text.split(search).join("");
}

function mkHookName(base: string): string {
	return `${base}[pi-pdf-preview-${process.pid}]`;
}

function stripFocusInput(data: string): string {
	return stripAll(stripAll(data, FOCUS_IN_SEQUENCE), FOCUS_OUT_SEQUENCE);
}

function describeInvalidatorContext(context: unknown): string {
	if (!context || typeof context !== "object") return "inline-preview";
	const candidate = context as { toolCallId?: unknown };
	if (typeof candidate.toolCallId === "string" && candidate.toolCallId.trim()) {
		return candidate.toolCallId;
	}
	return context.constructor?.name ?? "object";
}

export function createTerminalRefreshPolicy(options: TerminalRefreshPolicyOptions): TerminalRefreshPolicy {
	const {
		adapter,
		invalidatorRegistry,
		refreshDelayMs = DEFAULT_REFRESH_DELAYS,
		eventLog,
	} = options;

	const timers = new Set<ReturnType<typeof setTimeout>>();
	const cleanupTasks: Array<() => void> = [];
	let focusInputUnsubscribe: (() => void) | undefined;
	let installed = false;
	let focusReportingEnabled = false;

	const emit = (event: TerminalRefreshPolicyEvent): void => {
		eventLog?.(event);
	};

	const clearTimers = () => {
		for (const timer of timers) {
			clearTimeout(timer);
		}
		timers.clear();
	};

	const runInvalidators = () => {
		const activeInvalidators = invalidatorRegistry.snapshot();
		const keys = activeInvalidators.map((entry) => entry.key);
		const contextTypes = activeInvalidators.map((entry) => entry.context);
		emit({ type: "invalidation_called", count: keys.length, keys, contextTypes });
		invalidatorRegistry.refresh();
	};

	const scheduleRefresh = (delayMs: number) => {
		emit({ type: "refresh_scheduled", delayMs });
		const timer = setTimeout(() => {
			timers.delete(timer);
			runInvalidators();
		}, delayMs);
		timers.add(timer);
	};

	const onTerminalInput = (data: string): TerminalInputResult | undefined => {
		const sawFocusIn = data.includes(FOCUS_IN_SEQUENCE);
		const sawFocusOut = data.includes(FOCUS_OUT_SEQUENCE);
		if (!sawFocusIn && !sawFocusOut) return undefined;

		if (sawFocusIn) {
			for (const delayMs of refreshDelayMs) {
				scheduleRefresh(delayMs);
			}
		}

		const remaining = stripFocusInput(data);
		const remainingLength = remaining.length;
		emit({ type: "input_processed", hadFocusIn: sawFocusIn, hadFocusOut: sawFocusOut, consumed: remainingLength === 0, remainingLength });
		return remainingLength > 0 ? { data: remaining } : { consume: true };
	};

	const installTerminalHooks = () => {
		const refreshSignal = `run-shell -b "kill -USR1 ${process.pid} 2>/dev/null || true"`;
		adapter.runTmux(["set-hook", "-p", mkHookName("pane-focus-in"), refreshSignal]);
		adapter.runTmux(["set-hook", "-p", mkHookName("window-layout-changed"), refreshSignal]);

		cleanupTasks.push(() => {
			adapter.runTmux(["set-hook", "-up", mkHookName("pane-focus-in")]);
			adapter.runTmux(["set-hook", "-up", mkHookName("window-layout-changed")]);
		});
	};

	return {
		install(context) {
			if (installed || !adapter.isTmuxKittyTerminal()) return;
			installed = true;
			installTerminalHooks();

			cleanupTasks.push(adapter.onSignal("SIGWINCH", () => runInvalidators()));
			cleanupTasks.push(adapter.onSignal("SIGUSR1", () => runInvalidators()));

			if (!context?.hasUI || !context.ui) return;
			if (typeof context.ui.onTerminalInput !== "function") {
				context.ui.notify?.(FOCUS_WARNING_TEXT, "warning");
				return;
			}

			focusReportingEnabled = true;
			adapter.writeOutput(FOCUS_REPORT_ENABLE);
			focusInputUnsubscribe = context.ui.onTerminalInput(onTerminalInput);
			cleanupTasks.push(() => {
				focusInputUnsubscribe?.();
				focusInputUnsubscribe = undefined;
			});
			cleanupTasks.push(() => {
				if (focusReportingEnabled) {
					adapter.writeOutput(FOCUS_REPORT_DISABLE);
					focusReportingEnabled = false;
				}
			});
		},
		cleanup() {
			for (const cleanup of cleanupTasks.splice(0, cleanupTasks.length)) {
				cleanup();
			}
			clearTimers();
			installed = false;
			focusReportingEnabled = false;
		},
		rememberInvalidator(context: unknown) {
			if (!adapter.isTmuxKittyTerminal() || typeof context !== "object" || context === null) return;
			const candidate = context as { toolCallId?: unknown; invalidate?: unknown };
			if (typeof candidate.invalidate !== "function") return;
			const invalidate = candidate.invalidate as () => void;
			const key = typeof candidate.toolCallId === "string" ? candidate.toolCallId : randomUUID();
			const contextValue = describeInvalidatorContext(context);
			eventLog?.({ type: "invalidation_registered", key, context: contextValue });
			invalidatorRegistry.remember(key, invalidate, contextValue);
		},
		clearInvalidators() {
			invalidatorRegistry.clear();
		},
	};
}

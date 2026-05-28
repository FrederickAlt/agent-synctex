import { randomUUID } from "node:crypto";

export const TERMINAL_FOCUS_IN = "\x1b[I";
export const TERMINAL_FOCUS_OUT = "\x1b[O";

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
	remember(key: string, invalidate: () => void): void;
	refresh(): void;
	clear(): void;
}

export type TerminalRefreshPolicyEvent =
	| { type: "refresh_scheduled"; delayMs: number }
	| { type: "input_processed"; hasFocusIn: boolean; hasFocusOut: boolean; remaining: string; original: string }
	| { type: "invalidation_called" };

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
	focusInSequence?: string;
	focusOutSequence?: string;
	focusReportEnable?: string;
	focusReportDisable?: string;
	eventLog?: (event: TerminalRefreshPolicyEvent) => void;
}

const DEFAULT_REFRESH_DELAYS: readonly [number, number] = [50, 200];
const FOCUS_REPORT_ENABLE = "\x1b[?1004h";
const FOCUS_REPORT_DISABLE = "\x1b[?1004l";
const FOCUS_WARNING_TEXT = "pdf-preview: terminal focus refresh unavailable; ctx.ui.onTerminalInput is missing";

function stripAll(text: string, search: string): string {
	return text.split(search).join("");
}

function mkHookName(base: string): string {
	return `${base}[pi-pdf-preview-${process.pid}]`;
}

function stripFocusInput(data: string, focusInSequence: string, focusOutSequence: string): string {
	return stripAll(stripAll(data, focusInSequence), focusOutSequence);
}

export function createTerminalRefreshPolicy(options: TerminalRefreshPolicyOptions): TerminalRefreshPolicy {
	const {
		adapter,
		invalidatorRegistry,
		refreshDelayMs = DEFAULT_REFRESH_DELAYS,
		focusInSequence = TERMINAL_FOCUS_IN,
		focusOutSequence = TERMINAL_FOCUS_OUT,
		focusReportEnable = FOCUS_REPORT_ENABLE,
		focusReportDisable = FOCUS_REPORT_DISABLE,
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
		invalidatorRegistry.refresh();
		emit({ type: "invalidation_called" });
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
		const sawFocusIn = data.includes(focusInSequence);
		const sawFocusOut = data.includes(focusOutSequence);
		if (!sawFocusIn && !sawFocusOut) return undefined;

		if (sawFocusIn) {
			for (const delayMs of refreshDelayMs) {
				scheduleRefresh(delayMs);
			}
		}

		const remaining = stripFocusInput(data, focusInSequence, focusOutSequence);
		emit({ type: "input_processed", hasFocusIn: sawFocusIn, hasFocusOut: sawFocusOut, remaining, original: data });
		return remaining.length > 0 ? { data: remaining } : { consume: true };
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
			adapter.writeOutput(focusReportEnable);
			focusInputUnsubscribe = context.ui.onTerminalInput(onTerminalInput);
			cleanupTasks.push(() => {
				focusInputUnsubscribe?.();
				focusInputUnsubscribe = undefined;
			});
			cleanupTasks.push(() => {
				if (focusReportingEnabled) {
					adapter.writeOutput(focusReportDisable);
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
			invalidatorRegistry.remember(key, () => invalidate());
		},
		clearInvalidators() {
			invalidatorRegistry.clear();
		},
	};
}

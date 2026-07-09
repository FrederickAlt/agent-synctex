declare module "@mariozechner/pi-coding-agent" {
	export type ToolResponseContent =
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string };

	export interface ToolResponse {
		content: ToolResponseContent[];
		details?: Record<string, unknown>;
	}

	export interface ExtensionUIContext {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
		pasteToEditor(text: string): void;
		setEditorText(text: string): void;
		getEditorText(): string;
	}

	export interface ExtensionContext {
		ui: ExtensionUIContext;
		hasUI: boolean;
		cwd: string;
		isIdle(): boolean;
		signal: AbortSignal | undefined;
	}

	export interface ToolDefinition {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		renderShell?: "default" | "self";
		renderCall?: (...args: any[]) => any;
		renderResult?: (...args: any[]) => any;
		parameters: unknown;
		prepareArguments?: (args: unknown) => Record<string, unknown>;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: ExtensionContext,
		): ToolResponse | Promise<ToolResponse>;
	}

	export interface RegisteredCommandOptions {
		description?: string;
		getArgumentCompletions?: (argumentPrefix: string) => unknown[] | null | Promise<unknown[] | null>;
		handler(args: string, ctx: ExtensionContext): Promise<void> | void;
	}

	export interface SessionStartEvent {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	}

	export interface SessionShutdownEvent {
		type: "session_shutdown";
		reason?: "quit" | "reload" | "new" | "resume" | "fork";
		targetSessionFile?: string;
	}

	export interface ExtensionAPI {
		registerTool(tool: ToolDefinition): void;
		registerCommand(name: string, options: RegisteredCommandOptions): void;
		on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown): void;
		on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => unknown): void;
	}
}

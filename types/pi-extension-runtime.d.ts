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

declare module "@mariozechner/pi-tui" {
	export interface Component {
		render(width: number): string[];
		invalidate(): void;
	}

	export class Text implements Component {
		constructor(text: string, paddingX?: number, paddingY?: number, bgFn?: (s: string) => string);
		setText(text: string): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export class Container implements Component {
		addChild(child: Component): void;
		removeChild(child: Component): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export interface ImageDimensions {
		widthPx: number;
		heightPx: number;
	}

	export interface CellDimensions {
		widthPx: number;
		heightPx: number;
	}

	export function getCapabilities(): { images: "kitty" | "iterm2" | null; trueColor: boolean; hyperlinks: boolean };
	export function getCellDimensions(): CellDimensions;
	export function getPngDimensions(base64Data: string): ImageDimensions | null;
	export function calculateImageRows(imageDimensions: ImageDimensions, targetWidthCells: number, cellDimensions?: CellDimensions): number;

	export class Image implements Component {
		constructor(
			base64Data: string,
			mimeType: string,
			theme: { fallbackColor: (s: string) => string },
			options?: { maxWidthCells?: number; maxHeightCells?: number; filename?: string; imageId?: number },
		);
		render(width: number): string[];
		invalidate(): void;
	}
}

declare module "typebox" {
	export const Type: {
		Optional(schema: unknown, options?: Record<string, unknown>): unknown;
		Union(schemas: unknown[], options?: Record<string, unknown>): unknown;
		Literal(value: unknown, options?: Record<string, unknown>): unknown;
		Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
		String(options?: Record<string, unknown>): unknown;
		Number(options?: Record<string, unknown>): unknown;
		Boolean(options?: Record<string, unknown>): unknown;
	};
}

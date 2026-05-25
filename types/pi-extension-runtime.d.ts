declare module "@mariozechner/pi-coding-agent" {
	export interface ToolResponseContent {
		type: "text";
		text: string;
	}

	export interface ToolResponse {
		content: ToolResponseContent[];
		details?: Record<string, unknown>;
	}

	export interface ToolDefinition {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): ToolResponse | Promise<ToolResponse>;
	}

	export interface ExtensionAPI {
		registerTool(tool: ToolDefinition): void;
		on(event: "session_shutdown", handler: () => unknown): void;
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

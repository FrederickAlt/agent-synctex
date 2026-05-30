import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResponse } from "@mariozechner/pi-coding-agent";

export type TracerToolExecutor = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: ExtensionContext | undefined,
) => Promise<ToolResponse>;

export interface UniversalToolFacade {
	execute(
		toolName: string,
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext | undefined,
	): Promise<ToolResponse>;
}

export function createUniversalToolFacade(handlers: Record<string, TracerToolExecutor>): UniversalToolFacade {
	return {
		execute(toolName, toolCallId, params, signal, onUpdate, ctx) {
			const handler = handlers[toolName];
			if (!handler) {
				return Promise.reject(new Error(`No tracer handler registered for tool: ${toolName}`));
			}

			return handler(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

export type TracerToolDefinition = Omit<ToolDefinition, "execute">;

export function registerTracerTools(
	pi: ExtensionAPI,
	facade: UniversalToolFacade,
	tools: readonly TracerToolDefinition[],
): void {
	for (const tool of tools) {
		pi.registerTool({
			...tool,
			execute(toolCallId, params, signal, onUpdate, ctx) {
				return facade.execute(tool.name, toolCallId, params, signal, onUpdate, ctx);
			},
		});
	}
}

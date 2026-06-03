import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const contextUiIds = new WeakMap<object, string>();
let nextContextUiId = 1;

export function contextSessionKey(ctx?: ExtensionContext): string {
	if (!ctx) {
		throw new Error("Context key is only available inside a Pi agent session");
	}

	const ui = ctx.ui as object;
	let uiId = contextUiIds.get(ui);
	if (!uiId) {
		uiId = `ui-${nextContextUiId++}`;
		contextUiIds.set(ui, uiId);
	}

	return `${ctx.cwd}|${uiId}`;
}

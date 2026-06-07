import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import type { Component, } from "@mariozechner/pi-tui";
import { Container, getCapabilities, getCellDimensions, getPngDimensions, Image, Text } from "@mariozechner/pi-tui";
import {
	calculateInlineDisplayColumns,
} from "../preview/inline_preview.ts";
import { createTerminalRefreshPolicy } from "../preview/terminal_refresh_policy.ts";
import { createInlinePreviewRenderer } from "../preview/inline_preview_renderer.ts";
import { buildKittyPlaceholderImageRender, KittyPreviewInvalidationRegistry } from "../preview/kitty_placeholder_image.ts";
import {
	inlinePreviewRenderStateFromDetails as lookupInlinePreviewRenderStateFromDetails,
	type InlinePreviewRenderState,
} from "../preview/inline_preview_metadata.ts";
import { safeInlinePreviewPngPath } from "../preview/inline_preview_metadata.ts";

const TMUX_COMMAND_TIMEOUT_MS = 1_000;
const MAX_INLINE_PREVIEW_RENDER_STATES = 8;

const tmuxKittyPreviewInvalidationRegistry = new KittyPreviewInvalidationRegistry();

const terminalRefreshPolicy = createTerminalRefreshPolicy({
	adapter: {
		isTmuxKittyTerminal: isTmuxKittyTerminal,
		runTmux: runTmux,
		writeOutput: (sequence: string) => {
			process.stdout.write(sequence);
		},
		onSignal: (signal, handler) => {
			process.on(signal, handler);
			return () => process.off(signal, handler);
		},
	},
	invalidatorRegistry: tmuxKittyPreviewInvalidationRegistry,
});

const inlinePreviewRenderStates = new Map<string, InlinePreviewRenderState>();

export function rememberInlinePreviewRenderState(state: InlinePreviewRenderState): string {
	const id = randomUUID();
	inlinePreviewRenderStates.set(id, state);
	while (inlinePreviewRenderStates.size > MAX_INLINE_PREVIEW_RENDER_STATES) {
		const oldest = inlinePreviewRenderStates.keys().next().value;
		if (oldest === undefined) break;
		inlinePreviewRenderStates.delete(oldest);
	}
	return id;
}

function inlinePreviewRenderStateFromDetails(details: Record<string, unknown>): InlinePreviewRenderState | null {
	return lookupInlinePreviewRenderStateFromDetails(details, (previewId) => inlinePreviewRenderStates.get(previewId));
}

export function installTerminalRefreshForSession(
	hasUi = false,
	ui?: { notify?: (message: string, type?: "error" | "info" | "warning") => void },
): void {
	terminalRefreshPolicy.install({ hasUI: hasUi, ui });
}

export function cleanupTerminalRefresh(): void {
	terminalRefreshPolicy.cleanup();
}

export function clearTerminalInvalidators(): void {
	terminalRefreshPolicy.clearInvalidators();
}

const inlinePreviewRenderer = createInlinePreviewRenderer({
	readState: (details) => inlinePreviewRenderStateFromDetails(details),
	imagePolicy: {
		canShowImages: (context) => {
			if (typeof context === "object" && context !== null && "showImages" in context && (context as { showImages?: unknown }).showImages === false) {
				return false;
			}
			return true;
		},
		terminalSupportsImages: () => Boolean(getCapabilities().images),
	},
	isTmuxKittyTerminal,
	readImageBase64: (pngPath) => {
		const safePath = safeInlinePreviewPngPath(pngPath);
		if (!safePath) return null;
		try {
			return readFileSync(safePath).toString("base64");
		} catch {
			return null;
		}
	},
	makeText: (text) => new Text(text, 0, 0),
	makeContainer: () => new Container(),
	makeInlineImage: (options) =>
		new Image(options.base64Data, "image/png", { fallbackColor: options.fallbackColor }, {
			maxWidthCells: options.maxWidthCells,
			filename: options.filename,
		}),
	makeKittyPlaceholderImage: buildKittyPlaceholderImageRender,
	calculateDisplayColumns: calculateInlineDisplayColumns,
	getCellDimensions,
	getPngDimensions: (base64Data) => getPngDimensions(base64Data) ?? undefined,
	allocateImageId: () => randomInt(1, 0xfffffe + 1),
	rememberInvalidator: (context) => terminalRefreshPolicy.rememberInvalidator(context),
});

function renderInlineLatexPreview(
	result: { content?: Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>; details?: Record<string, unknown> },
	theme: unknown,
	context: unknown,
): Component {
	return inlinePreviewRenderer.render({ result, theme, context }).component;
}

export function renderShowLatexResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> },
	_options: unknown,
	theme: unknown,
	context: unknown,
): Component {
	const details = result.details as Record<string, unknown> | undefined;
	if (details?.inline === true || details?.inline_previews || details?.inline_preview) {
		return renderInlineLatexPreview(result, theme, context);
	}

	const text = result.content?.map((entry) => entry.text ?? "").filter(Boolean).join("\n") ?? "ok";
	return new Text(text, 0, 0);
}

function isTmuxKittyTerminal(): boolean {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase();
	const term = process.env.TERM?.toLowerCase();
	const insideTmux = Boolean(process.env.TMUX) || termProgram === "tmux" || Boolean(term?.startsWith("tmux")) || Boolean(term?.startsWith("screen"));
	return insideTmux && (Boolean(process.env.KITTY_WINDOW_ID) || termProgram === "kitty");
}

function runTmux(args: string[]): void {
	if (!process.env.TMUX) return;
	const result = spawnSync("tmux", args, { stdio: "ignore", timeout: TMUX_COMMAND_TIMEOUT_MS });
	const error = result.error as (Error & { code?: string }) | undefined;
	if (error?.code === "ETIMEDOUT") {
		console.error(`[pdf-preview] tmux ${args.join(" ")} timed out after ${TMUX_COMMAND_TIMEOUT_MS}ms`);
	}
}

export { type Component };

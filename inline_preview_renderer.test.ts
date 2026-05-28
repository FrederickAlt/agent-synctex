import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKittyPlaceholderImageRender } from "./kitty_placeholder_image.ts";
import { KittyPlaceholderOracle } from "./kitty_placeholder_oracle.ts";
import { INLINE_PREVIEW_DIR } from "./inline_preview.ts";
import { inlinePreviewRenderStateFromDetails, type InlinePreviewRenderState } from "./inline_preview_metadata.ts";
import {
	createInlinePreviewRenderer,
	type InlinePreviewRenderCacheEvent,
	type InlinePreviewRenderContainer,
	type InlinePreviewRenderComponent,
	type InlinePreviewRenderEnvironment,
} from "./inline_preview_renderer.ts";
import { TERMINAL_FOCUS_REFRESH_EPOCH_STATE_KEY } from "./terminal_refresh_policy.ts";

function makeFakeContainer(): InlinePreviewRenderContainer & { children: InlinePreviewRenderComponent[] } {
	const children: InlinePreviewRenderComponent[] = [];
	return {
		children,
		render(width: number): string[] {
			return children.flatMap((child) => child.render(width));
		},
		invalidate(): void {
			for (const child of children) child.invalidate();
		},
		addChild(child: InlinePreviewRenderComponent): void {
			children.push(child);
		},
	};
}

function createPngPath(prefix: string): string {
	mkdirSync(INLINE_PREVIEW_DIR, { recursive: true });
	const path = `${INLINE_PREVIEW_DIR}/${prefix}-${randomUUID()}.png`;
	writeFileSync(path, "fake png");
	return path;
}

function mkArtifactMetadata(pngPath: string) {
	return {
		pngPath,
		fullPageWidthPx: 100,
		fullPageHeightPx: 80,
		widthPx: 100,
		heightPx: 80,
	};
}

function mkRenderer(
	env: Partial<InlinePreviewRenderEnvironment> = {},
	stateMap: Map<string, InlinePreviewRenderState> = new Map(),
): ReturnType<typeof createInlinePreviewRenderer> {
	let nextImageId = 1;

	return createInlinePreviewRenderer({
		readState: (details) => inlinePreviewRenderStateFromDetails(details, (previewId) => stateMap.get(previewId)),
		imagePolicy: {
			canShowImages: () => true,
			terminalSupportsImages: () => true,
		},
		isTmuxKittyTerminal: () => false,
		readImageBase64: () => null,
		makeText: (text) => ({ render: () => [text], invalidate: () => {} }),
		makeContainer: makeFakeContainer,
		makeInlineImage: (params) => ({
			render: () => [`inline:${params.maxWidthCells}`],
			invalidate: () => {},
		}),
		makeKittyPlaceholderImage: (params) => buildKittyPlaceholderImageRender(params),
		calculateDisplayColumns: (available, artifact) => Math.max(1, Math.min(available, artifact.widthPx)),
		getCellDimensions: () => ({ widthPx: 10, heightPx: 20 }),
		getPngDimensions: () => ({ widthPx: 100, heightPx: 80 }),
		allocateImageId: () => {
			const current = nextImageId;
			nextImageId += 1;
			return current;
		},
		rememberInvalidator: () => {},
		...env,
	});
}

function runRenderer(
	renderer: ReturnType<typeof createInlinePreviewRenderer>,
	previewId: string | undefined,
	targetPreviews: { inline_previews: Array<Record<string, unknown>>; pdf: string },
	context: unknown,
) {
	const result = renderer.render({
		result: {
			content: [],
			details: {
				...targetPreviews,
				...(previewId ? { preview_id: previewId } : {}),
			},
		},
		theme: {},
		context,
	});
	return result;
}

test("inline preview renderer recovers persisted inline metadata after state cache miss", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const pngPath = createPngPath("recovered-inline-preview");
	const inlinePreviewMetadata = { inline_previews: [mkArtifactMetadata(pngPath)], pdf: "/tmp/recovered-preview.pdf" };

	const imageBase64ByPath = new Map([[pngPath, "cmVjb3ZlcmVk"]]);
	let imageCalls = 0;
	const renderer = mkRenderer({
		readImageBase64: (path) => {
			return imageBase64ByPath.get(path) ?? null;
		},
		makeInlineImage: (options) => {
			imageCalls += 1;
			return { render: () => ["rendered-inline"], invalidate: () => {} };
		},
	}, stateMap);

	const { component, diagnostics } = runRenderer(renderer, "missing-from-memory", inlinePreviewMetadata, { toolCallId: "tool-inline" });

	const output = component.render(120).join("\n");
	assert.equal(diagnostics.branch, "generic-image");
	assert.equal(diagnostics.terminalKind, "generic-capability");
	assert.equal(diagnostics.previewCount, 1);
	assert.equal(imageCalls, 1);
	assert.match(output, /rendered-inline/);
});

test("tmux/kitty path renders through placeholder protocol and is oracle-valid", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const detail = {
		inline_previews: [mkArtifactMetadata(createPngPath("kitty"))],
		pdf: "/tmp/kitty.pdf",
	};
	stateMap.set("state-0", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	const invalidatorContexts: unknown[] = [];
	const renderer = mkRenderer({
		isTmuxKittyTerminal: () => true,
		readImageBase64: () => "dGVzdC1raXR0eQ==",
		rememberInvalidator: (context) => invalidatorContexts.push(context),
		allocateImageId: () => 14,
	}, stateMap);

	const rendered = runRenderer(renderer, "state-0", detail, { toolCallId: "tool-kitty" });
	assert.equal(rendered.diagnostics.branch, "tmux-embedded");
	assert.equal(rendered.diagnostics.terminalKind, "tmux-kitty");
	assert.deepEqual(rendered.diagnostics.imageIds, [14]);
	assert.equal(invalidatorContexts.length, 1);

	const output = rendered.component.render(120).join("\n");
	const oracle = new KittyPlaceholderOracle(output, { expectedImageIds: [14], requireImageSetup: true, requirePlaceholders: true });
	assert.equal(oracle.isValid, true);
});

test("tmux/kitty image ids stay stable when pi rebuilds renderResult for the same tool", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const detail = {
		inline_previews: [mkArtifactMetadata(createPngPath("kitty-stable"))],
		pdf: "/tmp/kitty-stable.pdf",
	};
	stateMap.set("state-stable", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	const renderer = mkRenderer({
		isTmuxKittyTerminal: () => true,
		readImageBase64: () => "c3RhYmxlLWtpdHR5",
	}, stateMap);
	const context = { toolCallId: "tool-kitty-stable", state: {} };

	const first = runRenderer(renderer, "state-stable", detail, context);
	const firstOutput = first.component.render(120).join("\n");
	const second = runRenderer(renderer, "state-stable", detail, context);
	const secondOutput = second.component.render(120).join("\n");

	assert.deepEqual(second.diagnostics.imageIds, first.diagnostics.imageIds);
	assert.equal(secondOutput, firstOutput);

	(context.state as Record<string, unknown>)[TERMINAL_FOCUS_REFRESH_EPOCH_STATE_KEY] = 1;
	const focusRefresh = runRenderer(renderer, "state-stable", detail, context);
	const focusRefreshOutput = focusRefresh.component.render(120).join("\n");
	assert.notDeepEqual(focusRefresh.diagnostics.imageIds, first.diagnostics.imageIds);
	assert.notEqual(focusRefreshOutput, firstOutput);

	const oracle = new KittyPlaceholderOracle(focusRefreshOutput, { expectedImageIds: focusRefresh.diagnostics.imageIds, requireImageSetup: true, requirePlaceholders: true });
	assert.equal(oracle.isValid, true, oracle.summary);
});

test("generic image capability branch renders inline image output", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const detail = {
		inline_previews: [mkArtifactMetadata(createPngPath("generic"))],
		pdf: "/tmp/generic.pdf",
	};
	stateMap.set("state-generic", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	let inlineImageCount = 0;
	const renderer = mkRenderer({
		isTmuxKittyTerminal: () => false,
		readImageBase64: () => "Z2VuZXJpYw==",
		makeInlineImage: (options) => {
			inlineImageCount += 1;
			return {
				render: () => [`inline:${options.filename}:${options.maxWidthCells}`],
				invalidate: () => {},
			};
		},
	}, stateMap);

	const rendered = runRenderer(renderer, "state-generic", detail, {});
	assert.equal(rendered.diagnostics.branch, "generic-image");
	assert.equal(rendered.diagnostics.imageIds.length, 0);
	const outputLines = rendered.component.render(80);
	assert.equal(inlineImageCount, 1);
	assert.match(outputLines.join("\n"), /inline:.*generic/);
});

test("generic image branch falls back when context disables images", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const detail = {
		inline_previews: [mkArtifactMetadata(createPngPath("unsupported"))],
		pdf: "/tmp/unsupported.pdf",
	};
	stateMap.set("state-no-support", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	const renderer = mkRenderer({
		imagePolicy: {
			canShowImages: () => false,
			terminalSupportsImages: () => true,
		},
		readImageBase64: () => "c3R1Yg==",
	}, stateMap);

	const rendered = runRenderer(renderer, "state-no-support", detail, {});
	assert.equal(rendered.diagnostics.branch, "images-disabled");
	assert.equal(rendered.diagnostics.fallbackReason, "images-disabled-by-context");
	assert.equal(rendered.diagnostics.terminalKind, "generic-capability");
	assert.match(rendered.component.render(80).join("\n"), /not supported by this terminal/);
});

test("generic image branch falls back when terminal image support is disabled", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const detail = {
		inline_previews: [mkArtifactMetadata(createPngPath("terminal-unsupported"))],
		pdf: "/tmp/terminal-unsupported.pdf",
	};
	stateMap.set("state-no-support", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	const renderer = mkRenderer({
		imagePolicy: {
			canShowImages: () => true,
			terminalSupportsImages: () => false,
		},
		readImageBase64: () => "c3R1Yg==",
	}, stateMap);

	const rendered = runRenderer(renderer, "state-no-support", detail, {});
	assert.equal(rendered.diagnostics.branch, "images-disabled");
	assert.equal(rendered.diagnostics.fallbackReason, "images-disabled-by-terminal");
	assert.equal(rendered.diagnostics.terminalKind, "images-unsupported");
	assert.match(rendered.component.render(80).join("\n"), /not supported by this terminal/);
});

test("fallback diagnostics fire when inline PNG data cannot be read", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const path = createPngPath("bad-preview");
	const detail = {
		inline_previews: [mkArtifactMetadata(path)],
		pdf: "/tmp/bad-preview.pdf",
	};
	stateMap.set("state-missing", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	const renderer = mkRenderer({
		isTmuxKittyTerminal: () => false,
		imagePolicy: {
			canShowImages: () => true,
			terminalSupportsImages: () => true,
		},
		readImageBase64: () => null,
	}, stateMap);

	const rendered = runRenderer(renderer, "state-missing", detail, {});
	assert.equal(rendered.diagnostics.branch, "missing-image-data");
	assert.equal(rendered.diagnostics.fallbackReason, `missing-image:${path}`);
	assert.match(rendered.component.render(80).join("\n"), /Inline preview unavailable/);
});

test("invalid persisted png metadata outside preview directory falls back to unavailable text", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const outsidePngPath = join(dirname(INLINE_PREVIEW_DIR), `outside-preview-${randomUUID()}.png`);
	writeFileSync(outsidePngPath, "not-a-real-in-preview-png");

	const detail = {
		inline_previews: [mkArtifactMetadata(outsidePngPath)],
		pdf: "/tmp/outside-preview.pdf",
	};
	const renderer = mkRenderer({
		readState: (details) => inlinePreviewRenderStateFromDetails(details, (previewId) => stateMap.get(previewId)),
		imagePolicy: {
			canShowImages: () => true,
			terminalSupportsImages: () => true,
		},
		readImageBase64: () => null,
	}, stateMap);

	const rendered = runRenderer(renderer, undefined, detail, {});
	assert.equal(rendered.diagnostics.branch, "no-previews");
	assert.equal(rendered.diagnostics.fallbackReason, "no-previews");
	assert.equal(rendered.diagnostics.previewCount, 0);
	assert.deepEqual(rendered.diagnostics.missingPngPaths, []);
	const renderedLines = rendered.component.render(80).join("\n");
	assert.match(renderedLines, /ok: \/tmp\/outside-preview\.pdf/);
	assert.match(renderedLines, /Inline preview: unavailable/);
});

test("width changes and invalidation clear cached render output", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const detail = {
		inline_previews: [mkArtifactMetadata(createPngPath("cached"))],
		pdf: "/tmp/cached.pdf",
	};
	stateMap.set("state-cache", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	let imageRenders = 0;
	const renderer = mkRenderer({
		isTmuxKittyTerminal: () => false,
		readImageBase64: () => "ZmFrZS1pbWFnZS1kYXRh",
		imagePolicy: {
			canShowImages: () => true,
			terminalSupportsImages: () => true,
		},
		calculateDisplayColumns: (available, artifact) => Math.min(available, artifact.widthPx),
		makeInlineImage: (options) => {
			imageRenders += 1;
			return {
				render: () => [`width:${options.maxWidthCells}`],
				invalidate: () => {},
			};
		},
	}, stateMap);

	const rendered = runRenderer(renderer, "state-cache", detail, {});
	const output = rendered.component;

	assert.equal(output.render(120).join("\n"), "\u2713 LaTeX preview\nwidth:100");
	assert.deepEqual(
		rendered.diagnostics.cacheLog.map((entry: InlinePreviewRenderCacheEvent) => `${entry.type}:${entry.width ?? ""}`),
		["cache-miss:120"],
	);

	assert.equal(output.render(120).join("\n"), "\u2713 LaTeX preview\nwidth:100");
	assert.deepEqual(
		rendered.diagnostics.cacheLog.map((entry: InlinePreviewRenderCacheEvent) => `${entry.type}:${entry.width ?? ""}`),
		["cache-miss:120", "cache-hit:120"],
	);
	assert.equal(imageRenders, 1);

	assert.equal(output.render(40).join("\n"), "\u2713 LaTeX preview\nwidth:40");
	assert.deepEqual(
		rendered.diagnostics.cacheLog.map((entry: InlinePreviewRenderCacheEvent) => `${entry.type}:${entry.width ?? ""}`),
		["cache-miss:120", "cache-hit:120", "cache-width-recalculation:40"],
	);
	assert.equal(imageRenders, 2);

	output.invalidate();
	assert.deepEqual(
		rendered.diagnostics.cacheLog.map((entry: InlinePreviewRenderCacheEvent) => `${entry.type}:${entry.width ?? ""}`),
		["cache-miss:120", "cache-hit:120", "cache-width-recalculation:40", "cache-invalidation:"],
	);

	assert.equal(output.render(40).join("\n"), "\u2713 LaTeX preview\nwidth:40");
	assert.deepEqual(
		rendered.diagnostics.cacheLog.map((entry: InlinePreviewRenderCacheEvent) => `${entry.type}:${entry.width ?? ""}`),
		[
			"cache-miss:120",
			"cache-hit:120",
			"cache-width-recalculation:40",
			"cache-invalidation:",
			"cache-miss:40",
		],
	);
	assert.equal(imageRenders, 3);
});

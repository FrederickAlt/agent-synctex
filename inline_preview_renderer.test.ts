import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildKittyPlaceholderImageRender,
} from "./kitty_placeholder_image.ts";
import { KittyPlaceholderOracle } from "./kitty_placeholder_oracle.ts";
import { INLINE_PREVIEW_DIR } from "./inline_preview.ts";
import { inlinePreviewRenderStateFromDetails, type InlinePreviewRenderState } from "./inline_preview_metadata.ts";
import {
	createInlinePreviewRenderer,
	type InlinePreviewRenderContainer,
	type InlinePreviewRenderComponent,
	type InlinePreviewRenderEnvironment,
} from "./inline_preview_renderer.ts";

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
		canShowImages: () => true,
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
				preview_id: previewId,
				...targetPreviews,
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

test("generic image capability branch falls back when terminal image support is disabled", () => {
	const stateMap = new Map<string, InlinePreviewRenderState>();
	const detail = {
		inline_previews: [mkArtifactMetadata(createPngPath("unsupported"))],
		pdf: "/tmp/unsupported.pdf",
	};
	stateMap.set("state-no-support", inlinePreviewRenderStateFromDetails(detail, () => undefined)!);

	const renderer = mkRenderer({
		canShowImages: () => false,
		readImageBase64: () => "c3R1Yg==",
	}, stateMap);

	const rendered = runRenderer(renderer, "state-no-support", detail, {});
	assert.equal(rendered.diagnostics.branch, "images-disabled");
	assert.equal(rendered.diagnostics.fallbackReason, "images-disabled-by-terminal");
	assert.match(rendered.component.render(80).join("\n"), /muted/);
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
		canShowImages: () => true,
		readImageBase64: () => null,
	}, stateMap);

	const rendered = runRenderer(renderer, "state-missing", detail, {});
	assert.equal(rendered.diagnostics.branch, "missing-image-data");
	assert.equal(rendered.diagnostics.fallbackReason, `missing-image:${path}`);
	assert.match(rendered.component.render(80).join("\n"), /Inline preview unavailable/);
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
		canShowImages: () => true,
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

	assert.equal(output.render(120).join("\n"), "success\nwidth:100");
	assert.equal(output.render(120).join("\n"), "success\nwidth:100");
	assert.equal(imageRenders, 1);

	assert.equal(output.render(40).join("\n"), "success\nwidth:40");
	assert.equal(imageRenders, 2);

	output.invalidate();
	assert.equal(output.render(40).join("\n"), "success\nwidth:40");
	assert.equal(imageRenders, 3);
});

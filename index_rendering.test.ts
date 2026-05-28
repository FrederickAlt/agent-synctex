import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("index.ts", "utf8");

test("tmux/kitty placeholder branch runs before generic image-capability fallback", () => {
	const tmuxKittyBranch = source.indexOf("if (isTmuxKittyTerminal())");
	const genericImageCapabilityFallback = source.indexOf("if (!getCapabilities().images)");
	assert.ok(tmuxKittyBranch >= 0, "tmux/kitty branch should exist");
	assert.ok(genericImageCapabilityFallback >= 0, "generic image capability fallback should exist");
	assert.ok(tmuxKittyBranch < genericImageCapabilityFallback, "tmux/kitty path must be checked before capability fallback");
});

test("tmux/kitty placeholder images use a container-level title only", () => {
	assert.ok(/container\.addChild\(new TmuxKittyPlaceholderImage\("", base64, preview\)\)/.test(source), "tmux/kitty placeholders should use an empty per-page title");
	assert.ok(!source.includes("new TmuxKittyPlaceholderImage(index === 0 ? title : \"\""), "first placeholder should not duplicate the title");
});

test("tmux/kitty placeholders refresh by invalidating tool rows, not raw setup retransmits", () => {
	assert.ok(source.includes("installTerminalFocusRefresh"), "focus refresh hook should be installed");
	assert.ok(source.includes("refreshTmuxKittyPreviews"), "focus refresh should redraw previews");
	assert.ok(source.includes("rememberTmuxKittyPreviewInvalidator(context)"), "tmux preview rows should register their invalidator");
	assert.ok(source.includes("tmuxKittyPreviewInvalidationRegistry.refresh()"), "refresh should invalidate registered rows");
	assert.ok(!source.includes("rendered.refreshSequence"), "refresh must not re-emit detached Kitty setup sequences");
	assert.ok(!source.includes("tmuxKittyImageRefreshRegistry"), "old raw sequence registry should stay removed");
});

test("inline previews suppress page numbers before image trimming", () => {
	assert.ok(source.includes(String.raw`\AtBeginDocument{\pagestyle{empty}\thispagestyle{empty}\let\ps@plain\ps@empty}`), "inline preamble should suppress normal and plain page styles");
	assert.ok(/suppressPageNumbers:\s*inline/.test(source), "inline preview compilation should request page-number suppression");
});

test("inline show_latex persists local preview metadata in tool details", () => {
	assert.ok(source.includes("content: [{ type: \"text\", text }]"), "inline tool content should remain text-only");
	assert.ok(source.includes("image_path=${primaryImagePath}"), "inline tool content should expose the primary image path to the model");
	assert.ok(source.includes("inline: true"), "inline details should be explicitly marked");
	assert.ok(source.includes("preview_id: previewId"), "inline details should include a preview_id for in-memory recovery");
	assert.ok(source.includes("pdf: preview.pdfPath"), "inline details should include the source PDF path");
	assert.ok(source.includes("image_path: primaryImagePath"), "inline details should include the primary image path");
	assert.ok(!source.includes("image_paths:"), "inline details should expose only the singular image_path field");
	assert.ok(source.includes("inlinePreviews"), "inline details should persist local png path metadata");
	assert.ok(source.includes("inline_previews: inlinePreviews"), "inline details should include inline_previews metadata");
	assert.ok(!source.includes('type: "image" as const'), "inline tool result should not switch to image content");
	const inlineDetailsStart = source.indexOf("const inlinePreviews = artifacts.map((artifact) => ({");
	assert.ok(inlineDetailsStart >= 0, "inline_previews metadata should be built from raster artifacts");
	const inlineDetails = source.slice(inlineDetailsStart, inlineDetailsStart + 240);
	assert.ok(!inlineDetails.includes("renderer:"), "inline details should persist path+dimensions only");
	assert.ok(!inlineDetails.includes("dpi:"), "inline details should not persist renderer-only fields");
	assert.ok(!inlineDetails.includes("trimmed:"), "inline details should avoid transport-only fields");
	assert.ok(!inlineDetails.includes("base64"), "inline details should not persist base64 artifacts");
});

test("inline preview state fallback reads persisted detail metadata", () => {
	assert.ok(source.includes("if (previewId)"), "inline preview id fast-path should be attempted first");
	assert.ok(source.includes("if (state) return state"), "inline preview id should reuse live render state");
	assert.ok(source.includes("const rawPreviews = Array.isArray(details.inline_previews)"), "inline state should fallback to details.inline_previews");
	assert.ok(source.includes("details.inline_preview"), "fallback should still accept legacy inline_preview");
	assert.ok(source.includes("inlinePreviewPdfPathFromDetails(details.pdf)"), "inline preview path should be carried from details");
});

test("inline renderer validates PNG paths before reading image files", () => {
	assert.ok(source.includes("safeInlinePreviewPngPath"), "PNG path validation helper should be used");
	assert.ok(source.includes("if (!isAbsolute(rawPngPath)) return \"\";"), "PNG paths must be absolute");
	assert.ok(source.includes("extname(pngPath).toLowerCase() !== \".png\""), "PNG extension should be required");
	assert.ok(source.includes("realpathSync(INLINE_PREVIEW_DIR)"), "inline preview directory should be canonicalized");
	assert.ok(source.includes("realpathSync(pngPath)"), "PNG path should be canonicalized before reading");
	assert.ok(source.includes("status.isFile()"), "PNG path should resolve to a regular file");
	assert.ok(source.includes("accessSync(realPngPath, constants.R_OK)"), "PNG path should be readable");
	assert.ok(source.includes("INLINE_PREVIEW_MAX_IMAGE_SIZE_BYTES"), "PNG size cap should be enforced");
	assert.ok(source.includes("Inline preview unavailable"), "invalid/missing pngs should render a fallback text message");
	assert.ok(!source.includes("readFileSync(preview.pngPath"), "direct unsafe reads from preview paths should be avoided");
});

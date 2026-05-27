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

test("inline previews suppress page numbers before image trimming", () => {
	assert.ok(source.includes(String.raw`\AtBeginDocument{\pagestyle{empty}\thispagestyle{empty}\let\ps@plain\ps@empty}`), "inline preamble should suppress normal and plain page styles");
	assert.ok(/suppressPageNumbers:\s*inline/.test(source), "inline preview compilation should request page-number suppression");
});

test("inline previews are local render state, not image tool-result content", () => {
	assert.ok(source.includes("rememberInlinePreviewRenderState({ pdf: preview.pdfPath, previews: artifacts })"), "inline artifacts should be registered locally for rendering");
	assert.ok(source.includes('content: [{ type: "text", text: "✓ LaTeX preview rendered locally" }]'), "inline tool content should be text-only");
	assert.ok(!source.includes('type: "image" as const'), "inline tool results should not include base64 image content");
	assert.ok(!source.includes("inline_previews: artifacts"), "inline artifact metadata should not be returned in tool details");
});

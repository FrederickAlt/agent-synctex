import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
	inlinePreviewRenderStateFromDetails,
	inlinePreviewMetadataFromUnknown,
	INLINE_PREVIEW_MAX_IMAGE_SIZE_BYTES,
	safeInlinePreviewPngPath,
	type InlinePreviewRenderState,
} from "./inline_preview_metadata.ts";
import { buildInlinePreviewToolPayload } from "./inline_preview_payload.ts";
import { INLINE_PREVIEW_DIR } from "./inline_preview.ts";
import { type InlinePreviewArtifact } from "./inline_preview.ts";

test("inline preview metadata validation filters safe paths and dimensions", () => {
	mkdirSync(INLINE_PREVIEW_DIR, { recursive: true });
	const validPng = join(INLINE_PREVIEW_DIR, `${randomUUID()}.png`);
	writeFileSync(validPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]));
	assert.equal(safeInlinePreviewPngPath(validPng), resolve(validPng));

	const badExtension = validPng.replace(/\.png$/, ".txt");
	writeFileSync(badExtension, "not an image");
	assert.equal(safeInlinePreviewPngPath(badExtension), "");

	assert.equal(safeInlinePreviewPngPath("foo/bar.png"), "");

	const bigFile = join(INLINE_PREVIEW_DIR, `${randomUUID()}.png`);
	writeFileSync(bigFile, Buffer.alloc(INLINE_PREVIEW_MAX_IMAGE_SIZE_BYTES + 1, 0));
	assert.equal(safeInlinePreviewPngPath(bigFile), "");

	const badMetadata = inlinePreviewMetadataFromUnknown({
		pngPath: "not-a-path",
		fullPageWidthPx: 100,
		fullPageHeightPx: 100,
		widthPx: 100,
		heightPx: 100,
	});
	assert.equal(badMetadata, null);

	const goodMetadata = inlinePreviewMetadataFromUnknown({
		pngPath: validPng,
		fullPageWidthPx: 10.9,
		fullPageHeightPx: 20.4,
		widthPx: 200,
		heightPx: 300,
	});
	assert.deepEqual(goodMetadata, {
		pngPath: validPng,
		fullPageWidthPx: 10,
		fullPageHeightPx: 20,
		widthPx: 200,
		heightPx: 300,
	});
});

test("inline preview details fallback prefers in-memory state then persisted metadata", () => {
	mkdirSync(INLINE_PREVIEW_DIR, { recursive: true });
	const knownPath = join(INLINE_PREVIEW_DIR, `${randomUUID()}.png`);
	writeFileSync(knownPath, "binary");
	const stateMap = new Map<string, InlinePreviewRenderState>([
		[
			"memory",
			{
				pdf: "/tmp/memory.pdf",
				previews: [
					{
						pngPath: knownPath,
						page: 1,
						dpi: 150,
						renderer: "mutool",
						trimmed: false,
						fullPageWidthPx: 10,
						fullPageHeightPx: 10,
						widthPx: 10,
						heightPx: 10,
					},
				],
			},
		],
	]);

	const state = inlinePreviewRenderStateFromDetails({ preview_id: "memory", pdf: "/tmp/ignored.pdf", inline_previews: [] }, (id) => stateMap.get(id));
	assert.equal(state?.pdf, "/tmp/memory.pdf");
	assert.equal(state?.previews.length, 1);

	const fallback = inlinePreviewRenderStateFromDetails(
		{
			inline_previews: [
				{
					pngPath: knownPath,
					fullPageWidthPx: 1,
					fullPageHeightPx: 2,
					widthPx: 3,
					heightPx: 4,
				},
			],
			pdf: "/tmp/fallback.pdf",
		},
		(id) => stateMap.get(id),
	);
	assert.equal(fallback?.pdf, "/tmp/fallback.pdf");
	assert.equal(fallback?.previews[0]?.fullPageWidthPx, 1);
	assert.equal(fallback?.previews[0]?.page, 1);

	const legacy = inlinePreviewRenderStateFromDetails(
		{
			inline_preview: {
				pngPath: knownPath,
				fullPageWidthPx: 5,
				fullPageHeightPx: 6,
				widthPx: 7,
				heightPx: 8,
			},
			pdf: "/tmp/legacy.pdf",
		},
		(id) => stateMap.get(id),
	);
	assert.equal(legacy?.pdf, "/tmp/legacy.pdf");
	assert.equal(legacy?.previews[0]?.fullPageWidthPx, 5);


});

test("inline tool payload contains only sanitized inline preview metadata", () => {
	const tempDirectory = mkdtempSync(join(tmpdir(), "inline-preview-payload-"));
	const artifact: InlinePreviewArtifact = {
		pngPath: join(tempDirectory, `${randomUUID()}.png`),
		page: 1,
		dpi: 300,
		renderer: "mutool",
		trimmed: true,
		fullPageWidthPx: 80,
		fullPageHeightPx: 90,
		widthPx: 81,
		heightPx: 91,
	};
	writeFileSync(artifact.pngPath, "data");
	const payload = buildInlinePreviewToolPayload("/tmp/show.pdf", "preview-id", [artifact]);

	assert.equal(payload.content[0].type, "text");
	assert.equal(payload.content[0].text.includes("✓ LaTeX preview rendered locally"), true);
	assert.equal(payload.content[0].text.includes(`image_path=${artifact.pngPath}`), true);
	assert.equal(payload.details.inline, true);
	assert.equal(payload.details.preview_id, "preview-id");
	assert.equal(payload.details.pdf, "/tmp/show.pdf");
	assert.deepEqual(payload.details.inline_previews, [{
		pngPath: artifact.pngPath,
		fullPageWidthPx: 80,
		fullPageHeightPx: 90,
		widthPx: 81,
		heightPx: 91,
	}]);
	assert.equal(payload.details.image_path, artifact.pngPath);

	rmSync(tempDirectory, { recursive: true, force: true });
});

import type { InlinePreviewArtifact } from "./inline_preview.ts";
import {
	inlinePreviewMetadataFromArtifact,
	type InlinePreviewArtifactMetadata,
} from "./inline_preview_metadata.ts";

export interface InlinePreviewToolPayload {
	content: Array<{ type: "text"; text: string }>;
	details: {
		inline: true;
		preview_id: string;
		pdf: string;
		image_path: string;
		inline_previews: InlinePreviewArtifactMetadata[];
	};
}

export function buildInlinePreviewToolPayload(
	previewPdfPath: string,
	previewId: string,
	artifacts: InlinePreviewArtifact[],
): InlinePreviewToolPayload {
	const inlinePreviews = artifacts.map(inlinePreviewMetadataFromArtifact);
	const primaryImagePath = inlinePreviews[0]?.pngPath ?? "";
	const text = primaryImagePath
		? `\u2713 LaTeX preview rendered locally\nimage_path=${primaryImagePath}`
		: "\u2713 LaTeX preview rendered locally";

	return {
		content: [{ type: "text", text }],
		details: {
			inline: true,
			preview_id: previewId,
			pdf: previewPdfPath,
			image_path: primaryImagePath,
			inline_previews: inlinePreviews,
		},
	};
}

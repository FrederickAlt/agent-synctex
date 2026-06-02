import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { InlinePreviewArtifact } from "./inline_preview.ts";
import { INLINE_PREVIEW_DIR } from "./inline_preview.ts";

export interface InlinePreviewArtifactMetadata {
	pngPath: string;
	fullPageWidthPx: number;
	fullPageHeightPx: number;
	widthPx: number;
	heightPx: number;
}

export interface InlinePreviewRenderState {
	pdf: string;
	previews: InlinePreviewArtifact[];
}

export const INLINE_PREVIEW_MAX_IMAGE_SIZE_BYTES = 25 * 1024 * 1024;

function numberFromUnknown(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 1;
	return Math.max(1, Math.floor(value));
}

export function inlinePreviewPdfPathFromDetails(pdfPath: unknown): string {
	if (typeof pdfPath !== "string") return "";
	if (!isAbsolute(pdfPath)) return "";
	return resolve(pdfPath);
}

export function isInlinePreviewPngPathValue(absolutePath: string, inlinePreviewDir = INLINE_PREVIEW_DIR): boolean {
	const delta = relative(inlinePreviewDir, absolutePath);
	if (delta === "" || delta === ".") return false;
	if (delta === ".." || delta.startsWith(`..${sep}`)) return false;
	return !isAbsolute(delta);
}

function inlinePreviewDirectoryCandidates(): string[] {
	const roots = new Set<string>([INLINE_PREVIEW_DIR]);

	if (process.env.MCP_TMPDIR) {
		roots.add(resolve(process.env.MCP_TMPDIR, "inline"));
	}
	if (process.env.XDG_RUNTIME_DIR) {
		roots.add(resolve(process.env.XDG_RUNTIME_DIR, "tex-actions", "inline"));
	}

	return [...roots];
}

function isInlinePreviewPngPathWithinDirectory(absolutePath: string, inlinePreviewDir: string): boolean {
	let canonicalInlineDir: string;
	try {
		canonicalInlineDir = realpathSync(inlinePreviewDir);
	} catch {
		return false;
	}
	return isInlinePreviewPngPathValue(absolutePath, canonicalInlineDir);
}

export function safeInlinePreviewPngPath(rawPngPath: unknown): string {
	if (typeof rawPngPath !== "string") return "";
	if (!isAbsolute(rawPngPath)) return "";
	const pngPath = resolve(rawPngPath);
	if (extname(pngPath).toLowerCase() !== ".png") return "";

	try {
		const realPngPath = realpathSync(pngPath);
		let isSafeDirectory = false;
		for (const inlinePreviewDir of inlinePreviewDirectoryCandidates()) {
			if (!isInlinePreviewPngPathWithinDirectory(realPngPath, inlinePreviewDir)) {
				continue;
			}
			isSafeDirectory = true;
			break;
		}
		if (!isSafeDirectory) {
			return "";
		}
		if (extname(realPngPath).toLowerCase() !== ".png") return "";
		const status = statSync(realPngPath);
		if (!status.isFile()) return "";
		if (status.size <= 0 || status.size > INLINE_PREVIEW_MAX_IMAGE_SIZE_BYTES) return "";
		accessSync(realPngPath, constants.R_OK);
		return realPngPath;
	} catch {
		return "";
	}
}

export function inlinePreviewMetadataFromUnknown(value: unknown): InlinePreviewArtifactMetadata | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const pngPath = safeInlinePreviewPngPath(candidate.pngPath);
	if (!pngPath) return null;
	return {
		pngPath,
		fullPageWidthPx: numberFromUnknown(candidate.fullPageWidthPx),
		fullPageHeightPx: numberFromUnknown(candidate.fullPageHeightPx),
		widthPx: numberFromUnknown(candidate.widthPx),
		heightPx: numberFromUnknown(candidate.heightPx),
	};
}

export function inlinePreviewArtifactFromMetadata(metadata: InlinePreviewArtifactMetadata): InlinePreviewArtifact {
	return {
		pngPath: metadata.pngPath,
		page: 1,
		dpi: 150,
		renderer: "mutool",
		trimmed: false,
		fullPageWidthPx: metadata.fullPageWidthPx,
		fullPageHeightPx: metadata.fullPageHeightPx,
		widthPx: metadata.widthPx,
		heightPx: metadata.heightPx,
	};
}

export function inlinePreviewMetadataFromArtifact(artifact: InlinePreviewArtifact): InlinePreviewArtifactMetadata {
	return {
		pngPath: artifact.pngPath,
		fullPageWidthPx: artifact.fullPageWidthPx,
		fullPageHeightPx: artifact.fullPageHeightPx,
		widthPx: artifact.widthPx,
		heightPx: artifact.heightPx,
	};
}

export function inlinePreviewRenderStateFromDetails(
	details: Record<string, unknown>,
	readState: (previewId: string) => InlinePreviewRenderState | undefined,
): InlinePreviewRenderState | null {
	const previewId = typeof details.preview_id === "string" ? details.preview_id : undefined;
	if (previewId) {
		const state = readState(previewId);
		if (state) return state;
	}

	const rawPreviews = Array.isArray(details.inline_previews)
		? details.inline_previews
		: details.inline_preview
			? [details.inline_preview]
			: [];
	const metadataPreviews = rawPreviews
		.map((entry) => inlinePreviewMetadataFromUnknown(entry))
		.filter((entry): entry is InlinePreviewArtifactMetadata => entry !== null);
	if (metadataPreviews.length === 0) return null;

	return {
		pdf: inlinePreviewPdfPathFromDetails(details.pdf),
		previews: metadataPreviews.map((metadata) => inlinePreviewArtifactFromMetadata(metadata)),
	};
}

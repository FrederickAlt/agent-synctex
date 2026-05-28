import type { Component } from "@mariozechner/pi-tui";
import type { InlinePreviewArtifact } from "./inline_preview.ts";
import { inlinePreviewPdfPathFromDetails, type InlinePreviewRenderState } from "./inline_preview_metadata.ts";
import type { KittyPlaceholderImageRender, KittyPlaceholderRenderOptions } from "./kitty_placeholder_image.ts";

export interface InlinePreviewRenderComponent extends Component {
	render(width: number): string[];
	invalidate(): void;
}

export interface InlinePreviewRenderContainer extends InlinePreviewRenderComponent {
	addChild(child: InlinePreviewRenderComponent): void;
}

export interface InlinePreviewImagePolicy {
	canShowImages(context: unknown): boolean;
	terminalSupportsImages(): boolean;
}

export interface InlinePreviewRenderEnvironment {
	readState(details: Record<string, unknown>): InlinePreviewRenderState | null;
	imagePolicy: InlinePreviewImagePolicy;
	isTmuxKittyTerminal(): boolean;
	readImageBase64(pngPath: string): string | null;
	makeText(text: string): InlinePreviewRenderComponent;
	makeContainer(): InlinePreviewRenderContainer;
	makeInlineImage(params: {
		base64Data: string;
		maxWidthCells: number;
		fallbackColor: (text: string) => string;
		filename: string;
	}): InlinePreviewRenderComponent;
	makeKittyPlaceholderImage(params: KittyPlaceholderRenderOptions): KittyPlaceholderImageRender;
	calculateDisplayColumns(availableColumns: number, artifact: Pick<InlinePreviewArtifact, "fullPageWidthPx" | "widthPx">): number;
	getCellDimensions(): { widthPx: number; heightPx: number };
	getPngDimensions(base64Data: string): { widthPx: number; heightPx: number } | undefined;
	allocateImageId(): number;
	rememberInvalidator(context: unknown): void;
}

export type InlinePreviewTerminalKind = "tmux-kitty" | "generic-capability" | "images-unsupported";

export type InlinePreviewRenderBranch =
	| "no-previews"
	| "missing-image-data"
	| "images-disabled"
	| "tmux-embedded"
	| "generic-image";

export type InlinePreviewRenderCacheEventType =
	| "cache-hit"
	| "cache-miss"
	| "cache-width-recalculation"
	| "cache-invalidation";

export interface InlinePreviewRenderCacheEvent {
	type: InlinePreviewRenderCacheEventType;
	imageKind: "inline" | "tmux-placeholder";
	width?: number;
}

export interface InlinePreviewRenderDiagnostics {
	terminalKind: InlinePreviewTerminalKind;
	branch: InlinePreviewRenderBranch;
	previewCount: number;
	missingPngPaths: string[];
	fallbackReason?: string;
	imageIds: number[];
	cacheLog: InlinePreviewRenderCacheEvent[];
}

export interface InlinePreviewRenderResult {
	component: InlinePreviewRenderComponent;
	diagnostics: InlinePreviewRenderDiagnostics;
}

interface InlinePreviewRenderOutput {
	result: { content?: Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>; details?: Record<string, unknown> };
	theme: unknown;
	context: unknown;
}

export interface InlinePreviewRenderer {
	render(output: InlinePreviewRenderOutput): InlinePreviewRenderResult;
}

class InlineLatexPreviewImageComponent implements InlinePreviewRenderComponent {
	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;
	private readonly base64Data: string;
	private readonly artifact: InlinePreviewArtifact;
	private readonly fallbackColor: (text: string) => string;
	private readonly filename: string;
	private readonly env: InlinePreviewRenderEnvironment;
	private readonly cacheLog: InlinePreviewRenderCacheEvent[];

	constructor(
		base64Data: string,
		artifact: InlinePreviewArtifact,
		fallbackColor: (text: string) => string,
		filename: string,
		env: InlinePreviewRenderEnvironment,
		cacheLog: InlinePreviewRenderCacheEvent[],
	) {
		this.base64Data = base64Data;
		this.artifact = artifact;
		this.fallbackColor = fallbackColor;
		this.filename = filename;
		this.env = env;
		this.cacheLog = cacheLog;
	}

	invalidate(): void {
		this.cacheLog.push({ type: "cache-invalidation", imageKind: "inline" });
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			this.cacheLog.push({ type: "cache-hit", imageKind: "inline", width });
			return this.cachedLines;
		}

		if (this.cachedWidth !== undefined) {
			this.cacheLog.push({ type: "cache-width-recalculation", imageKind: "inline", width });
		} else {
			this.cacheLog.push({ type: "cache-miss", imageKind: "inline", width });
		}

		const maxWidthCells = this.env.calculateDisplayColumns(width, this.artifact);
		const image = this.env.makeInlineImage({
			base64Data: this.base64Data,
			maxWidthCells,
			fallbackColor: this.fallbackColor,
			filename: this.filename,
		});
		this.cachedWidth = width;
		this.cachedLines = image.render(width);
		return this.cachedLines;
	}
}

class TmuxKittyPlaceholderImageComponent implements InlinePreviewRenderComponent {
	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;
	private readonly title: string;
	private readonly base64Data: string;
	private readonly artifact: InlinePreviewArtifact;
	private readonly imageId: number;
	private readonly env: InlinePreviewRenderEnvironment;
	private readonly cacheLog: InlinePreviewRenderCacheEvent[];

	constructor(title: string, base64Data: string, artifact: InlinePreviewArtifact, imageId: number, env: InlinePreviewRenderEnvironment, cacheLog: InlinePreviewRenderCacheEvent[]) {
		this.title = title;
		this.base64Data = base64Data;
		this.artifact = artifact;
		this.imageId = imageId;
		this.env = env;
		this.cacheLog = cacheLog;
	}

	invalidate(): void {
		this.cacheLog.push({ type: "cache-invalidation", imageKind: "tmux-placeholder" });
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			this.cacheLog.push({ type: "cache-hit", imageKind: "tmux-placeholder", width });
			return this.cachedLines;
		}

		if (this.cachedWidth !== undefined) {
			this.cacheLog.push({ type: "cache-width-recalculation", imageKind: "tmux-placeholder", width });
		} else {
			this.cacheLog.push({ type: "cache-miss", imageKind: "tmux-placeholder", width });
		}

		const maxWidthCells = this.env.calculateDisplayColumns(width, this.artifact);
		const imageDimensions = this.env.getPngDimensions(this.base64Data) ?? {
			widthPx: this.artifact.widthPx,
			heightPx: this.artifact.heightPx,
		};
		const rendered = this.env.makeKittyPlaceholderImage({
			title: this.title,
			base64Data: this.base64Data,
			imageId: this.imageId,
			width,
			maxWidthCells,
			imageDimensions,
			cellDimensions: this.env.getCellDimensions(),
		});

		this.cachedWidth = width;
		this.cachedLines = rendered.lines;
		return this.cachedLines;
	}
}

function fgFromTheme(theme: unknown, role: string, text: string): string {
	if (typeof theme === "object" && theme !== null && "fg" in theme && typeof (theme as { fg?: unknown }).fg === "function") {
		return (theme as { fg: (role: string, text: string) => string }).fg(role, text);
	}
	return text;
}

export function createInlinePreviewRenderer(env: InlinePreviewRenderEnvironment): InlinePreviewRenderer {
	const labelForPaths = (paths: string[]): string =>
		paths.length === 1 ? `PNG: ${paths[0]}` : `PNGs:\n${paths.join("\n")}`;

	return {
		render({ result, theme, context }): InlinePreviewRenderResult {
			const details = result.details ?? {};
			const renderState = env.readState(details);
			const inlinePreviews = renderState?.previews ?? [];
			const pdf = renderState?.pdf ?? inlinePreviewPdfPathFromDetails((details as { pdf?: unknown }).pdf);
			const canShowByContext = env.imagePolicy.canShowImages(context);
			const canShowByTerminal = env.imagePolicy.terminalSupportsImages();
			const cacheLog: InlinePreviewRenderCacheEvent[] = [];

			const diagnostics: InlinePreviewRenderDiagnostics = {
				terminalKind: env.isTmuxKittyTerminal()
					? "tmux-kitty"
					: canShowByTerminal
						? "generic-capability"
						: "images-unsupported",
				branch: "no-previews",
				previewCount: inlinePreviews.length,
				missingPngPaths: [],
				imageIds: [],
				cacheLog,
			};

			const fg = (role: string, text: string) => fgFromTheme(theme, role, text);
			const makeUnavailableFallback = () =>
				env.makeText(`ok: ${pdf}\n${fg("muted", `Inline preview unavailable: ${labelForPaths(diagnostics.missingPngPaths)}`)}`);

			if (inlinePreviews.length === 0) {
				diagnostics.fallbackReason = pdf ? "no-previews" : "missing-preview-state";
				return {
					component: env.makeText(`ok: ${pdf}\nInline preview: unavailable`),
					diagnostics,
				};
			}

			const container = env.makeContainer();
			container.addChild(env.makeText(fg("success", "\u2713 LaTeX preview")));

			const readImageData = (preview: InlinePreviewArtifact): string | null => {
				const base64 = env.readImageBase64(preview.pngPath);
				if (base64 === null) {
					diagnostics.missingPngPaths.push(preview.pngPath);
				}
				return base64;
			};

			if (!canShowByContext) {
				diagnostics.branch = "images-disabled";
				diagnostics.fallbackReason = "images-disabled-by-context";
				const label = inlinePreviews.map((preview) => preview.pngPath);
				return {
					component: env.makeText(
						`${fg("success", "ok")}: ${pdf}\n${fg("muted", `Inline image display is not supported by this terminal. ${labelForPaths(label)}`)}`,
					),
					diagnostics,
				};
			}

			if (env.isTmuxKittyTerminal()) {
				diagnostics.branch = "tmux-embedded";
				env.rememberInvalidator(context);
				for (const preview of inlinePreviews) {
					const base64 = readImageData(preview);
					if (!base64) {
						diagnostics.branch = "missing-image-data";
						diagnostics.fallbackReason = `missing-image:${preview.pngPath}`;
						return { component: makeUnavailableFallback(), diagnostics };
					}
					const imageId = env.allocateImageId();
					diagnostics.imageIds.push(imageId);
					container.addChild(
						new TmuxKittyPlaceholderImageComponent("", base64, preview, imageId, env, cacheLog),
					);
				}
				return { component: container, diagnostics };
			}

			if (!canShowByTerminal) {
				diagnostics.branch = "images-disabled";
				diagnostics.fallbackReason = "images-disabled-by-terminal";
				const label = inlinePreviews.map((preview) => preview.pngPath);
				return {
					component: env.makeText(
						`${fg("success", "ok")}: ${pdf}\n${fg("muted", `Inline image display is not supported by this terminal. ${labelForPaths(label)}`)}`,
					),
					diagnostics,
				};
			}

			diagnostics.branch = "generic-image";
			for (const preview of inlinePreviews) {
				const base64 = readImageData(preview);
				if (!base64) {
					diagnostics.branch = "missing-image-data";
					diagnostics.fallbackReason = `missing-image:${preview.pngPath}`;
					return { component: makeUnavailableFallback(), diagnostics };
				}
				container.addChild(
					new InlineLatexPreviewImageComponent(
						base64,
						preview,
						(text) => fg("muted", text),
						preview.pngPath,
						env,
						cacheLog,
					),
				);
			}

			return { component: container, diagnostics };
		},
	};
}

import type { InlinePreviewArtifact } from "./inline_preview.ts";
import type { LatexCompileStatus, LatexDiagnosticSummary } from "../latex/latex_file_compiler.ts";
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
		log?: string;
		compile_status?: LatexCompileStatus;
		warning_count?: number;
		warnings?: LatexDiagnosticSummary[];
		warnings_truncated?: boolean;
	};
}

function warningSummary(warnings: LatexDiagnosticSummary[] | undefined, count: number | undefined, truncated: boolean | undefined): string {
	if (!count || !warnings?.length) return "";
	const lines = warnings.slice(0, 5).map((warning) => `- ${warning.message}`);
	return `\nWarnings:\n${lines.join("\n")}${truncated ? "\n- ... more warnings omitted" : ""}`;
}

export function buildInlinePreviewToolPayload(
	previewPdfPath: string,
	previewId: string,
	artifacts: InlinePreviewArtifact[],
	diagnostics: {
		compileStatus?: LatexCompileStatus;
		logPath?: string;
		warningCount?: number;
		warnings?: LatexDiagnosticSummary[];
		warningsTruncated?: boolean;
	} = {},
): InlinePreviewToolPayload {
	const inlinePreviews = artifacts.map(inlinePreviewMetadataFromArtifact);
	const primaryImagePath = inlinePreviews[0]?.pngPath ?? "";
	const statusLine = diagnostics.compileStatus && diagnostics.compileStatus !== "ok"
		? `\nstatus=${diagnostics.compileStatus}${diagnostics.warningCount ? ` warnings=${diagnostics.warningCount}` : ""}`
		: diagnostics.warningCount ? `\nwarnings=${diagnostics.warningCount}` : "";
	const logLine = diagnostics.logPath ? `\nlog=${diagnostics.logPath}` : "";
	const text = primaryImagePath
		? `\u2713 LaTeX preview rendered locally${statusLine}${warningSummary(diagnostics.warnings, diagnostics.warningCount, diagnostics.warningsTruncated)}\nimage_path=${primaryImagePath}${logLine}`
		: `\u2713 LaTeX preview rendered locally${statusLine}${warningSummary(diagnostics.warnings, diagnostics.warningCount, diagnostics.warningsTruncated)}${logLine}`;

	return {
		content: [{ type: "text", text }],
		details: {
			inline: true,
			preview_id: previewId,
			pdf: previewPdfPath,
			image_path: primaryImagePath,
			inline_previews: inlinePreviews,
			...(diagnostics.logPath ? { log: diagnostics.logPath } : {}),
			...(diagnostics.compileStatus ? { compile_status: diagnostics.compileStatus } : {}),
			...(diagnostics.warningCount !== undefined ? { warning_count: diagnostics.warningCount } : {}),
			...(diagnostics.warnings ? { warnings: diagnostics.warnings } : {}),
			...(diagnostics.warningsTruncated !== undefined ? { warnings_truncated: diagnostics.warningsTruncated } : {}),
		},
	};
}

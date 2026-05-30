import type { LatexCompiler } from "../latex/latex_file_compiler.ts";
import { applyLatexPreamble } from "../latex/latex_preamble.ts";
import { mergeInlinePreviewArtifacts, rasterizePdfPages, type InlinePreviewArtifact } from "./inline_preview.ts";
import { buildInlinePreviewToolPayload, type InlinePreviewToolPayload } from "./inline_preview_payload.ts";
import { type InlinePreviewRenderState } from "./inline_preview_metadata.ts";

export interface ParsedShowLatexInput {
	latexSource: string;
	compiler?: LatexCompiler;
	inline?: boolean;
}

export interface ShowLatexPreviewResult {
	text: string;
	pdfPath: string;
}

export interface ShowLatexCallOptions {
	writeReady?: boolean;
	writeFixed?: boolean;
	cropToContent?: boolean;
	suppressPageNumbers?: boolean;
}

export interface ShowLatexPipelineDependencies {
	resolveLatexCompiler: (compiler: unknown) => LatexCompiler | undefined;
	callShowLatex: (
		latexSource: string,
		compiler: LatexCompiler | undefined,
		synctexEditorCommand: string | undefined,
		signal: AbortSignal | undefined,
		options?: ShowLatexCallOptions,
	) => Promise<ShowLatexPreviewResult>;
	readLatexPreamble: () => string;
	rememberInlinePreviewRenderState: (state: InlinePreviewRenderState) => string;
	rasterizePdfPages: (pdfPath: string, options: { dpi?: number; signal?: AbortSignal }) => Promise<InlinePreviewArtifact[]>;
	mergeInlinePreviewArtifacts: (
		artifacts: InlinePreviewArtifact[],
		options: { signal?: AbortSignal },
	) => Promise<InlinePreviewArtifact[]>;
	buildInlinePreviewToolPayload: (
		previewPdfPath: string,
		previewId: string,
		artifacts: InlinePreviewArtifact[],
	) => InlinePreviewToolPayload;
}

export interface ShowLatexPipelineCompileRequest {
	latexSource: string;
	compiler?: LatexCompiler;
	inline?: boolean;
	synctexEditorCommand?: string;
	signal?: AbortSignal;
}

export interface ShowLatexCompiledPreview {
	text: string;
	previewPdfPath: string;
	inline: boolean;
}

export interface ShowLatexInlineResult {
	inline: true;
	text: string;
	previewPdfPath: string;
	payload: InlinePreviewToolPayload;
}

export type ShowLatexPipelineResult = ShowLatexInlineResult;

export interface ShowLatexPreviewPipeline {
	parseShowLatexInput(rawInput: string): ParsedShowLatexInput;
	prepareShowLatexArguments(args: unknown): Record<string, unknown>;
	compileAndPreviewLatex(request: ShowLatexPipelineCompileRequest): Promise<ShowLatexCompiledPreview>;
	buildInlinePreviewResult(compiledPreview: ShowLatexCompiledPreview, signal?: AbortSignal): Promise<ShowLatexInlineResult>;
}

export function createShowLatexPreviewPipeline(dependencies: ShowLatexPipelineDependencies): ShowLatexPreviewPipeline {
	function unquoteFrontMatterScalar(value: string): string {
		const trimmed = value.trim();
		if (trimmed.length >= 2) {
			const first = trimmed[0];
			const last = trimmed[trimmed.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				return trimmed.slice(1, -1);
			}
		}
		return trimmed;
	}

	function parseFrontMatterBoolean(key: string, value: string): boolean {
		const normalized = unquoteFrontMatterScalar(value).toLowerCase();
		if (["true", "yes", "on", "1"].includes(normalized)) return true;
		if (["false", "no", "off", "0"].includes(normalized)) return false;
		throw new Error(`Invalid show_latex front matter value for ${key}: expected true or false`);
	}

	function parseShowLatexInput(rawInput: string): ParsedShowLatexInput {
		const input = rawInput.replace(/^\uFEFF/, "");
		const frontMatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(input);
		if (!frontMatter) {
			return { latexSource: input };
		}

		const parsed: ParsedShowLatexInput = {
			latexSource: input.slice(frontMatter[0].length),
		};

		for (const rawLine of frontMatter[1].split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const separator = line.indexOf(":");
			if (separator < 0) {
				throw new Error(`Invalid show_latex front matter line: ${rawLine}`);
			}

			const key = line.slice(0, separator).trim();
			const value = line.slice(separator + 1).trim();
			switch (key) {
				case "compiler":
					parsed.compiler = dependencies.resolveLatexCompiler(unquoteFrontMatterScalar(value));
					break;
				case "inline":
					parsed.inline = parseFrontMatterBoolean(key, value);
					break;
				default:
					throw new Error(`Unsupported show_latex front matter key: ${key}`);
			}
		}

		return parsed;
	}

	function compactShowLatexArguments(parsed: ParsedShowLatexInput): Record<string, unknown> {
		const result: Record<string, unknown> = { source: parsed.latexSource };
		if (parsed.compiler !== undefined) result.compiler = parsed.compiler;
		if (parsed.inline !== undefined) result.inline = parsed.inline;
		return result;
	}

	function prepareShowLatexArguments(args: unknown): Record<string, unknown> {
		if (typeof args === "string") {
			return compactShowLatexArguments(parseShowLatexInput(args));
		}

		if (args && typeof args === "object" && !Array.isArray(args)) {
			const record = args as Record<string, unknown>;
			const source = record.source ?? record.latex_source ?? record.latex ?? record.body ?? record.content ?? record.text ?? record.input;
			const result: Record<string, unknown> = {};
			if (source !== undefined) result.source = source;
			if (record.compiler !== undefined) result.compiler = record.compiler;
			if (record.inline !== undefined) result.inline = record.inline;
			return Object.keys(result).length ? result : record;
		}

		return args as Record<string, unknown>;
	}

	async function compileAndPreviewLatex(request: ShowLatexPipelineCompileRequest): Promise<ShowLatexCompiledPreview> {
		if (!request.latexSource.trim()) {
			throw new Error("latex_source must be a non-empty string");
		}

		const inline = request.inline !== false;
		const preview = await dependencies.callShowLatex(
			applyLatexPreamble(
				request.latexSource,
				dependencies.readLatexPreamble(),
				{ cropToContent: false, suppressPageNumbers: inline },
			),
			request.compiler,
			request.synctexEditorCommand,
			request.signal,
			{
				writeReady: false,
				writeFixed: !inline,
				cropToContent: false,
				suppressPageNumbers: inline,
			},
		);

		return {
			text: preview.text,
			previewPdfPath: preview.pdfPath,
			inline,
		};
	}

	async function buildInlinePreviewResult(compiledPreview: ShowLatexCompiledPreview, signal?: AbortSignal): Promise<ShowLatexInlineResult> {
		if (!compiledPreview.inline) {
			throw new Error("Cannot build inline preview result for external flow");
		}

		const pageArtifacts = await dependencies.rasterizePdfPages(compiledPreview.previewPdfPath, { dpi: 150, signal });
		const artifacts = await dependencies.mergeInlinePreviewArtifacts(pageArtifacts, { signal });
		const previewId = dependencies.rememberInlinePreviewRenderState({
			pdf: compiledPreview.previewPdfPath,
			previews: artifacts,
		});

		return {
			inline: true,
			text: compiledPreview.text,
			previewPdfPath: compiledPreview.previewPdfPath,
			payload: dependencies.buildInlinePreviewToolPayload(compiledPreview.previewPdfPath, previewId, artifacts),
		};
	}

	return {
		parseShowLatexInput,
		prepareShowLatexArguments,
		compileAndPreviewLatex,
		buildInlinePreviewResult,
	};
}

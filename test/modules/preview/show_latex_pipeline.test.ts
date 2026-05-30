import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createShowLatexPreviewPipeline,
	type ShowLatexCompiledPreview,
	type ShowLatexPipelineDependencies,
	type ShowLatexPipelineCompileRequest,
} from "../../../src/modules/preview/show_latex_pipeline.ts";
import type { InlinePreviewArtifact } from "../../../src/modules/preview/inline_preview.ts";
import type { LatexCompiler } from "../../../src/modules/latex/latex_file_compiler.ts";

function createFakePipeline(dependencies?: Partial<ShowLatexPipelineDependencies>) {
	let sourceCalls: string[] = [];
	let optionsCalls: Array<{ writeFixed?: boolean; suppressPageNumbers?: boolean; cropToContent?: boolean; writeReady?: boolean }> = [];
	let synctexCommands: Array<string | undefined> = [];
	const inlineStateIds = ["inline-preview-id"];
	let nextStateIndex = 0;
	let rasterizeCalls: Array<{ pdfPath: string; dpi?: number }> = [];
	const pipeline = createShowLatexPreviewPipeline({
		resolveLatexCompiler: (compiler) => (compiler ? (typeof compiler === "string" ? (compiler as LatexCompiler) : "lualatex") : undefined),
		callShowLatex: async (latexSource, _compiler, synctexEditorCommand, _signal, options) => {
			sourceCalls.push(latexSource);
			optionsCalls.push(options ?? {});
			synctexCommands.push(synctexEditorCommand);
			return {
				text: `tex:${sourceCalls.length}`,
				pdfPath: `/tmp/show-latex-${sourceCalls.length}.pdf`,
			};
		},
		readLatexPreamble: () => "\\usepackage{custom}\\n\\usepackage{custom2}",
		rememberInlinePreviewRenderState: () => inlineStateIds[nextStateIndex++] ?? "inline-preview-id",
		rasterizePdfPages: async (pdfPath, { dpi } = {}) => {
			rasterizeCalls.push({ pdfPath, dpi });
			const artifact: InlinePreviewArtifact = {
				pngPath: "/tmp/page-1.png",
				page: 1,
				renderer: "mutool",
				dpi: dpi ?? 150,
				trimmed: false,
				fullPageWidthPx: 100,
				fullPageHeightPx: 80,
				widthPx: 100,
				heightPx: 80,
			};
			return [artifact, { ...artifact, pngPath: "/tmp/page-2.png", page: 2 }];
		},
		mergeInlinePreviewArtifacts: async (artifacts) => artifacts,
		buildInlinePreviewToolPayload: (previewPdfPath, previewId, artifacts) => ({
			content: [{ type: "text", text: `\u2713 LaTeX preview rendered locally\nimage_path=${artifacts[0]?.pngPath ?? ""}` }],
			details: {
				inline: true,
				preview_id: previewId,
				pdf: previewPdfPath,
				image_path: artifacts[0]?.pngPath ?? "",
				inline_previews: artifacts.map((artifact) => ({
					pngPath: artifact.pngPath,
					fullPageWidthPx: artifact.fullPageWidthPx,
					fullPageHeightPx: artifact.fullPageHeightPx,
					widthPx: artifact.widthPx,
					heightPx: artifact.heightPx,
				})),
			},
		}),
		...dependencies,
	});

	return {
		pipeline,
		getState() {
			return { sourceCalls, optionsCalls, synctexCommands, rasterizeCalls };
		},
	};
}


test("parses front matter into ParsedShowLatexInput", () => {
	const { pipeline } = createFakePipeline();
	const parsed = pipeline.parseShowLatexInput(["---", "inline: false", "compiler: pdflatex", "---", "\\frac12"].join("\n"));

	assert.equal(parsed.inline, false);
	assert.equal(parsed.compiler, "pdflatex");
	assert.equal(parsed.latexSource, "\\frac12");
});

test("rejects unknown front matter keys", () => {
	const { pipeline } = createFakePipeline();
	assert.throws(
		() => pipeline.parseShowLatexInput(["---", "rendering: false", "---", "x"].join("\n")),
		/Unsupported show_latex front matter key: rendering/,
	);
});

test("prepareShowLatexArguments extracts source aliases for string input with inline defaults", () => {
	const { pipeline } = createFakePipeline();
	const prepared = pipeline.prepareShowLatexArguments(["---", "inline: false", "---", "source body"].join("\n"));

	assert.equal(prepared.source, "source body");
	assert.equal(prepared.inline, false);
});

test("applies inline preamble options for crop/page-number behavior and write options", async () => {
	const { pipeline, getState } = createFakePipeline();
	const request: ShowLatexPipelineCompileRequest = {
		latexSource: "sample body",
		compiler: "pdflatex",
		inline: true,
	};
	const inlineResult = await pipeline.compileAndPreviewLatex(request);

	const { sourceCalls, optionsCalls, synctexCommands } = getState();
	assert.equal(inlineResult.inline, true);
	assert.equal(sourceCalls.length, 1);
	assert.equal(synctexCommands[0], undefined);
	assert.equal(optionsCalls[0].suppressPageNumbers, true);
	assert.equal(optionsCalls[0].writeFixed, false);
	assert.equal(optionsCalls[0].cropToContent, false);
	assert.ok(sourceCalls[0].includes("AtBeginDocument"));
	assert.ok(sourceCalls[0].includes("\\makeatletter"));
	assert.ok(!sourceCalls[0].includes("\\begin{preview}"));

	const externalResult = await pipeline.compileAndPreviewLatex({ ...request, inline: false });
	assert.equal(externalResult.inline, false);
	assert.equal(getState().optionsCalls[1].suppressPageNumbers, false);
	assert.equal(getState().optionsCalls[1].writeFixed, true);
});

test("defaults inline=true when unspecified", async () => {
	const { pipeline, getState } = createFakePipeline();
	const compiled = await pipeline.compileAndPreviewLatex({
		latexSource: "x",
	});
	assert.equal(compiled.inline, true);
	assert.equal(getState().optionsCalls[0].suppressPageNumbers, true);
});

test("buildInlinePreviewResult renders inline payload and remembers state", async () => {
	let mergeCounts: Array<number> = [];
	const { pipeline, getState } = createFakePipeline({
		mergeInlinePreviewArtifacts: async (artifacts) => {
			mergeCounts = [artifacts.length];
			return artifacts;
		},
	});
	const compiled: ShowLatexCompiledPreview = {
		inline: true,
		previewPdfPath: "/tmp/operation-preview.pdf",
		text: "compiled",
	};
	const inlinePayload = await pipeline.buildInlinePreviewResult(compiled);
	const { rasterizeCalls } = getState();

	assert.equal(inlinePayload.inline, true);
	assert.equal(inlinePayload.text, "compiled");
	assert.equal(inlinePayload.previewPdfPath, "/tmp/operation-preview.pdf");
	assert.equal(rasterizeCalls.length, 1);
	assert.equal(rasterizeCalls[0].pdfPath, "/tmp/operation-preview.pdf");
	assert.equal(rasterizeCalls[0].dpi, 150);
	assert.equal(mergeCounts.length, 1);
	assert.equal(mergeCounts[0], 2);
	assert.equal(inlinePayload.payload.details.preview_id, "inline-preview-id");
	assert.equal(inlinePayload.payload.details.pdf, "/tmp/operation-preview.pdf");
	assert.equal(inlinePayload.payload.details.inline_previews.length, 2);
	assert.match(inlinePayload.payload.content[0].text, /image_path=\/tmp\/page-1\.png/);
});


test("does not shape inline artifacts when inline=false at compile stage", async () => {
	const { pipeline, getState } = createFakePipeline();
	const compiled = await pipeline.compileAndPreviewLatex({
		latexSource: "x",
		inline: false,
	});

	assert.equal(compiled.inline, false);
	assert.equal(compiled.text, "tex:1");
	assert.equal(getState().sourceCalls.length, 1);
	assert.equal(getState().rasterizeCalls.length, 0);
});

test("inline result builder propagates rasterization failures", async () => {
	const { pipeline } = createFakePipeline({
		rasterizePdfPages: async () => {
			throw new Error("inline rasterization failed");
		},
	});

	const compiled: ShowLatexCompiledPreview = {
		inline: true,
		previewPdfPath: "/tmp/operation-preview.pdf",
		text: "compiled",
	};
	await assert.rejects(
		() => pipeline.buildInlinePreviewResult(compiled),
		/inline rasterization failed/,
	);
});

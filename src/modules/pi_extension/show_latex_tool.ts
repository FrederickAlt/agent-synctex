import { copyFileSync, existsSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	createShowLatexPreviewPipeline,
	type ShowLatexCompiledPreview,
	type ShowLatexWorkspaceContext,
} from "../preview/show_latex_pipeline.ts";
import {
	createLatexFileCompileToolSupport,
	DEFAULT_LATEX_COMPILER,
	LATEX_COMPILERS,
	type LatexCompiler,
} from "../latex/latex_file_compiler.ts";
import { mergeInlinePreviewArtifacts, rasterizePdfPages } from "../preview/inline_preview.ts";
import { buildInlinePreviewToolPayload } from "../preview/inline_preview_payload.ts";
import { openTrackedPdfForContext } from "../pdf_session/pdf_session.ts";
import { type HostServiceOpenResponseDetails } from "../host_service.ts";
import { type SynctexCallbackConfig } from "../synctex/synctex.ts";
import {
	createHostServiceClient,
	extractHostServiceErrorCode,
	hostServiceSocketPath,
	HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS,
	hostServiceWorkspaceContextForRequest,
} from "./host_service_client.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
import { getMcpFixedPreviewPdfPath, getMcpTmpDir } from "./runtime_paths.ts";
import { renderShowLatexResult, rememberInlinePreviewRenderState } from "./inline_renderer.ts";
import { errorMessage, latexToolFailure, tailText } from "./error_utils.ts";

const latexFileCompileToolSupport = createLatexFileCompileToolSupport();

const LatexCompilerParam = Type.Optional(Type.Union(
	LATEX_COMPILERS.map((compiler) => Type.Literal(compiler)),
	{
		description: `Optional LaTeX compiler. Defaults to ${DEFAULT_LATEX_COMPILER}.`,
		default: DEFAULT_LATEX_COMPILER,
	},
));

const ShowLatexParams = Type.Object(
	{
		source: Type.String({
			description: "Raw LaTeX source code to compile. Prefer passing this tool as FREEFORM/raw text. Optional leading front matter can set compiler and inline, for example: ---\ncompiler: lualatex\ninline: false\n---",
			minLength: 1,
		}),
		compiler: LatexCompilerParam,
		inline: Type.Optional(Type.Boolean({
			description: "When true, rasterize the compiled PDF and show it inline in the Pi TUI instead of requesting a host-service external preview. Defaults to true.",
			default: true,
		})),
	},
	{ additionalProperties: false },
);

const showLatexPreviewPipeline = createShowLatexPreviewPipeline({
	resolveLatexCompiler(compiler: unknown): LatexCompiler | undefined {
		return latexFileCompileToolSupport.resolveLatexCompiler(compiler);
	},
	async callShowLatex(latexSource, compiler, _synctexEditorCommand, signal, options) {
		const workspaceContext = options?.workspaceContext ?? hostServiceWorkspaceContextForRequest(undefined);
		const client = createHostServiceClient();
		const compileResult = await client.requestCompileLatexSnippet(
			{
				latex_source: latexSource,
				compiler: compiler,
				...(options?.suppressPageNumbers === true ? { suppress_page_numbers: true } : {}),
				...(options?.cropToContent === true ? { crop_to_content: true } : {}),
			},
			workspaceContext,
			signal,
			HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS,
		);
		return { text: "ok", pdfPath: compileResult.pdf, sourcePath: compileResult.source };
	},
	rememberInlinePreviewRenderState,
	async rasterizePdfPages(pdfPath, options) {
		const client = createHostServiceClient();
		const rasterResult = await client.requestRasterizePdf(
			{ pdf_path: pdfPath },
			options?.workspaceContext ?? hostServiceWorkspaceContextForRequest(undefined),
			options?.signal,
		);
		return rasterResult.artifacts;
	},
	mergeInlinePreviewArtifacts,
	buildInlinePreviewToolPayload,
});

function hostServiceWorkspaceContextForShowLatex(ctx?: ExtensionContext): ShowLatexWorkspaceContext {
	return {
		...hostServiceWorkspaceContextForRequest(ctx),
		workspace_root: getMcpTmpDir(),
	};
}

function fixedPreviewPdfPath(): string {
	return getMcpFixedPreviewPdfPath();
}

function copySynctexArtifactsForFixedPdfPath(sourcePdfPath: string, fixedPdfPath: string): void {
	const sourceBase = sourcePdfPath.toLowerCase().endsWith(".pdf") ? sourcePdfPath.slice(0, -4) : sourcePdfPath;
	const fixedBase = fixedPdfPath.toLowerCase().endsWith(".pdf") ? fixedPdfPath.slice(0, -4) : fixedPdfPath;
	for (const extension of [".synctex", ".synctex.gz"] as const) {
		const sourceArtifactPath = `${sourceBase}${extension}`;
		const fixedArtifactPath = `${fixedBase}${extension}`;
		if (existsSync(sourceArtifactPath)) {
			copyFileSync(sourceArtifactPath, fixedArtifactPath);
			continue;
		}
		if (existsSync(fixedArtifactPath)) {
			rmSync(fixedArtifactPath);
		}
	}
}

function describeShowLatexHostServiceOpenFailure(error: unknown): string {
	const message = errorMessage(error).toLowerCase();
	const errorCode = extractHostServiceErrorCode(error);

	if (message.includes("viewer service request timed out") || message.includes("host service request timed out")) {
		return "Host service request timed out while opening preview";
	}
	if (errorCode === "backend_unavailable") {
		return "Host service backend unavailable while opening preview";
	}
	if (errorCode) {
		return `Host service unavailable while opening preview (code=${errorCode})`;
	}
	if (message.includes("viewer service unavailable") || message.includes("host service unavailable")) {
		return "Host service unavailable while opening preview";
	}
	return "Host service unavailable while opening preview";
}

function openPdfThroughHostService(
	pdfPath: string,
	workspaceContext: ShowLatexWorkspaceContext,
	callbackConfig: SynctexCallbackConfig,
	signal?: AbortSignal,
): Promise<HostServiceOpenResponseDetails> {
	const client = createHostServiceClient();
	return client.requestOpenPdf(
		workspaceContext,
		{
			pdf_path: pdfPath,
			callback: callbackConfig,
			reuse_existing: true,
			require_persistent_viewer: true,
		},
		signal,
	);
}

export function registerShowLatexTool(pi: ExtensionAPI, callbackManager: SynctexCallbackManager): void {
	pi.registerTool({
		name: "show_latex",
		label: "Show LaTeX",
		description:
			"FREEFORM/raw LaTeX preview. Pass LaTeX code directly; optional YAML-like front matter may set compiler and inline. Example: ---\ncompiler: lualatex\ninline: false\n---\n\\begin{equation}\nx\n\\end{equation}\nThe \\begin{document}...\\end{document} wrapper is accepted but not required. Defaults to inline preview with lualatex; set inline=false to request host-service external open instead.",
		promptSnippet: "FREEFORM LaTeX preview; optional front matter can set compiler and inline",
		promptGuidelines: [
			"Use show_latex when the user asks for a LaTeX PDF preview. Prefer passing only the LaTeX body, for example \\[x\\]; \\begin{document}...\\end{document} is accepted but usually unnecessary.",
			"Use optional front matter only when changing options, for example: ---\ncompiler: xelatex\ninline: false\n---",
			"show_latex renders inline by default; set inline=false only when the user wants an external viewer.",
			"Do not use verbatim-like LaTeX constructs (for example, \\begin{verbatim}, lstlisting, minted, or \\verb) to show the user LaTeX code; provide real LaTeX that compiles and renders the requested content.",
			"In an existing LaTeX project, assume ./preamble.tex or ./praeamble.tex has already been copied into ${XDG_RUNTIME_DIR}/tex-actions/preamble.tex. Do not add a standalone \\documentclass or repeat the project preamble unless the user explicitly asks.",
			"If a project snippet preview fails, inspect the log and project preamble, or restore the project preamble in ${XDG_RUNTIME_DIR}/tex-actions/preamble.tex. Do not call set_latex_preamble with a minimal preamble as a workaround unless the user explicitly asks to change the active preview preamble."
		],
		renderShell: "self",
		parameters: ShowLatexParams,
		prepareArguments: showLatexPreviewPipeline.prepareShowLatexArguments,
		renderResult: renderShowLatexResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let latexSource = "";
			let compiler: LatexCompiler | undefined;
			let synctexCommand = "";
			let previewPdfPath = "";
			let preview: ShowLatexCompiledPreview;
			let inline = true;
			const workspaceContext = hostServiceWorkspaceContextForShowLatex(ctx);

			try {
				const parsed = showLatexPreviewPipeline.parseShowLatexInput(String(params.source ?? ""));
				latexSource = parsed.latexSource;
				compiler = parsed.compiler !== undefined ? parsed.compiler : latexFileCompileToolSupport.resolveLatexCompiler(params.compiler);
				inline = parsed.inline !== undefined ? parsed.inline : params.inline !== false;
				if (!inline) {
					if (!ctx) {
						throw new Error("show_latex with inline=false requires a Pi agent session context");
					}
					synctexCommand = (await callbackManager.ensureSynctexCallbacks(ctx)).command;
				}
				preview = await showLatexPreviewPipeline.compileAndPreviewLatex({
					latexSource,
					compiler,
					inline,
					signal,
					workspaceContext,
					synctexEditorCommand: inline ? undefined : synctexCommand,
				});
				previewPdfPath = preview.previewPdfPath;
			} catch (error) {
				throw latexToolFailure("show-latex", "LaTeX preview compilation failed", {
					compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
					inline,
					latex_source_length: latexSource.length,
					latex_source_tail: tailText(latexSource, 30_000),
					pdf: previewPdfPath,
					fixed_preview_pdf: fixedPreviewPdfPath(),
				},
				error,
			);
			}

			if (preview.inline) {
				const inlineResult = await showLatexPreviewPipeline.buildInlinePreviewResult(preview, signal);
				return inlineResult.payload;
			}

			try {
				const callbackTargetId = await callbackManager.ensureHostServiceCallbackTarget(ctx!);
				const callbackConfig = (await callbackManager.ensureSynctexCallbacks(ctx!)).callbackConfig;
				if (previewPdfPath !== fixedPreviewPdfPath()) {
					copyFileSync(previewPdfPath, fixedPreviewPdfPath());
					copySynctexArtifactsForFixedPdfPath(previewPdfPath, fixedPreviewPdfPath());
				}
				const openResponse = await openPdfThroughHostService(
					fixedPreviewPdfPath(),
					workspaceContext,
					callbackConfig,
					signal,
				);
				if (openResponse.pdf_id === undefined) {
					throw new Error("Host service open response missing pdf_id");
				}
				const trackedOpenResult = {
					pid: openResponse.pid,
					viewerHandle: openResponse.handle,
					viewerBackend: openResponse.backend,
					viewerOwned: openResponse.owned,
					viewerCapabilities: openResponse.capabilities,
					hostServicePdfId: openResponse.pdf_id,
					hostServiceSocketPath: hostServiceSocketPath(),
					hostServiceCallbackTargetId: callbackTargetId,
				};
				let trackedPdf: Awaited<ReturnType<typeof openTrackedPdfForContext>>;
				const defaultSourceForPdf = preview.sourcePath ?? previewPdfPath;
				try {
					trackedPdf = await openTrackedPdfForContext(
						ctx,
						fixedPreviewPdfPath(),
						signal,
						async () => trackedOpenResult,
						defaultSourceForPdf,
						synctexCommand || undefined,
						{
							reuseTrackedPdf: false,
							pdfId: openResponse.pdf_id,
						},
					);
				} catch (error) {
					if (openResponse.pdf_id !== undefined) {
						await createHostServiceClient().requestClosePdf(workspaceContext, openResponse.pdf_id, signal).catch(() => undefined);
					}
					throw error;
				}
				return {
					content: [{ type: "text", text: preview.text }],
					details: {
						pdf: trackedPdf.path,
						pdf_id: trackedPdf.id,
						operation_pdf: previewPdfPath,
						inline: false,
					},
				};
			} catch (error) {
				throw latexToolFailure("show-latex", describeShowLatexHostServiceOpenFailure(error), {
					compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
					inline,
					latex_source_length: latexSource.length,
					latex_source_tail: tailText(latexSource, 30_000),
					preview_pdf: previewPdfPath,
					fixed_preview_pdf: fixedPreviewPdfPath(),
					open_error: errorMessage(error),
					open_error_code: extractHostServiceErrorCode(error),
				},
				error,
			);
			}
		},
	});
}

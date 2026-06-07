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
import {
	createHostServiceClient,
	extractHostServiceErrorCode,
	HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS,
	hostServiceWorkspaceContextForRequest,
} from "./host_service_client.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
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
	async callShowLatex(latexSource, compiler, signal, options) {
		const workspaceContext = options?.workspaceContext ?? hostServiceWorkspaceContextForRequest(undefined);
		const client = createHostServiceClient();
		const compileResult = await client.requestCompileLatexSnippet(
			{
				latex_source: latexSource,
				compiler: compiler,
				...(options?.suppressPageNumbers === true ? { suppress_page_numbers: true } : {}),
				...(options?.cropToContent === true ? { crop_to_content: true } : {}),
				...(options?.openPdf === true ? { open_pdf: true } : {}),
				...(options?.fixedPreview === undefined ? {} : { fixed_preview: options.fixedPreview }),
				...(options?.openPdfReuseExisting === undefined ? {} : { reuse_existing: options.openPdfReuseExisting }),
				...(options?.openPdfRequirePersistentViewer === undefined
					? {}
					: { require_persistent_viewer: options.openPdfRequirePersistentViewer }),
				...(options?.openPdfCallback === undefined ? {} : { callback: options.openPdfCallback }),
			},
			workspaceContext,
			signal,
			HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS,
		);
		return {
			text: "ok",
			pdfPath: compileResult.pdf,
			sourcePath: compileResult.source,
			operationPdfPath: compileResult.operation_pdf,
			targetPdfId: compileResult.pdf_id,
			managedRecord: compileResult.managed_record,
		};
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
	return hostServiceWorkspaceContextForRequest(ctx);
}

function describeShowLatexHostServiceOpenFailure(error: unknown): string {
	const message = errorMessage(error).toLowerCase();
	const errorCode = extractHostServiceErrorCode(error);

	if (
		message.includes("viewer backend request timed out")
		|| message.includes("host service managed viewer request timed out")
		|| message.includes("host service request timed out")
	) {
		return "Host service managed viewer request timed out while opening preview";
	}
	if (errorCode === "backend_unavailable") {
		return `Host service managed viewer backend unavailable while opening preview (code=${errorCode})`;
	}
	if (errorCode === "service_unavailable") {
		return `Host service managed viewer unavailable while opening preview (code=${errorCode})`;
	}
	if (errorCode) {
		return `Host service managed viewer unavailable while opening preview (code=${errorCode})`;
	}
	if (
		message.includes("viewer backend unavailable")
		|| message.includes("host service managed viewer unavailable")
		|| message.includes("host service unavailable")
	) {
		return "Host service managed viewer unavailable while opening preview";
	}
	return "Host service managed viewer unavailable while opening preview";
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
			"In an existing LaTeX project, assume ./preamble.tex or ./praeamble.tex has already been copied into the current agent’s TeX Actions runtime preamble. Do not add a standalone \\documentclass or repeat the project preamble unless the user explicitly asks.",
			"If a project snippet preview fails, inspect the log and project preamble, or restore the current agent’s TeX Actions runtime preamble. Do not call set_latex_preamble with a minimal preamble as a workaround unless the user explicitly asks to change the active preview preamble."
		],
		renderShell: "self",
		parameters: ShowLatexParams,
		prepareArguments: showLatexPreviewPipeline.prepareShowLatexArguments,
		renderResult: renderShowLatexResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let latexSource = "";
			let compiler: LatexCompiler | undefined;
			let previewPdfPath = "";
			let preview: ShowLatexCompiledPreview;
			let inline = true;
			const workspaceContext = hostServiceWorkspaceContextForShowLatex(ctx);

			try {
				const parsed = showLatexPreviewPipeline.parseShowLatexInput(String(params.source ?? ""));
				latexSource = parsed.latexSource;
				compiler = parsed.compiler !== undefined ? parsed.compiler : latexFileCompileToolSupport.resolveLatexCompiler(params.compiler);
				inline = parsed.inline !== undefined ? parsed.inline : params.inline !== false;
				let openPdfCallback: { kind: "pi-synctex-callback-v1"; transport: "unix"; socket_path: string; token: string } | undefined;
				if (!inline) {
					if (!ctx) {
						throw new Error("show_latex with inline=false requires a Pi agent session context");
					}
					openPdfCallback = (await callbackManager.ensureSynctexCallbacks(ctx)).callbackConfig;
				}
				preview = await showLatexPreviewPipeline.compileAndPreviewLatex({
					latexSource,
					compiler,
					inline,
					signal,
					workspaceContext,
					...(inline
						? {}
						: {
							openPdf: true,
							openPdfReuseExisting: true,
							openPdfRequirePersistentViewer: true,
							openPdfCallback,
							fixedPreview: true,
						}),
				});
				previewPdfPath = preview.previewPdfPath;
			} catch (error) {
				const errorCode = extractHostServiceErrorCode(error);
				const errorText = errorMessage(error);
				if (
					!inline && (
						/host service request timed out/i.test(errorText)
						|| /host service managed viewer request timed out/i.test(errorText)
						|| /viewer backend request timed out/i.test(errorText)
						|| (errorCode !== undefined && errorCode !== "compile_failed")
					)
				) {
					throw latexToolFailure("show-latex", describeShowLatexHostServiceOpenFailure(error), {
						compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
						inline,
						latex_source_length: latexSource.length,
						latex_source_tail: tailText(latexSource, 30_000),
						preview_pdf: previewPdfPath,
						open_error: errorText,
						open_error_code: errorCode,
					},
					error,
				);
				}
				throw latexToolFailure("show-latex", "LaTeX preview compilation failed", {
					compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
					inline,
					latex_source_length: latexSource.length,
					latex_source_tail: tailText(latexSource, 30_000),
					pdf: previewPdfPath,
				},
				error,
			);
			}

			if (preview.inline) {
				const inlineResult = await showLatexPreviewPipeline.buildInlinePreviewResult(preview, signal);
				return inlineResult.payload;
			}

			try {
				const managedRecord = preview.managedRecord;
				if (preview.targetPdfId === undefined) {
					throw new Error("Host service compile/open response missing pdf_id");
				}
				return {
					content: [{ type: "text", text: preview.text }],
					details: {
						pdf: managedRecord?.pdfPath || preview.previewPdfPath,
						source: managedRecord?.defaultSourcePath ?? preview.sourcePath,
						pdf_id: preview.targetPdfId,
						viewer_handle: managedRecord?.viewerHandle,
						viewer_backend: managedRecord?.viewerBackend,
						viewer_owned: managedRecord?.viewerOwned,
						viewer_capabilities: managedRecord?.capabilities,
						operation_pdf: preview.operationPdfPath ?? previewPdfPath,
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
					open_error: errorMessage(error),
					open_error_code: extractHostServiceErrorCode(error),
				},
				error,
			);
			}
		},
	});
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	createUniversalToolFacade,
	registerTracerTools,
	type TracerToolDefinition,
} from "../pi_adapter/pi_adapter.ts";
import {
	createLatexFileCompileToolSupport,
	DEFAULT_LATEX_COMPILER,
	LATEX_COMPILERS,
	type LatexCompiler,
} from "../latex/latex_file_compiler.ts";
import {
	type HostServiceCompileResponseDetails,
	type HostServiceCompileSnippetResponseDetails,
} from "../host_service.ts";
import { openTrackedPdfForContext } from "../pdf_session/pdf_session.ts";
import {
	createHostServiceClient,
	extractHostServiceErrorCode,
	hostServiceSocketPath,
	hostServiceWorkspaceContextForRequest,
} from "./host_service_client.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
import { errorMessage, latexToolFailure } from "./error_utils.ts";

const latexFileCompileToolSupport = createLatexFileCompileToolSupport();

const LatexCompilerParam = Type.Optional(Type.Union(
	LATEX_COMPILERS.map((compiler) => Type.Literal(compiler)),
	{
		description: `Optional LaTeX compiler. Defaults to ${DEFAULT_LATEX_COMPILER}.`,
		default: DEFAULT_LATEX_COMPILER,
	},
));

const CompileLatexFileParams = Type.Object(
	{
		latex_file_path: Type.String({
			description: "Path to a local LaTeX source file to compile in its own directory. Relative \\input, \\include, graphics, bibliography, and other project files are resolved from the file's directory by the LaTeX compiler.",
			minLength: 1,
		}),
		compiler: LatexCompilerParam,
		open_pdf: Type.Optional(Type.Boolean({
			description: "When true, request the host service to open and track the compiled PDF after successful compilation. Defaults to false.",
			default: false,
		})),
		clean: Type.Optional(Type.Boolean({
			description: "When true, remove common LaTeX artifacts for this source file's basename before compiling, including the previous PDF and SyncTeX sidecar. Defaults to false.",
			default: false,
		})),
	},
	{ additionalProperties: false },
);

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostServiceCompileErrorDetails(
	error: unknown,
): (HostServiceCompileResponseDetails | { operation?: string; source?: string; pdf?: string; clean?: boolean; cleaned_artifacts?: unknown; error_code?: string }) | undefined {
	if (!error || typeof error !== "object") {
		return;
	}
	const statusDetails = "statusDetails" in error ? (error as { statusDetails?: unknown }).statusDetails : undefined;
	if (!isStringRecord(statusDetails)) {
		return;
	}
	if (typeof statusDetails.operation === "string" && !["compile_latex_file", "compile_latex_snippet"].includes(statusDetails.operation)) {
		return;
	}
	if (typeof statusDetails.source !== "string" || typeof statusDetails.pdf !== "string") {
		return;
	}
	return statusDetails as unknown as HostServiceCompileResponseDetails | HostServiceCompileSnippetResponseDetails;
}

function stringsOrEmpty(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.every((entry) => typeof entry === "string") ? value : [];
}

function describeCompileFailureContext(
	requestedPath: string,
	compileResult: { source: string; pdf: string; clean: boolean; cleaned_artifacts: string[] } | undefined,
	error: unknown,
): { source: string; pdf: string; clean: boolean; cleaned_artifacts: string[] } {
	const details = hostServiceCompileErrorDetails(error);
	if (details) {
		return {
			source: typeof details.source === "string" ? details.source : requestedPath,
			pdf: typeof details.pdf === "string" ? details.pdf : "",
			clean: typeof details.clean === "boolean" ? details.clean : false,
			cleaned_artifacts: stringsOrEmpty(details.cleaned_artifacts),
		};
	}
	if (compileResult !== undefined) return compileResult;
	return { source: requestedPath, pdf: "", clean: false, cleaned_artifacts: [] };
}

function isOpenFailureFromCompileError(error: unknown): boolean {
	const details = hostServiceCompileErrorDetails(error);
	return typeof details?.pdf === "string" && details.pdf.length > 0 && details.error_code !== "compile_failed";
}

function resolveLatexFilePath(latexFilePath: string, cwd = process.cwd()): string {
	return latexFileCompileToolSupport.resolveLatexFilePath(latexFilePath, cwd);
}

export function registerCompileLatexFileTool(pi: ExtensionAPI, callbackManager: SynctexCallbackManager): void {
	const compileLatexFileToolFacade = createUniversalToolFacade({
		"compile_latex_file": async (_toolCallId, params, signal, _onUpdate, ctx) => {
			let requestedPath = "";
			let compileResult: { source: string; pdf: string; clean: boolean; cleaned_artifacts: string[] } | undefined;
			let openResult: { pdf_id?: number; pdf: string; source: string } | undefined;
			let synctexCommand = "";
			let compiler: LatexCompiler | undefined;
			let shouldOpenPdf = false;
			let shouldClean = false;
			let targetId = "";
			try {
				requestedPath = String(params.latex_file_path ?? "");
				if (!requestedPath.trim()) {
					throw new Error("latex_file_path must be a non-empty string");
				}

				const requestedPathInWorkspace = resolveLatexFilePath(requestedPath, ctx?.cwd ?? process.cwd());
				compiler = latexFileCompileToolSupport.resolveLatexCompiler(params.compiler);
				shouldOpenPdf = params.open_pdf === true;
				shouldClean = params.clean === true;
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const client = createHostServiceClient();
				const compileRequest: {
					latex_file_path: string;
					compiler?: string;
					clean?: boolean;
					open_pdf?: boolean;
					callback_target_id?: string;
				} = {
					latex_file_path: requestedPathInWorkspace,
					...(shouldClean ? { clean: true } : {}),
				};
				if (compiler !== undefined) {
					compileRequest.compiler = compiler;
				}
				if (shouldOpenPdf && ctx) {
					targetId = await callbackManager.ensureHostServiceCallbackTarget(ctx);
					compileRequest.open_pdf = true;
					compileRequest.callback_target_id = targetId;
				}
				const compileResponse = await client.requestCompileLatexFile(compileRequest, workspaceContext, signal);
				compileResult = {
					source: compileResponse.source,
					pdf: compileResponse.pdf,
					clean: compileResponse.clean,
					cleaned_artifacts: compileResponse.cleaned_artifacts,
				};

				if (!shouldOpenPdf) {
					return {
						content: [{ type: "text", text: `ok: ${compileResult.pdf}` }],
						details: {
							source: compileResult.source,
							pdf: compileResult.pdf,
							clean: compileResult.clean,
							cleaned_artifacts: compileResult.cleaned_artifacts,
						},
					};
				}

				if (!ctx) {
					throw new Error("compile_latex_file with open_pdf=true requires a Pi agent session context");
				}
				synctexCommand = (await callbackManager.ensureSynctexCallbacks(ctx)).command;
				const trackedPdf = await openTrackedPdfForContext(
					ctx,
					compileResponse.pdf,
					signal,
					async () => {
						const managedRecord = compileResponse.managed_record;
						return {
							pid: managedRecord?.pid,
							viewerHandle: managedRecord?.viewerHandle,
							viewerBackend: managedRecord?.viewerBackend,
							viewerOwned: managedRecord?.viewerOwned,
							viewerCapabilities: managedRecord?.capabilities,
							hostServicePdfId: compileResponse.pdf_id,
							hostServiceSocketPath: hostServiceSocketPath(),
							hostServiceCallbackTargetId: targetId,
						};
					},
					compileResponse.source,
					synctexCommand,
					{
						reuseTrackedPdf: false,
						pdfId: compileResponse.pdf_id,
					},
				);
				openResult = {
					pdf_id: trackedPdf.id,
					pdf: trackedPdf.path,
					source: trackedPdf.sourceFile ?? compileResponse.source,
				};
				const pidText = trackedPdf.pid === undefined ? "" : ` pid=${trackedPdf.pid}`;
				return {
					content: [{ type: "text", text: `ok: pdf_id=${trackedPdf.id}${pidText} pdf=${trackedPdf.path}` }],
					details: {
						source: trackedPdf.sourceFile ?? compileResponse.source,
						pdf: trackedPdf.path,
						pdf_id: trackedPdf.id,
						pid: trackedPdf.pid,
						viewer_handle: trackedPdf.viewerHandle,
						viewer_backend: trackedPdf.viewerBackend,
						viewer_owned: trackedPdf.viewerOwned,
						viewer_capabilities: trackedPdf.viewerCapabilities,
						clean: compileResponse.clean,
						cleaned_artifacts: compileResponse.cleaned_artifacts,
					},
				};
			} catch (error) {
				const failureContext = describeCompileFailureContext(requestedPath, compileResult, error);
				if (openResult === undefined && shouldOpenPdf && isOpenFailureFromCompileError(error)) {
					throw latexToolFailure("compile-latex-file", "LaTeX compile succeeded but opening failed", {
						requested_path: requestedPath,
						source: failureContext.source,
						compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
						open_pdf: shouldOpenPdf,
						clean: failureContext.clean,
						cleaned_artifacts: failureContext.cleaned_artifacts,
						pdf: failureContext.pdf,
						target_id: targetId,
						open_error: errorMessage(error),
						open_error_code: extractHostServiceErrorCode(error),
					}, error);
				}
				throw latexToolFailure("compile-latex-file", "LaTeX compile failed", {
					requested_path: requestedPath,
					source: failureContext.source,
					compiler: compiler ?? params.compiler ?? DEFAULT_LATEX_COMPILER,
					open_pdf: shouldOpenPdf,
					clean: failureContext.clean,
					cleaned_artifacts: failureContext.cleaned_artifacts,
					pdf: failureContext.pdf,
					callback_target_id: shouldOpenPdf ? targetId : undefined,
				}, error);
			}
		},
	});

	const compileLatexFileTool: TracerToolDefinition = {
		name: "compile_latex_file",
		label: "Compile LaTeX File",
		description:
			"Compile an existing local LaTeX source file from its own directory. Defaults to lualatex; pass compiler to choose lualatex, pdflatex, xelatex, or latexmk. Set clean=true to remove common same-basename LaTeX artifacts before compiling. Set open_pdf=true to request a host-service open/track for the successfully compiled PDF; leave it false (the default) to compile without requesting external service state.",
		promptSnippet: "Compile a local LaTeX file as PDF",
		promptGuidelines: [
			"Prefer compile_latex_file over invoking a bare compiler directly when the user has an existing .tex file to build.",
			"By default this compiles only. Leave open_pdf false (or omit it) when you want to compile without requesting external service state; set open_pdf=true only when the user wants the compiled PDF opened/tracked by the host service immediately.",
			"Use clean=true when stale or broken same-basename LaTeX artifacts may be causing problems. It removes common artifacts such as .aux, .log, .out, .pdf, .synctex, and .synctex.gz before compiling.",
			"Use this for complete .tex documents. File compiles run in the file's own directory so relative includes and assets resolve normally, and the fixed temp preamble is not injected.",
			"For multi-file LaTeX projects, compile the root file that produces the PDF, such as main.tex, and use open_pdf=true only when a host-service-tracked PDF is needed. The returned pdf_id identifies the running service-tracked PDF and can be reused for jumps into any included .tex file via jump_pdf with source_file set explicitly.",
		],
		parameters: CompileLatexFileParams,
	};

	registerTracerTools(pi, compileLatexFileToolFacade, [compileLatexFileTool]);
}

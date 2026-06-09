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
	type LatexDiagnosticSummary,
} from "../latex/latex_file_compiler.ts";
import {
	type HostServiceCompileResponseDetails,
	type HostServiceCompileSnippetResponseDetails,
} from "../host_service.ts";
import {
	createHostServiceClient,
	extractHostServiceErrorCode,
	HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS,
	hostServiceWorkspaceContextForRequest,
} from "./host_service_client.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
import { errorMessage, latexToolFailure } from "./error_utils.ts";

const latexFileCompileToolSupport = createLatexFileCompileToolSupport();

const LatexCompilerParam = Type.Optional(Type.Union(
	LATEX_COMPILERS.map((compiler) => Type.Literal(compiler)),
	{
		description: `Optional TeX engine for latexmk. Defaults to ${DEFAULT_LATEX_COMPILER}; latexmk uses the hardened default LuaLaTeX-backed mode.`,
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
		continuous: Type.Optional(Type.Boolean({
			description: "All file compiles use latexmk. When true, immediately compile with non-continuous latexmk then subscribe this session to one shared host-service latexmk -pvc compiler for the normalized root file; latexmk handles multi-file dependency tracking with -norc, recorder/SyncTeX-friendly flags, no shell escape, and no latexmk-owned viewer. When false, immediately compile then unsubscribe this session, stopping the compiler only when no other sessions remain. Omit continuous to leave continuous compilation unchanged.",
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

function warningSummary(warnings: LatexDiagnosticSummary[] | undefined, count: number | undefined, truncated: boolean | undefined): string {
	if (!count || !warnings?.length) return "";
	const lines = warnings.slice(0, 5).map((warning) => `- ${warning.message}`);
	const suffix = truncated ? "\n- ... more warnings omitted" : "";
	return `\nWarnings:\n${lines.join("\n")}${suffix}`;
}

function continuousSummary(details: HostServiceCompileResponseDetails): string {
	const continuous = details.continuous;
	if (!continuous) return "";
	const pid = continuous.pid === undefined ? "" : ` pid=${continuous.pid}`;
	const error = continuous.error ? ` error=${continuous.error}` : "";
	return `\nContinuous: ${continuous.status} subscribers=${continuous.subscriber_count}${pid} root=${continuous.root_source}${error}`;
}

function compileSuccessText(details: HostServiceCompileResponseDetails): string {
	const status = details.compile_status ?? "ok";
	const warningCount = details.warning_count ? ` warnings=${details.warning_count}` : "";
	const exitCode = status === "nonzero_but_pdf_updated" ? ` exit_code=${details.compiler_exit_code ?? "unknown"}` : "";
	const prefix = status === "ok" ? "ok" : status;
	return `${prefix}: ${details.pdf}${exitCode}${warningCount}\nLog: ${details.log}${continuousSummary(details)}${warningSummary(details.warnings, details.warning_count, details.warnings_truncated)}`;
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
	const compileErrorCodes = new Set(["compile_failed", "failed_no_pdf", "failed_stale_pdf_exists", "compile_timeout", "compile_aborted", "compiler_start_failed"]);
	return typeof details?.pdf === "string" && details.pdf.length > 0 && !compileErrorCodes.has(String(details.error_code ?? ""));
}

function resolveLatexFilePath(latexFilePath: string, cwd = process.cwd()): string {
	return latexFileCompileToolSupport.resolveLatexFilePath(latexFilePath, cwd);
}

export function registerCompileLatexFileTool(pi: ExtensionAPI, callbackManager: SynctexCallbackManager): void {
	const compileLatexFileToolFacade = createUniversalToolFacade({
		"compile_latex_file": async (_toolCallId, params, signal, _onUpdate, ctx) => {
			let requestedPath = "";
			let compileResult: HostServiceCompileResponseDetails | undefined;

			let compiler: LatexCompiler | undefined;
			let shouldOpenPdf = false;
			let shouldClean = false;
			let continuous: boolean | undefined;
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
				if (params.continuous !== undefined) {
					if (typeof params.continuous !== "boolean") {
						throw new Error("continuous must be a boolean");
					}
					continuous = params.continuous;
				}
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const client = createHostServiceClient();
				const compileRequest: {
					latex_file_path: string;
					compiler?: string;
					clean?: boolean;
					open_pdf?: boolean;
					continuous?: boolean;
					callback_target_id?: string;
				} = {
					latex_file_path: requestedPathInWorkspace,
					...(shouldClean ? { clean: true } : {}),
				};
				if (compiler !== undefined) {
					compileRequest.compiler = compiler;
				}
				if (continuous !== undefined) {
					compileRequest.continuous = continuous;
				}
				if (shouldOpenPdf && ctx) {
					targetId = await callbackManager.ensureHostServiceCallbackTarget(ctx);
					compileRequest.open_pdf = true;
					compileRequest.callback_target_id = targetId;
				}
				const compileResponse = await client.requestCompileLatexFile(
					compileRequest,
					workspaceContext,
					signal,
					HOST_SERVICE_COMPILE_REQUEST_TIMEOUT_MS,
				);
				compileResult = compileResponse;

				if (!shouldOpenPdf) {
					return {
						content: [{ type: "text", text: compileSuccessText(compileResult) }],
						details: {
							source: compileResult.source,
							pdf: compileResult.pdf,
							log: compileResult.log,
							continuous: compileResult.continuous,
							clean: compileResult.clean,
							cleaned_artifacts: compileResult.cleaned_artifacts,
							compile_status: compileResult.compile_status,
							compiler_exit_code: compileResult.compiler_exit_code,
							compiler_signal: compileResult.compiler_signal,
							warning_count: compileResult.warning_count,
							warnings: compileResult.warnings,
							warnings_truncated: compileResult.warnings_truncated,
						},
					};
				}

				if (!ctx) {
					throw new Error("compile_latex_file with open_pdf=true requires a Pi agent session context");
				}
				await callbackManager.ensureSynctexCallbacks(ctx);
				if (compileResponse.pdf_id === undefined) {
					throw new Error("host service returned no pdf_id for open_pdf=true compile request");
				}
				const managedRecord = compileResponse.managed_record;
				const pidText = managedRecord?.pid === undefined ? "" : ` pid=${managedRecord.pid}`;
				const status = compileResponse.compile_status ?? "ok";
				const warningCount = compileResponse.warning_count ? ` warnings=${compileResponse.warning_count}` : "";
				return {
					content: [{ type: "text", text: `${status}: pdf_id=${compileResponse.pdf_id}${pidText} pdf=${compileResponse.pdf}${warningCount}\nLog: ${compileResponse.log}${continuousSummary(compileResponse)}${warningSummary(compileResponse.warnings, compileResponse.warning_count, compileResponse.warnings_truncated)}` }],
					details: {
						source: compileResponse.source,
						pdf: compileResponse.pdf,
						pdf_id: compileResponse.pdf_id,
						continuous: compileResponse.continuous,
						pid: managedRecord?.pid,
						viewer_handle: managedRecord?.viewerHandle,
						viewer_backend: managedRecord?.viewerBackend,
						viewer_owned: managedRecord?.viewerOwned,
						viewer_capabilities: managedRecord?.capabilities,
						managed_record: managedRecord,
						clean: compileResponse.clean,
						cleaned_artifacts: compileResponse.cleaned_artifacts,
						log: compileResponse.log,
						compile_status: compileResponse.compile_status,
						compiler_exit_code: compileResponse.compiler_exit_code,
						compiler_signal: compileResponse.compiler_signal,
						warning_count: compileResponse.warning_count,
						warnings: compileResponse.warnings,
						warnings_truncated: compileResponse.warnings_truncated,
					},
				};
			} catch (error) {
				const failureContext = describeCompileFailureContext(requestedPath, compileResult, error);
				if (shouldOpenPdf && isOpenFailureFromCompileError(error)) {
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
			"Compile an existing local LaTeX source file from its own directory using latexmk. Defaults to lualatex; pass compiler to choose the TeX engine latexmk should run: lualatex, pdflatex, xelatex, or latexmk default behavior. Set clean=true to remove common same-basename LaTeX artifacts before compiling. Set open_pdf=true to request a host-service open/track for the successfully compiled PDF; leave it false (the default) to compile without requesting external service state. Set continuous=true to compile once and subscribe this session to shared latexmk -pvc recompilation; set continuous=false to compile once and unsubscribe this session; omit continuous for a latexmk-backed one-shot compile that leaves continuous state unchanged.",
		promptSnippet: "Compile a local LaTeX file as PDF",
		promptGuidelines: [
			"Prefer compile_latex_file over invoking a bare compiler directly when the user has an existing .tex file to build.",
			"By default this compiles only. Leave open_pdf false (or omit it) when you want to compile without requesting external service state; set open_pdf=true only when the user wants the compiled PDF opened/tracked by the host service immediately.",
			"Use clean=true when stale or broken same-basename LaTeX artifacts may be causing problems. It removes common artifacts such as .aux, .log, .out, .pdf, .synctex, and .synctex.gz before compiling.",
			"Use continuous=true for iterative project editing. Omit continuous for a latexmk-backed one-shot compile that does not alter continuous state. Use continuous=false to stop only this session's subscription; close_pdf does not stop continuous compilation.",
			"File compilation requires latexmk. If compile_latex_file reports latexmk is unavailable, install MacTeX or TeX Live; BasicTeX users may need to install latexmk separately and ensure it is on PATH.",
			"latexmk starts with -norc, -view=none, recorder/SyncTeX-friendly flags, selected-engine configuration, and -no-shell-escape engine commands so project latexmkrc files cannot override default commands or launch a latexmk-owned viewer. Continuous mode adds -pvc.",
			"Continuous subscriptions are tied to the agent session heartbeat. If the session stops heartbeating, the Host Service removes the subscription and stops unreferenced compilers; unresolved background failures are delivered later as pending [system info] messages and cleared by later success or delivery.",
			"latexmk handles multi-file dependency tracking, including included files and bibliography dependencies; the Host Service intentionally does not recursively watch the project tree.",
			"Use this for complete .tex documents. File compiles run in the file's own directory so relative includes and assets resolve normally, and the fixed temp preamble is not injected.",
			"For multi-file LaTeX projects, compile the root file that produces the PDF, such as main.tex, and use open_pdf=true only when a host-service-tracked PDF is needed. The returned pdf_id identifies the running service-tracked PDF and can be reused for jumps into any included .tex file via jump_pdf with source_file set explicitly.",
		],
		parameters: CompileLatexFileParams,
	};

	registerTracerTools(pi, compileLatexFileToolFacade, [compileLatexFileTool]);
}

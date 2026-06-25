import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
	applyLatexPreamble,
	DEFAULT_SNIPPET_PREAMBLE,
} from "./latex/latex_preamble.ts";
import {
	createLatexFileCompileToolSupport,
	latexmkEngineIdentity,
	LoggedToolError,
	type LatexCompileStatus,
	type LatexDiagnosticSummary,
	type LatexFileCompileRequest,
	type LatexFileCompileResult,
} from "./latex/latex_file_compiler.ts";
import { resolveFixedPreviewPdfPath } from "./host_service_fixed_preview_pdf_path.ts";
import { getMcpFixedPreviewPdfPath } from "./runtime_paths.ts";
import type {
	HostServiceCallbackTarget,
	HostServiceCompileRequest,
	HostServiceCompileSnippetRequest,
	HostServiceCompileSnippetResponseEnvelope,
	HostServiceCompileResponseEnvelope,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
	HostServiceWorkspaceContext,
} from "./host_service_protocol.ts";
import { createLogger } from "./logging.ts";
import {
	buildLatexmkFreshnessSnapshot,
	HostServiceCompileCoordinationError,
	HostServiceRootCompileCoordinator,
} from "./host_service_root_compile_coordinator.ts";

const logger = createLogger("host-service.compile");

const REQUIRED_DIRECTORY_MODE = 0o700;
const DEFAULT_HOST_SERVICE_TMPDIR = process.env.MCP_TMPDIR ?? resolve(process.env.XDG_RUNTIME_DIR || process.env.HOME || process.cwd(), "tex-actions");
const HOST_SERVICE_SNIPPET_WORKDIR_NAME = "host-service-snippets";
const HOST_SERVICE_SNIPPET_PREAMBLE_FILE_NAMES = [
	"preamble.tex",
	"praeamble.tex",
] as const;
const hostServiceLatexFileCompiler = createLatexFileCompileToolSupport();

interface HostServiceManagedViewerServiceLike {
	openViewer(request: HostServiceOpenRequest): Promise<HostServiceOpenResponseEnvelope>;
	markPdfUpdated?(pdfPath: string): Promise<unknown>;
}

type CompileRequest = HostServiceCompileRequest | HostServiceCompileSnippetRequest;

interface CompileDiagnosticsDetails {
	compile_status?: LatexCompileStatus;
	compiler_exit_code?: number | null;
	compiler_signal?: string | null;
	warning_count?: number;
	warnings?: LatexDiagnosticSummary[];
	warnings_truncated?: boolean;
	error_summary?: string;
	diagnostics?: LatexDiagnosticSummary[];
}

export interface HostServiceCompileServiceOptions {
	protocolVersion: number;
	managedViewerService: HostServiceManagedViewerServiceLike;
	resolveManagedOpenCallback: (
		workspaceContext: HostServiceWorkspaceContext,
		callbackTargetId: string | undefined,
		callbackTarget: HostServiceCallbackTarget | undefined,
	) => Promise<HostServiceCallbackTarget | undefined>;
	nowNs?: () => number;
	rootCompileCoordinator?: HostServiceRootCompileCoordinator;
}

export class HostServiceCompileService {
	private readonly protocolVersion: number;
	private readonly managedViewerService: HostServiceManagedViewerServiceLike;
	private readonly resolveManagedOpenCallback: HostServiceCompileServiceOptions["resolveManagedOpenCallback"];
	private readonly nowNs: () => number;
	private readonly rootCompileCoordinator: HostServiceRootCompileCoordinator;
	private readonly activeCompileAbortControllers = new Set<AbortController>();

	constructor(options: HostServiceCompileServiceOptions) {
		this.protocolVersion = options.protocolVersion;
		this.managedViewerService = options.managedViewerService;
		this.resolveManagedOpenCallback = options.resolveManagedOpenCallback;
		this.nowNs = options.nowNs ?? (() => Date.now() * 1_000_000);
		this.rootCompileCoordinator = options.rootCompileCoordinator ?? new HostServiceRootCompileCoordinator();
	}

	start(): void {
		this.rootCompileCoordinator.resume();
	}

	stop(): void {
		const stoppedError = new HostServiceCompileCoordinationError(
			"host service stopped while compile request was in progress",
			"host_service_stopped",
		);
		for (const controller of this.activeCompileAbortControllers) {
			controller.abort(stoppedError);
		}
		this.rootCompileCoordinator.stop(stoppedError);
	}

	private recordLastCompileSuccess(
		rootKey: string,
		rootSource: string,
		compilerIdentity: string,
		result: LatexFileCompileResult,
		compiledAfterMs: number,
		canRecord: boolean,
	): void {
		if (!canRecord) {
			return;
		}
		this.rootCompileCoordinator.recordLastResult(rootKey, {
			rootSource,
			compilerIdentity,
			outcome: { status: "success", value: result },
			freshness: buildLatexmkFreshnessSnapshot({
				rootSource,
				pdfPath: result.pdfPath,
				logPath: result.logPath,
				compiledAfterMs,
				requirePdf: true,
			}),
		});
	}

	private recordLastCompileFailure(
		rootKey: string,
		rootSource: string,
		compilerIdentity: string,
		error: unknown,
		compiledAfterMs: number,
		canRecord: boolean,
	): void {
		if (!canRecord) {
			return;
		}
		const logPath = error instanceof LoggedToolError ? error.logPath : inferLatexLogPath(rootSource);
		this.rootCompileCoordinator.recordLastResult(rootKey, {
			rootSource,
			compilerIdentity,
			outcome: { status: "failure", error },
			freshness: buildLatexmkFreshnessSnapshot({
				rootSource,
				logPath,
				compiledAfterMs,
				requirePdf: false,
			}),
		});
	}

	async compileLatexFileRequest(request: HostServiceCompileRequest, signal?: AbortSignal): Promise<HostServiceCompileResponseEnvelope> {
		const stopAbortController = new AbortController();
		this.activeCompileAbortControllers.add(stopAbortController);
		const compileSignal = signal === undefined ? stopAbortController.signal : AbortSignal.any([signal, stopAbortController.signal]);
		try {
			return await this.compileLatexFileRequestInner(request, compileSignal);
		} finally {
			this.activeCompileAbortControllers.delete(stopAbortController);
		}
	}

	private async compileLatexFileRequestInner(request: HostServiceCompileRequest, signal?: AbortSignal): Promise<HostServiceCompileResponseEnvelope> {
		const startedAt = Date.now();
		const requestedPath = request.details.latex_file_path;
		const normalizedPath = normalizeLatexSourcePath(requestedPath, request.workspace_context.cwd);
		const shouldClean = request.details.clean === true;
		const cleanArtifacts: string[] = [];
		const resolvedLogPath = inferLatexLogPath(normalizedPath);
		logger.info("compile_file.begin", {
			request_id: request.request_id,
			source_path: normalizedPath,
			compiler: request.details.compiler,
			clean: shouldClean,
			open_pdf: request.details.open_pdf === true,
		});

		try {
			const resolvedCompiler = hostServiceLatexFileCompiler.resolveLatexCompiler(request.details.compiler);
			const compilerIdentity = latexmkEngineIdentity(resolvedCompiler);
			const rootKey = normalizeLatexRootKey(normalizedPath);
			const compileRequest: LatexFileCompileRequest = {
				requestedPath,
				compiler: request.details.compiler,
				clean: shouldClean,
				cwd: request.workspace_context.cwd,
				signal,
			};
			const throwIfAborted = () => {
				if (signal?.aborted !== true) {
					return;
				}
				if (signal.reason instanceof Error) {
					throw signal.reason;
				}
				throw new HostServiceCompileCoordinationError("compile request cancelled", "compile_cancelled");
			};
			const result = await this.rootCompileCoordinator.runExclusive(
				rootKey,
				async () => {
					if (shouldClean) {
						this.rootCompileCoordinator.clearLastResult(rootKey);
					}
					const compiledAfterMs = Date.now();
					try {
						const freshResult = await hostServiceLatexFileCompiler.compileLatexFile(compileRequest);
						this.recordLastCompileSuccess(rootKey, normalizedPath, compilerIdentity, freshResult, compiledAfterMs, true);
						return freshResult;
					} catch (compileError) {
						this.recordLastCompileFailure(rootKey, normalizedPath, compilerIdentity, compileError, compiledAfterMs, true);
						throw compileError;
					}
				},
				signal,
			);
			throwIfAborted();
			const resultLogPath = inferLatexLogPath(result.source);
			const nowNs = this.nowNs();
			for (const cleaned of result.cleanedArtifacts) {
				if (!cleanArtifacts.includes(cleaned)) {
					cleanArtifacts.push(cleaned);
				}
			}
			const artifactPaths = getExistingArtifacts(result.pdfPath, resultLogPath);
			if (request.details.open_pdf !== true) {
				await this.markCompiledPdfUpdated(result.pdfPath, request.request_id);
			}
			const openResponse = await this.openCompiledPdfThroughManagedViewerAfterCompile(
				request,
				result.source,
				result.pdfPath,
				resultLogPath,
				shouldClean,
				cleanArtifacts,
				artifactPaths,
				nowNs,
			);
			if (openResponse !== undefined && openResponse.operation !== "open_pdf") {
				logger.warn("compile_file.open_error", {
					request_id: request.request_id,
					duration_ms: Date.now() - startedAt,
					compile_status: result.compileStatus,
					pdf_path: result.pdfPath,
					log_path: resultLogPath,
					open_status: openResponse.status,
					error: openResponse.error,
				});
				return openResponse;
			}
			logger.info("compile_file.end", {
				request_id: request.request_id,
				duration_ms: Date.now() - startedAt,
				compile_status: result.compileStatus,
				compiler_exit_code: result.compilerExitCode,
				warning_count: result.warningCount,
				source_path: result.source,
				pdf_path: result.pdfPath,
				log_path: resultLogPath,
				pdf_id: openResponse?.status_details.pdf_id,
			});
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: request.operation,
				status: "ok",
				generated_at_ns: nowNs,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: request.operation,
					source: result.source,
					pdf: result.pdfPath,
					log: resultLogPath,
					clean: shouldClean,
					cleaned_artifacts: cleanArtifacts,
					artifact_paths: artifactPaths,
					...compileDiagnosticsDetails(result),
					pdf_id: openResponse?.status_details.pdf_id,
					viewer_url: openResponse?.status_details.viewer_url,
					managed_record: openResponse?.status_details.managed_record,
				},
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const log = error instanceof LoggedToolError ? error.logPath : resolvedLogPath;
			const errorPdf = error instanceof LoggedToolError && error.pdfPath ? error.pdfPath : "";
			logger.error("compile_file.error", {
				request_id: request.request_id,
				duration_ms: Date.now() - startedAt,
				source_path: normalizedPath,
				pdf_path: errorPdf,
				log_path: log,
				error_code: extractCompileErrorCode(error),
				error,
			});
			const nowNs = this.nowNs();
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: request.operation,
				status: "error",
				generated_at_ns: nowNs,
				error: errorMessage,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: request.operation,
					source: normalizedPath,
					pdf: errorPdf,
					log,
					clean: shouldClean,
					cleaned_artifacts: cleanArtifacts,
					...compileErrorDiagnosticsDetails(error),
					error_code: extractCompileErrorCode(error),
					artifact_paths: getExistingArtifacts(errorPdf, log),
				},
			};
		}
	}

	async compileLatexSnippetRequest(request: HostServiceCompileSnippetRequest): Promise<HostServiceCompileSnippetResponseEnvelope> {
		const startedAt = Date.now();
		const shouldClean = false;
		const cleanArtifacts: string[] = [];
		let sourcePath = "";
		logger.info("compile_snippet.begin", {
			request_id: request.request_id,
			compiler: request.details.compiler,
			open_pdf: request.details.open_pdf === true,
			fixed_preview: request.details.fixed_preview === true,
			crop_to_content: request.details.crop_to_content === true,
			suppress_page_numbers: request.details.suppress_page_numbers === true,
		});

		try {
			sourcePath = buildSnippetLatexSourcePath(request.workspace_context);
			const source = request.details.latex_source;
			const workspacePreamble = resolveWorkspacePreambleForCompile(request.workspace_context);
			const preamble = workspacePreamble || DEFAULT_SNIPPET_PREAMBLE;
			const wrappedSource = applyLatexPreamble(source, preamble, {
				cropToContent: request.details.crop_to_content === true,
				suppressPageNumbers: request.details.suppress_page_numbers === true,
			});
			writeFileSync(sourcePath, wrappedSource, { mode: 0o600 });
			const compileRequest: LatexFileCompileRequest = {
				requestedPath: sourcePath,
				compiler: request.details.compiler,
				clean: shouldClean,
				cwd: dirname(sourcePath),
			};
			const result = await hostServiceLatexFileCompiler.compileLatexFile(compileRequest);
			const logPath = inferLatexLogPath(result.source);
			const nowNs = this.nowNs();
			const operationPdfPath = result.pdfPath;
			const operationArtifactPaths = getExistingArtifacts(operationPdfPath, logPath);
			const fixedPreviewPdfPath = request.details.open_pdf && request.details.fixed_preview === true
				? resolveFixedPreviewPdfPath(getMcpFixedPreviewPdfPath())
				: undefined;
			const previewPdfPath = fixedPreviewPdfPath ?? operationPdfPath;
			const artifactPaths = fixedPreviewPdfPath === undefined
				? operationArtifactPaths
				: [...this.copySnippetArtifactsToFixedPath(operationPdfPath, fixedPreviewPdfPath), ...getExistingArtifacts(logPath)];
			if (request.details.open_pdf !== true) {
				await this.markCompiledPdfUpdated(previewPdfPath, request.request_id);
			}
			const openResponse = await this.openCompiledPdfThroughManagedViewerAfterCompile(
				request,
				result.source,
				previewPdfPath,
				logPath,
				shouldClean,
				cleanArtifacts,
				artifactPaths,
				nowNs,
			);
			if (openResponse !== undefined && openResponse.operation !== "open_pdf") {
				logger.warn("compile_snippet.open_error", {
					request_id: request.request_id,
					duration_ms: Date.now() - startedAt,
					compile_status: result.compileStatus,
					pdf_path: previewPdfPath,
					operation_pdf_path: operationPdfPath,
					log_path: logPath,
					open_status: openResponse.status,
					error: openResponse.error,
				});
				return openResponse;
			}
			logger.info("compile_snippet.end", {
				request_id: request.request_id,
				duration_ms: Date.now() - startedAt,
				compile_status: result.compileStatus,
				compiler_exit_code: result.compilerExitCode,
				warning_count: result.warningCount,
				source_path: result.source,
				pdf_path: previewPdfPath,
				operation_pdf_path: operationPdfPath,
				log_path: logPath,
				pdf_id: openResponse?.status_details.pdf_id,
			});
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: request.operation,
				status: "ok",
				generated_at_ns: nowNs,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: request.operation,
					source: result.source,
					pdf: previewPdfPath,
					operation_pdf: operationPdfPath,
					log: logPath,
					clean: shouldClean,
					cleaned_artifacts: cleanArtifacts,
					artifact_paths: artifactPaths,
					...compileDiagnosticsDetails(result),
					operation_artifact_paths: operationArtifactPaths,
					pdf_id: openResponse?.status_details.pdf_id,
					viewer_url: openResponse?.status_details.viewer_url,
					managed_record: openResponse?.status_details.managed_record,
				},
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const source = sourcePath;
			const log = error instanceof LoggedToolError ? error.logPath : (source ? inferLatexLogPath(source) : "");
			const errorPdf = error instanceof LoggedToolError && error.pdfPath ? error.pdfPath : "";
			logger.error("compile_snippet.error", {
				request_id: request.request_id,
				duration_ms: Date.now() - startedAt,
				source_path: source,
				pdf_path: errorPdf,
				log_path: log,
				error_code: extractCompileErrorCode(error),
				error,
			});
			const nowNs = this.nowNs();
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: request.operation,
				status: "error",
				generated_at_ns: nowNs,
				error: errorMessage,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: request.operation,
					source,
					pdf: errorPdf,
					log,
					clean: shouldClean,
					cleaned_artifacts: cleanArtifacts,
					...compileErrorDiagnosticsDetails(error),
					error_code: extractCompileErrorCode(error),
					artifact_paths: getExistingArtifacts(errorPdf, log),
				},
			};
		}
	}

	private async markCompiledPdfUpdated(pdfPath: string, requestId: string): Promise<void> {
		try {
			await this.managedViewerService.markPdfUpdated?.(pdfPath);
		} catch (error) {
			logger.warn("compile.mark_pdf_updated_error", {
				request_id: requestId,
				pdf_path: pdfPath,
				error,
			});
		}
	}

	private openCompiledPdfThroughManagedViewerAfterCompile(
		request: HostServiceCompileRequest,
		source: string,
		pdf: string,
		log: string,
		clean: boolean,
		cleanedArtifacts: string[],
		artifactPaths: string[],
		nowNs: number,
	): Promise<HostServiceOpenResponseEnvelope | HostServiceCompileResponseEnvelope | undefined>;
	private openCompiledPdfThroughManagedViewerAfterCompile(
		request: HostServiceCompileSnippetRequest,
		source: string,
		pdf: string,
		log: string,
		clean: boolean,
		cleanedArtifacts: string[],
		artifactPaths: string[],
		nowNs: number,
	): Promise<HostServiceOpenResponseEnvelope | HostServiceCompileSnippetResponseEnvelope | undefined>;
	private async openCompiledPdfThroughManagedViewerAfterCompile(
		request: CompileRequest,
		source: string,
		pdf: string,
		log: string,
		clean: boolean,
		cleanedArtifacts: string[],
		artifactPaths: string[],
		nowNs: number,
	): Promise<HostServiceOpenResponseEnvelope | HostServiceCompileResponseEnvelope | HostServiceCompileSnippetResponseEnvelope | undefined> {
		if (!request.details.open_pdf) {
			return undefined;
		}

		const buildCompileOpenFailureResponse = (errorText: string, errorCode: string) => {
			return request.operation === "compile_latex_file"
				? this.buildCompileOpenFailureResponse(
						request,
						source,
						pdf,
						log,
						clean,
						cleanedArtifacts,
						artifactPaths,
						errorText,
						errorCode,
						nowNs,
					)
				: this.buildCompileOpenFailureResponse(
						request,
						source,
						pdf,
						log,
						clean,
						cleanedArtifacts,
						artifactPaths,
						errorText,
						errorCode,
						nowNs,
					);
		};

		const requiresCallbackResolution = request.details.callback_target_id !== undefined || request.details.callback !== undefined;
		const openCallback = requiresCallbackResolution
			? await this.resolveManagedOpenCallback(
				request.workspace_context,
				request.details.callback_target_id,
				request.details.callback,
			)
			: undefined;

		if (requiresCallbackResolution && openCallback === undefined) {
			return buildCompileOpenFailureResponse(
				"open_pdf callback configuration is missing or stale for this workspace",
				"invalid_request",
			);
		}

		let openResponse: HostServiceOpenResponseEnvelope;
		try {
			openResponse = await this.openCompiledPdfThroughManagedViewer(
				request.request_id,
				request.workspace_context,
				pdf,
				openCallback,
				request.details.reuse_existing,
				request.details.require_persistent_viewer,
			);
		} catch (error) {
			return buildCompileOpenFailureResponse(
				error instanceof Error ? error.message : String(error),
				"backend_unavailable",
			);
		}

		if (openResponse.status === "error") {
			return buildCompileOpenFailureResponse(
				openResponse.error || "failed to open compiled PDF",
				openResponse.status_details.error_code ?? "backend_unavailable",
			);
		}

		return openResponse;
	}

	private buildCompileOpenFailureResponse(
		request: HostServiceCompileRequest,
		source: string,
		pdf: string,
		log: string,
		clean: boolean,
		cleanedArtifacts: string[],
		artifactPaths: string[],
		errorText: string,
		errorCode: string,
		nowNs: number,
	): HostServiceCompileResponseEnvelope;
	private buildCompileOpenFailureResponse(
		request: HostServiceCompileSnippetRequest,
		source: string,
		pdf: string,
		log: string,
		clean: boolean,
		cleanedArtifacts: string[],
		artifactPaths: string[],
		errorText: string,
		errorCode: string,
		nowNs: number,
	): HostServiceCompileSnippetResponseEnvelope;
	private buildCompileOpenFailureResponse(
		request: CompileRequest,
		source: string,
		pdf: string,
		log: string,
		clean: boolean,
		cleanedArtifacts: string[],
		artifactPaths: string[],
		errorText: string,
		errorCode: string,
		nowNs: number,
	): HostServiceCompileResponseEnvelope | HostServiceCompileSnippetResponseEnvelope {
		return {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: request.operation,
			status: "error",
			generated_at_ns: nowNs,
			error: errorText,
			status_details: {
				protocol_version: this.protocolVersion,
				supported: false,
				service_available: false,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: request.operation,
				source,
				pdf,
				log,
				clean,
				cleaned_artifacts: cleanedArtifacts,
				artifact_paths: artifactPaths,
				error_code: errorCode,
			},
		} as HostServiceCompileResponseEnvelope | HostServiceCompileSnippetResponseEnvelope;
	}

	private async openCompiledPdfThroughManagedViewer(
		requestId: string,
		workspaceContext: HostServiceWorkspaceContext,
		pdfPath: string,
		callback: HostServiceCallbackTarget | undefined,
		reuseExisting?: boolean,
		requirePersistentViewer?: boolean,
	): Promise<HostServiceOpenResponseEnvelope> {
		return this.managedViewerService.openViewer({
			protocol_version: this.protocolVersion,
			request_id: requestId,
			operation: "open_pdf",
			created_at_ns: this.nowNs(),
			workspace_context: workspaceContext,
			details: {
				pdf_path: pdfPath,
				...(callback === undefined ? {} : { callback }),
				reuse_existing: reuseExisting ?? true,
				require_persistent_viewer: requirePersistentViewer ?? false,
			},
		});
	}

	private copySnippetArtifactsToFixedPath(operationPdfPath: string, fixedPdfPath: string): string[] {
		const operationBase = operationPdfPath.toLowerCase().endsWith(".pdf") ? operationPdfPath.slice(0, -4) : operationPdfPath;
		const fixedBase = fixedPdfPath.toLowerCase().endsWith(".pdf") ? fixedPdfPath.slice(0, -4) : fixedPdfPath;
		ensureDirectory(dirname(fixedPdfPath));
		if (existsSync(operationPdfPath) && operationPdfPath !== fixedPdfPath) {
			copyFileSync(operationPdfPath, fixedPdfPath);
		}
		for (const extension of [".synctex", ".synctex.gz"] as const) {
			const operationArtifactPath = `${operationBase}${extension}`;
			const fixedArtifactPath = `${fixedBase}${extension}`;
			if (existsSync(operationArtifactPath)) {
				if (operationArtifactPath !== fixedArtifactPath) {
					copyFileSync(operationArtifactPath, fixedArtifactPath);
				}
				continue;
			}
			if (existsSync(fixedArtifactPath)) {
				rmSync(fixedArtifactPath);
			}
		}
		if (!existsSync(fixedPdfPath)) {
			throw new Error(`failed to copy stable snippet PDF to fixed preview path: ${fixedPdfPath}`);
		}
		return getExistingArtifacts(fixedPdfPath, `${fixedBase}.synctex`, `${fixedBase}.synctex.gz`);
	}
}

function buildSnippetLatexSourcePath(workspaceContext: HostServiceWorkspaceContext): string {
	const workspaceRoot = workspaceContext.workspace_root ?? DEFAULT_HOST_SERVICE_TMPDIR;
	const snippetRoot = workspaceContext.workspace_root
		? join(workspaceRoot, HOST_SERVICE_SNIPPET_WORKDIR_NAME)
		: workspaceRoot;

	if (workspaceContext.workspace_root === undefined) {
		ensureDirectory(snippetRoot);
	} else {
		assertDirectorySafe(workspaceRoot, { enforceMode: false });
		ensureDirectory(snippetRoot);
	}

	const runDir = mkdtempSync(`${join(snippetRoot, "snippet-")}xxxxxx`);
	chmodSync(runDir, REQUIRED_DIRECTORY_MODE);
	return join(runDir, "snippet.tex");
}

function resolveWorkspacePreambleForCompile(context: HostServiceWorkspaceContext): string {
	const workspaceRoot = context.workspace_root ?? context.cwd;
	const preambleFile = resolveWorkspacePreambleFile(workspaceRoot);
	if (!preambleFile) {
		return "";
	}
	try {
		return readFileSync(preambleFile, "utf8").trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to read workspace preamble ${preambleFile}: ${message}`);
	}
}

function resolveWorkspacePreambleFile(workspaceRoot: string): string | null {
	for (const fileName of HOST_SERVICE_SNIPPET_PREAMBLE_FILE_NAMES) {
		const candidate = resolve(workspaceRoot, fileName);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

function expandHomePath(rawPath: string): string {
	if (rawPath === "~") {
		return process.env.HOME || rawPath;
	}
	if (rawPath.startsWith("~/")) {
		return process.env.HOME ? resolve(process.env.HOME, rawPath.slice(2)) : rawPath;
	}
	return rawPath;
}

function normalizeLatexSourcePath(rawSourcePath: string, workspaceCwd: string): string {
	const expandedPath = expandHomePath(rawSourcePath.trim());
	const resolved = isAbsolute(expandedPath) ? expandedPath : resolve(workspaceCwd, expandedPath);
	if (extname(resolved) === ".tex") {
		return resolved;
	}
	return resolved;
}

function normalizeLatexRootKey(normalizedSourcePath: string): string {
	return existsSync(normalizedSourcePath) ? realpathSync.native(normalizedSourcePath) : normalizedSourcePath;
}

function inferLatexLogPath(sourcePath: string): string {
	return join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.log`);
}

function getExistingArtifacts(...paths: string[]): string[] {
	const seen = new Set<string>();
	for (const path of paths) {
		if (!path || seen.has(path) || !existsSync(path)) {
			continue;
		}
		seen.add(path);
	}
	return Array.from(seen);
}

function ensureDirectory(path: string): void {
	try {
		lstatSync(path);
		assertDirectorySafe(path);
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			mkdirSync(path, { recursive: true, mode: REQUIRED_DIRECTORY_MODE });
			chmodSync(path, REQUIRED_DIRECTORY_MODE);
			assertDirectorySafe(path);
			return;
		}
		throw error;
	}
}

function assertDirectorySafe(path: string, options: { enforceMode?: boolean } = {}): void {
	const { enforceMode = true } = options;
	const st = lstatSync(path);
	if (st.isSymbolicLink()) {
		throw new Error(`host service path is a symlink: ${path}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`host service path is not a directory: ${path}`);
	}
	if (process.getuid?.() !== undefined && st.uid !== process.getuid()) {
		throw new Error(`host service path is not owned by current user: ${path}`);
	}
	if (enforceMode && (st.mode & 0o777) !== REQUIRED_DIRECTORY_MODE) {
		chmodSync(path, REQUIRED_DIRECTORY_MODE);
		if ((statSync(path).mode & 0o777) !== REQUIRED_DIRECTORY_MODE) {
			throw new Error(`host service path mode check failed after correction: ${path}`);
		}
	}
}

function compileDiagnosticsDetails(result: {
	compileStatus: LatexCompileStatus;
	compilerExitCode: number | null;
	compilerSignal: string | null;
	warningCount: number;
	warnings: LatexDiagnosticSummary[];
	warningsTruncated: boolean;
}): CompileDiagnosticsDetails {
	return {
		compile_status: result.compileStatus,
		compiler_exit_code: result.compilerExitCode,
		compiler_signal: result.compilerSignal,
		warning_count: result.warningCount,
		warnings: result.warnings,
		warnings_truncated: result.warningsTruncated,
	};
}

function compileErrorDiagnosticsDetails(error: unknown): CompileDiagnosticsDetails {
	if (!(error instanceof LoggedToolError)) return {};
	return {
		error_summary: error.diagnosticSummary,
		diagnostics: error.diagnostics,
	};
}

function extractCompileErrorCode(error: unknown): string {
	if (error instanceof LoggedToolError) {
		return error.errorCode;
	}
	if (error instanceof HostServiceCompileCoordinationError) {
		return error.errorCode;
	}
	if (error instanceof Error && /compiler/.test(error.message)) {
		return "compile_failed";
	}
	return "compile_failed";
}

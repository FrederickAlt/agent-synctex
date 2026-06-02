import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
	applyLatexPreamble,
	DEFAULT_SNIPPET_PREAMBLE,
} from "./latex/latex_preamble.ts";
import {
	createLatexFileCompileToolSupport,
	LoggedToolError,
	type LatexFileCompileRequest,
} from "./latex/latex_file_compiler.ts";
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
}

type CompileRequest = HostServiceCompileRequest | HostServiceCompileSnippetRequest;

export interface HostServiceCompileServiceOptions {
	protocolVersion: number;
	managedViewerService: HostServiceManagedViewerServiceLike;
	resolveManagedOpenCallback: (
		workspaceContext: HostServiceWorkspaceContext,
		callbackTargetId: string | undefined,
		callbackTarget: HostServiceCallbackTarget | undefined,
	) => Promise<HostServiceCallbackTarget | undefined>;
	nowNs?: () => number;
}

export class HostServiceCompileService {
	private readonly protocolVersion: number;
	private readonly managedViewerService: HostServiceManagedViewerServiceLike;
	private readonly resolveManagedOpenCallback: HostServiceCompileServiceOptions["resolveManagedOpenCallback"];
	private readonly nowNs: () => number;

	constructor(options: HostServiceCompileServiceOptions) {
		this.protocolVersion = options.protocolVersion;
		this.managedViewerService = options.managedViewerService;
		this.resolveManagedOpenCallback = options.resolveManagedOpenCallback;
		this.nowNs = options.nowNs ?? (() => Date.now() * 1_000_000);
	}

	async compileLatexFileRequest(request: HostServiceCompileRequest): Promise<HostServiceCompileResponseEnvelope> {
		const requestedPath = request.details.latex_file_path;
		const normalizedPath = normalizeLatexSourcePath(requestedPath, request.workspace_context.cwd);
		const shouldClean = request.details.clean === true;
		const cleanArtifacts: string[] = [];
		const resolvedLogPath = inferLatexLogPath(normalizedPath);

		try {
			const compileRequest: LatexFileCompileRequest = {
				requestedPath,
				compiler: request.details.compiler,
				clean: shouldClean,
				cwd: request.workspace_context.cwd,
			};
			const result = await hostServiceLatexFileCompiler.compileLatexFile(compileRequest);
			const resultLogPath = inferLatexLogPath(result.source);
			const nowNs = this.nowNs();
			for (const cleaned of result.cleanedArtifacts) {
				cleanArtifacts.push(cleaned);
			}
			const artifactPaths = getExistingArtifacts(result.pdfPath, resultLogPath);
			let openResponse: HostServiceOpenResponseEnvelope | undefined;
			if (request.details.open_pdf) {
				const openCallback = await this.resolveManagedOpenCallback(
					request.workspace_context,
					request.details.callback_target_id,
					request.details.callback,
				);
				if (openCallback === undefined) {
					return this.buildCompileOpenFailureResponse(
						request,
						result.source,
						result.pdfPath,
						resultLogPath,
						shouldClean,
						cleanArtifacts,
						artifactPaths,
						"open_pdf callback configuration is missing or stale for this workspace",
						"invalid_request",
						nowNs,
					);
				}
				try {
					openResponse = await this.openCompiledPdfThroughManagedViewer(
						request.request_id,
						request.workspace_context,
						result.pdfPath,
						openCallback,
					);
				} catch (error) {
					return this.buildCompileOpenFailureResponse(
						request,
						result.source,
						result.pdfPath,
						resultLogPath,
						shouldClean,
						cleanArtifacts,
						artifactPaths,
						error instanceof Error ? error.message : String(error),
						"backend_unavailable",
						nowNs,
					);
				}
				if (openResponse !== undefined && openResponse.status === "error") {
					return this.buildCompileOpenFailureResponse(
						request,
						result.source,
						result.pdfPath,
						resultLogPath,
						shouldClean,
						cleanArtifacts,
						artifactPaths,
						openResponse.error || "failed to open compiled PDF",
						openResponse.status_details.error_code ?? "backend_unavailable",
						nowNs,
					);
				}
			}
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
					pdf_id: openResponse?.status_details.pdf_id,
					managed_record: openResponse?.status_details.managed_record,
				},
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const log = error instanceof LoggedToolError ? error.logPath : resolvedLogPath;
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
					pdf: "",
					log,
					clean: shouldClean,
					cleaned_artifacts: cleanArtifacts,
					error_code: extractCompileErrorCode(error),
					artifact_paths: getExistingArtifacts(log),
				},
			};
		}
	}

	async compileLatexSnippetRequest(request: HostServiceCompileSnippetRequest): Promise<HostServiceCompileSnippetResponseEnvelope> {
		const shouldClean = false;
		const cleanArtifacts: string[] = [];
		let sourcePath = "";

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
			const artifactPaths = getExistingArtifacts(result.pdfPath, logPath);
			let openResponse: HostServiceOpenResponseEnvelope | undefined;
			if (request.details.open_pdf) {
				const openCallback = await this.resolveManagedOpenCallback(
					request.workspace_context,
					request.details.callback_target_id,
					request.details.callback,
				);
				if (openCallback === undefined) {
					return this.buildCompileOpenFailureResponse(
						request,
						result.source,
						result.pdfPath,
						logPath,
						shouldClean,
						cleanArtifacts,
						artifactPaths,
						"open_pdf callback configuration is missing or stale for this workspace",
						"invalid_request",
						nowNs,
					);
				}
				try {
					openResponse = await this.openCompiledPdfThroughManagedViewer(
						request.request_id,
						request.workspace_context,
						result.pdfPath,
						openCallback,
					);
				} catch (error) {
					return this.buildCompileOpenFailureResponse(
						request,
						result.source,
						result.pdfPath,
						logPath,
						shouldClean,
						cleanArtifacts,
						artifactPaths,
						error instanceof Error ? error.message : String(error),
						"backend_unavailable",
						nowNs,
					);
				}
				if (openResponse !== undefined && openResponse.status === "error") {
					return this.buildCompileOpenFailureResponse(
						request,
						result.source,
						result.pdfPath,
						logPath,
						shouldClean,
						cleanArtifacts,
						artifactPaths,
						openResponse.error || "failed to open compiled PDF",
						openResponse.status_details.error_code ?? "backend_unavailable",
						nowNs,
					);
				}
			}
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
					log: logPath,
					clean: shouldClean,
					cleaned_artifacts: cleanArtifacts,
					artifact_paths: artifactPaths,
					pdf_id: openResponse?.status_details.pdf_id,
					managed_record: openResponse?.status_details.managed_record,
				},
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const source = sourcePath;
			const log = error instanceof LoggedToolError ? error.logPath : (source ? inferLatexLogPath(source) : "");
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
					pdf: "",
					log,
					clean: shouldClean,
					cleaned_artifacts: cleanArtifacts,
					error_code: extractCompileErrorCode(error),
					artifact_paths: getExistingArtifacts(log),
				},
			};
		}
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
		callback: HostServiceCallbackTarget,
	): Promise<HostServiceOpenResponseEnvelope> {
		return this.managedViewerService.openViewer({
			protocol_version: this.protocolVersion,
			request_id: requestId,
			operation: "open_pdf",
			created_at_ns: this.nowNs(),
			workspace_context: workspaceContext,
			details: {
				pdf_path: pdfPath,
				callback,
				reuse_existing: true,
				require_persistent_viewer: false,
			},
		});
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

function normalizeLatexSourcePath(rawSourcePath: string, workspaceCwd: string): string {
	const resolved = isAbsolute(rawSourcePath) ? rawSourcePath : resolve(workspaceCwd, rawSourcePath);
	if (extname(resolved) === ".tex") {
		return resolved;
	}
	return resolved;
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

function extractCompileErrorCode(error: unknown): string {
	if (error instanceof LoggedToolError) {
		return "compile_failed";
	}
	if (error instanceof Error && /compiler/.test(error.message)) {
		return "compile_failed";
	}
	return "compile_failed";
}

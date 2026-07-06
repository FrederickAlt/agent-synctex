import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { HostServiceOpenResponseDetails } from "../host_service_protocol.ts";
import { createHostServiceClient, extractHostServiceErrorCode, hostServiceSocketPath, hostServiceWorkspaceContextForRequest } from "./host_service_client.ts";
import { SynctexCallbackManager } from "./synctex_callback_manager.ts";
import { errorMessage, latexToolFailure } from "./error_utils.ts";
import { appendViewerUrlAgentNotice } from "../viewer_url_agent_notice.ts";

const OpenPdfParams = Type.Object(
	{
		pdf_file_path: Type.String({
			description: "Path to an existing local PDF file to send to the host service for opening and later SyncTeX actions.",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

const ClosePdfParams = Type.Object(
	{
		pdf_id: Type.Number({
			description: "Host-service PDF ID returned by open_pdf or compile_latex_file(..., open_pdf=true).",
			minimum: 1,
		}),
	},
	{ additionalProperties: false },
);

const JumpPdfParams = Type.Object(
	{
		pdf_id: Type.Number({
			description: "Host-service PDF ID returned by open_pdf or compile_latex_file(..., open_pdf=true). Arbitrary PDF paths are not accepted.",
			minimum: 1,
		}),
		line: Type.Number({
			description: "1-based line in the selected source file. If source_file is provided, this line is interpreted within that file.",
			minimum: 1,
		}),
		source_file: Type.Optional(Type.String({
			description: "Optional source file for the SyncTeX jump. When the target is in a file included via \\input, \\include, or similar, pass that included .tex file and use a line number from that file, not the parent file's include line.",
			minLength: 1,
		})),
	},
	{ additionalProperties: false },
);

function resolvePositiveInteger(value: unknown, name: string): number {
	const numberValue = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(numberValue) || numberValue < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return numberValue;
}

export function registerPdfTools(pi: ExtensionAPI, callbackManager: SynctexCallbackManager): void {
	pi.registerTool({
		name: "open_pdf",
		label: "Open PDF",
		description: "Open an existing local PDF through the host service for later SyncTeX actions. Returns a daemon-owned host-service pdf_id. Opening the same PDF path again reuses the existing daemon-managed or visible viewer where practical. If a browser viewer is detected after launch/focus, only pdf_id/status is returned because the user can already see the output; if no live browser viewer is detected, the result includes a Viewer URL to pass to the user. The viewer is configured with this session's inverse SyncTeX callback so PDF clicks paste source references into the interactive editor without submitting.",
		promptSnippet: "Open a local PDF through the host service",
		promptGuidelines: [
			"Use open_pdf when the user asks to view an existing PDF or when you need a pdf_id for later PDF actions.",
			"Pass an existing local PDF path. The returned pdf_id is allocated and owned by the host-service daemon.",
			"Opening the same normalized PDF path again should return the existing daemon pdf_id instead of creating a duplicate viewer where practical.",
			"PDFs opened through the host service are wired to paste inverse SyncTeX clicks into the current interactive editor without triggering an agent turn when the backend supports it.",
		],
		parameters: OpenPdfParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let requestedPath = "";
			let pdfPath = "";
			let workspaceContext: { cwd: string; session_id?: string; workspace_root?: string } | undefined;
			let openResponse: HostServiceOpenResponseDetails | undefined;
			let socketPath = hostServiceSocketPath();
			try {
				requestedPath = String(params.pdf_file_path ?? "");
				if (!requestedPath.trim()) {
					throw new Error("pdf_file_path must be a non-empty string");
				}
				if (!ctx) {
					throw new Error("open_pdf requires a Pi agent session context");
				}
				workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const callbackServer = await callbackManager.ensureSynctexCallbacks(ctx);
				socketPath = hostServiceSocketPath();
				const hostServiceClient = createHostServiceClient(socketPath);
				openResponse = await hostServiceClient.requestOpenPdf(
					workspaceContext,
					{
						pdf_path: requestedPath,
						callback: callbackServer.callbackConfig,
						reuse_existing: true,
						require_persistent_viewer: true,
					},
					signal,
				);
				if (openResponse.pdf_id === undefined) {
					throw new Error("Host service open response missing pdf_id");
				}
				pdfPath = openResponse.pdf || openResponse.managed_record?.pdfPath || requestedPath;
				const pidText = openResponse.pid === undefined ? "" : ` pid=${openResponse.pid}`;
				const text = appendViewerUrlAgentNotice(`ok: pdf_id=${openResponse.pdf_id}${pidText} pdf=${pdfPath}`, openResponse);
				return {
					content: [{ type: "text", text }],
					details: {
						pdf_id: openResponse.pdf_id,
						pid: openResponse.pid,
						pdf: pdfPath,
						source: openResponse.managed_record?.defaultSourcePath,
						viewer_handle: openResponse.handle,
						viewer_backend: openResponse.backend,
						viewer_owned: openResponse.owned,
						viewer_capabilities: openResponse.capabilities,
					},
				};
			} catch (error) {
				if (openResponse?.pdf_id !== undefined && workspaceContext !== undefined) {
					await createHostServiceClient(socketPath).requestClosePdf(workspaceContext, openResponse.pdf_id, signal).catch(() => undefined);
				}
				throw latexToolFailure("open-pdf", "Open PDF failed", {
					requested_path: requestedPath,
					pdf: pdfPath,
					open_error: errorMessage(error),
					open_error_code: extractHostServiceErrorCode(error),
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "close_pdf",
		label: "Close PDF",
		description: "Request the host service to close a daemon-managed PDF by pdf_id. Service-managed windows are closed through private handle metadata. Unowned/reused handles are acknowledged as not closed to avoid killing user-owned processes. The active PDF ID is then removed from the daemon registry when close succeeds.",
		promptSnippet: "Close a tracked PDF via host service",
		promptGuidelines: [
			"Use close_pdf when the user asks to close a PDF previously opened and managed by the host service.",
			"Pass the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true).",
		],
		parameters: ClosePdfParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let pdfId = 0;
			try {
				pdfId = resolvePositiveInteger(params.pdf_id, "pdf_id");
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const result = await createHostServiceClient(hostServiceSocketPath()).requestClosePdf(workspaceContext, pdfId, signal);
				const reasonText = result.reason ? ` reason=${result.reason}` : "";
				const closedText = result.closed ? "closed=true" : "closed=false";
				return {
					content: [{ type: "text", text: `ok: pdf_id=${result.pdf_id} ${closedText}${reasonText}` }],
					details: {
						pdf_id: result.pdf_id,
						closed: result.closed,
						reason: result.reason,
					},
				};
			} catch (error) {
				throw latexToolFailure("close-pdf", "Close PDF failed", {
					pdf_id: pdfId || params.pdf_id,
				}, error);
			}
		},
	});

	pi.registerTool({
		name: "jump_pdf",
		label: "Jump PDF",
		description: "Perform a line-based host-service forward SyncTeX jump in an already tracked PDF. Requires the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); arbitrary PDF paths are not accepted. The PDF must have SyncTeX data, and the source file must be readable. Uses the tracked default source file when known, or pass source_file when no default source was inferred or when jumping to an included .tex file. On success, the text result names the jumped line and then shows the verbatim LaTeX source line.",
		promptSnippet: "Jump to a source line in a tracked PDF",
		promptGuidelines: [
			"Use jump_pdf to move an already tracked host-service PDF to a source line via forward SyncTeX.",
			"Pass the numeric pdf_id returned by open_pdf or compile_latex_file(..., open_pdf=true); do not pass arbitrary PDF paths.",
			"Reuse the same pdf_id for repeated jumps within one tracked PDF.",
			"source_file is optional only when the target line is in the tracked default source file; provide it whenever the target is in another source file or needs disambiguation.",
			"When the target content is in a file included by \\input, \\include, or similar, pass source_file as the included .tex file and use the line number from that included file. Do not jump to the parent file's \\input/\\include line unless that directive itself is the target.",
			"Mental model: pdf_id = viewer/PDF; source_file = TeX file containing the target line. For multi-file LaTeX, compile main.tex once and track its resulting PDF once, keep its pdf_id, and use jump_pdf(pdf_id, line, source_file=<included file>) for all fragments. Never open a new PDF merely because the target line is in another included file.",
			"After a successful jump, the tool result text names the jumped line and then shows the source line's verbatim LaTeX. Use it to verify that edits did not shift the intended target row.",
			"After a successful jump, do not tell the user which line you jumped to unless they explicitly ask for the exact line; the user will see the line in the PDF viewer.",
		],
		parameters: JumpPdfParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let pdfId = 0;
			let line = 0;
			let sourceFile: string | undefined;
			try {
				pdfId = resolvePositiveInteger(params.pdf_id, "pdf_id");
				line = resolvePositiveInteger(params.line, "line");
				sourceFile = params.source_file === undefined ? undefined : String(params.source_file);
				if (sourceFile !== undefined && !sourceFile.trim()) {
					throw new Error("source_file must be a non-empty string when provided");
				}
				if (!ctx) {
					throw new Error("jump_pdf requires a Pi agent session context");
				}
				await callbackManager.ensureSynctexCallbacks(ctx);
				const workspaceContext = hostServiceWorkspaceContextForRequest(ctx);
				const result = await createHostServiceClient().requestJumpPdf(
					workspaceContext,
					{
						pdf_id: pdfId,
						line,
						...(sourceFile === undefined ? {} : { source_file: sourceFile }),
					},
					signal,
				);
				const sourceLine = result.source_line ?? "";
				return {
					content: [{ type: "text", text: `line ${result.line ?? line} contains:\n${sourceLine}` }],
					details: {
						pdf_id: result.pdf_id ?? pdfId,
						line: result.line ?? line,
						source: result.source_file ?? sourceFile,
						pdf: result.pdf,
						reopened: result.reopened,
						source_line: sourceLine,
					},
				};
			} catch (error) {
				throw latexToolFailure("jump-pdf", "PDF jump failed", {
					pdf_id: pdfId || params.pdf_id,
					line: line || params.line,
					source_file: sourceFile ?? params.source_file,
				}, error);
			}
		},
	});
}

import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { assertReadablePdfFile, inferDefaultSourceFileForPdf } from "./pdf_tracking/pdf_tracking.ts";
import type {
	HostServiceCloseRequest,
	HostServiceCloseResponseEnvelope,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
} from "./host_service_protocol.ts";
import type { HostServiceMcpPdfOperations } from "./host_service_mcp.ts";
import { PdfJsViewerRegistry } from "./pdfjs_viewer_registry.ts";
import { PdfJsViewerServer } from "./pdfjs_viewer_server.ts";

const PDFJS_VIEWER_BACKEND_NAME = "pdfjs-browser";
const PDFJS_VIEWER_BACKEND_CAPABILITIES = {
	open: true,
	close: true,
	forward_search: false,
	inverse_search: false,
	reuse: true,
};
const DEFAULT_BROWSER_LAUNCH_SETTLE_MS = 250;

export interface BrowserLaunchResult {
	ok: boolean;
	command?: string;
	pid?: number;
	error?: string;
}

export interface BrowserLauncher {
	open(url: string): Promise<BrowserLaunchResult>;
}

export class DefaultBrowserLauncher implements BrowserLauncher {
	async open(url: string): Promise<BrowserLaunchResult> {
		const command = this.commandForPlatform(url);
		const commandText = [command.command, ...command.args].join(" ");
		try {
			const child = spawn(command.command, command.args, {
				detached: true,
				stdio: "ignore",
			});
			return await new Promise<BrowserLaunchResult>((resolve) => {
				let settled = false;
				const finish = (result: BrowserLaunchResult) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(result);
				};
				const timer = setTimeout(() => {
					child.unref();
					finish({ ok: true, command: commandText, pid: child.pid });
				}, DEFAULT_BROWSER_LAUNCH_SETTLE_MS);
				timer.unref?.();
				child.once("error", (error) => {
					finish({ ok: false, command: commandText, error: error.message });
				});
				child.once("exit", (code, signal) => {
					child.unref();
					if (code === 0) {
						finish({ ok: true, command: commandText, pid: child.pid });
						return;
					}
					finish({
						ok: false,
						command: commandText,
						pid: child.pid,
						error: signal ? `browser launcher exited with signal ${signal}` : `browser launcher exited with code ${code ?? "unknown"}`,
					});
				});
			});
		} catch (error) {
			return {
				ok: false,
				command: commandText,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private commandForPlatform(url: string): { command: string; args: string[] } {
		if (process.platform === "darwin") {
			return { command: "open", args: [url] };
		}
		if (process.platform === "win32") {
			return { command: "cmd", args: ["/c", "start", "", url] };
		}
		return { command: "xdg-open", args: [url] };
	}
}

export interface PdfJsViewerMcpServiceOptions {
	registry?: PdfJsViewerRegistry;
	server?: PdfJsViewerServer;
	browserLauncher?: BrowserLauncher;
}

export class PdfJsViewerMcpService {
	private readonly registry: PdfJsViewerRegistry;
	private readonly server: PdfJsViewerServer;
	private readonly browserLauncher: BrowserLauncher;
	readonly pdfOperations: HostServiceMcpPdfOperations;

	constructor(options: PdfJsViewerMcpServiceOptions = {}) {
		this.registry = options.registry ?? new PdfJsViewerRegistry();
		this.server = options.server ?? new PdfJsViewerServer({ registry: this.registry });
		this.browserLauncher = options.browserLauncher ?? new DefaultBrowserLauncher();
		this.pdfOperations = {
			openPdf: (request) => this.openPdf(request),
			closePdf: (request) => this.closePdf(request),
		};
	}

	async openPdf(request: HostServiceOpenRequest): Promise<HostServiceOpenResponseEnvelope> {
		const pdfPath = isAbsolute(request.details.pdf_path)
			? request.details.pdf_path
			: resolve(request.workspace_context.cwd, request.details.pdf_path);
		try {
			assertReadablePdfFile(pdfPath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "open_pdf",
				status: "error",
				generated_at_ns: Date.now() * 1_000_000,
				error: reason,
				status_details: {
					...this.openStatusBase(request, pdfPath),
					supported: false,
					service_available: false,
					owned: false,
					reused: false,
					error_code: reason.includes("must point to a PDF file") ? "invalid_pdf" : "invalid_request",
					reason,
				},
			};
		}

		await this.server.start();
		const existing = this.registry.findActiveRecordByPath(pdfPath);
		const record = this.registry.registerPdf({
			pdfPath,
			viewerUrlForPdfId: (pdfId) => this.server.viewerUrl(pdfId),
		});
		const launch = await this.browserLauncher.open(record.viewerUrl);
		return {
			protocol_version: request.protocol_version,
			request_id: request.request_id,
			operation: "open_pdf",
			status: "ok",
			generated_at_ns: Date.now() * 1_000_000,
			status_details: {
				...this.openStatusBase(request, pdfPath),
				supported: true,
				service_available: true,
				owned: true,
				reused: existing !== undefined,
				handle: record.viewerUrl,
				pdf_id: record.pdfId,
				viewer_url: record.viewerUrl,
				browser_launch: { ...launch },
				managed_record: {
					id: record.pdfId,
					pdfPath: record.pdfPath,
					viewerHandle: record.viewerUrl,
					viewerBackend: PDFJS_VIEWER_BACKEND_NAME,
					viewerOwned: true,
					createdAtNs: record.createdAtNs,
					reused: existing !== undefined,
					capabilities: PDFJS_VIEWER_BACKEND_CAPABILITIES,
					backendPath: PDFJS_VIEWER_BACKEND_NAME,
					defaultSourcePath: inferDefaultSourceFileForPdf(pdfPath),
					metadata: { viewer_url: record.viewerUrl, browser_launch: launch },
				},
			},
		};
	}

	async closePdf(request: HostServiceCloseRequest): Promise<HostServiceCloseResponseEnvelope> {
		let notifications = 0;
		try {
			notifications = this.server.notifyPdfClosed(request.pdf_id);
			const record = this.registry.closePdf(request.pdf_id);
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "close_pdf",
				status: "ok",
				generated_at_ns: Date.now() * 1_000_000,
				status_details: {
					protocol_version: request.protocol_version,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "close_pdf",
					backend: PDFJS_VIEWER_BACKEND_NAME,
					backend_path: PDFJS_VIEWER_BACKEND_NAME,
					backend_identity_ok: true,
					closed: true,
					handle: record.viewerUrl,
					pdf_id: request.pdf_id,
					viewer_notifications: notifications,
					reason: `untracked pdf_id=${request.pdf_id}; notified_viewers=${notifications}; browser windows may remain open`,
				},
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "close_pdf",
				status: "error",
				generated_at_ns: Date.now() * 1_000_000,
				error: reason,
				status_details: {
					protocol_version: request.protocol_version,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "close_pdf",
					backend: PDFJS_VIEWER_BACKEND_NAME,
					backend_path: PDFJS_VIEWER_BACKEND_NAME,
					backend_identity_ok: true,
					closed: false,
					pdf_id: request.pdf_id,
					viewer_notifications: notifications,
					error_code: "invalid_request",
					reason,
				},
			};
		}
	}

	async stop(): Promise<void> {
		await this.server.stop();
		this.registry.clear();
	}

	private openStatusBase(request: HostServiceOpenRequest, pdfPath: string) {
		return {
			protocol_version: request.protocol_version,
			workspace_context: request.workspace_context,
			request_id: request.request_id,
			operation: "open_pdf" as const,
			backend: PDFJS_VIEWER_BACKEND_NAME,
			backend_path: PDFJS_VIEWER_BACKEND_NAME,
			capabilities: PDFJS_VIEWER_BACKEND_CAPABILITIES,
			pdf: pdfPath,
		};
	}
}

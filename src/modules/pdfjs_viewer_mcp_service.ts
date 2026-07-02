import { spawn } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { assertReadablePdfFile, assertReadableSourceFile, inferDefaultSourceFileForPdf } from "./pdf_tracking/pdf_tracking.ts";
import { findUniqueSelectedTextSourceRange, mapForwardSynctex, mapReverseSynctex } from "./synctex/forward_synctex.ts";
import { PdfEventStore, type GetPdfEventsRequest, type PdfEvent, type ReverseSynctexSourceLocationEvent } from "./pdf_events.ts";
import type {
	HostServiceCloseRequest,
	HostServiceCloseResponseEnvelope,
	HostServiceJumpRequest,
	HostServiceJumpResponseEnvelope,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
} from "./host_service_protocol.ts";
import type { HostServiceMcpPdfOperations } from "./host_service_mcp.ts";
import { arePdfSnapshotsEqual, PdfJsViewerRegistry, type PdfJsViewerFileSnapshot, type PdfJsViewerRecord } from "./pdfjs_viewer_registry.ts";
import { PdfJsViewerServer, type ReverseSynctexClick, type ViewerSelectionDebug } from "./pdfjs_viewer_server.ts";

const PDFJS_VIEWER_BACKEND_NAME = "pdfjs-browser";
const PDFJS_VIEWER_BACKEND_CAPABILITIES = {
	open: true,
	close: true,
	forward_search: true,
	inverse_search: false,
	reuse: true,
};
const DEFAULT_BROWSER_LAUNCH_SETTLE_MS = 250;
const DEFAULT_PDF_REFRESH_POLL_INTERVAL_MS = 500;
const DEFAULT_PDF_REFRESH_STABILITY_DEBOUNCE_MS = 250;

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

export interface PdfJsViewerRefreshOptions {
	autoStart?: boolean;
	pollIntervalMs?: number;
	stabilityDebounceMs?: number;
}

type ReverseSynctexMapper = typeof mapReverseSynctex;

export interface PdfJsViewerMcpServiceOptions {
	registry?: PdfJsViewerRegistry;
	server?: PdfJsViewerServer;
	browserLauncher?: BrowserLauncher;
	pdfRefresh?: PdfJsViewerRefreshOptions;
	eventStore?: PdfEventStore;
	reverseSynctexMapper?: ReverseSynctexMapper;
}

export interface MarkTrackedPdfUpdatedResult {
	tracked: boolean;
	refreshed: boolean;
	pdfId?: number;
	revision?: number;
	viewerNotifications: number;
	reason?: string;
}

function assertReadableSourceFileOrSymlink(sourceFile: string): void {
	try {
		if (lstatSync(sourceFile).isSymbolicLink()) {
			assertReadableSourceFile(realpathSync.native(sourceFile));
			return;
		}
	} catch {
		// Preserve assertReadableSourceFile's existing clear error text for missing paths.
	}
	assertReadableSourceFile(sourceFile);
}

export class PdfJsViewerMcpService {
	private readonly registry: PdfJsViewerRegistry;
	private readonly server: PdfJsViewerServer;
	private readonly browserLauncher: BrowserLauncher;
	private readonly eventStore: PdfEventStore;
	private readonly reverseSynctexMapper: ReverseSynctexMapper;
	private readonly pdfRefreshAutoStart: boolean;
	private readonly pdfRefreshPollIntervalMs: number;
	private readonly pdfRefreshStabilityDebounceMs: number;
	private readonly pendingRefreshes = new Map<number, { snapshot: PdfJsViewerFileSnapshot; stableSinceMs: number }>();
	private pdfRefreshTimer: NodeJS.Timeout | undefined;
	private pdfRefreshPollInFlight = false;
	readonly pdfOperations: HostServiceMcpPdfOperations;

	constructor(options: PdfJsViewerMcpServiceOptions = {}) {
		this.registry = options.registry ?? new PdfJsViewerRegistry();
		this.eventStore = options.eventStore ?? new PdfEventStore();
		this.server = options.server ?? new PdfJsViewerServer({
			registry: this.registry,
			onReverseSynctex: (click) => this.handleReverseSynctexClick(click),
			onSelectionDebug: (debug) => this.handleSelectionDebug(debug),
		});
		this.browserLauncher = options.browserLauncher ?? new DefaultBrowserLauncher();
		this.reverseSynctexMapper = options.reverseSynctexMapper ?? mapReverseSynctex;
		this.pdfRefreshAutoStart = options.pdfRefresh?.autoStart ?? true;
		this.pdfRefreshPollIntervalMs = options.pdfRefresh?.pollIntervalMs ?? DEFAULT_PDF_REFRESH_POLL_INTERVAL_MS;
		this.pdfRefreshStabilityDebounceMs = options.pdfRefresh?.stabilityDebounceMs ?? DEFAULT_PDF_REFRESH_STABILITY_DEBOUNCE_MS;
		this.pdfOperations = {
			openPdf: (request) => this.openPdf(request),
			jumpPdf: (request) => this.jumpPdf(request),
			closePdf: (request) => this.closePdf(request),
			getPdfEvents: (request) => this.getPdfEvents(request),
			markTrackedPdfUpdated: (pdfPath) => this.markTrackedPdfUpdated(pdfPath),
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

		const fileSnapshot = snapshotReadablePdfFile(pdfPath);
		await this.server.start();
		this.startPdfRefreshPolling();
		const existing = this.registry.findActiveRecordByPath(pdfPath);
		const record = this.registry.registerPdf({
			pdfPath,
			fileSnapshot,
			workspaceCwd: request.workspace_context.cwd,
			viewerUrlForPdfId: (pdfId) => this.server.viewerUrl(pdfId),
		});
		if (existing !== undefined) {
			this.refreshRecordIfSnapshotChanged(record, fileSnapshot);
		}
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
				revision: record.revision,
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
					metadata: { viewer_url: record.viewerUrl, browser_launch: launch, revision: record.revision, file_snapshot: record.fileSnapshot },
				},
			},
		};
	}

	async jumpPdf(request: HostServiceJumpRequest): Promise<HostServiceJumpResponseEnvelope> {
		let pdfPath: string | undefined;
		let sourceFile: string | undefined;
		try {
			const record = this.registry.getActiveRecord(request.pdf_id);
			pdfPath = record.pdfPath;
			sourceFile = request.source_file ?? inferDefaultSourceFileForPdf(pdfPath);
			if (!sourceFile) {
				throw new Error(`No default source_file is known for tracked pdf_id=${request.pdf_id}. Pass source_file explicitly.`);
			}
			sourceFile = isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(request.workspace_context.cwd, sourceFile);
			assertReadableSourceFileOrSymlink(sourceFile);
			assertReadablePdfFile(pdfPath);
			const jump = mapForwardSynctex({ pdfPath, sourceFile, line: request.line, cwd: request.workspace_context.cwd });
			const viewerNotifications = this.server.notifySynctex(request.pdf_id, {
				page: jump.page,
				x: jump.x,
				y: jump.y,
				...(jump.width === undefined ? {} : { width: jump.width }),
				...(jump.height === undefined ? {} : { height: jump.height }),
				...(jump.ranges === undefined ? {} : { ranges: jump.ranges }),
				source_file: jump.sourceFile,
				line: jump.line,
			});
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "ok",
				generated_at_ns: Date.now() * 1_000_000,
				status_details: {
					protocol_version: request.protocol_version,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: PDFJS_VIEWER_BACKEND_NAME,
					backend_path: PDFJS_VIEWER_BACKEND_NAME,
					backend_identity_ok: true,
					handled: true,
					reopened: false,
					pdf: pdfPath,
					pdf_id: request.pdf_id,
					source_file: jump.sourceFile,
					line: jump.line,
					source_line: jump.sourceLine,
					page: jump.page,
					x: jump.x,
					y: jump.y,
					synctex_branch: jump.branch,
					synctex_diagnostics: jump.diagnostics,
					...(jump.width === undefined ? {} : { width: jump.width }),
					...(jump.height === undefined ? {} : { height: jump.height }),
					...(jump.ranges === undefined ? {} : { ranges: jump.ranges }),
					viewer_notifications: viewerNotifications,
					handle: record.viewerUrl,
					reason: `notified_viewers=${viewerNotifications}`,
					managed_record: {
						id: record.pdfId,
						pdfPath: record.pdfPath,
						viewerHandle: record.viewerUrl,
						viewerBackend: PDFJS_VIEWER_BACKEND_NAME,
						viewerOwned: true,
						createdAtNs: record.createdAtNs,
						reused: false,
						capabilities: PDFJS_VIEWER_BACKEND_CAPABILITIES,
						backendPath: PDFJS_VIEWER_BACKEND_NAME,
						defaultSourcePath: inferDefaultSourceFileForPdf(pdfPath),
						metadata: { viewer_url: record.viewerUrl, synctex_sidecar: jump.sidecarPath, synctex_branch: jump.branch, viewer_notifications: viewerNotifications },
					},
				},
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				protocol_version: request.protocol_version,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: Date.now() * 1_000_000,
				error: reason,
				status_details: {
					protocol_version: request.protocol_version,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: PDFJS_VIEWER_BACKEND_NAME,
					backend_path: PDFJS_VIEWER_BACKEND_NAME,
					backend_identity_ok: true,
					handled: false,
					reopened: false,
					pdf: pdfPath,
					pdf_id: request.pdf_id,
					source_file: sourceFile,
					line: request.line,
					error_code: this.jumpErrorCode(reason),
					reason,
				},
			};
		}
	}

	async closePdf(request: HostServiceCloseRequest): Promise<HostServiceCloseResponseEnvelope> {
		let notifications = 0;
		try {
			notifications = this.server.notifyPdfClosed(request.pdf_id);
			const record = this.registry.closePdf(request.pdf_id);
			this.pendingRefreshes.delete(request.pdf_id);
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

	getPdfEvents(request: GetPdfEventsRequest): PdfEvent[] {
		return this.eventStore.getEvents(request);
	}

	async markTrackedPdfUpdated(pdfPath: string): Promise<MarkTrackedPdfUpdatedResult> {
		const record = this.registry.findActiveRecordByPath(pdfPath);
		if (!record) {
			return { tracked: false, refreshed: false, viewerNotifications: 0, reason: "pdf is not tracked" };
		}
		const snapshot = readablePdfSnapshotOrUndefined(record.pdfPath);
		if (!snapshot) {
			return { tracked: true, refreshed: false, pdfId: record.pdfId, revision: record.revision, viewerNotifications: 0, reason: "pdf is not readable" };
		}
		return { tracked: true, ...this.refreshRecordIfSnapshotChanged(record, snapshot) };
	}

	async pollTrackedPdfChanges(nowMs = Date.now()): Promise<void> {
		for (const record of this.registry.activePdfRecords()) {
			const snapshot = readablePdfSnapshotOrUndefined(record.pdfPath);
			if (!snapshot) {
				this.pendingRefreshes.delete(record.pdfId);
				continue;
			}
			if (record.fileSnapshot && arePdfSnapshotsEqual(record.fileSnapshot, snapshot)) {
				this.pendingRefreshes.delete(record.pdfId);
				continue;
			}
			const pending = this.pendingRefreshes.get(record.pdfId);
			if (!pending || !arePdfSnapshotsEqual(pending.snapshot, snapshot)) {
				this.pendingRefreshes.set(record.pdfId, { snapshot, stableSinceMs: nowMs });
				continue;
			}
			if (nowMs - pending.stableSinceMs < this.pdfRefreshStabilityDebounceMs) {
				continue;
			}
			this.pendingRefreshes.delete(record.pdfId);
			this.refreshRecordIfSnapshotChanged(record, snapshot);
		}
	}

	async stop(): Promise<void> {
		if (this.pdfRefreshTimer) {
			clearInterval(this.pdfRefreshTimer);
			this.pdfRefreshTimer = undefined;
		}
		this.pendingRefreshes.clear();
		await this.server.stop();
		this.registry.clear();
	}

	private sourceLocationEventFromReverse(location: ReturnType<typeof mapReverseSynctex>, page: number, x: number, y: number): ReverseSynctexSourceLocationEvent {
		return {
			source_file: location.sourceFile,
			line: location.line,
			column: location.column,
			...(location.sourceLine === undefined ? {} : { source_line: location.sourceLine }),
			page,
			x,
			y,
			precision: location.precision,
			...(location.diagnostics.textRepair?.used === true ? { repair: "text_context" } : {}),
			...(location.rawMappedLine === undefined ? {} : {
				raw_mapped_source_file: location.rawMappedSourceFile,
				raw_mapped_line: location.rawMappedLine,
				raw_mapped_column: location.rawMappedColumn,
				...(location.rawMappedSourceLine === undefined ? {} : { raw_mapped_source_line: location.rawMappedSourceLine }),
			}),
			synctex_diagnostics: location.diagnostics,
		};
	}

	private withEndpointDiagnostics(repaired: ReverseSynctexSourceLocationEvent, mapped: ReturnType<typeof mapReverseSynctex> | undefined): ReverseSynctexSourceLocationEvent {
		if (mapped === undefined) return repaired;
		return {
			...repaired,
			...(mapped.rawMappedLine === undefined ? {} : {
				raw_mapped_source_file: mapped.rawMappedSourceFile,
				raw_mapped_line: mapped.rawMappedLine,
				raw_mapped_column: mapped.rawMappedColumn,
				...(mapped.rawMappedSourceLine === undefined ? {} : { raw_mapped_source_line: mapped.rawMappedSourceLine }),
			}),
			synctex_diagnostics: mapped.diagnostics,
		};
	}

	private repairedSelectionEndpoints(location: ReturnType<typeof mapReverseSynctex>, selectedText: string | undefined, click: ReverseSynctexClick): { selectionStart?: ReverseSynctexSourceLocationEvent; selectionEnd?: ReverseSynctexSourceLocationEvent } {
		if (selectedText === undefined) return {};
		const range = findUniqueSelectedTextSourceRange(location.sourceFile, selectedText);
		if (range === undefined) return {};
		return {
			selectionStart: { source_file: range.sourceFile, line: range.startLine, column: range.startColumn, ...(range.startSourceLine === undefined ? {} : { source_line: range.startSourceLine }), page: click.page, x: click.selectionStartX as number, y: click.selectionStartY as number, precision: "text", repair: "selected_text" },
			selectionEnd: { source_file: range.sourceFile, line: range.endLine, column: range.endColumn, ...(range.endSourceLine === undefined ? {} : { source_line: range.endSourceLine }), page: click.page, x: click.selectionEndX as number, y: click.selectionEndY as number, precision: "text", repair: "selected_text" },
		};
	}

	private handleSelectionDebug(debug: ViewerSelectionDebug): void {
		this.eventStore.appendSelectionDebugEvent({
			type: "selection_debug",
			pdf_id: debug.pdfId,
			timestamp: new Date().toISOString(),
			phase: debug.phase,
			...(debug.page === undefined ? {} : { page: debug.page }),
			text: debug.text,
			details: debug.details,
		});
	}

	private handleReverseSynctexClick(click: ReverseSynctexClick): void {
		const record = this.registry.getActiveRecord(click.pdfId);
		const cwd = record.workspaceCwd ?? dirname(record.pdfPath);
		const location = this.reverseSynctexMapper({
			pdfPath: record.pdfPath,
			page: click.page,
			x: click.x,
			y: click.y,
			cwd,
			...(click.textBeforeSelection === undefined ? {} : { textBeforeSelection: click.textBeforeSelection }),
			...(click.textAfterSelection === undefined ? {} : { textAfterSelection: click.textAfterSelection }),
		});
		const repairedSelection = click.selectedText !== undefined && click.selectionStartX !== undefined && click.selectionStartY !== undefined && click.selectionEndX !== undefined && click.selectionEndY !== undefined
			? this.repairedSelectionEndpoints(location, click.selectedText, click)
			: {};
		let selectionStart: ReturnType<typeof mapReverseSynctex> | undefined;
		let selectionStartError: string | undefined;
		if (click.selectedText !== undefined && click.selectionStartX !== undefined && click.selectionStartY !== undefined) {
			try {
				selectionStart = this.reverseSynctexMapper({
					pdfPath: record.pdfPath,
					page: click.page,
					x: click.selectionStartX,
					y: click.selectionStartY,
					cwd,
					...(click.textBeforeSelection === undefined ? {} : { textBeforeSelection: click.textBeforeSelection }),
					textAfterSelection: click.selectedText,
				});
			} catch (error) {
				selectionStartError = error instanceof Error ? error.message : String(error);
			}
			if (repairedSelection.selectionStart !== undefined) {
				selectionStartError = undefined;
			}
		}
		let selectionEnd: ReturnType<typeof mapReverseSynctex> | undefined;
		let selectionEndError: string | undefined;
		if (click.selectedText !== undefined && click.selectionEndX !== undefined && click.selectionEndY !== undefined) {
			try {
				selectionEnd = this.reverseSynctexMapper({
					pdfPath: record.pdfPath,
					page: click.page,
					x: click.selectionEndX,
					y: click.selectionEndY,
					cwd,
					textBeforeSelection: click.selectedText,
					...(click.textAfterSelection === undefined ? {} : { textAfterSelection: click.textAfterSelection }),
				});
			} catch (error) {
				selectionEndError = error instanceof Error ? error.message : String(error);
			}
			if (repairedSelection.selectionEnd !== undefined) {
				selectionEndError = undefined;
			}
		}
		this.eventStore.appendReverseSynctexEvent({
			type: "reverse_synctex",
			pdf_id: click.pdfId,
			source_file: location.sourceFile,
			line: location.line,
			column: location.column,
			...(location.sourceLine === undefined ? {} : { source_line: location.sourceLine }),
			synctex_diagnostics: location.diagnostics,
			timestamp: new Date().toISOString(),
			precision: location.precision,
			...(location.diagnostics.textRepair?.used === true ? { repair: "text_context" } : {}),
			page: click.page,
			x: click.x,
			y: click.y,
			...(click.selectedText === undefined ? {} : { selected_text: click.selectedText }),
			...(repairedSelection.selectionStart !== undefined ? { selection_start: this.withEndpointDiagnostics(repairedSelection.selectionStart, selectionStart) } : selectionStart === undefined ? {} : { selection_start: this.sourceLocationEventFromReverse(selectionStart, click.page, click.selectionStartX as number, click.selectionStartY as number) }),
			...(repairedSelection.selectionEnd !== undefined ? { selection_end: this.withEndpointDiagnostics(repairedSelection.selectionEnd, selectionEnd) } : selectionEnd === undefined ? {} : { selection_end: this.sourceLocationEventFromReverse(selectionEnd, click.page, click.selectionEndX as number, click.selectionEndY as number) }),
			...(selectionStartError === undefined ? {} : { selection_start_error: selectionStartError }),
			...(selectionEndError === undefined ? {} : { selection_end_error: selectionEndError }),
			...(location.rawMappedLine === undefined ? {} : {
				raw_mapped_source_file: location.rawMappedSourceFile,
				raw_mapped_line: location.rawMappedLine,
				raw_mapped_column: location.rawMappedColumn,
				...(location.rawMappedSourceLine === undefined ? {} : { raw_mapped_source_line: location.rawMappedSourceLine }),
			}),
			...(location.normalizedFormulaSpan === undefined ? {} : {
				normalized_formula_span: {
					source_file: location.normalizedFormulaSpan.sourceFile,
					start_line: location.normalizedFormulaSpan.startLine,
					end_line: location.normalizedFormulaSpan.endLine,
				},
				normalized_formula_excerpt: location.normalizedFormulaExcerpt,
			}),
		});
	}

	private startPdfRefreshPolling(): void {
		if (!this.pdfRefreshAutoStart || this.pdfRefreshTimer || this.pdfRefreshPollIntervalMs <= 0) {
			return;
		}
		this.pdfRefreshTimer = setInterval(() => {
			if (this.pdfRefreshPollInFlight) return;
			this.pdfRefreshPollInFlight = true;
			void this.pollTrackedPdfChanges()
				.finally(() => {
					this.pdfRefreshPollInFlight = false;
				});
		}, this.pdfRefreshPollIntervalMs);
		this.pdfRefreshTimer.unref?.();
	}

	private refreshRecordIfSnapshotChanged(record: PdfJsViewerRecord, snapshot: PdfJsViewerFileSnapshot): Omit<MarkTrackedPdfUpdatedResult, "tracked"> {
		const update = this.registry.updatePdfSnapshot(record.pdfId, snapshot);
		if (!update.changed) {
			return { refreshed: false, pdfId: record.pdfId, revision: update.revision, viewerNotifications: 0 };
		}
		const viewerNotifications = this.server.notifyPdfRefresh(record.pdfId, update.revision);
		return { refreshed: true, pdfId: record.pdfId, revision: update.revision, viewerNotifications };
	}

	private jumpErrorCode(reason: string): string {
		if (/missing SyncTeX sidecar/i.test(reason)) return "synctex_missing";
		if (/No SyncTeX mapping found/i.test(reason)) return "synctex_unmapped";
		if (/Unknown pdf_id|Closed pdf_id/i.test(reason)) return "invalid_request";
		if (/source_file/i.test(reason)) return "invalid_request";
		return "synctex_failed";
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

function snapshotReadablePdfFile(pdfPath: string): PdfJsViewerFileSnapshot {
	const status = statSync(pdfPath);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

function readablePdfSnapshotOrUndefined(pdfPath: string): PdfJsViewerFileSnapshot | undefined {
	try {
		const status = statSync(pdfPath);
		if (!status.isFile()) return undefined;
		return { size: status.size, mtimeMs: status.mtimeMs };
	} catch {
		return undefined;
	}
}

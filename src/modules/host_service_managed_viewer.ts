import {
	assertReadablePdfFile,
	assertReadableSourceFile,
	inferDefaultSourceFileForPdf,
} from "./pdf_tracking/pdf_tracking.ts";
import { readSourceLine } from "./synctex/synctex.ts";
import type {
	HostServiceCloseRequest,
	HostServiceCloseResponseEnvelope,
	HostServiceJumpRequest,
	HostServiceJumpResponseEnvelope,
	HostServiceManagedViewerRecord,
	HostServiceManagedViewerRecordInput,
	HostServiceOpenRequest,
	HostServiceOpenResponseEnvelope,
	HostServicePdfIdRegistryLike,
} from "./host_service_protocol.ts";
import type {
	HostServiceCallbackTarget,
	HostServiceViewerBackendCapabilities,
	ViewerBackendAdapter,
} from "./host_service_viewer_protocol.ts";

function sameCallbackTarget(
	left: HostServiceCallbackTarget | undefined,
	right: HostServiceCallbackTarget | undefined,
): boolean {
	if (left === undefined || right === undefined) {
		return left === right;
	}
	return (
		left.kind === right.kind
		&& left.transport === right.transport
		&& left.socket_path === right.socket_path
		&& left.token === right.token
	);
}

function isValidViewerBackendCapabilities(value: unknown): value is HostServiceViewerBackendCapabilities {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	return (
		typeof (value as Record<string, unknown>).open === "boolean"
		&& typeof (value as Record<string, unknown>).close === "boolean"
		&& typeof (value as Record<string, unknown>).forward_search === "boolean"
		&& typeof (value as Record<string, unknown>).inverse_search === "boolean"
		&& typeof (value as Record<string, unknown>).reuse === "boolean"
	);
}

const MANAGED_VIEWER_OPEN_TIMEOUT_MS = 2_000;
const VIEWER_BACKEND_TIMEOUT_ERROR_TEXT = "viewer backend request timed out while opening preview";

function withTimeout<T>(
	operation: () => Promise<T>,
	timeoutMs: number,
	onLateSuccess?: (value: T) => void | Promise<void>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			reject(new Error(VIEWER_BACKEND_TIMEOUT_ERROR_TEXT));
		}, timeoutMs);
		timer.unref?.();

		let operationPromise: Promise<T>;
		try {
			operationPromise = operation();
		} catch (error) {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		operationPromise
			.then((value) => {
				clearTimeout(timer);
				if (timedOut) {
					void Promise.resolve(onLateSuccess?.(value)).catch(() => undefined);
					return;
				}
				resolve(value);
			})
			.catch((error) => {
				clearTimeout(timer);
				if (timedOut) {
					return;
				}
				reject(error instanceof Error ? error : new Error(String(error)));
			});
	});
}

export class HostServiceManagedViewerService {
	private readonly viewerBackend: ViewerBackendAdapter;
	private readonly managedViewerRecords: HostServicePdfIdRegistryLike;
	private readonly protocolVersion: number;
	private readonly openTimeoutMs: number;

	constructor(options: {
		viewerBackend: ViewerBackendAdapter;
		managedViewerRecords: HostServicePdfIdRegistryLike;
		protocolVersion: number;
		openTimeoutMs?: number;
	}) {
		this.viewerBackend = options.viewerBackend;
		this.managedViewerRecords = options.managedViewerRecords;
		this.protocolVersion = options.protocolVersion;
		this.openTimeoutMs = options.openTimeoutMs ?? MANAGED_VIEWER_OPEN_TIMEOUT_MS;
	}

	async openViewer(request: HostServiceOpenRequest): Promise<HostServiceOpenResponseEnvelope> {
		try {
			assertReadablePdfFile(request.details.pdf_path);
		} catch (error) {
			const errorText = error instanceof Error ? error.message : String(error);
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "open_pdf",
				status: "error",
				generated_at_ns: Date.now() * 1_000_000,
				error: errorText,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "open_pdf",
					backend: this.viewerBackend.name,
					backend_path: this.viewerBackend.name,
					capabilities: this.viewerBackend.capabilities,
					handle: undefined,
					owned: false,
					reused: false,
					pid: undefined,
					pid_diagnostic: undefined,
					pdf: request.details.pdf_path,
					error_code: errorText.includes("must point to a PDF file") ? "invalid_pdf" : "invalid_request",
					reason: errorText,
				},
			};
		}
		let backendResult: Awaited<ReturnType<ViewerBackendAdapter["open"]>>;
		try {
			backendResult = await withTimeout(
				() => this.viewerBackend.open(request.request_id, request.details as Record<string, unknown>),
				this.openTimeoutMs,
				(result) => this.closeTimedOutOpenResult(request.request_id, result),
			);
		} catch (error) {
			const errorText = error instanceof Error ? error.message : String(error);
			const isTimeout = errorText === VIEWER_BACKEND_TIMEOUT_ERROR_TEXT;
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "open_pdf",
				status: "error",
				generated_at_ns: Date.now() * 1_000_000,
				error: errorText,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "open_pdf",
					backend: this.viewerBackend.name,
					backend_path: this.viewerBackend.name,
					capabilities: this.viewerBackend.capabilities,
					handle: undefined,
					owned: false,
					reused: false,
					pid: undefined,
					pid_diagnostic: undefined,
					pdf: request.details.pdf_path,
					error_code: isTimeout ? "service_timeout" : "backend_unavailable",
					reason: errorText,
				},
			};
		}
		const nowNs = Date.now() * 1_000_000;
		const backendDetails = backendResult.status_details as Record<string, unknown>;
		const backendPath =
			typeof backendDetails.backend_path === "string" && backendDetails.backend_path.trim()
				? backendDetails.backend_path
				: this.viewerBackend.name;
		const capabilities = isValidViewerBackendCapabilities(backendDetails.capabilities)
			? backendDetails.capabilities
			: this.viewerBackend.capabilities;
		const owned = Boolean(backendDetails.owned);
		const reused = Boolean(backendDetails.reused);
		const pid =
			typeof backendDetails.pid === "number" && Number.isInteger(backendDetails.pid) && backendDetails.pid > 0
				? backendDetails.pid
				: undefined;
		const pidDiagnostic =
			typeof backendDetails.pid_diagnostic === "string" && backendDetails.pid_diagnostic.trim()
				? backendDetails.pid_diagnostic
				: undefined;
		const handle =
			typeof backendDetails.handle === "string" && backendDetails.handle.trim()
				? backendDetails.handle
				: undefined;

		if (backendResult.status === "ok") {
			if (!handle) {
				return {
					protocol_version: this.protocolVersion,
					request_id: request.request_id,
					operation: "open_pdf",
					status: "error",
					generated_at_ns: nowNs,
					error: "viewer backend response missing handle",
					status_details: {
						protocol_version: this.protocolVersion,
						supported: false,
						service_available: false,
						workspace_context: request.workspace_context,
						request_id: request.request_id,
						operation: "open_pdf",
						backend: this.viewerBackend.name,
						backend_path: backendPath,
						capabilities: this.viewerBackend.capabilities,
						handle: undefined,
						owned: false,
						reused: false,
						pid: undefined,
						pid_diagnostic: undefined,
						pdf: request.details.pdf_path,
						error_code: "internal_error",
						reason: "viewer backend response missing handle",
					},
				};
			}

			const defaultSourcePath = inferDefaultSourceFileForPdf(request.details.pdf_path);
			const existingRecord = reused
				? this.managedViewerRecords.findActiveRecord((record) =>
					record.viewerHandle === handle
						&& record.pdfPath === request.details.pdf_path
						&& sameCallbackTarget(record.callback, request.details.callback),
				)
				: undefined;
			const managedRecord = existingRecord
				? (() => {
					existingRecord.viewerOwned = owned;
					existingRecord.reused = reused;
					existingRecord.pid = pid;
					existingRecord.pidDiagnostic = pidDiagnostic;
					existingRecord.capabilities = capabilities;
					existingRecord.backendPath = backendPath;
					existingRecord.defaultSourcePath = existingRecord.defaultSourcePath ?? defaultSourcePath;
					existingRecord.callback = request.details.callback;
					existingRecord.metadata = {
						...(existingRecord.metadata ?? {}),
						backend_path: backendPath,
						handle,
						...(request.details.callback
							? { callback_target_id: request.details.callback.socket_path }
							: {}),
					};
					return existingRecord;
				})()
				: this.trackManagedRecord({
					pdfPath: request.details.pdf_path,
					viewerHandle: handle,
					viewerBackend: this.viewerBackend.name,
					viewerOwned: owned,
					pid,
					pidDiagnostic,
					reused,
					capabilities,
					backendPath,
					defaultSourcePath,
					callback: request.details.callback,
					metadata: {
						backend_path: backendPath,
						handle,
						backend_name: this.viewerBackend.name,
						...(request.details.callback
							? { callback_target_id: request.details.callback.socket_path }
							: {}),
					},
				});

			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "open_pdf",
				status: "ok",
				generated_at_ns: nowNs,
				pdf: managedRecord.pdfPath,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "open_pdf",
					backend: this.viewerBackend.name,
					backend_path: backendPath,
					capabilities,
					handle,
					owned,
					reused,
					pid,
					pid_diagnostic: pidDiagnostic,
					pdf: managedRecord.pdfPath,
					pdf_id: managedRecord.id,
					managed_record: managedRecord,
				},
			};
		}

		return {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: "open_pdf",
			status: "error",
			generated_at_ns: nowNs,
			error: backendResult.error ?? "open failed",
			status_details: {
				protocol_version: this.protocolVersion,
				supported: false,
				service_available: false,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: "open_pdf",
				backend: this.viewerBackend.name,
				backend_path: backendPath,
				capabilities,
				handle,
				owned,
				reused,
				pid,
				pid_diagnostic: pidDiagnostic,
				pdf: request.details.pdf_path,
				error_code: typeof backendDetails.error_code === "string"
					? backendDetails.error_code
					: "backend_unavailable",
				reason: backendResult.error,
			},
		};
	}

	async closeViewer(request: HostServiceCloseRequest): Promise<HostServiceCloseResponseEnvelope> {
		let managedRecord: HostServiceManagedViewerRecord;
		try {
			managedRecord = this.managedViewerRecords.getActiveRecord(request.pdf_id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const nowNs = Date.now() * 1_000_000;
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "close_pdf",
				status: "error",
				generated_at_ns: nowNs,
				error: message,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "close_pdf",
					backend: this.viewerBackend.name,
					backend_path: this.viewerBackend.name,
					closed: false,
					pdf_id: request.pdf_id,
					error_code: "invalid_request",
					reason: message,
				},
			};
		}

		const nowNs = Date.now() * 1_000_000;
		if (!managedRecord.viewerOwned) {
			this.managedViewerRecords.closeRecord(request.pdf_id);
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "close_pdf",
				status: "ok",
				generated_at_ns: nowNs,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: true,
					service_available: true,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "close_pdf",
					backend: managedRecord.viewerBackend,
					backend_path:
						typeof managedRecord.backendPath === "string" && managedRecord.backendPath.trim()
							? managedRecord.backendPath
							: this.viewerBackend.name,
					backend_identity_ok: true,
					closed: false,
					handle: managedRecord.viewerHandle,
					reason: "not_service_owned",
					pdf_id: request.pdf_id,
				},
			};
		}

		const backendResult = await this.viewerBackend.close(request.request_id, {
			handle: managedRecord.viewerHandle,
			backend: managedRecord.viewerBackend,
		});
		const backendDetails = backendResult.status_details as Record<string, unknown>;
		const backendPath =
			typeof backendDetails.backend_path === "string" && backendDetails.backend_path.trim()
				? backendDetails.backend_path
				: typeof managedRecord.backendPath === "string" && managedRecord.backendPath.trim()
					? managedRecord.backendPath
					: this.viewerBackend.name;
		const backendAvailable =
			typeof backendDetails.service_available === "boolean" ? backendDetails.service_available : true;
		const backendIdentityOk =
			typeof backendDetails.backend_identity_ok === "boolean" ? backendDetails.backend_identity_ok : true;
		const closed = typeof backendDetails.closed === "boolean" ? backendDetails.closed : false;
		const reason =
			typeof backendDetails.reason === "string" && backendDetails.reason.trim() ? backendDetails.reason : undefined;

		if (backendResult.status === "ok") {
			this.managedViewerRecords.closeRecord(request.pdf_id);
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "close_pdf",
				status: "ok",
				generated_at_ns: nowNs,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: true,
					service_available: backendAvailable,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "close_pdf",
					backend: managedRecord.viewerBackend,
					backend_path: backendPath,
					backend_identity_ok: backendIdentityOk,
					closed,
					handle: managedRecord.viewerHandle,
					reason,
					pdf_id: request.pdf_id,
					error_code:
						typeof backendDetails.error_code === "string" ? backendDetails.error_code : undefined,
				},
			};
		}

		return {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: "close_pdf",
			status: "error",
			generated_at_ns: nowNs,
			error: backendResult.error ?? "close failed",
			status_details: {
				protocol_version: this.protocolVersion,
				supported: false,
				service_available: false,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: "close_pdf",
				backend: managedRecord.viewerBackend,
				backend_path: backendPath,
				backend_identity_ok: backendIdentityOk,
				closed,
				handle: managedRecord.viewerHandle,
				reason,
				pdf_id: request.pdf_id,
				error_code:
					typeof backendDetails.error_code === "string"
						? backendDetails.error_code
						: "backend_unavailable",
			},
		};
	}

	async jumpViewer(request: HostServiceJumpRequest): Promise<HostServiceJumpResponseEnvelope> {
		let managedRecord: HostServiceManagedViewerRecord;
		let managedRecordState: "active" | "stale" | "closed";
		try {
			const knownRecord = this.managedViewerRecords.getKnownRecord(request.pdf_id);
			managedRecord = knownRecord.record;
			managedRecordState = knownRecord.state;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const nowNs = Date.now() * 1_000_000;
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: nowNs,
				error: message,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: this.viewerBackend.name,
					backend_path: this.viewerBackend.name,
					handled: false,
					reopened: false,
					pdf_id: request.pdf_id,
					error_code: "invalid_request",
					reason: message,
				},
			};
		}

		if (managedRecord.capabilities?.forward_search === false) {
			const nowNs = Date.now() * 1_000_000;
			const errorText =
				`Tracked PDF ${request.pdf_id} is managed by a viewer backend without forward-search support: ${managedRecord.viewerBackend}`;
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: nowNs,
				error: errorText,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: managedRecord.viewerBackend,
					backend_path:
						typeof managedRecord.backendPath === "string" && managedRecord.backendPath.trim()
							? managedRecord.backendPath
							: this.viewerBackend.name,
					handled: false,
					reopened: false,
					pdf_id: request.pdf_id,
					error_code: "unsupported_operation",
					reason: errorText,
					source_file: request.source_file,
					line: request.line,
				},
			};
		}

		const resolvedSourceFile = request.source_file ?? managedRecord.defaultSourcePath;
		if (!resolvedSourceFile) {
			const nowNs = Date.now() * 1_000_000;
			const reason = `No default source_file is known for tracked pdf_id=${request.pdf_id}. Pass source_file explicitly.`;
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: nowNs,
				error: reason,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: managedRecord.viewerBackend,
					backend_path:
						typeof managedRecord.backendPath === "string" && managedRecord.backendPath.trim()
							? managedRecord.backendPath
							: this.viewerBackend.name,
					handled: false,
					reopened: false,
					error_code: "invalid_request",
					pdf_id: request.pdf_id,
					pdf: managedRecord.pdfPath,
					reason: reason,
				},
			};
		}

		try {
			assertReadableSourceFile(resolvedSourceFile);
		} catch (error) {
			const nowNs = Date.now() * 1_000_000;
			const reason = error instanceof Error ? error.message : String(error);
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: nowNs,
				error: reason,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: managedRecord.viewerBackend,
					backend_path:
						typeof managedRecord.backendPath === "string" && managedRecord.backendPath.trim()
							? managedRecord.backendPath
							: this.viewerBackend.name,
					handled: false,
					reopened: false,
					error_code: "invalid_request",
					pdf_id: request.pdf_id,
					pdf: managedRecord.pdfPath,
					source_file: resolvedSourceFile,
					line: request.line,
					source_line: readSourceLine(resolvedSourceFile, request.line, request.workspace_context.cwd),
					reason: reason,
				},
			};
		}

		try {
			assertReadablePdfFile(managedRecord.pdfPath);
		} catch (error) {
			const nowNs = Date.now() * 1_000_000;
			const reason = error instanceof Error ? error.message : String(error);
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: nowNs,
				error: reason,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: managedRecord.viewerBackend,
					backend_path:
						typeof managedRecord.backendPath === "string" && managedRecord.backendPath.trim()
							? managedRecord.backendPath
							: this.viewerBackend.name,
					handled: false,
					reopened: false,
					error_code: reason.includes("must point to a PDF file") ? "invalid_pdf" : "invalid_request",
					pdf_id: request.pdf_id,
					pdf: managedRecord.pdfPath,
					source_file: resolvedSourceFile,
					line: request.line,
					source_line: readSourceLine(resolvedSourceFile, request.line, request.workspace_context.cwd),
					reason,
				},
			};
		}

		const managedBackendPath =
			typeof managedRecord.backendPath === "string" && managedRecord.backendPath.trim()
				? managedRecord.backendPath
				: this.viewerBackend.name;
		const sourceLine = readSourceLine(resolvedSourceFile, request.line, request.workspace_context.cwd) ?? "";

		const jumpBackend = async (
			synctexPid: number | undefined,
			forwardSourceFile: string,
		): ReturnType<ViewerBackendAdapter["forwardSearch"]> => {
			const backendDetails: Record<string, unknown> = {
				handle: managedRecord.viewerHandle,
				backend: managedRecord.viewerBackend,
				source_file: forwardSourceFile,
				line: request.line,
			};
			if (synctexPid !== undefined) {
				backendDetails.synctex_pid = synctexPid;
			}
			return this.viewerBackend.forwardSearch(request.request_id, backendDetails);
		};

		const makeSuccessResponse = (
			handled: boolean,
			reopened: boolean,
			errorCode: string | undefined,
			reason: string | undefined,
			backendIdentityOk: boolean,
			serviceAvailable: boolean,
			diagnostics: Array<Record<string, unknown>> | undefined,
		): HostServiceJumpResponseEnvelope => ({
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: "jump_pdf",
			status: handled ? "ok" : "error",
			generated_at_ns: Date.now() * 1_000_000,
			error: handled ? undefined : reason,
			status_details: {
				protocol_version: this.protocolVersion,
				supported: handled,
				service_available: serviceAvailable,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: "jump_pdf",
				backend: managedRecord.viewerBackend,
				backend_path: managedBackendPath,
				backend_identity_ok: backendIdentityOk,
				handled,
				reopened,
				pdf_id: request.pdf_id,
				pdf: managedRecord.pdfPath,
				source_file: resolvedSourceFile,
				line: request.line,
				source_line: sourceLine,
				handle: managedRecord.viewerHandle,
				reason,
				error_code: handled ? undefined : errorCode,
				diagnostics: diagnostics,
				managed_record: managedRecord,
			},
		});

		const reopenableErrorCodes = new Set(["handle_not_found", "not_running", "stale_handle"]);
		let initialDiagnostics: Array<Record<string, unknown>> | undefined;
		let initialReason: string | undefined;
		if (managedRecordState === "active") {
			const initialAttempt = await jumpBackend(managedRecord.pid, resolvedSourceFile);
			const initialDetails = initialAttempt.status_details as Record<string, unknown>;
			initialDiagnostics = Array.isArray(initialDetails.diagnostics) ? initialDetails.diagnostics : undefined;
			const initialHandled =
				typeof initialDetails.handled === "boolean" ? initialDetails.handled : false;
			const backendIdentityOk =
				typeof initialDetails.backend_identity_ok === "boolean" ? initialDetails.backend_identity_ok : false;
			const backendAvailable =
				typeof initialDetails.service_available === "boolean" ? initialDetails.service_available : true;
			const initialErrorCode =
				typeof initialDetails.error_code === "string" ? initialDetails.error_code : "backend_unavailable";
			initialReason =
				typeof initialDetails.reason === "string" && initialDetails.reason.trim()
					? initialDetails.reason
					: initialAttempt.error;

			if (initialAttempt.status === "ok") {
				return makeSuccessResponse(
					initialHandled,
					false,
					undefined,
					initialReason,
					backendIdentityOk,
					backendAvailable,
					initialDiagnostics,
				);
			}
			if (!reopenableErrorCodes.has(initialErrorCode)) {
				return makeSuccessResponse(false, false, initialErrorCode, initialReason, backendIdentityOk, backendAvailable, initialDiagnostics);
			}
		} else {
			initialReason = `${managedRecordState} pdf_id=${request.pdf_id} requires viewer reopen`;
		}

		const reopenAttempt = await this.viewerBackend.open(request.request_id, {
			pdf_path: managedRecord.pdfPath,
			callback: managedRecord.callback,
			reuse_existing: true,
			require_persistent_viewer: true,
		});
		const reopenDetails = reopenAttempt.status_details as Record<string, unknown>;
		const reopenBackendPath =
			typeof reopenDetails.backend_path === "string" && reopenDetails.backend_path.trim()
				? reopenDetails.backend_path
				: managedBackendPath;
		const reopenHandle =
			typeof reopenDetails.handle === "string" && reopenDetails.handle.trim()
				? reopenDetails.handle
				: managedRecord.viewerHandle;
		const reopenPid =
			typeof reopenDetails.pid === "number" && Number.isInteger(reopenDetails.pid) && reopenDetails.pid > 0
				? reopenDetails.pid
				: undefined;
		const reopenPidDiagnostic =
			typeof reopenDetails.pid_diagnostic === "string" && reopenDetails.pid_diagnostic.trim()
				? reopenDetails.pid_diagnostic
				: undefined;
		const reopenOwned = typeof reopenDetails.owned === "boolean" ? reopenDetails.owned : managedRecord.viewerOwned;
		const reopenReused = typeof reopenDetails.reused === "boolean" ? reopenDetails.reused : managedRecord.reused;
		const reopenCapabilities = isValidViewerBackendCapabilities(reopenDetails.capabilities)
			? reopenDetails.capabilities
			: managedRecord.capabilities ?? this.viewerBackend.capabilities;

		if (reopenAttempt.status === "ok") {
			const revivedRecord = this.managedViewerRecords.reviveRecordIfState(
				request.pdf_id,
				managedRecordState,
				managedRecord,
			);
			if (!revivedRecord) {
				await this.viewerBackend.close(request.request_id, {
					handle: reopenHandle,
					backend: this.viewerBackend.name,
				}).catch(() => undefined);
				const conflictReason = `Tracked pdf_id=${request.pdf_id} changed lifecycle state while jump_pdf was reopening; aborting reopened jump.`;
				return {
					protocol_version: this.protocolVersion,
					request_id: request.request_id,
					operation: "jump_pdf",
					status: "error",
					generated_at_ns: Date.now() * 1_000_000,
					error: conflictReason,
					status_details: {
						protocol_version: this.protocolVersion,
						supported: false,
						service_available: false,
						workspace_context: request.workspace_context,
						request_id: request.request_id,
						operation: "jump_pdf",
						backend: managedRecord.viewerBackend,
						backend_path: reopenBackendPath,
						handled: false,
						closed: true,
						reopened: false,
						pdf_id: request.pdf_id,
						pdf: managedRecord.pdfPath,
						source_file: resolvedSourceFile,
						line: request.line,
						source_line: sourceLine,
						error_code: "conflict",
						reason: conflictReason,
						handle: reopenHandle,
						diagnostics: initialDiagnostics,
						managed_record: managedRecord,
					},
				};
			}
			managedRecord = revivedRecord;
			managedRecord.viewerHandle = reopenHandle;
			managedRecord.pid = reopenPid;
			managedRecord.pidDiagnostic = reopenPidDiagnostic;
			managedRecord.reused = reopenReused;
			managedRecord.viewerOwned = reopenOwned;
			managedRecord.capabilities = reopenCapabilities;
			managedRecord.backendPath = reopenBackendPath;
			managedRecord.defaultSourcePath =
				managedRecord.defaultSourcePath ?? inferDefaultSourceFileForPdf(managedRecord.pdfPath);

			const retryAttempt = await jumpBackend(reopenPid, resolvedSourceFile);
			const retryDetails = retryAttempt.status_details as Record<string, unknown>;
			const retryHandled =
				typeof retryDetails.handled === "boolean" ? retryDetails.handled : false;
			const retryDiagnostics = Array.isArray(retryDetails.diagnostics) ? retryDetails.diagnostics : [];
			const retryBackendIdentityOk =
				typeof retryDetails.backend_identity_ok === "boolean"
					? retryDetails.backend_identity_ok
					: false;
			const retryServiceAvailable =
				typeof retryDetails.service_available === "boolean" ? retryDetails.service_available : true;
			const retryReason =
				typeof retryDetails.reason === "string" && retryDetails.reason.trim()
					? retryDetails.reason
					: retryAttempt.error;
			if (retryAttempt.status === "ok") {
				return makeSuccessResponse(
					retryHandled,
					true,
					undefined,
					retryReason,
					retryBackendIdentityOk,
					retryServiceAvailable,
					retryDiagnostics,
				);
			}
			const staleRetryReason = retryAttempt.error
				? `${initialReason ?? ""} ${retryAttempt.error}`.trim()
				: "recovered handle jump failed";
			return {
				protocol_version: this.protocolVersion,
				request_id: request.request_id,
				operation: "jump_pdf",
				status: "error",
				generated_at_ns: Date.now() * 1_000_000,
				error:
					`Tracked PDF pdf_id=${request.pdf_id} appears closed or unavailable, stale handle retry failed for ${managedRecord.pdfPath}: ${staleRetryReason}`,
				status_details: {
					protocol_version: this.protocolVersion,
					supported: false,
					service_available: false,
					workspace_context: request.workspace_context,
					request_id: request.request_id,
					operation: "jump_pdf",
					backend: managedRecord.viewerBackend,
					backend_path: reopenBackendPath,
					backend_identity_ok: retryBackendIdentityOk,
					handled: false,
					reopened: true,
					pdf_id: request.pdf_id,
					pdf: managedRecord.pdfPath,
					source_file: resolvedSourceFile,
					line: request.line,
					source_line: sourceLine,
					error_code:
						typeof retryDetails.error_code === "string"
							? retryDetails.error_code
							: "backend_unavailable",
					reason: staleRetryReason,
					handle: managedRecord.viewerHandle,
					diagnostics: initialDiagnostics
						? [...initialDiagnostics, ...retryDiagnostics]
						: retryDiagnostics,
					managed_record: managedRecord,
				},
			};
		}

		const firstReason = initialReason ? `${initialReason}` : "closed or unavailable";
		const secondReason =
			typeof reopenDetails.error === "string" ? reopenDetails.error : "reopen failed";
		const reopenFailureReason = `${firstReason} ${secondReason}`.trim();
		return {
			protocol_version: this.protocolVersion,
			request_id: request.request_id,
			operation: "jump_pdf",
			status: "error",
			generated_at_ns: Date.now() * 1_000_000,
			error:
				`Tracked PDF pdf_id=${request.pdf_id} is not available, and reopen failed for handle ${managedRecord.viewerHandle} at ${managedRecord.pdfPath}: ${reopenFailureReason}`,
			status_details: {
				protocol_version: this.protocolVersion,
				supported: false,
				service_available: false,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: "jump_pdf",
				backend: managedRecord.viewerBackend,
				backend_path: managedBackendPath,
				handled: false,
				reopened: false,
				pdf_id: request.pdf_id,
				pdf: managedRecord.pdfPath,
				source_file: resolvedSourceFile,
				line: request.line,
				source_line: sourceLine,
				error_code:
					typeof reopenAttempt.status === "string"
						? typeof reopenDetails.error_code === "string"
							? reopenDetails.error_code
							: "backend_unavailable"
						: "backend_unavailable",
					reason: reopenFailureReason,
					handle: managedRecord.viewerHandle,
					diagnostics: initialDiagnostics,
					managed_record: managedRecord,
				},
			};
	}

	private async closeTimedOutOpenResult(
		requestId: string,
		backendResult: Awaited<ReturnType<ViewerBackendAdapter["open"]>>,
	): Promise<void> {
		if (backendResult.status !== "ok") {
			return;
		}
		const backendDetails = backendResult.status_details as Record<string, unknown>;
		const handle =
			typeof backendDetails.handle === "string" && backendDetails.handle.trim()
				? backendDetails.handle
				: undefined;
		if (!handle || !Boolean(backendDetails.owned) || Boolean(backendDetails.reused)) {
			return;
		}
		const capabilities = isValidViewerBackendCapabilities(backendDetails.capabilities)
			? backendDetails.capabilities
			: this.viewerBackend.capabilities;
		if (!capabilities.close) {
			return;
		}
		try {
			await this.viewerBackend.close(`${requestId}:late-open-cleanup`, {
				handle,
				backend: this.viewerBackend.name,
			});
		} catch {
			// Best effort: the original request already timed out and no pdf_id was returned.
		}
	}

	private trackManagedRecord(record: HostServiceManagedViewerRecordInput): HostServiceManagedViewerRecord {
		return this.managedViewerRecords.trackRecord(record);
	}
}

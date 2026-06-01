import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	rasterizePdfPage,
	rasterizePdfPages,
	mergeInlinePreviewArtifacts,
} from "./preview/inline_preview.ts";
import type {
	HostServiceRasterizeArtifact,
	HostServiceRasterizeRequest,
	HostServiceRasterizeResponseEnvelope,
	HostServiceWorkspaceContext,
} from "./host_service_protocol.ts";

export type { HostServiceRasterizeArtifact };

export function normalizeWorkspaceContextForRasterize(context: HostServiceWorkspaceContext): HostServiceWorkspaceContext {
	const normalized = {
		cwd: context.cwd,
		workspace_root: context.workspace_root,
		session_id: context.session_id,
	};
	if (!isAbsolute(normalized.cwd)) {
		throw new Error("workspace_context.cwd must be absolute for rasterize");
	}
	if (normalized.workspace_root !== undefined && !isAbsolute(normalized.workspace_root)) {
		throw new Error("workspace_context.workspace_root must be absolute for rasterize");
	}
	return normalized;
}

function getExistingArtifacts(...paths: string[]): string[] {
	const seen = new Set<string>();
	for (const artifactPath of paths) {
		if (!artifactPath || seen.has(artifactPath)) continue;
		if (existsSync(artifactPath)) {
			seen.add(artifactPath);
		}
	}
	return [...seen];
}

export async function executeRasterizePdfRequest(
	protocolVersion: number,
	request: HostServiceRasterizeRequest,
): Promise<HostServiceRasterizeResponseEnvelope> {
	const shouldMerge = request.details.merge_pages !== false;
	const pdfPath = isAbsolute(request.details.pdf_path)
		? request.details.pdf_path
		: resolve(request.workspace_context.cwd, request.details.pdf_path);
	const dpi = request.details.dpi ?? 150;
	const requestedPage = request.details.page;

	const artifactsSource = async (): Promise<HostServiceRasterizeArtifact[]> => {
		if (requestedPage === undefined) {
			return rasterizePdfPages(pdfPath, { dpi });
		}
		return [await rasterizePdfPage(pdfPath, { page: requestedPage, dpi })];
	};

	try {
		if (!existsSync(pdfPath)) {
			throw new Error(`pdf_path does not exist: ${pdfPath}`);
		}
		const rasterized = await artifactsSource();
		const artifacts = shouldMerge ? await mergeInlinePreviewArtifacts(rasterized, {}) : rasterized;
		const nowNs = Date.now() * 1_000_000;
		return {
			protocol_version: protocolVersion,
			request_id: request.request_id,
			operation: request.operation,
			status: "ok",
			generated_at_ns: nowNs,
			status_details: {
				protocol_version: protocolVersion,
				supported: true,
				service_available: true,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: request.operation,
				pdf_path: pdfPath,
				artifacts,
				artifact_paths: getExistingArtifacts(...artifacts.map((entry) => entry.pngPath)),
			},
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const nowNs = Date.now() * 1_000_000;
		return {
			protocol_version: protocolVersion,
			request_id: request.request_id,
			operation: request.operation,
			status: "error",
			generated_at_ns: nowNs,
			error: errorMessage,
			status_details: {
				protocol_version: protocolVersion,
				supported: true,
				service_available: true,
				workspace_context: request.workspace_context,
				request_id: request.request_id,
				operation: request.operation,
				pdf_path: pdfPath,
				artifacts: [],
				artifact_paths: [],
				error_code: extractRasterizationErrorCode(error),
			},
		};
	}
}

export function extractRasterizationErrorCode(error: unknown): string {
	if (error instanceof Error && /does not exist/.test(error.message)) {
		return "invalid_request";
	}
	return "rasterization_failed";
}

export function buildRasterizeErrorResponse(
	protocolVersion: number,
	requestId: string,
	workspaceContext: HostServiceWorkspaceContext,
	pdfPath: string,
	errorCode: string,
	errorText: string,
): string {
	const nowNs = Date.now() * 1_000_000;
	const response = {
		protocol_version: protocolVersion,
		request_id: requestId,
		operation: "rasterize" as const,
		status: "error",
		generated_at_ns: nowNs,
		error: errorText,
		status_details: {
			protocol_version: protocolVersion,
			supported: false,
			service_available: false,
			workspace_context: workspaceContext,
			request_id: requestId,
			operation: "rasterize" as const,
			pdf_path: pdfPath,
			artifacts: [],
			artifact_paths: [],
			error_code: errorCode,
		},
	};
	return `${JSON.stringify(response)}\n`;
}

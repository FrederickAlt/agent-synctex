import type { AcknowledgedPdfMark, PendingPdfMarkClaim, ReleasedPdfMark } from "./pending_pdf_marks.ts";
import { validateViewerHostToMcpMessage, VIEWER_HOST_CONTROL_TOKEN_HEADER, type ViewerHostPdfAnnotationMessage } from "./viewer_host_protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export interface ViewerHostMarksClientOptions {
	origin: string;
	controlToken?: string;
	fetchImpl?: typeof fetch;
	requestTimeoutMs?: number;
}

export class ViewerHostMarksClient {
	private readonly origin: string;
	private readonly controlToken: string | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly requestTimeoutMs: number;

	constructor(options: ViewerHostMarksClientOptions) {
		this.origin = options.origin.replace(/\/$/, "");
		this.controlToken = options.controlToken;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	async claimPdfMarks(pdfIds?: readonly number[], maxMarks?: number): Promise<PendingPdfMarkClaim> {
		const payload = await this.postJson("/marks/claim", {
			...(pdfIds === undefined ? {} : { pdf_ids: pdfIds }),
			...(maxMarks === undefined ? {} : { max_marks: maxMarks }),
		});
		if (payload.ok !== true || !Array.isArray(payload.marks)) {
			throw new Error(errorMessage(payload, "failed to claim pending PDF marks"));
		}
		const marks = payload.marks.map((mark) => {
			const parsed = validateViewerHostToMcpMessage(mark);
			if (parsed.type !== "pdf_annotation") throw new Error("Viewer Host mark claim returned a non-annotation message");
			return parsed;
		}) as ViewerHostPdfAnnotationMessage[];
		if (marks.length > 0 && typeof payload.claim_id !== "string") throw new Error("Viewer Host mark claim omitted claim_id");
		return {
			marks,
			...(typeof payload.claim_id === "string" ? { claimId: payload.claim_id } : {}),
			...(typeof payload.lease_expires_at_ms === "number" ? { expiresAtMs: payload.lease_expires_at_ms } : {}),
		};
	}

	async acknowledgePdfMarks(claimId: string, consumed: readonly AcknowledgedPdfMark[]): Promise<AcknowledgedPdfMark[]> {
		const payload = await this.postJson("/marks/ack", { claim_id: claimId, consumed });
		if (payload.ok !== true || !Array.isArray(payload.acknowledged)) {
			throw new Error(errorMessage(payload, "failed to acknowledge pending PDF marks"));
		}
		return payload.acknowledged.filter((entry): entry is AcknowledgedPdfMark => isRecord(entry)
			&& Number.isInteger(entry.pdf_id) && Number(entry.pdf_id) > 0
			&& typeof entry.annotation_id === "string");
	}

	async releasePdfMarks(claimId: string, error?: string): Promise<ReleasedPdfMark[]> {
		const payload = await this.postJson("/marks/release", {
			claim_id: claimId,
			...(error?.trim() ? { error: error.trim() } : {}),
		});
		if (payload.ok !== true || !Array.isArray(payload.released)) {
			throw new Error(errorMessage(payload, "failed to release pending PDF marks"));
		}
		return payload.released.filter((entry): entry is ReleasedPdfMark => isRecord(entry)
			&& Number.isInteger(entry.pdf_id) && Number(entry.pdf_id) > 0
			&& typeof entry.annotation_id === "string");
	}

	private async postJson(pathname: string, body: object): Promise<Record<string, unknown>> {
		const response = await this.fetchImpl(`${this.origin}${pathname}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.controlToken === undefined ? {} : { [VIEWER_HOST_CONTROL_TOKEN_HEADER]: this.controlToken }),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.requestTimeoutMs),
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error(`Viewer Host ${pathname} returned malformed JSON`);
		}
		if (!isRecord(payload)) throw new Error(`Viewer Host ${pathname} returned an invalid response`);
		if (!response.ok) throw new Error(errorMessage(payload, `Viewer Host ${pathname} failed with HTTP ${response.status}`));
		return payload;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(payload: Record<string, unknown>, fallback: string): string {
	const error = isRecord(payload.error) ? payload.error : undefined;
	return typeof error?.message === "string" ? error.message : fallback;
}

import { randomUUID } from "node:crypto";
import type { ViewerHostPdfAnnotationMessage } from "./viewer_host_protocol.ts";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_PENDING_MARKS = 500;
const DEFAULT_MAX_CLAIM_MARKS = 20;
const MAX_CLAIM_MARKS = 100;

interface PendingMarkEntry {
	mark: ViewerHostPdfAnnotationMessage;
	sequence: number;
	version: number;
	lease?: {
		claimId: string;
		version: number;
		expiresAtMs: number;
	};
}

export interface PendingPdfMarkClaim {
	claimId?: string;
	expiresAtMs?: number;
	marks: ViewerHostPdfAnnotationMessage[];
}

export interface AcknowledgedPdfMark {
	pdf_id: number;
	annotation_id: string;
}

export type ReleasedPdfMark = AcknowledgedPdfMark;

export interface ReconciledPdfMarks {
	updated: ViewerHostPdfAnnotationMessage[];
	cleared: AcknowledgedPdfMark[];
}

export interface PendingPdfMarkStoreOptions {
	nowMs?: () => number;
	makeClaimId?: () => string;
	leaseMs?: number;
	maxPendingMarks?: number;
}

/** Owns pending user marks independently from transient Viewer Host events. */
export class PendingPdfMarkStore {
	private readonly entries = new Map<string, PendingMarkEntry>();
	private readonly nowMs: () => number;
	private readonly makeClaimId: () => string;
	private readonly leaseMs: number;
	private readonly maxPendingMarks: number;
	private nextSequence = 1;

	constructor(options: PendingPdfMarkStoreOptions = {}) {
		this.nowMs = options.nowMs ?? (() => Date.now());
		this.makeClaimId = options.makeClaimId ?? randomUUID;
		this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
		this.maxPendingMarks = positiveInteger(options.maxPendingMarks, DEFAULT_MAX_PENDING_MARKS);
	}

	upsert(mark: ViewerHostPdfAnnotationMessage): void {
		this.releaseExpiredLeases(this.nowMs());
		const key = markKey(mark.pdf_id, mark.annotation_id);
		const existing = this.entries.get(key);
		if (existing) {
			existing.mark = copyMark(mark);
			existing.sequence = this.nextSequence++;
			existing.version += 1;
			delete existing.lease;
			return;
		}
		while (this.entries.size >= this.maxPendingMarks) {
			if (!this.evictOldestUnleased()) throw new Error("pending PDF mark capacity is occupied by active claims");
		}
		this.entries.set(key, {
			mark: copyMark(mark),
			sequence: this.nextSequence++,
			version: 1,
		});
	}

	delete(pdfId: number, annotationId: string): boolean {
		return this.entries.delete(markKey(pdfId, annotationId));
	}

	clearPdf(pdfId: number): AcknowledgedPdfMark[] {
		const cleared: AcknowledgedPdfMark[] = [];
		for (const [key, entry] of this.entries) {
			if (entry.mark.pdf_id !== pdfId) continue;
			cleared.push({ pdf_id: entry.mark.pdf_id, annotation_id: entry.mark.annotation_id });
			this.entries.delete(key);
		}
		return cleared;
	}

	clear(): void {
		this.entries.clear();
		this.nextSequence = 1;
	}

	/** Replaces only marks whose new source location can be verified, discarding the rest. */
	reconcilePdf(pdfId: number, transform: (mark: ViewerHostPdfAnnotationMessage) => ViewerHostPdfAnnotationMessage | undefined): ReconciledPdfMarks {
		const updated: ViewerHostPdfAnnotationMessage[] = [];
		const cleared: AcknowledgedPdfMark[] = [];
		for (const [key, entry] of this.entries) {
			if (entry.mark.pdf_id !== pdfId) continue;
			const replacement = transform(copyMark(entry.mark));
			if (replacement === undefined) {
				cleared.push({ pdf_id: entry.mark.pdf_id, annotation_id: entry.mark.annotation_id });
				this.entries.delete(key);
				continue;
			}
			entry.mark = copyMark(replacement);
			entry.version += 1;
			// A consumer may hold the old location. Keeping its lease version stale
			// makes acknowledgement release, rather than consume, the rebased mark.
			updated.push(copyMark(entry.mark));
		}
		return { updated, cleared };
	}

	claim(options: { pdfIds?: ReadonlySet<number>; maxMarks?: number } = {}): PendingPdfMarkClaim {
		const now = this.nowMs();
		this.releaseExpiredLeases(now);
		const maxMarks = Math.min(MAX_CLAIM_MARKS, positiveInteger(options.maxMarks, DEFAULT_MAX_CLAIM_MARKS));
		const selected = Array.from(this.entries.values())
			.filter((entry) => entry.lease === undefined && (options.pdfIds === undefined || options.pdfIds.has(entry.mark.pdf_id)))
			.sort((left, right) => left.sequence - right.sequence)
			.slice(0, maxMarks);
		if (selected.length === 0) return { marks: [] };

		const claimId = this.makeClaimId();
		const expiresAtMs = now + this.leaseMs;
		for (const entry of selected) {
			entry.lease = { claimId, version: entry.version, expiresAtMs };
		}
		return { claimId, expiresAtMs, marks: selected.map((entry) => copyMark(entry.mark)) };
	}

	acknowledge(claimId: string, consumedMarks?: readonly AcknowledgedPdfMark[]): AcknowledgedPdfMark[] {
		const now = this.nowMs();
		const acknowledged: AcknowledgedPdfMark[] = [];
		const consumedKeys = consumedMarks === undefined ? undefined : new Set(consumedMarks.map((mark) => markKey(mark.pdf_id, mark.annotation_id)));
		const claimedEntries = Array.from(this.entries.entries())
			.filter(([, entry]) => entry.lease?.claimId === claimId)
			.sort(([, left], [, right]) => left.sequence - right.sequence);
		for (const [key, entry] of claimedEntries) {
			if (entry.lease === undefined) continue;
			if (entry.lease.expiresAtMs <= now || entry.lease.version !== entry.version) {
				delete entry.lease;
				continue;
			}
			if (consumedKeys !== undefined && !consumedKeys.has(key)) {
				delete entry.lease;
				continue;
			}
			acknowledged.push({ pdf_id: entry.mark.pdf_id, annotation_id: entry.mark.annotation_id });
			this.entries.delete(key);
		}
		return acknowledged;
	}

	release(claimId: string): ReleasedPdfMark[] {
		const released: ReleasedPdfMark[] = [];
		for (const entry of this.entries.values()) {
			if (entry.lease?.claimId !== claimId) continue;
			released.push({ pdf_id: entry.mark.pdf_id, annotation_id: entry.mark.annotation_id });
			delete entry.lease;
		}
		return released;
	}

	get size(): number {
		return this.entries.size;
	}

	private releaseExpiredLeases(now: number): void {
		for (const entry of this.entries.values()) {
			if (entry.lease !== undefined && entry.lease.expiresAtMs <= now) delete entry.lease;
		}
	}

	private evictOldestUnleased(): boolean {
		let oldestKey: string | undefined;
		let oldestSequence = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.entries) {
			if (entry.lease !== undefined) continue;
			if (entry.sequence >= oldestSequence) continue;
			oldestKey = key;
			oldestSequence = entry.sequence;
		}
		if (oldestKey === undefined) return false;
		this.entries.delete(oldestKey);
		return true;
	}
}

function markKey(pdfId: number, annotationId: string): string {
	return `${pdfId}\0${annotationId}`;
}

function copyMark(mark: ViewerHostPdfAnnotationMessage): ViewerHostPdfAnnotationMessage {
	return {
		...mark,
		...(mark.source_spans === undefined ? {} : { source_spans: mark.source_spans.map((span) => ({ ...span })) }),
		...(mark.source_span === undefined ? {} : { source_span: { ...mark.source_span } }),
		...(mark.synctex_diagnostics === undefined ? {} : { synctex_diagnostics: structuredClone(mark.synctex_diagnostics) }),
	};
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

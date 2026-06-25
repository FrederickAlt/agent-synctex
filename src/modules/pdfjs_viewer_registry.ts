import { randomInt } from "node:crypto";
import { resolve } from "node:path";
const MIN_ACTIVE_PDF_ID = 1;
const MAX_ACTIVE_PDF_ID = 99_999_999;
const DEFAULT_MIN_PDF_ID = MIN_ACTIVE_PDF_ID;
const DEFAULT_MAX_PDF_ID = MAX_ACTIVE_PDF_ID;
const DEFAULT_ALLOCATION_ATTEMPTS = 64;

export interface PdfJsViewerClient {
	send(message: string): void;
}

export interface PdfJsViewerFileSnapshot {
	size: number;
	mtimeMs: number;
}

export interface PdfJsViewerRecord {
	pdfId: number;
	pdfPath: string;
	viewerUrl: string;
	createdAtNs: number;
	revision: number;
	fileSnapshot?: PdfJsViewerFileSnapshot;
	clients: Set<string>;
}

export interface PdfJsViewerClientRecord {
	clientId: string;
	pdfId: number;
	client: PdfJsViewerClient;
}

export interface PdfJsViewerRegistryOptions {
	minPdfId?: number;
	maxPdfId?: number;
	makePdfId?: () => number;
	maxAllocationAttempts?: number;
	makeClientId?: () => string;
}

export class PdfJsViewerRegistry {
	private readonly minPdfId: number;
	private readonly maxPdfId: number;
	private readonly makePdfId: () => number;
	private readonly maxAllocationAttempts: number;
	private readonly makeClientId: () => string;
	private readonly activeRecords = new Map<number, PdfJsViewerRecord>();
	private readonly activeRecordsByPath = new Map<string, PdfJsViewerRecord>();
	private readonly closedRecords = new Map<number, PdfJsViewerRecord>();
	private readonly clients = new Map<string, PdfJsViewerClientRecord>();
	private nextClientSequence = 0;

	constructor(options: PdfJsViewerRegistryOptions = {}) {
		this.minPdfId = options.minPdfId ?? DEFAULT_MIN_PDF_ID;
		this.maxPdfId = options.maxPdfId ?? DEFAULT_MAX_PDF_ID;
		if (
			!Number.isInteger(this.minPdfId)
			|| !Number.isInteger(this.maxPdfId)
			|| this.minPdfId < MIN_ACTIVE_PDF_ID
			|| this.maxPdfId > MAX_ACTIVE_PDF_ID
			|| this.maxPdfId < this.minPdfId
		) {
			throw new Error("invalid pdf id range");
		}
		this.makePdfId = options.makePdfId ?? (() => randomInt(this.minPdfId, this.maxPdfId + 1));
		this.maxAllocationAttempts = options.maxAllocationAttempts ?? DEFAULT_ALLOCATION_ATTEMPTS;
		if (!Number.isInteger(this.maxAllocationAttempts) || this.maxAllocationAttempts <= 0) {
			throw new Error("invalid maxAllocationAttempts");
		}
		this.makeClientId = options.makeClientId ?? (() => {
			this.nextClientSequence += 1;
			return `viewer-client-${this.nextClientSequence}`;
		});
	}

	get activeCount(): number {
		return this.activeRecords.size;
	}

	registerPdf(input: { pdfPath: string; viewerUrl?: string; viewerUrlForPdfId?: (pdfId: number) => string; fileSnapshot?: PdfJsViewerFileSnapshot }): PdfJsViewerRecord {
		const pdfPath = resolve(input.pdfPath);
		const existing = this.activeRecordsByPath.get(pdfPath);
		if (existing) {
			return existing;
		}
		const pdfId = this.allocatePdfId();
		const viewerUrl = input.viewerUrl ?? input.viewerUrlForPdfId?.(pdfId);
		if (viewerUrl === undefined || !viewerUrl.trim()) {
			throw new Error("viewerUrl is required");
		}
		const record: PdfJsViewerRecord = {
			pdfId,
			pdfPath,
			viewerUrl,
			createdAtNs: Date.now() * 1_000_000,
			revision: 1,
			...(input.fileSnapshot === undefined ? {} : { fileSnapshot: input.fileSnapshot }),
			clients: new Set(),
		};
		this.activeRecords.set(pdfId, record);
		this.activeRecordsByPath.set(pdfPath, record);
		return record;
	}

	getActiveRecord(pdfId: number): PdfJsViewerRecord {
		const record = this.activeRecords.get(pdfId);
		if (record) return record;
		if (this.closedRecords.has(pdfId)) {
			throw new Error(`Closed pdf_id=${pdfId}: this record has been removed and is no longer active`);
		}
		throw new Error(`Unknown pdf_id=${pdfId}: no active pdf record found`);
	}

	findActiveRecordByPath(pdfPath: string): PdfJsViewerRecord | undefined {
		return this.activeRecordsByPath.get(resolve(pdfPath));
	}

	activePdfRecords(): PdfJsViewerRecord[] {
		return Array.from(this.activeRecords.values());
	}

	updatePdfSnapshot(pdfId: number, fileSnapshot: PdfJsViewerFileSnapshot): { changed: boolean; revision: number; record: PdfJsViewerRecord } {
		const record = this.getActiveRecord(pdfId);
		if (record.fileSnapshot && arePdfSnapshotsEqual(record.fileSnapshot, fileSnapshot)) {
			return { changed: false, revision: record.revision, record };
		}
		record.fileSnapshot = fileSnapshot;
		record.revision += 1;
		return { changed: true, revision: record.revision, record };
	}

	closePdf(pdfId: number): PdfJsViewerRecord {
		const record = this.activeRecords.get(pdfId);
		if (!record) {
			this.getActiveRecord(pdfId);
			throw new Error(`Unable to close pdf_id=${pdfId}`);
		}
		for (const clientId of Array.from(record.clients)) {
			this.removeClient(clientId);
		}
		this.activeRecords.delete(pdfId);
		this.activeRecordsByPath.delete(record.pdfPath);
		this.closedRecords.set(pdfId, record);
		return record;
	}

	addClient(pdfId: number, client: PdfJsViewerClient): string {
		const record = this.getActiveRecord(pdfId);
		let clientId = this.makeClientId();
		while (this.clients.has(clientId)) {
			clientId = this.makeClientId();
		}
		record.clients.add(clientId);
		this.clients.set(clientId, { clientId, pdfId, client });
		return clientId;
	}

	removeClient(clientId: string): void {
		const clientRecord = this.clients.get(clientId);
		if (!clientRecord) return;
		this.clients.delete(clientId);
		const record = this.activeRecords.get(clientRecord.pdfId) ?? this.closedRecords.get(clientRecord.pdfId);
		record?.clients.delete(clientId);
	}

	clientRecord(clientId: string): PdfJsViewerClientRecord | undefined {
		return this.clients.get(clientId);
	}

	clientCount(pdfId: number): number {
		return this.activeRecords.get(pdfId)?.clients.size ?? 0;
	}

	sendToClients(pdfId: number, message: string): number {
		const record = this.activeRecords.get(pdfId);
		if (!record) return 0;
		let sent = 0;
		for (const clientId of record.clients) {
			const clientRecord = this.clients.get(clientId);
			if (!clientRecord) continue;
			try {
				clientRecord.client.send(message);
				sent += 1;
			} catch {
				// Best effort notification. Disconnect cleanup is handled by the socket lifecycle.
			}
		}
		return sent;
	}

	clear(): void {
		this.activeRecords.clear();
		this.activeRecordsByPath.clear();
		this.closedRecords.clear();
		this.clients.clear();
	}

	private allocatePdfId(): number {
		const collisions: number[] = [];
		for (let attempt = 0; attempt < this.maxAllocationAttempts; attempt += 1) {
			const candidate = this.makePdfId();
			if (
				!Number.isInteger(candidate)
				|| candidate < MIN_ACTIVE_PDF_ID
				|| candidate > MAX_ACTIVE_PDF_ID
				|| candidate < this.minPdfId
				|| candidate > this.maxPdfId
			) {
				throw new Error(`Invalid generated pdf_id=${String(candidate)}; expected integer in ${this.minPdfId}..${this.maxPdfId}`);
			}
			if (this.activeRecords.has(candidate) || this.closedRecords.has(candidate)) {
				collisions.push(candidate);
				continue;
			}
			return candidate;
		}
		throw new Error(`Unable to allocate unique active pdf_id after ${this.maxAllocationAttempts} attempts (collisions: ${collisions.join(", ")})`);
	}
}

export function arePdfSnapshotsEqual(left: PdfJsViewerFileSnapshot, right: PdfJsViewerFileSnapshot): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

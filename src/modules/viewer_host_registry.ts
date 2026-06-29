import { resolve } from "node:path";

export interface ViewerHostFileSnapshot {
	size: number;
	mtimeMs: number;
}

export interface ViewerHostPdfRegistration {
	pdfId: number;
	pdfPath: string;
	title: string;
	revision: number;
	fileSnapshot: ViewerHostFileSnapshot;
}

export interface ViewerHostPdfRecord {
	pdfId: number;
	pdfPath: string;
	title: string;
	revision: number;
	fileSnapshot: ViewerHostFileSnapshot;
	registeredAtNs: number;
	updatedAtNs: number;
}

export class ViewerHostPdfRegistry {
	private readonly records = new Map<number, ViewerHostPdfRecord>();
	private readonly nowNs: () => number;

	constructor(options: { nowNs?: () => number } = {}) {
		this.nowNs = options.nowNs ?? (() => Date.now() * 1_000_000);
	}

	registerPdf(input: ViewerHostPdfRegistration): ViewerHostPdfRecord {
		validateRegistration(input);
		const normalizedPath = resolve(input.pdfPath);
		const nowNs = this.nowNs();
		const existing = this.records.get(input.pdfId);
		if (existing) {
			existing.pdfPath = normalizedPath;
			existing.title = input.title;
			existing.revision = input.revision;
			existing.fileSnapshot = { ...input.fileSnapshot };
			existing.updatedAtNs = nowNs;
			return existing;
		}

		const record: ViewerHostPdfRecord = {
			pdfId: input.pdfId,
			pdfPath: normalizedPath,
			title: input.title,
			revision: input.revision,
			fileSnapshot: { ...input.fileSnapshot },
			registeredAtNs: nowNs,
			updatedAtNs: nowNs,
		};
		this.records.set(record.pdfId, record);
		return record;
	}

	getPdf(pdfId: number): ViewerHostPdfRecord {
		if (!Number.isInteger(pdfId) || pdfId <= 0) {
			throw new Error(`Invalid pdf_id=${String(pdfId)}`);
		}
		const record = this.records.get(pdfId);
		if (!record) {
			throw new Error(`Unknown pdf_id=${pdfId}: no Viewer Host PDF registration found`);
		}
		return copyRecord(record);
	}

	listPdfs(): ViewerHostPdfRecord[] {
		return Array.from(this.records.values(), copyRecord);
	}

	clear(): void {
		this.records.clear();
	}
}

function copyRecord(record: ViewerHostPdfRecord): ViewerHostPdfRecord {
	return { ...record, fileSnapshot: { ...record.fileSnapshot } };
}

function validateRegistration(input: ViewerHostPdfRegistration): void {
	if (!Number.isInteger(input.pdfId) || input.pdfId <= 0) {
		throw new Error("pdf_id must be a positive integer provided by MCP");
	}
	if (typeof input.pdfPath !== "string" || !input.pdfPath.trim()) {
		throw new Error("pdf_path must be a non-empty string");
	}
	if (typeof input.title !== "string" || !input.title.trim()) {
		throw new Error("title must be a non-empty string");
	}
	if (!Number.isInteger(input.revision) || input.revision <= 0) {
		throw new Error("revision must be a positive integer");
	}
	if (!input.fileSnapshot || typeof input.fileSnapshot !== "object") {
		throw new Error("fileSnapshot is required");
	}
	if (typeof input.fileSnapshot.size !== "number" || !Number.isFinite(input.fileSnapshot.size) || input.fileSnapshot.size < 0) {
		throw new Error("fileSnapshot.size must be a finite non-negative number");
	}
	if (typeof input.fileSnapshot.mtimeMs !== "number" || !Number.isFinite(input.fileSnapshot.mtimeMs) || input.fileSnapshot.mtimeMs < 0) {
		throw new Error("fileSnapshot.mtimeMs must be a finite non-negative number");
	}
}

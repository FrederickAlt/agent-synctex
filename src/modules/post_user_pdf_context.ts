import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PdfAnnotationEvent, PdfEvent } from "./pdf_events.ts";

const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MAX_FIELD_LENGTH = 240;
const DEFAULT_MAX_COMMENT_LENGTH = 500;
const DEFAULT_MAX_OUTPUT_LENGTH = 8_000;

export interface FetchPdfContextRequest {
	pdf_id?: number;
	max_events?: number;
	cwd?: string;
}

export interface PostUserPdfContextRequest {
	pdfId?: number;
	maxEvents?: number;
	clearViewer?: boolean;
	cwd?: string;
}

export interface PostUserPdfContextResult {
	text: string;
	pdfIds: number[];
	eventCount: number;
	cleared: boolean;
	events: PdfAnnotationEvent[];
}

export function collectPostUserPdfContextFromEvents(events: PdfEvent[], request: PostUserPdfContextRequest = {}): PostUserPdfContextResult {
	const maxEvents = normalizeMaxEvents(request.maxEvents);
	const annotations = dedupeAnnotations(events
		.filter((event): event is PdfAnnotationEvent => event.type === "pdf_annotation")
		.filter((event) => request.pdfId === undefined || event.pdf_id === request.pdfId))
		.slice(0, maxEvents);
	const text = formatPdfAnnotationContext(annotations, { cwd: request.cwd });
	return {
		text,
		pdfIds: Array.from(new Set(annotations.map((event) => event.pdf_id))).sort((left, right) => left - right),
		eventCount: annotations.length,
		cleared: request.clearViewer !== false && annotations.length > 0,
		events: annotations,
	};
}

export function formatPdfAnnotationContext(events: PdfAnnotationEvent[], options: { cwd?: string } = {}): string {
	if (events.length === 0) return "";
	const lines = ["## PDF marks from Agent SyncTeX", ""];
	for (const event of events) {
		const sourceLine = sourceLineForEvent(event);
		const sourceFile = displaySourceFile(event.source_file, options.cwd);
		lines.push(`- \`${sourceFile}:${event.line}\`${sourceLine ? ` — \`${escapeInlineCode(compactText(sourceLine, DEFAULT_MAX_FIELD_LENGTH))}\`` : ""}`);
		if (event.comment?.trim()) {
			lines.push(`  User comment: ${compactText(event.comment, DEFAULT_MAX_COMMENT_LENGTH)}`);
		}
	}
	return compactOutput(lines.join("\n"));
}

export function normalizeFetchPdfContextRequest(args: Record<string, unknown>): FetchPdfContextRequest {
	for (const key of Object.keys(args)) {
		if (key !== "pdf_id" && key !== "max_events") {
			throw new Error(`fetch_pdf_context unknown argument: ${key}`);
		}
	}
	if (args.pdf_id !== undefined && (typeof args.pdf_id !== "number" || !Number.isInteger(args.pdf_id) || args.pdf_id < 1)) {
		throw new Error("fetch_pdf_context pdf_id must be a positive integer");
	}
	if (args.max_events !== undefined && (typeof args.max_events !== "number" || !Number.isInteger(args.max_events) || args.max_events < 1)) {
		throw new Error("fetch_pdf_context max_events must be a positive integer");
	}
	return {
		...(args.pdf_id === undefined ? {} : { pdf_id: args.pdf_id }),
		...(args.max_events === undefined ? {} : { max_events: args.max_events }),
	};
}

function dedupeAnnotations(events: PdfAnnotationEvent[]): PdfAnnotationEvent[] {
	const byKey = new Map<string, PdfAnnotationEvent>();
	for (const event of events) {
		byKey.set(`${event.pdf_id}:${event.annotation_id}`, event);
	}
	return Array.from(byKey.values()).sort((left, right) => left.sequence - right.sequence);
}

function displaySourceFile(sourceFile: string, cwd: string | undefined): string {
	if (!cwd) return sourceFile;
	try {
		const resolvedCwd = resolve(cwd);
		const resolvedSource = isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(resolvedCwd, sourceFile);
		const relativePath = relative(resolvedCwd, resolvedSource);
		if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath;
	} catch {
		return sourceFile;
	}
	return sourceFile;
}

function sourceLineForEvent(event: PdfAnnotationEvent): string | undefined {
	if (event.source_line !== undefined) return event.source_line;
	try {
		const lines = readFileSync(event.source_file, "utf8").split(/\r?\n/);
		return lines[event.line - 1];
	} catch {
		return undefined;
	}
}

function normalizeMaxEvents(maxEvents: number | undefined): number {
	return maxEvents === undefined ? DEFAULT_MAX_EVENTS : Math.max(1, Math.min(maxEvents, DEFAULT_MAX_EVENTS));
}

function compactText(value: string, maxLength: number): string {
	const compacted = value.replace(/\s+/g, " ").trim();
	return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}…` : compacted;
}

function compactOutput(value: string): string {
	return value.length > DEFAULT_MAX_OUTPUT_LENGTH ? `${value.slice(0, DEFAULT_MAX_OUTPUT_LENGTH - 1)}…` : value;
}

function escapeInlineCode(value: string): string {
	return value.replace(/`/g, "\\`");
}

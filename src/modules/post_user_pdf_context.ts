import { isAbsolute, relative, resolve } from "node:path";
import type { PdfAnnotationEvent, PdfEvent } from "./pdf_events.ts";
import type { ViewerHostPdfAnnotationMessage } from "./viewer_host_protocol.ts";

const DEFAULT_MAX_EVENTS = 20;

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
	const candidates = dedupeAnnotations(events
		.filter((event): event is PdfAnnotationEvent => event.type === "pdf_annotation")
		.filter((event) => request.pdfId === undefined || event.pdf_id === request.pdfId))
		.slice(0, maxEvents);
	const formatted = formatPdfAnnotationContextResult(candidates, { cwd: request.cwd });
	return {
		text: formatted.text,
		pdfIds: Array.from(new Set(formatted.events.map((event) => event.pdf_id))).sort((left, right) => left - right),
		eventCount: formatted.events.length,
		cleared: request.clearViewer !== false && formatted.events.length > 0,
		events: formatted.events,
	};
}

export function pdfAnnotationEventsFromViewerMarks(
	marks: readonly ViewerHostPdfAnnotationMessage[],
	options: { timestamp?: string } = {},
): PdfAnnotationEvent[] {
	const timestamp = options.timestamp ?? new Date().toISOString();
	return marks.map((mark, index) => ({
		type: "pdf_annotation",
		sequence: index + 1,
		pdf_id: mark.pdf_id,
		annotation_id: mark.annotation_id,
		timestamp,
		source_file: mark.source_file,
		line: mark.line,
		...(mark.source_line === undefined ? {} : { source_line: mark.source_line }),
		...(mark.pdf_mark === undefined ? {} : { pdf_mark: mark.pdf_mark }),
		...(mark.source_span === undefined ? {} : { source_span: { ...mark.source_span } }),
		page: mark.page,
		x: mark.x,
		y: mark.y,
		...(mark.comment === undefined ? {} : { comment: mark.comment }),
	}));
}

export function formatPdfAnnotationContext(events: PdfAnnotationEvent[], options: { cwd?: string } = {}): string {
	return formatPdfAnnotationContextResult(events, options).text;
}

function formatPdfAnnotationContextResult(events: PdfAnnotationEvent[], options: { cwd?: string } = {}): { text: string; events: PdfAnnotationEvent[] } {
	if (events.length === 0) return { text: "", events: [] };
	const groups = new Map<string, { sourceLocation: string; events: PdfAnnotationEvent[] }>();
	for (const event of events) {
		const sourceLocation = displaySourceLocation(event, options.cwd);
		const group = groups.get(sourceLocation) ?? { sourceLocation, events: [] };
		group.events.push(event);
		groups.set(sourceLocation, group);
	}
	const lines = ["## PDF marks from the User", ""];
	for (const group of groups.values()) {
		const pdfMarks = group.events.map((event) => event.pdf_mark?.trim()).filter((mark): mark is string => Boolean(mark));
		const eventLines = [`- ${group.sourceLocation}`];
		if (pdfMarks.length > 0) eventLines.push(`  PDF mark: \`${escapeInlineCode(pdfMarks.join("; "))}\``);
		const comments = group.events.map((event) => event.comment?.trim()).filter((comment): comment is string => Boolean(comment));
		if (comments.length === 1) eventLines.push(`  User comment: ${comments[0]}`);
		else if (comments.length > 1) eventLines.push(`  User comments: ${comments.join("; ")}`);
		lines.push(...eventLines);
	}
	return { text: lines.join("\n"), events };
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

function displaySourceLocation(event: PdfAnnotationEvent, cwd: string | undefined): string {
	const span = event.source_span;
	if (span !== undefined) {
		const spanFile = displaySourceFile(span.source_file, cwd);
		return `${spanFile}:${span.start_line}-${span.end_line}`;
	}
	return `${displaySourceFile(event.source_file, cwd)}:${event.line}`;
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

function normalizeMaxEvents(maxEvents: number | undefined): number {
	return maxEvents === undefined ? DEFAULT_MAX_EVENTS : Math.max(1, Math.min(maxEvents, DEFAULT_MAX_EVENTS));
}

function escapeInlineCode(value: string): string {
	return value.replace(/`/g, "\\`");
}

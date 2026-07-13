import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PdfAnnotationEvent, PdfEvent } from "./pdf_events.ts";
import type { ViewerHostPdfAnnotationMessage } from "./viewer_host_protocol.ts";

const DEFAULT_MAX_EVENTS = 20;
const MAX_SOURCE_EXCERPT_BYTES = 1_000_000;

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
		...(mark.source_spans === undefined ? {} : { source_spans: mark.source_spans.map((span) => ({ ...span })) }),
		...(mark.source_span === undefined ? {} : { source_span: { ...mark.source_span } }),
		...(mark.source_stale === true ? { source_stale: true } : {}),
			...(mark.synctex_diagnostics === undefined ? {} : { synctex_diagnostics: structuredClone(mark.synctex_diagnostics) }),
		page: mark.page,
		x: mark.x,
		y: mark.y,
		...(mark.comment === undefined ? {} : { comment: mark.comment }),
	}));
}

export function formatPdfAnnotationContext(events: PdfAnnotationEvent[], options: { cwd?: string } = {}): string {
	return formatPdfAnnotationContextResult(events, options).text;
}

interface PdfAnnotationContextGroup {
	events: PdfAnnotationEvent[];
	spans: Array<{ source_file: string; start_line: number; end_line: number }>;
}

function formatPdfAnnotationContextResult(events: PdfAnnotationEvent[], options: { cwd?: string } = {}): { text: string; events: PdfAnnotationEvent[] } {
	if (events.length === 0) return { text: "", events: [] };
	const groups = groupAnnotationEvents(events);
	const sourceCache = new Map<string, string[] | undefined>();
	const lines = ["## PDF marks from the User", ""];
	for (const group of groups) {
		const { spans } = group;
		const sourceLine = group.events.find((event) => event.source_line?.trim())?.source_line?.trim();
		let remainingLines = 50;
		lines.push(`- ${spans.map((span) => `${displaySourceFile(span.source_file, options.cwd)}:${formatLineRange(span.start_line, span.end_line)}`).join(", ")}`);
		if (group.events.some((event) => event.source_stale === true)) {
			lines.push("  Warning: this source changed after the displayed PDF was compiled; the excerpt is current, but the mark may refer to the earlier PDF.");
		}
		let sourceBudgetOmitted = false;
		for (const span of spans) {
			if (remainingLines === 0) {
				sourceBudgetOmitted = true;
				continue;
			}
			const sourceExcerpt = readSourceExcerpt(span.source_file, span.start_line, span.end_line, options.cwd, sourceCache, remainingLines);
			if (sourceExcerpt !== undefined) {
				const excerptLabel = spans.length === 1
					? "  TeX source excerpt:"
					: `  TeX source excerpt: ${displaySourceFile(span.source_file, options.cwd)}:${formatLineRange(span.start_line, span.end_line)}`;
				lines.push(excerptLabel, "  ```tex", ...sourceExcerpt.lines.map((line) => `  ${line}`), "  ```");
				remainingLines -= sourceExcerpt.lines.length;
				if (sourceExcerpt.truncated) lines.push(remainingLines === 0 && spans.length > 1
					? "  (excerpt truncated to the 50-source-line total budget per annotation)"
					: "  (excerpt truncated to 50 lines)");
			} else if (spans.length === 1 && sourceLine !== undefined) {
				lines.push(`  TeX source excerpt: \`${escapeInlineCode(sourceLine)}\``);
			}
		}
		if (sourceBudgetOmitted) lines.push("  (source excerpt omitted: 50-source-line total budget per annotation exhausted)");
		for (const event of group.events) formatSynctexDiagnostics(event, lines);
		const comments = group.events
			.map((event) => event.comment?.trim())
			.filter((comment): comment is string => comment !== undefined && comment !== "");
		if (comments.length > 0) {
			lines.push("  Messages:", ...comments.map((comment) => `  - ${comment.replace(/\n/g, "\n    ")}`));
		}
	}
	return { text: lines.join("\n"), events: groups.flatMap((group) => group.events) };
}

const MAX_FORMATTED_SYNCTEX_DEBUG_PROPOSALS = 3;
const MAX_FORMATTED_SYNCTEX_DEBUG_GROUPS = 12;
const MAX_FORMATTED_SYNCTEX_DEBUG_BOXES = 4;

function formatSynctexDiagnostics(event: PdfAnnotationEvent, lines: string[]): void {
	const diagnostics = event.synctex_diagnostics;
	if (diagnostics === undefined) return;
	lines.push("  SyncTeX debug diagnostics (bounded):");
	if (diagnostics.selected_score !== undefined) lines.push(`  - selected proposal score: ${formatDebugNumber(diagnostics.selected_score)}`);
	for (const [index, proposal] of diagnostics.top_proposals.slice(0, MAX_FORMATTED_SYNCTEX_DEBUG_PROPOSALS).entries()) {
		lines.push(`  - top proposal #${index + 1}: ${proposal.source_file}:${proposal.line}:${proposal.column}; provenance=${proposal.provenance}; score=${formatDebugNumber(proposal.score)}; tier=${proposal.geometry_tier}; precision=${proposal.precision}`);
	}
	if (diagnostics.top_proposals.length > MAX_FORMATTED_SYNCTEX_DEBUG_PROPOSALS) lines.push(`  - (top proposals truncated to ${MAX_FORMATTED_SYNCTEX_DEBUG_PROPOSALS})`);
	for (const [groupIndex, group] of diagnostics.forward_groups.slice(0, MAX_FORMATTED_SYNCTEX_DEBUG_GROUPS).entries()) {
		lines.push(`  - forward group ${group.selected ? "* " : ""}#${groupIndex + 1}: ${group.origin} lookup line ${group.lookup_line}; proposal=${group.proposal.provenance}; score=${formatDebugNumber(group.score)}; tier=${group.geometry_tier}; boxes=${group.box_scores.length}/${group.box_score_count}`);
		for (const [boxIndex, boxScore] of group.box_scores.slice(0, MAX_FORMATTED_SYNCTEX_DEBUG_BOXES).entries()) {
			const box = boxScore.box;
			lines.push(`    - box ${boxScore.selected ? "* " : ""}#${boxIndex + 1}: page ${box.page} [${formatDebugNumber(box.h)}, ${formatDebugNumber(box.v)}, ${formatDebugNumber(box.W)}, ${formatDebugNumber(box.H)}]; score=${formatDebugNumber(boxScore.total)}; terms distance=${formatDebugNumber(boxScore.distance_term)}, area=${formatDebugNumber(boxScore.area_term)}, tiny=${formatDebugNumber(boxScore.tiny_penalty)}, semantic=${formatDebugNumber(boxScore.semantic_penalty)}, blank=${formatDebugNumber(boxScore.blank_source_line_penalty)}, click=${formatDebugNumber(boxScore.click_containment_bonus)}, text=${formatDebugNumber(boxScore.text_containment_bonus)}, end=${formatDebugNumber(boxScore.end_document_penalty)}`);
			const treeCandidate = boxScore.tree_candidate;
			if (treeCandidate !== undefined) lines.push(`      parsed tree: leaf ${treeCandidate.leaf.source_file}:${treeCandidate.leaf.line}; box ${treeCandidate.box.type}; ancestors=${treeCandidate.ancestors.length}${treeCandidate.ancestors_truncated === true ? "+" : ""}`);
		}
		if (group.box_scores.length > MAX_FORMATTED_SYNCTEX_DEBUG_BOXES) lines.push(`    - (box scores truncated to ${MAX_FORMATTED_SYNCTEX_DEBUG_BOXES})`);
	}
	if (diagnostics.forward_groups.length > MAX_FORMATTED_SYNCTEX_DEBUG_GROUPS) lines.push(`  - (forward groups truncated to ${MAX_FORMATTED_SYNCTEX_DEBUG_GROUPS})`);
}

function formatDebugNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?(?:0+)$/, "");
}

function groupAnnotationEvents(events: PdfAnnotationEvent[]): PdfAnnotationContextGroup[] {
	const groupsByKey = new Map<string, PdfAnnotationContextGroup>();
	for (const event of events) {
		const spans = sourceSpansForAnnotation(event);
		const key = `${event.pdf_id}\u0000${spans.map((span) => `${span.source_file}\u0000${span.start_line}\u0000${span.end_line}`).join("\u0001")}`;
		let group = groupsByKey.get(key);
		if (group === undefined) {
			group = { events: [], spans };
			groupsByKey.set(key, group);
		}
		group.events.push(event);
	}
	return Array.from(groupsByKey.values());
}

function sourceSpansForAnnotation(event: PdfAnnotationEvent): Array<{ source_file: string; start_line: number; end_line: number }> {
	if (event.source_spans !== undefined && event.source_spans.length > 0) return event.source_spans;
	if (event.source_span !== undefined) return [event.source_span];
	return [{ source_file: event.source_file, start_line: event.line, end_line: event.line }];
}

function readSourceExcerpt(sourceFile: string, startLine: number, endLine: number, cwd: string | undefined, cache: Map<string, string[] | undefined>, maxLines: number): { lines: string[]; truncated: boolean } | undefined {
	const path = isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(cwd ?? process.cwd(), sourceFile);
	let sourceLines: string[] | undefined;
	if (cache.has(path)) sourceLines = cache.get(path);
	else {
		try {
			const resolvedPath = realpathSync(path);
			if (cwd !== undefined) {
				const workspacePath = realpathSync(resolve(cwd));
				const relativePath = relative(workspacePath, resolvedPath);
				if (relativePath !== "" && (relativePath.startsWith("..") || isAbsolute(relativePath))) throw new Error("source is outside workspace");
			}
			const status = statSync(resolvedPath);
			sourceLines = !status.isFile() || status.size > MAX_SOURCE_EXCERPT_BYTES
				? undefined
				: readFileSync(resolvedPath, "utf8").replace(/\r\n?/g, "\n").split("\n");
		} catch {
			sourceLines = undefined;
		}
		cache.set(path, sourceLines);
	}
	if (sourceLines === undefined) return undefined;
	const lines = sourceLines.slice(startLine - 1, endLine);
	return lines.length === 0 ? undefined : { lines: lines.slice(0, maxLines), truncated: lines.length > maxLines };
}

function formatLineRange(startLine: number, endLine: number): string {
	return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
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

function normalizeMaxEvents(maxEvents: number | undefined): number {
	return maxEvents === undefined ? DEFAULT_MAX_EVENTS : Math.max(1, Math.min(maxEvents, DEFAULT_MAX_EVENTS));
}

function escapeInlineCode(value: string): string {
	return value.replace(/`/g, "\\`");
}

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { resolveForwardSynctexJump } from "./synctex/synctex_resolution.ts";
import { collectCachedSyncTeXForwardLeafBoxes } from "./synctex/latex_workshop/worker.ts";
import { sourceSpansForPdfAnnotation, type ViewerHostPdfAnnotationMessage, type ViewerHostSourceSpan, type ViewerHostSynctexForwardMessage, type ViewerHostSynctexForwardRange } from "./viewer_host_protocol.ts";

export const MAX_PDF_MARK_SOURCE_LINES = 50;
export const MAX_PDF_MARK_TOTAL_SOURCE_LINES = 500;
const MAX_PDF_MARK_REBASE_FORWARD_RANGES = 5_000;
const MAX_PDF_MARK_SOURCE_BYTES = 1_000_000;

export interface PdfMarkSourceRange {
	sourceFile: string;
	startLine: number;
	endLine: number;
}

export interface PdfMarkSourceAnchor extends PdfMarkSourceRange {
	lines: string[];
}

export interface RebasedPdfMark {
	mark: ViewerHostPdfAnnotationMessage;
	forward: Omit<ViewerHostSynctexForwardMessage, "type" | "pdf_id">;
	anchors: PdfMarkSourceAnchor[];
}

/** @deprecated Use pdfMarkSourceRanges for multi-range annotations. */
export function pdfMarkSourceRange(mark: ViewerHostPdfAnnotationMessage, cwd?: string): PdfMarkSourceRange {
	return pdfMarkSourceRanges(mark, cwd)[0] as PdfMarkSourceRange;
}

export function pdfMarkSourceRanges(mark: ViewerHostPdfAnnotationMessage, cwd?: string): PdfMarkSourceRange[] {
	return sourceSpansForPdfAnnotation(mark).map((span) => ({
		sourceFile: resolveSourceFile(span.source_file, cwd),
		startLine: span.start_line,
		endLine: span.end_line,
	}));
}

/** @deprecated Use capturePdfMarkSourceAnchors for multi-range annotations. */
export function capturePdfMarkSourceAnchor(mark: ViewerHostPdfAnnotationMessage, cwd?: string): PdfMarkSourceAnchor | undefined {
	return capturePdfMarkSourceAnchors(mark, cwd)?.[0];
}

export function capturePdfMarkSourceAnchors(mark: ViewerHostPdfAnnotationMessage, cwd?: string): PdfMarkSourceAnchor[] | undefined {
	const ranges = pdfMarkSourceRanges(mark, cwd);
	let totalLines = 0;
	const sourceLinesByFile = new Map<string, string[] | undefined>();
	const anchors: PdfMarkSourceAnchor[] = [];
	for (const range of ranges) {
		const lineCount = range.endLine - range.startLine + 1;
		if (lineCount > MAX_PDF_MARK_SOURCE_LINES || (totalLines += lineCount) > MAX_PDF_MARK_TOTAL_SOURCE_LINES) return undefined;
		let lines = sourceLinesByFile.get(range.sourceFile);
		if (lines === undefined && !sourceLinesByFile.has(range.sourceFile)) {
			lines = readSourceLines(range.sourceFile);
			sourceLinesByFile.set(range.sourceFile, lines);
		}
		if (lines === undefined || range.startLine > lines.length || range.endLine > lines.length) return undefined;
		const anchorLines = lines.slice(range.startLine - 1, range.endLine);
		if (anchorLines.length === 0) return undefined;
		anchors.push({ ...range, lines: anchorLines });
	}
	return anchors.length > 0 ? anchors : undefined;
}

export function sourceChangedSincePdf(mark: ViewerHostPdfAnnotationMessage, pdfMtimeMs: number, cwd?: string): boolean {
	return pdfMarkSourceRanges(mark, cwd).some((range) => {
		try {
			return statSync(range.sourceFile).mtimeMs > pdfMtimeMs;
		} catch {
			return false;
		}
	});
}

export function rebasePdfMark(input: {
	mark: ViewerHostPdfAnnotationMessage;
	anchors?: readonly PdfMarkSourceAnchor[];
	/** @deprecated Use anchors. */
	anchor?: PdfMarkSourceAnchor;
	pdfPath: string;
	cwd?: string;
	resolveForward?: typeof resolveForwardSynctexJump;
}): RebasedPdfMark | undefined {
	const { mark, pdfPath, cwd } = input;
	const resolveForward = input.resolveForward ?? resolveForwardSynctexJump;
	const anchors = input.anchors ?? (input.anchor === undefined ? undefined : [input.anchor]);
	if (anchors === undefined || anchors.length === 0) return undefined;
	const sourceLinesByFile = new Map<string, string[] | undefined>();
	const sourceSpans: ViewerHostSourceSpan[] = [];
	const rebasedAnchors: PdfMarkSourceAnchor[] = [];
	const jumps: Array<ReturnType<typeof resolveForwardSynctexJump>> = [];
	const forwardRanges: ViewerHostSynctexForwardRange[] = [];

	try {
		for (const anchor of anchors) {
			let currentLines = sourceLinesByFile.get(anchor.sourceFile);
			if (currentLines === undefined && !sourceLinesByFile.has(anchor.sourceFile)) {
				currentLines = readSourceLines(anchor.sourceFile);
				sourceLinesByFile.set(anchor.sourceFile, currentLines);
			}
			if (currentLines === undefined) return undefined;
			const starts = findExactLineSequence(currentLines, anchor.lines);
			if (starts.length !== 1) return undefined;
			const startLine = starts[0] as number;
			const endLine = startLine + anchor.lines.length - 1;
			const jump = resolveForward({ pdfPath, sourceFile: anchor.sourceFile, line: startLine, cwd: cwd ?? resolve(anchor.sourceFile, "..") });
			const sourceSpan: ViewerHostSourceSpan = { source_file: anchor.sourceFile, start_line: startLine, end_line: endLine };
			const rebasedAnchor = captureSourceAnchor(sourceSpan, currentLines);
			if (rebasedAnchor === undefined) return undefined;
			sourceSpans.push(sourceSpan);
			rebasedAnchors.push(rebasedAnchor);
			jumps.push(jump);
			const leafGeometry = collectCachedSyncTeXForwardLeafBoxes({
				pdfPath,
				sourceFile: anchor.sourceFile,
				line: startLine,
				page: jump.page,
				maxBoxes: MAX_PDF_MARK_REBASE_FORWARD_RANGES - forwardRanges.length,
			});
			if (leafGeometry.exceeded) return undefined;
			const leafRanges = leafGeometry.boxes.map(({ page, h, v, W, H }) => ({ page, h, v, W, H }));
			const jumpRanges = jump.ranges?.filter((range) => range.page === jump.page) ?? [];
			if (jumpRanges.length > MAX_PDF_MARK_REBASE_FORWARD_RANGES - forwardRanges.length) return undefined;
			const freshRanges = leafRanges.length > 0
				? leafRanges
				: jumpRanges.length > 0
					? jumpRanges
					: jump.width !== undefined && jump.height !== undefined
						? [{ page: jump.page, h: jump.x, v: jump.y, W: jump.width, H: jump.height }]
						: [];
			if (freshRanges.length === 0 || forwardRanges.length + freshRanges.length > MAX_PDF_MARK_REBASE_FORWARD_RANGES) return undefined;
			forwardRanges.push(...freshRanges);
		}
	} catch {
		return undefined;
	}

	const primaryJump = jumps[0];
	const primarySpan = sourceSpans[0];
	if (primaryJump === undefined || primarySpan === undefined || jumps.some((jump) => jump.page !== primaryJump.page)) return undefined;
	const primaryLines = sourceLinesByFile.get(primarySpan.source_file);
	const pageForwardRanges = dedupeForwardRanges(forwardRanges.filter((range) => range.page === primaryJump.page));
	const { source_span: _legacySourceSpan, source_spans: _oldSourceSpans, ...markWithoutSpans } = mark;
	const rebased: ViewerHostPdfAnnotationMessage = {
		...markWithoutSpans,
		page: primaryJump.page,
		source_file: primarySpan.source_file,
		line: primarySpan.start_line,
		source_line: primaryLines?.[primarySpan.start_line - 1] ?? primaryJump.sourceLine,
		source_spans: sourceSpans,
	};
	return {
		mark: rebased,
		forward: {
			page: primaryJump.page,
			x: primaryJump.x,
			y: primaryJump.y,
			...(primaryJump.width === undefined ? {} : { width: primaryJump.width }),
			...(primaryJump.height === undefined ? {} : { height: primaryJump.height }),
			...(pageForwardRanges.length === 0 ? {} : { ranges: pageForwardRanges }),
			...(primaryJump.indicator === undefined ? {} : { indicator: primaryJump.indicator }),
			source_file: rebased.source_file,
			line: rebased.line,
			source_line: rebased.source_line,
		},
		anchors: rebasedAnchors,
	};
}

function captureSourceAnchor(span: ViewerHostSourceSpan, lines: string[]): PdfMarkSourceAnchor | undefined {
	const lineCount = span.end_line - span.start_line + 1;
	if (lineCount > MAX_PDF_MARK_SOURCE_LINES || span.start_line > lines.length || span.end_line > lines.length) return undefined;
	const anchorLines = lines.slice(span.start_line - 1, span.end_line);
	return anchorLines.length === 0 ? undefined : {
		sourceFile: span.source_file,
		startLine: span.start_line,
		endLine: span.end_line,
		lines: anchorLines,
	};
}

function dedupeForwardRanges(ranges: readonly ViewerHostSynctexForwardRange[]): ViewerHostSynctexForwardRange[] {
	const seen = new Set<string>();
	return ranges.filter((range) => {
		const key = `${range.page}:${range.h}:${range.v}:${range.W}:${range.H}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function resolveSourceFile(sourceFile: string, cwd?: string): string {
	return isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(cwd ?? process.cwd(), sourceFile);
}

function readSourceLines(sourceFile: string): string[] | undefined {
	try {
		const status = statSync(sourceFile);
		if (!status.isFile() || status.size > MAX_PDF_MARK_SOURCE_BYTES) return undefined;
		return readFileSync(sourceFile, "utf8").replace(/\r\n/g, "\n").split("\n");
	} catch {
		return undefined;
	}
}

function findExactLineSequence(lines: readonly string[], needle: readonly string[]): number[] {
	const starts: number[] = [];
	for (let start = 0; start + needle.length <= lines.length; start += 1) {
		if (needle.every((line, index) => lines[start + index] === line)) starts.push(start + 1);
	}
	return starts;
}

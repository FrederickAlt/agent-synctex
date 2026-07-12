import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { collectCachedSyncTeXPageLeafBoxes, convInputFilePath, getCachedSyncTeXPageLeafBoxes, MAX_CACHED_SYNC_TEX_PAGE_LEAF_BOXES, parseSyncTexForPdf } from "./latex_workshop/worker.ts";
import type { ReverseSynctexPdfEventInput, ReverseSynctexSourceLocationEvent } from "../pdf_events.ts";
import type {
	ViewerHostReverseSynctexBoxMessage,
	ViewerHostReverseSynctexBoxResultMessage,
	ViewerHostReverseSynctexForwardProbeMessage,
	ViewerHostDebugForwardGroup,
	ViewerHostReverseSynctexForwardProbeResultMessage,
	ViewerHostReverseSynctexHoverMessage,
	ViewerHostReverseSynctexHoverResultMessage,
	ViewerHostReverseSynctexMessage,
	ViewerHostPdfTextSpan,
	ViewerHostSourceSpan,
	ViewerHostSynctexForwardRange,
} from "../viewer_host_protocol.ts";
import {
	findUniqueSelectedTextSourceRange,
	inspectReverseSynctexHover,
	mapForwardSynctex,
	mapReverseForwardSynctexProbe,
	mapReverseSynctex,
	normalizedSourceSpansForLines,
	normalizedVisibleText,
	simpleVisibleSourceText,
	type ForwardSynctexJump,
	type MapForwardSynctexInput,
	type ReverseSynctexSourceSpan,
} from "./forward_synctex.ts";

export type ReverseSynctexMapper = typeof mapReverseSynctex;

const MAX_REVERSE_SYNCTEX_BOX_LEAF_BOXES = MAX_CACHED_SYNC_TEX_PAGE_LEAF_BOXES;
const MAX_REVERSE_SYNCTEX_BOX_SOURCE_LOCATIONS = 2_000;
const MIN_BOX_COVERAGE = 0.5;
const SCORE_EPSILON = 1e-9;
const MIN_TEXT_MATCH_LENGTH = 8;

export interface RegisteredSynctexPdf {
	pdfId: number;
	pdfPath: string;
	workspaceCwd?: string;
}

function sourceSpanPayload(span: ReverseSynctexSourceSpan | undefined): { source_file: string; start_line: number; end_line: number } | undefined {
	return span === undefined ? undefined : { source_file: span.sourceFile, start_line: span.startLine, end_line: span.endLine };
}

export function prewarmSynctexForPdf(pdfPath: string): void {
	try {
		parseSyncTexForPdf(pdfPath);
	} catch {
		// Prewarming is a latency optimization only; real SyncTeX calls report errors.
	}
}

export function resolveForwardSynctexJump(input: MapForwardSynctexInput): ForwardSynctexJump {
	return mapForwardSynctex(input);
}

/**
 * Seeds from the best half-covered SyncTeX record, grows through source lines
 * with half-covered geometry while skipping lines without geometry, then
 * normalizes accepted lines and merges their spans across gaps of at most two lines.
 */
export function resolveReverseSynctexBox(input: {
	message: ViewerHostReverseSynctexBoxMessage;
	pdf: RegisteredSynctexPdf;
}): ViewerHostReverseSynctexBoxResultMessage {
	const { message, pdf } = input;
	const workspaceCwd = pdf.workspaceCwd ?? dirname(pdf.pdfPath);
	const seedQuery = collectCachedSyncTeXPageLeafBoxes({
		pdfPath: pdf.pdfPath,
		page: message.page,
		maxBoxes: MAX_REVERSE_SYNCTEX_BOX_LEAF_BOXES,
		matches: (box) => usableBox(box) && meetsMinimumCoverage(box, message),
	});
	if (seedQuery.exceeded) {
		throw new Error(`Selection is too dense to resolve exhaustively (more than ${MAX_REVERSE_SYNCTEX_BOX_LEAF_BOXES} SyncTeX boxes). Select a smaller PDF area.`);
	}
	const seedBoxes = seedQuery.boxes;
	const pageBoxesBySource = indexPageBoxesBySource(getCachedSyncTeXPageLeafBoxes(pdf.pdfPath, message.page));
	const seedLocations = dedupeSourceLocations(seedBoxes.map((box) => ({ sourceFile: box.sourceFile, line: box.line })));
	if (seedLocations.length > MAX_REVERSE_SYNCTEX_BOX_SOURCE_LOCATIONS) {
		throw new Error(`Selection resolves to more than ${MAX_REVERSE_SYNCTEX_BOX_SOURCE_LOCATIONS} source locations. Select a smaller PDF area.`);
	}

	const sources = new Map<string, ResolvedSource | undefined>();
	const sourceFor = (sourceFile: string): ResolvedSource | undefined => {
		if (sources.has(sourceFile)) return sources.get(sourceFile);
		const source = resolveBoxSourceFile(sourceFile, workspaceCwd);
		sources.set(sourceFile, source);
		return source;
	};
	const scoredSeeds = seedBoxes.flatMap((box) => {
		const source = sourceFor(box.sourceFile);
		return source === undefined ? [] : [scoreBoxCandidate(box, source, message)];
	}).sort(compareScoredBoxCandidates);
	const seed = scoredSeeds[0];
	if (seed === undefined) {
		throw new Error("No SyncTeX source boxes in this drag area met the 50% forward-coverage requirement");
	}

	const boxesByLine = pageBoxesBySource.get(seed.rawSourceFile) ?? new Map();
	const accepted = [seed];
	growBoxSelection({ direction: -1, seedLine: seed.line, source: seed.source, rawSourceFile: seed.rawSourceFile, boxesByLine, message, accepted });
	growBoxSelection({ direction: 1, seedLine: seed.line, source: seed.source, rawSourceFile: seed.rawSourceFile, boxesByLine, message, accepted });
	const sourceSpans = mergeAcceptedSourceSpans(normalizedSourceSpansForLines(seed.source.sourceFile, accepted.map((candidate) => candidate.line)));
	const firstSpan = sourceSpans[0]!;
	return {
		type: "reverse_synctex_box_result",
		pdf_id: message.pdf_id,
		request_id: message.request_id,
		page: message.page,
		h: message.h,
		v: message.v,
		W: message.W,
		H: message.H,
		source_spans: sourceSpans,
		ranges: [{ page: message.page, h: message.h, v: message.v, W: message.W, H: message.H }],
		source_file: firstSpan.source_file,
		line: firstSpan.start_line,
	};
}

interface ResolvedSource {
	sourceFile: string;
	lines: string[];
}

interface ScoredBoxCandidate {
	rawSourceFile: string;
	line: number;
	box: ViewerHostSynctexForwardRange;
	coverage: number;
	source: ResolvedSource;
	score: number;
}

function resolveBoxSourceFile(sourceFile: string, workspaceCwd: string): ResolvedSource | undefined {
	const inputFile = isAbsolute(sourceFile) ? sourceFile : resolve(workspaceCwd, sourceFile);
	const resolved = convInputFilePath(inputFile) ?? inputFile;
	if (!sourceFileInsideWorkspace(resolved, workspaceCwd)) return undefined;
	try {
		return { sourceFile: resolved, lines: readFileSync(resolved, "utf8").split(/\r?\n/) };
	} catch {
		return undefined;
	}
}

function growBoxSelection(input: {
	direction: -1 | 1;
	seedLine: number;
	source: ResolvedSource;
	rawSourceFile: string;
	boxesByLine: ReadonlyMap<number, ReadonlyArray<{ page: number; h: number; v: number; W: number; H: number }>>;
	message: ViewerHostReverseSynctexBoxMessage;
	accepted: ScoredBoxCandidate[];
}): void {
	const pendingOpeningEnvironmentMarkers: ScoredBoxCandidate[] = [];
	let line = input.seedLine + input.direction;
	while (line >= 1 && line <= input.source.lines.length) {
		const boxes = input.boxesByLine.get(line)?.filter(usableBox) ?? [];
		if (boxes.length === 0) {
			line += input.direction;
			continue;
		}
		const best = boxes
			.filter((box) => meetsMinimumCoverage(box, input.message))
			.map((box) => scoreBoxCandidate({ ...box, sourceFile: input.rawSourceFile, line }, input.source, input.message))
			.sort(compareScoredBoxCandidates)[0];
		if (best === undefined) break;
		if (isOpeningEnvironmentMarker(input.source.lines[line - 1])) {
			pendingOpeningEnvironmentMarkers.push(best);
		} else {
			input.accepted.push(...pendingOpeningEnvironmentMarkers, best);
			pendingOpeningEnvironmentMarkers.length = 0;
		}
		line += input.direction;
	}
}

function isOpeningEnvironmentMarker(sourceLine: string | undefined): boolean {
	return sourceLine?.trim().startsWith("\\begin{") ?? false;
}

const MAX_SOURCE_SPAN_MERGE_GAP_LINES = 2;

function mergeAcceptedSourceSpans(spans: readonly ReverseSynctexSourceSpan[]): ViewerHostSourceSpan[] {
	const sorted = [...new Map(spans.map((span) => [`${span.sourceFile}\0${span.startLine}\0${span.endLine}`, span])).values()]
		.sort((left, right) => left.sourceFile.localeCompare(right.sourceFile) || left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: ViewerHostSourceSpan[] = [];
	for (const span of sorted) {
		const previous = merged.at(-1);
		if (previous !== undefined && previous.source_file === span.sourceFile && span.startLine - previous.end_line - 1 <= MAX_SOURCE_SPAN_MERGE_GAP_LINES) {
			previous.end_line = Math.max(previous.end_line, span.endLine);
		} else {
			merged.push({ source_file: span.sourceFile, start_line: span.startLine, end_line: span.endLine });
		}
	}
	return merged;
}

function indexPageBoxesBySource(boxes: ReadonlyArray<{ sourceFile: string; line: number; page: number; h: number; v: number; W: number; H: number }>): Map<string, Map<number, Array<{ page: number; h: number; v: number; W: number; H: number }>>> {
	const indexed = new Map<string, Map<number, Array<{ page: number; h: number; v: number; W: number; H: number }>>>();
	for (const box of boxes) {
		const boxesByLine = indexed.get(box.sourceFile) ?? new Map();
		const lineBoxes = boxesByLine.get(box.line) ?? [];
		lineBoxes.push({ page: box.page, h: box.h, v: box.v, W: box.W, H: box.H });
		boxesByLine.set(box.line, lineBoxes);
		indexed.set(box.sourceFile, boxesByLine);
	}
	return indexed;
}

function scoreBoxCandidate(box: { sourceFile: string; line: number; page: number; h: number; v: number; W: number; H: number }, source: ResolvedSource, message: ViewerHostReverseSynctexBoxMessage): ScoredBoxCandidate {
	const coverage = boxCoverage(box, message);
	const sourceLine = { source_file: source.sourceFile, start_line: box.line, end_line: box.line };
	return {
		rawSourceFile: box.sourceFile,
		line: box.line,
		box: { page: box.page, h: box.h, v: box.v, W: box.W, H: box.H },
		coverage,
		source,
		score: (1 / (coverage + SCORE_EPSILON)) + 1 + textMatchBonus(source, sourceLine, box, message.pdf_text_spans),
	};
}

function compareScoredBoxCandidates(left: ScoredBoxCandidate, right: ScoredBoxCandidate): number {
	return left.score - right.score
		|| right.coverage - left.coverage
		|| left.line - right.line
		|| left.box.h - right.box.h
		|| left.box.v - right.box.v;
}

function textMatchBonus(source: ResolvedSource, span: ViewerHostSourceSpan, box: ViewerHostSynctexForwardRange, pdfTextSpans: ViewerHostPdfTextSpan[] | undefined): number {
	const selectedText = normalizedVisibleText((pdfTextSpans ?? [])
		.filter((textSpan) => textSpan.page === box.page && boxesOverlap(textSpan, box))
		.map((textSpan) => textSpan.text)
		.join(" "));
	if (selectedText.length < MIN_TEXT_MATCH_LENGTH) return 0;
	const sourceText = normalizedVisibleText(source.lines
		.slice(span.start_line - 1, span.end_line)
		.map(simpleVisibleSourceText)
		.filter((line): line is string => line !== undefined)
		.join(" "));
	if (sourceText.length < MIN_TEXT_MATCH_LENGTH) return 0;
	if (sourceText.includes(selectedText)) return -1;
	return hasContiguousTextMatch(sourceText, selectedText) ? -0.5 : 0;
}

function hasContiguousTextMatch(sourceText: string, selectedText: string): boolean {
	for (let length = Math.min(selectedText.length, 200); length >= MIN_TEXT_MATCH_LENGTH; length -= 1) {
		for (let start = 0; start + length <= selectedText.length; start += 1) {
			if (sourceText.includes(selectedText.slice(start, start + length))) return true;
		}
	}
	return false;
}

function usableBox(box: { W: number; H: number }): boolean {
	return box.W > 0 || box.H > 0;
}

function boxCoverage(box: { h: number; v: number; W: number; H: number }, target: { h: number; v: number; W: number; H: number }): number {
	const overlapWidth = Math.max(0, Math.min(box.h + box.W, target.h + target.W) - Math.max(box.h, target.h));
	const overlapHeight = Math.max(0, Math.min(box.v, target.v) - Math.max(box.v - box.H, target.v - target.H));
	if (box.W > 0 && box.H > 0) return (overlapWidth * overlapHeight) / (box.W * box.H);
	if (box.W === 0 && box.H > 0) return box.h >= target.h && box.h <= target.h + target.W ? overlapHeight / box.H : 0;
	if (box.W > 0 && box.H === 0) return box.v >= target.v - target.H && box.v <= target.v ? overlapWidth / box.W : 0;
	return 0;
}

function meetsMinimumCoverage(box: { h: number; v: number; W: number; H: number }, target: { h: number; v: number; W: number; H: number }): boolean {
	return boxCoverage(box, target) + SCORE_EPSILON >= MIN_BOX_COVERAGE;
}

function boxesOverlap(left: { h: number; v: number; W: number; H: number }, right: { h: number; v: number; W: number; H: number }): boolean {
	return Math.min(left.h + left.W, right.h + right.W) > Math.max(left.h, right.h)
		&& Math.min(left.v, right.v) > Math.max(left.v - left.H, right.v - right.H);
}

function sourceLocationKey(sourceFile: string, line: number): string {
	return `${sourceFile}\0${line}`;
}

function dedupeSourceLocations(locations: Array<{ sourceFile: string; line: number }>): Array<{ sourceFile: string; line: number }> {
	const seen = new Set<string>();
	return locations.filter((location) => {
		const key = sourceLocationKey(location.sourceFile, location.line);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function sourceFileInsideWorkspace(sourceFile: string, workspaceCwd: string): boolean {
	try {
		const workspace = realpathSync(resolve(workspaceCwd));
		const source = realpathSync(isAbsolute(sourceFile) ? resolve(sourceFile) : resolve(workspace, sourceFile));
		const pathFromWorkspace = relative(workspace, source);
		return pathFromWorkspace === "" || (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace));
	} catch {
		return false;
	}
}

function sourceLocationEventFromReverse(location: ReturnType<ReverseSynctexMapper>, page: number, x: number, y: number): ReverseSynctexSourceLocationEvent {
	return {
		source_file: location.sourceFile,
		line: location.line,
		column: location.column,
		...(location.sourceLine === undefined ? {} : { source_line: location.sourceLine }),
		page,
		x,
		y,
		precision: location.precision,
		...(location.diagnostics.textRepair?.used === true ? { repair: "text_context" } : {}),
		...(location.rawMappedLine === undefined ? {} : {
			raw_mapped_source_file: location.rawMappedSourceFile,
			raw_mapped_line: location.rawMappedLine,
			raw_mapped_column: location.rawMappedColumn,
			...(location.rawMappedSourceLine === undefined ? {} : { raw_mapped_source_line: location.rawMappedSourceLine }),
		}),
		synctex_diagnostics: location.diagnostics,
	};
}

function withEndpointDiagnostics(repaired: ReverseSynctexSourceLocationEvent, mapped: ReturnType<ReverseSynctexMapper> | undefined): ReverseSynctexSourceLocationEvent {
	if (mapped === undefined) return repaired;
	return {
		...repaired,
		...(mapped.rawMappedLine === undefined ? {} : {
			raw_mapped_source_file: mapped.rawMappedSourceFile,
			raw_mapped_line: mapped.rawMappedLine,
			raw_mapped_column: mapped.rawMappedColumn,
			...(mapped.rawMappedSourceLine === undefined ? {} : { raw_mapped_source_line: mapped.rawMappedSourceLine }),
		}),
		synctex_diagnostics: mapped.diagnostics,
	};
}

function repairedSelectionEndpoints(location: ReturnType<ReverseSynctexMapper>, selectedText: string | undefined, message: ViewerHostReverseSynctexMessage): { selectionStart?: ReverseSynctexSourceLocationEvent; selectionEnd?: ReverseSynctexSourceLocationEvent } {
	if (selectedText === undefined) return {};
	const range = findUniqueSelectedTextSourceRange(location.sourceFile, selectedText);
	if (range === undefined) return {};
	return {
		selectionStart: { source_file: range.sourceFile, line: range.startLine, column: range.startColumn, ...(range.startSourceLine === undefined ? {} : { source_line: range.startSourceLine }), page: message.page, x: message.selectionStartX as number, y: message.selectionStartY as number, precision: "text", repair: "selected_text" },
		selectionEnd: { source_file: range.sourceFile, line: range.endLine, column: range.endColumn, ...(range.endSourceLine === undefined ? {} : { source_line: range.endSourceLine }), page: message.page, x: message.selectionEndX as number, y: message.selectionEndY as number, precision: "text", repair: "selected_text" },
	};
}

export function reverseSynctexPdfEventFromViewerMessage(input: {
	message: ViewerHostReverseSynctexMessage;
	pdf: RegisteredSynctexPdf;
	timestamp?: string;
	reverseSynctexMapper?: ReverseSynctexMapper;
}): ReverseSynctexPdfEventInput {
	const { message, pdf } = input;
	const reverseSynctexMapper = input.reverseSynctexMapper ?? mapReverseSynctex;
	const cwd = pdf.workspaceCwd ?? dirname(pdf.pdfPath);
	const location = reverseSynctexMapper({
		pdfPath: pdf.pdfPath,
		page: message.page,
		x: message.x,
		y: message.y,
		cwd,
		...(message.page_height === undefined ? {} : { pageHeight: message.page_height }),
		...(message.textBeforeSelection === undefined ? {} : { textBeforeSelection: message.textBeforeSelection }),
		...(message.textAfterSelection === undefined ? {} : { textAfterSelection: message.textAfterSelection }),
	});
	const repairedSelection = message.selectedText !== undefined && message.selectionStartX !== undefined && message.selectionStartY !== undefined && message.selectionEndX !== undefined && message.selectionEndY !== undefined
		? repairedSelectionEndpoints(location, message.selectedText, message)
		: {};
	let selectionStart: ReturnType<ReverseSynctexMapper> | undefined;
	let selectionStartError: string | undefined;
	if (message.selectedText !== undefined && message.selectionStartX !== undefined && message.selectionStartY !== undefined) {
		try {
			selectionStart = reverseSynctexMapper({
				pdfPath: pdf.pdfPath,
				page: message.page,
				x: message.selectionStartX,
				y: message.selectionStartY,
				cwd,
				...(message.page_height === undefined ? {} : { pageHeight: message.page_height }),
				...(message.textBeforeSelection === undefined ? {} : { textBeforeSelection: message.textBeforeSelection }),
				textAfterSelection: message.selectedText,
			});
		} catch (error) {
			selectionStartError = error instanceof Error ? error.message : String(error);
		}
		if (repairedSelection.selectionStart !== undefined) {
			selectionStartError = undefined;
		}
	}
	let selectionEnd: ReturnType<ReverseSynctexMapper> | undefined;
	let selectionEndError: string | undefined;
	if (message.selectedText !== undefined && message.selectionEndX !== undefined && message.selectionEndY !== undefined) {
		try {
			selectionEnd = reverseSynctexMapper({
				pdfPath: pdf.pdfPath,
				page: message.page,
				x: message.selectionEndX,
				y: message.selectionEndY,
				cwd,
				...(message.page_height === undefined ? {} : { pageHeight: message.page_height }),
				textBeforeSelection: message.selectedText,
				...(message.textAfterSelection === undefined ? {} : { textAfterSelection: message.textAfterSelection }),
			});
		} catch (error) {
			selectionEndError = error instanceof Error ? error.message : String(error);
		}
		if (repairedSelection.selectionEnd !== undefined) {
			selectionEndError = undefined;
		}
	}
	return {
		type: "reverse_synctex",
		pdf_id: message.pdf_id,
		source_file: location.sourceFile,
		line: location.line,
		column: location.column,
		...(location.sourceLine === undefined ? {} : { source_line: location.sourceLine }),
		synctex_diagnostics: location.diagnostics,
		timestamp: input.timestamp ?? new Date().toISOString(),
		precision: location.precision,
		...(location.diagnostics.textRepair?.used === true ? { repair: "text_context" } : {}),
		page: message.page,
		x: message.x,
		y: message.y,
		...(message.selectedText === undefined ? {} : { selected_text: message.selectedText }),
		...(repairedSelection.selectionStart !== undefined ? { selection_start: withEndpointDiagnostics(repairedSelection.selectionStart, selectionStart) } : selectionStart === undefined ? {} : { selection_start: sourceLocationEventFromReverse(selectionStart, message.page, message.selectionStartX as number, message.selectionStartY as number) }),
		...(repairedSelection.selectionEnd !== undefined ? { selection_end: withEndpointDiagnostics(repairedSelection.selectionEnd, selectionEnd) } : selectionEnd === undefined ? {} : { selection_end: sourceLocationEventFromReverse(selectionEnd, message.page, message.selectionEndX as number, message.selectionEndY as number) }),
		...(selectionStartError === undefined ? {} : { selection_start_error: selectionStartError }),
		...(selectionEndError === undefined ? {} : { selection_end_error: selectionEndError }),
		...(location.rawMappedLine === undefined ? {} : {
			raw_mapped_source_file: location.rawMappedSourceFile,
			raw_mapped_line: location.rawMappedLine,
			raw_mapped_column: location.rawMappedColumn,
			...(location.rawMappedSourceLine === undefined ? {} : { raw_mapped_source_line: location.rawMappedSourceLine }),
		}),
		...(sourceSpanPayload(location.normalizedSourceSpan) === undefined ? {} : {
			normalized_source_span: sourceSpanPayload(location.normalizedSourceSpan)!,
			normalized_source_excerpt: location.normalizedSourceExcerpt,
		}),
	};
}

function hoverCandidateSummary(candidate: unknown): { source_file?: string; line: number; column?: number; source_line?: string; rect?: { left: number; top: number; right: number; bottom: number }; score?: number; structural?: boolean; distance?: number; distance_x?: number; distance_y?: number } | undefined {
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const record = candidate as Record<string, unknown>;
	if (typeof record.line !== "number") return undefined;
	return {
		...(typeof record.sourceFile === "string" ? { source_file: record.sourceFile } : typeof record.input === "string" ? { source_file: record.input } : {}),
		line: record.line,
		...(typeof record.column === "number" ? { column: record.column } : {}),
		...(typeof record.sourceLine === "string" ? { source_line: record.sourceLine } : {}),
		...(typeof record.rect === "object" && record.rect !== null ? { rect: record.rect as { left: number; top: number; right: number; bottom: number } } : {}),
		...(typeof record.score === "number" ? { score: record.score } : {}),
		...(typeof record.structural === "boolean" ? { structural: record.structural } : {}),
		...(typeof record.distance === "number" ? { distance: record.distance } : {}),
		...(typeof record.distanceX === "number" ? { distance_x: record.distanceX } : {}),
		...(typeof record.distanceY === "number" ? { distance_y: record.distanceY } : {}),
	};
}

function debugCandidateDiagnostics(reverse: ReturnType<typeof inspectReverseSynctexHover>): { debug_candidates?: NonNullable<ViewerHostReverseSynctexHoverResultMessage["candidates"]>; debug_selected_score?: number } {
	const candidates = (reverse.proposalScores ?? reverse.topCandidates)?.map((candidate) => hoverCandidateSummary(candidate)).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined).slice(0, 3);
	return {
		...(candidates === undefined || candidates.length === 0 ? {} : { debug_candidates: candidates }),
		...(reverse.repairedWinner?.score === undefined ? {} : { debug_selected_score: reverse.repairedWinner.score }),
	};
}

function debugForwardGroupDiagnostics(reverse: Pick<ReturnType<typeof inspectReverseSynctexHover>, "debugProposalScores">): { debug_forward_groups?: ViewerHostDebugForwardGroup[] } {
	const proposals = reverse.debugProposalScores;
	if (proposals === undefined || proposals.length === 0) return {};
	const groups = proposals.flatMap((proposal, proposalIndex) => proposal.forwardGroupScores.map((group, groupIndex): ViewerHostDebugForwardGroup => ({
		proposal: {
			kind: proposal.kind,
			provenance: proposal.provenance,
			source_file: proposal.sourceFile,
			line: proposal.line,
			column: proposal.column,
			rank: proposal.rank,
			structural: proposal.structural,
			...(proposal.textStatus === undefined ? {} : { text_status: proposal.textStatus }),
		},
		proposal_selected: proposalIndex === 0,
		proposal_order: {
			index: proposalIndex,
			geometry_tier: proposal.geometryTier,
			total: proposal.score,
			exact_lookup_preferred: proposal.forwardLookupMode === "exact",
			same_page_box_count: proposal.samePageBoxCount,
			rank: proposal.rank,
			line: proposal.line,
			source_file: proposal.sourceFile,
		},
		origin: group.origin,
		lookup_line: group.lookupLine,
		semantic_penalty: group.semanticPenalty,
		pdf_text_span_semantic_penalty: group.pdfTextSpanSemanticPenalty,
		selection_text_context_semantic_penalty: group.selectionTextContextSemanticPenalty,
		blank_source_line_penalty: group.blankSourceLinePenalty,
		original_box_count: group.originalBoxCount,
		filtered_box_count: group.filteredBoxCount,
		same_page_box_count: group.samePageBoxCount,
		rejected_invalid: group.rejectedInvalid,
		rejected_absurd: group.rejectedAbsurd,
		contains_click: group.containsClick,
		geometry_tier: group.geometryTier,
		...(group.distance === undefined ? {} : { distance: group.distance }),
		...(group.distanceSquared === undefined ? {} : { distance_squared: group.distanceSquared }),
		...(group.distanceMultiplier === undefined ? {} : { distance_multiplier: group.distanceMultiplier }),
		...(group.distanceTerm === undefined ? {} : { distance_term: group.distanceTerm }),
		...(group.area === undefined ? {} : { area: group.area }),
		...(group.areaTerm === undefined ? {} : { area_term: group.areaTerm }),
		...(group.tinyPenalty === undefined ? {} : { tiny_penalty: group.tinyPenalty }),
		click_containment_bonus: group.clickContainmentBonus,
		text_containment_bonus: group.textContainmentBonus,
		...(group.textContainment === undefined ? {} : { text_containment: group.textContainment }),
		...(group.endDocumentPenalty === undefined ? {} : { end_document_penalty: group.endDocumentPenalty }),
		score: group.score,
		group_order: {
			index: groupIndex,
			geometry_tier: group.geometryTier,
			total: group.score,
			exact_lookup_preferred: group.origin === "synctex_exact",
		},
		selected: proposalIndex === 0 && groupIndex === 0,
		...(group.chosenBox === undefined ? {} : { chosen_box: group.chosenBox }),
		box_score_count: group.boxScoreCount,
		box_scores_truncated: group.boxScoresTruncated,
		box_scores: group.boxScores.map((box, boxIndex) => ({
			box: box.box,
			contains_click: box.containsClick,
			geometry_tier: box.geometryTier,
			distance: box.distance,
			distance_squared: box.distanceSquared,
			distance_multiplier: box.distanceMultiplier,
			distance_term: box.distanceTerm,
			area: box.area,
			area_term: box.areaTerm,
			tiny_penalty: box.tinyPenalty,
			semantic_penalty: box.semanticPenalty,
			pdf_text_span_semantic_penalty: box.pdfTextSpanSemanticPenalty,
			selection_text_context_semantic_penalty: box.selectionTextContextSemanticPenalty,
			blank_source_line_penalty: box.blankSourceLinePenalty,
			click_containment_bonus: box.clickContainmentBonus,
			text_containment_bonus: box.textContainmentBonus,
			...(box.textContainment === undefined ? {} : { text_containment: box.textContainment }),
			end_document_penalty: box.endDocumentPenalty,
			total: box.score,
			order: boxIndex,
			selected: boxIndex === 0,
		})),
	})));
	return groups.length === 0 ? {} : { debug_forward_groups: groups };
}

function hoverResultDiagnostics(hover: ReturnType<typeof inspectReverseSynctexHover>): Partial<ViewerHostReverseSynctexHoverResultMessage> {
	const nearestCandidate = hoverCandidateSummary(hover.rawWinner);
	const candidates = (hover.proposalScores ?? hover.topCandidates)?.map((candidate) => hoverCandidateSummary(candidate)).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined).slice(0, 3);
	return {
		...(hover.precision === undefined ? {} : { precision: hover.precision }),
		...(hover.repairedWinner?.score === undefined ? {} : { selected_score: hover.repairedWinner.score }),
		...(nearestCandidate === undefined ? {} : { nearest_candidate: nearestCandidate }),
		...(hover.repairedWinner === undefined ? {} : { repaired: { source_file: hover.repairedWinner.sourceFile, line: hover.repairedWinner.line, column: hover.repairedWinner.column, ...(hover.repairedWinner.sourceLine === undefined ? {} : { source_line: hover.repairedWinner.sourceLine }), precision: hover.repairedWinner.precision, ...(hover.repairedWinner.score === undefined ? {} : { score: hover.repairedWinner.score }) } }),
		...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
		...(hover.forwardVerification === undefined ? {} : { forward: { attempted: hover.forwardVerification.attempted, contains_click: hover.forwardVerification.containsClick, boxes_considered: hover.forwardVerification.boxesConsidered, boxes_filtered: hover.forwardVerification.boxesFiltered, ...(hover.forwardVerification.chosenBox === undefined ? {} : { chosen_box: hover.forwardVerification.chosenBox as ViewerHostSynctexForwardRange }) } }),
	};
}

export function reverseSynctexHoverResult(input: { message: ViewerHostReverseSynctexHoverMessage; pdf: RegisteredSynctexPdf }): ViewerHostReverseSynctexHoverResultMessage {
	const { message, pdf } = input;
	const cwd = pdf.workspaceCwd ?? dirname(pdf.pdfPath);
	const hoverInput = { pdfPath: pdf.pdfPath, page: message.page, x: message.x, y: message.y, ...(message.page_height === undefined ? {} : { pageHeight: message.page_height }), ...(message.pdf_text_spans === undefined ? {} : { pdfTextSpans: message.pdf_text_spans }), ...(message.textBeforeSelection === undefined ? {} : { textBeforeSelection: message.textBeforeSelection }), ...(message.textAfterSelection === undefined ? {} : { textAfterSelection: message.textAfterSelection }) };
	let hover;
	try {
		hover = inspectReverseSynctexHover({ ...hoverInput, cwd });
	} catch (error) {
		if (pdf.workspaceCwd === undefined || pdf.workspaceCwd === dirname(pdf.pdfPath)) throw error;
		hover = inspectReverseSynctexHover({ ...hoverInput, cwd: dirname(pdf.pdfPath) });
	}
	return {
		type: "reverse_synctex_hover_result",
		pdf_id: message.pdf_id,
		request_id: message.request_id,
		page: message.page,
		x: message.x,
		y: message.y,
		source_file: hover.sourceFile,
		line: hover.line,
		column: hover.column,
		...(hover.sourceLine === undefined ? {} : { source_line: hover.sourceLine }),
		rect: hover.rect,
		...hoverResultDiagnostics(hover),
	};
}

export function reverseSynctexForwardProbeResult(input: { message: ViewerHostReverseSynctexForwardProbeMessage; pdf: RegisteredSynctexPdf; debugSynctex?: boolean }): ViewerHostReverseSynctexForwardProbeResultMessage {
	const { message, pdf } = input;
	const pdfMark = message.pdf_text_spans?.[0]?.text.trim();
	const probeInput = { pdfPath: pdf.pdfPath, page: message.page, x: message.x, y: message.y, ...(message.page_height === undefined ? {} : { pageHeight: message.page_height }), ...(message.pdf_text_spans === undefined ? {} : { pdfTextSpans: message.pdf_text_spans }), ...(message.textBeforeSelection === undefined ? {} : { textBeforeSelection: message.textBeforeSelection }), ...(message.textAfterSelection === undefined ? {} : { textAfterSelection: message.textAfterSelection }) };
	let probe;
	try {
		probe = mapReverseForwardSynctexProbe({ ...probeInput, cwd: pdf.workspaceCwd ?? dirname(pdf.pdfPath), ...(input.debugSynctex === true ? { debugTrace: true } : {}) });
	} catch (error) {
		if (pdf.workspaceCwd === undefined || pdf.workspaceCwd === dirname(pdf.pdfPath)) throw error;
		probe = mapReverseForwardSynctexProbe({ ...probeInput, cwd: dirname(pdf.pdfPath), ...(input.debugSynctex === true ? { debugTrace: true } : {}) });
	}
	return {
		type: "reverse_synctex_forward_probe_result",
		pdf_id: message.pdf_id,
		request_id: message.request_id,
		click_page: message.page,
		click_x: message.x,
		click_y: message.y,
		reverse_source_file: probe.reverse.sourceFile,
		reverse_line: probe.reverse.line,
		reverse_column: probe.reverse.column,
		...(probe.reverse.sourceLine === undefined ? {} : { reverse_source_line: probe.reverse.sourceLine }),
		...(pdfMark ? { pdf_mark: pdfMark } : {}),
		...(sourceSpanPayload(probe.reverse.normalizedSourceSpan) === undefined ? {} : { source_span: sourceSpanPayload(probe.reverse.normalizedSourceSpan)! }),
		page: probe.forward.page,
		x: probe.forward.x,
		y: probe.forward.y,
		...(probe.forward.width === undefined ? {} : { width: probe.forward.width }),
		...(probe.forward.height === undefined ? {} : { height: probe.forward.height }),
		...(probe.forward.ranges === undefined ? {} : { ranges: probe.forward.ranges }),
		...(probe.forward.indicator === undefined ? {} : { indicator: probe.forward.indicator }),
		...(input.debugSynctex === true ? { ...debugCandidateDiagnostics(probe.reverse), ...debugForwardGroupDiagnostics(probe.reverse) } : {}),
		source_file: probe.forward.sourceFile,
		line: probe.forward.line,
		source_line: probe.forward.sourceLine,
	};
}

import { dirname } from "node:path";
import { parseSyncTexForPdf } from "./latex_workshop/worker.ts";
import type { ReverseSynctexPdfEventInput, ReverseSynctexSourceLocationEvent } from "../pdf_events.ts";
import type {
	ViewerHostReverseSynctexForwardProbeMessage,
	ViewerHostReverseSynctexForwardProbeResultMessage,
	ViewerHostReverseSynctexHoverMessage,
	ViewerHostReverseSynctexHoverResultMessage,
	ViewerHostReverseSynctexMessage,
	ViewerHostSynctexForwardRange,
} from "../viewer_host_protocol.ts";
import {
	findUniqueSelectedTextSourceRange,
	inspectReverseSynctexHover,
	mapForwardSynctex,
	mapReverseForwardSynctexProbe,
	mapReverseSynctex,
	type ForwardSynctexJump,
	type MapForwardSynctexInput,
	type ReverseSynctexSourceSpan,
} from "./forward_synctex.ts";

export type ReverseSynctexMapper = typeof mapReverseSynctex;

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
		probe = mapReverseForwardSynctexProbe({ ...probeInput, cwd: pdf.workspaceCwd ?? dirname(pdf.pdfPath) });
	} catch (error) {
		if (pdf.workspaceCwd === undefined || pdf.workspaceCwd === dirname(pdf.pdfPath)) throw error;
		probe = mapReverseForwardSynctexProbe({ ...probeInput, cwd: dirname(pdf.pdfPath) });
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
		...(input.debugSynctex === true ? debugCandidateDiagnostics(probe.reverse) : {}),
		source_file: probe.forward.sourceFile,
		line: probe.forward.line,
		source_line: probe.forward.sourceLine,
	};
}

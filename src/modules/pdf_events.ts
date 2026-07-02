export interface ReverseSynctexFormulaSpanEvent {
	source_file: string;
	start_line: number;
	end_line: number;
}

export interface ReverseSynctexSourceLocationEvent {
	source_file: string;
	line: number;
	column: number;
	source_line?: string;
	page: number;
	x: number;
	y: number;
}

export interface ReverseSynctexPdfEventInput {
	type: "reverse_synctex";
	pdf_id: number;
	source_file: string;
	line: number;
	column: number;
	source_line?: string;
	timestamp: string;
	page?: number;
	x?: number;
	y?: number;
	selected_text?: string;
	precision?: "verified" | "text" | "line" | "raw";
	repair?: string;
	selection_start?: ReverseSynctexSourceLocationEvent;
	selection_end?: ReverseSynctexSourceLocationEvent;
	selection_start_error?: string;
	selection_end_error?: string;
	raw_mapped_source_file?: string;
	raw_mapped_line?: number;
	raw_mapped_column?: number;
	raw_mapped_source_line?: string;
	normalized_formula_span?: ReverseSynctexFormulaSpanEvent;
	normalized_formula_excerpt?: string;
	synctex_diagnostics?: unknown;
}

export interface ReverseSynctexPdfEvent extends ReverseSynctexPdfEventInput {
	sequence: number;
}

export interface SelectionDebugPdfEventInput {
	type: "selection_debug";
	pdf_id: number;
	timestamp: string;
	phase: string;
	page?: number;
	x?: undefined;
	y?: undefined;
	text: string;
	details: unknown;
}

export interface SelectionDebugPdfEvent extends SelectionDebugPdfEventInput {
	sequence: number;
}

export type PdfEvent = ReverseSynctexPdfEvent | SelectionDebugPdfEvent;

export interface GetPdfEventsRequest {
	pdf_id?: number;
	max_events: number;
	stale?: boolean;
	debug?: boolean;
}

export class PdfEventStore {
	private readonly events: PdfEvent[] = [];
	private readonly readSequences = new Set<number>();
	private nextSequence = 1;

	appendReverseSynctexEvent(input: ReverseSynctexPdfEventInput): ReverseSynctexPdfEvent {
		const event: ReverseSynctexPdfEvent = {
			...input,
			sequence: this.nextSequence,
		};
		this.nextSequence += 1;
		this.events.push(event);
		return event;
	}

	appendSelectionDebugEvent(input: SelectionDebugPdfEventInput): SelectionDebugPdfEvent {
		const event: SelectionDebugPdfEvent = {
			...input,
			sequence: this.nextSequence,
		};
		this.nextSequence += 1;
		this.events.push(event);
		return event;
	}

	getEvents(request: GetPdfEventsRequest): PdfEvent[] {
		const pdfFiltered = request.pdf_id === undefined
			? this.events
			: this.events.filter((event) => event.pdf_id === request.pdf_id);
		const filtered = request.debug === true
			? pdfFiltered
			: pdfFiltered.filter((event) => event.type !== "selection_debug");
		if (request.stale === true) {
			return filtered.slice(-request.max_events);
		}
		const unread = filtered.filter((event) => !this.readSequences.has(event.sequence));
		const returned = unread.slice(0, request.max_events);
		for (const event of returned) {
			this.readSequences.add(event.sequence);
		}
		return returned;
	}

	clear(): void {
		this.events.length = 0;
		this.readSequences.clear();
		this.nextSequence = 1;
	}
}

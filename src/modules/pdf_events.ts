export interface ReverseSynctexSourceSpanEvent {
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
	precision?: "verified" | "text" | "line" | "raw";
	repair?: string;
	raw_mapped_source_file?: string;
	raw_mapped_line?: number;
	raw_mapped_column?: number;
	raw_mapped_source_line?: string;
	synctex_diagnostics?: unknown;
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
	normalized_source_span?: ReverseSynctexSourceSpanEvent;
	normalized_source_excerpt?: string;
	synctex_diagnostics?: unknown;
}

export interface ReverseSynctexPdfEvent extends ReverseSynctexPdfEventInput {
	sequence: number;
}

export interface PdfAnnotationEventInput {
	type: "pdf_annotation";
	pdf_id: number;
	annotation_id: string;
	timestamp: string;
	source_file: string;
	line: number;
	source_line?: string;
	pdf_mark?: string;
	source_span?: ReverseSynctexSourceSpanEvent;
	page: number;
	x: number;
	y: number;
	comment?: string;
}

export interface PdfAnnotationEvent extends PdfAnnotationEventInput {
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

export type PdfEvent = ReverseSynctexPdfEvent | PdfAnnotationEvent | SelectionDebugPdfEvent;

export interface GetPdfEventsRequest {
	pdf_id?: number;
	max_events: number;
	stale?: boolean;
	debug?: boolean;
}

export class PdfEventStore {
	private readonly events: PdfEvent[] = [];
	private readonly readSequences = new Set<number>();
	private readonly maxEvents: number;
	private nextSequence = 1;

	constructor(options: { maxEvents?: number } = {}) {
		this.maxEvents = typeof options.maxEvents === "number" && Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : 500;
	}

	appendReverseSynctexEvent(input: ReverseSynctexPdfEventInput): ReverseSynctexPdfEvent {
		const event: ReverseSynctexPdfEvent = {
			...input,
			sequence: this.nextSequence,
		};
		this.nextSequence += 1;
		this.append(event);
		return event;
	}

	appendPdfAnnotationEvent(input: PdfAnnotationEventInput): PdfAnnotationEvent {
		const event: PdfAnnotationEvent = {
			...input,
			sequence: this.nextSequence,
		};
		this.nextSequence += 1;
		this.append(event);
		return event;
	}

	appendSelectionDebugEvent(input: SelectionDebugPdfEventInput): SelectionDebugPdfEvent {
		const event: SelectionDebugPdfEvent = {
			...input,
			sequence: this.nextSequence,
		};
		this.nextSequence += 1;
		this.append(event);
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

	getPdfAnnotationEvents(request: Pick<GetPdfEventsRequest, "pdf_id" | "max_events">): PdfAnnotationEvent[] {
		const filtered = this.events.filter((event): event is PdfAnnotationEvent => event.type === "pdf_annotation"
			&& (request.pdf_id === undefined || event.pdf_id === request.pdf_id));
		const unread = filtered.filter((event) => !this.readSequences.has(event.sequence));
		const returned = unread.slice(0, request.max_events);
		for (const event of returned) this.readSequences.add(event.sequence);
		return returned;
	}

	clearPdfEvents(pdfId: number): void {
		for (let index = this.events.length - 1; index >= 0; index -= 1) {
			const event = this.events[index];
			if (event?.pdf_id !== pdfId) continue;
			this.readSequences.delete(event.sequence);
			this.events.splice(index, 1);
		}
	}

	clear(): void {
		this.events.length = 0;
		this.readSequences.clear();
		this.nextSequence = 1;
	}

	private append(event: PdfEvent): void {
		this.events.push(event);
		while (this.events.length > this.maxEvents) {
			const removed = this.events.shift();
			if (removed) this.readSequences.delete(removed.sequence);
		}
	}
}

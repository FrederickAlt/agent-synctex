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
}

export interface ReverseSynctexPdfEvent extends ReverseSynctexPdfEventInput {
	sequence: number;
}

export type PdfEvent = ReverseSynctexPdfEvent;

export interface GetPdfEventsRequest {
	pdf_id?: number;
	max_events: number;
}

export class PdfEventStore {
	private readonly events: PdfEvent[] = [];
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

	getEvents(request: GetPdfEventsRequest): PdfEvent[] {
		const filtered = request.pdf_id === undefined
			? this.events
			: this.events.filter((event) => event.pdf_id === request.pdf_id);
		return filtered.slice(-request.max_events);
	}

	clear(): void {
		this.events.length = 0;
		this.nextSequence = 1;
	}
}

import type { ViewerHostToMcpMessage } from "./viewer_host_protocol.ts";

export interface ViewerHostEventFilters {
	pdfIds?: ReadonlySet<number>;
	eventTypes?: ReadonlySet<ViewerHostToMcpMessage["type"]>;
}

/** Bounded transient events; lease-backed user marks deliberately live elsewhere. */
export class ViewerHostEventBacklog {
	private readonly events: ViewerHostToMcpMessage[] = [];
	private readonly capacity: number;

	constructor(capacity = 500) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("Viewer Host event backlog capacity must be a positive integer");
		this.capacity = capacity;
	}

	enqueue(message: ViewerHostToMcpMessage): void {
		if (message.type === "pdf_annotation" || message.type === "pdf_annotation_deleted") {
			throw new Error("PDF annotations must use PendingPdfMarkStore, not the transient event backlog");
		}
		if (message.type === "selection_debug" && message.phase !== "lw_raw_mouse_event" && message.phase !== "lw_raw_mouse_navigation") {
			const existingIndex = this.events.findIndex((event) => event.type === "selection_debug"
				&& event.pdf_id === message.pdf_id && event.phase === message.phase);
			if (existingIndex >= 0) {
				this.events[existingIndex] = message;
				return;
			}
		}
		this.events.push(message);
		while (this.events.length > this.capacity) {
			const diagnosticIndex = this.events.findIndex((event) => event.type !== "compile_action" && event.type !== "viewer_tab_closed");
			this.events.splice(diagnosticIndex >= 0 ? diagnosticIndex : 0, 1);
		}
	}

	drain(filters?: ViewerHostEventFilters): ViewerHostToMcpMessage[] {
		if (filters?.pdfIds === undefined && filters?.eventTypes === undefined) return this.events.splice(0);
		const drained: ViewerHostToMcpMessage[] = [];
		const kept: ViewerHostToMcpMessage[] = [];
		for (const event of this.events) {
			const matchesPdf = filters.pdfIds === undefined || ("pdf_id" in event && filters.pdfIds.has(event.pdf_id));
			const matchesType = filters.eventTypes === undefined || filters.eventTypes.has(event.type);
			if (matchesPdf && matchesType) drained.push(event);
			else kept.push(event);
		}
		this.events.splice(0, this.events.length, ...kept);
		return drained;
	}

	discardPdf(pdfId: number): void {
		const kept = this.events.filter((event) => !("pdf_id" in event) || event.pdf_id !== pdfId);
		this.events.splice(0, this.events.length, ...kept);
	}

	clear(): void {
		this.events.length = 0;
	}
}

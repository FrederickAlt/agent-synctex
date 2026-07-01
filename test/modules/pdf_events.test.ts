import assert from "node:assert/strict";
import { test } from "node:test";
import { PdfEventStore, type ReverseSynctexPdfEventInput } from "../../src/modules/pdf_events.ts";

function event(line: number, pdfId: number): ReverseSynctexPdfEventInput {
	return {
		type: "reverse_synctex",
		pdf_id: pdfId,
		source_file: `/tmp/source-${pdfId}.tex`,
		line,
		column: 1,
		timestamp: `2026-01-01T00:00:0${line}.000Z`,
	};
}

test("PDF event store assigns monotonic sequences and returns stale last N events across PDFs chronologically and non-destructively", () => {
	const store = new PdfEventStore();
	assert.equal(store.appendReverseSynctexEvent(event(1, 10)).sequence, 1);
	assert.equal(store.appendReverseSynctexEvent(event(2, 20)).sequence, 2);
	assert.equal(store.appendReverseSynctexEvent(event(3, 10)).sequence, 3);

	const firstRead = store.getEvents({ max_events: 2, stale: true });
	const secondRead = store.getEvents({ max_events: 2, stale: true });

	assert.deepEqual(firstRead.map((item) => item.sequence), [2, 3]);
	assert.deepEqual(secondRead.map((item) => item.sequence), [2, 3]);
});

test("PDF event store filters by pdf_id before selecting last N events", () => {
	const store = new PdfEventStore();
	store.appendReverseSynctexEvent(event(1, 10));
	store.appendReverseSynctexEvent(event(2, 20));
	store.appendReverseSynctexEvent(event(3, 10));
	store.appendReverseSynctexEvent(event(4, 20));
	store.appendReverseSynctexEvent(event(5, 10));

	assert.deepEqual(store.getEvents({ pdf_id: 10, max_events: 2, stale: true }).map((item) => item.sequence), [3, 5]);
	assert.deepEqual(store.getEvents({ pdf_id: 20, max_events: 5, stale: true }).map((item) => item.sequence), [2, 4]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HostServicePdfIdRegistry,
	MAX_ACTIVE_PDF_ID,
	type HostServiceManagedViewerRecordInput,
} from "../../src/modules/host_service.ts";

function recordTemplate(overrides: Partial<HostServiceManagedViewerRecordInput> = {}): HostServiceManagedViewerRecordInput {
	return {
		pdfPath: "/tmp/example.pdf",
		viewerHandle: "viewer://example",
		viewerBackend: "zathura",
		viewerOwned: true,
		...overrides,
	};
}

test("host service PDF ID registry enforces random ID range, uniqueness, and deterministic retries", () => {
	const generated: number[] = [];
	const values = [1, 1, 2, 3];
	const registry = new HostServicePdfIdRegistry({
		minPdfId: 1,
		maxPdfId: 10,
		maxAllocationAttempts: 8,
		makePdfId: () => {
			const value = values[generated.length] as number;
			generated.push(value);
			return value;
		},
	});

	const first = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/first.pdf" }));
	const second = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/second.pdf" }));

	assert.equal(first.id, 1);
	assert.equal(second.id, 2);
	assert.notEqual(first.id, second.id);
	assert.equal(generated.length, 3);
	assert.equal(generated.join(","), "1,1,2");
	assert.equal(registry.activeCount, 2);
});

test("host service PDF ID registry classifies stale/closed/unknown lifecycle states", () => {
	const staleRegistry = new HostServicePdfIdRegistry({
		minPdfId: 7,
		maxPdfId: 7,
		makePdfId: () => 7,
	});
	const staleRecord = staleRegistry.trackRecord(recordTemplate({ pdfPath: "/tmp/stale.pdf" }));
	staleRegistry.markRecordStale(staleRecord.id);
	assert.throws(() => staleRegistry.getActiveRecord(staleRecord.id), /Stale pdf_id=7:/);
	assert.throws(() => staleRegistry.removeRecord(staleRecord.id), /Stale pdf_id=7:/);
	assert.throws(() => staleRegistry.closeRecord(staleRecord.id), /Stale pdf_id=7:/);

	const closedRegistry = new HostServicePdfIdRegistry({
		minPdfId: 8,
		maxPdfId: 8,
		makePdfId: () => 8,
	});
	const closedRecord = closedRegistry.trackRecord(recordTemplate({ pdfPath: "/tmp/closed.pdf" }));
	const removed = closedRegistry.closeRecord(closedRecord.id);
	assert.equal(removed.id, 8);
	assert.equal(removed.viewerHandle, "viewer://example");
	assert.throws(() => closedRegistry.getActiveRecord(closedRecord.id), /Closed pdf_id=8:/);
	assert.throws(() => closedRegistry.removeRecord(closedRecord.id), /Closed pdf_id=8:/);
	assert.throws(() => closedRegistry.closeRecord(closedRecord.id), /Closed pdf_id=8:/);
	assert.throws(() => closedRegistry.closeRecord(123), /Unknown pdf_id=123:/);
	assert.equal(closedRegistry.activeCount, 0);
});

test("host service PDF ID registry exposes and revives known stale and closed records", () => {
	const generatedIds = [1, 2];
	let generatedIndex = 0;
	const registry = new HostServicePdfIdRegistry({
		minPdfId: 1,
		maxPdfId: 2,
		makePdfId: () => generatedIds[generatedIndex++] ?? 2,
	});
	const staleRecord = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/stale.pdf" }));
	registry.markRecordStale(staleRecord.id);
	const knownStale = registry.getKnownRecord(staleRecord.id);
	assert.equal(knownStale.state, "stale");
	assert.equal(knownStale.record.pdfPath, "/tmp/stale.pdf");
	const revivedStale = registry.reviveRecord(staleRecord.id);
	assert.equal(revivedStale.id, staleRecord.id);
	assert.equal(registry.getActiveRecord(staleRecord.id).id, staleRecord.id);

	const closedRecord = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/closed.pdf" }));
	registry.closeRecord(closedRecord.id);
	const knownClosed = registry.getKnownRecord(closedRecord.id);
	assert.equal(knownClosed.state, "closed");
	assert.equal(knownClosed.record.pdfPath, "/tmp/closed.pdf");
	const revivedClosed = registry.reviveRecord(closedRecord.id);
	assert.equal(revivedClosed.id, closedRecord.id);
	assert.equal(registry.getActiveRecord(closedRecord.id).id, closedRecord.id);
	assert.throws(() => registry.getKnownRecord(123), /Unknown pdf_id=123:/);
});

test("host service PDF ID registry does not reuse closed ids within service lifetime", () => {
	const registry = new HostServicePdfIdRegistry({
		minPdfId: 1,
		maxPdfId: 1,
		maxAllocationAttempts: 2,
		makePdfId: () => 1,
	});
	const first = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/first.pdf" }));
	registry.closeRecord(first.id);
	assert.throws(
		() => registry.trackRecord(recordTemplate({ pdfPath: "/tmp/second.pdf" })),
		/Unable to allocate unique active pdf_id after 2 attempts/,
	);
});

test("host service PDF ID registry clear() resets closed id tombstones for a new service lifetime", () => {
	const registry = new HostServicePdfIdRegistry({
		minPdfId: 1,
		maxPdfId: 1,
		maxAllocationAttempts: 1,
		makePdfId: () => 1,
	});
	const first = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/first.pdf" }));
	registry.closeRecord(first.id);
	registry.clear();
	const second = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/second.pdf" }));
	assert.equal(second.id, first.id);
	assert.equal(second.pdfPath, "/tmp/second.pdf");
});

test("host service PDF ID registry handles collision exhaustion deterministically", () => {
	const values = [1, 2, 1, 2, 1, 2, 1];
	let index = 0;
	const registry = new HostServicePdfIdRegistry({
		minPdfId: 1,
		maxPdfId: 2,
		maxAllocationAttempts: 4,
		makePdfId: () => values[index++ % values.length],
	});

	const first = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/first.pdf" }));
	const second = registry.trackRecord(recordTemplate({ pdfPath: "/tmp/second.pdf" }));
	assert.equal(first.id, 1);
	assert.equal(second.id, 2);

	assert.throws(
		() => registry.trackRecord(recordTemplate({ pdfPath: "/tmp/third.pdf" })),
		/Unable to allocate unique active pdf_id after 4 attempts/,
	);
});

test("host service PDF ID registry validates generated IDs against configured and canonical ranges", () => {
	const smallRangeRegistry = new HostServicePdfIdRegistry({
		minPdfId: 5,
		maxPdfId: 6,
		makePdfId: () => 4,
	});
	assert.throws(
		() => smallRangeRegistry.trackRecord(recordTemplate({ pdfPath: "/tmp/range-invalid.pdf" })),
		/Invalid generated pdf_id=4; expected integer in 5\.\.6/,
	);

	const canonicalRangeRegistry = new HostServicePdfIdRegistry({ makePdfId: () => MAX_ACTIVE_PDF_ID + 1 });
	assert.throws(
		() => canonicalRangeRegistry.trackRecord(recordTemplate({ pdfPath: "/tmp/canonical-invalid.pdf" })),
		/Invalid generated pdf_id=100000000;/,
	);
});

test("host service PDF ID registry rejects impossible option configuration", () => {
	assert.throws(() => new HostServicePdfIdRegistry({ minPdfId: 10, maxPdfId: 1 }), /invalid pdf id range/);
	assert.throws(
		() => new HostServicePdfIdRegistry({ minPdfId: 1, maxPdfId: MAX_ACTIVE_PDF_ID + 1 }),
		/invalid pdf id range/,
	);
});

test("host service PDF ID registry reuses IDs only after restart", () => {
	let reusedId: number;
	{
		const firstRegistry = new HostServicePdfIdRegistry({
			minPdfId: 1,
			maxPdfId: 100,
			makePdfId: () => 42,
		});
		reusedId = firstRegistry.trackRecord(recordTemplate({ pdfPath: "/tmp/first.pdf" })).id;
		assert.equal(reusedId, 42);
		firstRegistry.closeRecord(reusedId);
	}

	const secondRegistry = new HostServicePdfIdRegistry({
		minPdfId: 1,
		maxPdfId: 100,
		makePdfId: () => reusedId,
	});
	const second = secondRegistry.trackRecord(recordTemplate({ pdfPath: "/tmp/second.pdf" }));
	assert.equal(second.id, reusedId);
	assert.equal(secondRegistry.activeCount, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingPdfMarkStore } from "../../src/modules/pending_pdf_marks.ts";
import type { ViewerHostPdfAnnotationMessage } from "../../src/modules/viewer_host_protocol.ts";

function mark(pdfId: number, annotationId: string, comment: string): ViewerHostPdfAnnotationMessage {
	return {
		type: "pdf_annotation",
		pdf_id: pdfId,
		annotation_id: annotationId,
		page: 1,
		x: 10,
		y: 20,
		source_file: `/tmp/${pdfId}.tex`,
		line: 1,
		comment,
	};
}

test("pending PDF marks coalesce updates and acknowledge only the claimed version", () => {
	let claimNumber = 0;
	const store = new PendingPdfMarkStore({ makeClaimId: () => `claim-${++claimNumber}` });
	store.upsert(mark(1, "a", "old"));
	store.upsert(mark(1, "a", "new"));
	store.upsert(mark(2, "b", "second"));

	const first = store.claim({ pdfIds: new Set([1]), maxMarks: 20 });
	assert.equal(first.claimId, "claim-1");
	assert.deepEqual(first.marks.map((entry) => entry.comment), ["new"]);

	store.upsert(mark(1, "a", "newer while claimed"));
	assert.deepEqual(store.acknowledge("claim-1"), [], "ack must not delete a mark updated after it was claimed");
	assert.equal(store.size, 2);

	const second = store.claim({ maxMarks: 20 });
	assert.deepEqual(second.marks.map((entry) => [entry.pdf_id, entry.comment]), [[2, "second"], [1, "newer while claimed"]]);
	assert.deepEqual(store.acknowledge(second.claimId!), [
		{ pdf_id: 2, annotation_id: "b" },
		{ pdf_id: 1, annotation_id: "a" },
	]);
	assert.equal(store.size, 0);
});

test("pending PDF mark claims are leased and become available again after expiry", () => {
	let nowMs = 1_000;
	let claimNumber = 0;
	const store = new PendingPdfMarkStore({ nowMs: () => nowMs, leaseMs: 100, makeClaimId: () => `claim-${++claimNumber}` });
	store.upsert(mark(1, "a", "leased"));
	assert.equal(store.claim().marks.length, 1);
	assert.deepEqual(store.claim().marks, []);

	nowMs += 100;
	const retried = store.claim();
	assert.equal(retried.claimId, "claim-2");
	assert.equal(retried.marks[0]?.annotation_id, "a");
});

test("failed consumers can release a claim immediately", () => {
	const store = new PendingPdfMarkStore({ makeClaimId: () => "failed-claim" });
	store.upsert(mark(1, "a", "retry now"));
	const claimed = store.claim();
	assert.deepEqual(store.release(claimed.claimId!), [{ pdf_id: 1, annotation_id: "a" }]);
	assert.deepEqual(store.claim().marks.map((entry) => entry.annotation_id), ["a"]);
});

test("subset acknowledgement releases unrendered marks for the next consumer", () => {
	const store = new PendingPdfMarkStore({ makeClaimId: () => "claim" });
	store.upsert(mark(1, "shown", "one"));
	store.upsert(mark(1, "not-shown", "two"));
	const claim = store.claim();
	assert.deepEqual(store.acknowledge(claim.claimId!, [{ pdf_id: 1, annotation_id: "shown" }]), [{ pdf_id: 1, annotation_id: "shown" }]);
	assert.deepEqual(store.claim().marks.map((entry) => entry.annotation_id), ["not-shown"]);
});

test("pending PDF marks deep-copy SyncTeX debug diagnostics", () => {
	const store = new PendingPdfMarkStore();
	const diagnostics = {
		top_proposals: [{ source_file: "/tmp/1.tex", line: 1, score: -100 }],
		forward_groups: [],
	} as unknown as NonNullable<ViewerHostPdfAnnotationMessage["synctex_diagnostics"]>;
	const input = { ...mark(1, "debug", "trace"), synctex_diagnostics: diagnostics };
	store.upsert(input);
	diagnostics.top_proposals[0]!.score = 999;

	const claimed = store.claim().marks[0];
	assert.equal(claimed?.synctex_diagnostics?.top_proposals[0]?.score, -100);
});

test("pending PDF marks retain only successfully reconciled annotations", () => {
	const store = new PendingPdfMarkStore();
	store.upsert(mark(1, "keep", "before"));
	store.upsert(mark(1, "clear", "obsolete"));
	store.upsert(mark(2, "other", "unchanged"));

	const reconciled = store.reconcilePdf(1, (entry) => entry.annotation_id === "keep" ? { ...entry, comment: "rebased", line: 7 } : undefined);

	assert.deepEqual(reconciled.cleared, [{ pdf_id: 1, annotation_id: "clear" }]);
	assert.deepEqual(reconciled.updated.map((entry) => [entry.annotation_id, entry.line, entry.comment]), [["keep", 7, "rebased"]]);
	assert.deepEqual(store.claim().marks.map((entry) => [entry.pdf_id, entry.annotation_id, entry.comment]), [[1, "keep", "rebased"], [2, "other", "unchanged"]]);
});

test("reconciling a claimed PDF mark invalidates the old claim so the rebased mark is delivered", () => {
	let claimNumber = 0;
	const store = new PendingPdfMarkStore({ makeClaimId: () => `claim-${++claimNumber}` });
	store.upsert(mark(1, "claimed", "old"));
	const claim = store.claim();

	store.reconcilePdf(1, (entry) => ({ ...entry, comment: "rebased" }));

	assert.deepEqual(store.acknowledge(claim.claimId!), []);
	assert.equal(store.size, 1);
	assert.deepEqual(store.claim().marks.map((entry) => [entry.annotation_id, entry.comment]), [["claimed", "rebased"]]);
});

test("reconciling an unchanged mark preserves its active lease version", () => {
	const store = new PendingPdfMarkStore({ makeClaimId: () => "lease" });
	store.upsert(mark(1, "unchanged", "keep"));
	assert.equal(store.claim().claimId, "lease");
	assert.deepEqual(store.reconcilePdf(1, (entry) => entry), { updated: [], cleared: [] });
	assert.deepEqual(store.acknowledge("lease"), [{ pdf_id: 1, annotation_id: "unchanged" }]);
	assert.deepEqual(store.claim().marks, []);
});

test("pending PDF mark storage is bounded", () => {
	const store = new PendingPdfMarkStore({ maxPendingMarks: 2 });
	store.upsert(mark(1, "oldest", "one"));
	store.upsert(mark(1, "middle", "two"));
	store.upsert(mark(1, "latest", "three"));
	assert.deepEqual(store.claim().marks.map((entry) => entry.annotation_id), ["middle", "latest"]);
});

test("capacity pressure never evicts marks held by an active claim", () => {
	const store = new PendingPdfMarkStore({ maxPendingMarks: 1 });
	store.upsert(mark(1, "claimed", "one"));
	const claim = store.claim();
	assert.throws(() => store.upsert(mark(1, "new", "two")), /capacity is occupied by active claims/);
	assert.deepEqual(store.acknowledge(claim.claimId!), [{ pdf_id: 1, annotation_id: "claimed" }]);
});

test("capacity insertion releases expired claim leases before evicting", () => {
	let nowMs = 1_000;
	const store = new PendingPdfMarkStore({ nowMs: () => nowMs, leaseMs: 100, maxPendingMarks: 1 });
	store.upsert(mark(1, "expired", "one"));
	assert.equal(store.claim().marks.length, 1);
	nowMs += 100;
	assert.doesNotThrow(() => store.upsert(mark(1, "new", "two")));
	assert.deepEqual(store.claim().marks.map((entry) => entry.annotation_id), ["new"]);
});

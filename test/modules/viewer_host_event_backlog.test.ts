import assert from "node:assert/strict";
import { test } from "node:test";
import { ViewerHostEventBacklog } from "../../src/modules/viewer_host_event_backlog.ts";

test("Viewer Host event backlog keeps control actions under diagnostic pressure", () => {
	const backlog = new ViewerHostEventBacklog(2);
	backlog.enqueue({ type: "compile_action", pdf_id: 1, action: "stop" });
	backlog.enqueue({ type: "selection_debug", pdf_id: 1, phase: "one", text: "", details: {} });
	backlog.enqueue({ type: "selection_debug", pdf_id: 1, phase: "two", text: "", details: {} });
	assert.deepEqual(backlog.drain(), [
		{ type: "compile_action", pdf_id: 1, action: "stop" },
		{ type: "selection_debug", pdf_id: 1, phase: "two", text: "", details: {} },
	]);
});

test("Viewer Host event backlog filtered drains preserve unmatched events", () => {
	const backlog = new ViewerHostEventBacklog(5);
	backlog.enqueue({ type: "compile_action", pdf_id: 1, action: "compile" });
	backlog.enqueue({ type: "compile_action", pdf_id: 2, action: "stop" });
	assert.deepEqual(backlog.drain({ pdfIds: new Set([1]) }), [{ type: "compile_action", pdf_id: 1, action: "compile" }]);
	assert.deepEqual(backlog.drain(), [{ type: "compile_action", pdf_id: 2, action: "stop" }]);
});

test("Viewer Host event backlog rejects durable PDF marks", () => {
	const backlog = new ViewerHostEventBacklog();
	assert.throws(() => backlog.enqueue({ type: "pdf_annotation_deleted", pdf_id: 1, annotation_id: "a" }), /PendingPdfMarkStore/);
});

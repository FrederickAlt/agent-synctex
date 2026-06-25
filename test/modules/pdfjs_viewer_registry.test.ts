import assert from "node:assert/strict";
import { test } from "node:test";
import { PdfJsViewerRegistry } from "../../src/modules/pdfjs_viewer_registry.ts";

test("PDF.js viewer registry reuses active records by normalized PDF path", () => {
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 41 });
	const snapshot = { size: 123, mtimeMs: 456 };
	const first = registry.registerPdf({ pdfPath: "/tmp/paper.pdf", viewerUrl: "http://127.0.0.1/viewer/41", fileSnapshot: snapshot });
	const second = registry.registerPdf({ pdfPath: "/tmp/paper.pdf", viewerUrl: "ignored" });

	assert.equal(first.pdfId, 41);
	assert.equal(first.revision, 1);
	assert.deepEqual(first.fileSnapshot, snapshot);
	assert.equal(second, first);
	assert.equal(second.viewerUrl, "http://127.0.0.1/viewer/41");
	assert.equal(registry.activeCount, 1);
});

test("PDF.js viewer registry increments revision when a tracked PDF snapshot changes", () => {
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 42 });
	const record = registry.registerPdf({
		pdfPath: "/tmp/paper.pdf",
		viewerUrl: "http://127.0.0.1/viewer/42",
		fileSnapshot: { size: 10, mtimeMs: 100 },
	});

	const unchanged = registry.updatePdfSnapshot(record.pdfId, { size: 10, mtimeMs: 100 });
	assert.equal(unchanged.changed, false);
	assert.equal(record.revision, 1);

	const changed = registry.updatePdfSnapshot(record.pdfId, { size: 12, mtimeMs: 150 });
	assert.equal(changed.changed, true);
	assert.equal(changed.revision, 2);
	assert.deepEqual(record.fileSnapshot, { size: 12, mtimeMs: 150 });
});

test("PDF.js viewer registry tracks connected clients and removes them on disconnect", () => {
	let nextId = 10;
	const registry = new PdfJsViewerRegistry({ makePdfId: () => nextId++ });
	const record = registry.registerPdf({ pdfPath: "/tmp/paper.pdf", viewerUrl: "http://127.0.0.1/viewer/10" });
	const client = { send: (_message: string) => undefined };

	const clientId = registry.addClient(record.pdfId, client);
	assert.equal(registry.clientCount(record.pdfId), 1);
	assert.equal(registry.clientRecord(clientId)?.pdfId, record.pdfId);

	registry.removeClient(clientId);
	assert.equal(registry.clientCount(record.pdfId), 0);
	assert.equal(registry.clientRecord(clientId), undefined);
});

test("PDF.js viewer registry closes records without reusing closed pdf_ids", () => {
	let nextId = 1;
	const registry = new PdfJsViewerRegistry({ makePdfId: () => nextId++ });
	const first = registry.registerPdf({ pdfPath: "/tmp/paper.pdf", viewerUrl: "http://127.0.0.1/viewer/1" });

	const closed = registry.closePdf(first.pdfId);
	assert.equal(closed, first);
	assert.equal(registry.activeCount, 0);
	assert.throws(() => registry.getActiveRecord(first.pdfId), /Closed pdf_id=1/);

	const reopened = registry.registerPdf({ pdfPath: "/tmp/paper.pdf", viewerUrl: "http://127.0.0.1/viewer/2" });
	assert.equal(reopened.pdfId, 2);
});

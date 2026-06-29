import assert from "node:assert/strict";
import { test } from "node:test";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";

test("Viewer Host registry registers and re-registers MCP-provided pdf_id metadata", () => {
	const registry = new ViewerHostPdfRegistry();
	const first = registry.registerPdf({
		pdfId: 42,
		pdfPath: "/tmp/paper.pdf",
		title: "paper.pdf",
		revision: 1,
		fileSnapshot: { size: 100, mtimeMs: 200 },
	});

	assert.equal(first.pdfId, 42);
	assert.equal(first.pdfPath, "/tmp/paper.pdf");
	assert.equal(first.title, "paper.pdf");
	assert.equal(first.revision, 1);
	assert.deepEqual(first.fileSnapshot, { size: 100, mtimeMs: 200 });
	assert.deepEqual(registry.getPdf(42), first);

	const updated = registry.registerPdf({
		pdfId: 42,
		pdfPath: "/tmp/paper-v2.pdf",
		title: "Paper v2",
		revision: 7,
		fileSnapshot: { size: 120, mtimeMs: 250 },
	});

	assert.equal(updated, first);
	assert.equal(updated.pdfId, 42);
	assert.equal(updated.pdfPath, "/tmp/paper-v2.pdf");
	assert.equal(updated.title, "Paper v2");
	assert.equal(updated.revision, 7);
	assert.deepEqual(updated.fileSnapshot, { size: 120, mtimeMs: 250 });
	assert.deepEqual(registry.listPdfs(), [updated]);
});

test("Viewer Host registry lookup fails clearly for unknown pdf_id", () => {
	const registry = new ViewerHostPdfRegistry();

	assert.throws(() => registry.getPdf(99), /Unknown pdf_id=99/);
});

test("Viewer Host registry validates MCP-owned pdf_id and PDF metadata without allocating ids", () => {
	const registry = new ViewerHostPdfRegistry();

	assert.throws(() => registry.registerPdf({ pdfId: 0, pdfPath: "/tmp/a.pdf", title: "a", revision: 1, fileSnapshot: { size: 1, mtimeMs: 1 } }), /pdf_id/);
	assert.throws(() => registry.registerPdf({ pdfId: 1, pdfPath: "", title: "a", revision: 1, fileSnapshot: { size: 1, mtimeMs: 1 } }), /pdf_path/);
	assert.throws(() => registry.registerPdf({ pdfId: 1, pdfPath: "/tmp/a.pdf", title: "", revision: 1, fileSnapshot: { size: 1, mtimeMs: 1 } }), /title/);
	assert.throws(() => registry.registerPdf({ pdfId: 1, pdfPath: "/tmp/a.pdf", title: "a", revision: 0, fileSnapshot: { size: 1, mtimeMs: 1 } }), /revision/);
	assert.throws(() => registry.registerPdf({ pdfId: 1, pdfPath: "/tmp/a.pdf", title: "a", revision: 1, fileSnapshot: { size: -1, mtimeMs: 1 } }), /fileSnapshot.size/);
});

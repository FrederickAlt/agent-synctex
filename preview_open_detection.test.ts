import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSnapshot, previewAlreadyOpen, viewerLogReportsPreviewHandled } from "./preview_open_detection.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "preview-open-detection-test-"));
}

test("viewer log success lines count as an opened preview", async () => {
	const log = join(tempDir(), "zathura.log");
	writeFileSync(log, "old log\n");
	const before = fileSnapshot(log);
	appendFileSync(log, "[2026-05-26T07:24:58+0200] helper: launching /usr/bin/zathura /tmp/codex-show-latex/show-latex.pdf DISPLAY=:0 WAYLAND_DISPLAY=wayland-0\n");

	const opened = await previewAlreadyOpen(["/tmp/nonexistent-preview.pdf"], undefined, {
		viewerLogPath: log,
		viewerLogBefore: before,
		isPdfOpen: () => false,
		timeoutMs: 0,
	});

	assert.equal(opened, true);
});

test("viewer open failures do not suppress fallback", async () => {
	const log = join(tempDir(), "zathura.log");
	writeFileSync(log, "old log\n");
	const before = fileSnapshot(log);
	appendFileSync(log, "[2026-05-26T07:24:58+0200] helper: open failed: display unavailable\n");

	const opened = await previewAlreadyOpen(["/tmp/nonexistent-preview.pdf"], undefined, {
		viewerLogPath: log,
		viewerLogBefore: before,
		isPdfOpen: () => false,
		timeoutMs: 0,
	});

	assert.equal(opened, false);
});

test("viewer log parser recognizes old and new already-open messages", () => {
	assert.equal(viewerLogReportsPreviewHandled("[time] helper: zathura already open for fixed pdf; relying on auto-reload\n"), true);
	assert.equal(viewerLogReportsPreviewHandled("[time] helper: zathura already tracked with current SyncTeX command; relying on auto-reload\n"), true);
	assert.equal(viewerLogReportsPreviewHandled("[time] helper: tracked zathura lacks current SyncTeX command; launching configured viewer\n"), false);
});

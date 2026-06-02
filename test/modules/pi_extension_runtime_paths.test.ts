import assert from "node:assert/strict";
import { test } from "node:test";

import * as sharedRuntimePaths from "../../src/modules/runtime_paths.ts";
import * as extensionRuntimePaths from "../../src/modules/pi_extension/runtime_paths.ts";

test("pi_extension runtime_paths exports full MCP helper API", () => {
	assert.equal(typeof extensionRuntimePaths.getMcpTmpDir, "function");
	assert.equal(typeof extensionRuntimePaths.getLatexPreamblePath, "function");
	assert.equal(typeof extensionRuntimePaths.getMcpFixedPreviewPdfPath, "function");
	assert.equal(extensionRuntimePaths.getMcpTmpDir(), sharedRuntimePaths.getMcpTmpDir());
	assert.equal(extensionRuntimePaths.getLatexPreamblePath(), sharedRuntimePaths.getLatexPreamblePath());
	assert.equal(extensionRuntimePaths.getMcpFixedPreviewPdfPath(), sharedRuntimePaths.getMcpFixedPreviewPdfPath());
	assert.deepEqual(extensionRuntimePaths.LATEX_PREAMBLE_FILE_NAMES, sharedRuntimePaths.LATEX_PREAMBLE_FILE_NAMES);
	assert.equal(extensionRuntimePaths.MCP_TMPDIR, sharedRuntimePaths.MCP_TMPDIR);
	assert.equal(extensionRuntimePaths.MCP_FIXED_PREVIEW_PDF_PATH, sharedRuntimePaths.MCP_FIXED_PREVIEW_PDF_PATH);
	assert.equal(extensionRuntimePaths.LATEX_PREAMBLE_PATH, sharedRuntimePaths.LATEX_PREAMBLE_PATH);
});

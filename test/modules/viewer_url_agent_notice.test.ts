import assert from "node:assert/strict";
import { test } from "node:test";
import { appendViewerUrlAgentNotice } from "../../src/modules/viewer_url_agent_notice.ts";

test("viewer URL fallback tells the agent only to pass the URL to the user", () => {
	const text = appendViewerUrlAgentNotice("ok: pdf_id=42", {
		viewer_url: "http://127.0.0.1:43125/viewer-lw/42",
		browser_launch: {
			confirmed: false,
			error: "browser opener xdg-open exited with code 3: links2 not found",
		},
	});

	assert.equal(text, "ok: pdf_id=42\nPass this Viewer URL to the user: http://127.0.0.1:43125/viewer-lw/42");
	assert.doesNotMatch(text, /browser|opener|xdg-open|not found/i);
});

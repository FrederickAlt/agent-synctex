import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalLoopbackViewerHostAccessPolicy } from "../../src/modules/viewer_host_access_policy.ts";

test("local loopback Viewer Host access policy owns generated app, PDF, and socket URLs", () => {
	const policy = new LocalLoopbackViewerHostAccessPolicy();
	const origin = policy.originForAddress({ host: "127.0.0.1", port: 43125 });

	assert.equal(policy.bindHost, "127.0.0.1");
	assert.equal(origin, "http://127.0.0.1:43125");
	assert.equal(policy.viewerRootUrl(origin), "http://127.0.0.1:43125/viewer-lw");
	assert.equal(policy.viewerUrl(7, 3), "/viewer-lw/7?revision=3");
	assert.equal(policy.pdfUrl(origin, 7, 3), "http://127.0.0.1:43125/pdf/7?revision=3");
	assert.equal(policy.viewerSocketUrl(origin, 7, "a token"), "ws://127.0.0.1:43125/viewer-socket?pdf_id=7&token=a%20token");
	assert.equal(policy.isAllowedViewerSocketOrigin(undefined, origin), true);
	assert.equal(policy.isAllowedViewerSocketOrigin(origin, origin), true);
	assert.equal(policy.isAllowedViewerSocketOrigin("http://evil.example", origin), false);
});

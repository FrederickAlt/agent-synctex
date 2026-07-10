import assert from "node:assert/strict";
import { test } from "node:test";
import { ViewerFailureReporter, viewerFailureMessage } from "../../src/modules/viewer_failure_reporter.ts";

test("ViewerFailureReporter produces bounded structured viewer errors", () => {
	const message = viewerFailureMessage(new Error("low-level failure"), {
		pdfId: 7,
		code: ` failure-${"x".repeat(100)} `,
		title: ` Could not finish ${"y".repeat(220)} `,
		injectText: `forward-${"z".repeat(5_000)}`,
	});

	assert.equal(message.type, "viewer_error");
	assert.equal(message.pdf_id, 7);
	assert.ok(message.code.length <= 80);
	assert.ok(message.title.length <= 200);
	assert.equal(message.detail, "low-level failure");
	assert.ok((message.inject_text?.length ?? 0) <= 4_000);
});

test("ViewerFailureReporter.capture reports and rethrows the original operation failure", async () => {
	const delivered: unknown[] = [];
	const reporter = new ViewerFailureReporter((message) => { delivered.push(message); });
	const operationError = new Error("operation exploded");

	await assert.rejects(
		() => reporter.capture({ code: "operation_failed", title: "Operation failed", pdfId: 9 }, () => { throw operationError; }),
		(error) => error === operationError,
	);
	assert.deepEqual(delivered, [{
		type: "viewer_error",
		pdf_id: 9,
		code: "operation_failed",
		title: "Operation failed",
		detail: "operation exploded",
		inject_text: "Operation failed: operation exploded",
	}]);
});

test("ViewerFailureReporter.capture preserves both operation and delivery failures", async () => {
	const reporter = new ViewerFailureReporter(() => { throw new Error("viewer unavailable"); });

	await assert.rejects(
		() => reporter.capture({ code: "operation_failed", title: "Operation failed" }, () => { throw new Error("operation exploded"); }),
		(error) => error instanceof AggregateError
			&& error.errors.some((entry) => entry instanceof Error && entry.message === "operation exploded")
			&& error.errors.some((entry) => entry instanceof Error && entry.message === "viewer unavailable"),
	);
});

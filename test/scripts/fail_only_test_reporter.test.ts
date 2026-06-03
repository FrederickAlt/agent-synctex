import assert from "node:assert/strict";
import { test } from "node:test";

import failOnlyTestReporter, { formatFailure, formatSummary } from "../../scripts/fail-only-test-reporter.ts";

async function collectReporterOutput(events: Array<{ type: string; data?: unknown }>): Promise<string> {
	async function* source() {
		for (const event of events) {
			yield event;
		}
	}

	let output = "";
	for await (const chunk of failOnlyTestReporter(source())) {
		output += chunk;
	}
	return output;
}

test("fail-only reporter suppresses passing test events and per-file summaries", async () => {
	const output = await collectReporterOutput([
		{ type: "test:pass", data: { name: "passes" } },
		{ type: "test:summary", data: { file: "example.test.ts", counts: { tests: 1, passed: 1, failed: 0 } } },
	]);

	assert.equal(output, "");
});

test("fail-only reporter prints failures and the global summary", async () => {
	const error = new Error("test failed", { cause: new Error("expected 1 to equal 2") });
	const output = await collectReporterOutput([
		{
			type: "test:fail",
			data: {
				name: "fails clearly",
				testNumber: 7,
				file: "example.test.ts",
				line: 12,
				column: 3,
				details: { duration_ms: 1.25, error },
			},
		},
		{
			type: "test:summary",
			data: {
				counts: { tests: 2, passed: 1, failed: 1, skipped: 0, cancelled: 0, todo: 0 },
				duration_ms: 20,
			},
		},
	]);

	assert.match(output, /FAIL #7 fails clearly/);
	assert.match(output, /example\.test\.ts:12:3/);
	assert.match(output, /expected 1 to equal 2/);
	assert.match(output, /1 passed, 1 failed \(2 tests\) in 20\.0ms/);
});

test("formatSummary includes only non-zero optional counts", () => {
	assert.equal(
		formatSummary({ counts: { tests: 4, passed: 1, failed: 2, skipped: 1, cancelled: 0, todo: 0 }, duration_ms: 12.345 }),
		"1 passed, 2 failed, 1 skipped (4 tests) in 12.3ms\n",
	);
});

test("formatFailure handles missing optional fields", () => {
	assert.equal(formatFailure({ name: "fails" }), "FAIL fails\n");
});

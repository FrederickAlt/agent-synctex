import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { contextSessionKey } from "../../../src/modules/pi_extension/context_session.ts";

function fakeContext(cwd: string, ui: object): ExtensionContext {
	return {
		cwd,
		ui,
		hasUI: true,
		isIdle: () => false,
		signal: undefined,
	} as ExtensionContext;
}

test("contextSessionKey is deterministic for the same ui object", () => {
	const ui = {};
	const context = fakeContext("/project", ui);
	assert.equal(contextSessionKey(context), contextSessionKey(context));
});

test("contextSessionKey is unique across ui identities", () => {
	const keyA = contextSessionKey(fakeContext("/project", {}));
	const keyB = contextSessionKey(fakeContext("/project", {}));
	assert.notEqual(keyA, keyB);
});

test("contextSessionKey varies by working directory", () => {
	const ui = {};
	const keyA = contextSessionKey(fakeContext("/project/a", ui));
	const keyB = contextSessionKey(fakeContext("/project/b", ui));
	assert.notEqual(keyA, keyB);
});

test("contextSessionKey requires an active Pi context", () => {
	assert.throws(() => contextSessionKey(undefined), /Context key is only available inside a Pi agent session/);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildSourceSearchFragments,
	filterForwardBoxes,
	findSourceTextMatches,
	selectForwardVerifiedSourceMatch,
} from "../../../src/modules/synctex/text_repair.ts";

function withTempSource(lines: string[], run: (sourceFile: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "synctex-text-repair-"));
	try {
		const sourceFile = join(dir, "main.tex");
		writeFileSync(sourceFile, lines.join("\n"));
		run(sourceFile);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("source repair fragments reconstruct split PDF text across before/after context", () => {
	const fragments = buildSourceSearchFragments("PAGETWOD", "ISPLAYINT");

	assert.equal(fragments[0], "PAGETWODISPLAYINT");
	assert.ok(fragments.includes("PAGETWOD"));
	assert.ok(fragments.includes("ISPLAYINT"));
});

test("source repair fragments split Unicode math glyphs without requiring glyphs in TeX source", () => {
	const fragments = buildSourceSearchFragments("I = ∫ 1 −1 ", "PAGETWODISPLAYINT");

	assert.ok(fragments.includes("PAGETWODISPLAYINT"));
	assert.equal(fragments.some((fragment) => fragment.includes("∫") || fragment.includes("−")), false);
});

test("source text repair returns a unique match with line and column", () => {
	withTempSource([
		"before",
		"\\text{PAGETWODISPLAYINT}\\quad J=...",
		"after",
	], (sourceFile) => {
		const result = findSourceTextMatches(sourceFile, buildSourceSearchFragments("PAGETWOD", "ISPLAYINT"));

		assert.equal(result.status, "unique");
		assert.equal(result.fragment, "PAGETWODISPLAYINT");
		assert.deepEqual(result.matches.map(({ line, column }) => ({ line, column })), [{ line: 2, column: 6 }]);
	});
});

test("source text repair returns small ambiguous match sets for forward verification", () => {
	withTempSource(["TOKENALPHA one", "middle TOKENALPHA", "TOKENALPHA three"], (sourceFile) => {
		const result = findSourceTextMatches(sourceFile, ["TOKENALPHA"], { maxMatchesForVerification: 5 });

		assert.equal(result.status, "ambiguous-small");
		assert.equal(result.matches.length, 3);
		assert.deepEqual(result.matches.map((match) => match.line), [1, 2, 3]);
	});
});

test("source text repair rejects too many matches for terminal repair", () => {
	withTempSource(["TOKEN", "TOKEN", "TOKEN", "TOKEN", "TOKEN", "TOKEN"], (sourceFile) => {
		const result = findSourceTextMatches(sourceFile, ["TOKEN"], { maxMatchesForVerification: 5 });

		assert.equal(result.status, "too-many");
		assert.equal(result.matches.length, 0);
	});
});

test("forward verification retains a unique text match when forward boxes are empty", () => {
	const uniqueMatch = { sourceFile: "main.tex", line: 10, column: 0, fragment: "TOKEN" };
	const result = selectForwardVerifiedSourceMatch({
		matches: [uniqueMatch],
		click: { page: 2, x: 55, y: 55 },
		forwardBoxesForMatch: () => [],
	});

	assert.equal(result.precision, "text");
	assert.deepEqual(result.match, uniqueMatch);
	assert.equal(result.chosenBox, undefined);
	assert.deepEqual(result.boxes, []);
	assert.equal(result.containsClick, false);
});

test("forward verification retains a unique text match when all forward boxes are invalid", () => {
	const uniqueMatch = { sourceFile: "main.tex", line: 10, column: 0, fragment: "TOKEN" };
	const result = selectForwardVerifiedSourceMatch({
		matches: [uniqueMatch],
		click: { page: 2, x: 55, y: 55 },
		forwardBoxesForMatch: () => [
			{ page: 2, h: Number.NaN, v: 0, W: 10, H: 10 },
			{ page: 2, h: 0, v: 0, W: 0, H: 10 },
		],
	});

	assert.equal(result.precision, "text");
	assert.deepEqual(result.match, uniqueMatch);
	assert.equal(result.chosenBox, undefined);
	assert.deepEqual(result.boxes, []);
	assert.equal(result.containsClick, false);
});

test("forward verification selects the smallest containing box", () => {
	const result = selectForwardVerifiedSourceMatch({
		matches: [
			{ sourceFile: "main.tex", line: 10, column: 0, fragment: "TOKEN" },
			{ sourceFile: "main.tex", line: 20, column: 0, fragment: "TOKEN" },
		],
		click: { page: 2, x: 55, y: 55 },
		forwardBoxesForMatch: (match) => match.line === 10
			? [{ page: 2, h: 0, v: 200, W: 200, H: 200 }]
			: [{ page: 2, h: 50, v: 70, W: 20, H: 20 }],
	});

	assert.equal(result.precision, "verified");
	assert.equal(result.match?.line, 20);
	assert.deepEqual(result.chosenBox, { page: 2, h: 50, v: 70, W: 20, H: 20 });
});

test("forward verification treats forward box v as the lower edge", () => {
	const result = selectForwardVerifiedSourceMatch({
		matches: [
			{ sourceFile: "main.tex", line: 10, column: 0, fragment: "TOKEN" },
			{ sourceFile: "main.tex", line: 20, column: 0, fragment: "TOKEN" },
		],
		click: { page: 2, x: 55, y: 45 },
		forwardBoxesForMatch: (match) => match.line === 10
			? [{ page: 2, h: 0, v: 0, W: 10, H: 10 }]
			: [{ page: 2, h: 50, v: 50, W: 20, H: 20 }],
	});

	assert.equal(result.precision, "verified");
	assert.equal(result.containsClick, true);
	assert.equal(result.match?.line, 20);
	assert.deepEqual(result.chosenBox, { page: 2, h: 50, v: 50, W: 20, H: 20 });
});

test("forward verification falls back to nearest filtered box when none contain the click", () => {
	const result = selectForwardVerifiedSourceMatch({
		matches: [
			{ sourceFile: "main.tex", line: 10, column: 0, fragment: "TOKEN" },
			{ sourceFile: "main.tex", line: 20, column: 0, fragment: "TOKEN" },
		],
		click: { page: 2, x: 100, y: 100 },
		forwardBoxesForMatch: (match) => match.line === 10
			? [{ page: 2, h: 10, v: 15, W: 5, H: 5 }]
			: [{ page: 2, h: 92, v: 97, W: 5, H: 5 }],
	});

	assert.equal(result.precision, "text");
	assert.equal(result.match?.line, 20);
	assert.deepEqual(result.chosenBox, { page: 2, h: 92, v: 97, W: 5, H: 5 });
});

test("forward box filtering retains broad same-page boxes for numeric scoring", () => {
	const filtered = filterForwardBoxes([
		{ page: 2, h: 0, v: 792, W: 612, H: 792 },
		{ page: 2, h: 90, v: 102, W: 12, H: 12 },
	], { page: 2, x: 100, y: 100 });

	assert.deepEqual(filtered.boxes, [
		{ page: 2, h: 90, v: 102, W: 12, H: 12 },
		{ page: 2, h: 0, v: 792, W: 612, H: 792 },
	]);
	assert.deepEqual(filtered.chosenBox, { page: 2, h: 90, v: 102, W: 12, H: 12 });
	assert.equal(filtered.rejectedAbsurd, 0);
});

test("forward box filtering prefers same-page valid boxes without size rejection", () => {
	const filtered = filterForwardBoxes([
		{ page: 2, h: 0, v: 0, W: 10000, H: 10000 },
		{ page: 2, h: 90, v: 102, W: 12, H: 12 },
		{ page: 3, h: 95, v: 95, W: 2, H: 2 },
		{ page: 2, h: Number.NaN, v: 0, W: 10, H: 10 },
	], { page: 2, x: 100, y: 100 });

	assert.deepEqual(filtered.boxes, [
		{ page: 2, h: 90, v: 102, W: 12, H: 12 },
		{ page: 2, h: 0, v: 0, W: 10000, H: 10000 },
	]);
	assert.deepEqual(filtered.chosenBox, { page: 2, h: 90, v: 102, W: 12, H: 12 });
	assert.equal(filtered.rejectedInvalid, 1);
	assert.equal(filtered.rejectedAbsurd, 0);
});

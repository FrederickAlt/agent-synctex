import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import * as iconv from "iconv-lite";
import { test } from "node:test";
import { findUniqueSelectedTextSourceRange, inspectReverseSynctexHover, mapForwardSynctex, mapReverseForwardSynctexProbe, mapReverseSynctex, resolveSynctexSidecar } from "../../../src/modules/synctex/forward_synctex.ts";
import { collectReverseSyncTeXCandidatesFromParsed, findInputFilePathForward, inspectSyncTeXToTeX, inspectSyncTeXToTeXCandidates, syncTeXToPDF, syncTeXToTeX } from "../../../src/modules/synctex/latex_workshop/worker.ts";
import type { PdfSyncObject } from "../../../src/modules/synctex/latex_workshop/synctexjs.ts";

const FIXTURE_DIR = resolve("test/fixtures/synctex-forward");

function makeFixtureProject(options: { sidecar: "synctex" | "synctex.gz" }): { dir: string; pdfPath: string; sourcePath: string } {
	const dir = mkdtempSync(join(tmpdir(), `forward-synctex-${options.sidecar}-`));
	const pdfPath = join(dir, "paper.pdf");
	const sourcePath = join(dir, "main.tex");
	writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
	copyFileSync(join(FIXTURE_DIR, "main.tex"), sourcePath);
	copyFileSync(join(FIXTURE_DIR, `paper.${options.sidecar}`), join(dir, `paper.${options.sidecar}`));
	return { dir, pdfPath, sourcePath };
}

function readFixtureSynctex(): string {
	return readFileSync(join(FIXTURE_DIR, "paper.synctex"), "utf8");
}

function writeGzipSynctex(sidecarPath: string, body: string, encoding: BufferEncoding = "utf8"): void {
	writeFileSync(sidecarPath, gzipSync(Buffer.from(body, encoding)));
}

const failNativeRunner = () => ({ status: 1, stdout: "", stderr: "native disabled for JS fallback assertion" });

function syntheticParsedReverseFixture(lines: string[], blocksByLine: Array<{ line: number; left: number; bottom: number; width: number; height: number; page?: number }>, options: { inputPath?: string } = {}): { dir: string; sourcePath: string; parsed: PdfSyncObject } {
	const dir = mkdtempSync(join(tmpdir(), "reverse-synctex-candidates-"));
	const sourcePath = join(dir, "main.tex");
	const inputPath = options.inputPath ?? sourcePath;
	writeFileSync(sourcePath, lines.join("\n"));
	const blockNumberLine: PdfSyncObject["blockNumberLine"] = { [inputPath]: {} };
	for (const spec of blocksByLine) {
		const page = spec.page ?? 1;
		blockNumberLine[inputPath]![spec.line] ??= {};
		blockNumberLine[inputPath]![spec.line]![page] ??= [];
		blockNumberLine[inputPath]![spec.line]![page]!.push({
			type: "h",
			parent: { page, blocks: [], type: "page" },
			fileNumber: 1,
			file: { path: inputPath },
			line: spec.line,
			left: spec.left,
			bottom: spec.bottom,
			width: spec.width,
			height: spec.height,
			page,
		});
	}
	return {
		dir,
		sourcePath,
		parsed: {
			offset: { x: 0, y: 0 },
			version: "synthetic",
			files: { 1: { path: inputPath } },
			pages: {},
			blockNumberLine,
			hBlocks: [],
			numberPages: 1,
		},
	};
}

test("reverse SyncTeX candidate collection preserves current raw winner", () => {
	const fixture = syntheticParsedReverseFixture(["one", "two", "three"], [
		{ line: 1, left: 100, bottom: 110, width: 10, height: 10 },
		{ line: 2, left: 0, bottom: 10, width: 10, height: 10 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 5, 5, { minCandidates: 1, maxCandidates: 10, minDistance: 1 });
		assert.ok(inspection, "expected reverse candidates");
		assert.equal(inspection.rawWinner.line, 2);
		assert.equal(inspection.winner.line, 2);
		assert.equal(Number.isFinite(inspection.winner.distance), true);
		assert.ok(inspection.candidates.length >= 1);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate collection deduplicates source locations before radius expansion", () => {
	const fixture = syntheticParsedReverseFixture(["one", "two", "three"], [
		{ line: 1, left: 0, bottom: 10, width: 10, height: 10 },
		{ line: 1, left: 1, bottom: 10, width: 10, height: 10 },
		{ line: 1, left: 2, bottom: 10, width: 10, height: 10 },
		{ line: 2, left: 20, bottom: 10, width: 10, height: 10 },
		{ line: 3, left: 40, bottom: 10, width: 10, height: 10 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 5, 5, { minCandidates: 3, maxCandidates: 25, minDistance: 1, maxRadius: 100, pageHeight: 40 });
		assert.ok(inspection);
		assert.deepEqual(inspection.candidates.map((candidate) => candidate.line), [1, 2, 3]);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate collection stops expansion at the PDF page height", () => {
	const fixture = syntheticParsedReverseFixture(["near", "far"], [
		{ line: 1, left: 0, bottom: 10, width: 10, height: 10 },
		{ line: 2, left: 100, bottom: 10, width: 10, height: 10 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 5, 5, { minCandidates: 2, maxCandidates: 25, minDistance: 1, maxRadius: 100, pageHeight: 20 });
		assert.ok(inspection);
		assert.deepEqual(inspection.candidates.map((candidate) => candidate.line), [1]);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX public raw inspection matches candidate rawWinner", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	const previousCwd = process.cwd();
	try {
		process.chdir(project.dir);
		const publicRaw = inspectSyncTeXToTeX(1, 144.27, 155.27, project.pdfPath);
		const candidates = inspectSyncTeXToTeXCandidates(1, 144.27, 155.27, project.pdfPath);
		assert.ok(publicRaw);
		assert.ok(candidates);
		assert.deepEqual({ input: candidates.rawWinner.input, line: candidates.rawWinner.line, column: candidates.rawWinner.column }, { input: publicRaw.input, line: publicRaw.line, column: publicRaw.column });
		assert.deepEqual(candidates.rawWinner.rect, publicRaw.rect);
	} finally {
		process.chdir(previousCwd);
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate collection preserves rawWinner for unresolvable input paths", () => {
	const inputPath = "/definitely/unresolvable/main.tex";
	const fixture = syntheticParsedReverseFixture(["one", "two"], [
		{ line: 1, left: 0, bottom: 10, width: 10, height: 10 },
		{ line: 2, left: 100, bottom: 110, width: 10, height: 10 },
	], { inputPath });
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 5, 5, { minCandidates: 1, maxCandidates: 10, minDistance: 1 });
		assert.ok(inspection);
		assert.equal(inspection.rawWinner.input, inputPath);
		assert.equal(inspection.rawWinner.line, 1);
		assert.equal(inspection.candidates.some((candidate) => candidate.input === inputPath && candidate.line === 1), true);
		assert.equal(inspection.rawWinner.sourceLine, undefined);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate collection fills minCandidates from nearest blocks", () => {
	const fixture = syntheticParsedReverseFixture(["one", "two", "three", "four", "five"], [
		{ line: 1, left: 0, bottom: 10, width: 10, height: 10 },
		{ line: 2, left: 20, bottom: 10, width: 10, height: 10 },
		{ line: 3, left: 40, bottom: 10, width: 10, height: 10 },
		{ line: 4, left: 60, bottom: 10, width: 10, height: 10 },
		{ line: 5, left: 80, bottom: 10, width: 10, height: 10 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 5, 5, { minCandidates: 4, maxCandidates: 10, minDistance: 1 });
		assert.ok(inspection);
		assert.equal(inspection.candidates.length, 4);
		assert.deepEqual(inspection.candidates.map((candidate) => candidate.line), [1, 2, 3, 4]);
		assert.ok(inspection.candidates.every((candidate, index, candidates) => index === 0 || candidate.distance >= candidates[index - 1]!.distance));
		assert.equal("score" in inspection.candidates[0]!, false);
		assert.equal("areaPenalty" in inspection.candidates[0]!, false);
		assert.equal("structuralPenalty" in inspection.candidates[0]!, false);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate collection keeps many nearby candidates up to maxCandidates", () => {
	const fixture = syntheticParsedReverseFixture(["one", "two", "three", "four", "five"], [
		{ line: 1, left: 0, bottom: 10, width: 10, height: 10 },
		{ line: 2, left: 12, bottom: 10, width: 10, height: 10 },
		{ line: 3, left: 24, bottom: 10, width: 10, height: 10 },
		{ line: 4, left: 36, bottom: 10, width: 10, height: 10 },
		{ line: 5, left: 200, bottom: 10, width: 10, height: 10 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 5, 5, { minCandidates: 1, maxCandidates: 3, minDistance: 40 });
		assert.ok(inspection);
		assert.equal(inspection.candidates.length, 3);
		assert.deepEqual(inspection.candidates.map((candidate) => candidate.line), [1, 2, 3]);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate collection does not structurally demote nearby lines", () => {
	const fixture = syntheticParsedReverseFixture(["useful", "\\end{document}"], [
		{ line: 2, left: 0, bottom: 2, width: 2, height: 2 },
		{ line: 1, left: 4, bottom: 10, width: 10, height: 10 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 1, 1, { minCandidates: 1, maxCandidates: 10, minDistance: 20 });
		assert.ok(inspection);
		assert.equal(inspection.winner.line, 2);
		assert.equal(inspection.rawWinner.line, 2);
		assert.ok(inspection.candidates.some((candidate) => candidate.line === 2 && candidate.structural && candidate.structuralReason === "\\end{document}"));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate collection orders by Euclidean proximity", () => {
	const fixture = syntheticParsedReverseFixture(["x-far", "y-far"], [
		{ line: 1, left: 10, bottom: 1, width: 1, height: 1 },
		{ line: 2, left: 0, bottom: 10, width: 1, height: 1 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 0, 0, { minCandidates: 1, maxCandidates: 10, minDistance: 20 });
		assert.ok(inspection);
		assert.deepEqual(inspection.candidates.map((candidate) => candidate.line), [2, 1]);
		assert.equal(inspection.candidates.find((candidate) => candidate.line === 1)?.distance, 10);
		assert.equal(inspection.candidates.find((candidate) => candidate.line === 2)?.distance, 9);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping repairs raw structural winner with unique text context and containing forward box", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\documentclass{article}", "\\begin{document}", "\\text{PAGETWODISPLAYINT}\\quad J=1", "\\end{document}"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 2,
			x: 100,
			y: 200,
			cwd: dir,
			textBeforeSelection: "PAGETWOD",
			textAfterSelection: "ISPLAYINT",
			jsFallback: () => ({ input: sourcePath, line: 4, column: 0 }),
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 4, column: 0, sourceLine: "\\end{document}", rect: { left: 99, top: 199, right: 101, bottom: 201 }, distanceX: 0, distanceY: 0, distance: 0, area: 4, containsClick: true, structural: true, structuralReason: "\\end{document}" },
				rawWinner: { input: sourcePath, line: 4, column: 0, sourceLine: "\\end{document}", rect: { left: 99, top: 199, right: 101, bottom: 201 }, distanceX: 0, distanceY: 0, distance: 0, area: 4, containsClick: true, structural: true, structuralReason: "\\end{document}" },
				candidates: [],
			}),
			forwardBoxesForLine: ({ line }) => line === 3 ? [{ page: 2, h: 90, v: 210, W: 30, H: 20 }] : [],
		});
		assert.equal(location.line, 3);
		assert.equal(location.precision, "verified");
		assert.equal(location.rawMappedLine, 4);
		assert.equal(location.rawMappedSourceLine, "\\end{document}");
		assert.equal(location.diagnostics.textRepair?.used, true);
		assert.equal(location.diagnostics.forwardVerification?.containsClick, true);
		assert.equal((location.diagnostics.rawWinner as { line?: number }).line, 4);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping does not give unique text a bonus when geometry scores tie", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-text-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "FIGURETWOSMALLBOX", "ranked candidate"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "FIGURE",
			textAfterSelection: "TWOSMALLBOX",
			jsFallback: () => ({ input: sourcePath, line: 3, column: 0 }),
			forwardBoxesForLine: () => [{ page: 1, h: 200, v: 200, W: 10, H: 10 }],
		});
		assert.equal(location.line, 3);
		assert.equal(location.precision, "line");
		assert.equal(location.rawMappedLine, undefined);
		assert.equal(location.diagnostics.forwardVerification?.containsClick, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping gives a separate -1000 bonus when the chosen forward box contains the click", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-click-bonus-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "contains click", "misses click"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 5,
			y: 5,
			cwd: dir,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: "contains click", rect: { left: 0, top: 0, right: 10, bottom: 10 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				rawWinner: { input: sourcePath, line: 2, column: 0, sourceLine: "contains click", rect: { left: 0, top: 0, right: 10, bottom: 10 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				candidates: [
					{ input: sourcePath, line: 2, column: 0, sourceLine: "contains click", rect: { left: 0, top: 0, right: 10, bottom: 10 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
					{ input: sourcePath, line: 3, column: 0, sourceLine: "misses click", rect: { left: 20, top: 0, right: 30, bottom: 10 }, distanceX: 15, distanceY: 0, distance: 15, area: 100, containsClick: false, structural: false },
				],
			}),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 0, v: 10, W: 10, H: 10 }] : [{ page: 1, h: 20, v: 10, W: 10, H: 10 }],
		});
		assert.equal(location.line, 2);
		assert.equal(location.diagnostics.selected.score, -980);
		assert.equal(location.diagnostics.proposalScores?.find((proposal) => proposal.line === 2)?.clickContainmentBonus, -1000);
		assert.equal(location.diagnostics.proposalScores?.find((proposal) => proposal.line === 2)?.score, -980);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping applies click containment bonus when forward box v is the lower edge", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-lower-edge-click-bonus-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "contains lower-edge click"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 5,
			y: 15,
			cwd: dir,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: "contains lower-edge click", rect: { left: 0, top: 10, right: 10, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				rawWinner: { input: sourcePath, line: 2, column: 0, sourceLine: "contains lower-edge click", rect: { left: 0, top: 10, right: 10, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				candidates: [{ input: sourcePath, line: 2, column: 0, sourceLine: "contains lower-edge click", rect: { left: 0, top: 10, right: 10, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false }],
			}),
			forwardBoxesForLine: () => [{ page: 1, h: 0, v: 20, W: 10, H: 10 }],
		});
		assert.equal(location.line, 2);
		assert.equal(location.diagnostics.proposalScores?.find((proposal) => proposal.line === 2)?.containsClick, true);
		assert.equal(location.diagnostics.proposalScores?.find((proposal) => proposal.line === 2)?.clickContainmentBonus, -1000);
		assert.equal(location.diagnostics.proposalScores?.find((proposal) => proposal.line === 2)?.score, -980);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping uses every JS candidate as a proposal and lets lower proximity win on forward geometry", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-candidate-proposals-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "near old winner", "far better geometry"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: "near old winner", rect: { left: 10, top: 10, right: 20, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				rawWinner: { input: sourcePath, line: 2, column: 0, sourceLine: "near old winner", rect: { left: 10, top: 10, right: 20, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				candidates: [
					{ input: sourcePath, line: 2, column: 0, sourceLine: "near old winner", rect: { left: 10, top: 10, right: 20, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
					{ input: sourcePath, line: 3, column: 0, sourceLine: "far better geometry", rect: { left: 100, top: 100, right: 110, bottom: 110 }, distanceX: 90, distanceY: 90, distance: 127.3, area: 100, containsClick: false, structural: false },
				],
			}),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 100, v: 120, W: 20, H: 20 }] : [{ page: 1, h: 8, v: 12, W: 4, H: 4 }],
		});
		assert.equal(location.line, 3);
		assert.deepEqual(location.diagnostics.proposalScores?.map((proposal) => proposal.line), [3, 2]);
		assert.equal(location.diagnostics.proposalScores?.every((proposal) => proposal.kind !== "text"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping scores exact structural boxes alongside normalized span alternatives", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-structural-box-pool-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\begin{align}", "  a &= b", "\\end{align}", "nearby candidate"].join("\n"));
		const lookups: string[] = [];
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 5,
			y: 5,
			cwd: dir,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 3, column: 0, sourceLine: "\\end{align}", rect: { left: 0, top: 0, right: 10, bottom: 10 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: true },
				rawWinner: { input: sourcePath, line: 3, column: 0, sourceLine: "\\end{align}", rect: { left: 0, top: 0, right: 10, bottom: 10 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: true },
				candidates: [
					{ input: sourcePath, line: 3, column: 0, sourceLine: "\\end{align}", rect: { left: 0, top: 0, right: 10, bottom: 10 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: true },
					{ input: sourcePath, line: 4, column: 0, sourceLine: "nearby candidate", rect: { left: 50, top: 50, right: 60, bottom: 60 }, distanceX: 45, distanceY: 45, distance: 63.6, area: 100, containsClick: false, structural: false },
				],
			}),
			forwardBoxesForLine: ({ line, lookupMode }) => {
				lookups.push(`${lookupMode}:${line}`);
				if (line === 3 && lookupMode === "exact") return [{ page: 1, h: 0, v: 10, W: 10, H: 10 }];
				if (line === 2 && lookupMode === "normalized") return [{ page: 1, h: 100, v: 110, W: 10, H: 10 }];
				return [{ page: 1, h: 50, v: 60, W: 10, H: 10 }];
			},
		});
		assert.deepEqual(lookups, ["exact:3", "normalized:2", "exact:4"]);
		assert.equal(location.line, 3);
		assert.equal(location.forwardLookupLine, 3);
		assert.equal(location.forwardLookupMode, "exact");
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: sourcePath, startLine: 1, endLine: 3 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping skips an invalid first JS candidate and scores later candidates without native fallback", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-invalid-first-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["one", "valid later candidate"].join("\n"));
		let nativeCalls = 0;
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			nativeRunner: () => { nativeCalls += 1; return { status: 0, stdout: "", stderr: "" }; },
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 99, column: 0, rect: { left: 0, top: 0, right: 1, bottom: 1 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: false },
				rawWinner: { input: sourcePath, line: 99, column: 0, rect: { left: 0, top: 0, right: 1, bottom: 1 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: false },
				candidates: [
					{ input: sourcePath, line: 99, column: 0, rect: { left: 0, top: 0, right: 1, bottom: 1 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: false },
					{ input: sourcePath, line: 2, column: 0, sourceLine: "valid later candidate", rect: { left: 8, top: 8, right: 12, bottom: 12 }, distanceX: 0, distanceY: 0, distance: 0, area: 16, containsClick: true, structural: false },
				],
			}),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 8, v: 12, W: 4, H: 4 }] : [],
		});
		assert.equal(location.line, 2);
		assert.equal(nativeCalls, 0);
		assert.deepEqual(location.diagnostics.proposalScores?.map((proposal) => proposal.line), [2]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping falls back to native when JS candidates yield no viable proposals", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-no-viable-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["native line"].join("\n"));
		let nativeCalls = 0;
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			nativeRunner: () => {
				nativeCalls += 1;
				return { status: 0, stdout: `SyncTeX result begin\nInput:${sourcePath}\nLine:1\nColumn:0\nSyncTeX result end\n`, stderr: "" };
			},
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 99, column: 0, rect: { left: 0, top: 0, right: 1, bottom: 1 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: false },
				rawWinner: { input: sourcePath, line: 99, column: 0, rect: { left: 0, top: 0, right: 1, bottom: 1 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: false },
				candidates: [{ input: sourcePath, line: 99, column: 0, rect: { left: 0, top: 0, right: 1, bottom: 1 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: false }],
			}),
			forwardBoxesForLine: () => [],
		});
		assert.equal(location.line, 1);
		assert.equal(location.diagnostics.branch, "native_fallback");
		assert.equal(nativeCalls, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX prefers an exact source line over an equal-score normalized closing span", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-exact-over-normalized-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\begin{align}", "f(x)", "\\end{align}"].join("\n"));
		const close = { input: sourcePath, line: 3, column: 0, sourceLine: "\\end{align}", rect: { left: 0, top: 0, right: 1, bottom: 1 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: false };
		const content = { input: sourcePath, line: 2, column: 0, sourceLine: "f(x)", rect: { left: 1, top: 1, right: 2, bottom: 2 }, distanceX: 1, distanceY: 1, distance: 1, area: 1, containsClick: false, structural: false };
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 5,
			y: 5,
			cwd: dir,
			inspectCandidates: () => ({ winner: close, rawWinner: close, candidates: [close, content] }),
			forwardBoxesForLine: ({ line }) => line === 3 ? [{ page: 1, h: 0, v: 70, W: 50, H: 70 }] : [{ page: 1, h: 0, v: 10, W: 10, H: 10 }],
		});
		assert.equal(location.line, 2);
		assert.equal(location.forwardLookupMode, "exact");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX attaches a literal nested environment span as metadata", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-generic-environment-span-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\begin{figure}", "outer", "\\begin{proof}", "inner", "\\end{proof}", "\\end{figure}"].join("\n"));
		const candidate = { input: sourcePath, line: 5, column: 0, sourceLine: "\\end{proof}", rect: { left: 0, top: 0, right: 10, bottom: 10 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false };
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 5,
			y: 5,
			cwd: dir,
			inspectCandidates: () => ({ winner: candidate, rawWinner: candidate, candidates: [candidate] }),
			forwardBoxesForLine: () => [{ page: 1, h: 0, v: 10, W: 10, H: 10 }],
		});
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: sourcePath, startLine: 3, endLine: 5 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX uses a visually hyphenated PDF text rectangle without forward-geometry overlap", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-verified-pdf-text-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		const sourceLine = "formula close, while the heading exercises PDF text geometry.";
		writeFileSync(sourcePath, `${sourceLine}\n`);
		const candidate = { input: sourcePath, line: 1, column: 0, sourceLine, rect: { left: 90, top: 198, right: 190, bottom: 210 }, distanceX: 0, distanceY: 0, distance: 0, area: 1200, containsClick: true, structural: false };
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 100,
			y: 204,
			cwd: dir,
			pdfTextSpans: [{ page: 1, h: 90, v: 210, W: 100, H: 12, text: "while the heading exercises PDF text geome-" }],
			inspectCandidates: () => ({ winner: candidate, rawWinner: candidate, candidates: [candidate] }),
			forwardBoxesForLine: () => [{ page: 1, h: 0, v: 30, W: 10, H: 10 }],
		});
		assert.equal(location.precision, "verified");
		assert.deepEqual(location.selectedForwardRanges, [{ page: 1, h: 90, v: 210, W: 100, H: 12 }]);
		assert.equal(location.diagnostics.proposalScores?.[0]?.geometryTier, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping forwards every retained unique candidate proposal", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-candidate-cap-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["one", "two", "three", "four", "five", "six"].join("\n"));
		const candidates = [1, 2, 3, 4, 5, 6].map((line) => ({ input: sourcePath, line, column: 0, sourceLine: String(line), rect: { left: line, top: line, right: line + 1, bottom: line + 1 }, distanceX: line, distanceY: line, distance: line, area: 1, containsClick: false, structural: false }));
		const forwardLines: number[] = [];
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			inspectCandidates: () => ({ winner: candidates[0]!, rawWinner: candidates[0]!, candidates }),
			forwardBoxesForLine: ({ line }) => {
				forwardLines.push(line);
				return line === 6 ? [{ page: 1, h: 10, v: 11, W: 1, H: 1 }] : [{ page: 1, h: 100 + line, v: 101 + line, W: 1, H: 1 }];
			},
		});
		assert.deepEqual(forwardLines, [1, 2, 3, 4, 5, 6]);
		assert.equal(location.line, 6);
		assert.equal(location.diagnostics.proposalScores?.length, 6);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reverse candidate proposal deduplication retains a later useful source line", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-duplicate-end-document-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		const lines = Array.from({ length: 71 }, (_, index) => index === 35 ? "f(x), & 0<x<L,\\ t=0,\\\\" : index === 70 ? "\\end{document}" : `line ${index + 1}`);
		writeFileSync(sourcePath, lines.join("\n"));
		const structural = { input: sourcePath, line: 71, column: 0, sourceLine: "\\end{document}", rect: { left: 390, top: 145, right: 390, bottom: 145 }, distanceX: 0, distanceY: 0, distance: 0, area: 0, containsClick: true, structural: true, structuralReason: "\\end{document}" };
		const formula = { input: sourcePath, line: 36, column: 0, sourceLine: lines[35]!, rect: { left: 370, top: 133, right: 602, bottom: 149 }, distanceX: 20, distanceY: 0, distance: 20, area: 3712, containsClick: false, structural: false };
		const forwardLines: number[] = [];
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 390,
			y: 145,
			cwd: dir,
			inspectCandidates: () => ({ winner: structural, rawWinner: structural, candidates: [structural, structural, structural, structural, structural, formula] }),
			forwardBoxesForLine: ({ line }) => {
				forwardLines.push(line);
				return line === 36 ? [{ page: 1, h: 370, v: 149, W: 232, H: 16 }] : [{ page: 1, h: 50, v: 500, W: 511, H: 219 }];
			},
		});
		assert.deepEqual(forwardLines, [71, 36]);
		assert.equal(location.line, 36);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping puts end-document in the least-preferred geometry tier", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-enddoc-geometry-tier-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["usable fallback", "\\end{document}"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: "\\end{document}", rect: { left: 8, top: 8, right: 12, bottom: 12 }, distanceX: 0, distanceY: 0, distance: 0, area: 16, containsClick: true, structural: true, structuralReason: "\\end{document}" },
				rawWinner: { input: sourcePath, line: 2, column: 0, sourceLine: "\\end{document}", rect: { left: 8, top: 8, right: 12, bottom: 12 }, distanceX: 0, distanceY: 0, distance: 0, area: 16, containsClick: true, structural: true, structuralReason: "\\end{document}" },
				candidates: [
					{ input: sourcePath, line: 2, column: 0, sourceLine: "\\end{document}", rect: { left: 8, top: 8, right: 12, bottom: 12 }, distanceX: 0, distanceY: 0, distance: 0, area: 16, containsClick: true, structural: true, structuralReason: "\\end{document}" },
					{ input: sourcePath, line: 1, column: 0, sourceLine: "usable fallback", rect: { left: 200, top: 200, right: 220, bottom: 220 }, distanceX: 190, distanceY: 190, distance: 268.7, area: 400, containsClick: false, structural: false },
				],
			}),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 8, v: 12, W: 4, H: 4 }] : [],
		});
		const usable = location.diagnostics.proposalScores?.find((proposal) => proposal.line === 1);
		const endDocument = location.diagnostics.proposalScores?.find((proposal) => proposal.line === 2);
		assert.equal(location.line, 1);
		assert.equal(usable?.geometryTier, 1);
		assert.equal(endDocument?.geometryTier, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping does not privilege raw end-document when same-page geometry ties", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-enddoc-tie-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "better same-page source", "\\end{document}"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 3, column: 0, sourceLine: "\\end{document}", rect: { left: 10, top: 10, right: 11, bottom: 11 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: true, structuralReason: "\\end{document}" },
				rawWinner: { input: sourcePath, line: 3, column: 0, sourceLine: "\\end{document}", rect: { left: 10, top: 10, right: 11, bottom: 11 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: true, structuralReason: "\\end{document}" },
				candidates: [
					{ input: sourcePath, line: 3, column: 0, sourceLine: "\\end{document}", rect: { left: 10, top: 10, right: 11, bottom: 11 }, distanceX: 0, distanceY: 0, distance: 0, area: 1, containsClick: true, structural: true, structuralReason: "\\end{document}" },
					{ input: sourcePath, line: 2, column: 0, sourceLine: "better same-page source", rect: { left: 12, top: 10, right: 13, bottom: 11 }, distanceX: 1, distanceY: 0, distance: 1, area: 1, containsClick: false, structural: false },
				],
			}),
			forwardBoxesForLine: ({ line }) => line === 3
				? [{ page: 1, h: 8, v: 12, W: 4, H: 4 }, { page: 1, h: 40, v: 44, W: 4, H: 4 }]
				: [{ page: 1, h: 8, v: 12, W: 4, H: 4 }],
		});
		const [winner, endDocument] = location.diagnostics.proposalScores ?? [];
		assert.equal(location.line, 2);
		assert.equal(winner?.line, 2);
		assert.equal(endDocument?.line, 3);
		assert.ok((winner?.score ?? Infinity) < (endDocument?.score ?? -Infinity));
		assert.equal(endDocument?.structural, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping uses unweighted forward distance", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-unweighted-distance-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "horizontal miss", "vertical miss"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 3, column: 0, sourceLine: "vertical miss", rect: { left: 10, top: 30, right: 20, bottom: 40 }, distanceX: 0, distanceY: 10, distance: 10, area: 100, containsClick: false, structural: false },
				rawWinner: { input: sourcePath, line: 3, column: 0, sourceLine: "vertical miss", rect: { left: 10, top: 30, right: 20, bottom: 40 }, distanceX: 0, distanceY: 10, distance: 10, area: 100, containsClick: false, structural: false },
				candidates: [
					{ input: sourcePath, line: 3, column: 0, sourceLine: "vertical miss", rect: { left: 10, top: 30, right: 20, bottom: 40 }, distanceX: 0, distanceY: 10, distance: 10, area: 100, containsClick: false, structural: false },
					{ input: sourcePath, line: 2, column: 0, sourceLine: "horizontal miss", rect: { left: 20, top: 10, right: 30, bottom: 20 }, distanceX: 10, distanceY: 0, distance: 10, area: 100, containsClick: false, structural: false },
				],
			}),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 20, v: 10, W: 10, H: 10 }] : [{ page: 1, h: 10, v: 30, W: 10, H: 10 }],
		});
		assert.equal(location.line, 3);
		assert.deepEqual(location.diagnostics.proposalScores?.map((proposal) => proposal.line), [3, 2]);
		assert.equal(location.diagnostics.proposalScores?.[0]?.score, 116);
		assert.equal(location.diagnostics.proposalScores?.[1]?.score, 116);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping uses exact forward geometry scoring formula", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-formula-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "candidate"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 13,
			y: 14,
			cwd: dir,
			jsFallback: () => ({ input: sourcePath, line: 2, column: 0 }),
			forwardBoxesForLine: () => [{ page: 1, h: 0, v: 8, W: 6, H: 8 }],
		});
		assert.equal(location.diagnostics.proposalScores?.[0]?.score, ((7 ** 2 + 6 ** 2) * 0.96) + (Math.sqrt(48) * 2));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping applies full text containment bonus without partial bonus", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-full-text-bonus-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "HELLOWORLD", "ranked candidate"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "HELLO",
			textAfterSelection: "WORLD",
			jsFallback: () => ({ input: sourcePath, line: 3, column: 0 }),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 5, v: 15, W: 10, H: 10 }] : [{ page: 1, h: 5, v: 15, W: 10, H: 10 }],
		});
		const textScore = location.diagnostics.proposalScores?.find((proposal) => proposal.kind === "text") as { score?: number; clickContainmentBonus?: number; textContainmentBonus?: number; textContainment?: string } | undefined;
		assert.equal(location.line, 2);
		assert.equal(textScore?.score, -1480);
		assert.equal(textScore?.clickContainmentBonus, -1000);
		assert.equal(textScore?.textContainmentBonus, -500);
		assert.equal(textScore?.textContainment, "full");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping caps full text containment scoring to 30 characters per side", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-capped-full-text-bonus-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		const beforePrefix = "A".repeat(36);
		const beforeTail = "B".repeat(30);
		const afterHead = "C".repeat(30);
		const afterSuffix = "D".repeat(36);
		const cappedContext = `${beforeTail}${afterHead}`;
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", cappedContext].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: `${beforePrefix}${beforeTail}`,
			textAfterSelection: `${afterHead}${afterSuffix}`,
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: cappedContext, rect: { left: 5, top: 5, right: 15, bottom: 15 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				rawWinner: { input: sourcePath, line: 2, column: 0, sourceLine: cappedContext, rect: { left: 5, top: 5, right: 15, bottom: 15 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false },
				candidates: [{ input: sourcePath, line: 2, column: 0, sourceLine: cappedContext, rect: { left: 5, top: 5, right: 15, bottom: 15 }, distanceX: 0, distanceY: 0, distance: 0, area: 100, containsClick: true, structural: false }],
			}),
			forwardBoxesForLine: () => [{ page: 1, h: 5, v: 15, W: 10, H: 10 }],
		});
		const score = location.diagnostics.proposalScores?.[0] as { score?: number; textContainmentBonus?: number; textContainment?: string } | undefined;
		assert.equal(location.line, 2);
		assert.equal(score?.score, -1480);
		assert.equal(score?.textContainmentBonus, -500);
		assert.equal(score?.textContainment, "full");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping applies partial 8-character text containment bonus with one-sided fill", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-partial-text-bonus-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "KLM xxx FGHIJKLM", "ranked candidate"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "ABCDEFGHIJ",
			textAfterSelection: "KLM",
			jsFallback: () => ({ input: sourcePath, line: 3, column: 0 }),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 5, v: 15, W: 10, H: 10 }] : [{ page: 1, h: 5, v: 15, W: 10, H: 10 }],
		});
		const textScore = location.diagnostics.proposalScores?.find((proposal) => proposal.kind === "text") as { score?: number; clickContainmentBonus?: number; textContainmentBonus?: number; textContainment?: string } | undefined;
		assert.equal(location.line, 2);
		assert.equal(textScore?.score, -1180);
		assert.equal(textScore?.clickContainmentBonus, -1000);
		assert.equal(textScore?.textContainmentBonus, -200);
		assert.equal(textScore?.textContainment, "partial");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping grants no partial text containment bonus when fewer than eight context characters are available", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-no-short-partial-bonus-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "DEFG", "ranked candidate"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "ABC",
			textAfterSelection: "DEFG",
			jsFallback: () => ({ input: sourcePath, line: 3, column: 0 }),
			forwardBoxesForLine: ({ line }) => line === 2 ? [{ page: 1, h: 5, v: 15, W: 10, H: 10 }] : [{ page: 1, h: 5, v: 15, W: 10, H: 10 }],
		});
		const textScore = location.diagnostics.proposalScores?.find((proposal) => proposal.kind === "text") as { score?: number; clickContainmentBonus?: number; textContainmentBonus?: number; textContainment?: string } | undefined;
		assert.equal(location.line, 3);
		assert.equal(textScore?.score, -980);
		assert.equal(textScore?.clickContainmentBonus, -1000);
		assert.equal(textScore?.textContainmentBonus, 0);
		assert.equal(textScore?.textContainment, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping verifies same-line text repair and preserves raw diagnostics", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-same-line-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "PAGETWODISPLAYINT", "ranked candidate should not replace verified same-line repair"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "PAGETWOD",
			textAfterSelection: "ISPLAYINT",
			jsFallback: () => ({ input: sourcePath, line: 2, column: 0 }),
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 3, column: 0, sourceLine: "ranked candidate should not replace verified same-line repair", rect: { left: 30, top: 30, right: 40, bottom: 40 }, distanceX: 20, distanceY: 20, distance: 28.28, area: 100, containsClick: false, structural: false },
				rawWinner: { input: sourcePath, line: 2, column: 0, sourceLine: "PAGETWODISPLAYINT", rect: { left: 5, top: 5, right: 20, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 225, containsClick: true, structural: false },
				candidates: [],
			}),
			forwardBoxesForLine: () => [{ page: 1, h: 5, v: 25, W: 20, H: 20 }],
		});
		assert.equal(location.line, 2);
		assert.equal(location.column, 8);
		assert.equal(location.precision, "verified");
		assert.equal(location.rawMappedLine, 2);
		assert.equal(location.diagnostics.textRepair?.used, true);
		assert.equal(location.diagnostics.forwardVerification?.containsClick, true);
		assert.equal((location.diagnostics.rawWinner as { line?: number }).line, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping scores raw section heading above wrong-page text repair", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-section-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\documentclass{article}", "\\section{Introduction}", "Body", "\\section{Target Section}"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "Introduction",
			textAfterSelection: "",
			jsFallback: () => ({ input: sourcePath, line: 4, column: 0 }),
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: "\\section{Introduction}", rect: { left: 200, top: 200, right: 260, bottom: 220 }, distanceX: 190, distanceY: 190, distance: 268.7, area: 1200, containsClick: false, structural: false },
				rawWinner: { input: sourcePath, line: 4, column: 0, sourceLine: "\\section{Target Section}", rect: { left: 5, top: 5, right: 80, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 1125, containsClick: true, structural: false },
				candidates: [],
			}),
			forwardBoxesForLine: ({ line }) => line === 4 ? [{ page: 1, h: 5, v: 25, W: 80, H: 20 }] : line === 2 ? [{ page: 2, h: 200, v: 220, W: 60, H: 20 }] : [],
		});
		assert.equal(location.line, 4);
		assert.equal(location.precision, "line");
		assert.equal(location.rawMappedLine, 4);
		assert.equal(location.diagnostics.textRepair?.used, false);
		assert.equal(location.diagnostics.forwardVerification?.containsClick, false);
		assert.equal(location.diagnostics.proposalScores?.[0]?.kind, "ranked");
		assert.equal(location.diagnostics.proposalScores?.some((proposal) => proposal.kind === "text" && proposal.line === 2 && proposal.reason === "no-same-page-forward-box"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping rejects stale margin text context with wrong-page geometry", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-margin-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\documentclass{article}", "\\section{First Section}", "Body", "Margin-adjacent prose line"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "First",
			textAfterSelection: "Section",
			jsFallback: () => ({ input: sourcePath, line: 4, column: 0 }),
			inspectCandidates: () => ({
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: "\\section{First Section}", rect: { left: 100, top: 100, right: 180, bottom: 120 }, distanceX: 90, distanceY: 90, distance: 127.3, area: 1600, containsClick: false, structural: false },
				rawWinner: { input: sourcePath, line: 4, column: 0, sourceLine: "Margin-adjacent prose line", rect: { left: 12, top: 12, right: 80, bottom: 24 }, distanceX: 2, distanceY: 2, distance: 2.8, area: 816, containsClick: false, structural: false },
				candidates: [],
			}),
			forwardBoxesForLine: ({ line }) => line === 4 ? [{ page: 1, h: 12, v: 24, W: 68, H: 12 }] : line === 2 ? [{ page: 2, h: 100, v: 120, W: 80, H: 20 }] : [],
		});
		assert.equal(location.line, 4);
		assert.equal(location.precision, "line");
		assert.equal(location.rawMappedLine, undefined);
		assert.equal(location.diagnostics.textRepair?.used, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping gives page mismatch a huge penalty against same-page raw geometry", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-page-penalty-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\documentclass{article}", "WRONGPAGEUNIQUE", "same page raw line"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "WRONGPAGE",
			textAfterSelection: "UNIQUE",
			jsFallback: () => ({ input: sourcePath, line: 3, column: 0 }),
			forwardBoxesForLine: ({ line }) => line === 3 ? [{ page: 1, h: 400, v: 400, W: 20, H: 20 }] : line === 2 ? [{ page: 2, h: 10, v: 10, W: 20, H: 20 }] : [],
		});
		assert.equal(location.line, 3);
		assert.equal(location.diagnostics.textRepair?.used, false);
		const candidateScore = location.diagnostics.proposalScores?.find((proposal) => proposal.kind === "ranked");
		const textScore = location.diagnostics.proposalScores?.find((proposal) => proposal.kind === "text");
		assert.ok(candidateScore && textScore);
		assert.equal(candidateScore.samePageBoxCount, 1);
		assert.equal(textScore.samePageBoxCount, 0);
		assert.ok(candidateScore.geometryTier < textScore.geometryTier);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping ranks any usable same-page geometry above wrong-page unique text", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-page-tier-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\documentclass{article}", "WRONGPAGEUNIQUE", "very far same page raw line"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "WRONGPAGE",
			textAfterSelection: "UNIQUE",
			jsFallback: () => ({ input: sourcePath, line: 3, column: 0 }),
			forwardBoxesForLine: ({ line }) => line === 3 ? [{ page: 1, h: 2_000_000, v: 2_000_000, W: 20, H: 20 }] : line === 2 ? [{ page: 2, h: 10, v: 10, W: 20, H: 20 }] : [],
		});
		assert.equal(location.line, 3);
		assert.equal(location.diagnostics.proposalScores?.[0]?.kind, "ranked");
		assert.equal(location.diagnostics.proposalScores?.[0]?.samePageBoxCount, 1);
		assert.equal(location.diagnostics.proposalScores?.[1]?.kind, "text");
		assert.equal(location.diagnostics.proposalScores?.[1]?.samePageBoxCount, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("robust reverse mapping selects the top scored proposal when no proposal has forward geometry", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-no-geometry-order-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["\\documentclass{article}", "UNIQUEWITHOUTGEOMETRY", "raw line without geometry"].join("\n"));
		const location = mapReverseSynctex({
			pdfPath,
			page: 1,
			x: 10,
			y: 10,
			cwd: dir,
			textBeforeSelection: "UNIQUEWITHOUT",
			textAfterSelection: "GEOMETRY",
			jsFallback: () => ({ input: sourcePath, line: 3, column: 0 }),
			forwardBoxesForLine: () => [],
		});
		const topProposal = location.diagnostics.proposalScores?.[0];
		assert.equal(topProposal?.kind, "ranked");
		assert.equal(location.line, topProposal?.line);
		assert.equal(location.sourceFile, topProposal?.sourceFile);
		assert.equal(location.diagnostics.textRepair?.used, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reverse-forward probe default path uses robust text context for forward SyncTeX", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const forwardLines: number[] = [];
		const probe = mapReverseForwardSynctexProbe({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			textBeforeSelection: "Second",
			textAfterSelection: "",
			mapForward: (input) => {
				forwardLines.push(input.line);
				assert.equal(input.line, 3);
				assert.equal(input.lookupMode, "exact");
				return { page: 1, x: 90, y: 190, ranges: [{ page: 1, h: 90, v: 190, W: 20, H: 10 }], sourceFile: input.sourceFile, line: input.line, sourceLine: "First paragraph text that should wrap a little and create boxes.", sidecarPath: join(project.dir, "paper.synctex"), branch: "js_fallback", diagnostics: { branch: "js_fallback", lookupInput: { pdfPath: project.pdfPath, sourceFile: input.sourceFile, line: input.line, sidecarPath: join(project.dir, "paper.synctex") }, native: { command: "synctex", args: [], cwd: project.dir, parsedRectangles: [] }, jsFallback: { attempted: true } } };
			},
		});
		assert.deepEqual(forwardLines, [3]);
		assert.equal(probe.reverse.line, 3);
		assert.equal(probe.reverse.precision, "line");
		assert.equal(probe.forward.line, 3);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse-forward probe renders the selected normalized box group", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const probe = mapReverseForwardSynctexProbe({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144,
			y: 155,
			cwd: project.dir,
			inspectReverse: (input) => ({
				page: input.page,
				x: input.x,
				y: input.y,
				sourceFile: project.sourcePath,
				line: 3,
				column: 0,
				sourceLine: "\\end{align}",
				sidecarPath: join(project.dir, "paper.synctex"),
				forwardLookupLine: 2,
				forwardLookupMode: "normalized" as const,
				selectedForwardBox: { page: 1, h: 140, v: 150, W: 16, H: 10 },
				rect: { left: 10, top: 20, right: 30, bottom: 40 },
				distanceFromCenter: 0,
			}),
			mapForward: (input) => {
				assert.equal(input.line, 2);
				assert.equal(input.lookupMode, "normalized");
				return { page: 1, x: 140, y: 150, ranges: [{ page: 1, h: 140, v: 150, W: 16, H: 10 }, { page: 1, h: 0, v: 700, W: 500, H: 300 }], sourceFile: input.sourceFile, line: input.line, sourceLine: "formula body", sidecarPath: join(project.dir, "paper.synctex"), branch: "js_fallback", diagnostics: { branch: "js_fallback", lookupInput: { pdfPath: project.pdfPath, sourceFile: input.sourceFile, line: input.line, sidecarPath: join(project.dir, "paper.synctex") }, native: { command: "synctex", args: [], cwd: project.dir, parsedRectangles: [] }, jsFallback: { attempted: true } } };
			},
		});
		assert.equal(probe.forward.line, 2);
		assert.deepEqual(probe.forward.ranges, [{ page: 1, h: 140, v: 150, W: 16, H: 10 }]);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse-forward probe filters garbage forward boxes before display", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const probe = mapReverseForwardSynctexProbe({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144,
			y: 155,
			cwd: project.dir,
			inspectReverse: (input) => ({
				page: input.page,
				x: input.x,
				y: input.y,
				sourceFile: project.sourcePath,
				line: 3,
				column: 0,
				sourceLine: "First paragraph text that should wrap a little and create boxes.",
				sidecarPath: join(project.dir, "paper.synctex"),
				rect: { left: 10, top: 20, right: 30, bottom: 40 },
				distanceFromCenter: 0,
			}),
			mapForward: (input) => ({
				page: 1,
				x: 0,
				y: 0,
				ranges: [
					{ page: 1, h: 0, v: 0, W: 10_000, H: 10_000 },
					{ page: 1, h: 140, v: 150, W: 16, H: 10 },
					{ page: 2, h: 144, v: 155, W: 5, H: 5 },
				],
				sourceFile: input.sourceFile,
				line: input.line,
				sourceLine: "First paragraph text that should wrap a little and create boxes.",
				sidecarPath: join(project.dir, "paper.synctex"),
				branch: "js_fallback",
				diagnostics: { branch: "js_fallback", lookupInput: { pdfPath: project.pdfPath, sourceFile: input.sourceFile, line: input.line, sidecarPath: join(project.dir, "paper.synctex") }, native: { command: "synctex", args: [], cwd: project.dir, parsedRectangles: [] }, jsFallback: { attempted: true } },
			}),
		});

		assert.deepEqual(probe.forward.ranges, [{ page: 1, h: 140, v: 150, W: 16, H: 10 }]);
		assert.equal(probe.forward.page, 1);
		assert.equal(probe.forward.x, 140);
		assert.equal(probe.forward.y, 150);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse-forward probe maps JS reverse inspection result through forward SyncTeX", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const calls: string[] = [];
		const probe = mapReverseForwardSynctexProbe({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144,
			y: 155,
			cwd: project.dir,
			inspectReverse: (input) => {
				calls.push(`reverse:${input.page}:${input.x}:${input.y}`);
				return {
					page: input.page,
					x: input.x,
					y: input.y,
					sourceFile: project.sourcePath,
					line: 3,
					column: 0,
					sourceLine: "First paragraph text that should wrap a little and create boxes.",
					sidecarPath: join(project.dir, "paper.synctex"),
					rect: { left: 10, top: 20, right: 30, bottom: 40 },
					distanceFromCenter: 0,
				};
			},
			mapForward: (input) => {
				calls.push(`forward:${input.sourceFile}:${input.line}`);
				assert.equal(input.sourceFile, project.sourcePath);
				assert.equal(input.line, 3);
				return mapForwardSynctex({ ...input, nativeRunner: failNativeRunner, jsFallback: syncTeXToPDF });
			},
		});

		assert.deepEqual(calls, [`reverse:1:144:155`, `forward:${project.sourcePath}:3`]);
		assert.equal(probe.reverse.sourceFile, project.sourcePath);
		assert.equal(probe.reverse.line, 3);
		assert.equal(probe.forward.sourceFile, project.sourcePath);
		assert.equal(probe.forward.line, 3);
		assert.equal(probe.forward.page, 1);
		assert.equal(probe.forward.indicator, true);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("LaTeX-Workshop-derived syncTeXToPDF reads realistic .synctex fixtures and maps source lines to page coordinates", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	const previousCwd = process.cwd();
	try {
		process.chdir(project.dir);
		const jump = syncTeXToPDF(3, project.sourcePath, project.pdfPath);

		assert.deepEqual(jump, {
			page: 1,
			x: 143.7309977720268,
			y: 154.6899018816158,
			indicator: true,
		});
	} finally {
		process.chdir(previousCwd);
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native forward SyncTeX returns native rectangle ranges", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
		const jump = mapForwardSynctex({
			pdfPath: project.pdfPath,
			sourceFile: project.sourcePath,
			line: 3,
			cwd: project.dir,
			nativeRunner: (command, args, options) => {
				calls.push({ command, args, cwd: options.cwd });
				return {
					status: 0,
					stdout: [
						"SyncTeX result begin",
						"Output:1",
						"Page:2",
						"h:20",
						"v:140",
						"W:30",
						"H:12",
						"Output:2",
						"Page:3",
						"h:80",
						"v:200",
						"W:10",
						"H:8",
						"SyncTeX result end",
					].join("\n"),
					stderr: "",
				};
			},
			jsFallback: () => {
				throw new Error("JS fallback should not be invoked after native success");
			},
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, "synctex");
		assert.deepEqual(calls[0]?.args, ["view", "-i", `3:1:${project.sourcePath}`, "-o", project.pdfPath]);
		assert.equal(calls[0]?.cwd, dirname(project.pdfPath));
		assert.equal(jump.branch, "native");
		assert.equal(jump.diagnostics.branch, "native");
		assert.equal(jump.diagnostics.native.command, "synctex");
		assert.deepEqual(jump.diagnostics.native.args, ["view", "-i", `3:1:${project.sourcePath}`, "-o", project.pdfPath]);
		assert.equal(jump.diagnostics.native.status, 0);
		assert.match(jump.diagnostics.native.stdout ?? "", /SyncTeX result begin/);
		assert.deepEqual(jump.diagnostics.native.parsedRectangles, [
			{ page: 2, h: 20, v: 140, W: 30, H: 12 },
			{ page: 3, h: 80, v: 200, W: 10, H: 8 },
		]);
		assert.equal(jump.diagnostics.jsFallback, undefined);
		assert.equal(jump.page, 2);
		assert.equal(jump.x, 20);
		assert.equal(jump.y, 140);
		assert.deepEqual(jump.ranges, [
			{ page: 2, h: 20, v: 140, W: 30, H: 12 },
			{ page: 3, h: 80, v: 200, W: 10, H: 8 },
		]);
		assert.equal(jump.indicator, true);
		assert.equal(jump.sourceLine, "First paragraph text that should wrap a little and create boxes.");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native forward SyncTeX keeps top-level point consistent with the first rectangle record when multiple native records include x/y", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const jump = mapForwardSynctex({
			pdfPath: project.pdfPath,
			sourceFile: project.sourcePath,
			line: 3,
			cwd: project.dir,
			nativeRunner: () => ({
				status: 0,
				stdout: [
					"SyncTeX result begin",
					"Output:1",
					"Page:2",
					"x:21",
					"y:141",
					"h:20",
					"v:140",
					"W:30",
					"H:12",
					"Output:2",
					"Page:3",
					"x:888",
					"y:999",
					"h:80",
					"v:200",
					"W:10",
					"H:8",
					"SyncTeX result end",
				].join("\n"),
				stderr: "",
			}),
			jsFallback: () => {
				throw new Error("JS fallback should not be invoked after native success");
			},
		});

		assert.equal(jump.branch, "native");
		assert.equal(jump.page, 2);
		assert.equal(jump.x, 21);
		assert.equal(jump.y, 141);
		assert.deepEqual(jump.ranges, [
			{ page: 2, h: 20, v: 140, W: 30, H: 12 },
			{ page: 3, h: 80, v: 200, W: 10, H: 8 },
		]);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native rectangle-mode failure falls back to JS circle semantics without synthetic ranges", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const jump = mapForwardSynctex({
			pdfPath: project.pdfPath,
			sourceFile: project.sourcePath,
			line: 3,
			cwd: project.dir,
			nativeRunner: () => ({
				status: 1,
				stdout: "SyncTeX result begin\nOutput:1\nPage:1\nh:20\nv:40\nW:10\nH:5\nSyncTeX result end\n",
				stderr: "native rectangle mode failed",
			}),
			jsFallback: (line, sourceFile, pdfPath) => syncTeXToPDF(line, sourceFile, pdfPath),
		});

		assert.equal(jump.branch, "js_fallback");
		assert.equal(jump.diagnostics.branch, "js_fallback");
		assert.equal(jump.diagnostics.native.status, 1);
		assert.match(jump.diagnostics.native.failureReason ?? "", /native rectangle mode failed/);
		assert.deepEqual(jump.diagnostics.native.parsedRectangles, []);
		assert.equal(jump.diagnostics.jsFallback?.attempted, true);
		assert.deepEqual(jump.diagnostics.jsFallback?.point, {
			page: jump.page,
			x: jump.x,
			y: jump.y,
			indicator: true,
		});
		assert.equal(jump.indicator, true);
		assert.equal(Object.hasOwn(jump, "ranges"), false);
		assert.equal(Object.hasOwn(jump, "width"), false);
		assert.equal(Object.hasOwn(jump, "height"), false);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native forward SyncTeX success returns native output without using JS fallback", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
		const jump = mapForwardSynctex({
			pdfPath: project.pdfPath,
			sourceFile: project.sourcePath,
			line: 3,
			cwd: project.dir,
			nativeRunner: (command, args, options) => {
				calls.push({ command, args, cwd: options.cwd });
				return {
					status: 0,
					stdout: "SyncTeX result begin\nPage:2\nx:11.5\ny:22.25\nSyncTeX result end\n",
					stderr: "",
				};
			},
			jsFallback: () => {
				throw new Error("JS fallback should not be invoked after native success");
			},
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, "synctex");
		assert.deepEqual(calls[0]?.args, ["view", "-i", `3:1:${project.sourcePath}`, "-o", project.pdfPath]);
		assert.equal(calls[0]?.cwd, dirname(project.pdfPath));
		assert.equal(jump.branch, "native");
		assert.equal(jump.page, 2);
		assert.equal(jump.x, 11.5);
		assert.equal(jump.y, 22.25);
		assert.equal(jump.indicator, true);
		assert.equal(jump.sourceLine, "First paragraph text that should wrap a little and create boxes.");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native forward SyncTeX failure falls back to the existing LaTeX-Workshop JS parser", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const fallbackCalls: Array<{ line: number; sourceFile: string; pdfPath: string }> = [];
		const jump = mapForwardSynctex({
			pdfPath: project.pdfPath,
			sourceFile: project.sourcePath,
			line: 3,
			cwd: project.dir,
			nativeRunner: () => ({ status: 1, stdout: "", stderr: "native failed" }),
			jsFallback: (line, sourceFile, pdfPath) => {
				fallbackCalls.push({ line, sourceFile, pdfPath });
				return syncTeXToPDF(line, sourceFile, pdfPath);
			},
		});

		assert.deepEqual(fallbackCalls, [{ line: 3, sourceFile: project.sourcePath, pdfPath: project.pdfPath }]);
		assert.equal(jump.branch, "js_fallback");
		assert.equal(jump.indicator, true);
		assert.equal(jump.page, 1);
		assert.equal(jump.x, 143.7309977720268);
		assert.equal(jump.y, 154.6899018816158);
		assert.equal(Object.hasOwn(jump, "width"), false);
		assert.equal(Object.hasOwn(jump, "height"), false);
		assert.equal(Object.hasOwn(jump, "ranges"), false);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native forward SyncTeX no-result plus JS fallback no-result reports no usable mapping clearly", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		assert.throws(
			() => mapForwardSynctex({
				pdfPath: project.pdfPath,
				sourceFile: project.sourcePath,
				line: 3,
				cwd: project.dir,
				nativeRunner: () => ({ status: 0, stdout: "SyncTeX result begin\nSyncTeX result end\n", stderr: "" }),
				jsFallback: () => undefined,
			}),
			/No usable SyncTeX mapping found.*native.*no usable result.*JS fallback.*no result/i,
		);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX native path does not reintroduce a custom sidecar parser before JS fallback", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		let fallbackCalls = 0;
		assert.throws(
			() => mapForwardSynctex({
				pdfPath: project.pdfPath,
				sourceFile: project.sourcePath,
				line: 3,
				cwd: project.dir,
				nativeRunner: () => ({ status: 1, stdout: "", stderr: "native failed" }),
				jsFallback: () => {
					fallbackCalls += 1;
					return undefined;
				},
			}),
			/JS fallback returned no result/i,
		);
		assert.equal(fallbackCalls, 1);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX adapter returns LaTeX-Workshop output plus current API glue fields", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	const previousCwd = process.cwd();
	try {
		process.chdir(project.dir);
		const lwJump = syncTeXToPDF(3, project.sourcePath, project.pdfPath);
		process.chdir(previousCwd);
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.deepEqual({ ...jump, diagnostics: undefined }, {
			...lwJump,
			sourceFile: project.sourcePath,
			line: 3,
			sourceLine: "First paragraph text that should wrap a little and create boxes.",
			sidecarPath: join(project.dir, "paper.synctex"),
			branch: "js_fallback",
			diagnostics: undefined,
		});
		assert.equal(jump.diagnostics.branch, "js_fallback");
		assert.equal(Object.hasOwn(jump, "width"), false);
		assert.equal(Object.hasOwn(jump, "height"), false);
	} finally {
		process.chdir(previousCwd);
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("LaTeX-Workshop-derived syncTeXToTeX maps realistic .synctex fixture coordinates to source lines", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	const previousCwd = process.cwd();
	try {
		process.chdir(project.dir);
		const location = syncTeXToTeX(1, 144.27, 155.27, project.pdfPath);

		assert.deepEqual(location, {
			input: "main.tex",
			line: 3,
			column: 0,
		});
	} finally {
		process.chdir(previousCwd);
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("LaTeX-Workshop-derived inspectSyncTeXToTeX matches syncTeXToTeX and exposes chosen rectangle", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	const previousCwd = process.cwd();
	try {
		process.chdir(project.dir);
		const location = syncTeXToTeX(1, 144.27, 155.27, project.pdfPath);
		const inspected = inspectSyncTeXToTeX(1, 144.27, 155.27, project.pdfPath);

		assert.ok(inspected, "expected inspected reverse SyncTeX record");
		assert.deepEqual({ input: inspected.input, line: inspected.line, column: inspected.column }, location);
		assert.equal(inspected.line, 3);
		assert.equal(Number.isFinite(inspected.distanceFromCenter), true);
		assert.ok(inspected.distanceFromCenter >= 0);
		assert.ok(inspected.rect.right >= inspected.rect.left, "inspection rect should have non-negative width");
		assert.ok(inspected.rect.bottom >= inspected.rect.top, "inspection rect should have non-negative height");
	} finally {
		process.chdir(previousCwd);
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("LaTeX-Workshop SyncTeX parse cache invalidates when sidecar mtime changes without a size change", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	const previousCwd = process.cwd();
	try {
		process.chdir(project.dir);
		assert.equal(inspectSyncTeXToTeX(1, 144.27, 155.27, project.pdfPath)?.line, 3);
		const sidecarPath = join(project.dir, "paper.synctex");
		const original = readFileSync(sidecarPath, "utf8");
		const changed = original.replace(/1,3:/g, "1,9:");
		assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
		writeFileSync(sidecarPath, changed);
		const future = new Date(Date.now() + 10_000);
		utimesSync(sidecarPath, future, future);
		assert.equal(inspectSyncTeXToTeX(1, 144.27, 155.27, project.pdfPath)?.line, 9);
	} finally {
		process.chdir(previousCwd);
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX defaults to JS reverse lookup when candidate proposal scoring probes forward boxes", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		let nativeCalls = 0;
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => {
				nativeCalls += 1;
				throw new Error("native fallback should not run after JS success");
			},
		});

		assert.equal(nativeCalls > 0, true);
		assert.equal(location.sourceFile, project.sourcePath);
		assert.equal(location.line, 3);
		assert.equal(location.column, 0);
		assert.equal(location.diagnostics.branch, "js");
		assert.deepEqual(location.diagnostics.js.result, { input: "main.tex", line: 3, column: 0 });
		assert.equal(location.diagnostics.js.role, "primary");
		assert.equal(location.diagnostics.native.attempted, false);
		assert.equal(location.diagnostics.native.role, "fallback");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native reverse SyncTeX is fallback only after JS returns no result", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const nativeCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: (command, args, options) => {
				nativeCalls.push({ command, args, cwd: options.cwd });
				return {
					status: 0,
					stdout: "SyncTeX result begin\nOutput:paper.pdf\nInput:main.tex\nLine:3\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n",
					stderr: "",
				};
			},
			jsFallback: () => undefined,
		});

		assert.deepEqual(nativeCalls, [{ command: "synctex", args: ["edit", "-o", `1:144.27:155.27:${project.pdfPath}`], cwd: dirname(project.pdfPath) }]);
		assert.equal(location.diagnostics.branch, "native_fallback");
		assert.equal(location.diagnostics.js.attempted, true);
		assert.equal(location.diagnostics.js.role, "primary");
		assert.equal(location.diagnostics.js.failureReason, "no result");
		assert.equal(location.diagnostics.native.attempted, true);
		assert.equal(location.diagnostics.native.status, 0);
		assert.deepEqual(location.diagnostics.native.parsedResult, { input: "main.tex", line: 3, column: 0 });
		assert.equal(location.line, 3);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native reverse SyncTeX is fallback after JS lookup throws", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		let nativeCalls = 0;
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => {
				nativeCalls += 1;
				return {
					status: 0,
					stdout: "SyncTeX result begin\nOutput:paper.pdf\nInput:main.tex\nLine:3\nColumn:0\nSyncTeX result end\n",
					stderr: "",
				};
			},
			jsFallback: () => {
				throw new Error("JS sidecar parse failed");
			},
		});

		assert.equal(nativeCalls, 1);
		assert.equal(location.diagnostics.branch, "native_fallback");
		assert.equal(location.diagnostics.js.failureReason, "JS sidecar parse failed");
		assert.equal(location.diagnostics.native.attempted, true);
		assert.equal(location.line, 3);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("native reverse SyncTeX is not fallback after JS returns an invalid source line", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		let nativeCalls = 0;
		assert.throws(
			() => mapReverseSynctex({
				pdfPath: project.pdfPath,
				page: 1,
				x: 144.27,
				y: 155.27,
				cwd: project.dir,
				nativeRunner: () => {
					nativeCalls += 1;
					return {
						status: 0,
						stdout: "SyncTeX result begin\nOutput:paper.pdf\nInput:main.tex\nLine:3\nColumn:0\nSyncTeX result end\n",
						stderr: "",
					};
				},
				jsFallback: () => ({ input: "main.tex", line: 8737, column: 0 }),
			}),
			/outside readable source line range.*native fallback was not attempted/,
		);
		assert.equal(nativeCalls, 0);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX JS primary result is accepted before native invalid source line is considered", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		let fallbackCalls = 0;
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => ({
				status: 0,
				stdout: "SyncTeX result begin\nOutput:paper.pdf\nInput:main.tex\nLine:8737\nColumn:0\nSyncTeX result end\n",
				stderr: "",
			}),
			jsFallback: () => {
				fallbackCalls += 1;
				return { input: "main.tex", line: 3, column: 0 };
			},
		});

		assert.equal(fallbackCalls, 1);
		assert.equal(location.diagnostics.branch, "js");
		assert.equal(location.diagnostics.native.attempted, false);
		assert.deepEqual(location.diagnostics.js.result, { input: "main.tex", line: 3, column: 0 });
		assert.equal(location.line, 3);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX JS primary result is accepted before native low-quality end-document fallback", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\documentclass{article}",
			"\\begin{document}",
			"Useful equation source line",
			"\\end{document}",
		].join("\n"));

		let fallbackCalls = 0;
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => ({
				status: 0,
				stdout: "SyncTeX result begin\nOutput:paper.pdf\nInput:main.tex\nLine:4\nColumn:0\nSyncTeX result end\n",
				stderr: "",
			}),
			jsFallback: () => {
				fallbackCalls += 1;
				return { input: "main.tex", line: 3, column: 0 };
			},
		});

		assert.equal(fallbackCalls, 1);
		assert.equal(location.diagnostics.branch, "js");
		assert.equal(location.diagnostics.native.attempted, false);
		assert.equal(location.line, 3);
		assert.equal(location.sourceLine, "Useful equation source line");
		assert.deepEqual(location.diagnostics.js.result, { input: "main.tex", line: 3, column: 0 });
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX default uses LaTeX-Workshop JS parser before native no-result fallback", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		let fallbackCalls = 0;
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => ({ status: 0, stdout: "SyncTeX result begin\nSyncTeX result end\n", stderr: "" }),
			jsFallback: (page, x, y, pdfPath) => {
				fallbackCalls += 1;
				return syncTeXToTeX(page, x, y, pdfPath);
			},
		});

		assert.equal(fallbackCalls, 1);
		assert.equal(location.diagnostics.branch, "js");
		assert.equal(location.diagnostics.native.attempted, false);
		assert.equal(location.line, 3);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX keeps JS lookup semantics when formula normalization can enrich a closing line", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, Array.from({ length: 20 }, (_, index) => {
			const line = index + 1;
			if (line === 16) return "\\begin{align}";
			if (line === 17) return "  a &= b + c \\\\";
			if (line === 20) return "\\end{align}";
			return `% line ${line}`;
		}).join("\n"));
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => ({
				status: 0,
				stdout: "SyncTeX result begin\nOutput:paper.pdf\nInput:main.tex\nLine:16\nColumn:2\nSyncTeX result end\n",
				stderr: "",
			}),
			jsFallback: () => ({ input: "main.tex", line: 20, column: 0 }),
		});

		assert.equal(location.diagnostics.branch, "js");
		assert.equal(location.diagnostics.native.attempted, false);
		assert.equal(location.line, 20);
		assert.equal(location.sourceLine, "\\end{align}");
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 16, endLine: 20 });
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("selected text source range repair maps a unique partial selection with spaces", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"one",
			"alpha beta gamma",
			"omega",
		].join("\n"));

		const range = findUniqueSelectedTextSourceRange(project.sourcePath, "pha beta");

		assert.deepEqual(range, {
			sourceFile: project.sourcePath,
			startLine: 2,
			startColumn: 2,
			endLine: 2,
			endColumn: 9,
			startSourceLine: "alpha beta gamma",
			endSourceLine: "alpha beta gamma",
		});
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("selected text source range repair rejects absent and ambiguous selections", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, ["repeat", "missing", "repeat"].join("\n"));

		assert.equal(findUniqueSelectedTextSourceRange(project.sourcePath, "repeat"), undefined);
		assert.equal(findUniqueSelectedTextSourceRange(project.sourcePath, "absent"), undefined);
		assert.equal(findUniqueSelectedTextSourceRange(project.sourcePath, ""), undefined);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter returns mapped output with column 0 and current API glue fields", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 155.27, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(location.sidecarPath, join(project.dir, "paper.synctex"));
		assert.equal(location.sourceFile, project.sourcePath);
		assert.equal(location.line, 3);
		assert.equal(location.column, 0);
		assert.equal(location.sourceLine, "First paragraph text that should wrap a little and create boxes.");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter normalizes \\end{equation} to the enclosing formula span while preserving raw mapped result", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\begin{equation}",
			"  a = b + c",
			"\\end{equation}",
			"",
		].join("\n"));

		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 155.27, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(location.line, 3);
		assert.equal(location.sourceLine, "\\end{equation}");
		assert.equal(location.rawMappedSourceFile, project.sourcePath);
		assert.equal(location.rawMappedLine, 3);
		assert.equal(location.rawMappedColumn, 0);
		assert.equal(location.rawMappedSourceLine, "\\end{equation}");
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
		assert.equal(location.normalizedSourceExcerpt, "\\begin{equation}\n  a = b + c\n\\end{equation}");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter normalizes align and align* closing lines", () => {
	for (const environment of ["align", "align*"]) {
		const project = makeFixtureProject({ sidecar: "synctex" });
		try {
			writeFileSync(project.sourcePath, [
				`\\begin{${environment}}`,
				"  a &= b \\\\",
				`\\end{${environment}}`,
				"",
			].join("\n"));

			const location = mapReverseSynctex({
				pdfPath: project.pdfPath,
				page: 1,
				x: 144.27,
				y: 155.27,
				cwd: project.dir,
				nativeRunner: () => {
					throw new Error("native fallback should not be invoked after JS success");
				},
				jsFallback: () => ({ input: "main.tex", line: 3, column: 0 }),
			});

			assert.equal(location.diagnostics.branch, "js");
			assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
			assert.equal(location.normalizedSourceExcerpt, `\\begin{${environment}}\n  a &= b \\\\\n\\end{${environment}}`);
		} finally {
			rmSync(project.dir, { recursive: true, force: true });
		}
	}
});

test("reverse SyncTeX attaches the innermost minipage span to a selected closing line", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\begin{minipage}[t]{0.9\\textwidth}",
			"outer",
			"\\begin{minipage}{0.8\\linewidth}",
			"inner",
			"\\end{minipage}",
			"outer after",
			"\\end{minipage}",
		].join("\n"));
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => { throw new Error("native fallback should not be invoked after JS success"); },
			jsFallback: () => ({ input: "main.tex", line: 5, column: 0 }),
		});

		assert.equal(location.line, 5);
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 3, endLine: 5 });
		assert.equal(location.normalizedSourceExcerpt, "\\begin{minipage}{0.8\\linewidth}\ninner\n\\end{minipage}");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX maps display math delimiter lines to the formula body", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"before",
			"\\[",
			"  x^2 + y^2 = z^2",
			"\\]",
			"after",
		].join("\n"));
		const requestedLines: number[] = [];
		const jump = mapForwardSynctex({
			pdfPath: project.pdfPath,
			sourceFile: project.sourcePath,
			line: 2,
			cwd: project.dir,
			nativeRunner: failNativeRunner,
			jsFallback: (line) => {
				requestedLines.push(line);
				return { page: 1, x: 10, y: 20, width: 30, height: 4 };
			},
		});

		assert.deepEqual(requestedLines, [3]);
		assert.equal(jump.line, 3);
		assert.equal(jump.sourceLine, "  x^2 + y^2 = z^2");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter normalizes display math opener to the full formula span", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\[",
			"  x^2 + y^2 = z^2",
			"\\]",
			"",
		].join("\n"));

		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: () => { throw new Error("native fallback should not be invoked after JS success"); },
			jsFallback: () => ({ input: "main.tex", line: 1, column: 0 }),
		});

		assert.equal(location.line, 1);
		assert.equal(location.sourceLine, "\\[");
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
		assert.equal(location.normalizedSourceExcerpt, "\\[\n  x^2 + y^2 = z^2\n\\]");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter normalizes \\] to the matching display math opener", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\[",
			"  x^2 + y^2 = z^2",
			"\\]",
			"",
		].join("\n"));

		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 155.27, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
		assert.equal(location.normalizedSourceExcerpt, "\\[\n  x^2 + y^2 = z^2\n\\]");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter normalizes a standalone closing brace to its braced formula span", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\bas{\\label{eq:sample}",
			"  x + \\} + y",
			"  \\text{nested braces are balanced}",
			"}",
			"",
		].join("\n"));

		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: failNativeRunner,
			jsFallback: () => ({ input: "main.tex", line: 4, column: 0 }),
		});

		assert.equal(location.line, 4);
		assert.equal(location.sourceLine, "}");
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
		assert.equal(location.normalizedSourceExcerpt, "\\bas{\\label{eq:sample}\n  x + \\} + y\n  \\text{nested braces are balanced}");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter does not treat escaped closing braces as formula-span closes", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\bas{",
			"  x + y",
			"\\}",
			"}",
		].join("\n"));

		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: failNativeRunner,
			jsFallback: () => ({ input: "main.tex", line: 3, column: 0 }),
		});

		assert.equal(Object.hasOwn(location, "normalizedSourceSpan"), false);
		assert.equal(Object.hasOwn(location, "normalizedSourceExcerpt"), false);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter matches nested same-environment closes to the nearest opener", () => {
	const project = makeFixtureProject({ sidecar: "synctex.gz" });
	try {
		writeFileSync(project.sourcePath, [
			"\\begin{equation}",
			"outer before",
			"\\begin{equation}",
			"inner",
			"\\end{equation}",
			"outer after",
			"\\end{equation}",
		].join("\n"));

		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 167.27, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(location.line, 5);
		assert.deepEqual(location.normalizedSourceSpan, { sourceFile: project.sourcePath, startLine: 3, endLine: 5 });
		assert.equal(location.normalizedSourceExcerpt, "\\begin{equation}\ninner\n\\end{equation}");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter leaves non-formula reverse events unchanged", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 155.27, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(location.sourceLine, "First paragraph text that should wrap a little and create boxes.");
		assert.equal(Object.hasOwn(location, "rawMappedLine"), false);
		assert.equal(Object.hasOwn(location, "normalizedSourceSpan"), false);
		assert.equal(Object.hasOwn(location, "normalizedSourceExcerpt"), false);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter uses LaTeX-Workshop selection context to correct column", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: failNativeRunner,
			textBeforeSelection: "First paragraph",
			textAfterSelection: " text that should wrap a little and create boxes.",
		});

		assert.equal(location.sourceFile, project.sourcePath);
		assert.equal(location.line, 3);
		assert.equal(location.column, 6);
		assert.equal(location.sourceLine, "First paragraph text that should wrap a little and create boxes.");
		assert.equal(location.diagnostics.context.hasSelectionContext, true);
		assert.equal(location.diagnostics.context.textBeforeSelection, "First paragraph");
		assert.deepEqual(location.diagnostics.candidates.map((candidate) => candidate.kind), ["initial_candidate", "context_corrected"]);
		assert.deepEqual(location.diagnostics.selected, {
			sourceFile: project.sourcePath,
			line: 3,
			column: 6,
			sourceLine: "First paragraph text that should wrap a little and create boxes.",
			score: 0,
		});
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter leaves no-context fallback mapping unchanged", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const location = mapReverseSynctex({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: failNativeRunner,
		});

		assert.equal(location.sourceFile, project.sourcePath);
		assert.equal(location.line, 3);
		assert.equal(location.column, 0);
		assert.equal(location.diagnostics.context.hasSelectionContext, false);
		assert.deepEqual(location.diagnostics.candidates.map((candidate) => candidate.kind), ["initial_candidate"]);
		assert.deepEqual(location.diagnostics.selected, {
			sourceFile: project.sourcePath,
			line: 3,
			column: 0,
			sourceLine: "First paragraph text that should wrap a little and create boxes.",
			score: 0,
		});
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX hover without text context reports top proposal diagnostics", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		writeFileSync(project.sourcePath, [
			"\\documentclass{article}",
			"\\begin{document}",
			"\\end{document}",
			"% filler",
			"Second paragraph text on a different source line for SyncTeX mapping.",
			"\\end{document}",
		].join("\n"));

		const hover = inspectReverseSynctexHover({
			pdfPath: project.pdfPath,
			page: 1,
			x: 144.27,
			y: 155.27,
			cwd: project.dir,
			nativeRunner: failNativeRunner,
		});

		assert.equal(hover.sourceFile, project.sourcePath);
		assert.equal(hover.line, 3);
		assert.equal(hover.sourceLine, "\\end{document}");
		assert.equal(hover.precision, "line");
		assert.deepEqual(hover.repairedWinner, {
			sourceFile: project.sourcePath,
			line: 3,
			column: 0,
			sourceLine: "\\end{document}",
			precision: "line",
			score: 0,
		});
		assert.equal((hover.rawWinner as { line?: number; structural?: boolean; sourceLine?: string }).line, 3);
		assert.equal((hover.rawWinner as { line?: number; structural?: boolean; sourceLine?: string }).structural, true);
		assert.equal((hover.rawWinner as { line?: number; structural?: boolean; sourceLine?: string }).sourceLine, "\\end{document}");
		assert.ok(hover.topCandidates?.some((candidate) => (candidate as { line?: number }).line === 5));
		assert.ok(hover.topCandidates?.some((candidate) => (candidate as { line?: number }).line === 3));
		assert.equal(hover.forwardVerification, undefined);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter reads realistic .synctex.gz fixtures", () => {
	const project = makeFixtureProject({ sidecar: "synctex.gz" });
	try {
		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 167.27, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(location.sidecarPath, join(project.dir, "paper.synctex.gz"));
		assert.equal(location.sourceFile, project.sourcePath);
		assert.equal(location.line, 5);
		assert.equal(location.sourceLine, "Second paragraph text on a different source line for SyncTeX mapping.");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper reads realistic .synctex.gz fixtures", () => {
	const project = makeFixtureProject({ sidecar: "synctex.gz" });
	try {
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 5, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(jump.sidecarPath, join(project.dir, "paper.synctex.gz"));
		assert.equal(jump.sourceLine, "Second paragraph text on a different source line for SyncTeX mapping.");
		assert.equal(jump.page, 1);
		assert.equal(jump.x, 143.7309977720268);
		assert.equal(jump.y, 166.6450700011675);
		assert.equal(Object.hasOwn(jump, "width"), false);
		assert.equal(Object.hasOwn(jump, "height"), false);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper follows LaTeX-Workshop sidecar ordering when both .synctex and .synctex.gz exist", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const gzBody = readFixtureSynctex().replace("X Offset:655360", "X Offset:1310720");
		writeGzipSynctex(join(project.dir, "paper.synctex.gz"), gzBody);

		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(jump.sidecarPath, join(project.dir, "paper.synctex"));
		assert.equal(jump.x, 143.7309977720268);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper accepts symlink-equivalent source paths", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const symlinkPath = join(project.dir, "linked-main.tex");
		symlinkSync(project.sourcePath, symlinkPath);
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: symlinkPath, line: 3, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(jump.sourceFile, resolve(symlinkPath));
		assert.equal(jump.page, 1);
		assert.equal(jump.x, 143.7309977720268);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper matches encoded non-ASCII Input filenames through LaTeX-Workshop iconv path", () => {
	const dir = mkdtempSync(join(tmpdir(), "forward-synctex-encoded-"));
	const pdfPath = join(dir, "paper.pdf");
	const sourcePath = join(dir, "café.tex");
	try {
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		copyFileSync(join(FIXTURE_DIR, "main.tex"), sourcePath);
		const encodedSourcePath = iconv.encode(sourcePath, "ISO-8859-1").toString("binary");
		const body = readFixtureSynctex().replace("Input:1:main.tex", `Input:1:${encodedSourcePath}`);
		writeGzipSynctex(join(dir, "paper.synctex.gz"), body, "binary");

		const jump = mapForwardSynctex({ pdfPath, sourceFile: sourcePath, line: 3, cwd: dir, nativeRunner: failNativeRunner });

		assert.equal(jump.sidecarPath, join(dir, "paper.synctex.gz"));
		assert.equal(jump.sourceFile, sourcePath);
		assert.equal(jump.page, 1);
		assert.equal(jump.x, 143.7309977720268);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("LaTeX-Workshop forward source matching decodes binary Input paths with iconv-lite", () => {
	const dir = mkdtempSync(join(tmpdir(), "forward-synctex-iconv-"));
	const sourcePath = join(dir, "café.tex");
	try {
		writeFileSync(sourcePath, "encoded source\n");
		const encodedSourcePath = iconv.encode(sourcePath, "ISO-8859-1").toString("binary");
		const pdfSyncObject = { blockNumberLine: { [encodedSourcePath]: {} } } as PdfSyncObject;

		assert.equal(findInputFilePathForward(sourcePath, pdfSyncObject), encodedSourcePath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper resolves relative Input records against cwd for output-directory builds", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		mkdirSync(join(project.dir, "out"));
		const outPdfPath = join(project.dir, "out", "paper.pdf");
		writeFileSync(outPdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		copyFileSync(join(project.dir, "paper.synctex"), join(project.dir, "out", "paper.synctex"));
		rmSync(join(project.dir, "paper.synctex"));

		const jump = mapForwardSynctex({ pdfPath: outPdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(jump.sourceFile, project.sourcePath);
		assert.equal(jump.page, 1);
		assert.equal(jump.x, 143.7309977720268);
		assert.equal(jump.y, 154.6899018816158);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper follows LaTeX-Workshop forward selection for non-exact lines", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 4, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(jump.sourceLine, "");
		assert.equal(jump.page, 1);
		assert.equal(jump.x, 487.44208120913765);
		assert.equal(jump.y, 154.6899018816158);
		assert.equal(Object.hasOwn(jump, "width"), false);
		assert.equal(Object.hasOwn(jump, "height"), false);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper applies LaTeX-Workshop X/Y offsets from realistic SyncTeX fixtures", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir, nativeRunner: failNativeRunner });

		assert.equal(jump.x, 143.7309977720268);
		assert.equal(jump.y, 154.6899018816158);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX mapper reports missing sidecars and unmappable lines clearly", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		rmSync(join(project.dir, "paper.synctex"));
		assert.equal(resolveSynctexSidecar(project.pdfPath), undefined);
		assert.throws(
			() => mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir }),
			/missing SyncTeX sidecar/i,
		);
		copyFileSync(join(FIXTURE_DIR, "paper.synctex"), join(project.dir, "paper.synctex"));
		assert.throws(
			() => mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 12, cwd: project.dir, nativeRunner: failNativeRunner }),
			/No usable SyncTeX mapping found.*main\.tex:12/i,
		);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import * as iconv from "iconv-lite";
import { test } from "node:test";
import { findUniqueSelectedTextSourceRange, mapForwardSynctex, mapReverseForwardSynctexProbe, mapReverseSynctex, resolveSynctexSidecar } from "../../../src/modules/synctex/forward_synctex.ts";
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
		assert.ok(inspection.candidates.every((candidate, index, candidates) => index === 0 || candidate.score >= candidates[index - 1]!.score));
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

test("reverse SyncTeX candidate scoring demotes structural lines but preserves raw diagnostics", () => {
	const fixture = syntheticParsedReverseFixture(["useful", "\\end{document}"], [
		{ line: 2, left: 0, bottom: 2, width: 2, height: 2 },
		{ line: 1, left: 4, bottom: 10, width: 10, height: 10 },
	]);
	try {
		const unpenalized = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 1, 1, { minCandidates: 1, maxCandidates: 10, minDistance: 20, structuralPenalty: 0 });
		const penalized = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 1, 1, { minCandidates: 1, maxCandidates: 10, minDistance: 20, structuralPenalty: 1000 });
		assert.ok(unpenalized);
		assert.ok(penalized);
		assert.equal(unpenalized.winner.line, 2);
		assert.equal(penalized.winner.line, 1);
		assert.equal(penalized.rawWinner.line, 2);
		assert.ok(penalized.candidates.some((candidate) => candidate.line === 2 && candidate.structural && candidate.structuralReason === "\\end{document}"));
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX candidate score weights x distance twice y distance", () => {
	const fixture = syntheticParsedReverseFixture(["x-far", "y-far"], [
		{ line: 1, left: 10, bottom: 1, width: 1, height: 1 },
		{ line: 2, left: 0, bottom: 10, width: 1, height: 1 },
	]);
	try {
		const inspection = collectReverseSyncTeXCandidatesFromParsed(fixture.parsed, 1, 0, 0, { minCandidates: 1, maxCandidates: 10, minDistance: 20 });
		assert.ok(inspection);
		assert.deepEqual(inspection.candidates.map((candidate) => candidate.line), [2, 1]);
		assert.equal(inspection.candidates.find((candidate) => candidate.line === 1)?.score, 20);
		assert.equal(inspection.candidates.find((candidate) => candidate.line === 2)?.score, 9);
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
				winner: { input: sourcePath, line: 4, column: 0, sourceLine: "\\end{document}", rect: { left: 99, top: 199, right: 101, bottom: 201 }, distanceX: 0, distanceY: 0, distance: 0, area: 4, containsClick: true, structural: true, structuralReason: "\\end{document}", areaPenalty: 0, structuralPenalty: 1000, score: 1000 },
				rawWinner: { input: sourcePath, line: 4, column: 0, sourceLine: "\\end{document}", rect: { left: 99, top: 199, right: 101, bottom: 201 }, distanceX: 0, distanceY: 0, distance: 0, area: 4, containsClick: true, structural: true, structuralReason: "\\end{document}", areaPenalty: 0, structuralPenalty: 1000, score: 1000 },
				candidates: [],
			}),
			forwardBoxesForLine: ({ line }) => line === 3 ? [{ page: 2, h: 90, v: 190, W: 30, H: 20 }] : [],
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

test("robust reverse mapping uses unique text precision when forward boxes do not contain click", () => {
	const dir = mkdtempSync(join(tmpdir(), "robust-reverse-text-"));
	try {
		const pdfPath = join(dir, "paper.pdf");
		const sourcePath = join(dir, "main.tex");
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(join(dir, "paper.synctex"), "fixture");
		writeFileSync(sourcePath, ["aaa", "FIGURETWOSMALLBOX", "\\end{document}"].join("\n"));
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
		assert.equal(location.line, 2);
		assert.equal(location.precision, "text");
		assert.equal(location.rawMappedLine, 3);
		assert.equal(location.diagnostics.forwardVerification?.containsClick, false);
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
		writeFileSync(sourcePath, ["aaa", "PAGETWODISPLAYINT", "\\end{document}"].join("\n"));
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
				winner: { input: sourcePath, line: 2, column: 0, sourceLine: "PAGETWODISPLAYINT", rect: { left: 5, top: 5, right: 20, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 225, containsClick: true, structural: false, areaPenalty: 0, structuralPenalty: 0, score: 0 },
				rawWinner: { input: sourcePath, line: 2, column: 0, sourceLine: "PAGETWODISPLAYINT", rect: { left: 5, top: 5, right: 20, bottom: 20 }, distanceX: 0, distanceY: 0, distance: 0, area: 225, containsClick: true, structural: false, areaPenalty: 0, structuralPenalty: 0, score: 0 },
				candidates: [],
			}),
			forwardBoxesForLine: () => [{ page: 1, h: 5, v: 5, W: 20, H: 20 }],
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
				assert.equal(input.line, 5);
				return { page: 1, x: 90, y: 190, ranges: [{ page: 1, h: 90, v: 190, W: 20, H: 10 }], sourceFile: input.sourceFile, line: input.line, sourceLine: "Second paragraph text on a different source line for SyncTeX mapping.", sidecarPath: join(project.dir, "paper.synctex"), branch: "js_fallback", diagnostics: { branch: "js_fallback", lookupInput: { pdfPath: project.pdfPath, sourceFile: input.sourceFile, line: input.line, sidecarPath: join(project.dir, "paper.synctex") }, native: { command: "synctex", args: [], cwd: project.dir, parsedRectangles: [] }, jsFallback: { attempted: true } } };
			},
		});
		assert.deepEqual(forwardLines, [5]);
		assert.equal(probe.reverse.line, 5);
		assert.equal(probe.reverse.precision, "text");
		assert.equal(probe.forward.line, 5);
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

test("reverse SyncTeX defaults to the LaTeX-Workshop JS worker and avoids native when JS succeeds", () => {
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

		assert.equal(nativeCalls, 0);
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
		assert.deepEqual(location.normalizedFormulaSpan, { sourceFile: project.sourcePath, startLine: 16, endLine: 20 });
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
		assert.deepEqual(location.normalizedFormulaSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
		assert.equal(location.normalizedFormulaExcerpt, "\\begin{equation}\n  a = b + c\n\\end{equation}");
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
			assert.deepEqual(location.normalizedFormulaSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
			assert.equal(location.normalizedFormulaExcerpt, `\\begin{${environment}}\n  a &= b \\\\\n\\end{${environment}}`);
		} finally {
			rmSync(project.dir, { recursive: true, force: true });
		}
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

		assert.deepEqual(location.normalizedFormulaSpan, { sourceFile: project.sourcePath, startLine: 1, endLine: 3 });
		assert.equal(location.normalizedFormulaExcerpt, "\\[\n  x^2 + y^2 = z^2\n\\]");
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
		assert.deepEqual(location.normalizedFormulaSpan, { sourceFile: project.sourcePath, startLine: 3, endLine: 5 });
		assert.equal(location.normalizedFormulaExcerpt, "\\begin{equation}\ninner\n\\end{equation}");
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
		assert.equal(Object.hasOwn(location, "normalizedFormulaSpan"), false);
		assert.equal(Object.hasOwn(location, "normalizedFormulaExcerpt"), false);
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
		assert.equal(location.column, "First paragraph".length);
		assert.equal(location.sourceLine, "First paragraph text that should wrap a little and create boxes.");
		assert.equal(location.diagnostics.context.hasSelectionContext, true);
		assert.equal(location.diagnostics.context.textBeforeSelection, "First paragraph");
		assert.deepEqual(location.diagnostics.candidates.map((candidate) => candidate.kind), ["raw", "context_corrected"]);
		assert.deepEqual(location.diagnostics.selected, {
			sourceFile: project.sourcePath,
			line: 3,
			column: "First paragraph".length,
			sourceLine: "First paragraph text that should wrap a little and create boxes.",
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
		assert.deepEqual(location.diagnostics.candidates.map((candidate) => candidate.kind), ["raw"]);
		assert.deepEqual(location.diagnostics.selected, {
			sourceFile: project.sourcePath,
			line: 3,
			column: 0,
			sourceLine: "First paragraph text that should wrap a little and create boxes.",
		});
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

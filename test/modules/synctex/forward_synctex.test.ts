import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import * as iconv from "iconv-lite";
import { test } from "node:test";
import { mapForwardSynctex, mapReverseSynctex, resolveSynctexSidecar } from "../../../src/modules/synctex/forward_synctex.ts";
import { findInputFilePathForward, syncTeXToPDF, syncTeXToTeX } from "../../../src/modules/synctex/latex_workshop/worker.ts";
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

test("forward SyncTeX adapter returns LaTeX-Workshop output plus current API glue fields", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	const previousCwd = process.cwd();
	try {
		process.chdir(project.dir);
		const lwJump = syncTeXToPDF(3, project.sourcePath, project.pdfPath);
		process.chdir(previousCwd);
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir });

		assert.deepEqual(jump, {
			...lwJump,
			sourceFile: project.sourcePath,
			line: 3,
			sourceLine: "First paragraph text that should wrap a little and create boxes.",
			sidecarPath: join(project.dir, "paper.synctex"),
		});
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

test("reverse SyncTeX adapter returns LaTeX-Workshop output with column 0 and current API glue fields", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 155.27, cwd: project.dir });

		assert.equal(location.sidecarPath, join(project.dir, "paper.synctex"));
		assert.equal(location.sourceFile, project.sourcePath);
		assert.equal(location.line, 3);
		assert.equal(location.column, 0);
		assert.equal(location.sourceLine, "First paragraph text that should wrap a little and create boxes.");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX adapter reads realistic .synctex.gz fixtures", () => {
	const project = makeFixtureProject({ sidecar: "synctex.gz" });
	try {
		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 167.27, cwd: project.dir });

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
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 5, cwd: project.dir });

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

		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir });

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
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: symlinkPath, line: 3, cwd: project.dir });

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

		const jump = mapForwardSynctex({ pdfPath, sourceFile: sourcePath, line: 3, cwd: dir });

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

		const jump = mapForwardSynctex({ pdfPath: outPdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir });

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
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 4, cwd: project.dir });

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
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 3, cwd: project.dir });

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
			() => mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: project.sourcePath, line: 12, cwd: project.dir }),
			/No SyncTeX mapping found.*main\.tex:12/i,
		);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

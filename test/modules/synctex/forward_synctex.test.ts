import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { mapForwardSynctex, mapReverseSynctex, resolveSynctexSidecar } from "../../../src/modules/synctex/forward_synctex.ts";
import { syncTeXToPDF } from "../../../src/modules/synctex/latex_workshop/worker.ts";

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

test("reverse SyncTeX mapper reads realistic .synctex fixtures and maps page coordinates to source lines", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		const location = mapReverseSynctex({ pdfPath: project.pdfPath, page: 1, x: 144.27, y: 155.27, cwd: project.dir });

		assert.equal(location.sidecarPath, join(project.dir, "paper.synctex"));
		assert.equal(location.sourceFile, project.sourcePath);
		assert.equal(location.line, 3);
		assert.equal(location.column, 1);
		assert.equal(location.sourceLine, "First paragraph text that should wrap a little and create boxes.");
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
	}
});

test("reverse SyncTeX mapper reads realistic .synctex.gz fixtures", () => {
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

test("forward SyncTeX mapper accepts realpath-equivalent source paths", () => {
	const project = makeFixtureProject({ sidecar: "synctex" });
	try {
		mkdirSync(join(project.dir, "nested"));
		const equivalentPath = join(project.dir, "nested", "..", "main.tex");
		const jump = mapForwardSynctex({ pdfPath: project.pdfPath, sourceFile: equivalentPath, line: 3, cwd: project.dir });

		assert.equal(jump.sourceFile, resolve(equivalentPath));
		assert.equal(jump.page, 1);
		assert.equal(jump.x, 143.7309977720268);
	} finally {
		rmSync(project.dir, { recursive: true, force: true });
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

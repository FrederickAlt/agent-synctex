import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildLatexPreambleIndex } from "../../../src/modules/latex/latex_preamble_index.ts";

test("preamble index treats a file with documentclass in a pre-document input as the root", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "latex-preamble-index-input-root-"));
	try {
		writeFileSync(join(baseDir, "praeamble.tex"), "\\documentclass{article}\n\\newcommand{\\fromPreamble}{P}\n");
		writeFileSync(join(baseDir, "main.tex"), "% !TeX program = lualatex\n\\input{praeamble}\n\\begin{document}\nHello\n\\end{document}\n");
		writeFileSync(join(baseDir, "section.tex"), "Section body only.\n");

		const index = buildLatexPreambleIndex(baseDir);

		assert.deepEqual(index.listRoots(), [join(baseDir, "main.tex")]);
		const root = index.getRoot("main.tex");
		assert.equal(root.facts.documentClass?.name, "article");
		assert.match(root.preamble, /\\newcommand\{\\fromPreamble\}/);
		assert.doesNotMatch(root.preamble, /\\begin\{document\}/);
		assert.deepEqual(root.files, [join(baseDir, "main.tex"), join(baseDir, "praeamble.tex")]);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("preamble index does not treat a standalone preamble file as a root", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "latex-preamble-index-preamble-only-"));
	try {
		writeFileSync(join(baseDir, "praeamble.tex"), "\\documentclass{article}\n\\newcommand{\\fromPreamble}{P}\n");
		const index = buildLatexPreambleIndex(baseDir);
		assert.deepEqual(index.listRoots(), []);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("preamble index follows nested pre-document inputs while identifying roots", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "latex-preamble-index-nested-root-"));
	try {
		mkdirSync(join(baseDir, "preamble"));
		writeFileSync(join(baseDir, "preamble", "class.tex"), "\\documentclass[11pt]{amsart}\n");
		writeFileSync(join(baseDir, "praeamble.tex"), "\\input{preamble/class}\n\\usepackage{amsmath}\n");
		writeFileSync(join(baseDir, "main.tex"), "\\input{praeamble}\n\\begin{document}\nHello\n\\end{document}\n");

		const index = buildLatexPreambleIndex(baseDir);

		assert.deepEqual(index.listRoots(), [join(baseDir, "main.tex")]);
		const root = index.getRoot("main.tex");
		assert.equal(root.facts.documentClass?.name, "amsart");
		assert.deepEqual(root.facts.packages.map((pkg) => pkg.name), ["amsmath"]);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

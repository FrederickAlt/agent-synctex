import test from "node:test";
import assert from "node:assert/strict";
import { applyLatexPreamble } from "../../../src/modules/latex/latex_preamble.ts";

const SIMPLE_PREAMBLE = String.raw`\documentclass{article}`;

test("inline preamble suppresses page styles when requested", () => {
	const rendered = applyLatexPreamble("", SIMPLE_PREAMBLE, { suppressPageNumbers: true });
	assert.ok(rendered.includes(String.raw`\AtBeginDocument{\pagestyle{empty}\thispagestyle{empty}\let\ps@plain\ps@empty}`));
	assert.ok(!rendered.includes("suppressPageNumbers"));
});

test("inline preamble preserves existing document content and documentclass", () => {
	const source = `${SIMPLE_PREAMBLE}\n\\begin{document}\nThis is a test.\n\\end{document}`;
	const rendered = applyLatexPreamble(source, "", { suppressPageNumbers: true });
	assert.ok(rendered.includes("This is a test."));
	assert.ok(rendered.includes("\\documentclass"));
});

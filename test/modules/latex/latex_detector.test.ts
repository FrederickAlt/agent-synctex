import test from "node:test";
import assert from "node:assert/strict";
import { detectLatexBlocks, isPureLatexLine } from "../../../src/modules/latex/latex_detector.ts";

test("classifies obvious pure LaTeX lines", () => {
	assert.equal(isPureLatexLine(String.raw`e\in\bar\E_\out(\V_\bou).`), true);
	assert.equal(isPureLatexLine(String.raw`f(x) &= \int_0^1 x^2\,dx \\`), true);
	assert.equal(isPureLatexLine(String.raw`\frac{a+b}{\sqrt{c}} = d_i`), true);
	assert.equal(isPureLatexLine(String.raw`\section{Introduction}`), true);
});

test("does not classify ordinary prose or code as pure LaTeX", () => {
	assert.equal(isPureLatexLine("You are right to question it, but the current definition is indeed written so that no local chronology condition is imposed for"), false);
	assert.equal(isPureLatexLine("Specifically, the definition quantifies only over"), false);
	assert.equal(isPureLatexLine("const foo_bar = baz + qux;"), false);
	assert.equal(isPureLatexLine(String.raw`Run the command C:\Users\name\script.ps1 from PowerShell.`), false);
	assert.equal(isPureLatexLine("The inline formula $x_i = y$ is useful here."), false);
});

test("triggers on a consecutive display math block with multiple substantive lines", () => {
	const text = String.raw`Here is the derivation:
\[
\begin{aligned}
f(x) &= \int_0^1 x^2\,dx \\
g(x) &= \frac{x_1 + x_2}{2}
\end{aligned}
\]
That is all.`;

	const result = detectLatexBlocks(text);

	assert.equal(result.triggered, true);
	assert.equal(result.bestBlock?.startLine, 2);
	assert.equal(result.bestBlock?.endLine, 6);
	assert.ok((result.bestBlock?.latexLineCount ?? 0) >= 2);
});

test("does not trigger on one isolated display formula line", () => {
	const text = String.raw`The condition is
[
e\in\bar\E_\out(\V_\bou).
]
but the next paragraph is prose.`;

	const result = detectLatexBlocks(text);

	assert.equal(result.triggered, false);
	assert.equal(result.bestBlock?.latexLineCount, 1);
});

test("detects a later LaTeX block inside surrounding prose", () => {
	const text = String.raw`First paragraph with $x$ inline math only.
Nothing should trigger yet.

Now the model emits source:
\documentclass{article}
\usepackage{amsmath,amssymb}
\begin{document}
\[
a^2 + b^2 &= c^2 \\
\alpha + \beta &= \gamma
\]
\end{document}

Back to prose.`;

	const result = detectLatexBlocks(text);

	assert.equal(result.triggered, true);
	assert.equal(result.bestBlock?.startLine, 5);
	assert.equal(result.bestBlock?.endLine, 12);
	assert.ok(result.bestBlock?.lines.join("\n").includes(String.raw`\alpha + \beta`));
});

test("counts LaTeX fenced code blocks and ignores non-LaTeX fences", () => {
	const text = String.raw`A TypeScript fence should not count:
\`\`\`ts
const x_i = y + z;
const path = "C:\\tmp\\file";
\`\`\`

A LaTeX fence should count:
\`\`\`latex
\begin{align}
x_i &= y_i + z_i \\
A &= \{a \mid a \in S\}
\end{align}
\`\`\``.replaceAll("\\`", "`");

	const result = detectLatexBlocks(text);

	assert.equal(result.triggered, true);
	assert.equal(result.blocks.length, 1);
	assert.equal(result.bestBlock?.startLine, 9);
	assert.equal(result.bestBlock?.endLine, 12);
});

test("allows delimiters and blanks to bridge a block but breaks on prose", () => {
	const text = String.raw`[
x &= y + z
]

Here is explanatory prose that breaks the block.
[
y &= z^2
]

[
\alpha &= \beta + \gamma \\
\delta &= \epsilon + \zeta
]`;

	const result = detectLatexBlocks(text);

	assert.equal(result.triggered, true);
	assert.equal(result.blocks.map((block) => block.latexLineCount).join(","), "1,1,2");
	assert.equal(result.bestBlock?.startLine, 11);
});

test("can require more than two LaTeX lines", () => {
	const text = String.raw`\[
x &= y \\
y &= z
\]`;

	assert.equal(detectLatexBlocks(text).triggered, true);
	assert.equal(detectLatexBlocks(text, { minLatexLines: 3 }).triggered, false);
});

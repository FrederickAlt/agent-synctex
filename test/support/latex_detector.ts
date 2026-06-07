export interface LatexDetectorOptions {
	/** Number of substantive LaTeX lines needed in one contiguous block. */
	minLatexLines?: number;
	/** Blank/delimiter lines that may appear inside a LaTeX block without breaking it. */
	maxBridgeLines?: number;
}

export interface LatexLineAnalysis {
	lineNumber: number;
	text: string;
	trimmed: string;
	classification: "latex" | "delimiter" | "blank" | "prose" | "codeFence";
	score: number;
	reasons: string[];
}

export interface LatexBlock {
	startLine: number;
	endLine: number;
	latexLineCount: number;
	lines: string[];
	latexLines: LatexLineAnalysis[];
}

export interface LatexDetectionResult {
	triggered: boolean;
	blocks: LatexBlock[];
	bestBlock?: LatexBlock;
	lines: LatexLineAnalysis[];
}

interface OpenBlock {
	startLine: number;
	endLine: number;
	latexLineCount: number;
	lines: string[];
	latexLines: LatexLineAnalysis[];
	bridgesSinceLatex: number;
}

const DEFAULT_MIN_LATEX_LINES = 2;
const DEFAULT_MAX_BRIDGE_LINES = 2;

const LATEX_FENCE_LANGUAGES = new Set(["tex", "latex", "ltx", "plaintex", "bibtex"]);

const STRUCTURAL_COMMAND = /^\\(?:documentclass|usepackage|begin|end|newcommand|renewcommand|providecommand|DeclareMathOperator|def|let|title|author|date|maketitle|section|subsection|subsubsection|paragraph|item|label|ref|eqref|cite|caption|includegraphics)\b/;
const COMMAND_PATTERN = /\\(?:[A-Za-z@]+\*?|.)/g;
const COMMON_MATH_MACRO = /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|log|sin|cos|tan|min|max|argmin|argmax|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|nu|pi|rho|sigma|tau|phi|varphi|omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Omega|infty|partial|nabla|bar|hat|tilde|vec|dot|ddot|overline|underline|mathbb|mathbf|mathrm|mathcal|operatorname|left|right|bigl|bigr|Bigl|Bigr|leq|geq|neq|approx|sim|equiv|propto|in|notin|subset|subseteq|supset|supseteq|cup|cap|setminus|times|cdot|wedge|vee|forall|exists|to|mapsto|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow)\b/g;
const RELATION_PATTERN = /(=|≤|≥|≈|≠|∈|∉|⊂|⊆|⊃|⊇|→|←|↔|⇒|⇔|\\(?:leq|geq|neq|approx|sim|equiv|propto|in|notin|subset|subseteq|supset|supseteq|to|mapsto|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow)\b|[<>])/g;
const MATH_SYMBOL_PATTERN = /[\\_{}^$&=<>+\-*/|()[\],.;:≤≥≈≠∈∉⊂⊆⊃⊇→←↔⇒⇔]/g;
const DISPLAY_DELIMITER_PATTERN = /^(?:\\\[|\\\]|\\\(|\\\)|\$\$|\[|\])$/;

export function detectLatexBlocks(text: string, options: LatexDetectorOptions = {}): LatexDetectionResult {
	const minLatexLines = options.minLatexLines ?? DEFAULT_MIN_LATEX_LINES;
	const maxBridgeLines = options.maxBridgeLines ?? DEFAULT_MAX_BRIDGE_LINES;
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const analyses: LatexLineAnalysis[] = [];
	const blocks: LatexBlock[] = [];
	let block: OpenBlock | undefined;
	let fenceLanguage: string | undefined;
	let latexEnvironmentDepth = 0;

	function closeBlock(): void {
		if (!block) return;
		while (block.lines.length > 0 && isBridgeLine(block.lines[block.lines.length - 1])) {
			block.lines.pop();
			block.endLine--;
		}
		if (block.latexLineCount > 0) {
			blocks.push({
				startLine: block.startLine,
				endLine: block.endLine,
				latexLineCount: block.latexLineCount,
				lines: block.lines,
				latexLines: block.latexLines,
			});
		}
		block = undefined;
	}

	for (let i = 0; i < lines.length; i++) {
		const lineNumber = i + 1;
		const line = lines[i];
		const fenceMatch = /^\s*```\s*([A-Za-z0-9_-]*)/.exec(line);

		if (fenceMatch) {
			const analysis = makeAnalysis(lineNumber, line, "codeFence", 0, ["markdown code fence"]);
			analyses.push(analysis);

			if (fenceLanguage !== undefined) {
				if (LATEX_FENCE_LANGUAGES.has(fenceLanguage)) closeBlock();
				fenceLanguage = undefined;
				continue;
			}

			fenceLanguage = fenceMatch[1].toLowerCase();
			if (!LATEX_FENCE_LANGUAGES.has(fenceLanguage)) closeBlock();
			continue;
		}

		if (fenceLanguage !== undefined && !LATEX_FENCE_LANGUAGES.has(fenceLanguage)) {
			analyses.push(makeAnalysis(lineNumber, line, "prose", 0, ["inside non-latex code fence"]));
			continue;
		}

		const inLatexContext = fenceLanguage !== undefined || latexEnvironmentDepth > 0;
		const beforeEnvironmentDepth = latexEnvironmentDepth;
		const analysis = analyzeLatexLine(line, lineNumber, { inLatexContext });
		analyses.push(analysis);

		const begins = countMatches(line, /\\begin\s*\{[^}]+\}/g);
		const ends = countMatches(line, /\\end\s*\{[^}]+\}/g);
		latexEnvironmentDepth = Math.max(0, latexEnvironmentDepth + begins - ends);
		const bridgesBecauseEnvironment = beforeEnvironmentDepth > 0 || latexEnvironmentDepth > 0;

		if (analysis.classification === "latex") {
			addLatexLine(line, analysis);
		} else if (analysis.classification === "delimiter" || (analysis.classification === "blank" && (block || bridgesBecauseEnvironment || fenceLanguage !== undefined))) {
			addBridgeLine(line, analysis);
		} else if (bridgesBecauseEnvironment && analysis.trimmed.startsWith("%")) {
			addBridgeLine(line, analysis);
		} else {
			closeBlock();
		}
	}

	closeBlock();

	const bestBlock = blocks.reduce<LatexBlock | undefined>((best, candidate) => {
		if (!best) return candidate;
		if (candidate.latexLineCount !== best.latexLineCount) {
			return candidate.latexLineCount > best.latexLineCount ? candidate : best;
		}
		return candidate.lines.length > best.lines.length ? candidate : best;
	}, undefined);

	return {
		triggered: blocks.some((candidate) => candidate.latexLineCount >= minLatexLines),
		blocks,
		bestBlock,
		lines: analyses,
	};

	function addLatexLine(line: string, analysis: LatexLineAnalysis): void {
		if (!block) {
			block = {
				startLine: analysis.lineNumber,
				endLine: analysis.lineNumber,
				latexLineCount: 0,
				lines: [],
				latexLines: [],
				bridgesSinceLatex: 0,
			};
		}
		block.endLine = analysis.lineNumber;
		block.lines.push(line);
		block.latexLines.push(analysis);
		block.latexLineCount++;
		block.bridgesSinceLatex = 0;
	}

	function addBridgeLine(line: string, analysis: LatexLineAnalysis): void {
		if (!block) {
			block = {
				startLine: analysis.lineNumber,
				endLine: analysis.lineNumber,
				latexLineCount: 0,
				lines: [],
				latexLines: [],
				bridgesSinceLatex: 0,
			};
		}
		block.endLine = analysis.lineNumber;
		block.lines.push(line);
		if (block.latexLineCount > 0) block.bridgesSinceLatex++;
		if (block.latexLineCount > 0 && block.bridgesSinceLatex > maxBridgeLines) closeBlock();
	}
}

export function isPureLatexLine(line: string): boolean {
	return analyzeLatexLine(line, 1, { inLatexContext: false }).classification === "latex";
}

function analyzeLatexLine(line: string, lineNumber: number, context: { inLatexContext: boolean }): LatexLineAnalysis {
	const trimmed = stripMarkdownQuote(line.trim());
	const reasons: string[] = [];
	let score = 0;

	if (!trimmed) return makeAnalysis(lineNumber, line, "blank", 0, ["blank"]);
	if (DISPLAY_DELIMITER_PATTERN.test(trimmed)) return makeAnalysis(lineNumber, line, "delimiter", 0, ["display delimiter"]);

	const withoutCommands = trimmed.replace(COMMAND_PATTERN, " ");
	const longPlainWords = withoutCommands.match(/[A-Za-z]{3,}/g)?.length ?? 0;
	const proseWordCount = trimmed.match(/[A-Za-z]{2,}/g)?.length ?? 0;
	const commandCount = countMatches(trimmed, COMMAND_PATTERN);
	const commonMathMacroCount = countMatches(trimmed, COMMON_MATH_MACRO);
	const relationCount = countMatches(trimmed, RELATION_PATTERN);
	const mathSymbolCount = countMatches(trimmed, MATH_SYMBOL_PATTERN);
	const density = mathSymbolCount / Math.max(1, trimmed.length);
	const subscriptOrSuperscriptCount = countMatches(trimmed, /[_^]/g);
	const hasEnvironmentCommand = /\\(?:begin|end)\s*\{[^}]+\}/.test(trimmed);
	const hasStructuralCommand = STRUCTURAL_COMMAND.test(trimmed);
	const hasAlignment = /&/.test(trimmed) && (relationCount > 0 || /\\\\\s*$/.test(trimmed));
	const hasUnicodeMath = /[≤≥≈≠∈∉⊂⊆⊃⊇→←↔⇒⇔∑∫√∞]/.test(trimmed);
	const startsWithCommand = /^\\/.test(trimmed);
	const hasDisplayDelimiter = /(?:\\\[|\\\]|\\\(|\\\)|\$\$)/.test(trimmed);
	const hasTexLineBreak = /\\\\\s*(?:%.*)?$/.test(trimmed);
	const onlyMathishCharacters = /^[A-Za-z0-9\s\\_{}^$&=<>+\-*/|()[\],.;:'`~]+$/.test(trimmed);

	if (hasEnvironmentCommand) add(3, "environment command");
	if (hasStructuralCommand) add(3, "structural latex command");
	if (commandCount >= 2) add(2, "multiple latex commands");
	else if (commandCount === 1) add(1, "latex command");
	if (commonMathMacroCount > 0) add(Math.min(3, commonMathMacroCount), "common math macro");
	if (relationCount > 0) add(1, "math relation/operator");
	if (subscriptOrSuperscriptCount > 0) add(1, "subscript/superscript");
	if (density >= 0.18) add(1, "high latex symbol density");
	if (startsWithCommand) add(1, "starts with command");
	if (hasDisplayDelimiter) add(1, "display delimiter on line");
	if (hasAlignment) add(2, "alignment row");
	if (hasTexLineBreak) add(1, "tex line break");
	if (hasUnicodeMath) add(2, "unicode math symbol");

	if (proseWordCount >= 8 && commandCount <= 2 && !hasStructuralCommand) add(-3, "prose-like word count");
	else if (proseWordCount >= 5 && commandCount === 0 && !hasUnicodeMath) add(-2, "wordy non-command line");
	if (/[.!?]$/.test(trimmed) && proseWordCount >= 5 && commandCount <= 2) add(-1, "sentence punctuation");

	const noCommandMathLine = commandCount === 0
		&& onlyMathishCharacters
		&& longPlainWords === 0
		&& (hasAlignment || hasTexLineBreak || hasUnicodeMath || (subscriptOrSuperscriptCount > 0 && relationCount > 0));
	const commandLatexLine = commandCount > 0
		&& score >= 3
		&& (longPlainWords <= 6 || density >= 0.15 || commandCount >= 2 || hasStructuralCommand || context.inLatexContext);
	const contextLatexLine = context.inLatexContext && score >= 2 && longPlainWords <= 8;
	const classification = commandLatexLine || noCommandMathLine || contextLatexLine ? "latex" : "prose";

	return makeAnalysis(lineNumber, line, classification, score, reasons);

	function add(points: number, reason: string): void {
		score += points;
		reasons.push(`${points > 0 ? "+" : ""}${points} ${reason}`);
	}
}

function makeAnalysis(
	lineNumber: number,
	text: string,
	classification: LatexLineAnalysis["classification"],
	score: number,
	reasons: string[],
): LatexLineAnalysis {
	return { lineNumber, text, trimmed: stripMarkdownQuote(text.trim()), classification, score, reasons };
}

function stripMarkdownQuote(line: string): string {
	return line.replace(/^(?:>\s*)+/, "");
}

function countMatches(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

function isBridgeLine(line: string): boolean {
	const trimmed = stripMarkdownQuote(line.trim());
	return !trimmed || DISPLAY_DELIMITER_PATTERN.test(trimmed) || /^```/.test(trimmed);
}

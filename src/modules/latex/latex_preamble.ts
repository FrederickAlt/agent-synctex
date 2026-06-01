export const DEFAULT_SNIPPET_PREAMBLE = [
	String.raw`\documentclass{article}`,
	String.raw`\usepackage[utf8]{inputenc}`,
	String.raw`\usepackage[T1]{fontenc}`,
	String.raw`\usepackage{amsmath,amssymb,mathtools}`,
	String.raw`\usepackage{xcolor}`,
	String.raw`\pagestyle{empty}`,
].join("\n");

const INLINE_PREVIEW_SETUP = [
	String.raw`\usepackage[active,tightpage]{preview}`,
	String.raw`\setlength\PreviewBorder{8pt}`,
].join("\n");

const INLINE_PAGE_STYLE_SETUP = [
	String.raw`\makeatletter`,
	String.raw`\AtBeginDocument{\pagestyle{empty}\thispagestyle{empty}\let\ps@plain\ps@empty}`,
	String.raw`\makeatother`,
].join("\n");

function hasDocumentClass(latexSource: string): boolean {
	return /\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(latexSource);
}

function removeDocumentClass(latexSource: string): string {
	return latexSource
		.replace(/\s*\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}\s*/m, "\n")
		.trim();
}

function defaultPreambleFor(latexPreamble: string): string {
	return hasDocumentClass(latexPreamble)
		? latexPreamble
		: [DEFAULT_SNIPPET_PREAMBLE, latexPreamble].filter(Boolean).join("\n");
}

function addInlinePreviewSetup(preamble: string): string {
	if (/\\usepackage(?:\s*\[[^\]]*\])?\s*\{preview\}/.test(preamble)) return preamble;
	return [preamble, INLINE_PREVIEW_SETUP].filter(Boolean).join("\n");
}

function addInlinePageStyleSetup(preamble: string): string {
	if (/\\AtBeginDocument\s*\{[^}]*\\pagestyle\s*\{empty\}/s.test(preamble) && /\\ps@plain\b/.test(preamble)) return preamble;
	return [preamble, INLINE_PAGE_STYLE_SETUP].filter(Boolean).join("\n");
}

function wrapLatexPreviewBody(body: string): string {
	if (/\\begin\s*\{preview\}/.test(body)) return body;
	return [String.raw`\begin{preview}`, body.trim(), String.raw`\end{preview}`].join("\n");
}

function wrapDocumentBody(latexSource: string, beginDocument: RegExpExecArray): string | null {
	const documentBodyStart = beginDocument.index + beginDocument[0].length;
	const afterBegin = latexSource.slice(documentBodyStart);
	const endDocument = /\\end\s*\{document\}/.exec(afterBegin);
	if (!endDocument) return null;
	const documentBodyEnd = documentBodyStart + endDocument.index;
	return [
		latexSource.slice(0, documentBodyStart),
		"\n",
		wrapLatexPreviewBody(latexSource.slice(documentBodyStart, documentBodyEnd)),
		"\n",
		latexSource.slice(documentBodyEnd),
	].join("");
}

export function applyLatexPreamble(latexSource: string, latexPreamble: string, options: { cropToContent?: boolean; suppressPageNumbers?: boolean } = {}): string {
	const preamble = latexPreamble.trim();
	const beginDocument = /\\begin\s*\{document\}/.exec(latexSource);
	const sourceHasDocumentClass = hasDocumentClass(latexSource);
	const cropToContent = options.cropToContent === true;
	const suppressPageNumbers = options.suppressPageNumbers === true;
	const preparePreamble = (basePreamble: string): string => {
		const withCropSetup = cropToContent ? addInlinePreviewSetup(basePreamble) : basePreamble;
		return suppressPageNumbers ? addInlinePageStyleSetup(withCropSetup) : withCropSetup;
	};

	if (sourceHasDocumentClass) {
		const insertablePreamble = hasDocumentClass(preamble) ? removeDocumentClass(preamble) : preamble;
		const combinedPreamble = preparePreamble(insertablePreamble);
		if (!combinedPreamble && !cropToContent) return latexSource;
		if (!beginDocument || beginDocument.index < 0) {
			return `${latexSource.trimEnd()}\n\n${combinedPreamble}\n`;
		}

		const sourceWithPreamble = [
			latexSource.slice(0, beginDocument.index).trimEnd(),
			"",
			combinedPreamble,
			"",
			latexSource.slice(beginDocument.index).trimStart(),
		].join("\n");
		if (!cropToContent) return sourceWithPreamble;

		const adjustedBeginDocument = /\\begin\s*\{document\}/.exec(sourceWithPreamble);
		return adjustedBeginDocument ? wrapDocumentBody(sourceWithPreamble, adjustedBeginDocument) ?? sourceWithPreamble : sourceWithPreamble;
	}

	if (beginDocument && beginDocument.index >= 0) {
		const sourceWithPreamble = [
			preparePreamble(defaultPreambleFor(preamble)),
			latexSource.slice(beginDocument.index).trimStart(),
			"",
		].filter((part) => part.length > 0).join("\n");
		if (!cropToContent) return sourceWithPreamble;

		const adjustedBeginDocument = /\\begin\s*\{document\}/.exec(sourceWithPreamble);
		return adjustedBeginDocument ? wrapDocumentBody(sourceWithPreamble, adjustedBeginDocument) ?? sourceWithPreamble : sourceWithPreamble;
	}

	if (!preamble && !cropToContent && !suppressPageNumbers) return latexSource;

	return [
		preparePreamble(defaultPreambleFor(preamble)),
		String.raw`\begin{document}`,
		cropToContent ? wrapLatexPreviewBody(latexSource) : latexSource,
		String.raw`\end{document}`,
		"",
	].join("\n");
}

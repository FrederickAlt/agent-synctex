import { extname, isAbsolute, resolve, basename } from "node:path";
import { syncTeXToPDF, syncTeXToTeX, resolveLatexWorkshopSynctexSidecar } from "./latex_workshop/worker.ts";
import { readSourceLine } from "./source_line.ts";

export interface ForwardSynctexTarget {
	page: number;
	x: number;
	y: number;
	width?: number;
	height?: number;
	source_file: string;
	line: number;
}

export interface ForwardSynctexJump {
	page: number;
	x: number;
	y: number;
	indicator?: boolean;
	width?: number;
	height?: number;
	sourceFile: string;
	line: number;
	sourceLine: string;
	sidecarPath: string;
}

export interface ReverseSynctexLocation {
	page: number;
	x: number;
	y: number;
	sourceFile: string;
	line: number;
	column: number;
	sourceLine?: string;
	sidecarPath: string;
}

export function resolveSynctexSidecar(pdfPath: string): string | undefined {
	const normalizedPdfPath = resolve(pdfPath);
	const basePath = normalizedPdfPath.toLowerCase().endsWith(".pdf")
		? normalizedPdfPath.slice(0, -extname(normalizedPdfPath).length)
		: normalizedPdfPath;
	return resolveLatexWorkshopSynctexSidecar(`${basePath}.pdf`);
}

function sourcePathLabel(sourceFile: string): string {
	return basename(sourceFile) || sourceFile;
}

export function mapForwardSynctex(input: { pdfPath: string; sourceFile: string; line: number; cwd: string }): ForwardSynctexJump {
	if (!Number.isInteger(input.line) || input.line < 1) {
		throw new Error("line must be a positive integer");
	}
	const pdfPath = resolve(input.pdfPath);
	const sidecarPath = resolveSynctexSidecar(pdfPath);
	if (sidecarPath === undefined) {
		throw new Error(`PDF ${pdfPath} is missing SyncTeX sidecar (${pdfPath.replace(/\.pdf$/i, "")}.synctex or .synctex.gz)`);
	}

	const sourceFile = isAbsolute(input.sourceFile) ? resolve(input.sourceFile) : resolve(input.cwd, input.sourceFile);
	const sourceLine = readSourceLine(sourceFile, input.line, input.cwd);
	if (sourceLine === undefined) {
		throw new Error(`Cannot read source_file line ${sourceFile}:${input.line}`);
	}

	let mapped;
	const previousCwd = process.cwd();
	try {
		process.chdir(input.cwd);
		mapped = syncTeXToPDF(input.line, sourceFile, pdfPath);
	} catch {
		mapped = undefined;
	} finally {
		process.chdir(previousCwd);
	}
	if (mapped === undefined) {
		throw new Error(`No SyncTeX mapping found for ${sourcePathLabel(sourceFile)}:${input.line}`);
	}

	return {
		page: mapped.page,
		x: mapped.x,
		y: mapped.y,
		...(mapped.indicator === undefined ? {} : { indicator: mapped.indicator }),
		sourceFile,
		line: input.line,
		sourceLine,
		sidecarPath,
	};
}

export function mapReverseSynctex(input: {
	pdfPath: string;
	page: number;
	x: number;
	y: number;
	cwd: string;
}): ReverseSynctexLocation {
	if (!Number.isInteger(input.page) || input.page < 1) {
		throw new Error("page must be a positive integer");
	}
	if (!Number.isFinite(input.x) || input.x < 0 || !Number.isFinite(input.y) || input.y < 0) {
		throw new Error("x and y must be non-negative finite numbers");
	}
	const pdfPath = resolve(input.pdfPath);
	const sidecarPath = resolveSynctexSidecar(pdfPath);
	if (sidecarPath === undefined) {
		throw new Error(`PDF ${pdfPath} is missing SyncTeX sidecar (${pdfPath.replace(/\.pdf$/i, "")}.synctex or .synctex.gz)`);
	}

	let mapped;
	const previousCwd = process.cwd();
	try {
		process.chdir(input.cwd);
		mapped = syncTeXToTeX(input.page, input.x, input.y, pdfPath);
	} catch {
		mapped = undefined;
	} finally {
		process.chdir(previousCwd);
	}
	if (mapped === undefined) {
		throw new Error(`No SyncTeX mapping found for page ${input.page} at ${input.x},${input.y}`);
	}

	const sourceFile = isAbsolute(mapped.input) ? resolve(mapped.input) : resolve(input.cwd, mapped.input);
	const sourceLine = readSourceLine(sourceFile, mapped.line, input.cwd);
	return {
		page: input.page,
		x: input.x,
		y: input.y,
		sourceFile,
		line: mapped.line,
		column: mapped.column,
		...(sourceLine === undefined ? {} : { sourceLine }),
		sidecarPath,
	};
}

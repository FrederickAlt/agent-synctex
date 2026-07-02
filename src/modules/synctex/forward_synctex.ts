import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { inspectSyncTeXToTeXCandidates, syncTeXToPDF, syncTeXToTeX, resolveLatexWorkshopSynctexSidecar, type ReverseSyncTeXCandidate, type ReverseSyncTeXCandidatesInspection } from "./latex_workshop/worker.ts";
import { lineColumnForSourceIndex } from "./source_index.ts";
import { readSourceLine } from "./source_line.ts";
import { buildSourceSearchFragments, filterForwardBoxes, findSourceTextMatches, selectForwardVerifiedSourceMatch, type SourceTextMatchResult } from "./text_repair.ts";

export interface ForwardSynctexTarget {
	page: number;
	x: number;
	y: number;
	width?: number;
	height?: number;
	source_file: string;
	line: number;
}

export type ForwardSynctexBranch = "native" | "js_fallback";
export type ReverseSynctexBranch = "js" | "native_fallback";
export type ReverseSynctexPrecision = "verified" | "text" | "line" | "raw";

export interface ForwardSynctexJump {
	page: number;
	x: number;
	y: number;
	indicator?: boolean;
	width?: number;
	height?: number;
	ranges?: ForwardSynctexRange[];
	sourceFile: string;
	line: number;
	sourceLine: string;
	sidecarPath: string;
	branch: ForwardSynctexBranch;
	diagnostics: ForwardSynctexDiagnostics;
}

export interface ForwardSynctexRange {
	page: number;
	h: number;
	v: number;
	W: number;
	H: number;
}

export interface ForwardSynctexDiagnostics {
	branch: ForwardSynctexBranch;
	lookupInput: {
		pdfPath: string;
		sourceFile: string;
		line: number;
		sidecarPath: string;
	};
	native: {
		command: string;
		args: string[];
		cwd: string;
		status?: number | null;
		stdout?: string;
		stderr?: string;
		error?: string;
		failureReason?: string;
		parsedPoint?: ForwardSynctexPoint;
		parsedRectangles: ForwardSynctexRange[];
	};
	jsFallback?: {
		attempted: boolean;
		point?: ForwardSynctexPoint;
		failureReason?: string;
	};
}

export interface NativeSynctexRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export type NativeSynctexRunner = (command: string, args: string[], options: { cwd: string }) => NativeSynctexRunResult;
export interface ReverseSynctexMappedResult {
	input: string;
	line: number;
	column: number;
}
export interface ForwardSynctexPoint {
	page: number;
	x: number;
	y: number;
	indicator?: boolean;
	width?: number;
	height?: number;
	ranges?: ForwardSynctexRange[];
}
export type ForwardSynctexJsFallback = (line: number, sourceFile: string, pdfPath: string) => ForwardSynctexPoint | undefined;
export type ReverseSynctexJsFallback = (page: number, x: number, y: number, pdfPath: string) => ReverseSynctexMappedResult | undefined;
export type ReverseSynctexCandidateInspector = (page: number, x: number, y: number, pdfPath: string) => ReverseSyncTeXCandidatesInspection | undefined;
export type ReverseSynctexForwardBoxesForLine = (input: { sourceFile: string; line: number; pdfPath: string; cwd: string }) => ForwardSynctexRange[];

export interface SelectedTextSourceRange {
	sourceFile: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	startSourceLine?: string;
	endSourceLine?: string;
}

export interface MapForwardSynctexInput {
	pdfPath: string;
	sourceFile: string;
	line: number;
	cwd: string;
	nativeRunner?: NativeSynctexRunner;
	jsFallback?: ForwardSynctexJsFallback;
	synctexCommand?: string;
}

export interface ReverseForwardSynctexProbe {
	reverse: ReverseSynctexHoverInspection;
	forward: ForwardSynctexJump;
}

export interface ReverseForwardSynctexProbeInput {
	pdfPath: string;
	page: number;
	x: number;
	y: number;
	cwd: string;
	textBeforeSelection?: string;
	textAfterSelection?: string;
	nativeRunner?: NativeSynctexRunner;
	forwardJsFallback?: ForwardSynctexJsFallback;
	synctexCommand?: string;
	inspectReverse?: (input: { pdfPath: string; page: number; x: number; y: number; cwd: string }) => ReverseSynctexHoverInspection;
	mapForward?: (input: MapForwardSynctexInput) => ForwardSynctexJump;
}

export interface ReverseSynctexFormulaSpan {
	sourceFile: string;
	startLine: number;
	endLine: number;
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
	precision: ReverseSynctexPrecision;
	rawMappedSourceFile?: string;
	rawMappedLine?: number;
	rawMappedColumn?: number;
	rawMappedSourceLine?: string;
	normalizedFormulaSpan?: ReverseSynctexFormulaSpan;
	normalizedFormulaExcerpt?: string;
	diagnostics: ReverseSynctexDiagnostics;
}

export interface ReverseSynctexHoverInspection {
	page: number;
	x: number;
	y: number;
	sourceFile: string;
	line: number;
	column: number;
	sourceLine?: string;
	sidecarPath: string;
	precision?: ReverseSynctexPrecision;
	rawWinner?: unknown;
	topCandidates?: unknown[];
	repairedWinner?: { sourceFile: string; line: number; column: number; sourceLine?: string; precision: ReverseSynctexPrecision };
	forwardVerification?: ReverseSynctexDiagnostics["forwardVerification"];
	rect: { left: number; top: number; right: number; bottom: number };
	distanceFromCenter: number;
}

export interface ReverseSynctexDiagnostics {
	branch: ReverseSynctexBranch;
	lookupInput: {
		pdfPath: string;
		page: number;
		x: number;
		y: number;
		sidecarPath: string;
	};
	native: {
		command: string;
		args: string[];
		cwd: string;
		attempted: boolean;
		role: "fallback";
		status?: number | null;
		stdout?: string;
		stderr?: string;
		error?: string;
		failureReason?: string;
		parsedResult?: ReverseSynctexMappedResult;
	};
	js: {
		attempted: boolean;
		role: "primary";
		result?: ReverseSynctexMappedResult;
		failureReason?: string;
	};
	context: {
		hasSelectionContext: boolean;
		textBeforeSelection?: string;
		textAfterSelection?: string;
	};
	candidates: Array<{
		sourceFile: string;
		line: number;
		column: number;
		sourceLine?: string;
		kind: "raw" | "context_corrected" | "formula_normalized";
	}>;
	selected: {
		sourceFile: string;
		line: number;
		column: number;
		sourceLine?: string;
	};
	precision?: ReverseSynctexPrecision;
	rawWinner?: unknown;
	topCandidates?: unknown[];
	textRepair?: {
		used: boolean;
		status: SourceTextMatchResult["status"];
		fragmentsTried: string[];
		matchCount: number;
		selectedFragment?: string;
		line?: number;
		column?: number;
	};
	forwardVerification?: {
		attempted: boolean;
		boxesConsidered: number;
		boxesFiltered: number;
		chosenBox?: ForwardSynctexRange;
		containsClick: boolean;
	};
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

export const defaultNativeSynctexRunner: NativeSynctexRunner = (command, args, options) => {
	const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error instanceof Error ? { error: result.error } : {}),
	};
};

interface NativeForwardRecord {
	page?: number;
	x?: number;
	y?: number;
	h?: number;
	v?: number;
	W?: number;
	H?: number;
}

function completeRange(record: NativeForwardRecord): ForwardSynctexRange | undefined {
	if (record.page === undefined || record.h === undefined || record.v === undefined || record.W === undefined || record.H === undefined) return undefined;
	return { page: record.page, h: record.h, v: record.v, W: record.W, H: record.H };
}

function parseNativeForwardResult(stdout: string): ForwardSynctexPoint | undefined {
	const records: NativeForwardRecord[] = [];
	let started = false;
	let activeRecord: NativeForwardRecord | undefined;

	function currentRecord(): NativeForwardRecord {
		activeRecord ??= {};
		return activeRecord;
	}

	function flushRecord(): void {
		if (activeRecord !== undefined && Object.keys(activeRecord).length > 0) {
			records.push(activeRecord);
		}
		activeRecord = undefined;
	}

	for (const line of stdout.split("\n")) {
		if (line.includes("SyncTeX result begin")) {
			started = true;
			continue;
		}
		if (line.includes("SyncTeX result end")) {
			break;
		}
		if (!started) continue;
		const pos = line.indexOf(":");
		if (pos < 0) continue;
		const rawKey = line.substring(0, pos).trim();
		const key = rawKey.toLowerCase();
		if (key === "output") {
			flushRecord();
			activeRecord = {};
			continue;
		}
		const value = Number(line.substring(pos + 1));
		if (!Number.isFinite(value)) continue;
		const record = currentRecord();
		if (key === "page") record.page = value;
		else if (key === "x") record.x = value;
		else if (key === "y") record.y = value;
		else if (key === "h") {
			if (rawKey === "H") record.H = value;
			else record.h = value;
		} else if (key === "v") record.v = value;
		else if (key === "w") record.W = value;
	}
	flushRecord();

	const ranges = records.map(completeRange).filter((range): range is ForwardSynctexRange => range !== undefined);
	if (ranges.length > 0) {
		const primaryRecord = records.find((record) => completeRange(record) !== undefined);
		const primaryRange = ranges[0];
		return {
			page: primaryRecord?.page ?? primaryRange.page,
			x: primaryRecord?.x ?? primaryRange.h,
			y: primaryRecord?.y ?? primaryRange.v,
			indicator: true,
			ranges,
		};
	}
	const pointRecord = records.find((record) => record.page !== undefined && record.x !== undefined && record.y !== undefined);
	if (pointRecord === undefined || pointRecord.page === undefined || pointRecord.x === undefined || pointRecord.y === undefined) return undefined;
	return { page: pointRecord.page, x: pointRecord.x, y: pointRecord.y, indicator: true };
}

function runNativeForwardSynctex(input: { line: number; sourceFile: string; pdfPath: string; runner: NativeSynctexRunner; command: string }): { mapped?: ForwardSynctexPoint; failureReason?: string; diagnostics: ForwardSynctexDiagnostics["native"] } {
	const args = ["view", "-i", `${input.line}:1:${input.sourceFile}`, "-o", input.pdfPath];
	const cwd = dirname(input.pdfPath);
	const result = input.runner(input.command, args, { cwd });
	const mapped = result.status === 0 && result.error === undefined ? parseNativeForwardResult(result.stdout) : undefined;
	const failureReason = result.error !== undefined
		? result.error.message
		: result.status !== 0
			? `exit status ${String(result.status)}${result.stderr ? `: ${result.stderr.trim()}` : ""}`
			: mapped === undefined ? "no usable result" : undefined;
	return {
		...(mapped === undefined ? {} : { mapped }),
		...(failureReason === undefined ? {} : { failureReason }),
		diagnostics: {
			command: input.command,
			args,
			cwd,
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			...(result.error === undefined ? {} : { error: result.error.message }),
			...(failureReason === undefined ? {} : { failureReason }),
			...(mapped === undefined ? {} : { parsedPoint: mapped }),
			parsedRectangles: mapped?.ranges ?? [],
		},
	};
}

function buildForwardDiagnostics(input: {
	branch: ForwardSynctexBranch;
	pdfPath: string;
	sourceFile: string;
	line: number;
	sidecarPath: string;
	native: ForwardSynctexDiagnostics["native"];
	jsFallback?: ForwardSynctexDiagnostics["jsFallback"];
}): ForwardSynctexDiagnostics {
	return {
		branch: input.branch,
		lookupInput: {
			pdfPath: input.pdfPath,
			sourceFile: input.sourceFile,
			line: input.line,
			sidecarPath: input.sidecarPath,
		},
		native: input.native,
		...(input.jsFallback === undefined ? {} : { jsFallback: input.jsFallback }),
	};
}

function withForwardGlue(input: { mapped: ForwardSynctexPoint; branch: ForwardSynctexBranch; sourceFile: string; line: number; sourceLine: string; sidecarPath: string; diagnostics: ForwardSynctexDiagnostics }): ForwardSynctexJump {
	return {
		page: input.mapped.page,
		x: input.mapped.x,
		y: input.mapped.y,
		...(input.mapped.indicator === undefined ? {} : { indicator: input.mapped.indicator }),
		...(input.mapped.width === undefined ? {} : { width: input.mapped.width }),
		...(input.mapped.height === undefined ? {} : { height: input.mapped.height }),
		...(input.mapped.ranges === undefined ? {} : { ranges: input.mapped.ranges }),
		sourceFile: input.sourceFile,
		line: input.line,
		sourceLine: input.sourceLine,
		sidecarPath: input.sidecarPath,
		branch: input.branch,
		diagnostics: input.diagnostics,
	};
}

export function mapReverseForwardSynctexProbe(input: ReverseForwardSynctexProbeInput): ReverseForwardSynctexProbe {
	const mapForward = input.mapForward ?? mapForwardSynctex;
	const reverse = input.inspectReverse === undefined
		? reverseLocationToHoverInspection(mapReverseSynctex({
			pdfPath: input.pdfPath,
			page: input.page,
			x: input.x,
			y: input.y,
			cwd: input.cwd,
			...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }),
			...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }),
			...(input.nativeRunner === undefined ? {} : { nativeRunner: input.nativeRunner }),
			...(input.synctexCommand === undefined ? {} : { synctexCommand: input.synctexCommand }),
		}))
		: input.inspectReverse({ pdfPath: input.pdfPath, page: input.page, x: input.x, y: input.y, cwd: input.cwd });
	const mappedForward = mapForward({
		pdfPath: input.pdfPath,
		sourceFile: reverse.sourceFile,
		line: reverse.line,
		cwd: input.cwd,
		...(input.nativeRunner === undefined ? {} : { nativeRunner: input.nativeRunner }),
		...(input.forwardJsFallback === undefined ? {} : { jsFallback: input.forwardJsFallback }),
		...(input.synctexCommand === undefined ? {} : { synctexCommand: input.synctexCommand }),
	});
	const filtered = mappedForward.ranges === undefined ? undefined : filterForwardBoxes(mappedForward.ranges, { page: input.page, x: input.x, y: input.y });
	const chosenBox = filtered?.chosenBox;
	const forward = filtered === undefined || chosenBox === undefined ? mappedForward : {
		...mappedForward,
		page: chosenBox.page,
		x: chosenBox.h,
		y: chosenBox.v,
		width: chosenBox.W,
		height: chosenBox.H,
		ranges: filtered.boxes,
	};
	return { reverse, forward };
}

export function mapForwardSynctex(input: MapForwardSynctexInput): ForwardSynctexJump {
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

	const native = runNativeForwardSynctex({
		line: input.line,
		sourceFile,
		pdfPath,
		runner: input.nativeRunner ?? defaultNativeSynctexRunner,
		command: input.synctexCommand ?? "synctex",
	});
	if (native.mapped !== undefined) {
		const diagnostics = buildForwardDiagnostics({ branch: "native", pdfPath, sourceFile, line: input.line, sidecarPath, native: native.diagnostics });
		return withForwardGlue({ mapped: native.mapped, branch: "native", sourceFile, line: input.line, sourceLine, sidecarPath, diagnostics });
	}

	let mapped;
	let jsFailureReason: string | undefined;
	const previousCwd = process.cwd();
	try {
		process.chdir(input.cwd);
		mapped = (input.jsFallback ?? syncTeXToPDF)(input.line, sourceFile, pdfPath);
		if (mapped === undefined) jsFailureReason = "no result";
	} catch (error) {
		mapped = undefined;
		jsFailureReason = error instanceof Error ? error.message : String(error);
	} finally {
		process.chdir(previousCwd);
	}
	const jsFallback = {
		attempted: true,
		...(mapped === undefined ? {} : { point: mapped }),
		...(jsFailureReason === undefined ? {} : { failureReason: jsFailureReason }),
	};
	if (mapped === undefined) {
		throw new Error(`No usable SyncTeX mapping found for ${sourcePathLabel(sourceFile)}:${input.line}; native synctex view returned ${native.failureReason ?? "no usable result"}; JS fallback returned no result`);
	}

	const diagnostics = buildForwardDiagnostics({ branch: "js_fallback", pdfPath, sourceFile, line: input.line, sidecarPath, native: native.diagnostics, jsFallback });
	return withForwardGlue({ mapped, branch: "js_fallback", sourceFile, line: input.line, sourceLine, sidecarPath, diagnostics });
}

function indexes(source: string, find: string): number[] {
	const result: number[] = [];
	for (let i = 0; i < source.length; ++i) {
		if (source.substring(i, i + find.length) === find) {
			result.push(i);
		}
	}
	return result;
}

function getColumnBySurroundingText(line: string, textBeforeSelectionFull: string, textAfterSelectionFull: string): number | null {
	let previousColumnMatches = Object.create(null) as { [k: string]: number };

	for (let length = 5; length <= Math.max(textBeforeSelectionFull.length, textAfterSelectionFull.length); length++) {
		const columns: number[] = [];
		const textBeforeSelection = textBeforeSelectionFull.substring(textBeforeSelectionFull.length - length, textBeforeSelectionFull.length);
		const textAfterSelection = textAfterSelectionFull.substring(0, length);

		if (textBeforeSelection !== "") {
			columns.push(...indexes(line, textBeforeSelection).map((index) => index + textBeforeSelection.length));
		}
		if (textAfterSelection !== "") {
			columns.push(...indexes(line, textAfterSelection));
		}

		const columnMatches = Object.create(null) as { [k: string]: number };
		columns.forEach((column) => columnMatches[column] = (columnMatches[column] || 0) + 1);
		const values = Object.values(columnMatches).sort();

		if (values.length > 1 && values[0] === values[1]) {
			previousColumnMatches = columnMatches;
			continue;
		}
		if (values.length >= 1) {
			return parseInt(Object.keys(columnMatches).reduce((a, b) => columnMatches[a] > columnMatches[b] ? a : b));
		}
		if (Object.keys(previousColumnMatches).length > 0) {
			return parseInt(Object.keys(previousColumnMatches).reduce((a, b) => previousColumnMatches[a] > previousColumnMatches[b] ? a : b));
		} else {
			return null;
		}
	}
	return null;
}

function getRowAndColumn(lines: string[], row: number, textBeforeSelectionFull: string, textAfterSelectionFull: string): [number, number] {
	let tempCol = getColumnBySurroundingText(lines[row] ?? "", textBeforeSelectionFull, textAfterSelectionFull);
	if (tempCol !== null) {
		return [row, tempCol];
	}

	if (row - 1 >= 0) {
		tempCol = getColumnBySurroundingText(lines[row - 1] ?? "", textBeforeSelectionFull, textAfterSelectionFull);
		if (tempCol !== null) {
			return [row - 1, tempCol];
		}
	}

	if (row + 1 < lines.length) {
		tempCol = getColumnBySurroundingText(lines[row + 1] ?? "", textBeforeSelectionFull, textAfterSelectionFull);
		if (tempCol !== null) {
			return [row + 1, tempCol];
		}
	}

	return [row, 0];
}

function readSourceText(sourceFile: string): string | undefined {
	try {
		return readFileSync(sourceFile, "utf8");
	} catch {
		return undefined;
	}
}

function readSourceLines(sourceFile: string): string[] | undefined {
	return readSourceText(sourceFile)?.split(/\r?\n/);
}

function resolveReverseMappedSourceFile(mapped: ReverseSynctexMappedResult, cwd: string): string {
	return isAbsolute(mapped.input) ? resolve(mapped.input) : resolve(cwd, mapped.input);
}

function candidateToMapped(candidate: ReverseSyncTeXCandidate): ReverseSynctexMappedResult {
	return { input: candidate.input, line: candidate.line, column: candidate.column };
}

function compactReverseCandidate(candidate: ReverseSyncTeXCandidate): unknown {
	return {
		sourceFile: candidate.input,
		line: candidate.line,
		column: candidate.column,
		...(candidate.sourceLine === undefined ? {} : { sourceLine: candidate.sourceLine }),
		rect: candidate.rect,
		distanceX: candidate.distanceX,
		distanceY: candidate.distanceY,
		distance: candidate.distance,
		containsClick: candidate.containsClick,
		structural: candidate.structural,
		...(candidate.structuralReason === undefined ? {} : { structuralReason: candidate.structuralReason }),
		score: candidate.score,
	};
}

function forwardBoxesForSourceLine(input: { sourceFile: string; line: number; pdfPath: string; cwd: string; nativeRunner?: NativeSynctexRunner; forwardBoxesForLine?: ReverseSynctexForwardBoxesForLine; synctexCommand?: string }): ForwardSynctexRange[] {
	if (input.forwardBoxesForLine !== undefined) return input.forwardBoxesForLine(input);
	try {
		const forward = mapForwardSynctex({
			pdfPath: input.pdfPath,
			sourceFile: input.sourceFile,
			line: input.line,
			cwd: input.cwd,
			...(input.nativeRunner === undefined ? {} : { nativeRunner: input.nativeRunner }),
			...(input.synctexCommand === undefined ? {} : { synctexCommand: input.synctexCommand }),
		});
		if (forward.ranges !== undefined && forward.ranges.length > 0) return forward.ranges;
		if (forward.width !== undefined && forward.height !== undefined) return [{ page: forward.page, h: forward.x, v: forward.y, W: forward.width, H: forward.height }];
		return [];
	} catch {
		return [];
	}
}

function invalidReadableSourceLineReason(mapped: ReverseSynctexMappedResult, cwd: string): string | undefined {
	if (!Number.isInteger(mapped.line) || mapped.line < 1) return `mapped line ${mapped.line} is outside readable source line range`;
	const sourceLines = readSourceLines(resolveReverseMappedSourceFile(mapped, cwd));
	if (sourceLines === undefined) return undefined;
	if (mapped.line > sourceLines.length) return `mapped line ${mapped.line} is outside readable source line range 1-${sourceLines.length}`;
	return undefined;
}

function lowQualityNativeReverseSourceLineReason(mapped: ReverseSynctexMappedResult, cwd: string): string | undefined {
	const sourceLine = readSourceLine(resolveReverseMappedSourceFile(mapped, cwd), mapped.line, cwd);
	if (sourceLine?.trim() === "\\end{document}") return "native result is low-quality/end-document";
	return undefined;
}

export function findUniqueSelectedTextSourceRange(sourceFile: string, selectedText: string): SelectedTextSourceRange | undefined {
	if (selectedText.length === 0) return undefined;
	const source = readSourceText(sourceFile);
	if (source === undefined) return undefined;
	const firstIndex = source.indexOf(selectedText);
	if (firstIndex < 0) return undefined;
	if (source.indexOf(selectedText, firstIndex + 1) >= 0) return undefined;
	const lastIndex = firstIndex + selectedText.length - 1;
	const start = lineColumnForSourceIndex(source, firstIndex);
	const end = lineColumnForSourceIndex(source, lastIndex);
	const sourceLines = source.split(/\r?\n/);
	return {
		sourceFile,
		startLine: start.line,
		startColumn: start.column,
		endLine: end.line,
		endColumn: end.column,
		...(sourceLines[start.line - 1] === undefined ? {} : { startSourceLine: sourceLines[start.line - 1] }),
		...(sourceLines[end.line - 1] === undefined ? {} : { endSourceLine: sourceLines[end.line - 1] }),
	};
}

const FORMULA_ENVIRONMENTS = new Set([
	"equation",
	"equation*",
	"align",
	"align*",
	"aligned",
	"aligned*",
	"alignedat",
	"alignedat*",
	"gather",
	"gather*",
	"multline",
	"multline*",
	"flalign",
	"flalign*",
	"split",
]);

function formulaEnvironmentClose(line: string): string | undefined {
	const match = line.trim().match(/^\\end\{([^}]+)\}\s*$/);
	if (match?.[1] === undefined || !FORMULA_ENVIRONMENTS.has(match[1])) return undefined;
	return match[1];
}

function formulaEnvironmentToken(line: string, environment: string): "begin" | "end" | undefined {
	const escaped = environment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = line.trim().match(new RegExp(`^\\\\(begin|end)\\{${escaped}\\}\\s*$`));
	return match?.[1] === "begin" || match?.[1] === "end" ? match[1] : undefined;
}

function findFormulaEnvironmentSpan(lines: string[], closeLineIndex: number, environment: string): { startLine: number; endLine: number; excerpt: string } | undefined {
	let depth = 0;
	for (let index = closeLineIndex; index >= 0; index -= 1) {
		const token = formulaEnvironmentToken(lines[index] ?? "", environment);
		if (token === "end") depth += 1;
		else if (token === "begin") {
			depth -= 1;
			if (depth === 0) {
				return { startLine: index + 1, endLine: closeLineIndex + 1, excerpt: lines.slice(index, closeLineIndex + 1).join("\n") };
			}
		}
	}
	return undefined;
}

function findDisplayMathSpan(lines: string[], closeLineIndex: number): { startLine: number; endLine: number; excerpt: string } | undefined {
	let depth = 0;
	for (let index = closeLineIndex; index >= 0; index -= 1) {
		const trimmed = (lines[index] ?? "").trim();
		if (trimmed === "\\]") depth += 1;
		else if (trimmed === "\\[") {
			depth -= 1;
			if (depth === 0) return { startLine: index + 1, endLine: closeLineIndex + 1, excerpt: lines.slice(index, closeLineIndex + 1).join("\n") };
		}
	}
	return undefined;
}

function normalizeFormulaClosingSpan(sourceFile: string, line: number, sourceLines: string[] | undefined): { span: ReverseSynctexFormulaSpan; excerpt: string } | undefined {
	if (sourceLines === undefined) return undefined;
	const closeLineIndex = line - 1;
	const sourceLine = sourceLines[closeLineIndex];
	if (sourceLine === undefined) return undefined;
	const environment = formulaEnvironmentClose(sourceLine);
	const span = environment === undefined
		? sourceLine.trim() === "\\]" ? findDisplayMathSpan(sourceLines, closeLineIndex) : undefined
		: findFormulaEnvironmentSpan(sourceLines, closeLineIndex, environment);
	if (span === undefined) return undefined;
	return { span: { sourceFile, startLine: span.startLine, endLine: span.endLine }, excerpt: span.excerpt };
}

function parseNativeReverseResult(stdout: string): ReverseSynctexMappedResult | undefined {
	let started = false;
	let input: string | undefined;
	let line: number | undefined;
	let column: number | undefined;
	for (const outputLine of stdout.split("\n")) {
		if (outputLine.includes("SyncTeX result begin")) {
			started = true;
			continue;
		}
		if (outputLine.includes("SyncTeX result end")) break;
		if (!started) continue;
		const pos = outputLine.indexOf(":");
		if (pos < 0) continue;
		const key = outputLine.substring(0, pos).trim().toLowerCase();
		const value = outputLine.substring(pos + 1).trim();
		if (key === "input" && value !== "") input = value;
		else if (key === "line") {
			const parsed = Number(value);
			if (Number.isInteger(parsed) && parsed > 0) line = parsed;
		} else if (key === "column") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) column = Math.max(0, Math.trunc(parsed));
		}
	}
	if (input === undefined || line === undefined) return undefined;
	return { input, line, column: column ?? 0 };
}

function runNativeReverseSynctex(input: { page: number; x: number; y: number; pdfPath: string; runner: NativeSynctexRunner; command: string }): { mapped?: ReverseSynctexMappedResult; failureReason?: string; diagnostics: ReverseSynctexDiagnostics["native"] } {
	const args = ["edit", "-o", `${input.page}:${input.x}:${input.y}:${input.pdfPath}`];
	const cwd = dirname(input.pdfPath);
	const result = input.runner(input.command, args, { cwd });
	const mapped = result.status === 0 && result.error === undefined ? parseNativeReverseResult(result.stdout) : undefined;
	const failureReason = result.error !== undefined
		? result.error.message
		: result.status !== 0
			? `exit status ${String(result.status)}${result.stderr ? `: ${result.stderr.trim()}` : ""}`
			: mapped === undefined ? "no usable result" : undefined;
	return {
		...(mapped === undefined ? {} : { mapped }),
		...(failureReason === undefined ? {} : { failureReason }),
		diagnostics: {
			command: input.command,
			args,
			cwd,
			attempted: true,
			role: "fallback",
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			...(result.error === undefined ? {} : { error: result.error.message }),
			...(failureReason === undefined ? {} : { failureReason }),
			...(mapped === undefined ? {} : { parsedResult: mapped }),
		},
	};
}

function rectFromDiagnostics(diagnostics: ReverseSynctexDiagnostics): { left: number; top: number; right: number; bottom: number } {
	const rawWinner = diagnostics.rawWinner;
	if (typeof rawWinner === "object" && rawWinner !== null && "rect" in rawWinner) {
		const rect = (rawWinner as { rect?: { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown } }).rect;
		if (rect !== undefined && typeof rect.left === "number" && typeof rect.top === "number" && typeof rect.right === "number" && typeof rect.bottom === "number") {
			return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
		}
	}
	return { left: 0, top: 0, right: 0, bottom: 0 };
}

function reverseLocationToHoverInspection(location: ReverseSynctexLocation): ReverseSynctexHoverInspection {
	return {
		page: location.page,
		x: location.x,
		y: location.y,
		sourceFile: location.sourceFile,
		line: location.line,
		column: location.column,
		...(location.sourceLine === undefined ? {} : { sourceLine: location.sourceLine }),
		sidecarPath: location.sidecarPath,
		precision: location.precision,
		...(location.diagnostics.rawWinner === undefined ? {} : { rawWinner: location.diagnostics.rawWinner }),
		...(location.diagnostics.topCandidates === undefined ? {} : { topCandidates: location.diagnostics.topCandidates }),
		repairedWinner: { sourceFile: location.sourceFile, line: location.line, column: location.column, ...(location.sourceLine === undefined ? {} : { sourceLine: location.sourceLine }), precision: location.precision },
		...(location.diagnostics.forwardVerification === undefined ? {} : { forwardVerification: location.diagnostics.forwardVerification }),
		rect: rectFromDiagnostics(location.diagnostics),
		distanceFromCenter: 0,
	};
}

export function inspectReverseSynctexHover(input: { pdfPath: string; page: number; x: number; y: number; cwd: string; textBeforeSelection?: string; textAfterSelection?: string }): ReverseSynctexHoverInspection {
	if (!Number.isInteger(input.page) || input.page < 1) {
		throw new Error("page must be a positive integer");
	}
	if (!Number.isFinite(input.x) || input.x < 0 || !Number.isFinite(input.y) || input.y < 0) {
		throw new Error("x and y must be non-negative finite numbers");
	}
	if (input.textBeforeSelection !== undefined || input.textAfterSelection !== undefined) {
		return reverseLocationToHoverInspection(mapReverseSynctex(input));
	}
	const pdfPath = resolve(input.pdfPath);
	const sidecarPath = resolveSynctexSidecar(pdfPath);
	if (sidecarPath === undefined) {
		throw new Error(`PDF ${pdfPath} is missing SyncTeX sidecar (${pdfPath.replace(/\.pdf$/i, "")}.synctex or .synctex.gz)`);
	}
	const previousCwd = process.cwd();
	let inspected;
	try {
		process.chdir(input.cwd);
		inspected = inspectSyncTeXToTeXCandidates(input.page, input.x, input.y, pdfPath);
	} finally {
		process.chdir(previousCwd);
	}
	if (inspected === undefined) {
		throw new Error(`No SyncTeX hover mapping found for page ${input.page} at ${input.x},${input.y}; primary JS lookup returned no result`);
	}
	const winner = inspected.rawWinner;
	const sourceFile = resolveReverseMappedSourceFile(winner, input.cwd);
	const sourceLine = readSourceLine(sourceFile, winner.line, input.cwd);
	return {
		page: input.page,
		x: input.x,
		y: input.y,
		sourceFile,
		line: winner.line,
		column: winner.column,
		...(sourceLine === undefined ? {} : { sourceLine }),
		sidecarPath,
		precision: inspected.rawWinner.structural ? "raw" : "line",
		rawWinner: compactReverseCandidate(inspected.rawWinner),
		topCandidates: inspected.candidates.map(compactReverseCandidate),
		rect: winner.rect,
		distanceFromCenter: 0,
	};
}

export function mapReverseSynctex(input: {
	pdfPath: string;
	page: number;
	x: number;
	y: number;
	cwd: string;
	textBeforeSelection?: string;
	textAfterSelection?: string;
	nativeRunner?: NativeSynctexRunner;
	jsFallback?: ReverseSynctexJsFallback;
	inspectCandidates?: ReverseSynctexCandidateInspector;
	forwardBoxesForLine?: ReverseSynctexForwardBoxesForLine;
	synctexCommand?: string;
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

	let jsMapped;
	let jsResult: ReverseSynctexMappedResult | undefined;
	let jsFailureReason: string | undefined;
	let allowNativeFallback = false;
	let candidateInspection: ReverseSyncTeXCandidatesInspection | undefined;
	const previousCwd = process.cwd();
	try {
		process.chdir(input.cwd);
		if (input.jsFallback === undefined) {
			candidateInspection = (input.inspectCandidates ?? inspectSyncTeXToTeXCandidates)(input.page, input.x, input.y, pdfPath);
			jsResult = candidateInspection === undefined ? undefined : candidateToMapped(candidateInspection.rawWinner);
		} else {
			jsResult = input.jsFallback(input.page, input.x, input.y, pdfPath);
			candidateInspection = input.inspectCandidates?.(input.page, input.x, input.y, pdfPath);
		}
		if (jsResult === undefined) {
			jsFailureReason = "no result";
			allowNativeFallback = true;
		} else {
			const invalidReason = invalidReadableSourceLineReason(jsResult, input.cwd);
			if (invalidReason === undefined) {
				jsMapped = jsResult;
			} else {
				jsFailureReason = invalidReason;
			}
		}
	} catch (error) {
		jsMapped = undefined;
		candidateInspection = undefined;
		jsFailureReason = error instanceof Error ? error.message : String(error);
		allowNativeFallback = true;
	} finally {
		process.chdir(previousCwd);
	}
	const jsDiagnostics: ReverseSynctexDiagnostics["js"] = {
		attempted: true,
		role: "primary",
		...(jsResult === undefined ? {} : { result: jsResult }),
		...(jsFailureReason === undefined ? {} : { failureReason: jsFailureReason }),
	};
	let mapped = jsMapped;
	let branch: ReverseSynctexBranch = "js";
	const nativeCommand = input.synctexCommand ?? "synctex";
	const nativeArgs = ["edit", "-o", `${input.page}:${input.x}:${input.y}:${pdfPath}`];
	const nativeCwd = dirname(pdfPath);
	let nativeDiagnostics: ReverseSynctexDiagnostics["native"] = {
		command: nativeCommand,
		args: nativeArgs,
		cwd: nativeCwd,
		attempted: false,
		role: "fallback",
		failureReason: "not attempted because primary JS lookup succeeded",
	};
	if (mapped === undefined && allowNativeFallback) {
		const native = runNativeReverseSynctex({
			page: input.page,
			x: input.x,
			y: input.y,
			pdfPath,
			runner: input.nativeRunner ?? defaultNativeSynctexRunner,
			command: nativeCommand,
		});
		let nativeFailureReason = native.failureReason;
		mapped = native.mapped;
		if (mapped !== undefined) {
			const invalidReason = invalidReadableSourceLineReason(mapped, input.cwd) ?? lowQualityNativeReverseSourceLineReason(mapped, input.cwd);
			if (invalidReason !== undefined) {
				nativeFailureReason = invalidReason;
				mapped = undefined;
			}
		}
		nativeDiagnostics = {
			...native.diagnostics,
			attempted: true,
			role: "fallback",
			...(nativeFailureReason === undefined ? {} : { failureReason: nativeFailureReason }),
		};
		branch = "native_fallback";
	}
	if (mapped === undefined) {
		const nativeFallbackResult = nativeDiagnostics.attempted ? `native fallback returned ${nativeDiagnostics.failureReason ?? "no usable result"}` : "native fallback was not attempted";
		throw new Error(`No SyncTeX mapping found for page ${input.page} at ${input.x},${input.y}; primary JS lookup returned ${jsFailureReason ?? "no result"}; ${nativeFallbackResult}`);
	}

	const rawSourceFile = resolveReverseMappedSourceFile(mapped, input.cwd);
	const rawMappedLine = mapped.line;
	const rawMappedColumn = mapped.column;
	const rawMappedSourceLine = readSourceLine(rawSourceFile, rawMappedLine, input.cwd);
	let selectedMapped = mapped;
	let sourceFile = rawSourceFile;
	let line = mapped.line;
	let column = mapped.column;
	let precision: ReverseSynctexPrecision = branch === "native_fallback" ? "line" : candidateInspection?.rawWinner.structural === true ? "raw" : "line";
	const hasSelectionContext = input.textBeforeSelection !== undefined || input.textAfterSelection !== undefined;
	let textRepair: ReverseSynctexDiagnostics["textRepair"] | undefined;
	let forwardVerification: ReverseSynctexDiagnostics["forwardVerification"] | undefined;
	let textRepairChangedLocation = false;

	if (branch === "js" && hasSelectionContext) {
		const fragments = buildSourceSearchFragments(input.textBeforeSelection ?? "", input.textAfterSelection ?? "");
		const matches = findSourceTextMatches(rawSourceFile, fragments);
		textRepair = {
			used: false,
			status: matches.status,
			fragmentsTried: matches.fragmentsTried,
			matchCount: matches.matchCount,
			...(matches.fragment === undefined ? {} : { selectedFragment: matches.fragment }),
		};
		if (matches.status === "unique" || matches.status === "ambiguous-small") {
			const verified = selectForwardVerifiedSourceMatch({
				matches: matches.matches,
				click: { page: input.page, x: input.x, y: input.y },
				forwardBoxesForMatch: (match) => forwardBoxesForSourceLine({
					sourceFile: match.sourceFile,
					line: match.line,
					pdfPath,
					cwd: input.cwd,
					...(input.nativeRunner === undefined ? {} : { nativeRunner: input.nativeRunner }),
					...(input.forwardBoxesForLine === undefined ? {} : { forwardBoxesForLine: input.forwardBoxesForLine }),
					...(input.synctexCommand === undefined ? {} : { synctexCommand: input.synctexCommand }),
				}),
			});
			forwardVerification = {
				attempted: true,
				boxesConsidered: verified.boxes.length,
				boxesFiltered: verified.boxes.length,
				...(verified.chosenBox === undefined ? {} : { chosenBox: verified.chosenBox }),
				containsClick: verified.containsClick,
			};
			if (verified.match !== undefined && (matches.status === "unique" || verified.chosenBox !== undefined)) {
				const sameRawLine = verified.match.sourceFile === rawSourceFile && verified.match.line === rawMappedLine;
				if (!sameRawLine) {
					selectedMapped = { input: verified.match.sourceFile, line: verified.match.line, column: verified.match.column };
					sourceFile = verified.match.sourceFile;
					line = verified.match.line;
					column = verified.match.column;
					textRepairChangedLocation = true;
				}
				precision = verified.precision;
				textRepair = { ...textRepair, used: true, line: verified.match.line, column: verified.match.column };
			}
		}
	}

	const acceptedTextRepair = textRepair?.used === true || precision === "verified" || precision === "text";
	if (!acceptedTextRepair && selectedMapped === mapped && branch === "js" && candidateInspection !== undefined && candidateInspection.winner.line !== rawMappedLine) {
		selectedMapped = candidateToMapped(candidateInspection.winner);
		sourceFile = resolveReverseMappedSourceFile(selectedMapped, input.cwd);
		line = selectedMapped.line;
		column = selectedMapped.column;
		precision = "line";
	}

	const sourceLines = readSourceLines(sourceFile);
	if (column === 0 && hasSelectionContext && sourceLines !== undefined && !textRepairChangedLocation) {
		const [row, col] = getRowAndColumn(sourceLines, line - 1, input.textBeforeSelection ?? "", input.textAfterSelection ?? "");
		line = row + 1;
		column = col;
	}
	const sourceLine = readSourceLine(sourceFile, line, input.cwd);
	const normalizedFormula = normalizeFormulaClosingSpan(rawSourceFile, rawMappedLine, readSourceLines(rawSourceFile));
	const candidates: ReverseSynctexDiagnostics["candidates"] = [{
		sourceFile: rawSourceFile,
		line: rawMappedLine,
		column: rawMappedColumn,
		...(rawMappedSourceLine === undefined ? {} : { sourceLine: rawMappedSourceLine }),
		kind: "raw",
	}];
	if (line !== rawMappedLine || column !== rawMappedColumn || sourceFile !== rawSourceFile) {
		candidates.push({
			sourceFile,
			line,
			column,
			...(sourceLine === undefined ? {} : { sourceLine }),
			kind: "context_corrected",
		});
	}
	if (normalizedFormula !== undefined) {
		candidates.push({
			sourceFile: normalizedFormula.span.sourceFile,
			line: normalizedFormula.span.startLine,
			column: 0,
			sourceLine: normalizedFormula.excerpt,
			kind: "formula_normalized",
		});
	}
	const diagnostics: ReverseSynctexDiagnostics = {
		branch,
		lookupInput: { pdfPath, page: input.page, x: input.x, y: input.y, sidecarPath },
		native: nativeDiagnostics,
		js: jsDiagnostics,
		context: {
			hasSelectionContext,
			...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }),
			...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }),
		},
		candidates,
		selected: {
			sourceFile,
			line,
			column,
			...(sourceLine === undefined ? {} : { sourceLine }),
		},
		precision,
		...(candidateInspection === undefined ? {} : { rawWinner: compactReverseCandidate(candidateInspection.rawWinner), topCandidates: candidateInspection.candidates.map(compactReverseCandidate) }),
		...(textRepair === undefined ? {} : { textRepair }),
		...(forwardVerification === undefined ? {} : { forwardVerification }),
	};
	return {
		page: input.page,
		x: input.x,
		y: input.y,
		sourceFile,
		line,
		column,
		...(sourceLine === undefined ? {} : { sourceLine }),
		sidecarPath,
		precision,
		...(line === rawMappedLine && column === rawMappedColumn && sourceFile === rawSourceFile && normalizedFormula === undefined ? {} : {
			rawMappedSourceFile: rawSourceFile,
			rawMappedLine,
			rawMappedColumn,
			...(rawMappedSourceLine === undefined ? {} : { rawMappedSourceLine }),
		}),
		...(normalizedFormula === undefined ? {} : {
			normalizedFormulaSpan: normalizedFormula.span,
			normalizedFormulaExcerpt: normalizedFormula.excerpt,
		}),
		diagnostics,
	};
}

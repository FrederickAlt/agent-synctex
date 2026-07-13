import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { collectCachedSyncTeXForwardTreeCandidates, inspectSyncTeXToTeXCandidates, syncTeXToPDF, syncTeXToTeX, resolveLatexWorkshopSynctexSidecar, type ReverseSyncTeXCandidate, type ReverseSyncTeXCandidatesInspection, type SyncTeXForwardTreeCandidate } from "./latex_workshop/worker.ts";
import { lineColumnForSourceIndex } from "./source_index.ts";
import { readSourceLine } from "./source_line.ts";
import { boxContainsClick, boxDistanceComponentsFromClick, buildSourceSearchFragments, filterForwardBoxes, findSourceTextMatches, type SourceTextMatchResult } from "./text_repair.ts";
import { resolveExecutable } from "../executable_resolution.ts";

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
export type ForwardSynctexLookupMode = "exact";
export type ReverseSynctexBranch = "js" | "native_fallback";
export type ReverseSynctexPrecision = "verified" | "text" | "line" | "raw";
/** How this source proposal entered reverse SyncTeX scoring, independent of its forward box-group flavor. */
export type ReverseSynctexProposalProvenance = "synctex_reverse" | "selection_text_context";

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
	/** Present only for JS parsed-tree candidates used by reverse click scoring. */
	treeCandidate?: SyncTeXForwardTreeCandidate;
}

/** Browser-derived PDF.js text geometry, in the same PDF coordinate system as SyncTeX. */
export interface PdfTextSpan extends ForwardSynctexRange {
	text: string;
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
export type ReverseSynctexForwardBoxesForLine = (input: { sourceFile: string; line: number; pdfPath: string; cwd: string; lookupMode: ForwardSynctexLookupMode }) => ForwardSynctexRange[];

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
	/** Normal source jumps use a printable content line; reverse candidates preserve the exact artifact line. */
	lookupMode?: ForwardSynctexLookupMode;
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
	pageHeight?: number;
	pdfTextSpans?: PdfTextSpan[];
	nativeRunner?: NativeSynctexRunner;
	forwardJsFallback?: ForwardSynctexJsFallback;
	synctexCommand?: string;
	/** Retains bounded proposal/group/box arithmetic for an explicit debug probe only. */
	debugTrace?: boolean;
	inspectReverse?: (input: { pdfPath: string; page: number; x: number; y: number; cwd: string }) => ReverseSynctexHoverInspection;
	mapForward?: (input: MapForwardSynctexInput) => ForwardSynctexJump;
}

export interface ReverseSynctexSourceSpan {
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
	normalizedSourceSpan?: ReverseSynctexSourceSpan;
	normalizedSourceExcerpt?: string;
	forwardLookupLine?: number;
	forwardLookupMode?: ForwardSynctexLookupMode;
	selectedForwardBox?: ForwardSynctexRange;
	selectedForwardRanges?: ForwardSynctexRange[];
	/** Exact forward-group scores, emitted only by an explicit debug probe. */
	forwardGroupScores?: ReverseSynctexForwardGroupScore[];
	/** Full bounded proposal/group/box trace retained only for an explicit debug probe. */
	debugProposalScores?: ReverseSynctexProposalScore[];
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
	proposalScores?: ReverseSynctexDiagnostics["proposalScores"];
	debugProposalScores?: ReverseSynctexProposalScore[];
	repairedWinner?: { sourceFile: string; line: number; column: number; sourceLine?: string; precision: ReverseSynctexPrecision; score?: number };
	forwardVerification?: ReverseSynctexDiagnostics["forwardVerification"];
	normalizedSourceSpan?: ReverseSynctexSourceSpan;
	normalizedSourceExcerpt?: string;
	forwardLookupLine?: number;
	forwardLookupMode?: ForwardSynctexLookupMode;
	selectedForwardBox?: ForwardSynctexRange;
	selectedForwardRanges?: ForwardSynctexRange[];
	forwardGroupScores?: ReverseSynctexForwardGroupScore[];
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
		kind: "initial_candidate" | "context_corrected" | "source_span";
	}>;
	selected: {
		sourceFile: string;
		line: number;
		column: number;
		sourceLine?: string;
		score?: number;
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
	proposalScores?: Array<{
		kind: "text" | "ranked";
		provenance: ReverseSynctexProposalProvenance;
		sourceFile: string;
		line: number;
		column: number;
		geometryTier: number;
		score: number;
		precision: ReverseSynctexPrecision;
		samePageBoxCount: number;
		containsClick: boolean;
		structural: boolean;
		clickContainmentBonus: number;
		textContainmentBonus: number;
		textContainment?: "full" | "partial";
		distance?: number;
		reason?: string;
	}>;
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

const MAX_CACHED_FORWARD_SYNCTEX_JUMPS = 512;
const cachedForwardSynctexJumps = new Map<string, ForwardSynctexJump>();

function fileSnapshotCacheKey(filePath: string): string | undefined {
	try {
		const status = statSync(filePath);
		return `${resolve(filePath)}:${status.size}:${status.mtimeMs}`;
	} catch {
		return undefined;
	}
}

function cacheKeyForForwardSynctex(input: MapForwardSynctexInput): string | undefined {
	if (input.nativeRunner !== undefined || input.jsFallback !== undefined) return undefined;
	const pdfPath = resolve(input.pdfPath);
	const sourceFile = isAbsolute(input.sourceFile) ? resolve(input.sourceFile) : resolve(input.cwd, input.sourceFile);
	const sidecarPath = resolveSynctexSidecar(pdfPath);
	if (sidecarPath === undefined) return undefined;
	const sidecarSnapshot = fileSnapshotCacheKey(sidecarPath);
	const sourceSnapshot = fileSnapshotCacheKey(sourceFile);
	if (sidecarSnapshot === undefined || sourceSnapshot === undefined) return undefined;
	return [input.synctexCommand ?? resolveExecutable("synctex"), pdfPath, sidecarSnapshot, sourceFile, sourceSnapshot, input.lookupMode ?? "exact", input.line].join("\0");
}

function cloneForwardSynctexJump(jump: ForwardSynctexJump): ForwardSynctexJump {
	return structuredClone(jump);
}

function rememberForwardSynctexJump(cacheKey: string, jump: ForwardSynctexJump): void {
	cachedForwardSynctexJumps.delete(cacheKey);
	cachedForwardSynctexJumps.set(cacheKey, cloneForwardSynctexJump(jump));
	while (cachedForwardSynctexJumps.size > MAX_CACHED_FORWARD_SYNCTEX_JUMPS) {
		const oldestKey = cachedForwardSynctexJumps.keys().next().value;
		if (oldestKey === undefined) break;
		cachedForwardSynctexJumps.delete(oldestKey);
	}
}

function cachedMapForwardSynctex(input: MapForwardSynctexInput): ForwardSynctexJump {
	const cacheKey = cacheKeyForForwardSynctex(input);
	const cached = cacheKey === undefined ? undefined : cachedForwardSynctexJumps.get(cacheKey);
	if (cached !== undefined) return cloneForwardSynctexJump(cached);
	const jump = mapForwardSynctex(input);
	if (cacheKey !== undefined) rememberForwardSynctexJump(cacheKey, jump);
	return jump;
}

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
	const h = record.W < 0 ? record.h + record.W : record.h;
	const v = record.H < 0 ? record.v - record.H : record.v;
	return { page: record.page, h, v, W: Math.abs(record.W), H: Math.abs(record.H) };
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
	const mapForward = input.mapForward ?? cachedMapForwardSynctex;
	const reverse = input.inspectReverse === undefined
		? reverseLocationToHoverInspection(mapReverseSynctex({
			pdfPath: input.pdfPath,
			page: input.page,
			x: input.x,
			y: input.y,
			cwd: input.cwd,
			...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }),
			...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }),
			...(input.pageHeight === undefined ? {} : { pageHeight: input.pageHeight }),
			...(input.pdfTextSpans === undefined ? {} : { pdfTextSpans: input.pdfTextSpans }),
			...(input.nativeRunner === undefined ? {} : { nativeRunner: input.nativeRunner }),
			...(input.synctexCommand === undefined ? {} : { synctexCommand: input.synctexCommand }),
			...(input.debugTrace === true ? { debugTrace: true } : {}),
		}))
		: input.inspectReverse({ pdfPath: input.pdfPath, page: input.page, x: input.x, y: input.y, cwd: input.cwd });
	const mappedForward = mapForward({
		pdfPath: input.pdfPath,
		sourceFile: reverse.sourceFile,
		line: reverse.forwardLookupLine ?? reverse.line,
		cwd: input.cwd,
		lookupMode: reverse.forwardLookupMode ?? "exact",
		...(input.nativeRunner === undefined ? {} : { nativeRunner: input.nativeRunner }),
		...(input.forwardJsFallback === undefined ? {} : { jsFallback: input.forwardJsFallback }),
		...(input.synctexCommand === undefined ? {} : { synctexCommand: input.synctexCommand }),
	});
	// A normal reverse mapping already scored selectedForwardBox. Custom
	// inspectReverse callers have no scorer result, so retain the legacy fallback.
	const selectedBox = reverse.selectedForwardBox
		?? (mappedForward.ranges === undefined ? undefined : filterForwardBoxes(mappedForward.ranges, { page: input.page, x: input.x, y: input.y }).chosenBox);
	const forward = selectedBox === undefined ? mappedForward : {
		...mappedForward,
		page: selectedBox.page,
		x: selectedBox.h,
		y: selectedBox.v,
		width: selectedBox.W,
		height: selectedBox.H,
		ranges: [selectedBox],
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
	const effectiveLine = input.line;
	const sourceLine = readSourceLine(sourceFile, effectiveLine, input.cwd);
	if (sourceLine === undefined) {
		throw new Error(`Cannot read source_file line ${sourceFile}:${effectiveLine}`);
	}

	const native = runNativeForwardSynctex({
		line: effectiveLine,
		sourceFile,
		pdfPath,
		runner: input.nativeRunner ?? defaultNativeSynctexRunner,
		command: input.synctexCommand ?? resolveExecutable("synctex"),
	});
	if (native.mapped !== undefined) {
		const diagnostics = buildForwardDiagnostics({ branch: "native", pdfPath, sourceFile, line: effectiveLine, sidecarPath, native: native.diagnostics });
		return withForwardGlue({ mapped: native.mapped, branch: "native", sourceFile, line: effectiveLine, sourceLine, sidecarPath, diagnostics });
	}

	let mapped;
	let jsFailureReason: string | undefined;
	const previousCwd = process.cwd();
	try {
		process.chdir(input.cwd);
		mapped = (input.jsFallback ?? syncTeXToPDF)(effectiveLine, sourceFile, pdfPath);
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
		throw new Error(`No usable SyncTeX mapping found for ${sourcePathLabel(sourceFile)}:${effectiveLine}; native synctex view returned ${native.failureReason ?? "no usable result"}; JS fallback returned no result`);
	}

	const diagnostics = buildForwardDiagnostics({ branch: "js_fallback", pdfPath, sourceFile, line: effectiveLine, sidecarPath, native: native.diagnostics, jsFallback });
	return withForwardGlue({ mapped, branch: "js_fallback", sourceFile, line: effectiveLine, sourceLine, sidecarPath, diagnostics });
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

const MAX_SYNC_TEX_SOURCE_BYTES = 1_000_000;

function readSourceText(sourceFile: string): string | undefined {
	try {
		const status = statSync(sourceFile);
		if (!status.isFile() || status.size > MAX_SYNC_TEX_SOURCE_BYTES) return undefined;
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

const STRUCTURAL_REVERSE_SOURCE_LINES = new Set(["\\end{document}", "\\newpage", "\\end{minipage}", "\\end{figure}", "\\begin{document}"]);

function isStructuralReverseSourceLine(sourceLine: string | undefined): boolean {
	const trimmed = sourceLine?.trim();
	return trimmed !== undefined && STRUCTURAL_REVERSE_SOURCE_LINES.has(trimmed);
}

function compactReverseCandidate(candidate: ReverseSyncTeXCandidate, cwd?: string, proposalScores?: ReverseSynctexDiagnostics["proposalScores"]): unknown {
	const sourceFile = cwd === undefined ? candidate.input : resolveReverseMappedSourceFile(candidateToMapped(candidate), cwd);
	const proposalScore = proposalScores?.find((proposal) => proposal.sourceFile === sourceFile && proposal.line === candidate.line && proposal.column === candidate.column)?.score;
	return {
		sourceFile: candidate.input,
		line: candidate.line,
		column: candidate.column,
		...(candidate.sourceLine === undefined ? {} : { sourceLine: candidate.sourceLine }),
		rect: candidate.rect,
		distanceX: candidate.distanceX,
		distanceY: candidate.distanceY,
		distance: candidate.distance,
		area: candidate.area,
		containsClick: candidate.containsClick,
		structural: candidate.structural,
		...(proposalScore === undefined ? {} : { score: proposalScore }),
		...(candidate.structuralReason === undefined ? {} : { structuralReason: candidate.structuralReason }),
	};
}

/** Reject rather than sample an unbounded parsed-tree click candidate pool. */
const MAX_FORWARD_TREE_CANDIDATES = 2_000;

const FORWARD_DISTANCE_PENALTY_MULTIPLIER = 0.96;
const FORWARD_BOX_SIZE_PENALTY_MULTIPLIER = 2;
const TINY_BOX_GLYPH_WIDTH_PT = 5.5;
const TINY_BOX_GLYPH_HEIGHT_PT = 11;
const TINY_BOX_MAX_PENALTY = 1_000;
const TINY_BOX_CHARACTER_CUTOFF = 10;
// Calibrated so a five-glyph-equivalent box receives a 300-point penalty.
const TINY_BOX_PENALTY_EXPONENT = Math.log(0.3) / Math.log(5 / 9);

interface ForwardBoxGroup {
	lookupMode: ForwardSynctexLookupMode;
	lookupLine: number;
	boxes: ForwardSynctexRange[];
	/** DOM text rectangles describe visual layout; SyncTeX rectangles preserve source semantics. */
	semanticPenalty: number;
	verifiedText?: boolean;
}

export interface ReverseSynctexForwardBoxScore {
	box: ForwardSynctexRange;
	containsClick: boolean;
	geometryTier: number;
	distance: number;
	distanceSquared: number;
	distanceMultiplier: number;
	distanceTerm: number;
	area: number;
	areaTerm: number;
	tinyPenalty: number;
	/** Max of the independent semantic penalty sources below; never their sum. */
	semanticPenalty: number;
	pdfTextSpanSemanticPenalty: number;
	selectionTextContextSemanticPenalty: number;
	blankSourceLinePenalty: number;
	clickContainmentBonus: number;
	textContainmentBonus: number;
	textContainment?: "full" | "partial";
	endDocumentPenalty: number;
	score: number;
}

/** Minimal selected-group data retained by normal reverse SyncTeX resolution. */
export interface ReverseSynctexForwardGroupScore {
	origin: "synctex_exact" | "pdf_text_span";
	lookupLine: number;
	semanticPenalty: number;
	geometryTier: number;
	score: number;
	chosenBox?: ForwardSynctexRange;
}

/** Bounded box arithmetic retained only for an explicit debug probe. */
export interface ReverseSynctexDebugForwardGroupScore extends ReverseSynctexForwardGroupScore {
	pdfTextSpanSemanticPenalty: number;
	selectionTextContextSemanticPenalty: number;
	blankSourceLinePenalty: number;
	originalBoxCount: number;
	filteredBoxCount: number;
	samePageBoxCount: number;
	rejectedInvalid: number;
	rejectedAbsurd: number;
	containsClick: boolean;
	distance?: number;
	distanceSquared?: number;
	distanceMultiplier?: number;
	distanceTerm?: number;
	area?: number;
	areaTerm?: number;
	tinyPenalty?: number;
	endDocumentPenalty?: number;
	clickContainmentBonus: number;
	textContainmentBonus: number;
	textContainment?: "full" | "partial";
	boxScoreCount: number;
	boxScoresTruncated: boolean;
	boxScores: ReverseSynctexForwardBoxScore[];
}

export interface ReverseSynctexProposalScore {
	kind: "text" | "ranked";
	provenance: ReverseSynctexProposalProvenance;
	sourceFile: string;
	line: number;
	column: number;
	rank: number;
	textStatus?: "unique" | "ambiguous-small";
	geometryTier: number;
	score: number;
	precision: ReverseSynctexPrecision;
	samePageBoxCount: number;
	containsClick: boolean;
	structural: boolean;
	clickContainmentBonus: number;
	textContainmentBonus: number;
	textContainment?: "full" | "partial";
	distance?: number;
	reason?: string;
	forwardLookupMode?: ForwardSynctexLookupMode;
	forwardGroupScores: ReverseSynctexDebugForwardGroupScore[];
}

function forwardBoxesForLookup(input: { sourceFile: string; line: number; pdfPath: string; cwd: string; lookupMode: ForwardSynctexLookupMode; nativeRunner?: NativeSynctexRunner; forwardBoxesForLine?: ReverseSynctexForwardBoxesForLine; synctexCommand?: string }): ForwardSynctexRange[] {
	if (input.forwardBoxesForLine !== undefined) return input.forwardBoxesForLine(input);
	let treeCandidates;
	const previousCwd = process.cwd();
	try {
		process.chdir(input.cwd);
		treeCandidates = collectCachedSyncTeXForwardTreeCandidates({
			pdfPath: input.pdfPath,
			sourceFile: input.sourceFile,
			line: input.line,
			maxCandidates: MAX_FORWARD_TREE_CANDIDATES,
		});
	} finally {
		process.chdir(previousCwd);
	}
	if (treeCandidates.exceeded) return [];
	if (treeCandidates.candidates.length > 0) {
		const seen = new Set<string>();
		return treeCandidates.candidates.flatMap((candidate) => {
			const box: ForwardSynctexRange = { ...candidate.box, treeCandidate: candidate };
			const key = forwardRangeKey(box);
			if (seen.has(key)) return [];
			seen.add(key);
			return [box];
		});
	}
	try {
		const forward = cachedMapForwardSynctex({
			pdfPath: input.pdfPath,
			sourceFile: input.sourceFile,
			line: input.line,
			cwd: input.cwd,
			lookupMode: input.lookupMode,
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

function forwardRangeKey(range: ForwardSynctexRange): string {
	return [range.page, range.h, range.v, range.W, range.H].join(":");
}

/**
 * Discourages click candidates whose visible geometry is only glyph-sized.
 * The positive value is added to the reverse-click score, where lower wins.
 */
export function tinyForwardBoxPenalty(box: Pick<ForwardSynctexRange, "W" | "H">): number {
	const glyphArea = TINY_BOX_GLYPH_WIDTH_PT * TINY_BOX_GLYPH_HEIGHT_PT;
	const characterEquivalent = Math.max(1, (Math.max(0, box.W) * Math.max(0, box.H)) / glyphArea);
	if (characterEquivalent >= TINY_BOX_CHARACTER_CUTOFF) return 0;
	const remaining = (TINY_BOX_CHARACTER_CUTOFF - characterEquivalent) / (TINY_BOX_CHARACTER_CUTOFF - 1);
	return TINY_BOX_MAX_PENALTY * Math.pow(remaining, TINY_BOX_PENALTY_EXPONENT);
}

export function normalizedVisibleText(value: string): string {
	return value.replace(/[\u00a0\s]+/g, " ").replace(/[−–—]/g, "-").trim();
}

/** Only project source lines whose visible text can be established without TeX expansion. */
export function simpleVisibleSourceText(sourceLine: string | undefined): string | undefined {
	if (sourceLine === undefined) return undefined;
	let visible = sourceLine.replace(/\\(?:textbf|textit|emph|mathrm|mathbf|text)\{([^{}]*)\}/g, "$1");
	visible = visible.replace(/\\\\(?:\[[^\]]*\])?/g, " ").replace(/&/g, " ");
	visible = visible.replace(/\\(?:quad|qquad|enspace|,|;|!|:| )/g, " ");
	if (/\\[A-Za-z@]+|[{}]/.test(visible)) return undefined;
	const normalized = normalizedVisibleText(visible);
	return normalized.length >= 3 ? normalized : undefined;
}

function uniquelyOccursInSource(sourceText: string, text: string): boolean {
	const first = sourceText.indexOf(text);
	return first >= 0 && sourceText.indexOf(text, first + 1) < 0;
}

/** A PDF.js visual line can end in a discretionary hyphen absent from the TeX source. */
function isUniqueVisibleSpanInSource(sourceText: string, spanText: string): boolean {
	if (uniquelyOccursInSource(sourceText, spanText)) return true;
	if (!spanText.endsWith("-")) return false;
	const dehyphenated = spanText.slice(0, -1);
	const first = sourceText.indexOf(dehyphenated);
	if (first < 0 || sourceText.indexOf(dehyphenated, first + 1) >= 0) return false;
	return /[A-Za-z0-9]/.test(sourceText[first + dehyphenated.length] ?? "");
}

function verifiedPdfTextBoxes(input: { sourceLine: string | undefined; click: { page: number; x: number; y: number }; spans: PdfTextSpan[] | undefined }): ForwardSynctexRange[] {
	const sourceText = simpleVisibleSourceText(input.sourceLine);
	if (sourceText === undefined || input.spans === undefined) return [];
	const matches = input.spans.filter((span) => {
		const text = normalizedVisibleText(span.text);
		return text.length >= 3 && boxContainsClick(span, input.click) && isUniqueVisibleSpanInSource(sourceText, text);
	});
	return matches.length === 1 ? matches.map(({ text: _text, ...box }) => box) : [];
}

function forwardBoxGroupsForSourceLine(input: { sourceFile: string; line: number; pdfPath: string; cwd: string; click?: { page: number; x: number; y: number }; pdfTextSpans?: PdfTextSpan[]; nativeRunner?: NativeSynctexRunner; forwardBoxesForLine?: ReverseSynctexForwardBoxesForLine; synctexCommand?: string }): ForwardBoxGroup[] {
	const sourceLines = readSourceLines(input.sourceFile);
	const groups: ForwardBoxGroup[] = [{
		lookupMode: "exact" as const,
		lookupLine: input.line,
		semanticPenalty: 0,
		boxes: forwardBoxesForLookup({ ...input, lookupMode: "exact" }),
	}].filter((group) => group.boxes.length > 0);
	const textBoxes = input.click === undefined ? [] : verifiedPdfTextBoxes({
		sourceLine: sourceLines?.[input.line - 1],
		click: input.click,
		spans: input.pdfTextSpans,
	});
	if (textBoxes.length > 0) groups.push({ lookupMode: "exact", lookupLine: input.line, boxes: textBoxes, semanticPenalty: 0, verifiedText: true });
	return groups;
}

const MAX_REVERSE_SYNCTEX_CANDIDATE_PROPOSALS = 25;
const MAX_REVERSE_SYNCTEX_DEBUG_BOX_SCORES = 16;
const FULL_TEXT_CONTAINMENT_CONTEXT_CHARS = 30;
const END_DOCUMENT_GEOMETRY_TIER = 1;
const END_DOCUMENT_SCORE_PENALTY = 2_000;
const BLANK_SOURCE_LINE_SCORE_PENALTY = 500;

interface ReverseSynctexProposal {
	kind: "text" | "ranked";
	provenance: ReverseSynctexProposalProvenance;
	sourceFile: string;
	line: number;
	column: number;
	sourceLine?: string;
	structural: boolean;
	textStatus?: "unique" | "ambiguous-small";
	rank: number;
}

interface ScoredReverseSynctexProposal extends ReverseSynctexProposal {
	precision: ReverseSynctexPrecision;
	geometryTier: number;
	score: number;
	forwardLookupLine?: number;
	forwardLookupMode?: ForwardSynctexLookupMode;
	boxes: ForwardSynctexRange[];
	chosenBox?: ForwardSynctexRange;
	containsClick: boolean;
	samePageBoxCount: number;
	clickContainmentBonus: number;
	textContainmentBonus: number;
	textContainment?: "full" | "partial";
	distance?: number;
	reason?: string;
	forwardGroupScores: ReverseSynctexForwardGroupScore[];
	debugForwardGroupScores?: ReverseSynctexDebugForwardGroupScore[];
}

function sameSourceLocation(left: { sourceFile: string; line: number }, right: { sourceFile: string; line: number }): boolean {
	return left.sourceFile === right.sourceFile && left.line === right.line;
}

function buildFullTextContainmentContext(textBeforeSelection: string | undefined, textAfterSelection: string | undefined): string | undefined {
	return buildSourceSearchFragments((textBeforeSelection ?? "").slice(-FULL_TEXT_CONTAINMENT_CONTEXT_CHARS), (textAfterSelection ?? "").slice(0, FULL_TEXT_CONTAINMENT_CONTEXT_CHARS))[0];
}

function buildPartialTextContainmentContext(textBeforeSelection: string | undefined, textAfterSelection: string | undefined): string | undefined {
	const before = textBeforeSelection ?? "";
	const after = textAfterSelection ?? "";
	let beforeCount = Math.min(4, before.length);
	let afterCount = Math.min(4, after.length);
	if (beforeCount < 4) afterCount = Math.min(8 - beforeCount, after.length);
	if (afterCount < 4) beforeCount = Math.min(8 - afterCount, before.length);
	const context = `${before.slice(before.length - beforeCount)}${after.slice(0, afterCount)}`;
	return context.length === 8 ? context : undefined;
}

function textContainmentBonus(input: { proposal: ReverseSynctexProposal; containsClick: boolean; fullTextFragment?: string; partialTextFragment?: string }): { bonus: number; containment?: "full" | "partial" } {
	if (!input.containsClick || input.proposal.sourceLine === undefined) return { bonus: 0 };
	if (input.fullTextFragment !== undefined && input.fullTextFragment.length > 0 && input.proposal.sourceLine.includes(input.fullTextFragment)) {
		return { bonus: -500, containment: "full" };
	}
	if (input.partialTextFragment !== undefined && input.proposal.sourceLine.includes(input.partialTextFragment)) {
		return { bonus: -200, containment: "partial" };
	}
	return { bonus: 0 };
}

function proposalPrecision(proposal: ReverseSynctexProposal, containsClick: boolean, verifiedTextGeometry = false): ReverseSynctexPrecision {
	if (verifiedTextGeometry || proposal.kind === "text") return containsClick ? "verified" : "text";
	return "line";
}

interface ScoredForwardBoxGroup extends ReverseSynctexForwardGroupScore {
	group: ForwardBoxGroup;
	boxes: ForwardSynctexRange[];
	containsClick: boolean;
	samePageBoxCount: number;
	clickContainmentBonus: number;
	textContainmentBonus: number;
	textContainment?: "full" | "partial";
	distance?: number;
	debugScore?: ReverseSynctexDebugForwardGroupScore;
}

function scoreReverseSynctexProposal(input: {
	proposal: ReverseSynctexProposal;
	click: { page: number; x: number; y: number };
	boxGroups: ForwardBoxGroup[];
	fullTextFragment?: string;
	partialTextFragment?: string;
	debugTrace?: boolean;
}): ScoredReverseSynctexProposal {
	const scoredGroups = input.boxGroups.map((group): ScoredForwardBoxGroup => {
		const filtered = filterForwardBoxes(group.boxes, input.click);
		const samePageBoxes = filtered.boxes.filter((box) => box.page === input.click.page);
		const pdfTextSpanSemanticPenalty = group.semanticPenalty;
		const selectionTextContextSemanticPenalty = 0;
		const semanticPenalty = 0;
		const scoredSamePageBoxes = samePageBoxes.map((box): ReverseSynctexForwardBoxScore => {
			const { distance, distanceSquared } = boxDistanceComponentsFromClick(box, input.click);
			const distanceMultiplier = FORWARD_DISTANCE_PENALTY_MULTIPLIER;
			const distanceTerm = distanceSquared * distanceMultiplier;
			const area = Math.max(0, box.W) * Math.max(0, box.H);
			const areaTerm = Math.sqrt(area) * FORWARD_BOX_SIZE_PENALTY_MULTIPLIER;
			const containsClick = boxContainsClick(box, input.click);
			const containment = textContainmentBonus({ proposal: input.proposal, containsClick, fullTextFragment: input.fullTextFragment, partialTextFragment: input.partialTextFragment });
			const clickContainmentBonus = containsClick ? -1000 : 0;
			const tinyPenalty = tinyForwardBoxPenalty(box);
			const blankSourceLinePenalty = input.proposal.sourceLine?.trim() === "" ? BLANK_SOURCE_LINE_SCORE_PENALTY : 0;
			const endDocumentPenalty = input.proposal.sourceLine?.trim() === "\\end{document}" ? END_DOCUMENT_SCORE_PENALTY : 0;
			return {
				box,
				containsClick,
				geometryTier: 0,
				distance,
				distanceSquared,
				distanceMultiplier,
				distanceTerm,
				area,
				areaTerm,
				tinyPenalty,
				semanticPenalty,
				pdfTextSpanSemanticPenalty,
				selectionTextContextSemanticPenalty,
				blankSourceLinePenalty,
				clickContainmentBonus,
				textContainmentBonus: containment.bonus,
				...(containment.containment === undefined ? {} : { textContainment: containment.containment }),
				endDocumentPenalty,
				score: distanceTerm + areaTerm + tinyPenalty + semanticPenalty + blankSourceLinePenalty + clickContainmentBonus + containment.bonus + endDocumentPenalty,
			};
		}).sort((left, right) => left.score - right.score);
		const chosen = scoredSamePageBoxes[0];
		const origin: ReverseSynctexForwardGroupScore["origin"] = group.verifiedText === true ? "pdf_text_span" : "synctex_exact";
		const basic = {
			origin,
			lookupLine: group.lookupLine,
			semanticPenalty,
			...(chosen?.box === undefined ? {} : { chosenBox: chosen.box }),
			geometryTier: chosen?.geometryTier ?? 1,
			score: chosen?.score ?? 0,
		};
		const debugScore = input.debugTrace !== true ? undefined : {
			...basic,
			pdfTextSpanSemanticPenalty,
			selectionTextContextSemanticPenalty,
			blankSourceLinePenalty: chosen?.blankSourceLinePenalty ?? 0,
			originalBoxCount: group.boxes.length,
			filteredBoxCount: filtered.boxes.length,
			samePageBoxCount: samePageBoxes.length,
			rejectedInvalid: filtered.rejectedInvalid,
			rejectedAbsurd: filtered.rejectedAbsurd,
			containsClick: chosen?.containsClick ?? false,
			...(chosen?.distance === undefined ? {} : { distance: chosen.distance }),
			...(chosen?.distanceSquared === undefined ? {} : { distanceSquared: chosen.distanceSquared }),
			...(chosen?.distanceMultiplier === undefined ? {} : { distanceMultiplier: chosen.distanceMultiplier }),
			...(chosen?.distanceTerm === undefined ? {} : { distanceTerm: chosen.distanceTerm }),
			...(chosen?.area === undefined ? {} : { area: chosen.area }),
			...(chosen?.areaTerm === undefined ? {} : { areaTerm: chosen.areaTerm }),
			...(chosen?.tinyPenalty === undefined ? {} : { tinyPenalty: chosen.tinyPenalty }),
			...(chosen?.endDocumentPenalty === undefined ? {} : { endDocumentPenalty: chosen.endDocumentPenalty }),
			clickContainmentBonus: chosen?.clickContainmentBonus ?? 0,
			textContainmentBonus: chosen?.textContainmentBonus ?? 0,
			...(chosen?.textContainment === undefined ? {} : { textContainment: chosen.textContainment }),
			boxScoreCount: scoredSamePageBoxes.length,
			boxScoresTruncated: scoredSamePageBoxes.length > MAX_REVERSE_SYNCTEX_DEBUG_BOX_SCORES,
			boxScores: scoredSamePageBoxes.slice(0, MAX_REVERSE_SYNCTEX_DEBUG_BOX_SCORES),
		} satisfies ReverseSynctexDebugForwardGroupScore;
		return {
			group,
			boxes: filtered.boxes,
			...basic,
			containsClick: chosen?.containsClick ?? false,
			samePageBoxCount: samePageBoxes.length,
			clickContainmentBonus: chosen?.clickContainmentBonus ?? 0,
			textContainmentBonus: chosen?.textContainmentBonus ?? 0,
			...(chosen?.textContainment === undefined ? {} : { textContainment: chosen.textContainment }),
			...(chosen?.distance === undefined ? {} : { distance: chosen.distance }),
			...(debugScore === undefined ? {} : { debugScore }),
		};
	}).sort((left, right) => left.geometryTier - right.geometryTier || left.score - right.score);
	const selectedGroup = scoredGroups[0];
	const geometryTier = input.proposal.sourceLine?.trim() === "\\end{document}"
			? END_DOCUMENT_GEOMETRY_TIER
			: selectedGroup?.geometryTier ?? 1;
	const chosenBox = selectedGroup?.chosenBox;
	const containsClick = selectedGroup?.containsClick ?? false;
	return {
		...input.proposal,
		precision: proposalPrecision(input.proposal, containsClick, selectedGroup?.group.verifiedText === true),
		forwardGroupScores: scoredGroups.map(({ group: _group, boxes: _boxes, containsClick: _containsClick, samePageBoxCount: _samePageBoxCount, clickContainmentBonus: _clickContainmentBonus, textContainmentBonus: _textContainmentBonus, textContainment: _textContainment, distance: _distance, debugScore: _debugScore, ...score }) => score),
		...(input.debugTrace !== true ? {} : { debugForwardGroupScores: scoredGroups.flatMap((group) => group.debugScore === undefined ? [] : [group.debugScore]) }),
		geometryTier,
		score: selectedGroup?.score ?? 0,
		...(selectedGroup === undefined ? {} : { forwardLookupLine: selectedGroup.group.lookupLine, forwardLookupMode: selectedGroup.group.lookupMode }),
		boxes: selectedGroup?.boxes ?? [],
		...(chosenBox === undefined ? {} : { chosenBox }),
		containsClick,
		samePageBoxCount: selectedGroup?.samePageBoxCount ?? 0,
		clickContainmentBonus: selectedGroup?.clickContainmentBonus ?? 0,
		textContainmentBonus: selectedGroup?.textContainmentBonus ?? 0,
		...(selectedGroup?.textContainment === undefined ? {} : { textContainment: selectedGroup.textContainment }),
		...(selectedGroup?.distance === undefined ? {} : { distance: selectedGroup.distance }),
		...(chosenBox === undefined ? { reason: "no-same-page-forward-box" } : containsClick ? { reason: "contains-click" } : { reason: "nearest-same-page-forward-box" }),
	};
}

function compareScoredReverseSynctexProposals(left: ScoredReverseSynctexProposal, right: ScoredReverseSynctexProposal): number {
	return left.geometryTier - right.geometryTier
		|| left.score - right.score
		|| (left.forwardLookupMode === "exact" ? -1 : 0) - (right.forwardLookupMode === "exact" ? -1 : 0)
		|| left.samePageBoxCount - right.samePageBoxCount
		|| left.rank - right.rank
		|| left.line - right.line
		|| left.sourceFile.localeCompare(right.sourceFile);
}

function compactProposalScore(proposal: ScoredReverseSynctexProposal): NonNullable<ReverseSynctexDiagnostics["proposalScores"]>[number] {
	return {
		kind: proposal.kind,
		provenance: proposal.provenance,
		sourceFile: proposal.sourceFile,
		line: proposal.line,
		column: proposal.column,
		geometryTier: proposal.geometryTier,
		score: proposal.score,
		precision: proposal.precision,
		samePageBoxCount: proposal.samePageBoxCount,
		containsClick: proposal.containsClick,
		structural: proposal.structural,
		clickContainmentBonus: proposal.clickContainmentBonus,
		textContainmentBonus: proposal.textContainmentBonus,
		...(proposal.textContainment === undefined ? {} : { textContainment: proposal.textContainment }),
		...(proposal.distance === undefined ? {} : { distance: proposal.distance }),
		...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
	};
}

function debugProposalScore(proposal: ScoredReverseSynctexProposal): ReverseSynctexProposalScore {
	return {
		...compactProposalScore(proposal),
		rank: proposal.rank,
		...(proposal.textStatus === undefined ? {} : { textStatus: proposal.textStatus }),
		...(proposal.forwardLookupMode === undefined ? {} : { forwardLookupMode: proposal.forwardLookupMode }),
		forwardGroupScores: proposal.debugForwardGroupScores ?? [],
	};
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

const NORMALIZABLE_SPAN_ENVIRONMENTS = new Set([
	"equation", "equation*", "align", "align*", "aligned", "aligned*", "alignedat", "alignedat*", "gather", "gather*", "multline", "multline*", "flalign", "flalign*", "split", "minipage",
]);

function spanEnvironmentToken(line: string, environment: string): "begin" | "end" | undefined {
	const escaped = environment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const trimmed = line.trim();
	if (new RegExp(`^\\\\end\\{${escaped}\\}\\s*(?:%.*)?$`).test(trimmed)) return "end";
	return new RegExp(`^\\\\begin\\{${escaped}\\}(?=\\s|\\[|\\{|%|$)`).test(trimmed) ? "begin" : undefined;
}

/**
 * Conservative lexical begin/end recognition for span metadata. This deliberately
 * does not attempt TeX macro expansion; it only pairs literal environment tokens.
 */
function spanEnvironmentAt(line: string): { environment: string; token: "begin" | "end" } | undefined {
	const trimmed = line.trim();
	const match = trimmed.match(/^\\(begin|end)\{([^{}\\]+)\}/);
	if (match === null) return undefined;
	const token = match[1] === "begin" || match[1] === "end" ? match[1] : undefined;
	const environment = match[2];
	if (token === undefined || environment === undefined || spanEnvironmentToken(line, environment) !== token) return undefined;
	return { environment, token };
}

function findEnvironmentSpan(lines: string[], lineIndex: number, environment: string, token: "begin" | "end"): { startLine: number; endLine: number; excerpt: string } | undefined {
	let depth = 0;
	const step = token === "end" ? -1 : 1;
	for (let index = lineIndex; index >= 0 && index < lines.length; index += step) {
		const currentToken = spanEnvironmentToken(lines[index] ?? "", environment);
		if (currentToken === token) depth += 1;
		else if (currentToken !== undefined) {
			depth -= 1;
			if (depth === 0) {
				const startIndex = Math.min(index, lineIndex);
				const endIndex = Math.max(index, lineIndex);
				return { startLine: startIndex + 1, endLine: endIndex + 1, excerpt: lines.slice(startIndex, endIndex + 1).join("\n") };
			}
		}
	}
	return undefined;
}

function findDisplayMathSpanFromClose(lines: string[], closeLineIndex: number): { startLine: number; endLine: number; excerpt: string } | undefined {
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

function findDisplayMathSpanFromOpen(lines: string[], openLineIndex: number): { startLine: number; endLine: number; excerpt: string } | undefined {
	let depth = 0;
	for (let index = openLineIndex; index < lines.length; index += 1) {
		const trimmed = (lines[index] ?? "").trim();
		if (trimmed === "\\[") depth += 1;
		else if (trimmed === "\\]") {
			depth -= 1;
			if (depth === 0) return { startLine: openLineIndex + 1, endLine: index + 1, excerpt: lines.slice(openLineIndex, index + 1).join("\n") };
		}
	}
	return undefined;
}

function isEscapedTeXBrace(line: string, charIndex: number): boolean {
	let slashCount = 0;
	for (let index = charIndex - 1; index >= 0 && line[index] === "\\"; index -= 1) {
		slashCount += 1;
	}
	return slashCount % 2 === 1;
}

function findLastUnescapedCloseBrace(line: string): number | undefined {
	for (let index = line.length - 1; index >= 0; index -= 1) {
		if (line[index] === "}" && !isEscapedTeXBrace(line, index)) return index;
	}
	return undefined;
}

function findBracedMacroSpanFromClose(lines: string[], closeLineIndex: number): { startLine: number; endLine: number; excerpt: string } | undefined {
	const closeLine = lines[closeLineIndex] ?? "";
	const closeBraceIndex = findLastUnescapedCloseBrace(closeLine);
	if (closeBraceIndex === undefined) return undefined;
	let depth = 1;
	for (let lineIndex = closeLineIndex; lineIndex >= 0; lineIndex -= 1) {
		const line = lines[lineIndex] ?? "";
		const startChar = lineIndex === closeLineIndex ? closeBraceIndex - 1 : line.length - 1;
		for (let charIndex = startChar; charIndex >= 0; charIndex -= 1) {
			const char = line[charIndex];
			if ((char !== "{" && char !== "}") || isEscapedTeXBrace(line, charIndex)) continue;
			if (char === "}") depth += 1;
			else {
				depth -= 1;
				if (depth === 0) {
					const startLine = lineIndex + 1;
					const endLine = closeLineIndex;
					if (endLine < startLine) return undefined;
					return { startLine, endLine, excerpt: lines.slice(lineIndex, closeLineIndex).join("\n") };
				}
			}
		}
	}
	return undefined;
}

function firstSpanContentLine(span: { startLine: number; endLine: number }, sourceLines: string[]): number | undefined {
	for (let line = span.startLine + 1; line <= span.endLine; line += 1) {
		const trimmed = (sourceLines[line - 1] ?? "").trim();
		if (!trimmed) continue;
		if (line === span.endLine && (trimmed === "\\]" || trimmed === "}" || spanEnvironmentAt(trimmed)?.token === "end")) continue;
		return line;
	}
	return undefined;
}

function sourceSpanForLine(sourceFile: string, line: number, sourceLines: string[] | undefined): { span: ReverseSynctexSourceSpan; excerpt: string; contentLine?: number } | undefined {
	if (sourceLines === undefined) return undefined;
	const lineIndex = line - 1;
	const sourceLine = sourceLines[lineIndex];
	if (sourceLine === undefined) return undefined;
	const trimmed = sourceLine.trim();
	const environment = spanEnvironmentAt(sourceLine);
	let span: { startLine: number; endLine: number; excerpt: string } | undefined;
	if (trimmed === "\\]") span = findDisplayMathSpanFromClose(sourceLines, lineIndex);
	else if (trimmed === "\\[") span = findDisplayMathSpanFromOpen(sourceLines, lineIndex);
	else if (trimmed === "}") span = findBracedMacroSpanFromClose(sourceLines, lineIndex);
	else span = environment === undefined ? undefined : findEnvironmentSpan(sourceLines, lineIndex, environment.environment, environment.token);
	if (span === undefined) return undefined;
	const normalizable = trimmed === "\\]" || trimmed === "\\[" || trimmed === "}" || (environment !== undefined && NORMALIZABLE_SPAN_ENVIRONMENTS.has(environment.environment));
	const contentLine = normalizable ? firstSpanContentLine(span, sourceLines) : undefined;
	return { span: { sourceFile, startLine: span.startLine, endLine: span.endLine }, excerpt: span.excerpt, ...(contentLine === undefined ? {} : { contentLine }) };
}

export function normalizedSourceSpansForLines(sourceFile: string, lines: readonly number[]): ReverseSynctexSourceSpan[] {
	const sourceLines = readSourceLines(sourceFile);
	return lines.map((line) => sourceSpanForLine(sourceFile, line, sourceLines)?.span ?? { sourceFile, startLine: line, endLine: line });
}

export function normalizedSourceSpanForLine(sourceFile: string, line: number): ReverseSynctexSourceSpan {
	return normalizedSourceSpansForLines(sourceFile, [line])[0] as ReverseSynctexSourceSpan;
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
		...(location.diagnostics.proposalScores === undefined ? {} : { proposalScores: location.diagnostics.proposalScores }),
		...(location.debugProposalScores === undefined ? {} : { debugProposalScores: location.debugProposalScores }),
		repairedWinner: { sourceFile: location.sourceFile, line: location.line, column: location.column, ...(location.sourceLine === undefined ? {} : { sourceLine: location.sourceLine }), precision: location.precision, ...(location.diagnostics.selected.score === undefined ? {} : { score: location.diagnostics.selected.score }) },
		...(location.diagnostics.forwardVerification === undefined ? {} : { forwardVerification: location.diagnostics.forwardVerification }),
		...(location.normalizedSourceSpan === undefined ? {} : { normalizedSourceSpan: location.normalizedSourceSpan }),
		...(location.normalizedSourceExcerpt === undefined ? {} : { normalizedSourceExcerpt: location.normalizedSourceExcerpt }),
		...(location.forwardLookupLine === undefined ? {} : { forwardLookupLine: location.forwardLookupLine }),
		...(location.forwardLookupMode === undefined ? {} : { forwardLookupMode: location.forwardLookupMode }),
		...(location.selectedForwardBox === undefined ? {} : { selectedForwardBox: location.selectedForwardBox }),
		...(location.selectedForwardRanges === undefined ? {} : { selectedForwardRanges: location.selectedForwardRanges }),
		...(location.forwardGroupScores === undefined ? {} : { forwardGroupScores: location.forwardGroupScores }),
		rect: rectFromDiagnostics(location.diagnostics),
		distanceFromCenter: 0,
	};
}

export function inspectReverseSynctexHover(input: {
	pdfPath: string;
	page: number;
	x: number;
	y: number;
	cwd: string;
	textBeforeSelection?: string;
	textAfterSelection?: string;
	pageHeight?: number;
	pdfTextSpans?: PdfTextSpan[];
	nativeRunner?: NativeSynctexRunner;
	inspectCandidates?: ReverseSynctexCandidateInspector;
	forwardBoxesForLine?: ReverseSynctexForwardBoxesForLine;
	synctexCommand?: string;
}): ReverseSynctexHoverInspection {
	return reverseLocationToHoverInspection(mapReverseSynctex(input));
}

export function mapReverseSynctex(input: {
	pdfPath: string;
	page: number;
	x: number;
	y: number;
	cwd: string;
	textBeforeSelection?: string;
	textAfterSelection?: string;
	pageHeight?: number;
	pdfTextSpans?: PdfTextSpan[];
	nativeRunner?: NativeSynctexRunner;
	jsFallback?: ReverseSynctexJsFallback;
	inspectCandidates?: ReverseSynctexCandidateInspector;
	forwardBoxesForLine?: ReverseSynctexForwardBoxesForLine;
	synctexCommand?: string;
	/** Retains bounded proposal/group/box arithmetic for an explicit debug probe only. */
	debugTrace?: boolean;
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
		if (input.jsFallback !== undefined && input.inspectCandidates === undefined) {
			jsResult = input.jsFallback(input.page, input.x, input.y, pdfPath);
		} else {
			candidateInspection = input.inspectCandidates === undefined
				? inspectSyncTeXToTeXCandidates(input.page, input.x, input.y, pdfPath, ...(input.pageHeight === undefined ? [] : [{ pageHeight: input.pageHeight }]))
				: input.inspectCandidates(input.page, input.x, input.y, pdfPath);
			jsResult = candidateInspection?.candidates[0] === undefined ? input.jsFallback?.(input.page, input.x, input.y, pdfPath) : candidateToMapped(candidateInspection.candidates[0]);
		}
		if (jsResult === undefined) {
			jsFailureReason = "no result";
			allowNativeFallback = true;
		} else if (candidateInspection !== undefined) {
			jsMapped = jsResult;
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
	const nativeCommand = input.synctexCommand ?? resolveExecutable("synctex");
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
	let sourceFile = rawSourceFile;
	let line = mapped.line;
	let column = mapped.column;
	let precision: ReverseSynctexPrecision = "line";
	let selectedProposalKind: ReverseSynctexProposal["kind"] | undefined = branch === "js" ? "ranked" : undefined;
	const hasSelectionContext = input.textBeforeSelection !== undefined || input.textAfterSelection !== undefined;
	let textRepair: ReverseSynctexDiagnostics["textRepair"] | undefined;
	let forwardVerification: ReverseSynctexDiagnostics["forwardVerification"] | undefined;
	let textRepairChangedLocation = false;
	let proposalScores: ReverseSynctexDiagnostics["proposalScores"] | undefined;
	let debugProposalScores: ReverseSynctexProposalScore[] | undefined;
	let selectedScore: number | undefined;
	let forwardLookup: { line: number; mode: ForwardSynctexLookupMode } | undefined;
	let selectedForwardBox: ForwardSynctexRange | undefined;
	let selectedForwardRanges: ForwardSynctexRange[] | undefined;
	let selectedForwardGroupScores: ReverseSynctexForwardGroupScore[] | undefined;

	if (branch === "js") {
		const proposals: ReverseSynctexProposal[] = [];
		const addProposal = (proposal: ReverseSynctexProposal): void => {
			const existingIndex = proposals.findIndex((existing) => existing.sourceFile === proposal.sourceFile && existing.line === proposal.line);
			if (existingIndex < 0) {
				proposals.push(proposal);
			} else if (proposal.provenance === "selection_text_context" && proposals[existingIndex]?.provenance !== "selection_text_context") {
				proposals[existingIndex] = { ...proposal, rank: proposals[existingIndex]?.rank ?? proposal.rank };
			}
		};
		let proposalRank = 0;
		if (candidateInspection !== undefined) {
			for (const candidate of candidateInspection.candidates) {
				const candidateSourceFile = resolveReverseMappedSourceFile(candidateToMapped(candidate), input.cwd);
				const candidateSourceLine = readSourceLine(candidateSourceFile, candidate.line, input.cwd) ?? candidate.sourceLine;
				if (proposals.some((proposal) => proposal.sourceFile === candidateSourceFile && proposal.line === candidate.line)) continue;
				addProposal({
					kind: "ranked",
					provenance: "synctex_reverse",
					rank: proposalRank++,
					sourceFile: candidateSourceFile,
					line: candidate.line,
					column: candidate.column,
					...(candidateSourceLine === undefined ? {} : { sourceLine: candidateSourceLine }),
					structural: candidate.structural || isStructuralReverseSourceLine(candidateSourceLine),
				});
				if (proposals.length >= MAX_REVERSE_SYNCTEX_CANDIDATE_PROPOSALS) break;
			}
		}
		if (proposals.length === 0) {
			addProposal({
				kind: "ranked",
				provenance: "synctex_reverse",
				rank: proposalRank++,
				sourceFile: rawSourceFile,
				line: rawMappedLine,
				column: rawMappedColumn,
				...(rawMappedSourceLine === undefined ? {} : { sourceLine: rawMappedSourceLine }),
				structural: isStructuralReverseSourceLine(rawMappedSourceLine),
			});
		}
		let textStatus: "unique" | "ambiguous-small" | undefined;
		let fullTextFragment: string | undefined;
		let partialTextFragment: string | undefined;
		if (hasSelectionContext) {
			const fragments = buildSourceSearchFragments(input.textBeforeSelection ?? "", input.textAfterSelection ?? "");
			fullTextFragment = buildFullTextContainmentContext(input.textBeforeSelection, input.textAfterSelection);
			partialTextFragment = buildPartialTextContainmentContext(input.textBeforeSelection, input.textAfterSelection);
			const matches = findSourceTextMatches(rawSourceFile, fragments);
			textRepair = {
				used: false,
				status: matches.status,
				fragmentsTried: matches.fragmentsTried,
				matchCount: matches.matchCount,
				...(matches.fragment === undefined ? {} : { selectedFragment: matches.fragment }),
			};
			if (matches.status === "unique" || matches.status === "ambiguous-small") {
				textStatus = matches.status;
				for (const match of matches.matches) {
					addProposal({
						kind: "text",
						provenance: "selection_text_context",
						rank: proposalRank++,
						sourceFile: match.sourceFile,
						line: match.line,
						column: match.column,
						...(match.sourceLine === undefined ? {} : { sourceLine: match.sourceLine }),
						structural: isStructuralReverseSourceLine(match.sourceLine),
						textStatus: matches.status,
					});
				}
			}
		}
		{
			const click = { page: input.page, x: input.x, y: input.y };
			const viableProposals = proposals.filter((proposal) => invalidReadableSourceLineReason({ input: proposal.sourceFile, line: proposal.line, column: proposal.column }, input.cwd) === undefined);
			const scored = viableProposals.map((proposal) => scoreReverseSynctexProposal({
				proposal,
				click,
				...(fullTextFragment === undefined ? {} : { fullTextFragment }),
				...(partialTextFragment === undefined ? {} : { partialTextFragment }),
				...(input.debugTrace === true ? { debugTrace: true } : {}),
				boxGroups: forwardBoxGroupsForSourceLine({
					sourceFile: proposal.sourceFile,
					line: proposal.line,
					pdfPath,
					cwd: input.cwd,
					click,
					...(input.pdfTextSpans === undefined ? {} : { pdfTextSpans: input.pdfTextSpans }),
					...(input.nativeRunner === undefined ? {} : { nativeRunner: input.nativeRunner }),
					...(input.forwardBoxesForLine === undefined ? {} : { forwardBoxesForLine: input.forwardBoxesForLine }),
					...(input.synctexCommand === undefined ? {} : { synctexCommand: input.synctexCommand }),
				}),
			})).sort(compareScoredReverseSynctexProposals);
			proposalScores = scored.map(compactProposalScore);
			if (input.debugTrace === true) debugProposalScores = scored.map(debugProposalScore);
			const selectedProposal = scored[0];
			if (selectedProposal !== undefined) {
				sourceFile = selectedProposal.sourceFile;
				line = selectedProposal.line;
				column = selectedProposal.column;
				precision = selectedProposal.precision;
				selectedScore = selectedProposal.score;
				selectedForwardBox = selectedProposal.chosenBox;
				selectedForwardRanges = selectedProposal.boxes;
					selectedForwardGroupScores = selectedProposal.forwardGroupScores;
				if (selectedProposal.forwardLookupLine !== undefined && selectedProposal.forwardLookupMode !== undefined) {
					forwardLookup = { line: selectedProposal.forwardLookupLine, mode: selectedProposal.forwardLookupMode };
				}
				selectedProposalKind = selectedProposal.kind;
				textRepairChangedLocation = selectedProposal.kind === "text" && !sameSourceLocation(selectedProposal, { sourceFile: rawSourceFile, line: rawMappedLine });
				if (selectedProposal.kind === "text" && textRepair !== undefined) {
					textRepair = { ...textRepair, used: true, line: selectedProposal.line, column: selectedProposal.column };
				}
				const textProposals = scored.filter((proposal) => proposal.kind === "text");
				const representativeTextProposal = selectedProposal.kind === "text" ? selectedProposal : textProposals[0];
				if (representativeTextProposal !== undefined || textStatus !== undefined) {
					const boxes = representativeTextProposal?.boxes ?? [];
					forwardVerification = {
						attempted: textStatus !== undefined,
						boxesConsidered: boxes.length,
						boxesFiltered: boxes.length,
						...(representativeTextProposal?.chosenBox === undefined ? {} : { chosenBox: representativeTextProposal.chosenBox }),
						containsClick: representativeTextProposal?.containsClick === true,
					};
				}
			} else {
				const native = runNativeReverseSynctex({ page: input.page, x: input.x, y: input.y, pdfPath, runner: input.nativeRunner ?? defaultNativeSynctexRunner, command: nativeCommand });
				let nativeFailureReason = native.failureReason;
				let nativeMapped = native.mapped;
				if (nativeMapped !== undefined) {
					const invalidReason = invalidReadableSourceLineReason(nativeMapped, input.cwd) ?? lowQualityNativeReverseSourceLineReason(nativeMapped, input.cwd);
					if (invalidReason !== undefined) {
						nativeFailureReason = invalidReason;
						nativeMapped = undefined;
					}
				}
				nativeDiagnostics = { ...native.diagnostics, attempted: true, role: "fallback", ...(nativeFailureReason === undefined ? {} : { failureReason: nativeFailureReason }) };
				if (nativeMapped === undefined) {
					throw new Error(`No SyncTeX mapping found for page ${input.page} at ${input.x},${input.y}; primary JS lookup yielded no viable proposals; native fallback returned ${nativeFailureReason ?? "no usable result"}`);
				}
				branch = "native_fallback";
				sourceFile = resolveReverseMappedSourceFile(nativeMapped, input.cwd);
				line = nativeMapped.line;
				column = nativeMapped.column;
				precision = "line";
				selectedProposalKind = undefined;
			}
		}
	}

	const sourceLines = readSourceLines(sourceFile);
	if (column === 0 && hasSelectionContext && sourceLines !== undefined && !textRepairChangedLocation) {
		if (selectedProposalKind === "ranked") {
			column = getColumnBySurroundingText(sourceLines[line - 1] ?? "", input.textBeforeSelection ?? "", input.textAfterSelection ?? "") ?? column;
		} else {
			const [row, col] = getRowAndColumn(sourceLines, line - 1, input.textBeforeSelection ?? "", input.textAfterSelection ?? "");
			line = row + 1;
			column = col;
		}
	}
	const sourceLine = readSourceLine(sourceFile, line, input.cwd);
	const normalizedSource = sourceSpanForLine(sourceFile, line, sourceLines);
	const candidates: ReverseSynctexDiagnostics["candidates"] = [{
		sourceFile: rawSourceFile,
		line: rawMappedLine,
		column: rawMappedColumn,
		...(rawMappedSourceLine === undefined ? {} : { sourceLine: rawMappedSourceLine }),
		kind: "initial_candidate",
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
	if (normalizedSource !== undefined) {
		candidates.push({
			sourceFile: normalizedSource.span.sourceFile,
			line: normalizedSource.span.startLine,
			column: 0,
			sourceLine: normalizedSource.excerpt,
			kind: "source_span",
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
			...(selectedScore === undefined ? {} : { score: selectedScore }),
		},
		precision,
		...(candidateInspection === undefined ? {} : { rawWinner: compactReverseCandidate(candidateInspection.rawWinner, input.cwd, proposalScores), topCandidates: candidateInspection.candidates.map((candidate) => compactReverseCandidate(candidate, input.cwd, proposalScores)) }),
		...(textRepair === undefined ? {} : { textRepair }),
		...(forwardVerification === undefined ? {} : { forwardVerification }),
		...(proposalScores === undefined ? {} : { proposalScores }),
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
		...(line === rawMappedLine && column === rawMappedColumn && sourceFile === rawSourceFile && normalizedSource === undefined ? {} : {
			rawMappedSourceFile: rawSourceFile,
			rawMappedLine,
			rawMappedColumn,
			...(rawMappedSourceLine === undefined ? {} : { rawMappedSourceLine }),
		}),
		...(normalizedSource === undefined ? {} : {
			normalizedSourceSpan: normalizedSource.span,
			normalizedSourceExcerpt: normalizedSource.excerpt,
		}),
		...(forwardLookup === undefined ? {} : { forwardLookupLine: forwardLookup.line, forwardLookupMode: forwardLookup.mode }),
		...(selectedForwardBox === undefined ? {} : { selectedForwardBox }),
		...(selectedForwardRanges === undefined ? {} : { selectedForwardRanges }),
		...(selectedForwardGroupScores === undefined ? {} : { forwardGroupScores: selectedForwardGroupScores }),
		...(debugProposalScores === undefined ? {} : { debugProposalScores }),
		diagnostics,
	};
}

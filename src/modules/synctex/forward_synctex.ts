import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
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

export type ForwardSynctexBranch = "native" | "js_fallback";

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
}

export interface ForwardSynctexRange {
	page: number;
	h: number;
	v: number;
	W: number;
	H: number;
}

export interface NativeSynctexRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export type NativeSynctexRunner = (command: string, args: string[], options: { cwd: string }) => NativeSynctexRunResult;
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

export interface MapForwardSynctexInput {
	pdfPath: string;
	sourceFile: string;
	line: number;
	cwd: string;
	nativeRunner?: NativeSynctexRunner;
	jsFallback?: ForwardSynctexJsFallback;
	synctexCommand?: string;
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

function runNativeForwardSynctex(input: { line: number; sourceFile: string; pdfPath: string; runner: NativeSynctexRunner; command: string }): { mapped?: ForwardSynctexPoint; failureReason?: string } {
	const args = ["view", "-i", `${input.line}:1:${input.sourceFile}`, "-o", input.pdfPath];
	const result = input.runner(input.command, args, { cwd: dirname(input.pdfPath) });
	if (result.error) return { failureReason: result.error.message };
	if (result.status !== 0) return { failureReason: `exit status ${String(result.status)}${result.stderr ? `: ${result.stderr.trim()}` : ""}` };
	const mapped = parseNativeForwardResult(result.stdout);
	return mapped === undefined ? { failureReason: "no usable result" } : { mapped };
}

function withForwardGlue(input: { mapped: ForwardSynctexPoint; branch: ForwardSynctexBranch; sourceFile: string; line: number; sourceLine: string; sidecarPath: string }): ForwardSynctexJump {
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
	};
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
		return withForwardGlue({ mapped: native.mapped, branch: "native", sourceFile, line: input.line, sourceLine, sidecarPath });
	}

	let mapped;
	const previousCwd = process.cwd();
	try {
		process.chdir(input.cwd);
		mapped = (input.jsFallback ?? syncTeXToPDF)(input.line, sourceFile, pdfPath);
	} catch {
		mapped = undefined;
	} finally {
		process.chdir(previousCwd);
	}
	if (mapped === undefined) {
		throw new Error(`No usable SyncTeX mapping found for ${sourcePathLabel(sourceFile)}:${input.line}; native synctex view returned ${native.failureReason ?? "no usable result"}; JS fallback returned no result`);
	}

	return withForwardGlue({ mapped, branch: "js_fallback", sourceFile, line: input.line, sourceLine, sidecarPath });
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

function readSourceLines(sourceFile: string): string[] | undefined {
	try {
		return readFileSync(sourceFile, "utf8").split(/\r?\n/);
	} catch {
		return undefined;
	}
}

export function mapReverseSynctex(input: {
	pdfPath: string;
	page: number;
	x: number;
	y: number;
	cwd: string;
	textBeforeSelection?: string;
	textAfterSelection?: string;
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
	let line = mapped.line;
	let column = mapped.column;
	const hasSelectionContext = input.textBeforeSelection !== undefined || input.textAfterSelection !== undefined;
	if (column === 0 && hasSelectionContext) {
		const sourceLines = readSourceLines(sourceFile);
		if (sourceLines !== undefined) {
			const [row, col] = getRowAndColumn(sourceLines, line - 1, input.textBeforeSelection ?? "", input.textAfterSelection ?? "");
			line = row + 1;
			column = col;
		}
	}
	const sourceLine = readSourceLine(sourceFile, line, input.cwd);
	return {
		page: input.page,
		x: input.x,
		y: input.y,
		sourceFile,
		line,
		column,
		...(sourceLine === undefined ? {} : { sourceLine }),
		sidecarPath,
	};
}

import { spawnSync } from "node:child_process";
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
	sourceFile: string;
	line: number;
	sourceLine: string;
	sidecarPath: string;
	branch: ForwardSynctexBranch;
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

function parseNativeForwardPoint(stdout: string): ForwardSynctexPoint | undefined {
	const record: { page?: number; x?: number; y?: number } = {};
	let started = false;
	for (const line of stdout.split("\n")) {
		if (line.includes("SyncTeX result begin")) {
			started = true;
			continue;
		}
		if (line.includes("SyncTeX result end")) break;
		if (!started) continue;
		const pos = line.indexOf(":");
		if (pos < 0) continue;
		const key = line.substring(0, pos).toLowerCase();
		if (key !== "page" && key !== "x" && key !== "y") continue;
		const value = Number(line.substring(pos + 1));
		if (Number.isFinite(value)) record[key] = value;
	}
	if (record.page === undefined || record.x === undefined || record.y === undefined) return undefined;
	return { page: record.page, x: record.x, y: record.y, indicator: true };
}

function runNativeForwardSynctex(input: { line: number; sourceFile: string; pdfPath: string; runner: NativeSynctexRunner; command: string }): { mapped?: ForwardSynctexPoint; failureReason?: string } {
	const args = ["view", "-i", `${input.line}:1:${input.sourceFile}`, "-o", input.pdfPath];
	const result = input.runner(input.command, args, { cwd: dirname(input.pdfPath) });
	if (result.error) return { failureReason: result.error.message };
	if (result.status !== 0) return { failureReason: `exit status ${String(result.status)}${result.stderr ? `: ${result.stderr.trim()}` : ""}` };
	const mapped = parseNativeForwardPoint(result.stdout);
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

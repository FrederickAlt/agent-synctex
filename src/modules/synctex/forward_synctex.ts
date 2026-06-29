import { existsSync, readFileSync, realpathSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { readSourceLine } from "./source_line.ts";

// Self-authored forward SyncTeX mapper for PDF.js jumps. It intentionally does not copy
// LaTeX-Workshop code; the parser below implements the subset of SyncTeX semantics this
// service needs: input path normalization, offsets, page elements, line aggregation, and
// nearest/interpolated line lookup.
const SCALED_POINTS_PER_POINT = 65_536;
const MAX_NEAREST_LINE_DISTANCE = 2;
const FALLBACK_FORWARD_HIGHLIGHT_HEIGHT_POINTS = 10;

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
	width: number;
	height: number;
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

interface SynctexInputRecord {
	tag: number;
	path: string;
	canonicalPaths: Set<string>;
}

interface SynctexPositionRecord {
	page: number;
	tag: number;
	line: number;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	depth: number;
	primary: boolean;
}

interface SynctexLineAggregate {
	line: number;
	page: number;
	x: number;
	y: number;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface ParsedSynctex {
	inputs: Map<number, SynctexInputRecord>;
	positions: SynctexPositionRecord[];
}

export function resolveSynctexSidecar(pdfPath: string): string | undefined {
	const normalizedPdfPath = resolve(pdfPath);
	const basePath = normalizedPdfPath.toLowerCase().endsWith(".pdf")
		? normalizedPdfPath.slice(0, -extname(normalizedPdfPath).length)
		: normalizedPdfPath;
	for (const candidate of [`${basePath}.synctex.gz`, `${basePath}.synctex`]) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function readSynctexSidecar(sidecarPath: string): string {
	try {
		const contents = readFileSync(sidecarPath);
		return sidecarPath.endsWith(".gz") ? gunzipSync(contents).toString("utf8") : contents.toString("utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read SyncTeX sidecar ${sidecarPath}: ${message}`);
	}
}

function decodeSynctexPath(rawPath: string): string {
	try {
		return decodeURIComponent(rawPath);
	} catch {
		return rawPath;
	}
}

function canonicalFilePath(path: string): string {
	const resolvedPath = resolve(path);
	try {
		return realpathSync.native(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

function scaledPointToPdfPoint(value: number, unit: number): number {
	const points = (value * unit) / SCALED_POINTS_PER_POINT;
	return Math.round(points * 1000) / 1000;
}

function uniqueResolvedPaths(inputPath: string, pdfDirectory: string, cwd: string): string[] {
	const candidates = isAbsolute(inputPath)
		? [resolve(inputPath)]
		: [resolve(cwd, inputPath), resolve(pdfDirectory, inputPath)];
	return [...new Set(candidates)];
}

function isPrimaryPositionType(type: string): boolean {
	// Containers (`[` and `(`) and kern records (`k`) commonly use nearby structural
	// source lines. Prefer rendered glyph/glue/list/rule points for forward search.
	return type !== "[" && type !== "(" && type !== "k";
}

function parseSynctexText(text: string, pdfDirectory: string, cwd: string): ParsedSynctex {
	const inputs = new Map<number, SynctexInputRecord>();
	const positions: SynctexPositionRecord[] = [];
	let page: number | undefined;
	let unit = 1;
	let xOffset = 0;
	let yOffset = 0;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const unitMatch = /^Unit:([0-9.]+)$/.exec(line);
		if (unitMatch) {
			const parsedUnit = Number(unitMatch[1]);
			if (Number.isFinite(parsedUnit) && parsedUnit > 0) unit = parsedUnit;
			continue;
		}
		const xOffsetMatch = /^X Offset:(-?\d+)$/.exec(line);
		if (xOffsetMatch) {
			xOffset = Number(xOffsetMatch[1]);
			continue;
		}
		const yOffsetMatch = /^Y Offset:(-?\d+)$/.exec(line);
		if (yOffsetMatch) {
			yOffset = Number(yOffsetMatch[1]);
			continue;
		}

		const inputMatch = /^Input:(\d+):(.+)$/.exec(line);
		if (inputMatch) {
			const tag = Number(inputMatch[1]);
			const inputPath = decodeSynctexPath(inputMatch[2].trim());
			const resolvedPaths = uniqueResolvedPaths(inputPath, pdfDirectory, cwd);
			inputs.set(tag, {
				tag,
				path: resolvedPaths[0],
				canonicalPaths: new Set(resolvedPaths.map(canonicalFilePath)),
			});
			continue;
		}

		const pageMatch = /^\{(\d+)/.exec(line);
		if (pageMatch) {
			page = Number(pageMatch[1]);
			continue;
		}
		if (/^}\d*$/.test(line)) {
			page = undefined;
			continue;
		}

		const positionMatch = /^([\[(A-Za-z$])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/.exec(line);
		if (!positionMatch || page === undefined) continue;
		const type = positionMatch[1];
		positions.push({
			page,
			type,
			tag: Number(positionMatch[2]),
			line: Number(positionMatch[3]),
			x: scaledPointToPdfPoint(Number(positionMatch[4]) + xOffset, unit),
			y: scaledPointToPdfPoint(Number(positionMatch[5]) + yOffset, unit),
			width: scaledPointToPdfPoint(Number(positionMatch[6] ?? 0), unit),
			height: scaledPointToPdfPoint(Number(positionMatch[7] ?? 0), unit),
			depth: scaledPointToPdfPoint(Number(positionMatch[8] ?? 0), unit),
			primary: isPrimaryPositionType(type),
		});
	}

	return { inputs, positions };
}

function sourcePathLabel(sourceFile: string): string {
	return basename(sourceFile) || sourceFile;
}

function aggregateLinePositions(positions: SynctexPositionRecord[], matchingTags: Set<number>, primaryOnly: boolean): SynctexLineAggregate[] {
	const byLine = new Map<number, SynctexLineAggregate>();
	for (const position of positions) {
		if (!matchingTags.has(position.tag)) continue;
		if (primaryOnly && !position.primary) continue;
		const width = Math.max(0, position.width);
		const height = Math.max(0, position.height);
		const depth = Math.max(0, position.depth);
		const minX = position.x;
		const maxX = position.x + width;
		// SyncTeX Y is a top-origin baseline; height extends above it and depth below it.
		const minY = position.y - height;
		const maxY = position.y + depth;
		const aggregate = byLine.get(position.line);
		if (!aggregate) {
			byLine.set(position.line, {
				line: position.line,
				page: position.page,
				x: minX,
				y: minY,
				minX,
				minY,
				maxX,
				maxY,
			});
			continue;
		}
		aggregate.minX = Math.min(aggregate.minX, minX);
		aggregate.minY = Math.min(aggregate.minY, minY);
		aggregate.maxX = Math.max(aggregate.maxX, maxX);
		aggregate.maxY = Math.max(aggregate.maxY, maxY);
		aggregate.x = aggregate.minX;
		aggregate.y = aggregate.minY;
	}
	return [...byLine.values()].sort((left, right) => left.line - right.line);
}

function interpolateLine(targetLine: number, lower: SynctexLineAggregate, upper: SynctexLineAggregate): SynctexLineAggregate {
	if (lower.page !== upper.page) {
		return targetLine - lower.line <= upper.line - targetLine ? lower : upper;
	}
	const ratio = (targetLine - lower.line) / (upper.line - lower.line);
	return {
		line: targetLine,
		page: lower.page,
		x: Math.round((lower.x + ((upper.x - lower.x) * ratio)) * 1000) / 1000,
		y: Math.round((lower.y + ((upper.y - lower.y) * ratio)) * 1000) / 1000,
		minX: Math.round((lower.minX + ((upper.minX - lower.minX) * ratio)) * 1000) / 1000,
		minY: Math.round((lower.minY + ((upper.minY - lower.minY) * ratio)) * 1000) / 1000,
		maxX: Math.round((lower.maxX + ((upper.maxX - lower.maxX) * ratio)) * 1000) / 1000,
		maxY: Math.round((lower.maxY + ((upper.maxY - lower.maxY) * ratio)) * 1000) / 1000,
	};
}

function selectLinePosition(linePositions: SynctexLineAggregate[], targetLine: number, allowExact = true): SynctexLineAggregate | undefined {
	const exact = allowExact ? linePositions.find((candidate) => candidate.line === targetLine) : undefined;
	if (exact) return exact;

	let lower: SynctexLineAggregate | undefined;
	let upper: SynctexLineAggregate | undefined;
	for (const candidate of linePositions) {
		if (candidate.line < targetLine) lower = candidate;
		if (candidate.line > targetLine) {
			upper = candidate;
			break;
		}
	}
	if (lower && upper) return interpolateLine(targetLine, lower, upper);

	const nearest = linePositions
		.map((candidate) => ({ candidate, distance: Math.abs(candidate.line - targetLine) }))
		.sort((left, right) => left.distance - right.distance)[0];
	return nearest && nearest.distance <= MAX_NEAREST_LINE_DISTANCE ? nearest.candidate : undefined;
}

function distanceToPosition(position: SynctexPositionRecord, x: number, y: number): number {
	const minX = position.x;
	const maxX = position.x + Math.max(0, position.width);
	const minY = position.y;
	const maxY = position.y + Math.max(0, position.height) + Math.max(0, position.depth);
	const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
	const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
	return Math.hypot(dx, dy);
}

function estimateColumn(sourceLine: string | undefined, aggregate: SynctexLineAggregate | undefined, x: number): number {
	if (!sourceLine || !aggregate || aggregate.maxX <= aggregate.minX) return 1;
	const ratio = Math.max(0, Math.min(1, (x - aggregate.minX) / (aggregate.maxX - aggregate.minX)));
	return Math.max(1, Math.min(sourceLine.length + 1, Math.round(ratio * sourceLine.length) + 1));
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
	const canonicalSourceFile = canonicalFilePath(sourceFile);
	const parsed = parseSynctexText(readSynctexSidecar(sidecarPath), dirname(pdfPath), input.cwd);
	const matchingTags = new Set<number>();
	for (const record of parsed.inputs.values()) {
		if (record.canonicalPaths.has(canonicalSourceFile)) matchingTags.add(record.tag);
	}
	if (matchingTags.size === 0) {
		throw new Error(`No SyncTeX input record matched source_file ${sourceFile}`);
	}

	const sourceLine = readSourceLine(sourceFile, input.line, input.cwd);
	if (sourceLine === undefined) {
		throw new Error(`Cannot read source_file line ${sourceFile}:${input.line}`);
	}

	const allowExact = sourceLine.trim().length > 0;
	const primaryLinePositions = aggregateLinePositions(parsed.positions, matchingTags, true);
	const fallbackLinePositions = aggregateLinePositions(parsed.positions, matchingTags, false);
	const position = selectLinePosition(primaryLinePositions, input.line, allowExact)
		?? (allowExact ? fallbackLinePositions.find((candidate) => candidate.line === input.line) : undefined);
	if (!position) {
		throw new Error(`No SyncTeX mapping found for ${sourcePathLabel(sourceFile)}:${input.line}`);
	}

	const verticalPosition = allowExact
		? (fallbackLinePositions.find((candidate) => candidate.page === position.page && candidate.line === position.line) ?? position)
		: position;
	const rawHeight = Math.max(0, verticalPosition.maxY - verticalPosition.minY);
	const height = Math.max(FALLBACK_FORWARD_HIGHLIGHT_HEIGHT_POINTS, rawHeight);

	return {
		page: position.page,
		x: position.x,
		y: rawHeight > 0 ? verticalPosition.minY : position.y - height,
		width: Math.max(0, position.maxX - position.minX),
		height,
		sourceFile,
		line: input.line,
		sourceLine,
		sidecarPath,
	};
}

export function mapReverseSynctex(input: { pdfPath: string; page: number; x: number; y: number; cwd: string }): ReverseSynctexLocation {
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

	const parsed = parseSynctexText(readSynctexSidecar(sidecarPath), dirname(pdfPath), input.cwd);
	const pagePositions = parsed.positions.filter((position) => position.page === input.page && parsed.inputs.has(position.tag));
	const candidates = pagePositions.filter((position) => position.primary);
	const pool = candidates.length > 0 ? candidates : pagePositions;
	const nearest = pool
		.map((position) => ({ position, distance: distanceToPosition(position, input.x, input.y) }))
		.sort((left, right) => left.distance - right.distance)[0]?.position;
	if (!nearest) {
		throw new Error(`No SyncTeX mapping found for page ${input.page} at ${input.x},${input.y}`);
	}
	const sourceFile = parsed.inputs.get(nearest.tag)?.path;
	if (!sourceFile) {
		throw new Error(`No SyncTeX input record matched tag ${nearest.tag}`);
	}
	const sourceLine = readSourceLine(sourceFile, nearest.line, input.cwd);
	const lineAggregate = aggregateLinePositions(parsed.positions, new Set([nearest.tag]), false)
		.find((candidate) => candidate.page === nearest.page && candidate.line === nearest.line);
	return {
		page: input.page,
		x: input.x,
		y: input.y,
		sourceFile,
		line: nearest.line,
		column: estimateColumn(sourceLine, lineAggregate, input.x),
		...(sourceLine === undefined ? {} : { sourceLine }),
		sidecarPath,
	};
}

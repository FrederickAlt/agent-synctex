/*
The MIT License (MIT)

Copyright (c) 2016 James Yu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Adapted from LaTeX-Workshop synctex_impl/src/locate/synctex/worker.ts.
*/

import * as fs from "node:fs";
import * as iconv from "iconv-lite";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { type Block, type PdfSyncObject, parseSyncTex } from "./synctexjs.ts";
import { iconvLiteSupportedEncodings } from "./convertfilename.ts";
import { isSameRealPath } from "./pathnormalize.ts";

export interface SyncTeXRecordToPDF {
	page: number;
	x: number;
	y: number;
	indicator?: boolean;
}

export interface SyncTeXRecordToTeX {
	input: string;
	line: number;
	column: number;
}

export interface SyncTeXInspectionRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface SyncTeXInspectionRecordToTeX extends SyncTeXRecordToTeX {
	rect: SyncTeXInspectionRect;
	distanceFromCenter: number;
}

export interface ReverseSyncTeXCandidate extends SyncTeXRecordToTeX {
	sourceLine?: string;
	rect: SyncTeXInspectionRect;
	distanceX: number;
	distanceY: number;
	distance: number;
	area: number;
	containsClick: boolean;
	structural: boolean;
	structuralReason?: string;
	areaPenalty: number;
	structuralPenalty: number;
	score: number;
}

export interface ReverseSyncTeXCandidatesInspection {
	winner: ReverseSyncTeXCandidate;
	rawWinner: ReverseSyncTeXCandidate;
	candidates: ReverseSyncTeXCandidate[];
}

export interface ReverseSyncTeXCandidatesOptions {
	minCandidates?: number;
	maxCandidates?: number;
	minDistance?: number;
	structuralPenalty?: number;
	enrichSourceLines?: boolean;
}

const DEFAULT_REVERSE_CANDIDATE_OPTIONS = {
	minCandidates: 8,
	maxCandidates: 40,
	minDistance: 12,
	structuralPenalty: 1000,
};

const STRUCTURAL_SOURCE_LINES = new Set(["\\end{document}", "\\newpage", "\\end{minipage}", "\\end{figure}", "\\begin{document}"]);

export class Rectangle {
	readonly top: number;
	readonly bottom: number;
	readonly left: number;
	readonly right: number;

	constructor({ top, bottom, left, right }: { top: number; bottom: number; left: number; right: number }) {
		this.top = top;
		this.bottom = bottom;
		this.left = left;
		this.right = right;
	}

	include(rect: Rectangle): boolean {
		return this.left <= rect.left && this.right >= rect.right && this.bottom >= rect.bottom && this.top <= rect.top;
	}

	distanceX(x: number): number {
		return this.left <= x && x <= this.right ? 0 : Math.min(Math.abs(this.left - x), Math.abs(this.right - x));
	}

	distanceY(y: number): number {
		return this.top <= y && y <= this.bottom ? 0 : Math.min(Math.abs(this.bottom - y), Math.abs(this.top - y));
	}

	containsPoint(x: number, y: number): boolean {
		return this.left <= x && x <= this.right && this.top <= y && y <= this.bottom;
	}

	distanceXY(x: number, y: number): number {
		return Math.sqrt(Math.pow(this.distanceY(y), 2) + Math.pow(this.distanceX(x), 2));
	}

	distanceFromCenter(x: number, y: number): number {
		return Math.sqrt(Math.pow((this.left + this.right) / 2 - x, 2) + Math.pow((this.bottom + this.top) / 2 - y, 2));
	}
}

export function getBlocks(linePageBlocks: { [inputLineNum: number]: { [pageNum: number]: Block[] } }, lineNum: number): Block[] {
	const pageBlocks = linePageBlocks[lineNum];
	const pageNums = Object.keys(pageBlocks);
	if (pageNums.length === 0) {
		return [];
	}
	const page = pageNums[0];
	return pageBlocks[Number(page)];
}

export function toRect(blocks: Block): Rectangle;
export function toRect(blocks: Block[]): Rectangle;
export function toRect(blocks: Block | Block[]): Rectangle {
	if (!Array.isArray(blocks)) {
		const block = blocks;
		const top = block.bottom - block.height;
		const bottom = block.bottom;
		const left = block.left;
		const right = block.width ? block.left + block.width : block.left;
		return new Rectangle({ top, bottom, left, right });
	} else {
		let cTop = 2e16;
		let cBottom = 0;
		let cLeft = 2e16;
		let cRight = 0;

		for (const b of blocks) {
			// Skip a block if they have boxes inside, or their type is kern or rule.
			// See also https://github.com/jlaurens/synctex/blob/2017/synctex_parser.c#L4655 for types.
			if (b.elements !== undefined || b.type === "k" || b.type === "r") {
				continue;
			}
			cBottom = Math.max(b.bottom, cBottom);
			const top = b.bottom - b.height;
			cTop = Math.min(top, cTop);
			cLeft = Math.min(b.left, cLeft);
			if (b.width !== undefined) {
				const right = b.left + b.width;
				cRight = Math.max(right, cRight);
			}
		}
		return new Rectangle({ top: cTop, bottom: cBottom, left: cLeft, right: cRight });
	}
}

export interface ParsedSyncTexForPdf {
	pdfSyncObject: PdfSyncObject;
	sidecarPath: string;
}

export function resolveLatexWorkshopSynctexSidecar(pdfPath: string): string | undefined {
	const synctexPath = pdfPath.slice(0, -path.extname(pdfPath).length) + ".synctex";
	if (fs.existsSync(synctexPath)) return synctexPath;
	const synctexGzPath = `${synctexPath}.gz`;
	if (fs.existsSync(synctexGzPath)) return synctexGzPath;
	return undefined;
}

const parsedSyncTexCache = new Map<string, { sidecarPath: string; mtimeMs: number; size: number; parsed: ParsedSyncTexForPdf | undefined }>();

export function parseSyncTexForPdf(pdfPath: string): ParsedSyncTexForPdf | undefined {
	const sidecarPath = resolveLatexWorkshopSynctexSidecar(pdfPath);
	if (sidecarPath === undefined) return undefined;
	const status = fs.statSync(sidecarPath);
	const cacheKey = path.resolve(pdfPath);
	const cached = parsedSyncTexCache.get(cacheKey);
	if (cached && cached.sidecarPath === sidecarPath && cached.mtimeMs === status.mtimeMs && cached.size === status.size) {
		return cached.parsed;
	}
	const data = fs.readFileSync(sidecarPath);
	const body = sidecarPath.endsWith(".gz") ? zlib.gunzipSync(data).toString("binary") : data.toString("utf8");
	const pdfSyncObject = parseSyncTex(body);
	const parsed = pdfSyncObject === undefined ? undefined : { pdfSyncObject, sidecarPath };
	parsedSyncTexCache.set(cacheKey, { sidecarPath, mtimeMs: status.mtimeMs, size: status.size, parsed });
	return parsed;
}

export function findInputFilePathForward(filePath: string, pdfSyncObject: PdfSyncObject): string | undefined {
	for (const inputFilePath in pdfSyncObject.blockNumberLine) {
		try {
			if (isSameRealPath(inputFilePath, filePath)) {
				return inputFilePath;
			}
		} catch { }
	}
	for (const inputFilePath in pdfSyncObject.blockNumberLine) {
		for (const enc of iconvLiteSupportedEncodings) {
			let convertedInputFilePath = "";
			try {
				convertedInputFilePath = iconv.decode(Buffer.from(inputFilePath, "binary"), enc);
				if (isSameRealPath(convertedInputFilePath, filePath)) {
					return inputFilePath;
				}
			} catch { }
		}
	}
	return;
}

export function syncTeXToPDF(line: number, filePath: string, pdfPath: string): SyncTeXRecordToPDF | undefined {
	const parsed = parseSyncTexForPdf(pdfPath);
	if (!parsed) {
		return undefined;
	}
	const inputFilePath = findInputFilePathForward(filePath, parsed.pdfSyncObject);
	if (inputFilePath === undefined) {
		return undefined;
	}

	const linePageBlocks = parsed.pdfSyncObject.blockNumberLine[inputFilePath];
	const lineNums = Object.keys(linePageBlocks).map((x) => Number(x)).sort((a, b) => { return (a - b); });
	const i = lineNums.findIndex((x) => x >= line);
	if (i === 0 || lineNums[i] === line) {
		const l = lineNums[i];
		const blocks = getBlocks(linePageBlocks, l);
		const c = toRect(blocks);
		return { page: blocks[0].page, x: c.left + parsed.pdfSyncObject.offset.x, y: c.bottom + parsed.pdfSyncObject.offset.y, indicator: true };
	}
	const line0 = lineNums[i - 1];
	const blocks0 = getBlocks(linePageBlocks, line0);
	const c0 = toRect(blocks0);
	const line1 = lineNums[i];
	const blocks1 = getBlocks(linePageBlocks, line1);
	const c1 = toRect(blocks1);
	let bottom: number;
	if (c0.bottom < c1.bottom) {
		bottom = c0.bottom * (line1 - line) / (line1 - line0) + c1.bottom * (line - line0) / (line1 - line0);
	} else {
		bottom = c1.bottom;
	}
	return { page: blocks1[0].page, x: c1.left + parsed.pdfSyncObject.offset.x, y: bottom + parsed.pdfSyncObject.offset.y, indicator: true };
}

function structuralSourceLineReason(sourceLine: string | undefined): string | undefined {
	const trimmed = sourceLine?.trim();
	return trimmed !== undefined && STRUCTURAL_SOURCE_LINES.has(trimmed) ? trimmed : undefined;
}

function compareReverseCandidates(a: ReverseSyncTeXCandidate, b: ReverseSyncTeXCandidate): number {
	return a.score - b.score
		|| a.distance - b.distance
		|| a.distanceY - b.distanceY
		|| a.distanceX - b.distanceX
		|| a.area - b.area
		|| a.line - b.line;
}

interface RawReverseCandidateRecord {
	input: string;
	line: number;
	rect: Rectangle;
	distanceFromCenter: number;
}

function scanRawReverseWinner(pdfSyncObject: PdfSyncObject, page: number, x: number, y: number): RawReverseCandidateRecord | undefined {
	const y0 = y - pdfSyncObject.offset.y;
	const x0 = x - pdfSyncObject.offset.x;
	const fileNames = Object.keys(pdfSyncObject.blockNumberLine);
	if (fileNames.length === 0) return undefined;

	const record = {
		input: "",
		line: 0,
		distanceFromCenter: 2e16,
		rect: new Rectangle({ top: 0, bottom: 2e16, left: 0, right: 2e16 }),
	};

	for (const fileName of fileNames) {
		const linePageBlocks = pdfSyncObject.blockNumberLine[fileName];
		for (const lineNum in linePageBlocks) {
			const pageBlocks = linePageBlocks[Number(lineNum)];
			for (const pageNum in pageBlocks) {
				if (page !== Number(pageNum)) continue;
				const blocks = pageBlocks[Number(pageNum)];
				for (const block of blocks) {
					// Skip a block if they have boxes inside, or their type is kern or rule.
					// See also https://github.com/jlaurens/synctex/blob/c11fe00dbdc6423a0e54d4e531563be645f78679/synctex_parser.c#L4706-L4727 for types.
					if (block.elements !== undefined || block.type === "k" || block.type === "r") continue;
					const rect = toRect(block);
					const distFromCenter = rect.distanceFromCenter(x0, y0);
					if (record.rect.include(rect) || (distFromCenter < record.distanceFromCenter && !rect.include(record.rect))) {
						record.input = fileName;
						record.line = Number(lineNum);
						record.distanceFromCenter = distFromCenter;
						record.rect = rect;
					}
				}
			}
		}
	}

	return record.input === "" ? undefined : record;
}

function readSourceLinesForCandidate(inputFilePath: string, resolvedInputs: Map<string, string | undefined>, sourceLinesByInput: Map<string, string[] | undefined>): string[] | undefined {
	if (sourceLinesByInput.has(inputFilePath)) return sourceLinesByInput.get(inputFilePath);
	let lines: string[] | undefined;
	const input = resolvedInputs.get(inputFilePath);
	if (input !== undefined) {
		try {
			lines = fs.readFileSync(input, "utf8").split(/\r?\n/);
		} catch { }
	}
	sourceLinesByInput.set(inputFilePath, lines);
	return lines;
}

export function collectReverseSyncTeXCandidatesFromParsed(pdfSyncObject: PdfSyncObject, page: number, x: number, y: number, options: ReverseSyncTeXCandidatesOptions = {}): ReverseSyncTeXCandidatesInspection | undefined {
	const minCandidates = options.minCandidates ?? DEFAULT_REVERSE_CANDIDATE_OPTIONS.minCandidates;
	const maxCandidates = options.maxCandidates ?? DEFAULT_REVERSE_CANDIDATE_OPTIONS.maxCandidates;
	const minDistance = options.minDistance ?? DEFAULT_REVERSE_CANDIDATE_OPTIONS.minDistance;
	const enrichSourceLines = options.enrichSourceLines ?? true;
	const structuralPenaltyValue = options.structuralPenalty ?? DEFAULT_REVERSE_CANDIDATE_OPTIONS.structuralPenalty;
	const rawRecord = scanRawReverseWinner(pdfSyncObject, page, x, y);
	if (rawRecord === undefined) return undefined;
	const y0 = y - pdfSyncObject.offset.y;
	const x0 = x - pdfSyncObject.offset.x;
	const allCandidates: ReverseSyncTeXCandidate[] = [];
	const resolvedInputs = new Map<string, string | undefined>();
	const sourceLinesByInput = new Map<string, string[] | undefined>();

	for (const fileName of Object.keys(pdfSyncObject.blockNumberLine)) {
		resolvedInputs.set(fileName, convInputFilePath(fileName));
	}

	for (const fileName of Object.keys(pdfSyncObject.blockNumberLine)) {
		const linePageBlocks = pdfSyncObject.blockNumberLine[fileName];
		for (const lineNum in linePageBlocks) {
			const pageBlocks = linePageBlocks[Number(lineNum)];
			const blocks = pageBlocks[page];
			if (blocks === undefined) continue;
			for (const block of blocks) {
				// Skip a block if they have boxes inside, or their type is kern or rule.
				// See also https://github.com/jlaurens/synctex/blob/c11fe00dbdc6423a0e54d4e531563be645f78679/synctex_parser.c#L4706-L4727 for types.
				if (block.elements !== undefined || block.type === "k" || block.type === "r") continue;
				const rect = toRect(block);
				const resolvedInput = resolvedInputs.get(fileName);
				const sourceLine = enrichSourceLines ? readSourceLinesForCandidate(fileName, resolvedInputs, sourceLinesByInput)?.[Number(lineNum) - 1] : undefined;
				const structuralReason = structuralSourceLineReason(sourceLine);
				const distanceX = rect.distanceX(x0);
				const distanceY = rect.distanceY(y0);
				const distance = Math.sqrt(distanceY ** 2 + distanceX ** 2);
				const area = Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
				const areaPenalty = 0;
				const structuralPenalty = structuralReason === undefined ? 0 : structuralPenaltyValue;
				allCandidates.push({
					input: resolvedInput ?? fileName,
					line: Number(lineNum),
					column: 0,
					...(sourceLine === undefined ? {} : { sourceLine }),
					rect: {
						left: rect.left + pdfSyncObject.offset.x,
						top: rect.top + pdfSyncObject.offset.y,
						right: rect.right + pdfSyncObject.offset.x,
						bottom: rect.bottom + pdfSyncObject.offset.y,
					},
					distanceX,
					distanceY,
					distance,
					area,
					containsClick: rect.containsPoint(x0, y0),
					structural: structuralReason !== undefined,
					...(structuralReason === undefined ? {} : { structuralReason }),
					areaPenalty,
					structuralPenalty,
					score: distanceY + 2 * distanceX + areaPenalty + structuralPenalty,
				});
			}
		}
	}

	if (allCandidates.length === 0) return undefined;
	const rawInput = resolvedInputs.get(rawRecord.input) ?? rawRecord.input;
	const rawWinner = allCandidates.find((candidate) => candidate.input === rawInput && candidate.line === rawRecord.line && candidate.rect.left === rawRecord.rect.left + pdfSyncObject.offset.x && candidate.rect.top === rawRecord.rect.top + pdfSyncObject.offset.y) ?? {
		input: rawInput,
		line: rawRecord.line,
		column: 0,
		rect: {
			left: rawRecord.rect.left + pdfSyncObject.offset.x,
			top: rawRecord.rect.top + pdfSyncObject.offset.y,
			right: rawRecord.rect.right + pdfSyncObject.offset.x,
			bottom: rawRecord.rect.bottom + pdfSyncObject.offset.y,
		},
		distanceX: rawRecord.rect.distanceX(x0),
		distanceY: rawRecord.rect.distanceY(y0),
		distance: rawRecord.rect.distanceXY(x0, y0),
		area: Math.max(0, rawRecord.rect.right - rawRecord.rect.left) * Math.max(0, rawRecord.rect.bottom - rawRecord.rect.top),
		containsClick: rawRecord.rect.containsPoint(x0, y0),
		structural: false,
		areaPenalty: 0,
		structuralPenalty: 0,
		score: rawRecord.rect.distanceY(y0) + 2 * rawRecord.rect.distanceX(x0),
	};
	const byScore = [...allCandidates].sort(compareReverseCandidates);
	const selected = new Set<ReverseSyncTeXCandidate>();
	for (const candidate of byScore) {
		if (candidate.distance <= minDistance) selected.add(candidate);
	}
	for (const candidate of byScore) {
		if (selected.size >= minCandidates) break;
		selected.add(candidate);
	}
	const candidates = [...selected].sort(compareReverseCandidates).slice(0, Math.max(1, maxCandidates));
	return { winner: candidates[0] ?? rawWinner, rawWinner, candidates };
}

export function inspectSyncTeXToTeXCandidates(page: number, x: number, y: number, pdfPath: string, options: ReverseSyncTeXCandidatesOptions = {}): ReverseSyncTeXCandidatesInspection | undefined {
	const parsed = parseSyncTexForPdf(pdfPath);
	return parsed === undefined ? undefined : collectReverseSyncTeXCandidatesFromParsed(parsed.pdfSyncObject, page, x, y, options);
}

export function inspectSyncTeXToTeX(page: number, x: number, y: number, pdfPath: string): SyncTeXInspectionRecordToTeX | undefined {
	const parsed = parseSyncTexForPdf(pdfPath);
	if (!parsed) {
		return undefined;
	}
	const record = scanRawReverseWinner(parsed.pdfSyncObject, page, x, y);
	if (record === undefined) {
		return undefined;
	}
	const input = convInputFilePath(record.input);
	return input ? {
		input,
		line: record.line,
		column: 0,
		distanceFromCenter: record.distanceFromCenter,
		rect: {
			left: record.rect.left + parsed.pdfSyncObject.offset.x,
			top: record.rect.top + parsed.pdfSyncObject.offset.y,
			right: record.rect.right + parsed.pdfSyncObject.offset.x,
			bottom: record.rect.bottom + parsed.pdfSyncObject.offset.y,
		},
	} : undefined;
}

export function syncTeXToTeX(page: number, x: number, y: number, pdfPath: string): SyncTeXRecordToTeX | undefined {
	const record = inspectSyncTeXToTeX(page, x, y, pdfPath);
	return record ? { input: record.input, line: record.line, column: record.column } : undefined;
}

export function convInputFilePath(inputFilePath: string): string | undefined {
	if (fs.existsSync(inputFilePath)) {
		return inputFilePath;
	}
	for (const enc of iconvLiteSupportedEncodings) {
		try {
			const convertedPath = iconv.decode(Buffer.from(inputFilePath, "binary"), enc);
			if (fs.existsSync(convertedPath)) {
				return convertedPath;
			}
		} catch { }
	}
	return undefined;
}

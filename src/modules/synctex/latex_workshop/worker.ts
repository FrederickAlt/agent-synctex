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
}

export interface ReverseSyncTeXCandidatesInspection {
	winner: ReverseSyncTeXCandidate;
	rawWinner: ReverseSyncTeXCandidate;
	candidates: ReverseSyncTeXCandidate[];
}

export interface ReverseSyncTeXCandidatesOptions {
	/** Minimum number of distinct source locations to collect before expanding the search radius. */
	minCandidates?: number;
	/** Maximum number of nearest distinct source locations to retain. */
	maxCandidates?: number;
	minDistance?: number;
	maxRadius?: number;
	/** PDF user-space height of the clicked page; bounds radius expansion when available. */
	pageHeight?: number;
	enrichSourceLines?: boolean;
}

const DEFAULT_REVERSE_CANDIDATE_OPTIONS = {
	minCandidates: 10,
	maxCandidates: 25,
	minDistance: 12,
	maxRadius: Number.MAX_SAFE_INTEGER,
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

/** A source-mapped terminal SyncTeX record in PDF user-space coordinates. */
export interface SyncTeXLeafBox {
	page: number;
	sourceFile: string;
	line: number;
	h: number;
	v: number;
	W: number;
	H: number;
}

export interface SyncTeXSourceLocation {
	sourceFile: string;
	line: number;
}

export interface SyncTeXForwardLeafLookup extends SyncTeXSourceLocation {
	boxes: SyncTeXLeafBox[];
}

export interface BoundedSyncTeXLeafBoxes {
	boxes: SyncTeXLeafBox[];
	exceeded: boolean;
}

export interface BoundedSyncTeXForwardLeafLookups {
	lookups: SyncTeXForwardLeafLookup[];
	exceeded: boolean;
}

/** One parsed box on the exact source leaf's ancestor path, in PDF user-space coordinates. */
export interface SyncTeXForwardTreeBox {
	type: string;
	page: number;
	sourceFile: string;
	line: number;
	h: number;
	v: number;
	W: number;
	H: number;
}

/** A forward candidate preserves both its exact source leaf and the box's remaining path to the page root. */
export interface SyncTeXForwardTreeCandidate {
	leaf: SyncTeXLeafBox;
	box: SyncTeXForwardTreeBox;
	/** Immediate parent first; excludes the page root, which has no SyncTeX box geometry. */
	ancestors: SyncTeXForwardTreeBox[];
}

export interface BoundedSyncTeXForwardTreeCandidates {
	candidates: SyncTeXForwardTreeCandidate[];
	exceeded: boolean;
}

const LEAF_BOX_GRID_CELL_SIZE = 64;
/** Explicit page-index ceiling: dense pages are rejected, never sampled. */
export const MAX_CACHED_SYNC_TEX_PAGE_LEAF_BOXES = 5_000;

interface CachedPageLeafBoxIndex {
	exceeded: boolean;
	boxes: SyncTeXLeafBox[];
	boxIndexesByGridCell: Map<string, number[]>;
	boxIndexesBySourceLocation: Map<string, number[]>;
}

interface CachedParsedSyncTex {
	sidecarPath: string;
	mtimeMs: number;
	size: number;
	parsed: ParsedSyncTexForPdf | undefined;
	leafBoxesByPage: Map<number, CachedPageLeafBoxIndex>;
}

export function resolveLatexWorkshopSynctexSidecar(pdfPath: string): string | undefined {
	const synctexPath = pdfPath.slice(0, -path.extname(pdfPath).length) + ".synctex";
	if (fs.existsSync(synctexPath)) return synctexPath;
	const synctexGzPath = `${synctexPath}.gz`;
	if (fs.existsSync(synctexGzPath)) return synctexGzPath;
	return undefined;
}

const parsedSyncTexCache = new Map<string, CachedParsedSyncTex>();

function cachedSyncTexForPdf(pdfPath: string): CachedParsedSyncTex | undefined {
	const sidecarPath = resolveLatexWorkshopSynctexSidecar(pdfPath);
	const cacheKey = path.resolve(pdfPath);
	if (sidecarPath === undefined) {
		parsedSyncTexCache.delete(cacheKey);
		return undefined;
	}
	const status = fs.statSync(sidecarPath);
	const cached = parsedSyncTexCache.get(cacheKey);
	if (cached && cached.sidecarPath === sidecarPath && cached.mtimeMs === status.mtimeMs && cached.size === status.size) {
		return cached;
	}
	const data = fs.readFileSync(sidecarPath);
	const body = sidecarPath.endsWith(".gz") ? zlib.gunzipSync(data).toString("binary") : data.toString("utf8");
	const pdfSyncObject = parseSyncTex(body);
	const parsed = pdfSyncObject === undefined ? undefined : { pdfSyncObject, sidecarPath };
	const entry = { sidecarPath, mtimeMs: status.mtimeMs, size: status.size, parsed, leafBoxesByPage: new Map<number, CachedPageLeafBoxIndex>() };
	parsedSyncTexCache.set(cacheKey, entry);
	return entry;
}

export function parseSyncTexForPdf(pdfPath: string): ParsedSyncTexForPdf | undefined {
	return cachedSyncTexForPdf(pdfPath)?.parsed;
}

function cachedPageLeafBoxIndex(pdfPath: string, page: number): CachedPageLeafBoxIndex | undefined {
	const cached = cachedSyncTexForPdf(pdfPath);
	if (cached?.parsed === undefined) return undefined;
	const existing = cached.leafBoxesByPage.get(page);
	if (existing !== undefined) return existing;

	const { pdfSyncObject } = cached.parsed;
	const boxes: SyncTeXLeafBox[] = [];
	for (const sourceFile of Object.keys(pdfSyncObject.blockNumberLine)) {
		const linePageBlocks = pdfSyncObject.blockNumberLine[sourceFile];
		for (const lineText of Object.keys(linePageBlocks)) {
			for (const block of linePageBlocks[Number(lineText)]![page] ?? []) {
				if (block.elements !== undefined || block.type === "k" || block.type === "r") continue;
				if (boxes.length >= MAX_CACHED_SYNC_TEX_PAGE_LEAF_BOXES) {
					const denseIndex = { exceeded: true, boxes: [], boxIndexesByGridCell: new Map<string, number[]>(), boxIndexesBySourceLocation: new Map<string, number[]>() };
					cached.leafBoxesByPage.set(page, denseIndex);
					return denseIndex;
				}
				boxes.push({
					page,
					sourceFile,
					line: Number(lineText),
					h: block.left + pdfSyncObject.offset.x,
					v: block.bottom + pdfSyncObject.offset.y,
					W: block.width ?? 0,
					H: block.height,
				});
			}
		}
	}
	const boxIndexesByGridCell = new Map<string, number[]>();
	const boxIndexesBySourceLocation = new Map<string, number[]>();
	for (const [index, box] of boxes.entries()) {
		const cell = gridCellKey(Math.floor(box.h / LEAF_BOX_GRID_CELL_SIZE), Math.floor((box.v - box.H) / LEAF_BOX_GRID_CELL_SIZE));
		const cellIndexes = boxIndexesByGridCell.get(cell) ?? [];
		cellIndexes.push(index);
		boxIndexesByGridCell.set(cell, cellIndexes);
		const sourceIndexes = boxIndexesBySourceLocation.get(sourceLocationKey(box.sourceFile, box.line)) ?? [];
		sourceIndexes.push(index);
		boxIndexesBySourceLocation.set(sourceLocationKey(box.sourceFile, box.line), sourceIndexes);
	}
	const pageIndex = { exceeded: false, boxes, boxIndexesByGridCell, boxIndexesBySourceLocation };
	cached.leafBoxesByPage.set(page, pageIndex);
	return pageIndex;
}

function cachedPageLeafBoxes(pdfPath: string, page: number): SyncTeXLeafBox[] {
	return cachedPageLeafBoxIndex(pdfPath, page)?.boxes ?? [];
}

function copyLeafBoxes(boxes: SyncTeXLeafBox[]): SyncTeXLeafBox[] {
	return boxes.map((box) => ({ ...box }));
}

/** Returns source-mapped terminal SyncTeX boxes for one page. */
export function getCachedSyncTeXPageLeafBoxes(pdfPath: string, page: number): SyncTeXLeafBox[] {
	return copyLeafBoxes(cachedPageLeafBoxes(pdfPath, page));
}

/**
 * Collects matching leaf boxes without materializing an unbounded response.
 * Hitting the limit is explicit: callers must reject rather than sample.
 */
export function collectCachedSyncTeXPageLeafBoxes(input: {
	pdfPath: string;
	page: number;
	maxBoxes: number;
	bounds?: { h: number; v: number; W: number; H: number };
	matches: (box: Readonly<SyncTeXLeafBox>) => boolean;
}): BoundedSyncTeXLeafBoxes {
	const maxBoxes = Math.max(1, Math.trunc(input.maxBoxes));
	const pageIndex = cachedPageLeafBoxIndex(input.pdfPath, input.page);
	if (pageIndex === undefined) return { boxes: [], exceeded: false };
	if (pageIndex.exceeded) return { boxes: [], exceeded: true };
	const boxes: SyncTeXLeafBox[] = [];
	for (const index of leafBoxIndexesForBounds(pageIndex, input.bounds)) {
		const box = pageIndex.boxes[index];
		if (box === undefined || !input.matches(box)) continue;
		if (boxes.length >= maxBoxes) return { boxes: copyLeafBoxes(boxes), exceeded: true };
		boxes.push(box);
	}
	return { boxes: copyLeafBoxes(boxes), exceeded: false };
}

/** Returns every terminal SyncTeX box for an exact source file and line, optionally on one page. */
export function getCachedSyncTeXForwardLeafBoxes(input: { pdfPath: string; sourceFile: string; line: number; page?: number }): SyncTeXLeafBox[] {
	return collectCachedSyncTeXForwardLeafBoxes({ ...input, maxBoxes: Number.MAX_SAFE_INTEGER }).boxes;
}

function isSyncTeXBlock(value: Block | { type: string; page: number }): value is Block {
	return "parent" in value;
}

function forwardTreeBox(block: Block, offset: PdfSyncObject["offset"]): SyncTeXForwardTreeBox {
	return {
		type: block.type,
		page: block.page,
		sourceFile: block.file.path,
		line: block.line,
		h: block.left + offset.x,
		v: block.bottom + offset.y,
		W: block.width ?? 0,
		H: block.height,
	};
}

/**
 * Returns every terminal record and enclosing parsed box for an exact source line.
 * No visible-box or mean-line filtering is applied: callers receive the whole candidate pool.
 */
export function collectCachedSyncTeXForwardTreeCandidates(input: { pdfPath: string; sourceFile: string; line: number; page?: number; maxCandidates: number }): BoundedSyncTeXForwardTreeCandidates {
	const cached = cachedSyncTexForPdf(input.pdfPath);
	if (cached?.parsed === undefined) return { candidates: [], exceeded: false };
	const { pdfSyncObject } = cached.parsed;
	const sourceFile = findInputFilePathForward(input.sourceFile, pdfSyncObject);
	if (sourceFile === undefined) return { candidates: [], exceeded: false };
	const linePageBlocks = pdfSyncObject.blockNumberLine[sourceFile]?.[input.line];
	if (linePageBlocks === undefined) return { candidates: [], exceeded: false };
	const maxCandidates = Math.max(1, Math.trunc(input.maxCandidates));
	const candidates: SyncTeXForwardTreeCandidate[] = [];
	for (const page of input.page === undefined ? Object.keys(linePageBlocks).map(Number) : [input.page]) {
		for (const leafBlock of linePageBlocks[page] ?? []) {
			if (leafBlock.elements !== undefined || leafBlock.type === "k" || leafBlock.type === "r") continue;
			const leaf = { page, sourceFile, line: input.line, h: leafBlock.left + pdfSyncObject.offset.x, v: leafBlock.bottom + pdfSyncObject.offset.y, W: leafBlock.width ?? 0, H: leafBlock.height };
			const path = [leafBlock];
			let parent = leafBlock.parent;
			while (isSyncTeXBlock(parent)) {
				path.push(parent);
				parent = parent.parent;
			}
			for (let index = 0; index < path.length; index += 1) {
				if (candidates.length >= maxCandidates) return { candidates, exceeded: true };
				candidates.push({ leaf: { ...leaf }, box: forwardTreeBox(path[index]!, pdfSyncObject.offset), ancestors: path.slice(index + 1).map((ancestor) => forwardTreeBox(ancestor, pdfSyncObject.offset)) });
			}
		}
	}
	return { candidates, exceeded: false };
}

/** Exact-line forward geometry with an explicit cap for refresh/rebase paths. */
export function collectCachedSyncTeXForwardLeafBoxes(input: { pdfPath: string; sourceFile: string; line: number; page?: number; maxBoxes: number }): BoundedSyncTeXLeafBoxes {
	const cached = cachedSyncTexForPdf(input.pdfPath);
	if (cached?.parsed === undefined) return { boxes: [], exceeded: false };
	const sourceFile = findInputFilePathForward(input.sourceFile, cached.parsed.pdfSyncObject);
	if (sourceFile === undefined) return { boxes: [], exceeded: false };
	const linePageBlocks = cached.parsed.pdfSyncObject.blockNumberLine[sourceFile]?.[input.line];
	if (linePageBlocks === undefined) return { boxes: [], exceeded: false };
	const maxBoxes = Math.max(1, Math.trunc(input.maxBoxes));
	const pages = input.page === undefined ? Object.keys(linePageBlocks).map(Number) : [input.page];
	const boxes: SyncTeXLeafBox[] = [];
	for (const page of pages) {
		for (const block of linePageBlocks[page] ?? []) {
			if (block.elements !== undefined || block.type === "k" || block.type === "r") continue;
			if (boxes.length >= maxBoxes) return { boxes: copyLeafBoxes(boxes), exceeded: true };
			boxes.push({
				page,
				sourceFile,
				line: input.line,
				h: block.left + cached.parsed.pdfSyncObject.offset.x,
				v: block.bottom + cached.parsed.pdfSyncObject.offset.y,
				W: block.width ?? 0,
				H: block.height,
			});
		}
	}
	return { boxes: copyLeafBoxes(boxes), exceeded: false };
}

/**
 * Resolves many already-indexed source locations on one page without repeated
 * sidecar parsing, path matching, or native SyncTeX calls. Locations use the
 * raw sourceFile returned by getCachedSyncTeXPageLeafBoxes.
 */
export function getCachedSyncTeXPageForwardLeafBoxes(input: { pdfPath: string; page: number; locations: readonly SyncTeXSourceLocation[] }): SyncTeXForwardLeafLookup[] {
	return collectCachedSyncTeXPageForwardLeafBoxes({ ...input, maxBoxes: Number.MAX_SAFE_INTEGER }).lookups;
}

/**
 * Batch-forward source locations from one cached page with an explicit output
 * bound. Hitting the limit means the caller must reject the selection.
 */
export function collectCachedSyncTeXPageForwardLeafBoxes(input: {
	pdfPath: string;
	page: number;
	locations: readonly SyncTeXSourceLocation[];
	maxBoxes: number;
}): BoundedSyncTeXForwardLeafLookups {
	const maxBoxes = Math.max(1, Math.trunc(input.maxBoxes));
	const pageIndex = cachedPageLeafBoxIndex(input.pdfPath, input.page);
	if (pageIndex === undefined) return { lookups: input.locations.map((location) => ({ ...location, boxes: [] })), exceeded: false };
	if (pageIndex.exceeded) return { lookups: input.locations.map((location) => ({ ...location, boxes: [] })), exceeded: true };
	const boxesByLocation = new Map<string, SyncTeXLeafBox[]>();
	let count = 0;
	for (const location of input.locations) {
		const key = sourceLocationKey(location.sourceFile, location.line);
		if (boxesByLocation.has(key)) continue;
		const boxes: SyncTeXLeafBox[] = [];
		for (const index of pageIndex.boxIndexesBySourceLocation.get(key) ?? []) {
			if (count >= maxBoxes) {
				return { lookups: copyForwardLeafLookups(input.locations, boxesByLocation), exceeded: true };
			}
			const box = pageIndex.boxes[index];
			if (box === undefined) continue;
			boxes.push(box);
			count += 1;
		}
		boxesByLocation.set(key, boxes);
	}
	return { lookups: copyForwardLeafLookups(input.locations, boxesByLocation), exceeded: false };
}

function copyForwardLeafLookups(locations: readonly SyncTeXSourceLocation[], boxesByLocation: ReadonlyMap<string, SyncTeXLeafBox[]>): SyncTeXForwardLeafLookup[] {
	return locations.map((location) => ({
		...location,
		boxes: copyLeafBoxes(boxesByLocation.get(sourceLocationKey(location.sourceFile, location.line)) ?? []),
	}));
}

function leafBoxIndexesForBounds(pageIndex: CachedPageLeafBoxIndex, bounds: { h: number; v: number; W: number; H: number } | undefined): number[] {
	if (bounds === undefined) return pageIndex.boxes.map((_box, index) => index);
	const left = bounds.h;
	const right = bounds.h + bounds.W;
	const top = bounds.v - bounds.H;
	const bottom = bounds.v;
	if (![left, right, top, bottom].every(Number.isFinite)) return pageIndex.boxes.map((_box, index) => index);
	const minX = Math.floor(left / LEAF_BOX_GRID_CELL_SIZE);
	const maxX = Math.floor(right / LEAF_BOX_GRID_CELL_SIZE);
	const minY = Math.floor(top / LEAF_BOX_GRID_CELL_SIZE);
	const maxY = Math.floor(bottom / LEAF_BOX_GRID_CELL_SIZE);
	const cellCount = (maxX - minX + 1) * (maxY - minY + 1);
	if (!Number.isSafeInteger(cellCount) || cellCount > pageIndex.boxIndexesByGridCell.size * 2) {
		return pageIndex.boxes.map((_box, index) => index);
	}
	const indexes: number[] = [];
	for (let x = minX; x <= maxX; x += 1) {
		for (let y = minY; y <= maxY; y += 1) {
			indexes.push(...(pageIndex.boxIndexesByGridCell.get(gridCellKey(x, y)) ?? []));
		}
	}
	return indexes;
}

function gridCellKey(x: number, y: number): string {
	return `${x}\0${y}`;
}

function sourceLocationKey(sourceFile: string, line: number): string {
	return `${sourceFile}\0${line}`;
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
	return a.distance - b.distance
		|| Number(b.containsClick) - Number(a.containsClick)
		|| a.distanceY - b.distanceY
		|| a.distanceX - b.distanceX
		|| a.area - b.area
		|| a.line - b.line
		|| a.input.localeCompare(b.input);
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
	const maxRadius = options.maxRadius ?? DEFAULT_REVERSE_CANDIDATE_OPTIONS.maxRadius;
	const pageHeight = options.pageHeight;
	const radiusLimit = Number.isFinite(pageHeight) && (pageHeight as number) > 0
		? Math.min(maxRadius, pageHeight as number)
		: maxRadius;
	const enrichSourceLines = options.enrichSourceLines ?? true;
	const y0 = y - pdfSyncObject.offset.y;
	const x0 = x - pdfSyncObject.offset.x;
	const candidatesBySourceLocation = new Map<string, ReverseSyncTeXCandidate>();
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
				const candidate: ReverseSyncTeXCandidate = {
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
				};
				const key = JSON.stringify([candidate.input, candidate.line]);
				const existing = candidatesBySourceLocation.get(key);
				if (existing === undefined || compareReverseCandidates(candidate, existing) < 0) {
					candidatesBySourceLocation.set(key, candidate);
				}
			}
		}
	}

	if (candidatesBySourceLocation.size === 0) return undefined;
	const sortedCandidates = [...candidatesBySourceLocation.values()].sort(compareReverseCandidates);
	let radius = Math.max(0, minDistance);
	let selected = sortedCandidates.filter((candidate) => candidate.distance <= radius);
	while (selected.length < minCandidates && selected.length < sortedCandidates.length && radius < radiusLimit) {
		radius = radius === 0 ? 1 : Math.min(radiusLimit, radius * 2);
		selected = sortedCandidates.filter((candidate) => candidate.distance <= radius);
	}
	const candidates = selected.slice(0, Math.max(1, maxCandidates));
	if (candidates.length === 0) return undefined;
	return { winner: candidates[0], rawWinner: candidates[0], candidates };
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

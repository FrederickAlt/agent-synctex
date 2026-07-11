import { readFileSync } from "node:fs";
import type { ForwardSynctexRange } from "./forward_synctex.ts";
import { lineColumnForSourceIndex } from "./source_index.ts";

export interface SourceTextMatch {
	sourceFile: string;
	line: number;
	column: number;
	fragment: string;
	sourceLine?: string;
}

export type SourceTextMatchStatus = "no-match" | "unique" | "ambiguous-small" | "too-many";

export interface SourceTextMatchResult {
	status: SourceTextMatchStatus;
	fragment?: string;
	matches: SourceTextMatch[];
	matchCount: number;
	fragmentsTried: string[];
}

export interface PdfClickPoint {
	page: number;
	x: number;
	y: number;
}

export interface FilteredForwardBoxes {
	boxes: ForwardSynctexRange[];
	chosenBox?: ForwardSynctexRange;
	rejectedInvalid: number;
	rejectedAbsurd: number;
}

export interface ForwardVerifiedSourceMatch {
	precision: "verified" | "text";
	match?: SourceTextMatch;
	chosenBox?: ForwardSynctexRange;
	boxes: ForwardSynctexRange[];
	containsClick: boolean;
}

const DEFAULT_MAX_TEXT_MATCHES_FOR_FORWARD_VERIFICATION = 5;
const MIN_USEFUL_FRAGMENT_LENGTH = 3;
const ABSURD_BOX_AREA = 200_000;
const ABSURD_BOX_SIDE = 500;

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function sourceLikeRuns(value: string): string[] {
	return normalizeWhitespace(value)
		.split(/[^A-Za-z0-9_\\{}]+/u)
		.map((part) => part.trim())
		.filter((part) => part.length >= MIN_USEFUL_FRAGMENT_LENGTH);
}

function pushUnique(values: string[], value: string): void {
	if (value.length >= MIN_USEFUL_FRAGMENT_LENGTH && !values.includes(value)) values.push(value);
}

export function buildSourceSearchFragments(before: string, after: string): string[] {
	const beforeRuns = sourceLikeRuns(before);
	const afterRuns = sourceLikeRuns(after);
	const fragments: string[] = [];
	const joinedBoundary = `${beforeRuns.at(-1) ?? ""}${afterRuns[0] ?? ""}`;
	pushUnique(fragments, joinedBoundary);
	for (const fragment of [...beforeRuns, ...afterRuns]
		.map((value, index) => ({ value, index }))
		.sort((a, b) => b.value.length - a.value.length || a.index - b.index)
		.map((entry) => entry.value)) {
		pushUnique(fragments, fragment);
	}
	return fragments;
}

function findIndexes(source: string, fragment: string, stopAfter: number): number[] {
	const indexes: number[] = [];
	let index = source.indexOf(fragment);
	while (index >= 0) {
		indexes.push(index);
		if (indexes.length > stopAfter) break;
		index = source.indexOf(fragment, index + Math.max(1, fragment.length));
	}
	return indexes;
}

export function findSourceTextMatches(sourceFile: string, fragments: string[], options?: { maxMatchesForVerification?: number }): SourceTextMatchResult {
	const maxMatches = options?.maxMatchesForVerification ?? DEFAULT_MAX_TEXT_MATCHES_FOR_FORWARD_VERIFICATION;
	const usefulFragments = fragments.map(normalizeWhitespace).filter((fragment, index, all) => fragment.length >= MIN_USEFUL_FRAGMENT_LENGTH && all.indexOf(fragment) === index);
	let source: string;
	try {
		source = readFileSync(sourceFile, "utf8");
	} catch {
		return { status: "no-match", matches: [], matchCount: 0, fragmentsTried: usefulFragments };
	}
	const sourceLines = source.split(/\r?\n/);
	for (const fragment of usefulFragments) {
		const indexes = findIndexes(source, fragment, maxMatches);
		if (indexes.length === 0) continue;
		if (indexes.length > maxMatches) {
			return { status: "too-many", fragment, matches: [], matchCount: indexes.length, fragmentsTried: usefulFragments };
		}
		const matches = indexes.map((index): SourceTextMatch => {
			const location = lineColumnForSourceIndex(source, index);
			return {
				sourceFile,
				line: location.line,
				column: location.column,
				fragment,
				...(sourceLines[location.line - 1] === undefined ? {} : { sourceLine: sourceLines[location.line - 1] }),
			};
		});
		return {
			status: matches.length === 1 ? "unique" : "ambiguous-small",
			fragment,
			matches,
			matchCount: matches.length,
			fragmentsTried: usefulFragments,
		};
	}
	return { status: "no-match", matches: [], matchCount: 0, fragmentsTried: usefulFragments };
}

function boxArea(box: ForwardSynctexRange): number {
	return box.W * box.H;
}

function isValidBox(box: ForwardSynctexRange): boolean {
	return [box.page, box.h, box.v, box.W, box.H].every(Number.isFinite) && box.W > 0 && box.H > 0;
}

function isAbsurdBox(box: ForwardSynctexRange): boolean {
	return boxArea(box) >= ABSURD_BOX_AREA || box.W >= ABSURD_BOX_SIDE || box.H >= ABSURD_BOX_SIDE;
}

/** A broad container is retained only as fallback geometry, never as tight evidence. */
export function forwardBoxGeometryTier(box: ForwardSynctexRange): number {
	return isAbsurdBox(box) ? 1 : 0;
}

export function boxContainsClick(box: ForwardSynctexRange, click: PdfClickPoint): boolean {
	return box.page === click.page
		&& click.x >= box.h
		&& click.x <= box.h + box.W
		&& click.y >= box.v - box.H
		&& click.y <= box.v;
}

export function boxDistanceComponentsFromClick(box: ForwardSynctexRange, click: PdfClickPoint): { dx: number; dy: number; distance: number; distanceSquared: number } {
	const nearestX = Math.max(box.h, Math.min(click.x, box.h + box.W));
	const nearestY = Math.max(box.v - box.H, Math.min(click.y, box.v));
	const dx = Math.abs(click.x - nearestX);
	const dy = Math.abs(click.y - nearestY);
	return { dx, dy, distance: Math.hypot(dx, dy), distanceSquared: (dx ** 2) + (dy ** 2) };
}

function boxDistance(box: ForwardSynctexRange, click: PdfClickPoint): number {
	return boxDistanceComponentsFromClick(box, click).distance;
}

function compareBoxes(click: PdfClickPoint): (left: ForwardSynctexRange, right: ForwardSynctexRange) => number {
	return (left, right) => {
		const leftContains = boxContainsClick(left, click);
		const rightContains = boxContainsClick(right, click);
		if (leftContains !== rightContains) return leftContains ? -1 : 1;
		if (leftContains && boxArea(left) !== boxArea(right)) return boxArea(left) - boxArea(right);
		const leftDistance = boxDistance(left, click);
		const rightDistance = boxDistance(right, click);
		if (leftDistance !== rightDistance) return leftDistance - rightDistance;
		return boxArea(left) - boxArea(right);
	};
}

export function filterForwardBoxes(boxes: ForwardSynctexRange[], click: PdfClickPoint): FilteredForwardBoxes {
	const valid = boxes.filter(isValidBox);
	const samePage = valid.filter((box) => box.page === click.page);
	const pagePreferred = samePage.length > 0 ? samePage : valid;
	const nonAbsurd = pagePreferred.filter((box) => !isAbsurdBox(box));
	const usable = nonAbsurd.length > 0 ? nonAbsurd : pagePreferred;
	const sorted = [...usable].sort(compareBoxes(click));
	return {
		boxes: sorted,
		...(sorted[0] === undefined ? {} : { chosenBox: sorted[0] }),
		rejectedInvalid: boxes.length - valid.length,
		rejectedAbsurd: pagePreferred.length - usable.length,
	};
}

export function selectForwardVerifiedSourceMatch(input: {
	matches: SourceTextMatch[];
	click: PdfClickPoint;
	forwardBoxesForMatch: (match: SourceTextMatch) => ForwardSynctexRange[];
}): ForwardVerifiedSourceMatch {
	const candidates = input.matches.flatMap((match) => {
		const filtered = filterForwardBoxes(input.forwardBoxesForMatch(match), input.click);
		return filtered.boxes.map((box) => ({ match, box }));
	});
	const sorted = [...candidates].sort((left, right) => compareBoxes(input.click)(left.box, right.box));
	const chosen = sorted[0];
	const retainedUniqueMatch = input.matches.length === 1 ? input.matches[0] : undefined;
	const containsClick = chosen === undefined ? false : boxContainsClick(chosen.box, input.click);
	return {
		precision: containsClick ? "verified" : "text",
		...(chosen === undefined ? retainedUniqueMatch === undefined ? {} : { match: retainedUniqueMatch } : { match: chosen.match, chosenBox: chosen.box }),
		boxes: sorted.map((candidate) => candidate.box),
		containsClick,
	};
}

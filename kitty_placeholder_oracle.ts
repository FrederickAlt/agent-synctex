import { KITTY_PLACEHOLDER, ROW_COLUMN_DIACRITICS } from "./kitty_placeholder_image.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const DCS_PREFIX = `${ESC}_G`;
const TMUX_WRAPPED_PREFIX = `${ESC}Ptmux;`;

const DEFAULT_MAX_DIAGNOSTIC_ENTRIES = 80;

const PLACEHOLDER_CELL_RE = new RegExp(`${ESC}\\[38;2;(\\d{1,3});(\\d{1,3});(\\d{1,3})m${KITTY_PLACEHOLDER}(..)`, "gu");

type ChunkMode = "none" | "more" | "last" | "invalid";

interface InternalImageState {
	expectingMoreChunks: boolean;
	livePlacement?: KittyPlaceholderPlacement;
	chunkColumns?: number;
	chunkRows?: number;
	chunkCommand?: KittyGraphicsCommand;
}

export interface KittyGraphicsCommand {
	raw: string;
	params: string[];
	paramByName: Map<string, string>;
	payload: string;
	wrappedInTmux: boolean;
}

export interface KittyPlaceholderPlacement {
	imageId: number;
	columns: number;
	rows: number;
	command: KittyGraphicsCommand;
}

export interface KittyPlaceholderCell {
	imageId: number;
	row: number;
	column: number;
	rowDiacritic: string;
	columnDiacritic: string;
	sourceOffset: number;
}

export interface InvalidKittyPlaceholderCoordinate {
	cell: KittyPlaceholderCell;
	reason: string;
}

export interface KittyPlaceholderOracleReport {
	isValid: boolean;
	commands: KittyGraphicsCommand[];
	placements: KittyPlaceholderPlacement[];
	placeholders: KittyPlaceholderCell[];
	orphanPlaceholders: KittyPlaceholderCell[];
	invalidCoordinatePlaceholders: InvalidKittyPlaceholderCoordinate[];
	commandImageIds: number[];
	placeholderImageIds: number[];
	failures: string[];
	toDiagnosticString(rawOutput: string): string;
}

export interface KittyPlaceholderOracleOptions {
	/** Require a virtual placement setup command (Kitty a=T,q=2 with image id, rows, cols). */
	requireImageSetup?: boolean;
	/** Require at least one placeholder cell. */
	requirePlaceholders?: boolean;
	/** Explicit ids expected by tests to exist in emitted placements. */
	expectedImageIds?: readonly number[];
	/** Emit escaped raw output in diagnostics when failures occur. */
	includeRawOutput?: boolean;
	/** Max number of characters for diagnostics. */
	maxDiagnosticLength?: number;
	/** Max number of diagnostic cell/placement entries to include before summarizing. */
	maxDiagnosticEntries?: number;
}

export class KittyPlaceholderOracle {
	readonly output: string;
	readonly options: KittyPlaceholderOracleOptions;
	private readonly report: KittyPlaceholderOracleReport;

	constructor(output: string, options: KittyPlaceholderOracleOptions = {}) {
		this.output = output;
		this.options = options;
		const config = {
			requireImageSetup: true,
			requirePlaceholders: true,
			includeRawOutput: false,
			maxDiagnosticLength: 4000,
			maxDiagnosticEntries: DEFAULT_MAX_DIAGNOSTIC_ENTRIES,
			...this.options,
		};

		const commands = parseKittyCommands(output);
		const { placementsByImage, commandImageIds, failures } = analyzeImagePlacements(commands);
		const placements = [...placementsByImage.values()];
		const placeholders = extractPlaceholderCells(output);
		const placeholderImageIds = uniqueSorted(placeholders.map((placeholder) => placeholder.imageId));

		const orphanPlaceholders: KittyPlaceholderCell[] = [];
		const invalidCoordinatePlaceholders: InvalidKittyPlaceholderCoordinate[] = [];

		for (const placeholder of placeholders) {
			const placement = placementsByImage.get(placeholder.imageId);
			if (!placement) {
				orphanPlaceholders.push(placeholder);
				invalidCoordinatePlaceholders.push({
					cell: placeholder,
					reason: "placeholder has no matching live image placement",
				});
				continue;
			}

			if (placeholder.row < 0 || placeholder.column < 0 || placeholder.row >= placement.rows || placeholder.column >= placement.columns) {
				invalidCoordinatePlaceholders.push({
					cell: placeholder,
					reason: "placeholder is outside declared placement dimensions",
				});
			}
		}

		const livePlacementImageIds = uniqueSorted(placements.map((placement) => placement.imageId));
		for (const imageId of config.expectedImageIds ?? []) {
			if (!commandImageIds.includes(imageId)) {
				failures.push(`Expected image id ${imageId} to appear in emitted Kitty setup commands.`);
			}
			if (config.requirePlaceholders && !placeholderImageIds.includes(imageId)) {
				failures.push(`Expected a placeholder cell for image id ${imageId}, but none were emitted.`);
			}
			if (config.requireImageSetup && !livePlacementImageIds.includes(imageId)) {
				failures.push(`Expected image id ${imageId} to have a complete Kitty setup stream, but it was missing or incomplete.`);
			}
		}

		if (config.requireImageSetup && livePlacementImageIds.length === 0) {
			failures.push("Missing virtual Kitty placeholder placement command (a=T,q=2,i=?,c=?,r=?).");
		}

		if (config.requirePlaceholders && placeholders.length === 0) {
			failures.push("No Kitty placeholder cells were decoded from output.");
		}

		for (const placeholder of orphanPlaceholders) {
			failures.push(`Orphan placeholder cell references image id ${placeholder.imageId} at row ${placeholder.row}, col ${placeholder.column}.`);
		}

		if (invalidCoordinatePlaceholders.length > 0) {
			for (const invalid of invalidCoordinatePlaceholders) {
				failures.push(`Invalid placeholder at row ${invalid.cell.row}, col ${invalid.cell.column} for image id ${invalid.cell.imageId}: ${invalid.reason}.`);
			}
		}

		this.report = {
			isValid: failures.length === 0,
			commands,
			placements,
			placeholders,
			orphanPlaceholders,
			invalidCoordinatePlaceholders,
			commandImageIds,
			placeholderImageIds,
			failures,
			toDiagnosticString: (rawOutput: string) => {
				return buildDiagnosticsMessage({
					failures,
					commandImageIds,
					placeholderImageIds,
					placements,
					placeholders,
					orphanPlaceholders,
					invalidCoordinatePlaceholders,
					rawOutput: config.includeRawOutput ? rawOutput : undefined,
					maxDiagnosticLength: config.maxDiagnosticLength,
					maxDiagnosticEntries: config.maxDiagnosticEntries,
				});
			},
		};
	}

	get isValid(): boolean {
		return this.report.isValid;
	}

	get commandCount(): number {
		return this.report.commands.length;
	}

	assertValid(message = "Kitty placeholder output is invalid"): void {
		if (this.isValid) return;
		throw new Error(`${message}\n${this.report.toDiagnosticString(this.output)}`);
	}

	getCommandImageIds(): number[] {
		return this.report.commandImageIds;
	}

	getPlaceholderImageIds(): number[] {
		return this.report.placeholderImageIds;
	}

	get summary(): string {
		return this.report.toDiagnosticString(this.output);
	}

	get diagnostics(): KittyPlaceholderOracleReport {
		return this.report;
	}
}

function parseKittyCommands(output: string): KittyGraphicsCommand[] {
	const commands: KittyGraphicsCommand[] = [];
	let offset = 0;
	while (offset < output.length) {
		if (output.startsWith(TMUX_WRAPPED_PREFIX, offset)) {
			const wrapperEnd = indexOfUnescapedTerminator(output, ST, offset + TMUX_WRAPPED_PREFIX.length);
			if (wrapperEnd < 0) break;

			const wrappedPayload = output.slice(offset + TMUX_WRAPPED_PREFIX.length, wrapperEnd);
			const unwrappedPayload = wrappedPayload.replaceAll(`${ESC}${ESC}`, ESC);
			commands.push(...parseKittyCommandsFromText(unwrappedPayload, true));

			offset = wrapperEnd + ST.length;
			continue;
		}

		if (!output.startsWith(DCS_PREFIX, offset)) {
			offset += 1;
			continue;
		}

		const command = parseSingleKittyCommand(output.slice(offset), false);
		if (!command) {
			offset += 1;
			continue;
		}

		commands.push(command);
		offset += command.raw.length;
	}

	return commands;
}

function parseKittyCommandsFromText(text: string, wrappedInTmux: boolean): KittyGraphicsCommand[] {
	const commands: KittyGraphicsCommand[] = [];
	let offset = 0;
	while (offset < text.length) {
		const commandOffset = text.indexOf(DCS_PREFIX, offset);
		if (commandOffset < 0) break;

		const command = parseSingleKittyCommand(text.slice(commandOffset), wrappedInTmux);
		if (!command) {
			offset = commandOffset + DCS_PREFIX.length;
			continue;
		}

		commands.push(command);
		offset = commandOffset + command.raw.length;
	}

	return commands;
}

function indexOfUnescapedTerminator(text: string, token: string, start: number): number {
	let index = text.indexOf(token, start);
	while (index >= 0) {
		if (index === 0 || text[index - 1] !== ESC) return index;
		index = text.indexOf(token, index + 1);
	}
	return -1;
}

function parseSingleKittyCommand(text: string, wrappedInTmux: boolean): KittyGraphicsCommand | undefined {
	const commandEnd = text.indexOf(ST);
	if (commandEnd < 0 || commandEnd < DCS_PREFIX.length) return undefined;
	if (!text.startsWith(DCS_PREFIX, 0)) return undefined;

	const body = text.slice(DCS_PREFIX.length, commandEnd);
	const splitIndex = body.indexOf(";");
	const rawParams = splitIndex >= 0 ? body.slice(0, splitIndex) : body;
	const payload = splitIndex >= 0 ? body.slice(splitIndex + 1) : "";
	const params = rawParams.length > 0 ? rawParams.split(",").filter(Boolean) : [];
	const paramByName = new Map<string, string>();
	for (const param of params) {
		const equals = param.indexOf("=");
		if (equals <= 0) {
			paramByName.set(param, "");
			continue;
		}
		paramByName.set(param.slice(0, equals), param.slice(equals + 1));
	}

	return {
		raw: text.slice(0, commandEnd + ST.length),
		params,
		paramByName,
		payload,
		wrappedInTmux,
	};
}

function parseChunkMode(value: string | undefined): ChunkMode {
	const parsed = parseIntSafe(value);
	if (parsed === undefined) return value === undefined ? "none" : "invalid";
	if (parsed === 0) return "last";
	if (parsed === 1) return "more";
	return "invalid";
}

function analyzeImagePlacements(commands: KittyGraphicsCommand[]): {
	placementsByImage: Map<number, KittyPlaceholderPlacement>;
	commandImageIds: number[];
	failures: string[];
} {
	const imageStates = new Map<number, InternalImageState>();
	const commandImageIds = new Set<number>();
	const failures: string[] = [];

	for (const command of commands) {
		const action = command.paramByName.get("a");
		const mode = command.paramByName.get("q");
		const imageId = parseIntSafe(command.paramByName.get("i"));
		const chunkMode = parseChunkMode(command.paramByName.get("m"));

		if (action === "T" && mode === "2" && imageId !== undefined) {
			commandImageIds.add(imageId);
			const state = imageStates.get(imageId) ?? { expectingMoreChunks: false };
			handleSetupStartCommand(imageId, command, state, failures);
			imageStates.set(imageId, state);
			continue;
		}

		if (chunkMode === "none") continue;

		const continuationImageId = resolveChunkContinuationImageId(imageId, imageStates, failures, command);
		if (continuationImageId === undefined) continue;

		const state = imageStates.get(continuationImageId) ?? { expectingMoreChunks: false };
		if (!state.expectingMoreChunks) {
			failures.push(`Image id ${continuationImageId} has no active chunked setup to continue.`);
			continue;
		}

		handleSetupChunkContinuation(continuationImageId, command, state, failures);
		imageStates.set(continuationImageId, state);
	}

	for (const [imageId, state] of imageStates.entries()) {
		if (!state.expectingMoreChunks) continue;
		failures.push(`Image id ${imageId} has an incomplete image transmission chain; missing terminal m=0 chunk.`);
		resetChunkState(state);
	}

	const placementsByImage = new Map<number, KittyPlaceholderPlacement>();
	for (const [imageId, state] of imageStates.entries()) {
		if (state.livePlacement) placementsByImage.set(imageId, state.livePlacement);
	}

	return {
		placementsByImage,
		commandImageIds: uniqueSorted(Array.from(commandImageIds)),
		failures,
	};
}

function resolveChunkContinuationImageId(
	explicitImageId: number | undefined,
	imageStates: Map<number, InternalImageState>,
	failures: string[],
	command: KittyGraphicsCommand,
): number | undefined {
	if (explicitImageId !== undefined) {
		const state = imageStates.get(explicitImageId);
		if (state?.expectingMoreChunks) return explicitImageId;
		failures.push(`Image id ${explicitImageId} chunk command has no active chunked setup to continue.`);
		return undefined;
	}

	const pendingImageIds = [...imageStates.entries()].filter((entry) => entry[1].expectingMoreChunks).map((entry) => entry[0]);
	if (pendingImageIds.length === 1) return pendingImageIds[0];
	if (pendingImageIds.length === 0) {
		failures.push("Chunked setup command has no image id and no active transmission is pending.");
		return undefined;
	}

	const visibleParams = command.raw.slice(0, 80);
	failures.push(`Chunked setup command ${visibleParams} is ambiguous across active transmissions: ${pendingImageIds.join(",")} pending.`);
	return undefined;
}

function handleSetupStartCommand(imageId: number, command: KittyGraphicsCommand, state: InternalImageState, failures: string[]): void {
	if (state.expectingMoreChunks) {
		failures.push(`Image id ${imageId} started a new setup command before completing a previous chunked stream.`);
		resetChunkState(state);
	}

	if (command.paramByName.get("U") !== "1") {
		failures.push(`Image id ${imageId} setup command is missing required U=1.`);
		return;
	}

	if (command.payload.length === 0) {
		failures.push(`Image id ${imageId} setup command has no payload.`);
		return;
	}

	const chunkMode = parseChunkMode(command.paramByName.get("m"));
	const columns = parseIntSafe(command.paramByName.get("c"));
	const rows = parseIntSafe(command.paramByName.get("r"));
	const hasDimensions = columns !== undefined && rows !== undefined;

	if (chunkMode === "invalid") {
		failures.push(`Image id ${imageId} setup command has invalid m value ${command.paramByName.get("m")}.`);
		return;
	}

	if (chunkMode === "more") {
		if (!hasDimensions) {
			failures.push(`Image id ${imageId} started a chunked setup command without placement dimensions (c,r).`);
			return;
		}
		state.expectingMoreChunks = true;
		state.chunkColumns = columns;
		state.chunkRows = rows;
		state.chunkCommand = command;
		state.livePlacement = undefined;
		return;
	}

	if (!hasDimensions) {
		failures.push(`Image id ${imageId} setup command is missing placement dimensions (c,r).`);
		return;
	}

	state.livePlacement = {
		imageId,
		columns,
		rows,
		command,
	};
}

function handleSetupChunkContinuation(imageId: number, command: KittyGraphicsCommand, state: InternalImageState, failures: string[]): void {
	if (command.payload.length === 0) {
		failures.push(`Image id ${imageId} chunk command has no payload.`);
		resetChunkState(state);
		return;
	}

	const chunkMode = parseChunkMode(command.paramByName.get("m"));
	if (chunkMode === "more") return;
	if (chunkMode === "last") {
		if (state.chunkColumns === undefined || state.chunkRows === undefined) {
			failures.push(`Image id ${imageId} started a chunked setup without placement dimensions (c,r).`);
			resetChunkState(state);
			return;
		}
		state.livePlacement = {
			imageId,
			columns: state.chunkColumns,
			rows: state.chunkRows,
			command: state.chunkCommand ?? command,
		};
		resetChunkState(state);
		return;
	}

	failures.push(`Image id ${imageId} chunk command has invalid m value ${command.paramByName.get("m")}.`);
	resetChunkState(state);
}

function resetChunkState(state: InternalImageState): void {
	state.expectingMoreChunks = false;
	state.chunkColumns = undefined;
	state.chunkRows = undefined;
	state.chunkCommand = undefined;
}

function parseIntSafe(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

function extractPlaceholderCells(output: string): KittyPlaceholderCell[] {
	const placeholderMap = coordinateMap();
	const cells: KittyPlaceholderCell[] = [];
	const matches = output.matchAll(PLACEHOLDER_CELL_RE);
	for (const match of matches) {
		if (match.index === undefined) continue;
		const red = Number(match[1]);
		const green = Number(match[2]);
		const blue = Number(match[3]);
		const diacritics = match[4];
		const rowDiacritic = diacritics[0] ?? "";
		const columnDiacritic = diacritics[1] ?? "";
		cells.push({
			imageId: (red << 16) | (green << 8) | blue,
			row: placeholderMap.get(rowDiacritic) ?? -1,
			column: placeholderMap.get(columnDiacritic) ?? -1,
			rowDiacritic,
			columnDiacritic,
			sourceOffset: match.index,
		});
	}
	return cells;
}

function coordinateMap(): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < ROW_COLUMN_DIACRITICS.length; i++) {
		map.set(ROW_COLUMN_DIACRITICS[i], i);
	}
	return map;
}

function uniqueSorted(numbers: number[]): number[] {
	return [...new Set(numbers)].sort((a, b) => a - b);
}

function formatPlacement(placement: KittyPlaceholderPlacement): string {
	return `image=${placement.imageId} columns=${placement.columns} rows=${placement.rows} tmux=${placement.command.wrappedInTmux ? "yes" : "no"}`;
}

function formatCell(cell: KittyPlaceholderCell): string {
	return `image=${cell.imageId} row=${cell.row} col=${cell.column} (${cell.rowDiacritic} ${cell.columnDiacritic})`;
}

function formatInvalidCoordinate(invalid: InvalidKittyPlaceholderCoordinate): string {
	return `image=${invalid.cell.imageId} row=${invalid.cell.row} col=${invalid.cell.column} reason=${invalid.reason}`;
}

function appendSummarizedEntries<T>(
	lines: string[],
	title: string,
	values: T[],
	formatter: (value: T) => string,
	maxEntries: number,
): void {
	lines.push(title);
	if (values.length === 0) {
		lines.push("- <none>");
		return;
	}

	const shown = values.slice(0, maxEntries);
	for (const value of shown) {
		lines.push(`- ${formatter(value)}`);
	}

	if (values.length > shown.length) {
		lines.push(`- ... (+${values.length - shown.length} more entries)`);
	}
}

function buildDiagnosticsMessage(params: {
	failures: string[];
	commandImageIds: number[];
	placeholderImageIds: number[];
	placements: KittyPlaceholderPlacement[];
	placeholders: KittyPlaceholderCell[];
	orphanPlaceholders: KittyPlaceholderCell[];
	invalidCoordinatePlaceholders: InvalidKittyPlaceholderCoordinate[];
	rawOutput?: string;
	maxDiagnosticLength?: number;
	maxDiagnosticEntries?: number;
}): string {
	const lines: string[] = [];
	if (params.failures.length === 0) {
		lines.push("Kitty placeholder output passed oracle checks.");
	} else {
		lines.push("Kitty placeholder oracle failures:");
		for (const failure of params.failures) {
			lines.push(`- ${failure}`);
		}
	}

	lines.push(`decoded setup image ids: ${params.commandImageIds.join(", ") || "<none>"}`);
	lines.push(`decoded placeholder image ids: ${params.placeholderImageIds.join(", ") || "<none>"}`);

	const maxEntries = params.maxDiagnosticEntries ?? DEFAULT_MAX_DIAGNOSTIC_ENTRIES;
	appendSummarizedEntries(lines, "placements:", params.placements, formatPlacement, maxEntries);
	appendSummarizedEntries(lines, "placeholder cells:", params.placeholders, formatCell, maxEntries);
	appendSummarizedEntries(lines, "orphan placeholders:", params.orphanPlaceholders, formatCell, maxEntries);
	appendSummarizedEntries(lines, "invalid coordinates:", params.invalidCoordinatePlaceholders, formatInvalidCoordinate, maxEntries);

	if (params.rawOutput !== undefined) {
		let raw = params.rawOutput.replaceAll(ESC, "\\x1b");
		if (raw.length > (params.maxDiagnosticLength ?? 4000)) {
			raw = `${raw.slice(0, params.maxDiagnosticLength ?? 4000)}... (+${raw.length - (params.maxDiagnosticLength ?? 4000)} more)`;
		}
		lines.push(`raw output:\n${raw}`);
	}

	return lines.join("\n");
}

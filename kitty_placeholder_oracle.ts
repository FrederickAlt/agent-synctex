import { KITTY_PLACEHOLDER, ROW_COLUMN_DIACRITICS } from "./kitty_placeholder_image.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const DCS_PREFIX = `${ESC}_G`;
const TMUX_WRAPPED_PREFIX = `${ESC}Ptmux;`;

const PLACEHOLDER_CELL_RE = new RegExp(`${ESC}\\[38;2;(\\d{1,3});(\\d{1,3});(\\d{1,3})m${KITTY_PLACEHOLDER}(..)`, "gu");

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
			...this.options,
		};

		const commands = parseKittyCommands(output);
		const placements = extractPlacements(commands);
		const placeholders = extractPlaceholderCells(output);

		const placementMap = new Map<number, KittyPlaceholderPlacement[]>();
		for (const placement of placements) {
			const list = placementMap.get(placement.imageId) ?? [];
			list.push(placement);
			placementMap.set(placement.imageId, list);
		}

		const orphanPlaceholders: KittyPlaceholderCell[] = [];
		const invalidCoordinatePlaceholders: InvalidKittyPlaceholderCoordinate[] = [];
		for (const placeholder of placeholders) {
			const relatedPlacements = placementMap.get(placeholder.imageId);
			if (!relatedPlacements || relatedPlacements.length === 0) {
				orphanPlaceholders.push(placeholder);
				invalidCoordinatePlaceholders.push({
					cell: placeholder,
					reason: "placeholder has no matching virtual placement",
				});
				continue;
			}

			const validInBounds = relatedPlacements.some((placement) => placeholder.row < placement.rows && placeholder.column < placement.columns);
			if (!validInBounds || placeholder.row < 0 || placeholder.column < 0) {
				invalidCoordinatePlaceholders.push({
					cell: placeholder,
					reason: "placeholder is outside declared placement dimensions",
				});
			}
		}

		const commandImageIds = uniqueSorted(placements.map((placement) => placement.imageId));
		const placeholderImageIds = uniqueSorted(placeholders.map((placeholder) => placeholder.imageId));
		const failures: string[] = [];

		if (config.requireImageSetup && placements.length === 0) {
			failures.push("Missing virtual Kitty placeholder placement command (a=T,q=2,i=?,c=?,r=?)." );
		}

		if (config.requirePlaceholders && placeholders.length === 0) {
			failures.push("No Kitty placeholder cells were decoded from output.");
		}

		for (const imageId of config.expectedImageIds ?? []) {
			if (!commandImageIds.includes(imageId)) {
				failures.push(`Expected image id ${imageId} to appear in emitted Kitty setup commands.`);
			}
			if (config.requirePlaceholders && !placeholders.some((placeholder) => placeholder.imageId === imageId)) {
				failures.push(`Expected a placeholder cell for image id ${imageId}, but none were emitted.`);
			}
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
			const command = parseSingleKittyCommand(unwrappedPayload, true);
			if (command) commands.push(command);

			offset = wrapperEnd + ST.length;
			continue;
		}

		if (!output.startsWith(DCS_PREFIX, offset)) {
			offset += 1;
			continue;
		}

		const remainder = output.slice(offset);
		const command = parseSingleKittyCommand(remainder, false);
		if (!command) {
			offset += 1;
			continue;
		}

		commands.push(command);
		offset += command.raw.length;
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

function extractPlacements(commands: KittyGraphicsCommand[]): KittyPlaceholderPlacement[] {
	const placements: KittyPlaceholderPlacement[] = [];
	for (const command of commands) {
		const action = command.paramByName.get("a");
		const mode = command.paramByName.get("q");
		if (action !== "T" || mode !== "2") continue;

		const imageId = parseIntSafe(command.paramByName.get("i"));
		const columns = parseIntSafe(command.paramByName.get("c"));
		const rows = parseIntSafe(command.paramByName.get("r"));
		if (imageId === undefined || columns === undefined || rows === undefined) continue;

		placements.push({ imageId, columns, rows, command });
	}
	return placements;
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
	lines.push("placements:");
	for (const placement of params.placements) {
		lines.push(`- ${formatPlacement(placement)}`);
	}
	if (params.placements.length === 0) {
		lines.push("- <none>");
	}

	lines.push("placeholder cells:");
	for (const cell of params.placeholders) {
		lines.push(`- ${formatCell(cell)}`);
	}
	if (params.placeholders.length === 0) {
		lines.push("- <none>");
	}

	if (params.orphanPlaceholders.length > 0) {
		lines.push("orphan placeholders:");
		for (const cell of params.orphanPlaceholders) {
			lines.push(`- ${formatCell(cell)}`);
		}
	}

	if (params.invalidCoordinatePlaceholders.length > 0) {
		lines.push("invalid coordinates:");
		for (const invalid of params.invalidCoordinatePlaceholders) {
			lines.push(`- image=${invalid.cell.imageId} row=${invalid.cell.row} col=${invalid.cell.column} reason=${invalid.reason}`);
		}
	}

	if (params.rawOutput !== undefined) {
		let raw = params.rawOutput.replaceAll(ESC, "\\x1b");
		if (raw.length > (params.maxDiagnosticLength ?? 4000)) {
			raw = `${raw.slice(0, params.maxDiagnosticLength ?? 4000)}... (+${raw.length - (params.maxDiagnosticLength ?? 4000)} more)`;
		}
		lines.push(`raw output:\n${raw}`);
	}

	return lines.join("\n");
}

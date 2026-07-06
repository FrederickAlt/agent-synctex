export const VIEWER_HOST_PROTOCOL_VERSION = 1 as const;

export interface ViewerHostHelloMessage {
	type: "hello";
	protocol_version: number;
}

export interface ViewerHostOpenPdfMessage {
	type: "open_pdf";
	pdf_id: number;
	pdf_path: string;
	title?: string;
	workspace_cwd?: string;
	debug_synctex?: boolean;
}

export interface ViewerHostFocusPdfMessage {
	type: "focus_pdf";
	pdf_id: number;
}

export interface ViewerHostSetDebugSynctexMessage {
	type: "set_debug_synctex";
	pdf_id: number;
	enabled: boolean;
}

export interface ViewerHostSynctexForwardRange {
	page: number;
	h: number;
	v: number;
	W: number;
	H: number;
}

export interface ViewerHostSynctexForwardMessage {
	type: "synctex_forward";
	pdf_id: number;
	page: number;
	x: number;
	y: number;
	width?: number;
	height?: number;
	ranges?: ViewerHostSynctexForwardRange[];
	indicator?: boolean;
	source_file?: string;
	line: number;
	source_line?: string;
}

export interface ViewerHostPdfMaybeUpdatedMessage {
	type: "pdf_maybe_updated";
	pdf_id: number;
}

export interface ViewerHostClearPdfAnnotationsMessage {
	type: "clear_pdf_annotations";
	pdf_id: number;
}

export type ViewerHostSynctexPrecision = "verified" | "text" | "line" | "raw";

export interface ViewerHostReverseSynctexCandidateSummary {
	source_file?: string;
	line: number;
	column?: number;
	source_line?: string;
	score?: number;
	structural?: boolean;
	distance?: number;
	distance_x?: number;
	distance_y?: number;
}

export interface ViewerHostReverseSynctexForwardVerificationSummary {
	attempted: boolean;
	contains_click: boolean;
	boxes_considered?: number;
	boxes_filtered?: number;
	chosen_box?: ViewerHostSynctexForwardRange;
}

export interface ViewerHostReverseSynctexHoverResultMessage {
	type: "reverse_synctex_hover_result";
	pdf_id: number;
	request_id: number;
	page: number;
	x: number;
	y: number;
	source_file?: string;
	line?: number;
	column?: number;
	source_line?: string;
	rect?: { left: number; top: number; right: number; bottom: number };
	precision?: ViewerHostSynctexPrecision;
	selected_score?: number;
	nearest_candidate?: ViewerHostReverseSynctexCandidateSummary;
	/** @deprecated Use nearest_candidate; retained only for older viewer frames. */
	raw?: ViewerHostReverseSynctexCandidateSummary;
	repaired?: ViewerHostReverseSynctexCandidateSummary & { precision?: ViewerHostSynctexPrecision };
	candidates?: ViewerHostReverseSynctexCandidateSummary[];
	forward?: ViewerHostReverseSynctexForwardVerificationSummary;
	error?: string;
}

export interface ViewerHostReverseSynctexForwardProbeResultMessage {
	type: "reverse_synctex_forward_probe_result";
	pdf_id: number;
	request_id: number;
	click_page: number;
	click_x: number;
	click_y: number;
	reverse_source_file?: string;
	reverse_line?: number;
	reverse_column?: number;
	reverse_source_line?: string;
	page?: number;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	ranges?: ViewerHostSynctexForwardRange[];
	indicator?: boolean;
	source_file?: string;
	line?: number;
	source_line?: string;
	error?: string;
}

export type McpToViewerHostMessage =
	| ViewerHostHelloMessage
	| ViewerHostOpenPdfMessage
	| ViewerHostFocusPdfMessage
	| ViewerHostSetDebugSynctexMessage
	| ViewerHostSynctexForwardMessage
	| ViewerHostPdfMaybeUpdatedMessage
	| ViewerHostClearPdfAnnotationsMessage
	| ViewerHostReverseSynctexHoverResultMessage
	| ViewerHostReverseSynctexForwardProbeResultMessage;

export interface ViewerHostReadyMessage {
	type: "ready";
	protocol_version: number;
	origin: string;
	active_viewer_clients?: number;
}

export interface ViewerHostViewerLoadedMessage {
	type: "viewer_loaded";
	pdf_id: number;
}

export interface ViewerHostViewerTabClosedMessage {
	type: "viewer_tab_closed";
	pdf_id: number;
}

export interface ViewerHostReverseSynctexMessage {
	type: "reverse_synctex";
	pdf_id: number;
	page: number;
	x: number;
	y: number;
	textBeforeSelection?: string;
	textAfterSelection?: string;
	selectedText?: string;
	selectionStartX?: number;
	selectionStartY?: number;
	selectionEndX?: number;
	selectionEndY?: number;
}

export interface ViewerHostPdfAnnotationMessage {
	type: "pdf_annotation";
	pdf_id: number;
	annotation_id: string;
	page: number;
	x: number;
	y: number;
	source_file: string;
	line: number;
	source_line?: string;
	comment?: string;
}

export interface ViewerHostPdfAnnotationDeletedMessage {
	type: "pdf_annotation_deleted";
	pdf_id: number;
	annotation_id: string;
}

export interface ViewerHostSelectionDebugMessage {
	type: "selection_debug";
	pdf_id: number;
	phase: string;
	page?: number;
	text: string;
	details: Record<string, unknown>;
}

export interface ViewerHostReverseSynctexHoverMessage {
	type: "reverse_synctex_hover";
	pdf_id: number;
	request_id: number;
	page: number;
	x: number;
	y: number;
	textBeforeSelection?: string;
	textAfterSelection?: string;
}

export interface ViewerHostReverseSynctexForwardProbeMessage {
	type: "reverse_synctex_forward_probe";
	pdf_id: number;
	request_id: number;
	page: number;
	x: number;
	y: number;
	textBeforeSelection?: string;
	textAfterSelection?: string;
}

export type ViewerHostToMcpMessage =
	| ViewerHostReadyMessage
	| ViewerHostViewerLoadedMessage
	| ViewerHostViewerTabClosedMessage
	| ViewerHostReverseSynctexMessage
	| ViewerHostPdfAnnotationMessage
	| ViewerHostPdfAnnotationDeletedMessage
	| ViewerHostSelectionDebugMessage
	| ViewerHostReverseSynctexHoverMessage
	| ViewerHostReverseSynctexForwardProbeMessage;

export interface ViewerHostControlAcceptedResult {
	type: McpToViewerHostMessage["type"];
	pdf_id?: number;
	revision?: number;
	browser_open_attempted?: boolean;
	browser_open_confirmed?: boolean;
	browser_open_error?: string;
	active_viewer_clients?: number;
}

export type ViewerHostControlResponse =
	| { ok: true; message: ViewerHostReadyMessage }
	| { ok: true; result: ViewerHostControlAcceptedResult }
	| { ok: false; error: { code: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireStringType(value: Record<string, unknown>): string {
	if (typeof value.type !== "string" || !value.type.trim()) {
		throw new Error("Viewer Host protocol message requires a string type");
	}
	return value.type;
}

function requirePositiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive integer`);
	}
	return value;
}

function requireCoordinate(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a finite non-negative number`);
	}
	return value;
}

function optionalCoordinate(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	return requireCoordinate(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a boolean`);
	}
	return value;
}

function parseSynctexForwardRange(value: unknown, field: string): ViewerHostSynctexForwardRange {
	if (!isRecord(value)) {
		throw new Error(`${field} must be an object`);
	}
	return {
		page: requirePositiveInteger(value.page, `${field}.page`),
		h: requireCoordinate(value.h, `${field}.h`),
		v: requireCoordinate(value.v, `${field}.v`),
		W: requireCoordinate(value.W, `${field}.W`),
		H: requireCoordinate(value.H, `${field}.H`),
	};
}

function parseHoverRect(value: unknown, field: string): { left: number; top: number; right: number; bottom: number } {
	if (!isRecord(value)) {
		throw new Error(`${field} must be an object`);
	}
	return {
		left: requireCoordinate(value.left, `${field}.left`),
		top: requireCoordinate(value.top, `${field}.top`),
		right: requireCoordinate(value.right, `${field}.right`),
		bottom: requireCoordinate(value.bottom, `${field}.bottom`),
	};
}

function optionalHoverRect(value: unknown, field: string): { left: number; top: number; right: number; bottom: number } | undefined {
	if (value === undefined) return undefined;
	return parseHoverRect(value, field);
}

function optionalSynctexRanges(value: unknown, field: string): ViewerHostSynctexForwardRange[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array`);
	}
	if (value.length === 0) {
		throw new Error(`${field} must not be empty`);
	}
	return value.map((entry, index) => parseSynctexForwardRange(entry, `${field}[${index}]`));
}

function optionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${field} must be a finite number`);
	}
	return value;
}

function optionalPrecision(value: unknown, field: string): ViewerHostSynctexPrecision | undefined {
	if (value === undefined) return undefined;
	if (value !== "verified" && value !== "text" && value !== "line" && value !== "raw") {
		throw new Error(`${field} must be a SyncTeX precision`);
	}
	return value;
}

function parseReverseSynctexCandidateSummary(value: unknown, field: string): ViewerHostReverseSynctexCandidateSummary {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const sourceFile = optionalNonEmptyString(value.source_file, `${field}.source_file`);
	const column = value.column === undefined ? undefined : requireCoordinate(value.column, `${field}.column`);
	const sourceLine = optionalString(value.source_line, `${field}.source_line`);
	const score = optionalNumber(value.score, `${field}.score`);
	const structural = optionalBoolean(value.structural, `${field}.structural`);
	const distance = optionalNumber(value.distance, `${field}.distance`);
	const distanceX = optionalNumber(value.distance_x, `${field}.distance_x`);
	const distanceY = optionalNumber(value.distance_y, `${field}.distance_y`);
	return {
		...(sourceFile === undefined ? {} : { source_file: sourceFile }),
		line: requirePositiveInteger(value.line, `${field}.line`),
		...(column === undefined ? {} : { column }),
		...(sourceLine === undefined ? {} : { source_line: sourceLine }),
		...(score === undefined ? {} : { score }),
		...(structural === undefined ? {} : { structural }),
		...(distance === undefined ? {} : { distance }),
		...(distanceX === undefined ? {} : { distance_x: distanceX }),
		...(distanceY === undefined ? {} : { distance_y: distanceY }),
	};
}

function optionalReverseSynctexCandidateSummary(value: unknown, field: string): ViewerHostReverseSynctexCandidateSummary | undefined {
	if (value === undefined) return undefined;
	return parseReverseSynctexCandidateSummary(value, field);
}

function optionalReverseSynctexCandidateSummaries(value: unknown, field: string): ViewerHostReverseSynctexCandidateSummary[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	return value.map((entry, index) => parseReverseSynctexCandidateSummary(entry, `${field}[${index}]`));
}

function optionalForwardVerificationSummary(value: unknown, field: string): ViewerHostReverseSynctexForwardVerificationSummary | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const boxesConsidered = optionalNumber(value.boxes_considered, `${field}.boxes_considered`);
	const boxesFiltered = optionalNumber(value.boxes_filtered, `${field}.boxes_filtered`);
	const chosenBox = value.chosen_box === undefined ? undefined : parseSynctexForwardRange(value.chosen_box, `${field}.chosen_box`);
	return {
		attempted: optionalBoolean(value.attempted, `${field}.attempted`) ?? false,
		contains_click: optionalBoolean(value.contains_click, `${field}.contains_click`) ?? false,
		...(boxesConsidered === undefined ? {} : { boxes_considered: boxesConsidered }),
		...(boxesFiltered === undefined ? {} : { boxes_filtered: boxesFiltered }),
		...(chosenBox === undefined ? {} : { chosen_box: chosenBox }),
	};
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requireNonEmptyString(value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string`);
	}
	return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value) || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value;
}

function requireProtocolVersion(value: unknown): number {
	return requirePositiveInteger(value, "protocol_version");
}

function requireOrigin(value: unknown): string {
	const origin = requireNonEmptyString(value, "origin");
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("origin must be an http(s) URL");
		}
	} catch (error) {
		if (error instanceof Error && error.message === "origin must be an http(s) URL") throw error;
		throw new Error("origin must be a valid URL");
	}
	return origin;
}

export function validateMcpToViewerHostMessage(message: unknown): McpToViewerHostMessage {
	if (!isRecord(message)) {
		throw new Error("Viewer Host protocol message must be an object");
	}
	const type = requireStringType(message);
	switch (type) {
		case "hello":
			return { type, protocol_version: requireProtocolVersion(message.protocol_version) };
		case "open_pdf": {
			const title = optionalNonEmptyString(message.title, "title");
			const workspaceCwd = optionalNonEmptyString(message.workspace_cwd, "workspace_cwd");
			const debugSynctex = optionalBoolean(message.debug_synctex, "debug_synctex");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				pdf_path: requireNonEmptyString(message.pdf_path, "pdf_path"),
				...(title === undefined ? {} : { title }),
				...(workspaceCwd === undefined ? {} : { workspace_cwd: workspaceCwd }),
				...(debugSynctex === undefined ? {} : { debug_synctex: debugSynctex }),
			};
		}
		case "focus_pdf":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id") };
		case "set_debug_synctex":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"), enabled: optionalBoolean(message.enabled, "enabled") ?? false };
		case "synctex_forward": {
			const sourceFile = optionalNonEmptyString(message.source_file, "source_file");
			const sourceLine = optionalString(message.source_line, "source_line");
			const width = optionalCoordinate(message.width, "width");
			const height = optionalCoordinate(message.height, "height");
			const ranges = optionalSynctexRanges(message.ranges, "ranges");
			const indicator = optionalBoolean(message.indicator, "indicator");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				...(width === undefined ? {} : { width }),
				...(height === undefined ? {} : { height }),
				...(ranges === undefined ? {} : { ranges }),
				...(indicator === undefined ? {} : { indicator }),
				...(sourceFile === undefined ? {} : { source_file: sourceFile }),
				line: requirePositiveInteger(message.line, "line"),
				...(sourceLine === undefined ? {} : { source_line: sourceLine }),
			};
		}
		case "pdf_maybe_updated":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id") };
		case "clear_pdf_annotations":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id") };
		case "reverse_synctex_hover_result": {
			const sourceFile = optionalNonEmptyString(message.source_file, "source_file");
			const line = message.line === undefined ? undefined : requirePositiveInteger(message.line, "line");
			const column = message.column === undefined ? undefined : requireCoordinate(message.column, "column");
			const sourceLine = optionalString(message.source_line, "source_line");
			const rect = optionalHoverRect(message.rect, "rect");
			const precision = optionalPrecision(message.precision, "precision");
			const selectedScore = optionalNumber(message.selected_score, "selected_score");
			const nearestCandidate = optionalReverseSynctexCandidateSummary(message.nearest_candidate, "nearest_candidate");
			const raw = optionalReverseSynctexCandidateSummary(message.raw, "raw");
			const initialCandidate = nearestCandidate ?? raw;
			const repairedBase = optionalReverseSynctexCandidateSummary(message.repaired, "repaired");
			const repairedPrecision = isRecord(message.repaired) ? optionalPrecision(message.repaired.precision, "repaired.precision") : undefined;
			const repaired = repairedBase === undefined ? undefined : { ...repairedBase, ...(repairedPrecision === undefined ? {} : { precision: repairedPrecision }) };
			const candidates = optionalReverseSynctexCandidateSummaries(message.candidates, "candidates");
			const forward = optionalForwardVerificationSummary(message.forward, "forward");
			const error = optionalString(message.error, "error");
			if (error === undefined && (sourceFile === undefined || line === undefined || column === undefined || rect === undefined)) {
				throw new Error("reverse_synctex_hover_result requires source_file, line, column, and rect unless error is set");
			}
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				request_id: requirePositiveInteger(message.request_id, "request_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				...(sourceFile === undefined ? {} : { source_file: sourceFile }),
				...(line === undefined ? {} : { line }),
				...(column === undefined ? {} : { column }),
				...(sourceLine === undefined ? {} : { source_line: sourceLine }),
				...(rect === undefined ? {} : { rect }),
				...(precision === undefined ? {} : { precision }),
				...(selectedScore === undefined ? {} : { selected_score: selectedScore }),
				...(initialCandidate === undefined ? {} : { nearest_candidate: initialCandidate }),
				...(repaired === undefined ? {} : { repaired }),
				...(candidates === undefined ? {} : { candidates }),
				...(forward === undefined ? {} : { forward }),
				...(error === undefined ? {} : { error }),
			};
		}
		case "reverse_synctex_forward_probe_result": {
			const reverseSourceFile = optionalNonEmptyString(message.reverse_source_file, "reverse_source_file");
			const reverseLine = message.reverse_line === undefined ? undefined : requirePositiveInteger(message.reverse_line, "reverse_line");
			const reverseColumn = message.reverse_column === undefined ? undefined : requireCoordinate(message.reverse_column, "reverse_column");
			const reverseSourceLine = optionalString(message.reverse_source_line, "reverse_source_line");
			const page = message.page === undefined ? undefined : requirePositiveInteger(message.page, "page");
			const x = message.x === undefined ? undefined : requireCoordinate(message.x, "x");
			const y = message.y === undefined ? undefined : requireCoordinate(message.y, "y");
			const width = optionalCoordinate(message.width, "width");
			const height = optionalCoordinate(message.height, "height");
			const ranges = optionalSynctexRanges(message.ranges, "ranges");
			const indicator = optionalBoolean(message.indicator, "indicator");
			const sourceFile = optionalNonEmptyString(message.source_file, "source_file");
			const line = message.line === undefined ? undefined : requirePositiveInteger(message.line, "line");
			const sourceLine = optionalString(message.source_line, "source_line");
			const error = optionalString(message.error, "error");
			if (error === undefined && (reverseSourceFile === undefined || reverseLine === undefined || reverseColumn === undefined || page === undefined || x === undefined || y === undefined || sourceFile === undefined || line === undefined)) {
				throw new Error("reverse_synctex_forward_probe_result requires reverse source and forward mapping fields unless error is set");
			}
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				request_id: requirePositiveInteger(message.request_id, "request_id"),
				click_page: requirePositiveInteger(message.click_page, "click_page"),
				click_x: requireCoordinate(message.click_x, "click_x"),
				click_y: requireCoordinate(message.click_y, "click_y"),
				...(reverseSourceFile === undefined ? {} : { reverse_source_file: reverseSourceFile }),
				...(reverseLine === undefined ? {} : { reverse_line: reverseLine }),
				...(reverseColumn === undefined ? {} : { reverse_column: reverseColumn }),
				...(reverseSourceLine === undefined ? {} : { reverse_source_line: reverseSourceLine }),
				...(page === undefined ? {} : { page }),
				...(x === undefined ? {} : { x }),
				...(y === undefined ? {} : { y }),
				...(width === undefined ? {} : { width }),
				...(height === undefined ? {} : { height }),
				...(ranges === undefined ? {} : { ranges }),
				...(indicator === undefined ? {} : { indicator }),
				...(sourceFile === undefined ? {} : { source_file: sourceFile }),
				...(line === undefined ? {} : { line }),
				...(sourceLine === undefined ? {} : { source_line: sourceLine }),
				...(error === undefined ? {} : { error }),
			};
		}
		default:
			throw new Error(`unknown message type: ${type}`);
	}
}

export function validateViewerHostToMcpMessage(message: unknown): ViewerHostToMcpMessage {
	if (!isRecord(message)) {
		throw new Error("Viewer Host protocol message must be an object");
	}
	const type = requireStringType(message);
	switch (type) {
		case "ready":
			return {
				type,
				protocol_version: requireProtocolVersion(message.protocol_version),
				origin: requireOrigin(message.origin),
			};
		case "viewer_loaded":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id") };
		case "viewer_tab_closed":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id") };
		case "reverse_synctex": {
			const textBeforeSelection = optionalString(message.textBeforeSelection, "textBeforeSelection");
			const textAfterSelection = optionalString(message.textAfterSelection, "textAfterSelection");
			const selectedText = optionalString(message.selectedText, "selectedText");
			const selectionStartX = optionalCoordinate(message.selectionStartX, "selectionStartX");
			const selectionStartY = optionalCoordinate(message.selectionStartY, "selectionStartY");
			const selectionEndX = optionalCoordinate(message.selectionEndX, "selectionEndX");
			const selectionEndY = optionalCoordinate(message.selectionEndY, "selectionEndY");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				...(textBeforeSelection === undefined ? {} : { textBeforeSelection }),
				...(textAfterSelection === undefined ? {} : { textAfterSelection }),
				...(selectedText === undefined ? {} : { selectedText }),
				...(selectionStartX === undefined ? {} : { selectionStartX }),
				...(selectionStartY === undefined ? {} : { selectionStartY }),
				...(selectionEndX === undefined ? {} : { selectionEndX }),
				...(selectionEndY === undefined ? {} : { selectionEndY }),
			};
		}
		case "pdf_annotation": {
			const sourceLine = optionalString(message.source_line, "source_line");
			const comment = optionalString(message.comment, "comment");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				annotation_id: requireNonEmptyString(message.annotation_id, "annotation_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				source_file: requireNonEmptyString(message.source_file, "source_file"),
				line: requirePositiveInteger(message.line, "line"),
				...(sourceLine === undefined ? {} : { source_line: sourceLine }),
				...(comment === undefined ? {} : { comment }),
			};
		}
		case "pdf_annotation_deleted":
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				annotation_id: requireNonEmptyString(message.annotation_id, "annotation_id"),
			};
		case "selection_debug": {
			const page = message.page === undefined ? undefined : requirePositiveInteger(message.page, "page");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				phase: requireNonEmptyString(message.phase, "phase"),
				...(page === undefined ? {} : { page }),
				text: optionalString(message.text, "text") ?? "",
				details: requireRecord(message.details, "details"),
			};
		}
		case "reverse_synctex_hover":
		case "reverse_synctex_forward_probe": {
			const textBeforeSelection = optionalString(message.textBeforeSelection, "textBeforeSelection");
			const textAfterSelection = optionalString(message.textAfterSelection, "textAfterSelection");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				request_id: requirePositiveInteger(message.request_id, "request_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				...(textBeforeSelection === undefined ? {} : { textBeforeSelection }),
				...(textAfterSelection === undefined ? {} : { textAfterSelection }),
			};
		}
		default:
			throw new Error(`unknown message type: ${type}`);
	}
}

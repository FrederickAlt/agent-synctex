export const VIEWER_HOST_PROTOCOL_VERSION = 3 as const;
export const VIEWER_HOST_CONTROL_TOKEN_HEADER = "x-agent-synctex-viewer-host-token" as const;
export const VIEWER_HOST_HEARTBEAT_TOKEN_HEADER = "x-agent-synctex-viewer-host-heartbeat-token" as const;
export const VIEWER_HOST_SHUTDOWN_TOKEN_HEADER = "x-agent-synctex-shutdown-token" as const;

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

export interface ViewerHostPdfTextSpan extends ViewerHostSynctexForwardRange {
	text: string;
}

export interface ViewerHostSourceSpan {
	source_file: string;
	start_line: number;
	end_line: number;
}

/** A page-local PDF-space rectangle using the SyncTeX h/v/W/H convention. */
export interface ViewerHostSynctexBox {
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

export interface ViewerHostCompileStatusMessage {
	type: "compile_status";
	pdf_id: number;
	running: boolean;
	continuous: boolean;
	severity?: "info" | "error";
	message?: string;
	inject_text?: string;
}

export interface ViewerHostReportErrorMessage {
	type: "report_error";
	pdf_id?: number;
	code: string;
	title: string;
	detail: string;
	inject_text?: string;
}

export interface ViewerHostErrorMessage {
	type: "viewer_error";
	pdf_id?: number;
	code: string;
	title: string;
	detail: string;
	inject_text?: string;
}

export type ViewerHostSynctexPrecision = "verified" | "text" | "line" | "raw";

export interface ViewerHostReverseSynctexCandidateSummary {
	source_file?: string;
	line: number;
	column?: number;
	source_line?: string;
	rect?: { left: number; top: number; right: number; bottom: number };
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

export interface ViewerHostReverseSynctexBoxMessage extends ViewerHostSynctexBox {
	type: "reverse_synctex_box";
	pdf_id: number;
	request_id: number;
	pdf_text_spans?: ViewerHostPdfTextSpan[];
}

export interface ViewerHostReverseSynctexBoxResultMessage extends ViewerHostSynctexBox {
	type: "reverse_synctex_box_result";
	pdf_id: number;
	request_id: number;
	source_spans?: ViewerHostSourceSpan[];
	ranges?: ViewerHostSynctexForwardRange[];
	source_file?: string;
	line?: number;
	source_line?: string;
	error?: string;
}

export interface ViewerHostDebugProposalIdentity {
	kind: "text" | "ranked";
	/** Source-proposal provenance, not the forward lookup or box-group flavor. */
	provenance: "synctex_reverse" | "selection_text_context";
	source_file: string;
	line: number;
	column: number;
	rank: number;
	structural: boolean;
	text_status?: "unique" | "ambiguous-small";
}

export interface ViewerHostDebugParsedTreeLeaf {
	page: number;
	source_file: string;
	line: number;
	h: number;
	v: number;
	W: number;
	H: number;
}

export interface ViewerHostDebugParsedTreeBox extends ViewerHostDebugParsedTreeLeaf {
	type: string;
}

export interface ViewerHostDebugParsedTreeCandidate {
	leaf: ViewerHostDebugParsedTreeLeaf;
	box: ViewerHostDebugParsedTreeBox;
	ancestors: ViewerHostDebugParsedTreeBox[];
	ancestors_truncated?: boolean;
}

export interface ViewerHostDebugForwardBoxScore {
	box: ViewerHostSynctexForwardRange;
	contains_click: boolean;
	geometry_tier: number;
	distance: number;
	distance_squared: number;
	distance_multiplier: number;
	distance_term: number;
	area: number;
	area_term: number;
	tiny_penalty: number;
	/** Max of the independent semantic sources below; it is not their sum. */
	semantic_penalty: number;
	pdf_text_span_semantic_penalty: number;
	selection_text_context_semantic_penalty: number;
	blank_source_line_penalty: number;
	click_containment_bonus: number;
	text_containment_bonus: number;
	text_containment?: "full" | "partial";
	end_document_penalty: number;
	total: number;
	order: number;
	selected: boolean;
	/** Parsed-tree provenance when this score came from a JS SyncTeX tree candidate. */
	tree_candidate?: ViewerHostDebugParsedTreeCandidate;
}

export interface ViewerHostDebugForwardGroup {
	proposal: ViewerHostDebugProposalIdentity;
	proposal_selected: boolean;
	proposal_order: {
		index: number;
		geometry_tier: number;
		total: number;
		exact_lookup_preferred: boolean;
		same_page_box_count: number;
		rank: number;
		line: number;
		source_file: string;
	};
	/** Forward box-group/lookup flavor, distinct from proposal.provenance. */
	origin: "synctex_exact" | "pdf_text_span";
	lookup_line: number;
	semantic_penalty: number;
	pdf_text_span_semantic_penalty: number;
	selection_text_context_semantic_penalty: number;
	blank_source_line_penalty: number;
	original_box_count: number;
	filtered_box_count: number;
	same_page_box_count: number;
	rejected_invalid: number;
	rejected_absurd: number;
	contains_click: boolean;
	geometry_tier: number;
	distance?: number;
	distance_squared?: number;
	distance_multiplier?: number;
	distance_term?: number;
	area?: number;
	area_term?: number;
	tiny_penalty?: number;
	click_containment_bonus: number;
	text_containment_bonus: number;
	text_containment?: "full" | "partial";
	end_document_penalty?: number;
	score: number;
	group_order: {
		index: number;
		geometry_tier: number;
		total: number;
		exact_lookup_preferred: boolean;
	};
	selected: boolean;
	chosen_box?: ViewerHostSynctexForwardRange;
	box_score_count: number;
	box_scores_truncated: boolean;
	box_scores: ViewerHostDebugForwardBoxScore[];
}

export interface ViewerHostDebugProposalScore extends ViewerHostDebugProposalIdentity {
	geometry_tier: number;
	score: number;
	precision: ViewerHostSynctexPrecision;
	same_page_box_count: number;
	contains_click: boolean;
	click_containment_bonus: number;
	text_containment_bonus: number;
	text_containment?: "full" | "partial";
	distance?: number;
	reason?: string;
	forward_lookup_mode?: "exact";
}

/** Bounded trace captured for a debug reverse-forward probe and retained with its annotation. */
export interface ViewerHostPdfAnnotationSynctexDiagnostics {
	top_proposals: ViewerHostDebugProposalScore[];
	selected_score?: number;
	forward_groups: ViewerHostDebugForwardGroup[];
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
	source_span?: ViewerHostSourceSpan;
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
	/** Exact visible text from the viewer element under the probe click. */
	pdf_mark?: string;
	/** Present only for an explicit SyncTeX debug session. */
	debug_candidates?: ViewerHostReverseSynctexCandidateSummary[];
	debug_selected_score?: number;
	/** Present only for an explicit SyncTeX debug session. */
	debug_forward_groups?: ViewerHostDebugForwardGroup[];
	/** Bounded trace intended for a debug-created PDF annotation. */
	synctex_diagnostics?: ViewerHostPdfAnnotationSynctexDiagnostics;
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
	| ViewerHostCompileStatusMessage
	| ViewerHostReportErrorMessage
	| ViewerHostReverseSynctexHoverResultMessage;

export interface ViewerHostReadyMessage {
	type: "ready";
	protocol_version: number;
	origin: string;
	instance_id: string;
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
	page_height?: number;
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
	/** Exact visible text from the viewer element that created this annotation. */
	pdf_mark?: string;
	/** Normalized source ranges belonging to this single annotation. */
	source_spans?: ViewerHostSourceSpan[];
	/** @deprecated Use source_spans. Retained for marks created by an older viewer. */
	source_span?: ViewerHostSourceSpan;
	/** The source file is newer than the PDF that produced this mapping. */
	source_stale?: boolean;
	/** Bounded trace retained only when this mark was created from an explicit debug probe. */
	synctex_diagnostics?: ViewerHostPdfAnnotationSynctexDiagnostics;
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
	page_height?: number;
	pdf_text_spans?: ViewerHostPdfTextSpan[];
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
	page_height?: number;
	pdf_text_spans?: ViewerHostPdfTextSpan[];
	textBeforeSelection?: string;
	textAfterSelection?: string;
}

export interface ViewerHostCompileActionMessage {
	type: "compile_action";
	pdf_id: number;
	action: "compile" | "stop" | "continuous_on" | "continuous_off" | "status" | "inject_diagnostic";
	inject_text?: string;
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
	| ViewerHostReverseSynctexForwardProbeMessage
	| ViewerHostReverseSynctexBoxMessage
	| ViewerHostCompileActionMessage;

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

export function validateViewerHostControlResponse(value: unknown): ViewerHostControlResponse {
	if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error("Viewer Host control response must include boolean ok");
	if (value.ok === false) {
		if (!isRecord(value.error)) throw new Error("Viewer Host control error response requires error details");
		return {
			ok: false,
			error: {
				code: requireNonEmptyString(value.error.code, "error.code"),
				message: requireNonEmptyString(value.error.message, "error.message"),
			},
		};
	}
	if (value.message !== undefined) {
		const parsed = validateViewerHostToMcpMessage(value.message);
		if (parsed.type !== "ready") throw new Error("Viewer Host control message response must be ready");
		return { ok: true, message: parsed };
	}
	if (!isRecord(value.result)) throw new Error("Viewer Host successful control response requires message or result");
	const result: ViewerHostControlAcceptedResult = {
		type: requireNonEmptyString(value.result.type, "result.type") as ViewerHostControlAcceptedResult["type"],
		...(value.result.pdf_id === undefined ? {} : { pdf_id: requirePositiveInteger(value.result.pdf_id, "result.pdf_id") }),
		...(value.result.revision === undefined ? {} : { revision: requirePositiveInteger(value.result.revision, "result.revision") }),
		...(value.result.browser_open_attempted === undefined ? {} : { browser_open_attempted: optionalBoolean(value.result.browser_open_attempted, "result.browser_open_attempted") }),
		...(value.result.browser_open_confirmed === undefined ? {} : { browser_open_confirmed: optionalBoolean(value.result.browser_open_confirmed, "result.browser_open_confirmed") }),
		...(value.result.browser_open_error === undefined ? {} : { browser_open_error: requireNonEmptyString(value.result.browser_open_error, "result.browser_open_error") }),
		...(value.result.active_viewer_clients === undefined ? {} : { active_viewer_clients: requireNonNegativeInteger(value.result.active_viewer_clients, "result.active_viewer_clients") }),
	};
	return { ok: true, result };
}

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

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
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

function requireBoolean(value: unknown, field: string): boolean {
	const parsed = optionalBoolean(value, field);
	if (parsed === undefined) throw new Error(`${field} must be a boolean`);
	return parsed;
}

function parseSynctexBox(value: unknown, field: string): ViewerHostSynctexBox {
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

function parseSynctexForwardRange(value: unknown, field: string): ViewerHostSynctexForwardRange {
	return parseSynctexBox(value, field);
}

function parsePdfTextSpan(value: unknown, field: string): ViewerHostPdfTextSpan {
	const range = parseSynctexForwardRange(value, field);
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	return { ...range, text: requireNonEmptyString(value.text, `${field}.text`) };
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

function parseSourceSpan(value: unknown, field: string): ViewerHostSourceSpan {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const startLine = requirePositiveInteger(value.start_line, `${field}.start_line`);
	const endLine = requirePositiveInteger(value.end_line, `${field}.end_line`);
	if (endLine < startLine) throw new Error(`${field}.end_line must be greater than or equal to start_line`);
	return {
		source_file: requireNonEmptyString(value.source_file, `${field}.source_file`),
		start_line: startLine,
		end_line: endLine,
	};
}

function optionalSourceSpan(value: unknown, field: string): ViewerHostSourceSpan | undefined {
	if (value === undefined) return undefined;
	return parseSourceSpan(value, field);
}

function optionalSourceSpans(value: unknown, field: string): ViewerHostSourceSpan[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
		throw new Error(`${field} must be a non-empty array of at most 500 source spans`);
	}
	return value.map((span, index) => parseSourceSpan(span, `${field}[${index}]`));
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

function optionalPdfTextSpans(value: unknown, field: string): ViewerHostPdfTextSpan[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	if (value.length === 0) throw new Error(`${field} must not be empty`);
	return value.map((entry, index) => parsePdfTextSpan(entry, `${field}[${index}]`));
}

function optionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${field} must be a finite number`);
	}
	return value;
}

function optionalCompileStatusSeverity(value: unknown, field: string): "info" | "error" | undefined {
	if (value === undefined) return undefined;
	if (value !== "info" && value !== "error") {
		throw new Error(`${field} must be info or error`);
	}
	return value;
}

function requireCompileAction(value: unknown, field: string): ViewerHostCompileActionMessage["action"] {
	if (value !== "compile" && value !== "stop" && value !== "continuous_on" && value !== "continuous_off" && value !== "status" && value !== "inject_diagnostic") {
		throw new Error(`${field} must be a compile action`);
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
	const rect = optionalHoverRect(value.rect, `${field}.rect`);
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
		...(rect === undefined ? {} : { rect }),
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

const MAX_SYNCTEX_DEBUG_TOP_PROPOSALS = 3;
const MAX_SYNCTEX_DEBUG_FORWARD_GROUPS = 12;
const MAX_SYNCTEX_DEBUG_BOX_SCORES = 16;
const MAX_SYNCTEX_DEBUG_TREE_ANCESTORS = 8;

function optionalTextContainment(value: unknown, field: string): "full" | "partial" | undefined {
	if (value === undefined) return undefined;
	if (value !== "full" && value !== "partial") throw new Error(`${field} must be full or partial`);
	return value;
}

function parseDebugProposalIdentity(value: unknown, field: string): ViewerHostDebugProposalIdentity {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const textStatus = value.text_status === undefined ? undefined : value.text_status;
	if (textStatus !== undefined && textStatus !== "unique" && textStatus !== "ambiguous-small") throw new Error(`${field}.text_status must be unique or ambiguous-small`);
	if (value.kind !== "text" && value.kind !== "ranked") throw new Error(`${field}.kind must be text or ranked`);
	if (value.provenance !== "synctex_reverse" && value.provenance !== "selection_text_context") throw new Error(`${field}.provenance must be a SyncTeX proposal provenance`);
	return {
		kind: value.kind,
		provenance: value.provenance,
		source_file: requireNonEmptyString(value.source_file, `${field}.source_file`),
		line: requirePositiveInteger(value.line, `${field}.line`),
		column: requireCoordinate(value.column, `${field}.column`),
		rank: requireNonNegativeInteger(value.rank, `${field}.rank`),
		structural: requireBoolean(value.structural, `${field}.structural`),
		...(textStatus === undefined ? {} : { text_status: textStatus }),
	};
}

function parseDebugProposalScore(value: unknown, field: string): ViewerHostDebugProposalScore {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const identity = parseDebugProposalIdentity(value, field);
	const textContainment = optionalTextContainment(value.text_containment, `${field}.text_containment`);
	const distance = optionalNumber(value.distance, `${field}.distance`);
	const reason = optionalString(value.reason, `${field}.reason`);
	if (value.precision !== "verified" && value.precision !== "text" && value.precision !== "line" && value.precision !== "raw") throw new Error(`${field}.precision must be a SyncTeX precision`);
	if (value.forward_lookup_mode !== undefined && value.forward_lookup_mode !== "exact") throw new Error(`${field}.forward_lookup_mode must be exact`);
	return {
		...identity,
		geometry_tier: requireNonNegativeInteger(value.geometry_tier, `${field}.geometry_tier`),
		score: optionalNumber(value.score, `${field}.score`) ?? (() => { throw new Error(`${field}.score must be a finite number`); })(),
		precision: value.precision,
		same_page_box_count: requireNonNegativeInteger(value.same_page_box_count, `${field}.same_page_box_count`),
		contains_click: requireBoolean(value.contains_click, `${field}.contains_click`),
		click_containment_bonus: optionalNumber(value.click_containment_bonus, `${field}.click_containment_bonus`) ?? (() => { throw new Error(`${field}.click_containment_bonus must be a finite number`); })(),
		text_containment_bonus: optionalNumber(value.text_containment_bonus, `${field}.text_containment_bonus`) ?? (() => { throw new Error(`${field}.text_containment_bonus must be a finite number`); })(),
		...(textContainment === undefined ? {} : { text_containment: textContainment }),
		...(distance === undefined ? {} : { distance }),
		...(reason === undefined ? {} : { reason }),
		...(value.forward_lookup_mode === undefined ? {} : { forward_lookup_mode: value.forward_lookup_mode }),
	};
}

function parseDebugTreeLeaf(value: unknown, field: string): ViewerHostDebugParsedTreeLeaf {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	return {
		page: requirePositiveInteger(value.page, `${field}.page`),
		source_file: requireNonEmptyString(value.source_file, `${field}.source_file`),
		line: requirePositiveInteger(value.line, `${field}.line`),
		h: requireCoordinate(value.h, `${field}.h`),
		v: requireCoordinate(value.v, `${field}.v`),
		W: requireCoordinate(value.W, `${field}.W`),
		H: requireCoordinate(value.H, `${field}.H`),
	};
}

function parseDebugTreeBox(value: unknown, field: string): ViewerHostDebugParsedTreeBox {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	return { type: requireNonEmptyString(value.type, `${field}.type`), ...parseDebugTreeLeaf(value, field) };
}

function optionalDebugTreeCandidate(value: unknown, field: string): ViewerHostDebugParsedTreeCandidate | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	if (!Array.isArray(value.ancestors) || value.ancestors.length > MAX_SYNCTEX_DEBUG_TREE_ANCESTORS) throw new Error(`${field}.ancestors must be an array of at most ${MAX_SYNCTEX_DEBUG_TREE_ANCESTORS} entries`);
	const truncated = optionalBoolean(value.ancestors_truncated, `${field}.ancestors_truncated`);
	return {
		leaf: parseDebugTreeLeaf(value.leaf, `${field}.leaf`),
		box: parseDebugTreeBox(value.box, `${field}.box`),
		ancestors: value.ancestors.map((ancestor, index) => parseDebugTreeBox(ancestor, `${field}.ancestors[${index}]`)),
		...(truncated === undefined ? {} : { ancestors_truncated: truncated }),
	};
}

function parseDebugForwardBoxScore(value: unknown, field: string): ViewerHostDebugForwardBoxScore {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const textContainment = optionalTextContainment(value.text_containment, `${field}.text_containment`);
	const treeCandidate = optionalDebugTreeCandidate(value.tree_candidate, `${field}.tree_candidate`);
	const requiredNumber = (key: string) => optionalNumber(value[key], `${field}.${key}`) ?? (() => { throw new Error(`${field}.${key} must be a finite number`); })();
	return {
		box: parseSynctexForwardRange(value.box, `${field}.box`),
		contains_click: requireBoolean(value.contains_click, `${field}.contains_click`),
		geometry_tier: requireNonNegativeInteger(value.geometry_tier, `${field}.geometry_tier`),
		distance: requiredNumber("distance"),
		distance_squared: requiredNumber("distance_squared"),
		distance_multiplier: requiredNumber("distance_multiplier"),
		distance_term: requiredNumber("distance_term"),
		area: requiredNumber("area"),
		area_term: requiredNumber("area_term"),
		tiny_penalty: requiredNumber("tiny_penalty"),
		semantic_penalty: requiredNumber("semantic_penalty"),
		pdf_text_span_semantic_penalty: requiredNumber("pdf_text_span_semantic_penalty"),
		selection_text_context_semantic_penalty: requiredNumber("selection_text_context_semantic_penalty"),
		blank_source_line_penalty: requiredNumber("blank_source_line_penalty"),
		click_containment_bonus: requiredNumber("click_containment_bonus"),
		text_containment_bonus: requiredNumber("text_containment_bonus"),
		...(textContainment === undefined ? {} : { text_containment: textContainment }),
		end_document_penalty: requiredNumber("end_document_penalty"),
		total: requiredNumber("total"),
		order: requireNonNegativeInteger(value.order, `${field}.order`),
		selected: requireBoolean(value.selected, `${field}.selected`),
		...(treeCandidate === undefined ? {} : { tree_candidate: treeCandidate }),
	};
}

function parseDebugForwardGroup(value: unknown, field: string): ViewerHostDebugForwardGroup {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	if (value.origin !== "synctex_exact" && value.origin !== "pdf_text_span") throw new Error(`${field}.origin must be a SyncTeX forward-group origin`);
	const proposalOrder = requireRecord(value.proposal_order, `${field}.proposal_order`);
	const groupOrder = requireRecord(value.group_order, `${field}.group_order`);
	const textContainment = optionalTextContainment(value.text_containment, `${field}.text_containment`);
	const optionalScore = (key: string) => optionalNumber(value[key], `${field}.${key}`);
	const requiredScore = (key: string) => optionalScore(key) ?? (() => { throw new Error(`${field}.${key} must be a finite number`); })();
	if (!Array.isArray(value.box_scores) || value.box_scores.length > MAX_SYNCTEX_DEBUG_BOX_SCORES) throw new Error(`${field}.box_scores must be an array of at most ${MAX_SYNCTEX_DEBUG_BOX_SCORES} entries`);
	const boxScoreCount = requireNonNegativeInteger(value.box_score_count, `${field}.box_score_count`);
	const boxScoresTruncated = requireBoolean(value.box_scores_truncated, `${field}.box_scores_truncated`);
	if (value.box_scores.length > boxScoreCount || (!boxScoresTruncated && value.box_scores.length !== boxScoreCount)) throw new Error(`${field}.box_scores must match box_score_count unless truncated`);
	return {
		proposal: parseDebugProposalIdentity(value.proposal, `${field}.proposal`),
		proposal_selected: requireBoolean(value.proposal_selected, `${field}.proposal_selected`),
		proposal_order: {
			index: requireNonNegativeInteger(proposalOrder.index, `${field}.proposal_order.index`),
			geometry_tier: requireNonNegativeInteger(proposalOrder.geometry_tier, `${field}.proposal_order.geometry_tier`),
			total: optionalNumber(proposalOrder.total, `${field}.proposal_order.total`) ?? (() => { throw new Error(`${field}.proposal_order.total must be a finite number`); })(),
			exact_lookup_preferred: requireBoolean(proposalOrder.exact_lookup_preferred, `${field}.proposal_order.exact_lookup_preferred`),
			same_page_box_count: requireNonNegativeInteger(proposalOrder.same_page_box_count, `${field}.proposal_order.same_page_box_count`),
			rank: requireNonNegativeInteger(proposalOrder.rank, `${field}.proposal_order.rank`),
			line: requirePositiveInteger(proposalOrder.line, `${field}.proposal_order.line`),
			source_file: requireNonEmptyString(proposalOrder.source_file, `${field}.proposal_order.source_file`),
		},
		origin: value.origin,
		lookup_line: requirePositiveInteger(value.lookup_line, `${field}.lookup_line`),
		semantic_penalty: requiredScore("semantic_penalty"),
		pdf_text_span_semantic_penalty: requiredScore("pdf_text_span_semantic_penalty"),
		selection_text_context_semantic_penalty: requiredScore("selection_text_context_semantic_penalty"),
		blank_source_line_penalty: requiredScore("blank_source_line_penalty"),
		original_box_count: requireNonNegativeInteger(value.original_box_count, `${field}.original_box_count`),
		filtered_box_count: requireNonNegativeInteger(value.filtered_box_count, `${field}.filtered_box_count`),
		same_page_box_count: requireNonNegativeInteger(value.same_page_box_count, `${field}.same_page_box_count`),
		rejected_invalid: requireNonNegativeInteger(value.rejected_invalid, `${field}.rejected_invalid`),
		rejected_absurd: requireNonNegativeInteger(value.rejected_absurd, `${field}.rejected_absurd`),
		contains_click: requireBoolean(value.contains_click, `${field}.contains_click`),
		geometry_tier: requireNonNegativeInteger(value.geometry_tier, `${field}.geometry_tier`),
		...(optionalScore("distance") === undefined ? {} : { distance: optionalScore("distance") }),
		...(optionalScore("distance_squared") === undefined ? {} : { distance_squared: optionalScore("distance_squared") }),
		...(optionalScore("distance_multiplier") === undefined ? {} : { distance_multiplier: optionalScore("distance_multiplier") }),
		...(optionalScore("distance_term") === undefined ? {} : { distance_term: optionalScore("distance_term") }),
		...(optionalScore("area") === undefined ? {} : { area: optionalScore("area") }),
		...(optionalScore("area_term") === undefined ? {} : { area_term: optionalScore("area_term") }),
		...(optionalScore("tiny_penalty") === undefined ? {} : { tiny_penalty: optionalScore("tiny_penalty") }),
		click_containment_bonus: requiredScore("click_containment_bonus"),
		text_containment_bonus: requiredScore("text_containment_bonus"),
		...(textContainment === undefined ? {} : { text_containment: textContainment }),
		...(optionalScore("end_document_penalty") === undefined ? {} : { end_document_penalty: optionalScore("end_document_penalty") }),
		score: requiredScore("score"),
		group_order: {
			index: requireNonNegativeInteger(groupOrder.index, `${field}.group_order.index`),
			geometry_tier: requireNonNegativeInteger(groupOrder.geometry_tier, `${field}.group_order.geometry_tier`),
			total: optionalNumber(groupOrder.total, `${field}.group_order.total`) ?? (() => { throw new Error(`${field}.group_order.total must be a finite number`); })(),
			exact_lookup_preferred: requireBoolean(groupOrder.exact_lookup_preferred, `${field}.group_order.exact_lookup_preferred`),
		},
		selected: requireBoolean(value.selected, `${field}.selected`),
		...(value.chosen_box === undefined ? {} : { chosen_box: parseSynctexForwardRange(value.chosen_box, `${field}.chosen_box`) }),
		box_score_count: boxScoreCount,
		box_scores_truncated: boxScoresTruncated,
		box_scores: value.box_scores.map((box, index) => parseDebugForwardBoxScore(box, `${field}.box_scores[${index}]`)),
	};
}

function optionalPdfAnnotationSynctexDiagnostics(value: unknown, field: string): ViewerHostPdfAnnotationSynctexDiagnostics | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	if (!Array.isArray(value.top_proposals) || value.top_proposals.length === 0 || value.top_proposals.length > MAX_SYNCTEX_DEBUG_TOP_PROPOSALS) throw new Error(`${field}.top_proposals must be a non-empty array of at most ${MAX_SYNCTEX_DEBUG_TOP_PROPOSALS} entries`);
	if (!Array.isArray(value.forward_groups) || value.forward_groups.length > MAX_SYNCTEX_DEBUG_FORWARD_GROUPS) throw new Error(`${field}.forward_groups must be an array of at most ${MAX_SYNCTEX_DEBUG_FORWARD_GROUPS} entries`);
	const selectedScore = optionalNumber(value.selected_score, `${field}.selected_score`);
	return {
		top_proposals: value.top_proposals.map((proposal, index) => parseDebugProposalScore(proposal, `${field}.top_proposals[${index}]`)),
		...(selectedScore === undefined ? {} : { selected_score: selectedScore }),
		forward_groups: value.forward_groups.map((group, index) => parseDebugForwardGroup(group, `${field}.forward_groups[${index}]`)),
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
		case "compile_status": {
			const severity = optionalCompileStatusSeverity(message.severity, "severity");
			const text = optionalString(message.message, "message");
			const injectText = optionalString(message.inject_text, "inject_text");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				running: optionalBoolean(message.running, "running") ?? false,
				continuous: optionalBoolean(message.continuous, "continuous") ?? false,
				...(severity === undefined ? {} : { severity }),
				...(text === undefined ? {} : { message: text }),
				...(injectText === undefined ? {} : { inject_text: injectText }),
			};
		}
		case "report_error": {
			const pdfId = message.pdf_id === undefined ? undefined : requirePositiveInteger(message.pdf_id, "pdf_id");
			const injectText = optionalString(message.inject_text, "inject_text");
			return {
				type,
				...(pdfId === undefined ? {} : { pdf_id: pdfId }),
				code: requireNonEmptyString(message.code, "code"),
				title: requireNonEmptyString(message.title, "title"),
				detail: requireNonEmptyString(message.detail, "detail"),
				...(injectText === undefined ? {} : { inject_text: injectText }),
			};
		}
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
		default:
			throw new Error(`unknown message type: ${type}`);
	}
}

export function sourceSpansForPdfAnnotation(mark: Pick<ViewerHostPdfAnnotationMessage, "source_file" | "line" | "source_span" | "source_spans">): ViewerHostSourceSpan[] {
	if (mark.source_spans !== undefined && mark.source_spans.length > 0) return mark.source_spans.map((span) => ({ ...span }));
	if (mark.source_span !== undefined) return [{ ...mark.source_span }];
	return [{ source_file: mark.source_file, start_line: mark.line, end_line: mark.line }];
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
				instance_id: requireNonEmptyString(message.instance_id, "instance_id"),
				...(message.active_viewer_clients === undefined ? {} : { active_viewer_clients: requireNonNegativeInteger(message.active_viewer_clients, "active_viewer_clients") }),
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
			const pageHeight = optionalCoordinate(message.page_height, "page_height");
			if (pageHeight !== undefined && pageHeight <= 0) throw new Error("page_height must be positive");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				...(pageHeight === undefined ? {} : { page_height: pageHeight }),
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
			const pdfMark = optionalString(message.pdf_mark, "pdf_mark");
			const sourceSpan = optionalSourceSpan(message.source_span, "source_span");
			const sourceSpans = optionalSourceSpans(message.source_spans, "source_spans");
			const sourceStale = optionalBoolean(message.source_stale, "source_stale");
			const synctexDiagnostics = optionalPdfAnnotationSynctexDiagnostics(message.synctex_diagnostics, "synctex_diagnostics");
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
				...(pdfMark === undefined ? {} : { pdf_mark: pdfMark }),
				...(sourceSpans === undefined ? {} : { source_spans: sourceSpans }),
				...(sourceSpan === undefined ? {} : { source_span: sourceSpan }),
				...(sourceStale === undefined ? {} : { source_stale: sourceStale }),
				...(synctexDiagnostics === undefined ? {} : { synctex_diagnostics: synctexDiagnostics }),
				...(comment === undefined ? {} : { comment }),
			};
		}
		case "reverse_synctex_box": {
			const box = parseSynctexBox(message, "reverse_synctex_box");
			if (box.W <= 0 || box.H <= 0) throw new Error("reverse_synctex_box.W and reverse_synctex_box.H must be positive");
			const pdfTextSpans = optionalPdfTextSpans(message.pdf_text_spans, "pdf_text_spans");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				request_id: requirePositiveInteger(message.request_id, "request_id"),
				...box,
				...(pdfTextSpans === undefined ? {} : { pdf_text_spans: pdfTextSpans }),
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
		case "compile_action": {
			const injectText = optionalString(message.inject_text, "inject_text");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				action: requireCompileAction(message.action, "action"),
				...(injectText === undefined ? {} : { inject_text: injectText }),
			};
		}
		case "reverse_synctex_hover":
		case "reverse_synctex_forward_probe": {
			const textBeforeSelection = optionalString(message.textBeforeSelection, "textBeforeSelection");
			const textAfterSelection = optionalString(message.textAfterSelection, "textAfterSelection");
			const pageHeight = optionalCoordinate(message.page_height, "page_height");
			if (pageHeight !== undefined && pageHeight <= 0) throw new Error("page_height must be positive");
			const pdfTextSpans = optionalPdfTextSpans(message.pdf_text_spans, "pdf_text_spans");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				request_id: requirePositiveInteger(message.request_id, "request_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				...(pageHeight === undefined ? {} : { page_height: pageHeight }),
				...(pdfTextSpans === undefined ? {} : { pdf_text_spans: pdfTextSpans }),
				...(textBeforeSelection === undefined ? {} : { textBeforeSelection }),
				...(textAfterSelection === undefined ? {} : { textAfterSelection }),
			};
		}
		default:
			throw new Error(`unknown message type: ${type}`);
	}
}

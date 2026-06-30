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
}

export interface ViewerHostFocusPdfMessage {
	type: "focus_pdf";
	pdf_id: number;
}

export interface ViewerHostSynctexForwardMessage {
	type: "synctex_forward";
	pdf_id: number;
	page: number;
	x: number;
	y: number;
	width?: number;
	height?: number;
	indicator?: boolean;
	source_file?: string;
	line: number;
}

export interface ViewerHostPdfMaybeUpdatedMessage {
	type: "pdf_maybe_updated";
	pdf_id: number;
}

export type McpToViewerHostMessage =
	| ViewerHostHelloMessage
	| ViewerHostOpenPdfMessage
	| ViewerHostFocusPdfMessage
	| ViewerHostSynctexForwardMessage
	| ViewerHostPdfMaybeUpdatedMessage;

export interface ViewerHostReadyMessage {
	type: "ready";
	protocol_version: number;
	origin: string;
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
}

export type ViewerHostToMcpMessage =
	| ViewerHostReadyMessage
	| ViewerHostViewerLoadedMessage
	| ViewerHostViewerTabClosedMessage
	| ViewerHostReverseSynctexMessage;

export interface ViewerHostControlAcceptedResult {
	type: McpToViewerHostMessage["type"];
	pdf_id?: number;
	revision?: number;
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
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				pdf_path: requireNonEmptyString(message.pdf_path, "pdf_path"),
				...(title === undefined ? {} : { title }),
			};
		}
		case "focus_pdf":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id") };
		case "synctex_forward": {
			const sourceFile = optionalNonEmptyString(message.source_file, "source_file");
			const width = optionalCoordinate(message.width, "width");
			const height = optionalCoordinate(message.height, "height");
			const indicator = optionalBoolean(message.indicator, "indicator");
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
				...(width === undefined ? {} : { width }),
				...(height === undefined ? {} : { height }),
				...(indicator === undefined ? {} : { indicator }),
				...(sourceFile === undefined ? {} : { source_file: sourceFile }),
				line: requirePositiveInteger(message.line, "line"),
			};
		}
		case "pdf_maybe_updated":
			return { type, pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id") };
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
		case "reverse_synctex":
			return {
				type,
				pdf_id: requirePositiveInteger(message.pdf_id, "pdf_id"),
				page: requirePositiveInteger(message.page, "page"),
				x: requireCoordinate(message.x, "x"),
				y: requireCoordinate(message.y, "y"),
			};
		default:
			throw new Error(`unknown message type: ${type}`);
	}
}

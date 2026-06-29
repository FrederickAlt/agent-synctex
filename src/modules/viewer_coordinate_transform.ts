export interface PdfJsViewportCoordinateConverter {
	convertToPdfPoint(viewportX: number, viewportY: number): [number, number];
	convertToViewportPoint(pdfX: number, pdfY: number): [number, number];
}

export interface ReverseSynctexViewportInput {
	page: number;
	viewportX: number;
	viewportY: number;
	viewport: PdfJsViewportCoordinateConverter;
}

export interface ReverseSynctexSocketPayload {
	type: "reverse_synctex";
	page: number;
	x: number;
	y: number;
}

export interface ForwardSynctexMarkerInput {
	pdfX: number;
	pdfY: number;
	width?: number;
	height?: number;
	viewport: PdfJsViewportCoordinateConverter;
}

export interface ForwardSynctexMarkerPosition {
	left: number;
	top: number;
	width: number;
	height: number;
}

export function reverseSynctexPayloadFromViewportPoint(input: ReverseSynctexViewportInput): ReverseSynctexSocketPayload {
	const [x, y] = input.viewport.convertToPdfPoint(input.viewportX, input.viewportY);
	return { type: "reverse_synctex", page: input.page, x, y };
}

const FALLBACK_FORWARD_HIGHLIGHT_WIDTH_POINTS = 96;
const FALLBACK_FORWARD_HIGHLIGHT_HEIGHT_POINTS = 10;

function viewportScale(input: { viewport: PdfJsViewportCoordinateConverter }): { x: number; y: number } {
	const [x0, y0] = input.viewport.convertToViewportPoint(0, 0);
	const [x1] = input.viewport.convertToViewportPoint(1, 0);
	const [, y1] = input.viewport.convertToViewportPoint(0, 1);
	return { x: Math.abs(x1 - x0) || 1, y: Math.abs(y1 - y0) || 1 };
}

export function forwardSynctexMarkerFromPdfPoint(input: ForwardSynctexMarkerInput): ForwardSynctexMarkerPosition {
	const scale = viewportScale(input);
	const [left] = input.viewport.convertToViewportPoint(input.pdfX, 0);
	const widthPoints = Math.max(input.width ?? 0, FALLBACK_FORWARD_HIGHLIGHT_WIDTH_POINTS);
	const heightPoints = Math.max(input.height ?? 0, FALLBACK_FORWARD_HIGHLIGHT_HEIGHT_POINTS);
	return {
		left,
		top: input.pdfY * scale.y,
		width: widthPoints * scale.x,
		height: heightPoints * scale.y,
	};
}

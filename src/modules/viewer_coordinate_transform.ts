export interface PdfJsViewportCoordinateConverter {
	convertToPdfPoint(viewportX: number, viewportY: number): [number, number];
	convertToViewportPoint(pdfX: number, pdfY: number): [number, number];
}

export interface ReverseSynctexViewportInput {
	page: number;
	viewportX: number;
	viewportY: number;
	viewportHeight: number;
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
	pageHeight?: number;
	viewport: PdfJsViewportCoordinateConverter;
}

export interface ForwardSynctexMarkerPosition {
	left: number;
	top: number;
	width?: number;
	height?: number;
}

export function reverseSynctexPayloadFromViewportPoint(input: ReverseSynctexViewportInput): ReverseSynctexSocketPayload {
	const [x, y] = input.viewport.convertToPdfPoint(input.viewportX, input.viewportHeight - input.viewportY);
	return { type: "reverse_synctex", page: input.page, x, y };
}

function viewportScale(input: { viewport: PdfJsViewportCoordinateConverter }): { x: number; y: number } {
	const [x0, y0] = input.viewport.convertToViewportPoint(0, 0);
	const [x1] = input.viewport.convertToViewportPoint(1, 0);
	const [, y1] = input.viewport.convertToViewportPoint(0, 1);
	return { x: Math.abs(x1 - x0) || 1, y: Math.abs(y1 - y0) || 1 };
}

export function forwardSynctexMarkerFromPdfPoint(input: ForwardSynctexMarkerInput): ForwardSynctexMarkerPosition {
	const scale = viewportScale(input);
	const [left, viewportY] = input.viewport.convertToViewportPoint(input.pdfX, input.pdfY);
	const pageHeight = input.pageHeight ?? input.viewport.convertToViewportPoint(0, 0)[1];
	const base = { left, top: pageHeight - viewportY };
	if (input.width === undefined || input.height === undefined) return base;
	return {
		...base,
		width: input.width * scale.x,
		height: input.height * scale.y,
	};
}

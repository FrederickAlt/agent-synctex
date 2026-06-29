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
	viewport: PdfJsViewportCoordinateConverter;
}

export interface ForwardSynctexMarkerPosition {
	left: number;
	top: number;
}

export function reverseSynctexPayloadFromViewportPoint(input: ReverseSynctexViewportInput): ReverseSynctexSocketPayload {
	const [x, y] = input.viewport.convertToPdfPoint(input.viewportX, input.viewportY);
	return { type: "reverse_synctex", page: input.page, x, y };
}

export function forwardSynctexMarkerFromPdfPoint(input: ForwardSynctexMarkerInput): ForwardSynctexMarkerPosition {
	const [left, top] = input.viewport.convertToViewportPoint(input.pdfX, input.pdfY);
	return { left, top };
}

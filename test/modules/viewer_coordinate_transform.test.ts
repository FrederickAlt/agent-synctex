import assert from "node:assert/strict";
import { test } from "node:test";
import {
	forwardSynctexMarkerFromPdfPoint,
	reverseSynctexPayloadFromViewportPoint,
	type PdfJsViewportCoordinateConverter,
} from "../../src/modules/viewer_coordinate_transform.ts";

function scaledViewport(scale: number, pageHeightPoints: number): PdfJsViewportCoordinateConverter {
	return {
		convertToPdfPoint(viewportX: number, viewportY: number): [number, number] {
			return [viewportX / scale, pageHeightPoints - (viewportY / scale)];
		},
		convertToViewportPoint(pdfX: number, pdfY: number): [number, number] {
			return [pdfX * scale, (pageHeightPoints - pdfY) * scale];
		},
	};
}

test("reverse SyncTeX click coordinates are converted from viewport/CSS pixels to PDF points", () => {
	const viewport = scaledViewport(1.25, 200);

	const payload = reverseSynctexPayloadFromViewportPoint({ page: 2, viewportX: 125, viewportY: 50, viewport });

	assert.deepEqual(payload, { type: "reverse_synctex", page: 2, x: 100, y: 160 });
});

test("forward SyncTeX marker coordinates are converted from PDF points to viewport/CSS pixels", () => {
	const viewport = scaledViewport(1.25, 200);

	const marker = forwardSynctexMarkerFromPdfPoint({ pdfX: 100, pdfY: 160, viewport });

	assert.deepEqual(marker, { left: 125, top: 50 });
});

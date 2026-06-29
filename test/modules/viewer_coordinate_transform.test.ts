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

test("forward SyncTeX marker coordinates keep SyncTeX top-origin Y instead of inverting vertically", () => {
	const viewport = scaledViewport(1.25, 200);

	const topLine = forwardSynctexMarkerFromPdfPoint({ pdfX: 100, pdfY: 40, viewport });
	const bottomLine = forwardSynctexMarkerFromPdfPoint({ pdfX: 100, pdfY: 160, viewport });

	assert.equal(topLine.left, 125);
	assert.equal(bottomLine.left, 125);
	assert.equal(topLine.top, 50);
	assert.equal(bottomLine.top, 200);
	assert.equal(topLine.top < bottomLine.top, true);
});

test("forward SyncTeX marker expands point-only targets to a useful snippet-sized highlight", () => {
	const viewport = scaledViewport(1.25, 200);

	const marker = forwardSynctexMarkerFromPdfPoint({ pdfX: 100, pdfY: 40, viewport });

	assert.equal(marker.left, 125);
	assert.equal(marker.top, 50);
	assert.equal((marker as { width?: number }).width !== undefined && (marker as { width?: number }).width! >= 120, true);
	assert.equal((marker as { height?: number }).height !== undefined && (marker as { height?: number }).height! >= 12, true);
});

test("forward SyncTeX marker uses SyncTeX target dimensions when available", () => {
	const viewport = scaledViewport(1.25, 200);

	const marker = forwardSynctexMarkerFromPdfPoint({ pdfX: 80, pdfY: 40, width: 120, height: 10, viewport } as Parameters<typeof forwardSynctexMarkerFromPdfPoint>[0] & { width: number; height: number });

	assert.deepEqual(marker, { left: 100, top: 50, width: 150, height: 12.5 });
});

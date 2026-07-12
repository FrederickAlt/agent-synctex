import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectCachedSyncTeXForwardTreeCandidates, getCachedSyncTeXForwardLeafBoxes, getCachedSyncTeXPageForwardLeafBoxes, getCachedSyncTeXPageLeafBoxes } from "../../../src/modules/synctex/latex_workshop/worker.ts";

test("cached SyncTeX leaf boxes are page-scoped, source-filterable, copied, and invalidated with the sidecar", () => {
	const dir = mkdtempSync(join(tmpdir(), "synctex-leaf-boxes-"));
	const pdfPath = join(dir, "paper.pdf");
	const sourcePath = join(dir, "main.tex");
	const sidecarPath = join(dir, "paper.synctex");
	const sidecar = (firstLeafLeft: number) => [
		"SyncTeX Version:1",
		`Input:1:${sourcePath}`,
		"X Offset:6578176",
		"Y Offset:13156352",
		"{1",
		"(1,12:13156352,19734528:6578176,1315635,0",
		`x1,12:${firstLeafLeft},19734528`,
		"k1,12:23023616,19734528:6578176",
		"r1,12:23681434,19734528:6578176",
		")",
		"}1",
		"{2",
		"(1,12:13156352,26312704:6578176,1315635,0",
		"x1,12:26312704,26312704",
		")",
		"}2",
	].join("\n");
	try {
		writeFileSync(pdfPath, "%PDF-1.4\nfixture\n%%EOF\n");
		writeFileSync(sourcePath, "leaf boxes\n");
		writeFileSync(sidecarPath, sidecar(19734528));

		const coord = (value: number) => value / 65781.76;
		const H = coord(1315635);
		const pageOne = getCachedSyncTeXPageLeafBoxes(pdfPath, 1);
		assert.deepEqual(pageOne, [{ page: 1, sourceFile: sourcePath, line: 12, h: coord(19734528) + coord(6578176), v: coord(19734528) + coord(13156352), W: 0, H }]);
		pageOne[0]!.h = -1;
		assert.equal(getCachedSyncTeXPageLeafBoxes(pdfPath, 1)[0]!.h, 400, "callers cannot mutate cached boxes");
		assert.deepEqual(getCachedSyncTeXForwardLeafBoxes({ pdfPath, sourceFile: sourcePath, line: 12 }), [
			{ page: 1, sourceFile: sourcePath, line: 12, h: coord(19734528) + coord(6578176), v: coord(19734528) + coord(13156352), W: 0, H },
			{ page: 2, sourceFile: sourcePath, line: 12, h: coord(26312704) + coord(6578176), v: coord(26312704) + coord(13156352), W: 0, H },
		]);
		assert.deepEqual(getCachedSyncTeXForwardLeafBoxes({ pdfPath, sourceFile: sourcePath, line: 12, page: 2 }), [
			{ page: 2, sourceFile: sourcePath, line: 12, h: coord(26312704) + coord(6578176), v: coord(26312704) + coord(13156352), W: 0, H },
		]);
		assert.deepEqual(collectCachedSyncTeXForwardTreeCandidates({ pdfPath, sourceFile: sourcePath, line: 12, page: 1, maxCandidates: 10 }), {
			candidates: [
				{
					leaf: { page: 1, sourceFile: sourcePath, line: 12, h: coord(19734528) + coord(6578176), v: coord(19734528) + coord(13156352), W: 0, H },
					box: { type: "x", page: 1, sourceFile: sourcePath, line: 12, h: coord(19734528) + coord(6578176), v: coord(19734528) + coord(13156352), W: 0, H },
					ancestors: [{ type: "horizontal", page: 1, sourceFile: sourcePath, line: 12, h: coord(13156352) + coord(6578176), v: coord(19734528) + coord(13156352), W: coord(6578176), H }],
				},
				{
					leaf: { page: 1, sourceFile: sourcePath, line: 12, h: coord(19734528) + coord(6578176), v: coord(19734528) + coord(13156352), W: 0, H },
					box: { type: "horizontal", page: 1, sourceFile: sourcePath, line: 12, h: coord(13156352) + coord(6578176), v: coord(19734528) + coord(13156352), W: coord(6578176), H },
					ancestors: [],
				},
			],
			exceeded: false,
		});
		assert.deepEqual(getCachedSyncTeXPageForwardLeafBoxes({
			pdfPath,
			page: 1,
			locations: [{ sourceFile: sourcePath, line: 12 }, { sourceFile: sourcePath, line: 99 }],
		}), [
			{ sourceFile: sourcePath, line: 12, boxes: [{ page: 1, sourceFile: sourcePath, line: 12, h: coord(19734528) + coord(6578176), v: coord(19734528) + coord(13156352), W: 0, H }] },
			{ sourceFile: sourcePath, line: 99, boxes: [] },
		]);

		writeFileSync(sidecarPath, sidecar(26312704));
		utimesSync(sidecarPath, new Date(), new Date(Date.now() + 1_000));
		assert.equal(getCachedSyncTeXPageLeafBoxes(pdfPath, 1)[0]!.h, coord(26312704) + coord(6578176), "sidecar changes rebuild derived page boxes");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

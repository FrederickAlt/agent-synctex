import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { mapForwardSynctex, type ForwardSynctexJump } from "../../../src/modules/synctex/forward_synctex.ts";
import { forwardSynctexMarkerFromPdfPoint, type ForwardSynctexMarkerPosition } from "../../../src/modules/viewer_coordinate_transform.ts";

interface TextItemLike {
	str: string;
	transform: number[];
	width: number;
}

interface PdfJsLibLike {
	Util: {
		transform(left: number[], right: number[]): number[];
	};
	getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocumentLike> };
}

interface PdfDocumentLike {
	getPage(page: number): Promise<PdfPageLike>;
	destroy?: () => Promise<void> | void;
}

interface PdfPageLike {
	getViewport(options: { scale: number }): PdfViewportLike;
	getTextContent(): Promise<{ items: TextItemLike[] }>;
}

interface PdfViewportLike {
	width: number;
	height: number;
	scale: number;
	transform: number[];
	convertToPdfPoint(viewportX: number, viewportY: number): [number, number];
	convertToViewportPoint(pdfX: number, pdfY: number): [number, number];
}

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface OracleCase {
	label: string;
	kind: "normal" | "equation-label";
	line: number;
	jump: ForwardSynctexJump;
	marker: ForwardSynctexMarkerPosition;
	textBox: Box;
}

const FIXTURE_LINES = [
	"\\documentclass[12pt]{article}",
	"\\usepackage{amsmath}",
	"\\pagestyle{empty}",
	"\\setlength{\\parindent}{0pt}",
	"\\begin{document}",
	"ORACLETOPAAA normal text line for SyncTeX oracle.",
	"\\vspace*{1.45in}\\par",
	"ORACLEMIDBBB middle normal text line for SyncTeX oracle.",
	"\\[",
	"E = mc^2 \\quad \\mbox{ORACLEEQCCC}",
	"\\]",
	"\\vspace*{1.15in}\\par",
	"ORACLEBOTTOMDDD bottom-ish normal text line for SyncTeX oracle.",
	"\\[",
	"\\begin{aligned}",
	"\\mbox{ORACLEALIGNONE} \\quad a+b &= c+d \\\\",
	"\\mbox{ORACLEALIGNTWO} \\quad x+y &= z+w \\\\",
	"\\mbox{ORACLEALIGNTHREE} \\quad p+q &= r+s",
	"\\end{aligned}",
	"\\]",
	"ORACLEAFTEREEE after aligned block text line for SyncTeX oracle.",
	"\\end{document}",
];

const CASES: Array<{ label: string; kind: OracleCase["kind"] }> = [
	{ label: "ORACLETOPAAA", kind: "normal" },
	{ label: "ORACLEMIDBBB", kind: "normal" },
	{ label: "ORACLEBOTTOMDDD", kind: "normal" },
	{ label: "ORACLEEQCCC", kind: "equation-label" },
	{ label: "ORACLEALIGNONE", kind: "equation-label" },
	{ label: "ORACLEALIGNTWO", kind: "equation-label" },
	{ label: "ORACLEALIGNTHREE", kind: "equation-label" },
];

const SIMPLE_ALIGN_LINES = [
	"\\documentclass{article}",
	"\\usepackage{amsmath}",
	"\\usepackage[margin=1in]{geometry}",
	"\\begin{document}",
	"Some text before the equation.",
	"",
	"\\begin{align*}",
	"\\text{ROWONEAAA}\\quad A &= B + C + D + E \\\\",
	"\\text{ROWTWOAAA}\\quad F &= G + H + I + J \\\\",
	"\\text{ROWTHREEAAA}\\quad K &= L + M + N + O",
	"\\end{align*}",
	"",
	"Some text after the equation.",
	"\\end{document}",
];

const SIMPLE_ALIGN_CASES = [
	{ label: "ROWONEAAA", line: 8 },
	{ label: "ROWTWOAAA", line: 9 },
	{ label: "ROWTHREEAAA", line: 10 },
];

function commandExists(command: string): boolean {
	const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
	return !probe.error && probe.status === 0;
}

function oracleSkipReason(): string | undefined {
	for (const command of ["latexmk", "pdflatex"] as const) {
		if (!commandExists(command)) return `requires ${command} on PATH`;
	}
	return undefined;
}

function compileFixture(lines = FIXTURE_LINES): { dir: string; texPath: string; pdfPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "forward-synctex-oracle-"));
	const texPath = join(dir, "main.tex");
	const pdfPath = join(dir, "main.pdf");
	writeFileSync(texPath, `${lines.join("\n")}\n`);

	const compile = spawnSync(
		"latexmk",
		["-norc", "-pdf", "-view=none", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", basename(texPath)],
		{ cwd: dir, encoding: "utf8" },
	);
	assert.equal(compile.status, 0, `latexmk failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`);
	assert.equal(existsSync(pdfPath), true, "fixture PDF should be compiled");
	assert.equal(existsSync(join(dir, "main.synctex.gz")) || existsSync(join(dir, "main.synctex")), true, "fixture should include SyncTeX sidecar");
	return { dir, texPath, pdfPath };
}

function lineForLabel(label: string): number {
	const line = FIXTURE_LINES.findIndex((candidate) => candidate.includes(label)) + 1;
	assert.ok(line > 0, `fixture source line for ${label}`);
	return line;
}

function textItemBox(pdfjsLib: PdfJsLibLike, viewport: PdfViewportLike, item: TextItemLike): Box {
	const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
	const fontHeight = Math.hypot(tx[2] ?? 0, tx[3] ?? 0);
	const width = item.width * viewport.scale;
	return {
		left: tx[4] ?? 0,
		top: (tx[5] ?? 0) - fontHeight,
		right: (tx[4] ?? 0) + width,
		bottom: tx[5] ?? 0,
	};
}

function centerY(box: Box | ForwardSynctexMarkerPosition): number {
	return "bottom" in box ? (box.top + box.bottom) / 2 : box.top + (box.height / 2);
}

function intersectionArea(left: Box | ForwardSynctexMarkerPosition, right: Box): number {
	const leftRight = "right" in left ? left.right : left.left + left.width;
	const leftBottom = "bottom" in left ? left.bottom : left.top + left.height;
	const width = Math.max(0, Math.min(leftRight, right.right) - Math.max(left.left, right.left));
	const height = Math.max(0, Math.min(leftBottom, right.bottom) - Math.max(left.top, right.top));
	return width * height;
}

function formatCase(candidate: OracleCase): string {
	return `${candidate.label} line=${candidate.line} jump=${JSON.stringify({ page: candidate.jump.page, x: candidate.jump.x, y: candidate.jump.y, width: candidate.jump.width, height: candidate.jump.height })} marker=${JSON.stringify(candidate.marker)} text=${JSON.stringify(candidate.textBox)}`;
}

async function collectOracleCases(pdfjsLib: PdfJsLibLike, fixture: { dir: string; texPath: string; pdfPath: string }): Promise<{ viewport: PdfViewportLike; cases: OracleCase[] }> {
	const pdfBytes = new Uint8Array(readFileSync(fixture.pdfPath));
	const document = await pdfjsLib.getDocument({ data: pdfBytes, disableWorker: true }).promise;
	try {
		const page = await document.getPage(1);
		const viewport = page.getViewport({ scale: 1 });
		const textContent = await page.getTextContent();
		const textBoxes = new Map<string, Box>();
		for (const item of textContent.items) {
			for (const { label } of CASES) {
				if (item.str.includes(label)) textBoxes.set(label, textItemBox(pdfjsLib, viewport, item));
			}
		}

		const cases = CASES.map(({ label, kind }) => {
			const textBox = textBoxes.get(label);
			assert.ok(textBox, `PDF.js textContent should contain ${label}; extracted text was: ${textContent.items.map((item) => item.str).join(" | ")}`);
			const line = lineForLabel(label);
			const jump = mapForwardSynctex({ pdfPath: fixture.pdfPath, sourceFile: fixture.texPath, line, cwd: fixture.dir });
			assert.equal(jump.page, 1, `${label} should map to the fixture page`);
			const marker = forwardSynctexMarkerFromPdfPoint({ pdfX: jump.x, pdfY: jump.y, width: jump.width, height: jump.height, viewport });
			return { label, kind, line, jump, marker, textBox };
		});
		return { viewport, cases };
	} finally {
		await document.destroy?.();
	}
}

function artifactRoot(): string {
	return process.env.AGENT_SYNCTEX_ORACLE_ARTIFACT_DIR ?? join(tmpdir(), "agent-synctex-oracle-artifacts");
}

function shouldWriteArtifacts(): boolean {
	return process.env.AGENT_SYNCTEX_ORACLE_ARTIFACTS === "1";
}

function executableOnPath(command: string): boolean {
	const probe = spawnSync("which", [command], { stdio: "ignore" });
	return !probe.error && probe.status === 0;
}

function rasterToolsAvailable(): boolean {
	return executableOnPath("pdftoppm") && executableOnPath("magick");
}

function drawVisualArtifacts(fixture: { pdfPath: string; texPath: string }, viewport: PdfViewportLike, cases: OracleCase[], reason: string): string | undefined {
	if (!rasterToolsAvailable()) return undefined;
	const root = artifactRoot();
	mkdirSync(root, { recursive: true });
	const prefix = join(root, "forward-synctex-oracle");
	const pagePng = `${prefix}-page`;
	const render = spawnSync("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-png", "-r", "144", fixture.pdfPath, pagePng], { encoding: "utf8" });
	if (render.status !== 0) return undefined;
	const renderedPage = `${pagePng}.png`;
	const scale = 2;
	const drawArgs = cases.flatMap((candidate) => {
		const x0 = Math.round(candidate.marker.left * scale);
		const y0 = Math.round(candidate.marker.top * scale);
		const x1 = Math.round((candidate.marker.left + candidate.marker.width) * scale);
		const y1 = Math.round((candidate.marker.top + candidate.marker.height) * scale);
		return ["-fill", "rgba(255,255,0,0.35)", "-stroke", "#d11", "-strokewidth", "3", "-draw", `rectangle ${x0},${y0} ${x1},${y1}`];
	});
	const overlayPng = `${prefix}-overlay.png`;
	const overlay = spawnSync("magick", [renderedPage, ...drawArgs, overlayPng], { encoding: "utf8" });
	if (overlay.status !== 0) return undefined;

	const marginPoints = 36;
	for (const candidate of cases) {
		const x = Math.max(0, Math.round((candidate.marker.left - marginPoints) * scale));
		const y = Math.max(0, Math.round((candidate.marker.top - marginPoints) * scale));
		const right = Math.min(viewport.width * scale, Math.round((candidate.marker.left + candidate.marker.width + marginPoints) * scale));
		const bottom = Math.min(viewport.height * scale, Math.round((candidate.marker.top + candidate.marker.height + marginPoints) * scale));
		const cropPng = `${prefix}-${candidate.label}-crop.png`;
		spawnSync("magick", [overlayPng, "-crop", `${Math.max(1, right - x)}x${Math.max(1, bottom - y)}+${x}+${y}`, "+repage", cropPng], { encoding: "utf8" });
	}
	writeFileSync(`${prefix}-diagnostics.txt`, [`reason: ${reason}`, `source: ${fixture.texPath}`, ...cases.map(formatCase)].join("\n"));
	return prefix;
}

const skipReason = oracleSkipReason();

test("forward SyncTeX markers follow each source row in a simple align* fixture", skipReason ? { skip: skipReason } : {}, async () => {
	const fixture = compileFixture(SIMPLE_ALIGN_LINES);
	try {
		const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as PdfJsLibLike;
		const pdfBytes = new Uint8Array(readFileSync(fixture.pdfPath));
		const document = await pdfjsLib.getDocument({ data: pdfBytes, disableWorker: true }).promise;
		try {
			const page = await document.getPage(1);
			const viewport = page.getViewport({ scale: 1 });
			const textContent = await page.getTextContent();
			const rows = SIMPLE_ALIGN_CASES.map(({ label, line }) => {
				const item = textContent.items.find((candidate) => candidate.str.includes(label));
				assert.ok(item, `PDF.js textContent should contain ${label}; extracted text was: ${textContent.items.map((candidate) => candidate.str).join(" | ")}`);
				const textBox = textItemBox(pdfjsLib, viewport, item);
				const jump = mapForwardSynctex({ pdfPath: fixture.pdfPath, sourceFile: fixture.texPath, line, cwd: fixture.dir });
				const marker = forwardSynctexMarkerFromPdfPoint({ pdfX: jump.x, pdfY: jump.y, width: jump.width, height: jump.height, viewport });
				return { label, line, jump, marker, textBox };
			});

			for (const row of rows) {
				const verticalCenterDelta = Math.abs(centerY(row.marker) - centerY(row.textBox));
				assert.ok(verticalCenterDelta <= 6, `marker center should be on ${row.label}; delta=${verticalCenterDelta}\n${JSON.stringify(row)}`);
				assert.ok(row.marker.height <= 18, `marker should stay row-local for ${row.label}\n${JSON.stringify(row)}`);
			}

			const markerCenterDeltas = rows.slice(1).map((row, index) => centerY(row.marker) - centerY(rows[index].marker));
			const textCenterDeltas = rows.slice(1).map((row, index) => centerY(row.textBox) - centerY(rows[index].textBox));
			for (let index = 0; index < markerCenterDeltas.length; index += 1) {
				assert.ok(Math.abs(markerCenterDeltas[index] - textCenterDeltas[index]) <= 3, `marker row spacing should match text row spacing; marker=${markerCenterDeltas.join(",")} text=${textCenterDeltas.join(",")}`);
			}
		} finally {
			await document.destroy?.();
		}
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("forward SyncTeX markers overlap real PDF.js text boxes for a compiled LaTeX fixture", skipReason ? { skip: skipReason } : {}, async () => {
	const fixture = compileFixture();
	let collected: { viewport: PdfViewportLike; cases: OracleCase[] } | undefined;
	try {
		const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as PdfJsLibLike;
		collected = await collectOracleCases(pdfjsLib, fixture);

		try {
			for (const candidate of collected.cases) {
				const overlap = intersectionArea(candidate.marker, candidate.textBox);
				assert.ok(overlap > 0, `computed marker should overlap ${candidate.label} text box\n${formatCase(candidate)}`);

				const verticalCenterDelta = Math.abs(centerY(candidate.marker) - centerY(candidate.textBox));
				if (candidate.kind === "normal") {
					assert.ok(verticalCenterDelta <= 3, `normal text marker center should be within 3pt of ${candidate.label}; delta=${verticalCenterDelta}\n${formatCase(candidate)}`);
				} else {
					assert.ok(verticalCenterDelta <= 6, `equation marker center should be within 6pt of ${candidate.label}; delta=${verticalCenterDelta}\n${formatCase(candidate)}`);
					assert.ok(candidate.marker.height <= 18, `equation marker height should stay row-local for ${candidate.label}\n${formatCase(candidate)}`);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const prefix = drawVisualArtifacts(fixture, collected.viewport, collected.cases, message);
			if (!prefix) throw error;
			throw new Error(`${message}\nvisual SyncTeX oracle artifacts: ${prefix}-overlay.png and ${prefix}-*-crop.png`, { cause: error });
		}

		if (shouldWriteArtifacts()) drawVisualArtifacts(fixture, collected.viewport, collected.cases, "AGENT_SYNCTEX_ORACLE_ARTIFACTS=1");
	} finally {
		if (!shouldWriteArtifacts()) rmSync(fixture.dir, { recursive: true, force: true });
	}
});

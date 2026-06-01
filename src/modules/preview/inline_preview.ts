import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MCP_TMPDIR = process.env.MCP_TMPDIR ?? resolve(process.env.XDG_RUNTIME_DIR || process.env.HOME || process.cwd(), "show-latex");
export const INLINE_PREVIEW_DIR = resolve(MCP_TMPDIR, "inline");
const INLINE_PREVIEW_MISSING_RENDERER_MESSAGE = "Inline preview requires mutool or pdftoppm. Install mupdf-tools or poppler-utils, or call show_latex with inline=false.";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_INLINE_PREVIEW_DIMENSION_PX = 1;

interface PngDimensions {
	widthPx: number;
	heightPx: number;
}

export interface InlinePreviewArtifact {
	pngPath: string;
	page: number;
	dpi: number;
	renderer: "mutool" | "pdftoppm";
	trimmed: boolean;
	fullPageWidthPx: number;
	fullPageHeightPx: number;
	widthPx: number;
	heightPx: number;
}

interface CommandResult {
	exitCode: number | null;
	output: string;
}

function ensureInlinePreviewDir(): void {
	mkdirSync(INLINE_PREVIEW_DIR, { recursive: true, mode: 0o700 });
}

function parsePngDimensions(buffer: Buffer): PngDimensions | null {
	if (buffer.length < 24) return null;
	if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
	const chunkType = buffer.toString("ascii", 12, 16);
	if (chunkType !== "IHDR") return null;
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) {
		return null;
	}
	return { widthPx: width, heightPx: height };
}

async function readPngDimensions(pngPath: string, signal?: AbortSignal): Promise<PngDimensions | null> {
	try {
		const data = await readFile(pngPath, { signal });
		return parsePngDimensions(data);
	} catch {
		return null;
	}
}

function dimensionFallback(): PngDimensions {
	return { widthPx: DEFAULT_INLINE_PREVIEW_DIMENSION_PX, heightPx: DEFAULT_INLINE_PREVIEW_DIMENSION_PX };
}

function normalizeDimensions(dimensions: PngDimensions | null | undefined): PngDimensions {
	if (!dimensions || dimensions.widthPx <= 0 || dimensions.heightPx <= 0 || !Number.isFinite(dimensions.widthPx) || !Number.isFinite(dimensions.heightPx)) {
		return dimensionFallback();
	}
	return dimensions;
}

function parsePageCountFromOutput(output: string): number | undefined {
	const match = /^\s*Pages?\s*:\s*(\d+)\s*$/im.exec(output);
	if (!match) return undefined;
	const value = Number.parseInt(match[1], 10);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

async function commandExists(command: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const result = await runCommand("/bin/sh", ["-c", `command -v ${command}`], signal);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

function commandLine(command: string, args: string[]): string {
	return [command, ...args].join(" ");
}

async function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.once("error", rejectRun);
		child.once("close", (exitCode) => {
			resolveRun({ exitCode, output });
		});
	});
}

async function runRequiredCommand(command: string, args: string[], signal?: AbortSignal): Promise<void> {
	const result = await runCommand(command, args, signal);
	if (result.exitCode !== 0) {
		const output = result.output.trim();
		throw new Error(`${commandLine(command, args)} failed with exit code ${result.exitCode}${output ? `: ${output}` : ""}`);
	}
}

async function tryTrimPng(pngPath: string, signal?: AbortSignal): Promise<string | null> {
	if (!(await commandExists("magick", signal))) return null;

	const trimmedPath = pngPath.replace(/\.png$/i, ".trim.png");
	try {
		await runRequiredCommand("magick", [pngPath, "-background", "white", "-alpha", "remove", "-alpha", "off", "-fuzz", "10%", "-trim", "+repage", "-bordercolor", "white", "-border", "8x8", trimmedPath], signal);
		if (!existsSync(trimmedPath)) return null;
		return trimmedPath;
	} catch {
		return null;
	}
}

async function detectPdfPageCount(pdfPath: string, signal?: AbortSignal): Promise<number | undefined> {
	if (await commandExists("pdfinfo", signal)) {
		const result = await runCommand("pdfinfo", [pdfPath], signal);
		if (result.exitCode === 0) {
			const count = parsePageCountFromOutput(result.output);
			if (count !== undefined) return count;
		}
	}

	if (await commandExists("mutool", signal)) {
		const result = await runCommand("mutool", ["info", pdfPath], signal);
		if (result.exitCode === 0) {
			const count = parsePageCountFromOutput(result.output);
			if (count !== undefined) return count;
		}
	}

	return undefined;
}

export function calculateInlineDisplayColumns(availableColumns: number, artifact: Pick<InlinePreviewArtifact, "fullPageWidthPx" | "widthPx">): number {
	const safeAvailable = Number.isFinite(availableColumns) ? Math.max(1, Math.floor(availableColumns)) : 1;
	if (artifact.fullPageWidthPx <= 0 || !Number.isFinite(artifact.fullPageWidthPx)) return safeAvailable;
	if (artifact.widthPx <= 0 || !Number.isFinite(artifact.widthPx)) return safeAvailable;
	return Math.max(1, Math.min(safeAvailable, Math.ceil((safeAvailable * artifact.widthPx) / artifact.fullPageWidthPx)));
}

export async function rasterizePdfPage(
	pdfPath: string,
	options: { page?: number; dpi?: number; signal?: AbortSignal } = {},
): Promise<InlinePreviewArtifact> {
	const page = options.page ?? 1;
	const dpi = options.dpi ?? 150;
	ensureInlinePreviewDir();

	const baseName = `${Date.now()}-${process.pid}-${randomUUID()}-p${page}`;
	const pngPath = resolve(INLINE_PREVIEW_DIR, `${baseName}.png`);

	let renderer: InlinePreviewArtifact["renderer"];
	if (await commandExists("mutool", options.signal)) {
		renderer = "mutool";
		await runRequiredCommand("mutool", ["draw", "-q", "-r", String(dpi), "-o", pngPath, pdfPath, String(page)], options.signal);
	} else if (await commandExists("pdftoppm", options.signal)) {
		renderer = "pdftoppm";
		const outputPrefix = resolve(INLINE_PREVIEW_DIR, baseName);
		await runRequiredCommand("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-r", String(dpi), "-png", pdfPath, outputPrefix], options.signal);
		await rename(`${outputPrefix}.png`, pngPath);
	} else {
		throw new Error(INLINE_PREVIEW_MISSING_RENDERER_MESSAGE);
	}

	const rawFullPageDimensions = await readPngDimensions(pngPath, options.signal);
	const fullPageDimensions = normalizeDimensions(rawFullPageDimensions);
	const trimmedPath = await tryTrimPng(pngPath, options.signal);
	const finalPngPath = trimmedPath ?? pngPath;
	const finalDimensions = normalizeDimensions(await readPngDimensions(finalPngPath, options.signal));

	return {
		pngPath: finalPngPath,
		page,
		dpi,
		renderer,
		trimmed: Boolean(trimmedPath),
		fullPageWidthPx: rawFullPageDimensions ? fullPageDimensions.widthPx : finalDimensions.widthPx,
		fullPageHeightPx: rawFullPageDimensions ? fullPageDimensions.heightPx : finalDimensions.heightPx,
		widthPx: finalDimensions.widthPx,
		heightPx: finalDimensions.heightPx,
	};
}

export async function rasterizePdfPages(
	pdfPath: string,
	options: { dpi?: number; signal?: AbortSignal } = {},
): Promise<InlinePreviewArtifact[]> {
	const pageCount = (await detectPdfPageCount(pdfPath, options.signal)) ?? 1;
	const artifacts: InlinePreviewArtifact[] = [];
	for (let page = 1; page <= pageCount; page++) {
		artifacts.push(await rasterizePdfPage(pdfPath, { page, dpi: options.dpi ?? 150, signal: options.signal }));
	}
	return artifacts;
}

export async function mergeInlinePreviewArtifacts(
	artifacts: InlinePreviewArtifact[],
	options: { signal?: AbortSignal } = {},
): Promise<InlinePreviewArtifact[]> {
	if (artifacts.length <= 1) return artifacts;
	if (!(await commandExists("magick", options.signal))) return artifacts;

	ensureInlinePreviewDir();
	const mergedPath = resolve(INLINE_PREVIEW_DIR, `${Date.now()}-${process.pid}-${randomUUID()}-merged.png`);
	try {
		await runRequiredCommand("magick", [
			...artifacts.map((artifact) => artifact.pngPath),
			"-background",
			"white",
			"-alpha",
			"remove",
			"-alpha",
			"off",
			"-append",
			mergedPath,
		], options.signal);
		if (!existsSync(mergedPath)) return artifacts;
	} catch {
		return artifacts;
	}

	const mergedDimensions = normalizeDimensions(await readPngDimensions(mergedPath, options.signal));
	return [{
		pngPath: mergedPath,
		page: artifacts[0]?.page ?? 1,
		dpi: artifacts[0]?.dpi ?? 150,
		renderer: artifacts[0]?.renderer ?? "mutool",
		trimmed: artifacts.some((artifact) => artifact.trimmed),
		fullPageWidthPx: Math.max(...artifacts.map((artifact) => artifact.fullPageWidthPx)),
		fullPageHeightPx: artifacts.reduce((sum, artifact) => sum + artifact.fullPageHeightPx, 0),
		widthPx: mergedDimensions.widthPx,
		heightPx: mergedDimensions.heightPx,
	}];
}

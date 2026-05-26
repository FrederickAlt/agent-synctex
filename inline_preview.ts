import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MCP_TMPDIR = "/tmp/codex-show-latex";
const INLINE_PREVIEW_DIR = resolve(MCP_TMPDIR, "inline");
const INLINE_PREVIEW_MISSING_RENDERER_MESSAGE = "Inline preview requires mutool or pdftoppm. Install mupdf-tools or poppler-utils, or call show_latex with inline=false.";

export interface InlinePreviewArtifact {
	pngPath: string;
	page: number;
	dpi: number;
	renderer: "mutool" | "pdftoppm";
	trimmed: boolean;
}

interface CommandResult {
	exitCode: number | null;
	output: string;
}

function ensureInlinePreviewDir(): void {
	mkdirSync(INLINE_PREVIEW_DIR, { recursive: true, mode: 0o700 });
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

	const trimmedPath = await tryTrimPng(pngPath, options.signal);
	return {
		pngPath: trimmedPath ?? pngPath,
		page,
		dpi,
		renderer,
		trimmed: Boolean(trimmedPath),
	};
}

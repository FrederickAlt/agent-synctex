import { tmpdir } from "node:os";
import { resolve } from "node:path";

const resolveMcpRuntimeDir = (): string =>
	process.env.MCP_TMPDIR
		?? resolve(tmpdir(), "tex-actions");

export function getMcpTmpDir(): string {
	return resolveMcpRuntimeDir();
}

export const MCP_TMPDIR = resolveMcpRuntimeDir();

export function getMcpFixedPreviewPdfPath(): string {
	return resolve(getMcpTmpDir(), "tex-actions.pdf");
}

export const MCP_FIXED_PREVIEW_PDF_PATH = getMcpFixedPreviewPdfPath();

export const LATEX_PREAMBLE_FILE_NAMES = ["preamble.tex", "praeamble.tex"] as const;

export function getLatexPreamblePath(): string {
	return resolve(getMcpTmpDir(), "preamble.tex");
}

export const LATEX_PREAMBLE_PATH = getLatexPreamblePath();

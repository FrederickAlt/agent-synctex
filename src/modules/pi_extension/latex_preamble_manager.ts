import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MCP_FIXED_PREVIEW_PDF_PATH, LATEX_PREAMBLE_FILE_NAMES, LATEX_PREAMBLE_PATH, MCP_TMPDIR } from "./runtime_paths.ts";

function ensurePreviewTmpdirAccessible(): void {
	try {
		mkdirSync(MCP_TMPDIR, { recursive: true, mode: 0o700 });
		accessSync(MCP_TMPDIR, constants.F_OK | constants.R_OK | constants.W_OK | constants.X_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot access preview temp directory at ${MCP_TMPDIR}: ${message}`);
	}
}

function findPreambleFile(directory: string): string | null {
	for (const fileName of LATEX_PREAMBLE_FILE_NAMES) {
		const candidate = resolve(directory, fileName);
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

function resolvePreambleFile(directory: string): string | null {
	return findPreambleFile(directory);
}

export function initializeLatexPreambleFile(): void {
	const cwdPreambleFile = resolvePreambleFile(process.cwd());
	if (!cwdPreambleFile) {
		ensurePreviewTmpdirAccessible();
		return;
	}

	try {
		ensurePreviewTmpdirAccessible();
		const preamble = readFileSync(cwdPreambleFile, "utf8");
		writeLatexPreambleToTmpdir(preamble);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to copy cwd preamble ${cwdPreambleFile} to ${LATEX_PREAMBLE_PATH}: ${message}`);
	}
}

export function writeLatexPreambleToTmpdir(latexPreamble: string): number {
	ensurePreviewTmpdirAccessible();
	const preamble = latexPreamble.trim();
	writeFileSync(LATEX_PREAMBLE_PATH, preamble ? `${preamble}\n` : "", { mode: 0o600 });
	return preamble.length;
}

export { MCP_FIXED_PREVIEW_PDF_PATH, LATEX_PREAMBLE_PATH, MCP_TMPDIR };

export function getPreambleFileFromDirectory(directory: string): string | null {
	return resolvePreambleFile(directory);
}

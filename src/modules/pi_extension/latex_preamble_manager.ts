import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	LATEX_PREAMBLE_FILE_NAMES,
	LATEX_PREAMBLE_PATH,
	MCP_FIXED_PREVIEW_PDF_PATH,
	MCP_TMPDIR,
} from "./runtime_paths.ts";
import {
	ensureMcpRuntimeDirectory,
	getLatexPreambleFilePath,
	writeLatexPreambleToTmpdir as writeLatexPreambleToTmpdirShared,
} from "../runtime_preamble.ts";
import { resolveAgentWorkspaceContext } from "../agent_runtime_context.ts";

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

export function initializeLatexPreambleFile(options: { cwd?: string; runtimeDirectory?: string; overwrite?: boolean } = {}): void {
	const cwd = options.cwd ?? process.cwd();
	const runtimeDirectory = options.runtimeDirectory ?? resolveAgentWorkspaceContext().workspace_root;
	ensureMcpRuntimeDirectory(runtimeDirectory);
	const preamblePath = getLatexPreambleFilePath(runtimeDirectory);
	if (options.overwrite === false && existsSync(preamblePath)) {
		return;
	}
	const cwdPreambleFile = resolvePreambleFile(cwd);
	if (!cwdPreambleFile) {
		return;
	}

	try {
		const preamble = readFileSync(cwdPreambleFile, "utf8");
		writeLatexPreambleToTmpdirShared(preamble, { runtimeDirectory });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to copy cwd preamble ${cwdPreambleFile} to ${preamblePath}: ${message}`);
	}
}

export function writeLatexPreambleToTmpdir(latexPreamble: string): number {
	return writeLatexPreambleToTmpdirShared(latexPreamble);
}

export { LATEX_PREAMBLE_PATH, MCP_FIXED_PREVIEW_PDF_PATH, MCP_TMPDIR };

export function getPreambleFileFromDirectory(directory: string): string | null {
	return resolvePreambleFile(directory);
}

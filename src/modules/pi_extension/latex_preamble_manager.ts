import { existsSync } from "node:fs";
import { buildLatexPreambleIndex } from "../latex/latex_preamble_index.ts";
import {
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

export type LatexPreambleInitializationResult =
	| { status: "loaded"; source: string; preamblePath: string }
	| { status: "not_found"; preamblePath: string }
	| { status: "multiple_roots"; preamblePath: string; roots: string[] }
	| { status: "timed_out"; preamblePath: string };

function resolveSingleRootPreamble(directory: string): { preamble: string; source: string } | "not_found" | "timed_out" | { status: "multiple_roots"; roots: string[] } {
	const timeoutMs = Number(process.env.LATEX_PREAMBLE_TIMEOUT_MS ?? "5000");
	const index = buildLatexPreambleIndex(directory, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000);
	if (index.timedOut) {
		return "timed_out";
	}
	if (index.roots.length === 0) {
		return "not_found";
	}
	if (index.roots.length > 1) {
		return { status: "multiple_roots", roots: index.roots.map((root) => root.rootFile) };
	}
	return { preamble: index.roots[0].preamble, source: index.roots[0].rootFile };
}

export function initializeLatexPreambleFile(options: { cwd?: string; runtimeDirectory?: string; overwrite?: boolean } = {}): LatexPreambleInitializationResult {
	const cwd = options.cwd ?? process.cwd();
	const runtimeDirectory = options.runtimeDirectory ?? resolveAgentWorkspaceContext().workspace_root;
	ensureMcpRuntimeDirectory(runtimeDirectory);
	const preamblePath = getLatexPreambleFilePath(runtimeDirectory);
	if (options.overwrite === false && existsSync(preamblePath)) {
		return { status: "loaded", source: preamblePath, preamblePath };
	}
	try {
		const resolvedRootPreamble = resolveSingleRootPreamble(cwd);
		if (typeof resolvedRootPreamble === "string") {
			return { status: resolvedRootPreamble, preamblePath };
		}
		if ("status" in resolvedRootPreamble) {
			return { status: "multiple_roots", roots: resolvedRootPreamble.roots, preamblePath };
		}
		writeLatexPreambleToTmpdirShared(resolvedRootPreamble.preamble, { runtimeDirectory });
		return { status: "loaded", source: resolvedRootPreamble.source, preamblePath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to copy single LaTeX root preamble under ${cwd} to ${preamblePath}: ${message}`);
	}
}

export function writeLatexPreambleToTmpdir(latexPreamble: string): number {
	return writeLatexPreambleToTmpdirShared(latexPreamble);
}

export { LATEX_PREAMBLE_PATH, MCP_FIXED_PREVIEW_PDF_PATH, MCP_TMPDIR };

export function getPreambleFileFromDirectory(_directory: string): string | null {
	return null;
}

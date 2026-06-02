import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLatexPreamblePath, getMcpTmpDir } from "./runtime_paths.ts";

const PREAMBLE_FILE_NAME = "preamble.tex";

export interface LatexPreambleWriterOptions {
	runtimeDirectory?: string;
}

export function ensureMcpRuntimeDirectory(runtimeDirectory: string = getMcpTmpDir()): void {
	mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
	accessSync(runtimeDirectory, constants.F_OK | constants.R_OK | constants.W_OK | constants.X_OK);
}

export function resolveLatexPreamblePath(runtimeDirectory: string = getMcpTmpDir()): string {
	return resolve(runtimeDirectory, PREAMBLE_FILE_NAME);
}

export function getLatexPreambleFilePath(runtimeDirectory?: string): string {
	return runtimeDirectory === undefined
		? getLatexPreamblePath()
		: resolve(runtimeDirectory, PREAMBLE_FILE_NAME);
}

export function writeLatexPreambleToTmpdir(
	latexPreamble: string,
	options: LatexPreambleWriterOptions = {},
): number {
	const runtimeDirectory = options.runtimeDirectory ?? getMcpTmpDir();
	ensureMcpRuntimeDirectory(runtimeDirectory);
	const normalized = String(latexPreamble).trim();
	const preamblePath = getLatexPreambleFilePath(runtimeDirectory);
	writeFileSync(preamblePath, normalized ? `${normalized}\n` : "", { mode: 0o600 });
	return normalized.length;
}

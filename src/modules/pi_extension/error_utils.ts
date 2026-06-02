import { mkdirSync, writeFileSync } from "node:fs";
import { getMcpTmpDir } from "./runtime_paths.ts";
import { LoggedToolError } from "../latex/latex_file_compiler.ts";

function latexErrorLogPath(prefix: string): string {
	const safePrefix = prefix.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "latex";
	mkdirSync(getMcpTmpDir(), { recursive: true, mode: 0o700 });
	return `${getMcpTmpDir()}/${safePrefix}.${Date.now()}.${process.pid}.log`;
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function errorDetails(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message;
	return String(error);
}

export function tailText(text: string, limit = 12000): string {
	return text.length <= limit ? text : `...\n${text.slice(-limit)}`;
}

export function lastLines(text: string, count = 5): string {
	return text
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.slice(-count)
		.join("\n");
}

function writeLatexToolErrorLog(
	toolName: string,
	title: string,
	context: Record<string, unknown>,
	error: unknown,
): string {
	const tempLogPath = latexErrorLogPath(toolName);
	const contextLines = Object.entries(context)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${key}: ${String(value)}`);

	const sections = [
		title,
		...contextLines,
		"\n--- error ---",
		errorDetails(error),
	];

	writeFileSync(tempLogPath, `${sections.join("\n")}\n`, { mode: 0o600 });
	return tempLogPath;
}

const LATEX_ERROR_TAIL_LINES = 20;

function shortFailureMessage(shortMessage: string, logPath: string, tail: string): string {
	const tailLines = lastLines(tail, LATEX_ERROR_TAIL_LINES);
	return tailLines
		? `${shortMessage}. Log: ${logPath}\nLast ${LATEX_ERROR_TAIL_LINES} lines:\n${tailLines}`
		: `${shortMessage}. Log: ${logPath}`;
}

export function latexToolFailure(toolName: string, shortMessage: string, context: Record<string, unknown>, error: unknown): Error {
	if (error instanceof LoggedToolError) return error;

	try {
		const tempLogPath = writeLatexToolErrorLog(toolName, shortMessage, context, error);
		const tail = tailText(errorMessage(error));
		return new LoggedToolError(shortFailureMessage(shortMessage, tempLogPath, tail), tempLogPath, tail);
	} catch (logError) {
		const message = logError instanceof Error ? logError.message : String(logError);
		return new Error(`${shortMessage}. Could not write temp log: ${message}`);
	}
}

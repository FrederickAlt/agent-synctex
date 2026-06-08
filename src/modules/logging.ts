import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPdfPreviewRuntimeConfig, type PdfPreviewLogLevel } from "./runtime_config.ts";

export type LogFields = Record<string, unknown>;

export interface PdfPreviewLogger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<PdfPreviewLogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	off: 50,
};

const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const REDACTED = "[redacted]";

const REDACTED_KEY_PATTERN = /(?:^|_)(?:token|secret|password|latex_source|source_line|preamble|callback|target|stdout|stderr|output|tail)(?:$|_)/i;

function safeProcessName(): string {
	const raw = basename(process.argv[1] || process.argv[0] || "process");
	return raw.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "process";
}

function logFilePath(logDir: string): string {
	return join(logDir, `${safeProcessName()}.${process.pid}.jsonl`);
}

function shouldLog(configuredLevel: PdfPreviewLogLevel, eventLevel: PdfPreviewLogLevel): boolean {
	if (configuredLevel === "off") return false;
	return LEVEL_ORDER[eventLevel] >= LEVEL_ORDER[configuredLevel];
}

function truncateString(value: string): string {
	return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}... [truncated]`;
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
	if (key && REDACTED_KEY_PATTERN.test(key)) return REDACTED;
	if (value instanceof Error) {
		return {
			name: value.name,
			message: truncateString(value.message),
			...(value.stack ? { stack: truncateString(value.stack) } : {}),
		};
	}
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return truncateString(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "symbol" || typeof value === "function") return String(value);
	if (depth >= MAX_DEPTH) return "[max-depth]";
	if (Array.isArray(value)) {
		const entries = value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeValue(entry, key, depth + 1));
		if (value.length > MAX_ARRAY_LENGTH) entries.push(`[${value.length - MAX_ARRAY_LENGTH} more entries truncated]`);
		return entries;
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
		for (const [entryKey, entryValue] of entries) {
			result[entryKey] = sanitizeValue(entryValue, entryKey, depth + 1);
		}
		const keyCount = Object.keys(value as Record<string, unknown>).length;
		if (keyCount > MAX_OBJECT_KEYS) result.truncated_keys = keyCount - MAX_OBJECT_KEYS;
		return result;
	}
	return String(value);
}

function rotateIfNeeded(path: string): void {
	try {
		const status = statSync(path);
		if (status.size < MAX_LOG_FILE_BYTES) return;
		renameSync(path, `${path}.${Date.now()}.old`);
	} catch {
		// Missing files and rotation failures should never affect extension behavior.
	}
}

function writeLog(level: Exclude<PdfPreviewLogLevel, "off">, component: string, event: string, fields: LogFields = {}): void {
	try {
		const config = loadPdfPreviewRuntimeConfig();
		if (!shouldLog(config.logging.level, level)) return;
		mkdirSync(config.logging.dir, { recursive: true, mode: 0o700 });
		const path = logFilePath(config.logging.dir);
		rotateIfNeeded(path);
		const record = {
			ts: new Date().toISOString(),
			level,
			component,
			event,
			pid: process.pid,
			config_path: config.configPath,
			...sanitizeValue(fields) as Record<string, unknown>,
		};
		appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Logging is diagnostic-only and must not break tools, MCP framing, or the daemon.
	}
}

export function createLogger(component: string): PdfPreviewLogger {
	return {
		debug(event, fields) {
			writeLog("debug", component, event, fields);
		},
		info(event, fields) {
			writeLog("info", component, event, fields);
		},
		warn(event, fields) {
			writeLog("warn", component, event, fields);
		},
		error(event, fields) {
			writeLog("error", component, event, fields);
		},
	};
}

export function pdfPreviewLogFilePathForCurrentProcess(): string {
	return logFilePath(loadPdfPreviewRuntimeConfig().logging.dir);
}

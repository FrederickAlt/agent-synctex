import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const PDF_PREVIEW_CONFIG_FILE_NAME = "config.json";
export const PDF_PREVIEW_CONFIG_DIR_NAME = "pi-pdf-preview";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "off"] as const;
export type PdfPreviewLogLevel = (typeof LOG_LEVELS)[number];

export interface PdfPreviewLoggingConfig {
	level: PdfPreviewLogLevel;
	dir: string;
}

export interface PdfPreviewRuntimeConfig {
	configPath: string;
	logging: PdfPreviewLoggingConfig;
}

type Env = NodeJS.ProcessEnv;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromUnknown(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function normalizePath(path: string): string {
	return resolve(expandHomePath(path));
}

function configHome(env: Env = process.env): string {
	return normalizePath(env.XDG_CONFIG_HOME || resolve(homedir(), ".config"));
}

function stateHome(env: Env = process.env): string {
	return normalizePath(env.XDG_STATE_HOME || resolve(homedir(), ".local", "state"));
}

export function defaultPdfPreviewConfigPath(env: Env = process.env): string {
	return resolve(configHome(env), PDF_PREVIEW_CONFIG_DIR_NAME, PDF_PREVIEW_CONFIG_FILE_NAME);
}

export function resolvePdfPreviewConfigPath(env: Env = process.env): string {
	const explicitConfig = stringFromUnknown(env.PDF_PREVIEW_CONFIG);
	return explicitConfig ? normalizePath(explicitConfig) : defaultPdfPreviewConfigPath(env);
}

export function defaultPdfPreviewLogDir(env: Env = process.env): string {
	return resolve(stateHome(env), PDF_PREVIEW_CONFIG_DIR_NAME, "logs");
}

function normalizeLogLevel(value: unknown): PdfPreviewLogLevel | undefined {
	const normalized = stringFromUnknown(value)?.toLowerCase();
	if (!normalized) return undefined;
	return (LOG_LEVELS as readonly string[]).includes(normalized)
		? normalized as PdfPreviewLogLevel
		: undefined;
}

function readConfigFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function loggingRecordFromConfig(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!config) return undefined;
	const nested = config.logging;
	if (isRecord(nested)) return nested;
	return config;
}

export function loadPdfPreviewRuntimeConfig(env: Env = process.env): PdfPreviewRuntimeConfig {
	const configPath = resolvePdfPreviewConfigPath(env);
	const config = readConfigFile(configPath);
	const logging = loggingRecordFromConfig(config);

	const configLevel = normalizeLogLevel(logging?.level ?? logging?.logLevel);
	const configDir = stringFromUnknown(logging?.dir ?? logging?.logDir);
	const envLevel = normalizeLogLevel(env.PDF_PREVIEW_LOG_LEVEL);
	const envDir = stringFromUnknown(env.PDF_PREVIEW_LOG_DIR);

	return {
		configPath,
		logging: {
			level: envLevel ?? configLevel ?? "off",
			dir: normalizePath(envDir ?? configDir ?? defaultPdfPreviewLogDir(env)),
		},
	};
}

export function pdfPreviewConfigDirectory(env: Env = process.env): string {
	return dirname(resolvePdfPreviewConfigPath(env));
}

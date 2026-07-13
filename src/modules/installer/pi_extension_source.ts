export function piExtensionSource(): string {
	return `import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

// Managed by agent-synctex.
const AGENT_SYNCTEX_TOOL_NAMES = new Set([
	"show_latex",
	"compile_latex_file",
	"open_pdf",
	"jump_pdf",
	"fetch_pdf_context",
]);

const LOG_LEVEL_ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 50 };
const LOG_LEVELS = new Set(["debug", "info", "warn", "error", "off"]);

function textFromPromptEvent(event: any): string {
	if (typeof event?.prompt === "string") return event.prompt;
	if (typeof event?.message === "string") return event.message;
	if (typeof event?.message?.content === "string") return event.message.content;
	return "";
}

function cwdFromEvent(event: any): string | undefined {
	if (typeof event?.cwd === "string" && event.cwd) return event.cwd;
	if (typeof event?.systemPromptOptions?.cwd === "string" && event.systemPromptOptions.cwd) return event.systemPromptOptions.cwd;
	return undefined;
}

function sessionIdFromContext(ctx: any): string | undefined {
	const getSessionId = ctx?.sessionManager?.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const sessionId = getSessionId.call(ctx.sessionManager);
		return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
	} catch {
		return undefined;
	}
}

function isAgentSynctexToolName(toolName: unknown): boolean {
	if (typeof toolName !== "string") return false;
	if (AGENT_SYNCTEX_TOOL_NAMES.has(toolName)) return true;
	return /^mcp__agent[-_]synctex__/.test(toolName);
}

function normalizeLogLevel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return LOG_LEVELS.has(normalized) ? normalized : undefined;
}

function hookLogConfig(cwd: string | undefined): { level: string; dir: string; configPath: string } {
	const workspace = cwd || process.cwd();
	const configPath = process.env.PDF_PREVIEW_CONFIG || join(workspace, ".agent-synctex", "config.json");
	let fileConfig: any;
	try {
		fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
	} catch { }
	const logging = fileConfig?.logging && typeof fileConfig.logging === "object" ? fileConfig.logging : fileConfig;
	const level = normalizeLogLevel(process.env.PDF_PREVIEW_LOG_LEVEL) ?? normalizeLogLevel(logging?.level ?? logging?.logLevel) ?? "off";
	const rawDir = typeof process.env.PDF_PREVIEW_LOG_DIR === "string" && process.env.PDF_PREVIEW_LOG_DIR.trim()
		? process.env.PDF_PREVIEW_LOG_DIR.trim()
		: typeof logging?.dir === "string" && logging.dir.trim()
			? logging.dir.trim()
			: typeof logging?.logDir === "string" && logging.logDir.trim()
				? logging.logDir.trim()
				: join(workspace, ".agent-synctex", "logs");
	return { level, dir: resolve(workspace, rawDir), configPath };
}

function safeLogValue(value: unknown, key = ""): unknown {
	if (/token|secret|password|prompt|message|content|source_line/i.test(key)) return "[redacted]";
	if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safeLogValue(entry));
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 50)) result[entryKey] = safeLogValue(entryValue, entryKey);
		return result;
	}
	return String(value);
}

function hookLog(level: "debug" | "info" | "warn" | "error", event: string, details: Record<string, unknown> = {}, cwd?: string): void {
	try {
		const config = hookLogConfig(cwd);
		if (config.level === "off" || LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[config.level]) return;
		mkdirSync(config.dir, { recursive: true, mode: 0o700 });
		const record = { ts: new Date().toISOString(), level, component: "pi-extension", event, pid: process.pid, config_path: config.configPath, ...safeLogValue(details) as Record<string, unknown> };
		appendFileSync(join(config.dir, "pi-extension." + process.pid + ".jsonl"), JSON.stringify(record) + "\\n", { encoding: "utf8", mode: 0o600 });
	} catch { }
}

function traceHook(event: string, details: Record<string, unknown>): void {
	const target = process.env.AGENT_SYNCTEX_HOOK_TRACE;
	if (!target) return;
	try {
		appendFileSync(target, JSON.stringify({ event, at: new Date().toISOString(), ...details }) + "\\n", { encoding: "utf8", mode: 0o600 });
	} catch { }
}

function stableHash(value: string | undefined): string | undefined {
	return value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : undefined;
}

function fetchPdfContext(prompt: string, cwd: string | undefined, sessionId: string | undefined): { text: string; error?: string } {
	const args = ["fetch-info", "--harness", "pi"];
	if (cwd) args.push("--cwd", cwd);
	if (sessionId) args.push("--agent-id", sessionId);
	const options = {
		input: prompt,
		encoding: "utf8" as const,
		...(cwd ? { cwd } : {}),
	};
	traceHook("fetch-start", { cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId) });
	hookLog("info", "fetch.start", { cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId), prompt_bytes: Buffer.byteLength(prompt), args }, cwd);
	const startedAt = Date.now();
	const direct = spawnSync("agent-synctex", args, options);
	if (direct.status === 0) {
		const text = (direct.stdout ?? "").trim();
		traceHook("fetch-result", { launcher: "direct", status: "ok", context_bytes: Buffer.byteLength(text) });
		hookLog("info", "fetch.result", { launcher: "direct", status: "ok", elapsed_ms: Date.now() - startedAt, context_bytes: Buffer.byteLength(text) }, cwd);
		return { text };
	}
	if ((direct.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
		traceHook("fetch-result", { launcher: "direct", status: "error" });
		hookLog("warn", "fetch.result", { launcher: "direct", status: "error", elapsed_ms: Date.now() - startedAt, exit_status: direct.status, error_code: (direct.error as NodeJS.ErrnoException | undefined)?.code }, cwd);
		return { text: "", error: resultError(direct) };
	}
	const shell = process.env.SHELL?.trim() || "/bin/sh";
	const viaShell = spawnSync(shell, ["-lc", "exec agent-synctex \\\"$@\\\"", "agent-synctex", ...args], options);
	const text = viaShell.status === 0 ? (viaShell.stdout ?? "").trim() : "";
	traceHook("fetch-result", { launcher: "shell", status: viaShell.status === 0 ? "ok" : "error", context_bytes: Buffer.byteLength(text) });
	hookLog(viaShell.status === 0 ? "info" : "warn", "fetch.result", { launcher: "shell", status: viaShell.status === 0 ? "ok" : "error", elapsed_ms: Date.now() - startedAt, exit_status: viaShell.status, context_bytes: Buffer.byteLength(text) }, cwd);
	return viaShell.status === 0 ? { text } : { text: "", error: resultError(viaShell) };
}

function resultError(result: ReturnType<typeof spawnSync>): string {
	if (result.error) return result.error.message;
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
	return stderr || "agent-synctex fetch-info exited with status " + (result.status ?? "unknown");
}

function isVisibleViewerSocketConnectingError(error: string): boolean {
	return /Timed out waiting \\d+ms for visible PDF viewer socket connection/.test(error);
}

export default function(pi: any): void {
	hookLog("info", "extension.register", { process_cwd: process.cwd() }, process.cwd());
	pi.on("tool_call", async (event: any, ctx: any) => {
		const cwd = cwdFromEvent(event) ?? ctx?.cwd ?? process.cwd();
		if (!isAgentSynctexToolName(event?.toolName)) return;
		if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) {
			hookLog("debug", "tool_call.skip", { reason: "invalid_input", tool_name: event?.toolName, cwd_hash: stableHash(cwd) }, cwd);
			return;
		}
		const sessionId = sessionIdFromContext(ctx);
		if (!sessionId) {
			hookLog("warn", "tool_call.skip", { reason: "missing_session", tool_name: event?.toolName, cwd_hash: stableHash(cwd) }, cwd);
			return;
		}
		hookLog("debug", "tool_call.annotate", { tool_name: event?.toolName, cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId) }, cwd);
		event.input._agent_synctex = {
			harness: "pi",
			session_id: sessionId,
			cwd: ctx?.cwd,
			tool_call_id: event?.toolCallId,
		};
		event.input._pi = {
			session_id: sessionId,
			tool_call_id: event?.toolCallId,
		};
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const cwd = cwdFromEvent(event) ?? ctx?.cwd ?? process.cwd();
		const sessionId = sessionIdFromContext(ctx);
		const prompt = textFromPromptEvent(event);
		hookLog("info", "before_agent_start.enter", { cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId), prompt_bytes: Buffer.byteLength(prompt), event_keys: event && typeof event === "object" ? Object.keys(event).slice(0, 20) : [] }, cwd);
		if (!sessionId) hookLog("warn", "before_agent_start.missing_session", { cwd_hash: stableHash(cwd) }, cwd);
		const context = fetchPdfContext(prompt, cwd, sessionId);
		if (!context.text) {
			if (!context.error) {
				hookLog("info", "before_agent_start.empty", { cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId) }, cwd);
				return;
			}
			if (isVisibleViewerSocketConnectingError(context.error)) {
				hookLog("info", "before_agent_start.socket_connecting_suppressed", { cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId), error_bytes: Buffer.byteLength(context.error) }, cwd);
				return;
			}
			const message = "Agent SyncTeX hook failed: " + context.error;
			hookLog("warn", "before_agent_start.error_injected", { cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId), error_bytes: Buffer.byteLength(context.error) }, cwd);
			ctx?.ui?.notify?.(message, "warning");
			return {
				message: {
					customType: "pdf-viewer-context",
					content: message,
					display: true,
				},
			};
		}
		hookLog("info", "before_agent_start.context_injected", { cwd_hash: stableHash(cwd), session_hash: stableHash(sessionId), context_bytes: Buffer.byteLength(context.text) }, cwd);
		return {
			message: {
				customType: "pdf-viewer-context",
				content: context.text,
				display: true,
			},
		};
	});
}
`;
}

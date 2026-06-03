#!/usr/bin/env node
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	defaultHostServiceSocketPath,
	HostServiceClient,
	HostServiceServer,
	resolveHostServiceSocketDirectory,
	resolveHostServiceSocketPath,
} from "../src/modules/host_service.ts";
import { HOST_SERVICE_TOOL_NAMES, MCP_TOOL_NAME } from "../src/modules/host_service_mcp.ts";
import { DEFAULT_LATEX_COMPILER, LATEX_COMPILERS } from "../src/modules/latex/latex_file_compiler.ts";

const SERVICE_NAME = "show-latex.service";
const SERVICE_SOURCE_NAME = "show-latex.service";
const SERVICE_TEMPLATE_NAME = "show-latex.service.template";
const HOST_SERVICE_NAME = "tex-actions-host-service";
const SOCKET_CHECK_TIMEOUT_MS = 750;
const MCP_CHECK_TIMEOUT_MS = 750;
const SERVICE_MARKER = "# Managed by tex-actionsctl";
const REMEDIATION_COMMAND_START_SERVICE = "systemctl --user enable --now show-latex.service";
const REMEDIATION_COMMAND_RESTART_SERVICE = "systemctl --user restart show-latex.service";

interface ParsedArgs {
	socketPath: string;
}

interface CliRunContext {
	platform: NodeJS.Platform;
	homeDir: string | undefined;
	configDir: string | undefined;
	tempDir: string | undefined;
	nodePath: string;
	repoRoot: string;
	serviceName: string;
	socketPath: string;
	commandRunner: CommandRunner;
	diagnosticOutput: DiagnosticOutput;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CommandOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult> | CommandResult;

interface DiagnosticOutput {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}


interface SocketDirectoryInspection {
	path: string;
	safe: boolean;
	reason?: string;
}

interface DoctorReport {
	platform: NodeJS.Platform;
	socketPath: string;
	socketDirectory: SocketDirectoryInspection;
	daemonReachable: boolean;
	mcpReachable: boolean;
	viewerBackendAvailable?: boolean;
	viewerBackendInverseSearchAvailable?: boolean;
	viewerBackendCapabilities?: {
		open: boolean;
		close: boolean;
		forward_search: boolean;
		inverse_search: boolean;
		reuse: boolean;
	} | undefined;
	syncTexCapable: boolean;
	guiEnvironmentAvailable: boolean;
	compilerAvailability: Record<string, boolean>;
	remediation: string[];
	warnings: string[];
	statusPayload?: unknown;
	mcpChecks?: {
		initialize: boolean;
		toolsList: boolean;
		toolNames: string[];
	};
	errors: string[];
}

interface ServiceInstallOutcome {
	serviceFilePath: string;
	codexConfigPath: string;
	source: string;
	commands: Array<{ command: string; args: string[] }>;
}

interface ServiceUninstallOutcome {
	serviceFilePath: string;
	serviceRemoved: boolean;
	commands: Array<{ command: string; args: string[] }>;
	runtimeFilesRemoved: string[];
}

interface McpFramePayload {
	jsonrpc: string;
	id?: string | number | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

function resolveScriptDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

function resolveRepoRoot(cliDir = resolveScriptDir()): string {
	return resolve(cliDir, "..");
}

function resolveUnitSourcePath(repoRoot: string): string {
	return resolve(repoRoot, "systemd", SERVICE_SOURCE_NAME);
}

function resolveUnitTemplatePath(repoRoot: string): string {
	return resolve(repoRoot, "systemd", SERVICE_TEMPLATE_NAME);
}

function resolveXdgConfigHome(context: Pick<CliRunContext, "configDir" | "homeDir">): string {
	const explicitConfig = context.configDir;
	if (explicitConfig && explicitConfig.length > 0) {
		return explicitConfig;
	}
	const homeDir = context.homeDir;
	if (homeDir && homeDir.length > 0) {
		return resolve(homeDir, ".config");
	}
	throw new Error("HOME is required to locate user systemd config (set XDG_CONFIG_HOME or HOME)");
}

function resolveServiceInstallDir(context: CliRunContext): string {
	return resolve(resolveXdgConfigHome(context), "systemd", "user");
}

function resolveServiceInstallPath(context: CliRunContext): string {
	return resolve(resolveServiceInstallDir(context), SERVICE_SOURCE_NAME);
}

function resolveCodexConfigPath(context: Pick<CliRunContext, "homeDir">): string {
	const homeDir = context.homeDir;
	if (!homeDir || homeDir.length === 0) {
		throw new Error("HOME is required to locate Codex config");
	}
	return resolve(homeDir, ".codex", "config.toml");
}

function defaultContext(): CliRunContext {
	const repoRoot = resolveRepoRoot();
	const nodePath = process.execPath;
	return {
		platform: process.platform,
		homeDir: process.env.HOME,
		configDir: process.env.XDG_CONFIG_HOME,
		tempDir: process.env.XDG_RUNTIME_DIR,
		nodePath,
		repoRoot,
		serviceName: SERVICE_NAME,
		socketPath: defaultHostServiceSocketPath(),
		commandRunner: runCommand,
		diagnosticOutput: console,
	};
}
function parseArgs(argv: string[]): ParsedArgs {
	let socketPath: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--socket")) {
			continue;
		}

		if (arg === "--socket") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("--socket requires a value");
			}
			socketPath = value;
			index += 1;
			continue;
		}

		if (arg.startsWith("--socket=")) {
			socketPath = arg.slice("--socket=".length);
		}
	}

	return { socketPath: socketPath ?? "" };
}

function inspectSocketDirectory(directoryPath = resolveHostServiceSocketDirectory()): SocketDirectoryInspection {
	const directory = resolve(directoryPath);
	try {
		const st = lstatSync(directory);
		if (st.isSymbolicLink()) {
			return { path: directory, safe: false, reason: `socket directory is a symlink: ${directory}` };
		}
		if (!st.isDirectory()) {
			return { path: directory, safe: false, reason: `socket directory is not a directory: ${directory}` };
		}
		if (process.getuid?.() !== undefined && st.uid !== process.getuid()) {
			return { path: directory, safe: false, reason: `socket directory is not owned by current user: ${directory}` };
		}
		if ((st.mode & 0o777) !== 0o700) {
			return { path: directory, safe: false, reason: `socket directory has unsafe mode: ${directory}` };
		}
		accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
		return { path: directory, safe: true };
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: directory, safe: false, reason: `socket directory does not exist: ${directory}` };
		}
		return { path: directory, safe: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

function isDefaultManagedSocketPath(context: CliRunContext, socketPath: string): boolean {
	const expected = resolveHostServiceSocketPath({ platform: context.platform, runtimeDir: context.tempDir, homeDir: context.homeDir });
	return resolve(socketPath) === resolve(expected);
}

async function isSocketReachable(path: string, timeoutMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(false);
		}, timeoutMs);
		timer.unref?.();
		const socket = createConnection({ path });
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

function hasExactToolSet(actualTools: string[], expectedTools: string[]): boolean {
	const uniqueActual = [...new Set(actualTools)];
	if (uniqueActual.length !== expectedTools.length) {
		return false;
	}
	const expectedSet = new Set(expectedTools);
	for (const tool of uniqueActual) {
		if (!expectedSet.has(tool)) {
			return false;
		}
	}
	return true;
}

function parseMcpFrames(raw: string): unknown[] {
	const frames: unknown[] = [];
	const buffer = Buffer.from(raw, "utf8");
	let cursor = 0;
	while (cursor < buffer.length) {
		const separator = buffer.indexOf("\r\n\r\n", cursor);
		if (separator < 0) {
			break;
		}
		const headerText = buffer.slice(cursor, separator).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(headerText);
		if (!match) {
			break;
		}
		const bodyLength = Number.parseInt(match[1], 10);
		const bodyStart = separator + 4;
		const body = buffer.slice(bodyStart, bodyStart + bodyLength);
		if (body.length < bodyLength) {
			break;
		}
		frames.push(JSON.parse(body.toString("utf8")));
		cursor = bodyStart + bodyLength;
	}
	return frames;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatMcpErrorPayload(error: unknown): string {
	if (!isRecord(error)) {
		return "[unknown MCP error]";
	}
	const code = typeof error["code"] === "number" ? ` code=${error["code"]}` : "";
	const message = typeof error["message"] === "string" ? String(error["message"]) : "[unknown MCP error message]";
	return `${message}${code}`;
}

function validateMcpInitializeResponse(response: McpFramePayload, expectedId: number | string | null): void {
	if (!isRecord(response)) {
		throw new Error("MCP initialize response is not an object");
	}
	if (response.jsonrpc !== "2.0") {
		throw new Error(`MCP initialize response invalid jsonrpc: ${response.jsonrpc}`);
	}
	if (!Object.prototype.hasOwnProperty.call(response, "id") || response.id !== expectedId) {
		throw new Error(`MCP initialize response id mismatch: expected ${String(expectedId)} got ${String(response.id)}`);
	}
	if (response.error !== undefined) {
		throw new Error(`MCP initialize returned error: ${formatMcpErrorPayload(response.error)}`);
	}
	const result = response.result;
	if (!isRecord(result)) {
		throw new Error("MCP initialize response missing result payload");
	}
	const serverInfo = result.serverInfo;
	if (!isRecord(serverInfo) || typeof serverInfo.name !== "string") {
		throw new Error("MCP initialize response missing serverInfo.name");
	}
	if (serverInfo.name !== MCP_TOOL_NAME) {
		throw new Error(`MCP initialize response unexpected server name: ${serverInfo.name}`);
	}
}

function formatToolsListPayload(rawTools: unknown): string[] {
	if (!isRecord(rawTools)) {
		return [];
	}
	const tools = rawTools.tools;
	if (!Array.isArray(tools)) {
		return [];
	}
	return tools
		.map((tool) => (isRecord(tool) && typeof tool["name"] === "string" ? String(tool["name"]) : ""))
		.filter((name) => name.length > 0);
}

function encodeMcpPayload(payload: string): string {
	return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

async function sendMcpRequest<T>(socketPath: string, payload: Record<string, unknown>, timeoutMs = MCP_CHECK_TIMEOUT_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const socket = createConnection({ path: socketPath });
		const encoded = encodeMcpPayload(JSON.stringify(payload));
		let raw = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("daemon MCP request timed out"));
		}, timeoutMs);
		timer.unref?.();
		socket.on("connect", () => {
			socket.write(encoded);
		});
		socket.on("data", (chunk) => {
			raw += String(chunk);
			try {
				const frames = parseMcpFrames(raw);
				if (frames.length > 0) {
					clearTimeout(timer);
					socket.destroy();
					resolve(frames[0] as T);
				}
			} catch (error) {
				clearTimeout(timer);
				socket.destroy();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			if (raw.length > 0) {
				try {
					const frames = parseMcpFrames(raw);
					if (frames.length > 0) {
						resolve(frames[0] as T);
						return;
					}
				} catch {
					reject(error);
					return;
				}
			}
			reject(error);
		});
	});
}

function commandAvailableInPath(command: string, pathEnv = process.env.PATH ?? ""): boolean {
	if (!command) {
		return false;
	}
	const directories = pathEnv.split(":").filter(Boolean);
	for (const directory of directories) {
		const candidate = resolve(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			continue;
		}
	}
	return false;
}

function runCommand(command: string, args: string[], options: CommandOptions = {}): CommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
		env: options.env ?? process.env,
		timeout: options.timeoutMs,
	});
	if (result.error) {
		throw result.error;
	}
	return {
		exitCode: result.status ?? 0,
		stdout: result.stdout ? String(result.stdout) : "",
		stderr: result.stderr ? String(result.stderr) : "",
	};
}

function renderServiceFile(context: CliRunContext): string {
	const templatePath = resolveUnitTemplatePath(context.repoRoot);
	const unitPath = resolveUnitSourcePath(context.repoRoot);
	let content = readFileSync(existsSync(templatePath) ? templatePath : unitPath, "utf8");
	const scriptPath = resolve(context.repoRoot, "scripts", "tex-actionsctl.ts");
	content = content
		.replaceAll("{{NODE_PATH}}", context.nodePath)
		.replaceAll("{{SCRIPT_PATH}}", scriptPath)
		.replaceAll("{{REPO_ROOT}}", context.repoRoot)
		.replaceAll("{{SERVICE_NAME}}", context.serviceName)
		.replaceAll("{{SOCKET_PATH}}", resolve(context.socketPath));
	if (!content.includes(SERVICE_MARKER)) {
		content = `${SERVICE_MARKER}\n${content}`;
	}
	return content;
}

function hasMarker(content: string): boolean {
	return content.includes(SERVICE_MARKER);
}

function isLegacyOwnedServiceUnit(content: string): boolean {
	return content.includes("Description=tex-actions Host Service")
		&& content.includes("Documentation=https://github.com/FrederickAlt/agent-synctex")
		&& content.includes("tex-actionsctl.ts daemon");
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function removeTomlTable(source: string, tableName: string): string {
	const lines = source.split(/\r?\n/);
	const output: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === `[${tableName}]`) {
			skipping = true;
			continue;
		}
		if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
			skipping = false;
		}
		if (!skipping) {
			output.push(line);
		}
	}
	return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function renderCodexMcpConfigBlock(context: CliRunContext): string {
	const relayScriptPath = resolve(context.repoRoot, "scripts", "tex-actions-mcp.ts");
	return [
		"[mcp_servers.pdf-preview]",
		`command = ${tomlString(context.nodePath)}`,
		`args = [${tomlString(relayScriptPath)}]`,
		"startup_timeout_sec = 20",
		"tool_timeout_sec = 60",
		"",
		"[mcp_servers.pdf-preview.env]",
		`TEX_ACTIONS_HOST_SERVICE_SOCKET_PATH = ${tomlString(resolve(context.socketPath))}`,
	].join("\n");
}

function renderCodexConfigWithMcpServer(existing: string, context: CliRunContext): string {
	let next = removeTomlTable(existing, "mcp_servers.pdf-preview.env");
	next = removeTomlTable(next, "mcp_servers.pdf-preview");
	const prefix = next.trimEnd();
	const block = renderCodexMcpConfigBlock(context);
	return `${prefix ? `${prefix}\n\n` : ""}${block}\n`;
}

function writeCodexMcpConfig(context: CliRunContext): string {
	const configPath = resolveCodexConfigPath(context);
	const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
	const next = renderCodexConfigWithMcpServer(existing, context);
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	writeFileSync(configPath, next, { mode: 0o600 });
	return configPath;
}

async function runSetup(context: CliRunContext): Promise<ServiceInstallOutcome> {
	if (context.platform !== "linux") {
		context.diagnosticOutput.warn("setup currently supports Linux user services only");
		context.diagnosticOutput.warn("macOS setup is intentionally not implemented here; use your own LaunchAgent wiring.");
		return { serviceFilePath: resolveServiceInstallPath(context), codexConfigPath: resolveCodexConfigPath(context), source: "", commands: [] };
	}
	const serviceFilePath = resolveServiceInstallPath(context);
	if (existsSync(serviceFilePath)) {
		const existing = readFileSync(serviceFilePath, "utf8");
		if (!hasMarker(existing) && !isLegacyOwnedServiceUnit(existing)) {
			const message = `setup refused: existing unowned systemd unit found at ${serviceFilePath}`;
			throw new Error(`${message}; remediation: remove or replace this unit file before rerunning tex-actionsctl setup`);
		}
	}
	const unitContent = renderServiceFile(context);
	mkdirSync(dirname(serviceFilePath), { recursive: true, mode: 0o700 });
	writeFileSync(serviceFilePath, unitContent, { mode: 0o644 });
	const codexConfigPath = writeCodexMcpConfig(context);
	const commands: Array<{ command: string; args: string[] }> = [];

	const daemonReload = await context.commandRunner("systemctl", ["--user", "daemon-reload"]);
	commands.push({ command: "systemctl", args: ["--user", "daemon-reload"] });
	if (daemonReload.exitCode !== 0) {
		const error = `systemctl --user daemon-reload failed: ${daemonReload.stderr || daemonReload.stdout}`.trim();
		context.diagnosticOutput.error(error);
		throw new Error(error);
	}

	const enable = await context.commandRunner("systemctl", ["--user", "enable", "--now", context.serviceName]);
	commands.push({ command: "systemctl", args: ["--user", "enable", "--now", context.serviceName] });
	if (enable.exitCode !== 0) {
		const error = `systemctl --user enable --now ${context.serviceName} failed: ${enable.stderr || enable.stdout}`.trim();
		context.diagnosticOutput.error(error);
		throw new Error(error);
	}

	return {
		serviceFilePath,
		codexConfigPath,
		source: unitContent,
		commands,
	};
}

async function runUninstall(context: CliRunContext): Promise<ServiceUninstallOutcome> {
	const serviceFilePath = resolveServiceInstallPath(context);
	const commands: Array<{ command: string; args: string[] }> = [];
	const runtimeFilesRemoved: string[] = [];
	if (existsSync(serviceFilePath)) {
		const existing = readFileSync(serviceFilePath, "utf8");
		if (hasMarker(existing)) {
			const stop = await context.commandRunner("systemctl", ["--user", "stop", context.serviceName]);
			commands.push({ command: "systemctl", args: ["--user", "stop", context.serviceName] });
			if (stop.exitCode !== 0 && stop.exitCode !== 5) {
				context.diagnosticOutput.warn(`systemctl --user stop ${context.serviceName} failed: ${stop.stderr || stop.stdout}`);
			}
			const disable = await context.commandRunner("systemctl", ["--user", "disable", context.serviceName]);
			commands.push({ command: "systemctl", args: ["--user", "disable", context.serviceName] });
			if (disable.exitCode !== 0 && disable.exitCode !== 1 && disable.exitCode !== 5) {
				context.diagnosticOutput.warn(`systemctl --user disable ${context.serviceName} failed: ${disable.stderr || disable.stdout}`);
			}
			rmSync(serviceFilePath, { force: true });
			const socketPath = context.socketPath;
			if (isDefaultManagedSocketPath(context, socketPath)) {
				const socketDir = dirname(socketPath);
				const socketDirectory = inspectSocketDirectory(socketDir);
				if (socketDirectory.safe) {
					const active = await isSocketReachable(socketPath);
					if (!active) {
						try {
							const st = lstatSync(socketPath);
							if (st.isSocket()) {
								rmSync(socketPath, { force: true });
								runtimeFilesRemoved.push(socketPath);
							}
						} catch {
							// ignore stale runtime cleanup failures
						}
					} else {
						context.diagnosticOutput.warn(`skipped socket cleanup because ${socketPath} appears active`);
					}
				} else {
					context.diagnosticOutput.warn(`skipped socket cleanup; socket directory is not safe: ${socketDirectory.reason}`);
				}
			}
		}
	}

	if (context.platform === "linux") {
		const reload = await context.commandRunner("systemctl", ["--user", "daemon-reload"]);
		commands.push({ command: "systemctl", args: ["--user", "daemon-reload"] });
		if (reload.exitCode !== 0 && reload.exitCode !== 1) {
			context.diagnosticOutput.warn(`systemctl --user daemon-reload failed: ${reload.stderr || reload.stdout}`);
		}
	}

	return {
		serviceFilePath,
		serviceRemoved: !existsSync(serviceFilePath),
		commands,
		runtimeFilesRemoved,
	};
}

async function runDoctor(context: CliRunContext): Promise<DoctorReport> {
	const report: DoctorReport = {
		socketPath: context.socketPath,
		platform: context.platform,
		socketDirectory: inspectSocketDirectory(dirname(resolve(context.socketPath))),
		daemonReachable: false,
		mcpReachable: false,
		syncTexCapable: false,
		guiEnvironmentAvailable: checkGuiAvailability(),
		compilerAvailability: Object.fromEntries(
			LATEX_COMPILERS.map((compiler) => [compiler, commandAvailableInPath(compiler, process.env.PATH)]),
		),
		remediation: [],
		warnings: [],
		errors: [],
	};

	if (!report.socketDirectory.safe) {
		report.errors.push(`Unsafe socket directory: ${report.socketDirectory.reason}`);
		report.remediation.push(`mkdir -p ${report.socketDirectory.path}`);
		report.remediation.push(`chmod 700 ${report.socketDirectory.path}`);
	}

	if (context.platform !== "linux") {
		report.errors.push(`Partial support: platform ${context.platform} does not support setup/uninstall via systemd launchers.`);
	}

	const client = new HostServiceClient({
		socketPath: report.socketPath,
		requestTimeoutMs: SOCKET_CHECK_TIMEOUT_MS,
	});
	try {
		const status = await client.requestStatus({ cwd: process.cwd() });
		report.daemonReachable = true;
		report.statusPayload = status;
		report.viewerBackendAvailable = status.viewer_backend_available;
		report.viewerBackendCapabilities = status.viewer_backend_capabilities;
		report.syncTexCapable = Boolean(status.viewer_backend_capabilities?.inverse_search);
		report.mcpChecks = {
			initialize: false,
			toolsList: false,
			toolNames: [],
		};

		try {
			const initializePayload = await sendMcpRequest<McpFramePayload>(
				report.socketPath,
				{
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {},
				},
			);
			validateMcpInitializeResponse(initializePayload, 1);
			report.mcpChecks.initialize = true;
			report.mcpReachable = true;
		} catch (error) {
			report.errors.push(`MCP initialize failed: ${error instanceof Error ? error.message : String(error)}`);
			report.remediation.push(REMEDIATION_COMMAND_RESTART_SERVICE);
		}

		if (report.mcpChecks.initialize) {
			try {
				const toolsPayload = await sendMcpRequest<McpFramePayload>(
					report.socketPath,
					{
						jsonrpc: "2.0",
						id: 2,
						method: "tools/list",
						params: {},
					},
				);
				if (toolsPayload.error !== undefined) {
					report.errors.push(`MCP tools/list returned error: ${formatMcpErrorPayload(toolsPayload.error)}`);
					report.remediation.push(REMEDIATION_COMMAND_RESTART_SERVICE);
				} else {
					report.mcpChecks.toolNames = formatToolsListPayload(toolsPayload.result);
					report.mcpChecks.toolsList = hasExactToolSet(report.mcpChecks.toolNames, Array.from(HOST_SERVICE_TOOL_NAMES));
					if (!report.mcpChecks.toolsList) {
						report.errors.push(`MCP tools/list returned unexpected tools: ${report.mcpChecks.toolNames.join(", ")}`);
						report.remediation.push(REMEDIATION_COMMAND_RESTART_SERVICE);
					}
				}
			} catch (error) {
				report.errors.push(`MCP tools/list failed: ${error instanceof Error ? error.message : String(error)}`);
				report.remediation.push(REMEDIATION_COMMAND_RESTART_SERVICE);
			}
		}
	} catch (error) {
		report.errors.push(`Daemon check failed: ${error instanceof Error ? error.message : String(error)}`);
		report.remediation.push(REMEDIATION_COMMAND_RESTART_SERVICE);
	}

	if (!report.compilerAvailability[DEFAULT_LATEX_COMPILER]) {
		report.errors.push(`Required LaTeX compiler missing from PATH: ${DEFAULT_LATEX_COMPILER}`);
	}
	for (const [compiler, available] of Object.entries(report.compilerAvailability)) {
		if (compiler === DEFAULT_LATEX_COMPILER) {
			continue;
		}
		if (!available) {
			report.warnings.push(`Optional LaTeX compiler missing from PATH: ${compiler}`);
		}
	}
	if (report.viewerBackendAvailable === false) {
		report.errors.push("Viewer backend reported unavailable");
		report.remediation.push(REMEDIATION_COMMAND_START_SERVICE);
	}
	if (!report.guiEnvironmentAvailable) {
		report.errors.push("No GUI/session signal detected for local viewer support");
	}

	if (!report.daemonReachable) {
		report.remediation.push(REMEDIATION_COMMAND_START_SERVICE);
	}

	report.remediation = [...new Set(report.remediation.filter(Boolean))];
	return report;
}

function checkGuiAvailability(): boolean {
	return Boolean(
		process.env.DISPLAY
		|| process.env.WAYLAND_DISPLAY
		|| process.env.X11_UNIX
		|| process.env.GDK_BACKEND
	);
}

function printDoctor(report: DoctorReport, output: DiagnosticOutput): void {
	const header = [
		"tex-actions doctor",
		`platform: ${report.platform}`,
		`socket path: ${report.socketPath}`,
		`socket directory: ${report.socketDirectory.path}`,
		`socket directory safe: ${report.socketDirectory.safe ? "yes" : `no (${report.socketDirectory.reason})`}`,
	];
	for (const line of header) {
		output.info(line);
	}

	output.info(`daemon reachable: ${report.daemonReachable ? "yes" : "no"}`);
	if (report.daemonReachable && report.mcpChecks) {
		output.info(`mcp initialize: ${report.mcpChecks.initialize ? "yes" : "no"}`);
		output.info(`mcp tools/list: ${report.mcpChecks.toolsList ? "yes" : "no"}`);
		output.info(`mcp tools: ${report.mcpChecks.toolNames.join(", ")}`);
	}
	if (typeof report.viewerBackendAvailable === "boolean") {
		output.info(`viewer backend available: ${report.viewerBackendAvailable ? "yes" : "no"}`);
	}
	if (report.viewerBackendCapabilities) {
		output.info(`syncTeX capable: ${report.syncTexCapable ? "yes" : "no"}`);
	}
	output.info(`GUI/session available: ${report.guiEnvironmentAvailable ? "yes" : "no"}`);
	output.info("latex compilers:");
	for (const [compiler, available] of Object.entries(report.compilerAvailability)) {
		output.info(`  - ${compiler}: ${available ? "yes" : "no"}`);
	}

	if (report.warnings.length > 0) {
		output.warn("doctor checks warning:");
		for (const message of report.warnings) {
			output.warn(`  - ${message}`);
		}
	}
	if (report.errors.length > 0) {
		output.error("doctor checks failed:");
		for (const message of report.errors) {
			output.error(`  - ${message}`);
		}
		if (report.remediation.length > 0) {
			output.error("remediation:");
			for (const line of report.remediation) {
				output.error(`  - ${line}`);
			}
		}
		return;
	}
	output.info("status: ok");
}

function usage(): void {
	console.log(`TeX Actions daemon control
	tex-actionsctl daemon [--socket <path>]  # start/hold daemon
	tex-actionsctl status [--socket <path>]  # query status
	tex-actionsctl setup                       # install and start Linux user service
	tex-actionsctl uninstall                   # stop/remove Linux user service
	tex-actionsctl doctor [--socket <path>]    # verify daemon/runtime/MCP health`);
}

async function run(): Promise<void> {
	const context = defaultContext();
	const command = process.argv[2] ?? "status";
	const parsed = parseArgs(process.argv.slice(3));
	const socketPath = parsed.socketPath ? resolve(parsed.socketPath) : defaultHostServiceSocketPath();
	context.socketPath = socketPath;

	switch (command) {
		case "daemon":
		case "start":
			await runDaemon(socketPath);
			return;
		case "status": {
			await runStatus(socketPath);
			return;
		}
		case "setup": {
			try {
				await runSetup(context);
				if (context.platform === "linux") {
					console.log(`tex-actions setup: wrote unit ${resolveServiceInstallPath(context)}`);
					console.log(`service command: ${REMEDIATION_COMMAND_START_SERVICE}`);
				}
			} catch (error) {
				console.error(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
				if (context.platform === "linux") {
					console.error(`remediation: ${REMEDIATION_COMMAND_START_SERVICE}`);
				}
				process.exitCode = 1;
			}
			return;
		}
		case "uninstall": {
			try {
				await runUninstall(context);
				console.log(`tex-actions uninstall: removed ${resolveServiceInstallPath(context)} (if owned)`);
			} catch (error) {
				console.error(`uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
			}
			return;
		}
		case "doctor": {
			const report = await runDoctor(context);
			printDoctor(report, context.diagnosticOutput);
			if (report.errors.length > 0) {
				process.exitCode = 1;
			}
			return;
		}
		default:
			usage();
			process.exitCode = 2;
		}
}

async function runDaemon(socketPath: string): Promise<void> {
	const server = new HostServiceServer({
		socketPath,
		serviceName: HOST_SERVICE_NAME,
	});
	await server.start();
	console.log(`tex-actions daemon: started at ${socketPath}`);
	process.stdout.write(`TeX Actions host service running on ${socketPath}\n`);

	await new Promise<void>((resolve) => {
		const shutdown = async () => {
			await server.stop().catch((error) => {
				console.error(`failed to stop host service: ${error instanceof Error ? error.message : String(error)}`);
			});
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
}

async function runStatus(socketPath: string): Promise<void> {
	const client = new HostServiceClient({ socketPath });
	const status = await client.requestStatus({ cwd: process.cwd() });
	console.log(JSON.stringify(status, null, 2));
}

export {
	checkGuiAvailability,
	commandAvailableInPath,
	defaultContext,
	runDoctor,
	runSetup,
	runUninstall,
	renderServiceFile,
	resolveHostServiceSocketPath,
	runCommand,
	parseArgs,
	run,
	usage,
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
	run().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

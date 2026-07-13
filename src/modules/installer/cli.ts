import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import { resolve } from "node:path";
import { fetchHookContext } from "../hook_context.ts";
import { startTexActionsStdioMcpRuntime } from "../stdio_mcp_runtime.ts";
import { selectHarnessAdapters, selectInstallHarnessAdapters, isHarnessId } from "./detect_harnesses.ts";
import { recordManifest, removeManifestHarness } from "./manifest.ts";
import type { HarnessId, HarnessSelection, InstallerContext, InstallScope } from "./types.ts";
import { findExecutable, MACTEX_BIN_DIR } from "../executable_resolution.ts";

interface ParsedCli {
	command?: string;
	subcommand?: string;
	harness: HarnessSelection;
	scope: InstallScope;
	dryRun: boolean;
	yes: boolean;
	noHooks: boolean;
	agentId?: string;
	cwd: string;
	help: boolean;
}

export function printAgentSynctexHelp(stdout: Pick<NodeJS.WritableStream, "write"> = processStdout): void {
	stdout.write(`Usage: agent-synctex <command> [options]

Commands:
  mcp                     Start the stdio MCP server.
  fetch-info              Read prompt from stdin and print pending PDF mark context, or empty output.
  install                 Install MCP config and prompt hooks/plugins/extensions.
  install mcp             Install MCP config only for a harness.
  install hooks           Install prompt hooks/plugins/extensions for a harness.
  uninstall [harness]     Remove managed MCP config and hooks for a harness.
  doctor                  Inspect managed harness integration state.

Options:
  --harness <name>        auto|all|claude|codex|cline|pi|opencode (default: auto; required for hook-capable mcp/fetch-info)
  --local                 Write project-local config/hooks instead of user/global config.
  --scope <scope>         project|user (default: user; --local is shorthand for --scope project)
  --no-hooks              For mcp/install mcp/install: manual-only mode; do not install/use hooks.
  --agent-id <id>         Explicit agent/session id for mcp and fetch-info ownership.
  --cwd <path>            Project directory (default: current working directory)
  --dry-run               Print planned changes without writing files.
  --yes                   Accept non-interactive defaults.
  -h, --help              Show this help.
`);
}

export async function runAgentSynctexCli(argv: string[], io: { stdin?: NodeJS.ReadableStream; stdout?: Pick<NodeJS.WritableStream, "write">; stderr?: Pick<NodeJS.WritableStream, "write"> } = {}): Promise<number> {
	const stdout = io.stdout ?? processStdout;
	const stderr = io.stderr ?? processStderr;
	let parsed: ParsedCli;
	try {
		parsed = parseCli(argv);
	} catch (error) {
		stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	if (parsed.help || parsed.command === undefined) {
		printAgentSynctexHelp(stdout);
		return 0;
	}
	if (parsed.command === "mcp") {
		return runMcp(parsed, stderr);
	}
	if (parsed.command === "fetch-info") {
		if (!isHarnessId(parsed.harness)) return 0;
		try {
			const prompt = await readStdin(io.stdin ?? processStdin);
			const context = await fetchHookContext({ prompt, agentId: parsed.agentId, cwd: parsed.cwd });
			if (context) stdout.write(context);
			return 0;
		} catch (error) {
			stderr.write(`Agent SyncTeX mark fetch failed: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	}

	const ctx: InstallerContext = {
		cwd: parsed.cwd,
		scope: parsed.scope,
		dryRun: parsed.dryRun,
		yes: parsed.yes,
		noHooks: parsed.noHooks,
		stdout,
		stderr,
	};

	try {
		if (parsed.command === "install") {
			if (parsed.subcommand !== undefined && parsed.subcommand !== "mcp" && parsed.subcommand !== "hooks") throw new Error("install subcommand must be mcp or hooks");
			if (parsed.subcommand === "hooks" && parsed.noHooks) throw new Error("install hooks cannot be combined with --no-hooks");
			const adapters = await selectInstallHarnessAdapters(ctx, parsed.harness);
			for (const adapter of adapters) {
				const installMcp = parsed.subcommand === undefined || parsed.subcommand === "mcp";
				const installHooks = parsed.subcommand === "hooks" || (parsed.subcommand === undefined && !parsed.noHooks);
				const changes = [
					...(installMcp ? await adapter.installMcp(ctx) : []),
					...(installHooks ? await adapter.installHooks(ctx) : []),
				];
				recordManifest(ctx, adapter.id, { mcpInstalled: installMcp ? true : undefined, hooksInstalled: installHooks ? true : undefined, changes });
				printChanges(stdout, adapter.id, changes, ctx.dryRun);
			}
			return 0;
		}
		if (parsed.command === "uninstall") {
			if (parsed.subcommand !== undefined) throw new Error(`Unknown uninstall target: ${parsed.subcommand}`);
			const adapters = await selectHarnessAdapters(ctx, parsed.harness);
			for (const adapter of adapters) {
				const changes = await adapter.uninstall(ctx);
				removeManifestHarness(ctx, adapter.id);
				printChanges(stdout, adapter.id, changes, ctx.dryRun);
			}
			return 0;
		}
		if (parsed.command === "doctor") {
			for (const command of ["latexmk", "synctex"] as const) {
				const resolved = findExecutable(command);
				const found = resolved !== undefined;
				stdout.write(`[${found ? "ok" : "warn"}] runtime: ${command} ${found ? `resolved to ${resolved}` : `was not found on PATH${process.platform === "darwin" ? ` or ${MACTEX_BIN_DIR}` : ""}`}\n`);
			}
			const adapters = await selectHarnessAdapters(ctx, parsed.harness === "auto" ? "all" : parsed.harness);
			for (const adapter of adapters) {
				for (const finding of await adapter.doctor(ctx)) {
					stdout.write(`[${finding.level}] ${finding.harness}: ${finding.message}\n`);
				}
			}
			return 0;
		}
		throw new Error(`Unknown command: ${parsed.command}`);
	} catch (error) {
		stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

function runMcp(parsed: ParsedCli, stderr: Pick<NodeJS.WritableStream, "write">): number {
	if (parsed.harness !== "auto" && parsed.harness !== "all" && isHarnessId(parsed.harness)) {
		const runtime = startTexActionsStdioMcpRuntime({
			launchCwd: parsed.cwd,
			agentId: parsed.agentId,
			hookMode: parsed.noHooks ? { kind: "no-hooks", harness: parsed.harness } : { kind: "hook-capable", harness: parsed.harness },
		});
		process.once("SIGINT", () => runtime.close());
		process.once("SIGTERM", () => runtime.close());
		return 0;
	}
	if (!parsed.noHooks) {
		stderr.write("Agent SyncTeX: agent-synctex mcp started without --harness; falling back to --no-hooks mode.\n");
	}
	const runtime = startTexActionsStdioMcpRuntime({
		launchCwd: parsed.cwd,
		hookMode: { kind: "no-hooks", fallbackReason: parsed.noHooks ? undefined : "missing-harness" },
	});
	process.once("SIGINT", () => runtime.close());
	process.once("SIGTERM", () => runtime.close());
	return 0;
}

function parseCli(argv: string[]): ParsedCli {
	const parsed: ParsedCli = {
		harness: "auto",
		scope: "user",
		dryRun: false,
		yes: false,
		noHooks: false,
		cwd: process.cwd(),
		help: false,
	};
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
		} else if (arg === "--dry-run") {
			parsed.dryRun = true;
		} else if (arg === "--yes" || arg === "-y") {
			parsed.yes = true;
		} else if (arg === "--no-hooks") {
			parsed.noHooks = true;
		} else if (arg === "--local") {
			parsed.scope = "project";
		} else if (arg === "--harness") {
			const value = argv[++index];
			if (!value) throw new Error("Missing value for --harness");
			parsed.harness = parseHarnessSelection(value);
		} else if (arg.startsWith("--harness=")) {
			parsed.harness = parseHarnessSelection(arg.slice("--harness=".length));
		} else if (arg === "--scope") {
			const value = argv[++index];
			if (value !== "project" && value !== "user") throw new Error("--scope must be project or user");
			parsed.scope = value;
		} else if (arg.startsWith("--scope=")) {
			const value = arg.slice("--scope=".length);
			if (value !== "project" && value !== "user") throw new Error("--scope must be project or user");
			parsed.scope = value;
		} else if (arg === "--agent-id") {
			const value = argv[++index];
			if (!value) throw new Error("Missing value for --agent-id");
			parsed.agentId = value;
		} else if (arg.startsWith("--agent-id=")) {
			parsed.agentId = arg.slice("--agent-id=".length);
		} else if (arg === "--cwd") {
			const value = argv[++index];
			if (!value) throw new Error("Missing value for --cwd");
			parsed.cwd = resolve(value);
		} else if (arg.startsWith("--cwd=")) {
			parsed.cwd = resolve(arg.slice("--cwd=".length));
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	parsed.command = positional[0];
	parsed.subcommand = positional[1];
	if (parsed.command === "uninstall" && parsed.subcommand && isHarnessId(parsed.subcommand)) {
		parsed.harness = parsed.subcommand;
		parsed.subcommand = undefined;
	}
	if (parsed.command === "uninstall" && parsed.subcommand === "all") {
		parsed.harness = "all";
		parsed.subcommand = undefined;
	}
	if (parsed.command === "install" && positional.length > 2) throw new Error("Too many positional arguments for install");
	if (!["install", "uninstall", "doctor", "fetch-info", "mcp", undefined].includes(parsed.command)) {
		throw new Error(`Unknown command: ${parsed.command}`);
	}
	return parsed;
}

function parseHarnessSelection(value: string): HarnessSelection {
	if (value === "auto" || value === "all" || isHarnessId(value)) return value;
	throw new Error(`Unknown harness: ${value}`);
}

function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		stdin.setEncoding("utf8");
		stdin.on("data", (chunk) => { data += chunk; });
		stdin.on("end", () => resolve(data));
		stdin.on("error", reject);
	});
}

function printChanges(stdout: Pick<NodeJS.WritableStream, "write">, harness: string, changes: readonly { description: string; path?: string }[], dryRun: boolean): void {
	const prefix = dryRun ? "[dry-run]" : "[ok]";
	if (changes.length === 0) {
		stdout.write(`${prefix} ${harness}: no managed changes\n`);
		return;
	}
	for (const item of changes) {
		stdout.write(`${prefix} ${harness}: ${item.description}${item.path ? ` (${item.path})` : ""}\n`);
	}
}

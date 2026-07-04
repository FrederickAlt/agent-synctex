import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";
import { resolve } from "node:path";
import { fetchHookContext } from "../hook_context_bridge.ts";
import { selectHarnessAdapters, isHarnessId } from "./detect_harnesses.ts";
import { recordManifest, removeManifestHarness } from "./manifest.ts";
import type { HarnessSelection, InstallerContext, InstallScope } from "./types.ts";

interface ParsedCli {
	command?: string;
	subcommand?: string;
	harness: HarnessSelection;
	scope: InstallScope;
	dryRun: boolean;
	yes: boolean;
	cwd: string;
	help: boolean;
}

export function printAgentSynctexHelp(stdout: Pick<NodeJS.WritableStream, "write"> = processStdout): void {
	stdout.write(`Usage: agent-synctex <command> [options]

Commands:
  fetch-info              Read prompt from stdin and print pending PDF mark context, or empty output.
  install mcp             Install MCP config only for a harness.
  install hooks           Install prompt hooks/plugins/extensions and switch MCP config to --with-hooks.
  uninstall [harness]     Remove managed MCP config and hooks for a harness.
  doctor                  Inspect managed harness integration state.

Options:
  --harness <name>        auto|all|claude|codex|cline|pi|opencode (default: auto)
  --scope <scope>         project|user (default: project; user is reserved for future global config support)
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
	if (parsed.command === "fetch-info") {
		const prompt = await readStdin(io.stdin ?? processStdin).catch(() => "");
		const context = await fetchHookContext({ prompt }).catch(() => "");
		if (context) stdout.write(context);
		return 0;
	}

	const ctx: InstallerContext = {
		cwd: parsed.cwd,
		scope: parsed.scope,
		dryRun: parsed.dryRun,
		yes: parsed.yes,
		stdout,
		stderr,
	};

	try {
		if (parsed.command === "install") {
			if (parsed.subcommand !== "mcp" && parsed.subcommand !== "hooks") throw new Error("install requires subcommand: mcp or hooks");
			const adapters = await selectHarnessAdapters(ctx, parsed.harness);
			for (const adapter of adapters) {
				const changes = parsed.subcommand === "mcp" ? await adapter.installMcp(ctx) : await adapter.installHooks(ctx);
				recordManifest(ctx, adapter.id, { mcpInstalled: true, hooksInstalled: parsed.subcommand === "hooks" ? true : undefined, changes });
				printChanges(stdout, adapter.id, changes, ctx.dryRun);
			}
			return 0;
		}
		if (parsed.command === "uninstall") {
			const adapters = await selectHarnessAdapters(ctx, parsed.harness);
			for (const adapter of adapters) {
				const changes = await adapter.uninstall(ctx);
				removeManifestHarness(ctx, adapter.id);
				printChanges(stdout, adapter.id, changes, ctx.dryRun);
			}
			return 0;
		}
		if (parsed.command === "doctor") {
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

function parseCli(argv: string[]): ParsedCli {
	const parsed: ParsedCli = {
		harness: "auto",
		scope: "project",
		dryRun: false,
		yes: false,
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
	if (parsed.command !== "install" && parsed.command !== "uninstall" && parsed.command !== "doctor" && parsed.command !== "fetch-info" && parsed.command !== undefined) {
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

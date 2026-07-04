#!/usr/bin/env node
import { startTexActionsStdioMcpRuntime } from "../src/modules/stdio_mcp_runtime.ts";

function printHelp(): void {
	process.stdout.write(`Usage: tex-actions-mcp [--with-hooks]\n\nOptions:\n  --with-hooks  Hide the manual PDF context tool because harness hooks inject PDF marks automatically.\n  -h, --help    Show this help.\n`);
}

function parseArgs(argv: string[]): { hooksEnabled: boolean; help: boolean } {
	let hooksEnabled = false;
	let help = false;
	for (const arg of argv) {
		if (arg === "--with-hooks") {
			hooksEnabled = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { hooksEnabled, help };
}

let args: { hooksEnabled: boolean; help: boolean };
try {
	args = parseArgs(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
	process.exit();
}

if (args.help) {
	printHelp();
	process.exit(0);
}

const runtime = startTexActionsStdioMcpRuntime({ hooksEnabled: args.hooksEnabled });
process.once("SIGINT", () => runtime.close());
process.once("SIGTERM", () => runtime.close());

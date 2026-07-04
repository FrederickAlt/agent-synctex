#!/usr/bin/env node
import { runAgentSynctexCli } from "../src/modules/installer/cli.ts";

process.exitCode = await runAgentSynctexCli(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	return 1;
});

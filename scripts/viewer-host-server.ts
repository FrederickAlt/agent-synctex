#!/usr/bin/env node
import readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { startDesktopViewerHostForDesktopWrapper } from "../src/modules/tauri_viewer_wrapper.ts";

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`PDF_PREVIEW_VIEWER_HOST_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
	}
	return port;
}

const launched = await startDesktopViewerHostForDesktopWrapper({ port: parsePort(process.env.PDF_PREVIEW_VIEWER_HOST_PORT) });
let stopping = false;

async function shutdown(reason: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	await launched.shutdown();
	stdout.write(JSON.stringify({ type: "stopped", reason }) + "\n");
}

stdout.write(JSON.stringify({ type: "ready", origin: launched.origin, app_url: launched.appUrl, address: launched.address }) + "\n");

const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", (line) => {
	if (line.trim() === "shutdown") {
		void shutdown("stdin").then(() => process.exit(0));
	}
});
input.on("close", () => {
	void shutdown("stdin_closed").then(() => process.exit(0));
});

process.on("SIGINT", () => {
	void shutdown("SIGINT").then(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void shutdown("SIGTERM").then(() => process.exit(0));
});
process.on("uncaughtException", (error) => {
	stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	void shutdown("uncaughtException").then(() => process.exit(1));
});

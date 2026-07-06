#!/usr/bin/env node
import readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { ViewerHostPdfRegistry } from "../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../src/modules/viewer_host_server.ts";

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`PDF_PREVIEW_VIEWER_HOST_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
	}
	return port;
}

function parseIdleTimeoutMs(value: string | undefined): number {
	if (value === undefined || value === "") return 30 * 60_000;
	const timeout = Number(value);
	if (!Number.isInteger(timeout) || timeout < 0) {
		throw new Error(`AGENT_SYNCTEX_VIEWER_HOST_IDLE_MS must be a non-negative integer, got ${JSON.stringify(value)}`);
	}
	return timeout;
}

const persistent = process.env.AGENT_SYNCTEX_PERSISTENT_VIEWER_HOST === "1";
const idleTimeoutMs = parseIdleTimeoutMs(process.env.AGENT_SYNCTEX_VIEWER_HOST_IDLE_MS);
const shutdownToken = process.env.AGENT_SYNCTEX_VIEWER_HOST_SHUTDOWN_TOKEN;
const controlToken = process.env.AGENT_SYNCTEX_VIEWER_HOST_CONTROL_TOKEN;
const registry = new ViewerHostPdfRegistry();
let stopping = false;
const server = new ViewerHostServer({
	registry,
	port: parsePort(process.env.PDF_PREVIEW_VIEWER_HOST_PORT),
	...(shutdownToken === undefined ? {} : { shutdownRequest: { token: shutdownToken, shutdown: (reason: string) => shutdown(reason) } }),
	...(controlToken === undefined ? {} : { controlToken }),
});
await server.start();

async function shutdown(reason: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	await server.stop();
	if (!persistent) stdout.write(JSON.stringify({ type: "stopped", reason }) + "\n");
}

stdout.write(JSON.stringify({ type: "ready", origin: server.origin, app_url: server.appUrl, address: server.address }) + "\n");

if (persistent && idleTimeoutMs > 0) {
	let lastActiveAt = Date.now();
	setInterval(() => {
		if (server.hasActiveViewerClients()) {
			lastActiveAt = Date.now();
			return;
		}
		if (Date.now() - lastActiveAt >= idleTimeoutMs) {
			void shutdown("idle_timeout").then(() => process.exit(0));
		}
	}, Math.min(30_000, Math.max(1_000, Math.floor(idleTimeoutMs / 4)))).unref();
}

const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", (line) => {
	if (line.trim() === "shutdown") {
		void shutdown("stdin").then(() => process.exit(0));
	}
});
input.on("close", () => {
	if (!persistent) {
		void shutdown("stdin_closed").then(() => process.exit(0));
	}
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

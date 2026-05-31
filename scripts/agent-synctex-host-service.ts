#!/usr/bin/env node
import { HostServiceClient, HostServiceServer, defaultHostServiceSocketPath } from "../src/modules/host_service.ts";

interface ParsedArgs {
	socketPath: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	let socketPath = defaultHostServiceSocketPath();
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
	return { socketPath };
}

function usage(): void {
	console.log(`agent-synctex host service
	agent-synctex-host-service.ts start [--socket <path>]  # start/hold daemon
	agent-synctex-host-service.ts status [--socket <path>] # query status`);
}

async function runStart(socketPath: string): Promise<void> {
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-host-service" });
	await server.start();
	console.log(`agent-synctex-host-service: started at ${socketPath}`);
	process.stdout.write(`agent-synctex host service running on ${socketPath}\n`);

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

async function run(): Promise<void> {
	const command = process.argv[2] ?? "status";
	const args = parseArgs(process.argv.slice(3));

	switch (command) {
		case "start": {
			await runStart(args.socketPath);
			return;
		}
		case "status": {
			await runStatus(args.socketPath);
			return;
		}
		default: {
			usage();
			process.exitCode = 2;
			return;
		}
	}
}

run().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

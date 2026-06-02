#!/usr/bin/env node
import {
	defaultHostServiceSocketPath,
	HostServiceClient,
	HostServiceServer,
	ZathuraViewerBackend,
} from "../src/modules/host_service.ts";

interface ParsedArgs {
	socketPath: string;
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

function usage(): void {
	console.log(`TeX Actions daemon control
	tex-actionsctl daemon [--socket <path>]  # start/hold daemon
	tex-actionsctl status [--socket <path>]  # query status`);
}

function parseSocketPath(argv: string[]): string {
	const { socketPath } = parseArgs(argv);
	if (socketPath) {
		return socketPath;
	}
	return defaultHostServiceSocketPath();
}

async function runDaemon(socketPath: string): Promise<void> {
	const server = new HostServiceServer({
		socketPath,
		serviceName: "tex-actions-host-service",
		viewerBackend: new ZathuraViewerBackend(),
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

async function run(): Promise<void> {
	const command = process.argv[2] ?? "status";
	const socketPath = parseSocketPath(process.argv.slice(3));

	switch (command) {
		case "daemon":
		case "start": {
			await runDaemon(socketPath);
			return;
		}
		case "status": {
			await runStatus(socketPath);
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

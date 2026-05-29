#!/usr/bin/env node
import { createConnection } from "node:net";

function usage() {
	console.error("usage: pi_synctex_callback.mjs --socket SOCKET --token TOKEN --file FILE --line LINE");
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		if (!key.startsWith("--")) {
			throw new Error(`unexpected argument: ${key}`);
		}
		const value = argv[i + 1];
		if (value === undefined) {
			throw new Error(`missing value for ${key}`);
		}
		args[key.slice(2)] = value;
		i += 1;
	}
	return args;
}

function sendClick(socketPath, message) {
	return new Promise((resolve, reject) => {
		let response = "";
		let settled = false;
		const socket = createConnection(socketPath);
		socket.setEncoding("utf8");

		const settle = (callback) => {
			if (settled) return;
			settled = true;
			callback();
		};

		socket.on("connect", () => {
			socket.end(`${JSON.stringify(message)}\n`);
		});
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.on("error", (error) => {
			settle(() => reject(error));
		});
		socket.on("close", () => {
			settle(() => {
				try {
					resolve(JSON.parse(response));
				} catch {
					reject(new Error(response.trim() || "empty callback response"));
				}
			});
		});
	});
}

function piPidFromSocketPath(socketPath) {
	const match = /(?:^|\/)pi-synctex-(\d+)-[0-9a-f]+\.sock$/.exec(socketPath);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function requestPiRedraw(socketPath) {
	const pid = piPidFromSocketPath(socketPath);
	if (pid === undefined) return;
	try {
		process.kill(pid, "SIGWINCH");
	} catch {
		// Best-effort redraw nudge only. The socket response already confirmed paste delivery.
	}
}

try {
	const args = parseArgs(process.argv.slice(2));
	const line = Number(args.line);
	if (!args.socket || !args.token || !args.file || !Number.isInteger(line) || line < 1) {
		usage();
		process.exit(2);
	}

	const response = await sendClick(args.socket, {
		token: args.token,
		file: args.file,
		line,
	});
	if (!response.ok) {
		throw new Error(response.error || "SyncTeX callback rejected");
	}
	requestPiRedraw(args.socket);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`pi SyncTeX callback failed: ${message}`);
	process.exit(1);
}

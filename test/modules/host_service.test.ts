import { spawn } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { HostServiceClient, HostServiceServer } from "../../src/modules/host_service.ts";

function temporaryDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function socketMode(path: string): number {
	return lstatSync(path).mode & 0o777;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForFile(path: string, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			return;
		}
		await sleep(10);
	}
	throw new Error(`Timed out waiting for socket: ${path}`);
}

function writeJsonServer(path: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => {
			socket.on("error", () => {
				/* ignore */
			});
			socket.end("ok");
		});
		server.once("error", reject);
		server.listen(path, () => {
			resolve(server);
		});
	});
}

function readFromSocket(path: string, timeoutMs = 300): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path });
		let raw = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("socket roundtrip timed out"));
		}, timeoutMs);
		timer.unref?.();

		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			raw += String(chunk);
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			if (raw.length > 0) {
				resolve(raw);
				return;
			}
			reject(error);
		});
		socket.on("end", () => {
			clearTimeout(timer);
			resolve(raw);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			if (!raw.length) {
				reject(new Error("socket closed without payload"));
				return;
			}
			resolve(raw);
		});
	});
}

function startOrphanSocketServer(path: string): Promise<import("node:child_process").ChildProcess> {
	const script = `
		const { createServer } = require("node:net");
		const socketPath = process.env.HS_SOCKET_PATH;
		if (!socketPath) {
			throw new Error("HS_SOCKET_PATH missing");
		}
		const server = createServer(() => {});
		server.listen(socketPath);
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", script], {
			env: {
				...process.env,
				HS_SOCKET_PATH: path,
			},
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.once("error", reject);
		child.once("spawn", () => resolve(child));
	});
}

test("host service status request returns service health details over unix socket", async () => {
	const baseDir = temporaryDir("host-service-status-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-test" });
	await server.start();

	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
	});

	try {
		const status = await client.requestStatus({ cwd: join(baseDir, "repo") });
		assert.equal(status.operation, "status");
		assert.equal(status.supported, true);
		assert.equal(status.service_available, true);
		assert.equal(status.service_name, "agent-synctex-test");
		assert.equal(status.socket_path, socketPath);
		assert.equal(status.workspace_context.cwd, join(baseDir, "repo"));
		assert.equal(socketMode(socketPath), 0o600);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}

	assert.equal(existsSync(socketPath), false, "socket file should be cleaned up on stop");
});

test("host service client surfaces malformed response payloads", async () => {
	const baseDir = temporaryDir("host-service-malformed-");
	const socketPath = join(baseDir, "host-service.sock");
	const malformedServer = createServer((socket) => {
		socket.end("not-json\n", () => {
			socket.destroy();
		});
	});

	await new Promise<void>((resolve, reject) => {
		malformedServer.once("error", reject);
		malformedServer.listen(socketPath, () => {
			resolve();
		});
	});

	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	try {
		await assert.rejects(() => client.requestStatus({ cwd: baseDir }), /Malformed host service response payload/);
	} finally {
		await new Promise<void>((resolve) => {
			malformedServer.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service rejects missing workspace context", async () => {
	const socketPath = join(temporaryDir("host-service-validate-"), "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-validate" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		await assert.rejects(() => client.requestStatus({ cwd: "" }), /invalid workspace_context/);
	} finally {
		await server.stop();
	}
});

test("host service does not delete regular file at socket path", async () => {
	const baseDir = temporaryDir("host-service-regular-");
	const socketPath = join(baseDir, "host-service.sock");
	writeFileSync(socketPath, "regular payload", { mode: 0o644 });
	const existing = readFileSync(socketPath, "utf8");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-regular" });
	await assert.rejects(() => server.start(), /unsupported file type|socket path has unsupported file type/);
	assert.equal(lstatSync(socketPath).isFile(), true, "regular file should remain a file");
	assert.equal(readFileSync(socketPath, "utf8"), existing, "regular file content should be unchanged");

	rmSync(baseDir, { recursive: true, force: true });
});

test("host service rejects symlinked socket directory", async () => {
	const baseDir = temporaryDir("host-service-symlink-");
	const targetDir = join(baseDir, "actual-socket-dir");
	const linkedDir = join(baseDir, "socket-dir-link");
	mkdirSync(targetDir, { mode: 0o700 });
	symlinkSync(targetDir, linkedDir);

	const socketPath = join(linkedDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-symlink" });
	await assert.rejects(() => server.start(), /symlink/);

	rmSync(baseDir, { recursive: true, force: true });
});

test("host service refuses to start over a live daemon socket", async () => {
	const baseDir = temporaryDir("host-service-live-");
	const socketPath = join(baseDir, "host-service.sock");
	const liveServer = await writeJsonServer(socketPath);
	try {
		const hostServer = new HostServiceServer({ socketPath, serviceName: "agent-synctex-live" });
		await assert.rejects(() => hostServer.start(), /already in use by a running service|already in use/);
		const observed = await readFromSocket(socketPath);
		assert.equal(observed, "ok");
	} finally {
		await new Promise<void>((resolve) => {
			liveServer.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service replaces stale socket on startup", async () => {
	const baseDir = temporaryDir("host-service-orphan-");
	const socketPath = join(baseDir, "host-service.sock");
	const child = await startOrphanSocketServer(socketPath);
	await waitForFile(socketPath);
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
	});
	await sleep(20);
	assert.equal(lstatSync(socketPath).isSocket(), true, "orphaned socket should remain until reclaimed");

	const hostServer = new HostServiceServer({ socketPath, serviceName: "agent-synctex-orphan" });
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	await hostServer.start();
	const status = await client.requestStatus({ cwd: baseDir });
	assert.equal(status.supported, true);
	assert.equal(status.service_name, "agent-synctex-orphan");
	await hostServer.stop();

	rmSync(baseDir, { recursive: true, force: true });
});
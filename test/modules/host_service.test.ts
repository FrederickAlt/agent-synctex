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

test("host service client surfaces server error envelopes as service errors", async () => {
	const baseDir = temporaryDir("host-service-error-envelope-");
	const socketPath = join(baseDir, "host-service.sock");
	const fixedRequestId = "fixed-request-id";
	const serverErrorResponse = JSON.stringify({
		protocol_version: 1,
		request_id: fixedRequestId,
		operation: "status",
		status: "error",
		generated_at_ns: Date.now() * 1_000_000,
		error: "invalid workspace_context; cwd is required",
		status_details: {
			protocol_version: 1,
			supported: false,
			service_available: false,
			service_name: "agent-synctex-test-error",
			socket_path: socketPath,
			service_instance_started_ns: Date.now() * 1_000_000,
			service_instance_id: "service-instance-id",
			workspace_context: { cwd: "/" },
			request_id: fixedRequestId,
			operation: "status",
			uptime_ns: 0,
			total_requests: 0,
			error_code: "invalid_workspace_context",
		},
	}) + "\n";
	const errorServer = createServer((socket) => {
		socket.end(serverErrorResponse, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		errorServer.once("error", reject);
		errorServer.listen(socketPath, () => {
			resolve();
		});
	});

	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => fixedRequestId,
	});
	let observed: unknown;
	try {
		await client.requestStatus({ cwd: baseDir });
	} catch (error) {
		observed = error;
	} finally {
		await new Promise<void>((resolve) => {
			errorServer.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}

	assert.ok(observed instanceof Error);
	assert.match(observed.message, /invalid workspace_context; cwd is required/);
	assert.match(observed.message, /code=invalid_workspace_context/);
	assert.doesNotMatch(observed.message, /Malformed host service response payload/);
});

test("host service client rejects malformed response with mismatched request ids", async () => {
	const baseDir = temporaryDir("host-service-mismatch-request-id-");
	const socketPath = join(baseDir, "host-service.sock");
	const expectedRequestId = "expected-request-id";
	const responseRequestId = "unexpected-request-id";
	const malformedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: responseRequestId,
		operation: "status",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			service_name: "agent-synctex-test-mismatch",
			socket_path: socketPath,
			service_instance_started_ns: Date.now() * 1_000_000,
			service_instance_id: "instance-id",
			workspace_context: { cwd: baseDir },
			request_id: responseRequestId,
			operation: "status",
			uptime_ns: 1,
			total_requests: 1,
		},
	}) + "\n";
	const malformedServer = createServer((socket) => {
		socket.end(malformedResponse, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		malformedServer.once("error", reject);
		malformedServer.listen(socketPath, () => {
			resolve();
		});
	});
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => expectedRequestId,
	});
	await assert.rejects(() => client.requestStatus({ cwd: baseDir }), /Malformed host service response payload/);
	await new Promise<void>((resolve) => {
		malformedServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service client rejects malformed response with non-status operation", async () => {
	const baseDir = temporaryDir("host-service-bad-operation-");
	const socketPath = join(baseDir, "host-service.sock");
	const expectedRequestId = "status-request-id";
	const malformedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "status_not_supported",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			service_name: "agent-synctex-test-bad-op",
			socket_path: socketPath,
			service_instance_started_ns: Date.now() * 1_000_000,
			service_instance_id: "instance-id",
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "status_not_supported",
			uptime_ns: 1,
			total_requests: 1,
		},
	}) + "\n";
	const badOperationServer = createServer((socket) => {
		socket.end(malformedResponse, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		badOperationServer.once("error", reject);
		badOperationServer.listen(socketPath, () => {
			resolve();
		});
	});
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => expectedRequestId,
	});
	await assert.rejects(() => client.requestStatus({ cwd: baseDir }), /Malformed host service response payload/);
	await new Promise<void>((resolve) => {
		badOperationServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service client rejects malformed response with mismatched status_details protocol version", async () => {
	const baseDir = temporaryDir("host-service-bad-details-version-");
	const socketPath = join(baseDir, "host-service.sock");
	const expectedRequestId = "details-version-request-id";
	const malformedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "status",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 0,
			supported: true,
			service_available: true,
			service_name: "agent-synctex-test-bad-version",
			socket_path: socketPath,
			service_instance_started_ns: Date.now() * 1_000_000,
			service_instance_id: "instance-id",
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "status",
			uptime_ns: 1,
			total_requests: 1,
		},
	}) + "\n";
	const badVersionServer = createServer((socket) => {
		socket.end(malformedResponse, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		badVersionServer.once("error", reject);
		badVersionServer.listen(socketPath, () => {
			resolve();
		});
	});
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => expectedRequestId,
	});
	await assert.rejects(() => client.requestStatus({ cwd: baseDir }), /Malformed host service response payload/);
	await new Promise<void>((resolve) => {
		badVersionServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
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
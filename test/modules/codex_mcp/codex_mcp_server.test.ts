import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { HOST_SERVICE_TOOL_NAMES, HostServiceMcpFrameReader } from "../../../src/modules/host_service_mcp.ts";
import { HOST_SERVICE_SOCKET_PATH_ENV_VAR } from "../../../src/modules/host_service.ts";
import { CodexMcpDaemonRelay } from "../../../src/modules/codex_mcp/codex_mcp_server.ts";

function encodeFrame(payload: string): string {
	return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

function parseFrames(raw: string): unknown[] {
	const buffer = Buffer.from(raw, "utf8");
	const frames: unknown[] = [];
	let cursor = 0;

	while (cursor < buffer.length) {
		const separator = buffer.indexOf("\r\n\r\n", cursor);
		if (separator < 0) {
			break;
		}
		const headerText = buffer.slice(cursor, separator).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(headerText);
		if (!match) {
			break;
		}
		const bodyLength = Number.parseInt(match[1], 10);
		const bodyStart = separator + 4;
		const body = buffer.slice(bodyStart, bodyStart + bodyLength);
		if (body.length < bodyLength) {
			break;
		}
		frames.push(JSON.parse(body.toString("utf8")));
		cursor = bodyStart + bodyLength;
	}

	return frames;
}

function parseLines(raw: string): unknown[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

type StreamDataSource = {
	on: (event: "data", handler: (chunk: string | Buffer) => void) => void;
	off: (event: "data", handler: (chunk: string | Buffer) => void) => void;
};

function collectFrames(stream: StreamDataSource, expectedFrames: number, timeoutMs = 1_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let raw = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("timed out waiting for response"));
		}, timeoutMs);
		timer.unref?.();

		const onData = (chunk: string | Buffer) => {
			raw += String(chunk);
			if (parseFrames(raw).length >= expectedFrames) {
				cleanup();
				resolve(raw);
			}
		};

		const cleanup = () => {
			clearTimeout(timer);
			stream.off("data", onData);
		};

		stream.on("data", onData);
	});
}

function collectLines(stream: StreamDataSource, expectedLines: number, timeoutMs = 1_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let raw = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("timed out waiting for response"));
		}, timeoutMs);
		timer.unref?.();

		const onData = (chunk: string | Buffer) => {
			raw += String(chunk);
			if (parseLines(raw).length >= expectedLines) {
				cleanup();
				resolve(raw);
			}
		};

		const cleanup = () => {
			clearTimeout(timer);
			stream.off("data", onData);
		};

		stream.on("data", onData);
	});
}

function startFakeDaemon(
	socketPath: string,
	handler: (request: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<{ server: ReturnType<typeof createServer>; close: () => Promise<void> }> {
	const server = createServer((connection) => {
		const parser = new HostServiceMcpFrameReader();
		connection.on("data", (chunk) => {
			parser.write(chunk);
			let frame = parser.nextFrame();
			while (frame) {
				if (frame.protocol !== "mcp") {
					connection.destroy();
					return;
				}
				const request = JSON.parse(frame.payload) as Record<string, unknown>;
				const responsePayload = handler(request);
				if (responsePayload !== undefined) {
					const response = encodeFrame(JSON.stringify(responsePayload));
					connection.end(response);
				}
				frame = parser.nextFrame();
			}
		});
	});

	return new Promise((resolve, reject) => {
		server.listen(socketPath, (error?: Error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve({
				server,
				close: () =>
					new Promise<void>((resolveClose) => {
						server.close(() => {
							resolveClose();
						});
					}),
			});
		});
	});
}

async function startRelayFixture(socketPath: string) {
	const relayInput = new PassThrough();
	const relayOutput = new PassThrough();
	const relay = new CodexMcpDaemonRelay({
		socketPath,
		stdin: relayInput,
		stdout: relayOutput,
		stderr: new PassThrough(),
	});
	relay.start();
	return {
		relay,
		relayInput,
		relayOutput,
		stop: () => relay.close(),
	};
}


test("Codex MCP relay forwards MCP frames with partial stdin chunks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "codex-mcp-relay-forward-"));
	const socketPath = join(baseDir, "host-service.sock");
	const daemon = await startFakeDaemon(socketPath, (request) => ({
		jsonrpc: "2.0",
		id: request.id,
		result: {
			method: request.method,
			observedParams: Object.prototype.hasOwnProperty.call(request, "params"),
		},
	}));
	const relay = await startRelayFixture(socketPath);

	try {
		const requestPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
		const framedRequest = encodeFrame(requestPayload);
		const output = collectFrames(relay.relayOutput, 1);
		relay.relayInput.write(framedRequest.slice(0, 7));
		relay.relayInput.write(framedRequest.slice(7));
		const raw = await output;
		const responses = parseFrames(raw);
		assert.equal(responses.length, 1);
		const response = responses[0] as { id: number; result: { method: string; observedParams: boolean } };
		assert.equal(response.id, 1);
		assert.equal(response.result.method, "ping");
		assert.equal(response.result.observedParams, true);
	} finally {
		relay.stop();
		await daemon.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Codex MCP relay handles partial response chunks from daemon", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "codex-mcp-relay-partial-response-"));
	const socketPath = join(baseDir, "host-service.sock");
	const fullResponse = encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
	const splitAt = Math.floor(fullResponse.length / 2);
	const daemon = await startFakeDaemon(socketPath, () => {
		// never used because we intentionally send partial data in this test.
		return { jsonrpc: "2.0", id: 0, result: {} };
	});
	// override by attaching a custom listener after server start to stream partial response
	daemon.server.removeAllListeners("connection");
	daemon.server.on("connection", (connection) => {
		const parser = new HostServiceMcpFrameReader();
		connection.on("data", (chunk) => {
			parser.write(chunk);
			const frame = parser.nextFrame();
			if (!frame || frame.protocol !== "mcp") {
				connection.destroy();
				return;
			}
			connection.write(fullResponse.slice(0, splitAt));
			setTimeout(() => {
				connection.write(fullResponse.slice(splitAt));
				connection.end();
			}, 10);
		});
	});

	const relay = await startRelayFixture(socketPath);
	try {
		const output = collectFrames(relay.relayOutput, 1);
		relay.relayInput.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })));
		const raw = await output;
		const parsed = parseFrames(raw) as Array<{ id: number; result: { tools: unknown[] } }>;
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0]!.id, 2);
		assert.deepEqual(parsed[0]!.result, { tools: [] });
	} finally {
		relay.stop();
		await daemon.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Codex MCP relay mirrors newline JSON-RPC framing from Codex", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "codex-mcp-relay-line-json-"));
	const socketPath = join(baseDir, "host-service.sock");
	const observedMethods: string[] = [];
	const daemon = await startFakeDaemon(socketPath, (request) => {
		if (typeof request.method === "string") {
			observedMethods.push(request.method);
		}
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "tex-actions", version: "0.1.0" },
			},
		};
	});
	const relay = await startRelayFixture(socketPath);

	try {
		const output = collectLines(relay.relayOutput, 1);
		relay.relayInput.write(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "initialize", params: {} })}\n`);
		const raw = await output;
		assert.doesNotMatch(raw, /Content-Length/i);
		const responses = parseLines(raw) as Array<{ id: number; result: { serverInfo: { name: string } } }>;
		assert.equal(responses.length, 1);
		assert.equal(responses[0]!.id, 11);
		assert.equal(responses[0]!.result.serverInfo.name, "tex-actions");
		assert.deepEqual(observedMethods, ["initialize"]);
	} finally {
		relay.stop();
		await daemon.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Codex MCP relay surfaces actionable daemon-unavailable errors", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "codex-mcp-relay-unavailable-"));
	const socketPath = join(baseDir, "missing-daemon.sock");
	const relayInput = new PassThrough();
	const relayOutput = new PassThrough();
	const relay = new CodexMcpDaemonRelay({ socketPath, stdin: relayInput, stdout: relayOutput, stderr: new PassThrough() });
	relay.start();

	try {
		const request = encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }));
		relayInput.write(request);
		const raw = await collectFrames(relayOutput, 1);
		const responses = parseFrames(raw);
		assert.equal(responses.length, 1);
		const response = responses[0] as { id: number; error: { message: string; code: number } };
		assert.equal(response.id, 3);
		assert.equal(response.error.code, -32603);
		assert.match(response.error.message, /TeX Actions daemon is unavailable/);
		assert.match(response.error.message, /pdf-preview-servicectl restart/);
		assert.match(response.error.message, /tex-actionsctl doctor/);
	} finally {
		relay.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Relay returns tools/list passthrough from daemon without desktop viewer", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "codex-mcp-relay-tools-list-"));
	const socketPath = join(baseDir, "host-service.sock");
	const expectedToolNames = [...HOST_SERVICE_TOOL_NAMES];
	const daemon = await startFakeDaemon(socketPath, (request) => {
		if (request.method === "tools/list") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					tools: expectedToolNames.map((name) => ({
						name,
						description: `daemon ${name}`,
						inputSchema: {},
					})),
				},
			};
		}
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: { tools: [] },
		};
	});
	const relay = await startRelayFixture(socketPath);

	try {
		const output = collectFrames(relay.relayOutput, 1);
		relay.relayInput.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })));
		const raw = await output;
		const responses = parseFrames(raw) as Array<{ id: number; result: { tools: Array<{ name: string }> } }>;
		assert.equal(responses.length, 1);
		assert.equal(responses[0]!.id, 4);
		const names = responses[0]!.result.tools.map((tool) => tool.name);
		assert.deepEqual(names, expectedToolNames);
	} finally {
		await daemon.close();
		relay.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Relay reads socket path override from TEX_ACTIONS_HOST_SERVICE_SOCKET_PATH", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "codex-mcp-relay-socket-override-"));
	const socketPath = join(baseDir, "host-service.sock");
	const overrideKey = HOST_SERVICE_SOCKET_PATH_ENV_VAR;
	const previousOverride = process.env[overrideKey];

	const daemon = await startFakeDaemon(socketPath, (request) => ({
		jsonrpc: "2.0",
		id: request.id,
		result: {
			method: request.method,
		},
	}));
	const relayInput = new PassThrough();
	const relayOutput = new PassThrough();

	let relay: CodexMcpDaemonRelay | undefined;
	try {
		process.env[overrideKey] = socketPath;
		relay = new CodexMcpDaemonRelay({ stdin: relayInput, stdout: relayOutput, stderr: new PassThrough() });
		relay.start();

		const output = collectFrames(relayOutput, 1);
		relayInput.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping", params: {} })));
		const raw = await output;
		const responses = parseFrames(raw) as Array<{ id: number; result: { method: string } }>;
		assert.equal(responses.length, 1);
		assert.equal(responses[0]!.id, 10);
		assert.equal(responses[0]!.result.method, "ping");
	} finally {
		if (relay) {
			relay.close();
		}
		if (previousOverride === undefined) {
			delete process.env[overrideKey];
		} else {
			process.env[overrideKey] = previousOverride;
		}
		await daemon.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Relay supports initialize + notification + tools/call passthrough flow", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "codex-mcp-relay-flow-"));
	const socketPath = join(baseDir, "host-service.sock");
	const observedMethods: string[] = [];
	const daemon = await startFakeDaemon(socketPath, (request) => {
		if (typeof request.method === "string") {
			observedMethods.push(request.method);
		}
		if (!Object.prototype.hasOwnProperty.call(request, "id")) {
			return undefined;
		}
		if (request.method === "initialize") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: "2025-03-26",
					serverInfo: { name: "tex-actions", version: "0.1.0", displayName: "TeX Actions" },
				},
			};
		}
		if (request.method === "tools/call") {
			const params = (request as { params?: { name?: unknown; arguments?: unknown } }).params;
			const name = (params as { name?: unknown })?.name;
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					call: name,
				},
			};
		}
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: { method: request.method },
		};
	});
	const relayInput = new PassThrough();
	const relayOutput = new PassThrough();
	const relay = new CodexMcpDaemonRelay({ socketPath, stdin: relayInput, stdout: relayOutput, stderr: new PassThrough() });
	relay.start();

	try {
		const initializeFrame = encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 20, method: "initialize", params: {} }));
		const initializedFrame = encodeFrame(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const toolsCallFrame = encodeFrame(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 21,
				method: "tools/call",
				params: {
					name: "set_latex_preamble",
					arguments: { latex_preamble: "\\usepackage{amssymb}" },
				},
			}),
		);
		const output = collectFrames(relayOutput, 2);
		relayInput.write(initializeFrame + initializedFrame + toolsCallFrame);

		const raw = await output;
		const responses = parseFrames(raw) as Array<{ id: number; result: { protocolVersion?: string; call?: unknown } }>;
		assert.equal(responses.length, 2);
		assert.equal(responses[0]!.id, 20);
		assert.equal(responses[0]!.result.protocolVersion, "2025-03-26");
		assert.equal(responses[1]!.id, 21);
		assert.equal(responses[1]!.result.call, "set_latex_preamble");
		assert.deepEqual(observedMethods, ["initialize", "notifications/initialized", "tools/call"]);
	} finally {
		relay.close();
		await daemon.close();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Codex MCP direct entrypoint exists and stays stdout-clean on startup", async () => {
	const relayScriptPath = resolve(process.cwd(), "scripts", "tex-actions-mcp.ts");
	const child = spawn(process.execPath, [relayScriptPath], {
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let exited = false;
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	const exitPromise = new Promise<void>((resolve) => {
		child.once("exit", () => {
			exited = true;
			resolve();
		});
		child.once("error", () => {
			exited = true;
			resolve();
		});
	});

	try {
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(stdout, "");
		child.kill("SIGTERM");
		await Promise.race([
			exitPromise,
			new Promise((resolve) => setTimeout(resolve, 200)),
		]);
		if (!exited) {
			child.kill("SIGKILL");
			await exitPromise;
		}
	} finally {
		if (!exited) {
			child.kill("SIGKILL");
			await exitPromise;
		}
	}
});

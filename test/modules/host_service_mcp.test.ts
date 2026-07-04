import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getLatexPreamblePath, getMcpFixedPreviewPdfPath } from "../../src/modules/runtime_paths.ts";
import { FakeViewerBackend, HostServiceServer } from "../../src/modules/host_service.ts";
import { HostServiceMcpFrameReader } from "../../src/modules/host_service_mcp.ts";

function allocateMcpTmpDir(prefix = "host-service-mcp-runtime-") {
	const previous = process.env.MCP_TMPDIR;
	const dir = mkdtempSync(join(tmpdir(), prefix));
	process.env.MCP_TMPDIR = dir;
	return {
		dir,
		restore() {
			if (previous === undefined) {
				delete process.env.MCP_TMPDIR;
				return;
			}
			process.env.MCP_TMPDIR = previous;
		},
	};
}

function writeFakeLatexCompiler(binDir: string, options: { logContents?: string } = {}): void {
	const compilerPath = join(binDir, "latexmk");
	const logContents = options.logContents ?? "fake compiler output\n";
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	writeFileSync(
		compilerPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const texFile = process.argv[process.argv.length - 1] || "";
if (!texFile) process.exit(1);
const base = path.basename(texFile);
const name = base.replace(/\\.tex$/, "");
const outDir = path.dirname(texFile);
fs.writeFileSync(path.join(outDir, name + ".log"), ${JSON.stringify(logContents)});
fs.writeFileSync(path.join(outDir, name + ".pdf"), "%PDF-1.4\\n");
fs.writeFileSync(path.join(outDir, name + ".aux"), "");
process.exit(0);
`,
		{ mode: 0o700 },
	);
	chmodSync(compilerPath, 0o700);
}

function encodeMcpFrame(jsonText: string): string {
	return `Content-Length: ${Buffer.byteLength(jsonText, "utf8")}\r\n\r\n${jsonText}`;
}

async function withPathOverride(value: string | undefined, run: () => Promise<unknown>): Promise<unknown> {
	const previous = process.env.PATH;
	const nextValue = value ?? process.execPath;
	process.env.PATH = nextValue;
	try {
		return await run();
	} finally {
		if (previous === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = previous;
		}
	}
}

class TestManagedViewerBackend extends FakeViewerBackend {
	openHandles = new Set<string>();
	openRequests: Array<{ requestId: string; details: Record<string, unknown> }> = [];
	closeRequests: Array<{ requestId: string; details: Record<string, unknown> }> = [];
	forwardSearchRequests: Array<{ requestId: string; details: Record<string, unknown> }> = [];

	async open(requestId: string, details: Record<string, unknown>) {
		this.openRequests.push({ requestId, details: { ...details } });
		const result = await super.open(requestId, details);
		if (result.status === "ok") {
			const handle = (result.status_details as Record<string, unknown>).handle;
			if (typeof handle === "string") {
				this.openHandles.add(handle);
			}
		}
		return result;
	}
	async close(requestId: string, details: Record<string, unknown>) {
		this.closeRequests.push({ requestId, details: { ...details } });
		const handle = details.handle;
		if (typeof handle === "string") {
			this.openHandles.delete(handle);
		}
		return super.close(requestId, details);
	}
	async forwardSearch(requestId: string, details: Record<string, unknown>) {
		this.forwardSearchRequests.push({ requestId, details: { ...details } });
		const handle = details.handle;
		if (typeof handle === "string" && this.openHandles.has(handle)) {
			return {
				status: "ok" as const,
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: this.name,
					backend_identity_ok: true,
					handle,
					handled: true,
				},
			};
		}
		return super.forwardSearch(requestId, details);
	}
}

class FailingManagedViewerBackend extends TestManagedViewerBackend {
	readonly behavior: { open?: boolean; forwardSearch?: boolean; close?: boolean };
	constructor(behavior: { open?: boolean; forwardSearch?: boolean; close?: boolean } = {}) {
		super();
		this.behavior = behavior;
	}

	async open(requestId: string, details: Record<string, unknown>) {
		if (this.behavior.open) {
			return {
				status: "error" as const,
				error: "backend unavailable",
				status_details: {
					protocol_version: 1,
					supported: false,
					service_available: false,
					backend: this.name,
					backend_identity_ok: false,
					error_code: "backend_unavailable",
					handled: false,
				},
			};
		}
		return super.open(requestId, details);
	}

	async forwardSearch(requestId: string, details: Record<string, unknown>) {
		if (this.behavior.forwardSearch) {
			return {
				status: "error" as const,
				error: "forward search unavailable",
				status_details: {
					protocol_version: 1,
					supported: false,
					service_available: false,
					backend: this.name,
					backend_identity_ok: false,
					handled: false,
					reason: "backend unavailable",
					error_code: "backend_unavailable",
					handle: details.handle,
				},
			};
		}
		return super.forwardSearch(requestId, details);
	}

	async close(requestId: string, details: Record<string, unknown>) {
		if (this.behavior.close) {
			return {
				status: "error" as const,
				error: "close unavailable",
				status_details: {
					protocol_version: 1,
					supported: false,
					service_available: false,
					backend: this.name,
					backend_identity_ok: false,
					closed: false,
					reason: "backend unavailable",
					error_code: "backend_unavailable",
					handle: details.handle,
				},
			};
		}
		return super.close(requestId, details);
	}
}

function parseMcpFrame(raw: string): unknown {
	const frames = parseMcpFrames(raw);
	assert.equal(frames.length, 1);
	return frames[0];
}

function parseMcpFrames(raw: string): unknown[] {
	const frames: unknown[] = [];
	const buffer = Buffer.from(raw, "utf8");
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

async function sendRawMcpPayload(
	socketPath: string,
	rawPayload: string,
	chunked = false,
	expectedFrames = 1,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path: socketPath });
		let raw = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("mcp socket timed out"));
		}, 1_000);
		timer.unref?.();

		const resolveIfDone = () => {
			if (parseMcpFrames(raw).length < expectedFrames) {
				return;
			}
			clearTimeout(timer);
			socket.destroy();
			resolve(raw);
		};

		socket.on("connect", () => {
			if (!chunked) {
				socket.write(rawPayload);
				return;
			}
			const splitAt = Math.max(1, Math.min(rawPayload.length - 1, Math.floor(rawPayload.length / 2)));
			const chunkA = rawPayload.slice(0, splitAt);
			const chunkB = rawPayload.slice(splitAt);
			socket.write(chunkA);
			setTimeout(() => {
				socket.write(chunkB);
			}, 10);
		});
		socket.on("data", (chunk) => {
			raw += String(chunk);
			resolveIfDone();
		});
		socket.on("error", (error) => {
			if (raw.length > 0) {
				clearTimeout(timer);
				resolve(raw);
				return;
			}
			reject(error);
		});
		socket.on("end", () => {
			if (parseMcpFrames(raw).length >= expectedFrames) {
				clearTimeout(timer);
				resolve(raw);
				return;
			}
			clearTimeout(timer);
			if (!raw.length) {
				reject(new Error("empty response"));
				return;
			}
			reject(new Error("incomplete mcp frame"));
		});
	});
}

async function sendFramedRequest(socketPath: string, payload: string, chunked = false): Promise<unknown> {
	const raw = await sendRawMcpPayload(socketPath, encodeMcpFrame(payload), chunked, 1);
	return parseMcpFrame(raw);
}

async function sendFramedRequests(socketPath: string, payloads: string[], expectedResponses: number): Promise<unknown[]> {
	const rawPayload = payloads.map(encodeMcpFrame).join("");
	const raw = await sendRawMcpPayload(socketPath, rawPayload, false, expectedResponses);
	return parseMcpFrames(raw);
}

const HOST_TOOL_NAMES = [
	"show_latex",
	"compile_latex_file",
	"open_pdf",
	"jump_pdf",
	"set_latex_preamble",
	"fetch_pdf_context",
];


test("MCP frame parser handles partial host-service JSON frames", () => {
	const parser = new HostServiceMcpFrameReader();
	parser.write('{"jsonrpc":"2.0","id":1,');
	assert.equal(parser.nextFrame(), null);
	parser.write('"method":"ping"}\n');
	const frame = parser.nextFrame();
	assert.equal(frame?.protocol, "host-service");
	assert.equal(frame?.payload, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
});

test("MCP frame parser handles partial Content-Length framed requests", () => {
	const payload = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
	const frame = encodeMcpFrame(payload);
	const parser = new HostServiceMcpFrameReader();
	parser.write(frame.slice(0, 15));
	assert.equal(parser.nextFrame(), null);
	parser.write(frame.slice(15));
	const parsed = parser.nextFrame();
	assert.equal(parsed?.protocol, "mcp");
	assert.equal(parsed?.payload, payload);
});

test("MCP frame parser rejects malformed Content-Length values", () => {
	const parser = new HostServiceMcpFrameReader();
	parser.write("Content-Length: 12garbage\r\n\r\n{}");
	assert.throws(() => {
		parser.nextFrame();
	}, /Malformed MCP Content-Length header/);
});

test("MCP frame parser supports multiple UTF-8 bytes with frame boundaries", () => {
	const parser = new HostServiceMcpFrameReader();
	const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", note: "é" });
	const frame = encodeMcpFrame(payload);
	const bytes = Buffer.from(frame, "utf8");
	parser.write(bytes.slice(0, bytes.length - 1));
	assert.equal(parser.nextFrame(), null);
	parser.write(bytes.slice(bytes.length - 1));
	const parsed = parser.nextFrame();
	assert.equal(parsed?.protocol, "mcp");
	assert.equal(parsed?.payload, payload);
});

test("daemon serves MCP initialize, ping, tools/list, and set_latex_preamble", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-runtime-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const initializePayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		const initializeResponse = (await sendFramedRequest(socketPath, initializePayload)) as { jsonrpc: string; id: number; result: { serverInfo: { name: string; displayName: string }; capabilities: { tools: { listChanged: boolean } } } };
		assert.equal(initializeResponse.jsonrpc, "2.0");
		assert.equal(initializeResponse.result.serverInfo.name, "tex-actions");
		assert.equal(initializeResponse.result.serverInfo.displayName, "TeX Actions");
		assert.equal(initializeResponse.result.capabilities.tools.listChanged, false);

		const pingPayload = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
		const pingResponse = (await sendFramedRequest(socketPath, pingPayload, true)) as { jsonrpc: "2.0"; id: 2; result: Record<string, unknown> };
		assert.equal(pingResponse.id, 2);
		assert.deepEqual(pingResponse.result, {});

		const toolsListPayload = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" });
		const toolsListResponse = (await sendFramedRequest(socketPath, toolsListPayload)) as {
			jsonrpc: "2.0";
			id: 3;
			result: {
				tools: Array<{
					name: string;
					description?: string;
					inputSchema: {
						properties: Record<string, { type?: string; description?: string }>;
						additionalProperties?: boolean;
					};
				}>;
			};
		};
		const names = toolsListResponse.result.tools.map((tool) => tool.name);
		assert.deepEqual(names, HOST_TOOL_NAMES);

		const byName = new Map(toolsListResponse.result.tools.map((tool) => [tool.name, tool]));
		const showLatexTool = byName.get("show_latex");
		const compileFileTool = byName.get("compile_latex_file");
		const openPdfTool = byName.get("open_pdf");
		const jumpPdfTool = byName.get("jump_pdf");
		const setPreambleTool = byName.get("set_latex_preamble");
		assert.ok(showLatexTool);
		assert.ok(compileFileTool);
		assert.ok(openPdfTool);
		assert.ok(jumpPdfTool);
		assert.equal(byName.has("close_pdf"), false);
		assert.ok(setPreambleTool);
		assert.equal(typeof showLatexTool.inputSchema.properties.workspace_context, "object");
		assert.equal(typeof compileFileTool.inputSchema.properties.workspace_context, "object");
		assert.equal(typeof openPdfTool.inputSchema.properties.workspace_context, "object");
		assert.equal(typeof setPreambleTool.inputSchema.properties.workspace_context, "object");
		assert.equal(typeof jumpPdfTool.inputSchema.properties.workspace_context, "object");
		assert.equal(openPdfTool.inputSchema.additionalProperties, false);
		assert.equal(jumpPdfTool.inputSchema.properties.pdf_id?.type, "integer");
		assert.equal(jumpPdfTool.inputSchema.properties.line?.type, "integer");
		assert.equal(jumpPdfTool.inputSchema.additionalProperties, false);
		assert.equal(compileFileTool.inputSchema.properties.callback_target_id, undefined);
		assert.equal(compileFileTool.inputSchema.properties.callback, undefined);
		assert.equal(openPdfTool.inputSchema.properties.callback, undefined);
		assert.ok(compileFileTool.inputSchema.properties.reuse_existing);
		assert.ok(compileFileTool.inputSchema.properties.require_persistent_viewer);
		assert.equal(compileFileTool.inputSchema.properties.continuous, undefined);
		assert.equal(compileFileTool.inputSchema.properties.hide_warnings?.type, "boolean");
		assert.doesNotMatch(compileFileTool.description ?? "", /continuous/);
		assert.match(compileFileTool.description ?? "", /hide_warnings=false/);
		assert.match(compileFileTool.description ?? "", /hidden by default/i);
		assert.match(compileFileTool.description ?? "", /same-root/i);
		assert.match(compileFileTool.description ?? "", /clean=true/);
		assert.match(compileFileTool.inputSchema.properties.hide_warnings?.description ?? "", /default/i);
		assert.match(compileFileTool.inputSchema.properties.hide_warnings?.description ?? "", /hide_warnings=false/);
		assert.deepEqual(Object.keys(showLatexTool.inputSchema.properties).sort(), ["compiler", "source", "workspace_context"]);
		assert.equal(showLatexTool.inputSchema.properties.inline, undefined);
		assert.equal(showLatexTool.inputSchema.properties.fixed_preview_pdf_path, undefined);
		assert.equal(showLatexTool.inputSchema.properties.fixed_preview, undefined);
		assert.equal(showLatexTool.inputSchema.properties.reuse_existing, undefined);
		assert.equal(showLatexTool.inputSchema.properties.require_persistent_viewer, undefined);
		assert.equal(showLatexTool.inputSchema.properties.callback, undefined);
		const setPreamblePayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "set_latex_preamble",
				arguments: {
					latex_preamble: "é",
				},
			},
		});
		const setPreambleResponse = (await sendFramedRequest(socketPath, setPreamblePayload)) as { id: 4; result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(setPreambleResponse.id, 4);
		assert.equal(setPreambleResponse.result.isError, undefined);
		assert.match(setPreambleResponse.result.content[0].text, /LaTeX preamble set/);
		const written = readFileSync(getLatexPreamblePath(), "utf8");
		assert.equal(written, "é\n");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon handles multiple MCP frames on one socket and ignores notifications", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-multi-runtime-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-multi-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const responses = await sendFramedRequests(
			socketPath,
			[
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
				JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
				JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			],
			2,
		);
		assert.equal(responses.length, 2);
		assert.equal((responses[0] as { id: number }).id, 1);
		assert.equal((responses[1] as { id: number }).id, 2);
		const names = ((responses[1] as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name);
		assert.deepEqual(names, HOST_TOOL_NAMES);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon set_latex_preamble writes workspace preamble when workspace_context is provided", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-agent-preamble-runtime-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-agent-preamble-"));
	const socketPath = join(baseDir, "host-service.sock");
	const tmpAgentDir = join(runtime.dir, "agents", "agent-A");
	mkdirSync(tmpAgentDir, { recursive: true });
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const agentPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 41,
			method: "tools/call",
			params: {
				name: "set_latex_preamble",
				arguments: {
					latex_preamble: "\\usepackage{array}",
					workspace_context: {
						cwd: baseDir,
						session_id: "agent-A",
						workspace_root: tmpAgentDir,
					},
				},
			},
		});
		const agentResponse = (await sendFramedRequest(socketPath, agentPayload)) as { id: 41; result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(agentResponse.result.isError, undefined);
		assert.equal(readFileSync(join(tmpAgentDir, "preamble.tex"), "utf8"), "\\usepackage{array}\n");

		const outsideRuntimePayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 43,
			method: "tools/call",
			params: {
				name: "set_latex_preamble",
				arguments: {
					latex_preamble: "bad",
					workspace_context: {
						cwd: baseDir,
						session_id: "agent-A",
						workspace_root: join(baseDir, "outside-runtime"),
					},
				},
			},
		});
		const outsideRuntimeResponse = (await sendFramedRequest(socketPath, outsideRuntimePayload)) as { id: 43; error: { code: number; message: string } };
		assert.equal(outsideRuntimeResponse.error.code, -32602);
		assert.match(outsideRuntimeResponse.error.message, /workspace_root must match the agent runtime directory/);

		const missingWorkspaceRootPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 44,
			method: "tools/call",
			params: {
				name: "set_latex_preamble",
				arguments: {
					latex_preamble: "bad",
					workspace_context: {
						cwd: baseDir,
						session_id: "agent-A",
					},
				},
			},
		});
		const missingWorkspaceRootResponse = (await sendFramedRequest(socketPath, missingWorkspaceRootPayload)) as { id: 44; error: { code: number; message: string } };
		assert.equal(missingWorkspaceRootResponse.error.code, -32602);
		assert.match(missingWorkspaceRootResponse.error.message, /requires workspace_root/);

		const symlinkTarget = join(baseDir, "symlink-target");
		mkdirSync(symlinkTarget, { recursive: true });
		const symlinkAgentDir = join(runtime.dir, "agents", "agent-symlink");
		symlinkSync(symlinkTarget, symlinkAgentDir, "dir");
		const symlinkPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 45,
			method: "tools/call",
			params: {
				name: "set_latex_preamble",
				arguments: {
					latex_preamble: "bad",
					workspace_context: {
						cwd: baseDir,
						session_id: "agent-symlink",
						workspace_root: symlinkAgentDir,
					},
				},
			},
		});
		const symlinkResponse = (await sendFramedRequest(socketPath, symlinkPayload)) as { id: 45; result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(symlinkResponse.result.isError, true);
		assert.match(symlinkResponse.result.content[0].text, /runtime directory is a symlink/);

		const legacyPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 42,
			method: "tools/call",
			params: {
				name: "set_latex_preamble",
				arguments: {
					latex_preamble: "legacy",
				},
			},
		});
		const legacyResponse = (await sendFramedRequest(socketPath, legacyPayload)) as { id: 42; result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(legacyResponse.result.isError, undefined);
		assert.equal(readFileSync(getLatexPreamblePath(), "utf8"), "legacy\n");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon rejects invalid set_latex_preamble arguments", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-invalid-preamble-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-invalid-preamble-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: {
				name: "set_latex_preamble",
				arguments: {},
			},
		});
		const response = (await sendFramedRequest(socketPath, payload)) as { error: { code: number; message: string } };
		assert.equal(response.error.code, -32602);
		assert.equal(response.error.message, "set_latex_preamble requires exactly one of latex_preamble or root_file");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon rejects removed compile_latex_file continuous arguments", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-continuous-missing-session-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-continuous-missing-session-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			id: 75,
			method: "tools/call",
			params: {
				name: "compile_latex_file",
				arguments: {
					latex_file_path: "paper.tex",
					continuous: true,
					workspace_context: { cwd: baseDir },
				},
			},
		});
		const response = (await sendFramedRequest(socketPath, payload)) as { error: { code: number; message: string } };
		assert.equal(response.error.code, -32602);
		assert.match(response.error.message, /unknown argument: continuous/);

		const malformedPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 76,
			method: "tools/call",
			params: {
				name: "compile_latex_file",
				arguments: {
					latex_file_path: "paper.tex",
					continuous: "true",
					workspace_context: { cwd: baseDir, session_id: "session-A" },
				},
			},
		});
		const malformedResponse = (await sendFramedRequest(socketPath, malformedPayload)) as { error: { code: number; message: string } };
		assert.equal(malformedResponse.error.code, -32602);
		assert.match(malformedResponse.error.message, /unknown argument: continuous/);

		const malformedHideWarningsPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 77,
			method: "tools/call",
			params: {
				name: "compile_latex_file",
				arguments: {
					latex_file_path: "paper.tex",
					hide_warnings: "false",
					workspace_context: { cwd: baseDir },
				},
			},
		});
		const malformedHideWarningsResponse = (await sendFramedRequest(socketPath, malformedHideWarningsPayload)) as { error: { code: number; message: string } };
		assert.equal(malformedHideWarningsResponse.error.code, -32602);
		assert.equal(malformedHideWarningsResponse.error.message, "hide_warnings must be a boolean");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon validates open_pdf/jump_pdf argument schemas and rejects removed close_pdf", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-open-jump-close-schema-args-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-open-jump-close-schema-args-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(workspaceDir, "paper.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const openUnknownResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 101,
			method: "tools/call",
			params: {
				name: "open_pdf",
				arguments: {
					pdf_file_path: "paper.pdf",
					extra: "reject",
					workspace_context: { cwd: workspaceDir },
				},
			},
		}))) as { error: { code: number; message: string } };
		assert.equal(openUnknownResponse.error.code, -32602);
		assert.equal(openUnknownResponse.error.message, "open_pdf unknown argument: extra");

		const openAliasResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 102,
			method: "tools/call",
			params: {
				name: "open_pdf",
				arguments: {
					pdf_path: "paper.pdf",
					workspace_context: { cwd: workspaceDir },
				},
			},
		}))) as { error: { code: number; message: string } };
		assert.equal(openAliasResponse.error.code, -32602);
		assert.equal(openAliasResponse.error.message, "open_pdf unknown argument: pdf_path");

		const openResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 103,
			method: "tools/call",
			params: {
				name: "open_pdf",
				arguments: {
					pdf_file_path: "paper.pdf",
					workspace_context: { cwd: workspaceDir },
				},
			},
		}))) as { result?: { details?: { pdf_id?: number } } };
		const pdfId = openResponse.result?.details?.pdf_id;
		assert.equal(typeof pdfId, "number");

		const jumpUnknownResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 103,
			method: "tools/call",
			params: {
				name: "jump_pdf",
				arguments: {
					pdf_id: pdfId,
					line: 1,
					extra: true,
				},
			},
		}))) as { error: { code: number; message: string } };
		assert.equal(jumpUnknownResponse.error.code, -32602);
		assert.equal(jumpUnknownResponse.error.message, "jump_pdf unknown argument: extra");

		const jumpFractionalLineResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 104,
			method: "tools/call",
			params: {
				name: "jump_pdf",
				arguments: {
					pdf_id: pdfId,
					line: 1.5,
				},
			},
		}))) as { error: { code: number; message: string } };
		assert.equal(jumpFractionalLineResponse.error.code, -32602);
		assert.equal(jumpFractionalLineResponse.error.message, "line must be a positive integer");

		const closeUnsupportedResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 105,
			method: "tools/call",
			params: {
				name: "close_pdf",
				arguments: {
					pdf_id: pdfId,
					extra: true,
				},
			},
		}))) as { result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(closeUnsupportedResponse.result.isError, true);
		assert.match(closeUnsupportedResponse.result.content[0].text, /Tool not implemented by runtime: close_pdf/);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon returns MCP-style tool errors for unimplemented tools", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-tool-error-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-tool-error-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: {
				name: "does_not_exist",
			},
		});
		const response = await sendFramedRequest(socketPath, payload);
		assert.equal((response as { result: { isError?: boolean } }).result.isError, true);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon resolves relative open_pdf and jump_pdf paths against workspace_context.cwd", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-open-jump-relative-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-open-jump-relative-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const pdfPath = join(workspaceDir, "paper.pdf");
	const sourcePath = join(workspaceDir, "paper.tex");
	const socketPath = join(baseDir, "host-service.sock");
	writeFileSync(pdfPath, "%PDF-1.7\n%");
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
	const backend = new TestManagedViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	try {
		const openResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: {
				name: "open_pdf",
				arguments: {
					pdf_file_path: "paper.pdf",
					workspace_context: {
						cwd: workspaceDir,
					},
				},
			},
		}))) as {
			result: {
				isError?: boolean;
				content: Array<{ text: string }>;
				details: {
					pdf_id?: number;
					managed_record?: { pdfPath?: string; id?: number; handle?: string };
				};
			};
		};
		assert.equal(openResponse.result.isError, undefined);
		assert.equal(openResponse.result.details.managed_record?.pdfPath, pdfPath);
		const lastOpen = backend.openRequests.at(-1);
		assert.ok(lastOpen !== undefined);
		assert.equal(typeof lastOpen?.details.pdf_path, "string");
		assert.equal(lastOpen?.details.pdf_path, pdfPath);

		const pdfId = openResponse.result.details.pdf_id;
		assert.equal(typeof pdfId, "number");
		const jumpResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 12,
			method: "tools/call",
			params: {
				name: "jump_pdf",
				arguments: {
					pdf_id: pdfId,
					line: 3,
					source_file: "paper.tex",
					workspace_context: {
						cwd: workspaceDir,
					},
				},
			},
		}))) as {
			result: {
				isError?: boolean;
				details: {
					source_file?: string;
					handled?: boolean;
					error_code?: string;
				};
			};
		};
		assert.equal(jumpResponse.result.isError, undefined);
		assert.equal(jumpResponse.result.details.handled, true);
		const lastJump = backend.forwardSearchRequests.at(-1);
		assert.ok(lastJump !== undefined);
		assert.equal(lastJump?.details.source_file, sourcePath);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon supports MCP managed open/jump without public close deleting MCP state", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-managed-open-jump-close-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-managed-open-jump-close-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const pdfPath = join(workspaceDir, "paper.pdf");
	const sourcePath = join(workspaceDir, "paper.tex");
	const socketPath = join(baseDir, "host-service.sock");
	writeFileSync(pdfPath, "%PDF-1.7\n%");
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: new TestManagedViewerBackend(),
	});
	await server.start();
	const openPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 11,
		method: "tools/call",
		params: {
			name: "open_pdf",
			arguments: {
				pdf_file_path: pdfPath,
			},
		},
	});
	try {
		const openResponse = (await sendFramedRequest(socketPath, openPayload)) as {
			result: { isError?: boolean; content: Array<{ text: string }>; details: { pdf_id?: number } };
		};
		assert.equal(openResponse.result.isError, undefined);
		assert.equal(openResponse.result.content[0].text.startsWith("open_pdf ok:"), true);
		const pdfId = openResponse.result.details.pdf_id;
		assert.equal(typeof pdfId, "number");

		const jumpPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 12,
			method: "tools/call",
			params: {
				name: "jump_pdf",
				arguments: {
					pdf_id: pdfId,
					line: 2,
					source_file: sourcePath,
				},
			},
		});
		const jumpResponse = (await sendFramedRequest(socketPath, jumpPayload)) as {
			result: { isError?: boolean; details: { handled?: boolean; reopened?: boolean } };
		};
		assert.equal(jumpResponse.result.isError, undefined);
		assert.equal(jumpResponse.result.details.handled, true);

		const closePayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 13,
			method: "tools/call",
			params: {
				name: "close_pdf",
				arguments: {
					pdf_id: pdfId,
				},
			},
		});
		const closeResponse = (await sendFramedRequest(socketPath, closePayload)) as {
			result: { isError?: boolean; content: Array<{ text: string }> };
		};
		assert.equal(closeResponse.result.isError, true);
		assert.match(closeResponse.result.content[0].text, /Tool not implemented by runtime: close_pdf/);

		const reopenedJumpPayload = JSON.stringify({
			jsonrpc: "2.0",
			id: 14,
			method: "tools/call",
			params: {
				name: "jump_pdf",
				arguments: {
					pdf_id: pdfId,
					line: 3,
					source_file: sourcePath,
				},
			},
		});
		const reopenedJumpResponse = (await sendFramedRequest(socketPath, reopenedJumpPayload)) as {
			result: { isError?: boolean; details: { handled?: boolean; reopened?: boolean; pdf_id?: number } };
		};
		assert.equal(reopenedJumpResponse.result.isError, undefined);
		assert.equal(reopenedJumpResponse.result.details.pdf_id, pdfId);
		assert.equal(reopenedJumpResponse.result.details.handled, true);
		assert.equal(reopenedJumpResponse.result.details.reopened, false);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon reuses managed PDF ID for repeated no-callback open of the same PDF", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-managed-open-reuse-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-managed-open-reuse-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const pdfPath = join(workspaceDir, "paper.pdf");
	const socketPath = join(baseDir, "host-service.sock");
	writeFileSync(pdfPath, "%PDF-1.7\n%");
	const backend = new TestManagedViewerBackend();
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
	});
	await server.start();
	const openOncePayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 20,
		method: "tools/call",
		params: {
			name: "open_pdf",
			arguments: {
				pdf_file_path: pdfPath,
			},
		},
	});
	const openTwicePayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 21,
		method: "tools/call",
		params: {
			name: "open_pdf",
			arguments: {
				pdf_file_path: pdfPath,
			},
		},
	});
	try {
		const openOnce = (await sendFramedRequest(socketPath, openOncePayload)) as {
			result: { isError?: boolean; details: { pdf_id?: number; managed_record?: { id?: number; handle?: string } } };
		};
		const openTwice = (await sendFramedRequest(socketPath, openTwicePayload)) as {
			result: { isError?: boolean; details: { pdf_id?: number; managed_record?: { id?: number; handle?: string } } };
		};
		assert.equal(openOnce.result.isError, undefined);
		assert.equal(openTwice.result.isError, undefined);
		assert.equal(openOnce.result.details.pdf_id, openTwice.result.details.pdf_id);
		assert.equal(openOnce.result.details.managed_record?.id, openTwice.result.details.managed_record?.id);
		assert.equal(openOnce.result.details.managed_record?.handle, openTwice.result.details.managed_record?.handle);
		assert.equal(backend.openRequests.length, 2);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon rejects removed MCP callback arguments", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-open-callback-rejected-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-open-callback-rejected-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const pdfPath = join(workspaceDir, "paper.pdf");
	const socketPath = join(baseDir, "host-service.sock");
	writeFileSync(pdfPath, "%PDF-1.7\n%");
	const server = new HostServiceServer({ socketPath, viewerBackend: new TestManagedViewerBackend() });
	await server.start();
	try {
		const openResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 31,
			method: "tools/call",
			params: {
				name: "open_pdf",
				arguments: {
					pdf_file_path: pdfPath,
					callback: { kind: "legacy" },
				},
			},
		}))) as { error: { code: number; message: string } };
		assert.equal(openResponse.error.code, -32602);
		assert.equal(openResponse.error.message, "open_pdf unknown argument: callback");

		const compileResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 32,
			method: "tools/call",
			params: {
				name: "compile_latex_file",
				arguments: {
					latex_file_path: "paper.tex",
					callback_target_id: "legacy-target",
					workspace_context: { cwd: workspaceDir },
				},
			},
		}))) as { error: { code: number; message: string } };
		assert.equal(compileResponse.error.code, -32602);
		assert.equal(compileResponse.error.message, "compile_latex_file unknown argument: callback_target_id");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon surfaces managed open backend failures in MCP tool responses", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-open-backend-fail-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-open-backend-fail-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const pdfPath = join(workspaceDir, "paper.pdf");
	const socketPath = join(baseDir, "host-service.sock");
	writeFileSync(pdfPath, "%PDF-1.7\n%");
	const backend = new FailingManagedViewerBackend({ open: true });
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	try {
		const openResponse = (await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 40,
			method: "tools/call",
			params: {
				name: "open_pdf",
				arguments: {
					pdf_file_path: pdfPath,
				},
			},
		}))) as {
			result: { isError?: boolean; content: Array<{ text: string }>; details: { error_code?: string } };
		};
		assert.equal(openResponse.result.isError, true);
		assert.equal(openResponse.result.details.error_code, "backend_unavailable");
		assert.match(openResponse.result.content[0].text, /backend unavailable/);
		assert.match(openResponse.result.content[0].text, /code=backend_unavailable/);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon surfaces managed jump errors and rejects removed close_pdf in MCP responses", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-jump-close-backend-fail-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-jump-close-backend-fail-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const pdfPath = join(workspaceDir, "paper.pdf");
	const sourcePath = join(workspaceDir, "paper.tex");
	const socketPath = join(baseDir, "host-service.sock");
	writeFileSync(pdfPath, "%PDF-1.7\n%");
	writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
	const backend = new FailingManagedViewerBackend({ forwardSearch: true, close: true });
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
	});
	await server.start();
	const openPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 50,
		method: "tools/call",
		params: {
			name: "open_pdf",
			arguments: {
				pdf_file_path: pdfPath,
			},
		},
	});
	const jumpPayload = (pdfId: number) => JSON.stringify({
		jsonrpc: "2.0",
		id: 51,
		method: "tools/call",
		params: {
			name: "jump_pdf",
			arguments: {
				pdf_id: pdfId,
				line: 1,
				source_file: sourcePath,
			},
		},
	});
	const closePayload = (pdfId: number) => JSON.stringify({
		jsonrpc: "2.0",
		id: 52,
		method: "tools/call",
		params: {
			name: "close_pdf",
			arguments: {
				pdf_id: pdfId,
			},
		},
	});
	try {
		const openResponse = (await sendFramedRequest(socketPath, openPayload)) as {
			result: { isError?: boolean; details: { pdf_id?: number } };
		};
		assert.equal(openResponse.result.isError, undefined);
		const pdfId = openResponse.result.details.pdf_id;
		if (typeof pdfId !== "number") {
			throw new Error("open_pdf response did not include pdf_id");
		}
		const jumpResponse = (await sendFramedRequest(socketPath, jumpPayload(pdfId))) as {
			result: { isError?: boolean; details: { handled?: boolean; error_code?: string; reason?: string } };
		};
		assert.equal(jumpResponse.result.details.error_code, "backend_unavailable");
		assert.equal(jumpResponse.result.details.reason, "backend unavailable");
		if (jumpResponse.result.isError !== undefined) {
			assert.equal(jumpResponse.result.isError, true);
		} else {
			assert.equal(jumpResponse.result.details.handled, false);
		}

		const closeResponse = (await sendFramedRequest(socketPath, closePayload(pdfId))) as {
			result: { isError?: boolean; content: Array<{ text: string }> };
		};
		assert.equal(closeResponse.result.isError, true);
		assert.match(closeResponse.result.content[0].text, /Tool not implemented by runtime: close_pdf/);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon rejects relative open_pdf path without workspace_context", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-open-rel-reject-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-open-rel-reject-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new TestManagedViewerBackend() });
	await server.start();
	const pdfPath = join(workspaceDir, "paper.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n%");
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 14,
		method: "tools/call",
		params: {
			name: "open_pdf",
			arguments: {
				pdf_file_path: "paper.pdf",
			},
		},
	});
	try {
		const response = (await sendFramedRequest(socketPath, requestPayload)) as { error: { code: number; message: string } };
		assert.equal(response.error.code, -32602);
		assert.equal(response.error.message, "relative pdf_file_path requires workspace_context.cwd");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon rejects compile_latex_file relative path without workspace_context", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-rel-reject-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-rel-reject-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir);
	await server.start();
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 8,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: "main.tex",
			},
		},
	});
	try {
		const response = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			const request = await sendFramedRequest(socketPath, requestPayload);
			return request;
		})) as { error: { code: number; message: string } };
		assert.equal(response.error.code, -32602);
		assert.equal(response.error.message, "relative latex_file_path requires workspace_context.cwd");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon compiles LaTeX file with relative path and workspace_context", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-rel-success-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-rel-success-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const latexPath = join(workspaceDir, "main.tex");
	writeFileSync(latexPath, "\\documentclass{article}\\begin{document}Hello\\end{document}\n");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir);
	await server.start();
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 9,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: "main.tex",
				workspace_context: {
					cwd: workspaceDir,
				},
			},
		},
	});
	try {
		const response = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, requestPayload);
		})) as { result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(response.result.isError, undefined);
		const resultText = response.result.content[0].text;
		const pdfPath = resultText.split(" ").at(-1);
		assert.ok(pdfPath && existsSync(pdfPath));
		assert.equal(dirname(pdfPath), workspaceDir);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon compiles LaTeX file with absolute path without workspace_context", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-abs-success-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-abs-success-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const latexPath = join(workspaceDir, "main.tex");
	writeFileSync(latexPath, "\\documentclass{article}\\begin{document}Hello\\end{document}\n");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir);
	await server.start();
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 10,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: latexPath,
			},
		},
	});
	try {
		const response = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, requestPayload);
		})) as { result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(response.result.isError, undefined);
		const resultText = response.result.content[0].text;
		const pdfPath = resultText.split(" ").at(-1);
		assert.ok(pdfPath && existsSync(pdfPath));
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon compile_latex_file hides warning details by default and can show them explicitly", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-warnings-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-warnings-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const latexPath = join(workspaceDir, "main.tex");
	writeFileSync(latexPath, "\\documentclass{article}\\begin{document}See \\ref{foo}.\\end{document}\n");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir, {
		logContents: "LaTeX Warning: Reference `foo' undefined on input line 1.\nOverfull \\hbox (5.0pt too wide) in paragraph at lines 2--3\n",
	});
	await server.start();
	const defaultPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 101,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: latexPath,
			},
		},
	});
	const shownPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 102,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: latexPath,
				hide_warnings: false,
			},
		},
	});
	try {
		const defaultResponse = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, defaultPayload);
		})) as { result: { isError?: boolean; content: Array<{ text: string }>; details: { compile_status?: string; warning_count?: number; warnings?: unknown; warnings_hidden?: boolean; log?: string } } };
		assert.equal(defaultResponse.result.isError, undefined);
		const defaultText = defaultResponse.result.content[0].text;
		assert.match(defaultText, /^ok_with_warnings:/);
		assert.match(defaultText, /warnings=2/);
		assert.match(defaultText, /Warnings: 2 warnings hidden\./);
		assert.doesNotMatch(defaultText, /hide_warnings=false|Reference `foo'|Overfull/);
		assert.equal(defaultResponse.result.details.compile_status, "ok_with_warnings");
		assert.equal(defaultResponse.result.details.warning_count, 2);
		assert.equal(defaultResponse.result.details.warnings_hidden, true);
		assert.equal("warnings" in defaultResponse.result.details, false);

		const shownResponse = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, shownPayload);
		})) as { result: { isError?: boolean; content: Array<{ text: string }>; details: { compile_status?: string; warning_count?: number; warnings?: Array<{ message: string }>; warnings_hidden?: boolean; log?: string } } };
		assert.equal(shownResponse.result.isError, undefined);
		const shownText = shownResponse.result.content[0].text;
		assert.match(shownText, /^ok_with_warnings:/);
		assert.match(shownText, /warnings=2/);
		assert.match(shownText, /Reference `foo'/);
		assert.match(shownText, /Overfull/);
		assert.equal(shownResponse.result.details.compile_status, "ok_with_warnings");
		assert.equal(shownResponse.result.details.warning_count, 2);
		assert.equal(shownResponse.result.details.warnings_hidden, undefined);
		assert.equal(shownResponse.result.details.warnings?.some((warning) => /Overfull/.test(warning.message)), true);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});


test("daemon rejects compile_latex_file absolute path with non-absolute workspace_context.cwd", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-abs-rel-cwd-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-abs-rel-cwd-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const latexPath = join(workspaceDir, "main.tex");
	writeFileSync(latexPath, "\\documentclass{article}\\begin{document}Hello\\end{document}\n");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 11,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: latexPath,
				workspace_context: {
					cwd: "relative/workspace",
				},
			},
		},
	});
	try {
		const response = (await sendFramedRequest(socketPath, requestPayload)) as { error: { code: number; message: string } };
		assert.equal(response.error.code, -32602);
		assert.equal(response.error.message, "workspace_context.cwd must be absolute for compile_latex_file");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon compile_latex_file open_pdf opens and returns a managed PDF id", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-open-pdf-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-open-pdf-"));
	const workspaceDir = mkdtempSync(join(baseDir, "workspace-"));
	const latexPath = join(workspaceDir, "main.tex");
	writeFileSync(latexPath, "\\documentclass{article}\\begin{document}Hello\\end{document}\n");
	const socketPath = join(baseDir, "host-service.sock");
	const backend = new TestManagedViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir);
	await server.start();
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 11,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: latexPath,
				open_pdf: true,
			},
		},
	});
	try {
		const response = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, requestPayload);
		})) as { result: { isError?: boolean; content: Array<{ text: string }>; details: { pdf?: string; pdf_id?: number; managed_record?: { pdfPath?: string; id?: number } } } };
		assert.equal(response.result.isError, undefined);
		assert.equal(typeof response.result.details.pdf_id, "number");
		assert.equal(response.result.details.managed_record?.id, response.result.details.pdf_id);
		assert.equal(response.result.details.managed_record?.pdfPath, response.result.details.pdf);
		assert.match(response.result.content[0].text, /pdf_id=\d+/);
		assert.equal(backend.openRequests.length, 1);
		assert.equal(backend.openRequests[0]?.details.pdf_path, response.result.details.pdf);
		assert.equal(backend.openRequests[0]?.details.callback, undefined);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon renders show_latex through compile flow", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-show-success-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-show-success-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir);
	await server.start();
	const workspaceContext = {
		cwd: baseDir,
		workspace_root: baseDir,
	};
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 11,
		method: "tools/call",
		params: {
			name: "show_latex",
			arguments: {
				source: "x",
				workspace_context: workspaceContext,
			},
		},
	});
	try {
		const response = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, requestPayload);
		})) as { result: { isError?: boolean; content: Array<{ text: string }> } };
		assert.equal(response.result.isError, undefined);
		const resultText = response.result.content[0].text;
		assert.match(resultText, /\.pdf/);
		assert.match(resultText, /Log: .*\.log/);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon show_latex compiles, opens, and returns a managed PDF id", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-show-open-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-show-open-"));
	const socketPath = join(baseDir, "host-service.sock");
	const backend = new TestManagedViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir);
	await server.start();
	const workspaceContext = {
		cwd: baseDir,
		workspace_root: baseDir,
	};
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 12,
		method: "tools/call",
		params: {
			name: "show_latex",
			arguments: {
				source: "x",
				workspace_context: workspaceContext,
			},
		},
	});
	try {
		const response = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, requestPayload);
		})) as { result: { isError?: boolean; content: Array<{ text: string }>; details: { pdf?: string; pdf_id?: number; managed_record?: { pdfPath?: string; id?: number } } } };
		assert.equal(response.result.isError, undefined);
		assert.equal(typeof response.result.details.pdf_id, "number");
		assert.equal(response.result.details.managed_record?.id, response.result.details.pdf_id);
		assert.equal(response.result.details.managed_record?.pdfPath, response.result.details.pdf);
		assert.notEqual(response.result.details.pdf, getMcpFixedPreviewPdfPath());
		assert.match(response.result.content[0].text, /pdf_id=\d+/);
		assert.equal(backend.openRequests.length, 1);
		assert.equal(backend.openRequests[0]?.details.pdf_path, response.result.details.pdf);
		assert.equal(backend.openRequests[0]?.details.callback, undefined);
		assert.equal(backend.openRequests[0]?.details.reuse_existing, true);
		assert.equal(backend.openRequests[0]?.details.require_persistent_viewer, false);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon rejects public show_latex fixed_preview_pdf_path", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-show-fixed-preview-outside-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-show-fixed-preview-outside-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new TestManagedViewerBackend() });
	const fakeCompilerDir = join(baseDir, "fake-bin");
	writeFakeLatexCompiler(fakeCompilerDir);
	await server.start();
	const workspaceContext = {
		cwd: baseDir,
		workspace_root: baseDir,
	};
	const invalidPreviewPath = join(tmpdir(), `host-service-show-latex-invalid-${Date.now()}.pdf`);
	if (existsSync(invalidPreviewPath)) {
		rmSync(invalidPreviewPath, { force: true });
	}
	const requestPayload = JSON.stringify({
		jsonrpc: "2.0",
		id: 13,
		method: "tools/call",
		params: {
			name: "show_latex",
			arguments: {
				source: "x",
				fixed_preview_pdf_path: invalidPreviewPath,
				workspace_context: workspaceContext,
			},
		},
	});
	try {
		const response = (await withPathOverride(`${fakeCompilerDir}:${process.env.PATH}`, async () => {
			return await sendFramedRequest(socketPath, requestPayload);
		})) as { error: { code: number; message: string } };
		assert.equal(response.error.code, -32602);
		assert.equal(response.error.message, "show_latex unknown argument: fixed_preview_pdf_path");
		assert.equal(existsSync(invalidPreviewPath), false);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon returns MCP method-not-found for unknown methods", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-method-not-found-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-method-not-found-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			id: 12,
			method: "foobar",
		});
		const response = (await sendFramedRequest(socketPath, payload)) as { error: { code: number } };
		assert.equal(response.error.code, -32601);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

test("daemon returns JSON-RPC parse errors for malformed MCP frames", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-malformed-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-malformed-"));
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	try {
		const request = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
		const malformed = `Content-Length: abc\r\n\r\n${request}`;
		const raw = await sendRawMcpPayload(socketPath, malformed);
		const response = parseMcpFrame(raw) as { error: { code: number } };
		assert.equal(response.error.code, -32700);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

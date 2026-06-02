import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getLatexPreamblePath } from "../../src/modules/runtime_paths.ts";
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

function writeFakeLatexCompiler(binDir: string): void {
	const compilerPath = join(binDir, "lualatex");
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	writeFileSync(
		compilerPath,
		"#!/bin/sh\nset -eu\ntex_file=\"\"\nfor arg in \"$@\"; do\n  tex_file=\"$arg\"\ndone\nbase=\"${tex_file##*/}\"\nname=\"${base%.*}\"\nout_dir=\"$(dirname \"$tex_file\")\"\nif [ -z \"$tex_file\" ]; then\n  exit 1\nfi\nprintf \"fake compiler output\\n\" > \"$out_dir/$name.log\"\ntouch \"$out_dir/$name.pdf\"\ntouch \"$out_dir/$name.aux\"\nexit 0\n",
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
	"close_pdf",
	"set_latex_preamble",
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
		const toolsListResponse = (await sendFramedRequest(socketPath, toolsListPayload)) as { jsonrpc: "2.0"; id: 3; result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { type?: string }> } }> } };
		const names = toolsListResponse.result.tools.map((tool) => tool.name);
		assert.deepEqual(names, HOST_TOOL_NAMES);

		const byName = new Map(toolsListResponse.result.tools.map((tool) => [tool.name, tool]));
		const showLatexTool = byName.get("show_latex");
		const compileFileTool = byName.get("compile_latex_file");
		assert.ok(showLatexTool);
		assert.ok(compileFileTool);
		assert.equal(typeof showLatexTool.inputSchema.properties.workspace_context, "object");
		assert.equal(typeof compileFileTool.inputSchema.properties.workspace_context, "object");
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
		assert.equal(response.error.message, "set_latex_preamble requires latex_preamble to be a string");
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
				name: "open_pdf",
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

test("daemon rejects compile_latex_file relative path without workspace_context", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-rel-reject-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-rel-reject-"));
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

test("daemon rejects compile_latex_file open_pdf support", async () => {
	const runtime = allocateMcpTmpDir("host-service-mcp-compile-open-pdf-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-mcp-compile-open-pdf-"));
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
				open_pdf: true,
			},
		},
	});
	try {
		const response = (await sendFramedRequest(socketPath, requestPayload)) as { error: { code: number; message: string } };
		assert.equal(response.error.code, -32602);
		assert.equal(response.error.message, "open_pdf is not supported by daemon MCP compile_latex_file");
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
		assert.match(resultText, /\.pdf$/);
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

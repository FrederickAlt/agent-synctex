import { spawn } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import {
	chmodSync,
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

import {
	FakeViewerBackend,
	HostServiceClient,
	HostServiceServer,
} from "../../src/modules/host_service.ts";
import { INLINE_PREVIEW_DIR } from "../../src/modules/preview/inline_preview.ts";

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

function writeFakeLatexCompiler(binDir: string, options: { exitCode?: number; withLog?: boolean } = {}): string {
	const exitCode = options.exitCode ?? 0;
	const withLog = options.withLog ?? true;
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	const compilerPath = join(binDir, "lualatex");
	writeFileSync(compilerPath, `#!/bin/sh
set -eu
tex_file=""
prev=""
out_dir=""
for arg in "$@"; do
  if [ "$prev" = "-output-directory" ]; then
    out_dir="$arg"
  fi
  tex_file="$arg"
  prev="$arg"
done
base="\${tex_file##*/}"
name="\${base%.*}"
out_dir="\${out_dir:-$(pwd)}"
mkdir -p "$out_dir"${withLog ? `
if [ ! -z "$out_dir" ]; then
  echo "fake compiler output" > "$out_dir/$name.log"
fi` : ""}
touch "$out_dir/$name.pdf"
exit ${exitCode}
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

function createMiniPng(width: number, height: number): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdrLength = Buffer.alloc(4);
	ihdrLength.writeUInt32BE(13, 0);
	const ihdrType = Buffer.from("IHDR");
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	ihdrData[8] = 8;
	ihdrData[9] = 6;
	ihdrData[10] = 0;
	ihdrData[11] = 0;
	ihdrData[12] = 0;
	const ihdrCrc = Buffer.alloc(4);
	const iendLength = Buffer.alloc(4);
	iendLength.writeUInt32BE(0, 0);
	const iendType = Buffer.from("IEND");
	const iendCrc = Buffer.alloc(4);
	return Buffer.concat([
		signature,
		ihdrLength,
		ihdrType,
		ihdrData,
		ihdrCrc,
		iendLength,
		iendType,
		iendCrc,
	]);
}

function writeFakeMutool(binDir: string, width = 64, height = 48): string {
	const png = createMiniPng(width, height).toString("base64");
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	const mutoolPath = join(binDir, "mutool");
	writeFileSync(mutoolPath, `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
if [ -z "$out" ]; then
  exit 1
fi
printf '%s' '${png}' | base64 -d > "$out"
`);
	chmodSync(mutoolPath, 0o700);
	return mutoolPath;
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

function buildHostServiceBackendHarness(baseDir: string, backend?: FakeViewerBackend): {
	server: HostServiceServer;
	client: HostServiceClient;
} {
	const socketPath = join(baseDir, "host-service.sock");
	const testBackend = backend ?? new FakeViewerBackend();
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: testBackend,
	});
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
	});
	return { server, client };
}

class RecordingFakeViewerBackend extends FakeViewerBackend {
	readonly openedDetails: Array<Record<string, unknown>> = [];

	async open(requestId: string, details: Record<string, unknown>) {
		this.openedDetails.push({ ...details });
		return super.open(requestId, details);
	}
}

class ValidatingFakeViewerBackend extends FakeViewerBackend {
	async open(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["open"]> {
		const pdfPath = typeof details.pdf_path === "string" ? details.pdf_path : undefined;
		if (pdfPath) {
			let header = "";
			try {
				header = readFileSync(pdfPath, "utf8");
			} catch {
				return {
					status: "error",
					error: "pdf_path is not a PDF file",
					status_details: {
						protocol_version: 1,
						supported: true,
						service_available: true,
						backend: this.name,
						backend_path: this.name,
						capabilities: this.capabilities,
						owned: false,
						reused: false,
						error_code: "invalid_pdf",
						reason: "pdf_path is not a PDF file",
					},
				};
			}
			if (!header.startsWith("%PDF-")) {
				return {
					status: "error",
					error: "pdf_path is not a PDF file",
					status_details: {
						protocol_version: 1,
						supported: true,
						service_available: true,
						backend: this.name,
						backend_path: this.name,
						capabilities: this.capabilities,
						owned: false,
						reused: false,
						error_code: "invalid_pdf",
						reason: "pdf_path is not a PDF file",
					},
				};
			}
		}
		return super.open(requestId, details);
	}
}

async function writeHostServiceRequest(
	path: string,
	request: Record<string, unknown>,
	timeoutMs = 300,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path });
		let raw = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("socket roundtrip timed out"));
		}, timeoutMs);
		timer.unref?.();

		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
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
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-test",
		viewerBackend: new FakeViewerBackend(),
	});
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


test("host service compiles an existing latex file with explicit workspace context", async () => {
	const baseDir = temporaryDir("host-service-compile-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-test" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexFile(
			{
				latex_file_path: "paper.tex",
				compiler: "lualatex",
				clean: false,
			},
		{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_file");
		assert.equal(result.supported, true);
		assert.equal(result.source, join(baseDir, "paper.tex"));
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
		assert.equal(result.log, join(baseDir, "paper.log"));
		assert.equal(result.clean, false);
		assert.equal(result.cleaned_artifacts.length, 0);
		assert.ok(result.artifact_paths.includes(join(baseDir, "paper.pdf")));
		assert.ok(result.artifact_paths.includes(join(baseDir, "paper.log")));
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_file operation surfaces compiler failures", async () => {
	const baseDir = temporaryDir("host-service-compile-failure-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), { exitCode: 7 });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-failure" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});

	try {
		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /LaTeX compile failed/);
		assert.match(observed.message, /code=compile_failed/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_file rejects malformed payloads", async () => {
	const baseDir = temporaryDir("host-service-compile-malformed-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-malformed" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "bad-request-id",
		operation: "compile_latex_file",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.request_id, "bad-request-id");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.match(response.error, /missing compile details/);
});


test("host service compile_latex_file includes raw source path for invalid compile workspace", async () => {
	const baseDir = temporaryDir("host-service-compile-malformed-workspace-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-workspace-raw" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "workspace-request-id",
		operation: "compile_latex_file",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: "relative/path", workspace_root: "relative-root" },
		details: {
			latex_file_path: "paper.tex",
		},
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.operation, "compile_latex_file");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.source, "paper.tex");
	assert.equal(response.status_details.log, "paper.log");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.match(response.error, /workspace_context.cwd must be absolute for compile_latex_file/);
});

test("host service rasterize request with missing payload details is rejected", async () => {
	const baseDir = temporaryDir("host-service-rasterize-malformed-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-malformed" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "rasterize-malformed-request-id",
		operation: "rasterize",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.operation, "rasterize");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.match(response.error, /missing rasterize details/);
});

test("host service rasterize missing pdf returns host-service invalid_request code", async () => {
	const baseDir = temporaryDir("host-service-rasterize-missing-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-missing-pdf" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "rasterize-missing-pdf-id",
		operation: "rasterize",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
		details: {
			pdf_path: join(baseDir, "missing.pdf"),
		},
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.operation, "rasterize");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.equal(response.status_details.pdf_path, join(baseDir, "missing.pdf"));
	assert.equal(response.status_details.artifacts.length, 0);
	assert.equal(response.status_details.artifact_paths.length, 0);
	assert.match(response.error, /does not exist/);
});

test("host service rasterize rejects invalid page request as invalid_request", async () => {
	const baseDir = temporaryDir("host-service-rasterize-invalid-page-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeMutool(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "sample.pdf"), "%PDF-1.4\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-invalid-page" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestRasterizePdf({ pdf_path: "sample.pdf", page: 0 }, { cwd: baseDir });
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /page must be a positive integer/);
	assert.match(observed.message, /code=invalid_request/);
	assert.doesNotMatch(observed.message, /Malformed host service response payload/);
});

test("host service rasterize returns artifact metadata", async () => {
	const baseDir = temporaryDir("host-service-rasterize-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeMutool(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "sample.pdf"), "%PDF-1.4\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-success" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestRasterizePdf({ pdf_path: "sample.pdf" }, { cwd: baseDir });
		assert.equal(result.operation, "rasterize");
		assert.equal(result.supported, true);
		assert.equal(result.service_available, true);
		assert.equal(result.pdf_path, join(baseDir, "sample.pdf"));
		assert.equal(result.artifact_paths.length, 1);
		assert.equal(result.artifacts.length, 1);
		assert.equal(result.artifacts[0].page, 1);
		assert.equal(result.artifacts[0].renderer, "mutool");
		assert.equal(existsSync(result.artifacts[0].pngPath), true);
		assert.equal(result.artifact_paths[0], result.artifacts[0].pngPath);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_snippet malformed requests avoid raw snippet in error details", async () => {
	const baseDir = temporaryDir("host-service-snippet-malformed-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-malformed" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "snippet-workspace-request-id",
		operation: "compile_latex_snippet",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.operation, "compile_latex_snippet");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.source, "");
	assert.equal(response.status_details.log, "");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.match(response.error, /missing compile details/);
});


test("host service compile_latex_file rejects invalid compiler values", async () => {
	const baseDir = temporaryDir("host-service-compile-invalid-compiler-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-bad-compiler" });
	await server.start();
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\\n\\begin{document}\\nhi\\end{document}\\n");
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: 123 }, { cwd: baseDir });
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /compiler must be a string/);
});


test("host service compile_latex_file rejects unsupported compiler strings", async () => {
	const baseDir = temporaryDir("host-service-compile-unsupported-compiler-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-unsupported-compiler" });
	await server.start();
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\\n\\begin{document}\\nhi\\end{document}\\n");
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "bogus" }, { cwd: baseDir });
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /compiler must be one of:/);
	assert.match(observed.message, /code=compile_failed/);
});


test("host service compile_latex_snippet wraps bare snippets when no workspace preamble exists", async () => {
	const baseDir = temporaryDir("host-service-snippet-no-preamble-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-no-preamble" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}" },
			{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_snippet");
		assert.equal(result.clean, false);
		assert.equal(result.artifact_paths.includes(result.pdf), true);
		assert.equal(result.artifact_paths.includes(result.log), true);
		assert.equal(existsSync(result.pdf), true);
		assert.equal(existsSync(result.log), true);
		const renderedSource = readFileSync(result.source, "utf8");
		assert.match(renderedSource, /\\documentclass\{article\}/);
		assert.match(renderedSource, /\\begin\{document\}/);
		assert.match(renderedSource, /\\end\{document\}/);
		assert.match(renderedSource, /\\section\{Hello\}/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet applies workspace preamble and document wrapper", async () => {
	const baseDir = temporaryDir("host-service-snippet-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "preamble.tex"), "\\usepackage{paper}");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-success" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}" },
			{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_snippet");
		assert.equal(result.clean, false);
		assert.equal(result.artifact_paths.includes(result.pdf), true);
		assert.equal(result.artifact_paths.includes(result.log), true);
		assert.equal(existsSync(result.pdf), true);
		assert.equal(existsSync(result.log), true);
		const renderedSource = readFileSync(result.source, "utf8");
		assert.match(renderedSource, /\\usepackage\{paper\}/);
		assert.match(renderedSource, /\\begin\{document\}/);
		assert.match(renderedSource, /\\end\{document\}/);
		assert.match(renderedSource, /\\section\{Hello\}/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet keeps explicit document wrappers when provided", async () => {
	const baseDir = temporaryDir("host-service-snippet-explicit-wrapper-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-explicit-wrapper" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\documentclass{article}\\n\\begin{document}\\n\\section{Body}\\n\\end{document}" },
			{ cwd: baseDir },
		);
		const renderedSource = readFileSync(result.source, "utf8");
		const beginCount = (renderedSource.match(/\\begin\{document\}/g) ?? []).length;
		const endCount = (renderedSource.match(/\\end\{document\}/g) ?? []).length;
		assert.equal(beginCount, 1);
		assert.equal(endCount, 1);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet resolves workspace_root preamble", async () => {
	const baseDir = temporaryDir("host-service-snippet-workspace-root-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const workspaceRoot = join(baseDir, "workspace");
	const compileCwd = join(baseDir, "cwd");
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(compileCwd, { recursive: true });
	writeFileSync(join(workspaceRoot, "preamble.tex"), "\\usepackage{hyperref}");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-workspace-root" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Root}" },
			{ cwd: compileCwd, workspace_root: workspaceRoot },
		);
		const renderedSource = readFileSync(result.source, "utf8");
		assert.match(renderedSource, /\\usepackage\{hyperref\}/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet preserves compile failures", async () => {
	const baseDir = temporaryDir("host-service-compile-snippet-failure-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), { exitCode: 9 });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-failure" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexSnippet({ latex_source: "x", compiler: "lualatex" }, { cwd: baseDir });
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /LaTeX compile failed/);
	assert.match(observed.message, /code=compile_failed/);
});


test("host service compile_latex_snippet requires absolute workspace cwd", async () => {
	const baseDir = temporaryDir("host-service-compile-snippet-absolute-cwd-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-absolute" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexSnippet({ latex_source: "x" }, { cwd: "relative/path" });
	} catch (error) {
		observed = error;
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /must be absolute for compile_latex_snippet/);
});


test("host service compile_latex_file keeps clean=true artifacts in report", async () => {
	const baseDir = temporaryDir("host-service-compile-clean-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\\n\\begin{document}\\nclean\\end{document}\\n");
	writeFileSync(join(baseDir, "paper.aux"), "old aux");
	writeFileSync(join(baseDir, "paper.log"), "old log");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-clean" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexFile(
			{
				latex_file_path: "paper.tex",
				clean: true,
			},
			{ cwd: baseDir },
		);
		assert.equal(result.clean, true);
		assert.equal(result.cleaned_artifacts.includes(join(baseDir, "paper.aux")), true);
		assert.equal(result.cleaned_artifacts.includes(join(baseDir, "paper.log")), true);
		assert.equal(result.artifact_paths.includes(join(baseDir, "paper.pdf")), true);
		assert.equal(result.artifact_paths.includes(join(baseDir, "paper.log")), true);
		assert.equal(result.artifact_paths.includes(join(baseDir, "paper.aux")), false);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_file filters missing artifacts", async () => {
	const baseDir = temporaryDir("host-service-compile-filter-artifacts-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), { withLog: false });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\\n\\begin{document}\\nhi\\end{document}\\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-filter-artifacts" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexFile({ latex_file_path: "paper.tex" }, { cwd: baseDir });
		assert.equal(result.artifact_paths.includes(join(baseDir, "paper.pdf")), true);
		assert.equal(result.artifact_paths.includes(join(baseDir, "paper.log")), false);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_file requires absolute workspace cwd", async () => {
	const baseDir = temporaryDir("host-service-compile-absolute-cwd-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-absolute" });
	await server.start();
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\\n\\begin{document}\\nhi\\end{document}\\n");
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex" }, { cwd: "relative/path" });
	} catch (error) {
		observed = error;
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /must be absolute for compile_latex_file/);
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

test("host service client validates callback response operation", async () => {
	const baseDir = temporaryDir("host-service-bad-callback-response-");
	const socketPath = join(baseDir, "host-service.sock");
	const expectedRequestId = "callback-response-request-id";
	const mismatchedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "status",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			service_name: "agent-synctex-test-callback-response",
			socket_path: socketPath,
			service_instance_started_ns: Date.now() * 1_000_000,
			service_instance_id: "instance-id",
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "status",
			target_id: "pi-editor",
			callback_available: true,
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: "/tmp/callback.sock",
				token: "token",
			},
			uptime_ns: 1,
			total_requests: 1,
		},
	}) + "\n";
	const mismatchedServer = createServer((socket) => {
		socket.end(mismatchedResponse, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		mismatchedServer.once("error", reject);
		mismatchedServer.listen(socketPath, () => {
			resolve();
		});
	});
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => expectedRequestId,
	});
	await assert.rejects(
		() => client.requestResolveCallbackTarget({ cwd: baseDir }, "pi-editor"),
		/Malformed host service response payload/,
	);
	await new Promise<void>((resolve) => {
		mismatchedServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
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

test("host service client validates rasterize response artifact metadata", async () => {
	const baseDir = temporaryDir("host-service-bad-rasterize-artifact-");
	const socketPath = join(baseDir, "host-service.sock");
	mkdirSync(INLINE_PREVIEW_DIR, { mode: 0o700, recursive: true });
	const previewPng = join(INLINE_PREVIEW_DIR, "rasterize-artifact-invalid-page.png");
	writeFileSync(previewPng, createMiniPng(16, 8));
	const expectedRequestId = "rasterize-page-id";
	const malformedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "rasterize",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "rasterize",
			pdf_path: join(baseDir, "sample.pdf"),
			artifacts: [
				{
					pngPath: previewPng,
					page: 0,
					dpi: 150,
					renderer: "mutool",
					trimmed: false,
					fullPageWidthPx: 16,
					fullPageHeightPx: 8,
					widthPx: 16,
					heightPx: 8,
				},
			],
			artifact_paths: [previewPng],
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
	await assert.rejects(
		() => client.requestRasterizePdf({ pdf_path: "sample.pdf" }, { cwd: baseDir }),
		/Malformed host service response payload/,
	);
	await new Promise<void>((resolve) => {
		malformedServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service client validates rasterize response artifact paths", async () => {
	const baseDir = temporaryDir("host-service-bad-rasterize-artifact-path-");
	const socketPath = join(baseDir, "host-service.sock");
	mkdirSync(INLINE_PREVIEW_DIR, { mode: 0o700, recursive: true });
	const previewPng = join(INLINE_PREVIEW_DIR, "rasterize-artifact-valid.png");
	writeFileSync(previewPng, createMiniPng(16, 8));
	const expectedRequestId = "rasterize-artifact-path-id";
	const malformedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "rasterize",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "rasterize",
			pdf_path: join(baseDir, "sample.pdf"),
			artifacts: [
				{
					pngPath: previewPng,
					page: 1,
					dpi: 150,
					renderer: "mutool",
					trimmed: false,
					fullPageWidthPx: 16,
					fullPageHeightPx: 8,
					widthPx: 16,
					heightPx: 8,
				},
			],
			artifact_paths: [join(baseDir, "outside-preview.png")],
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
	await assert.rejects(
		() => client.requestRasterizePdf({ pdf_path: "sample.pdf" }, { cwd: baseDir }),
		/Malformed host service response payload/,
	);
	await new Promise<void>((resolve) => {
		malformedServer.close(() => resolve());
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
test("host service status reports configured fake viewer backend name and capabilities", async () => {
	const baseDir = temporaryDir("host-service-backend-harness-status-");
	const fakeBackend = new FakeViewerBackend({
		name: "agent-synctex-fake-viewer",
		capabilities: {
			close: false,
			forward_search: false,
		},
	});
	const { server, client } = buildHostServiceBackendHarness(baseDir, fakeBackend);

	await server.start();
	try {
		const status = await client.requestStatus({ cwd: baseDir });
		assert.equal(status.viewer_backend_name, "agent-synctex-fake-viewer");
		assert.equal(status.viewer_backend_available, true);
		assert.equal(status.viewer_backend_capabilities?.open, true);
		assert.equal(status.viewer_backend_capabilities?.close, false);
		assert.equal(status.viewer_backend_capabilities?.forward_search, false);
		assert.equal(status.service_available, true);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service status reflects backend availability for health checks", async () => {
	const baseDir = temporaryDir("host-service-backend-harness-unavailable-");
	const fakeBackend = new FakeViewerBackend({ available: false });
	const { server, client } = buildHostServiceBackendHarness(baseDir, fakeBackend);

	await server.start();
	try {
		const status = await client.requestStatus({ cwd: baseDir });
		assert.equal(status.viewer_backend_available, false);
		assert.equal(status.service_available, false);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}

});

test("host service open_pdf resolves relative PDF paths and tracks managed records for reuse", async () => {
	const baseDir = temporaryDir("host-service-open-reuse-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new RecordingFakeViewerBackend();
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const firstOpen = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		assert.equal(firstOpen.reused, false);
		assert.equal(firstOpen.owned, true);
		assert.equal(typeof firstOpen.handle, "string");
		if (firstOpen.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const firstOpenPdfId = firstOpen.pdf_id;
		assert.equal(firstOpenPdfId >= 1, true);
		assert.equal(typeof firstOpenPdfId, "number");
		assert.equal(typeof firstOpen.managed_record?.id, "number");
		assert.equal(firstOpen.managed_record?.id, firstOpenPdfId);
		assert.equal(firstOpen.managed_record?.viewerHandle, firstOpen.handle);
		assert.equal(firstOpen.managed_record?.viewerBackend, firstOpen.backend);
		assert.equal(firstOpen.managed_record?.viewerOwned, firstOpen.owned);
		assert.equal(firstOpen.managed_record?.pdfPath, pdfPath);
		assert.equal(firstOpen.managed_record?.callback?.token, callback.token);
		assert.equal(firstOpen.managed_record?.capabilities?.open, true);
		assert.equal(backend.openedDetails.length, 1);
		assert.equal(backend.openedDetails[0]!.pdf_path, pdfPath);
		const secondOpen = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		assert.equal(secondOpen.reused, true);
		assert.equal(secondOpen.pdf_id, firstOpenPdfId);
		assert.equal(secondOpen.handle, firstOpen.handle);
		const thirdOpen = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback: {
					...callback,
					token: "beta-token",
				},
				reuse_existing: true,
			},
		);
		assert.equal(thirdOpen.reused, false);
		assert.notEqual(thirdOpen.pdf_id, firstOpenPdfId);
		assert.notEqual(thirdOpen.handle, firstOpen.handle);
		assert.equal(backend.openedDetails.length, 3);
		assert.equal(backend.openedDetails[1]!.pdf_path, pdfPath);
		assert.equal(backend.openedDetails[2]!.pdf_path, pdfPath);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service open_pdf returns backend-provided invalid-PDF errors", async () => {
	const baseDir = temporaryDir("host-service-open-invalid-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "not-pdf.txt");
	writeFileSync(pdfPath, "just text\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new ValidatingFakeViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		await assert.rejects(
			() => client.requestOpenPdf(
				{ cwd: baseDir },
				{
					pdf_path: "not-pdf.txt",
					callback,
					reuse_existing: true,
				},
			),
			/invalid_pdf/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service open_pdf returns backend-unavailable errors", async () => {
	const baseDir = temporaryDir("host-service-open-backend-unavailable-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new FakeViewerBackend({ available: false });
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		await assert.rejects(
			() => client.requestOpenPdf(
				{ cwd: baseDir },
				{
					pdf_path: "sample.pdf",
					callback,
					reuse_existing: true,
				},
			),
			/backend_unavailable/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service open_pdf allocates active pdf ids from random range", async () => {
	const baseDir = temporaryDir("host-service-open-id-range-");
	const socketPath = join(baseDir, "host-service.sock");
	const backend = new RecordingFakeViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const callbackBase = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
	};

	try {
		const pdfIds = new Set<number>();
		for (let i = 0; i < 5; i += 1) {
			const pdfPath = join(baseDir, `sample-${i}.pdf`);
			writeFileSync(pdfPath, "%PDF-1.4\n");
			const response = await client.requestOpenPdf(
				{ cwd: baseDir },
				{
					pdf_path: `sample-${i}.pdf`,
					callback: {
						...callbackBase,
						token: `token-${i}`,
					},
					reuse_existing: true,
				},
			);
			if (response.pdf_id === undefined) {
				throw new Error("host service open response did not include pdf_id");
			}
			const pdfId = response.pdf_id;
			assert.equal(pdfId >= 1 && pdfId <= 99_999_999, true);
			pdfIds.add(pdfId);
		}
		assert.equal(pdfIds.size, 5);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

	test("host service supports callback target register, replace, and unregister", async () => {
	const baseDir = temporaryDir("host-service-callback-register-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const targetPath = join(baseDir, "callback.sock");
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(targetPath, resolve);
	});
	const baseTarget = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: targetPath,
		token: "alpha-token",
	};

	const first = await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "pi-editor",
			target: baseTarget,
		},
	);
	assert.equal(first.target_id, "pi-editor");
	assert.equal(first.callback_registered, true);
	assert.equal(first.callback_replaced, false);
	assert.equal(first.target?.token, "alpha-token");

	const second = await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "pi-editor",
			target: {
				...baseTarget,
				token: "beta-token",
			},
		},
	);
	assert.equal(second.target_id, "pi-editor");
	assert.equal(second.callback_replaced, true);
	assert.equal(second.target?.token, "beta-token");

	const unregistered = await client.requestUnregisterCallbackTarget({ cwd: baseDir }, "pi-editor");
	assert.equal(unregistered.target_id, "pi-editor");
	assert.equal(unregistered.removed, true);
	const recheck = await client.requestUnregisterCallbackTarget({ cwd: baseDir }, "pi-editor");
	assert.equal(recheck.target_id, "pi-editor");
	assert.equal(recheck.removed, false);

	const resolved = await client.requestResolveCallbackTarget({ cwd: baseDir }, "pi-editor");
	assert.equal(resolved.operation, "resolve_callback_target");
	assert.equal(resolved.callback_available, false);
	assert.equal(resolved.target_id, "pi-editor");

	await server.stop();
	await new Promise<void>((resolve) => {
		callbackListener.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service isolates callback targets by workspace context", async () => {
	const baseDirA = temporaryDir("host-service-callback-context-a-");
	const baseDirB = temporaryDir("host-service-callback-context-b-");
	const socketPath = join(baseDirA, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-context" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const targetPathA = join(baseDirA, "callback-a.sock");
	const targetPathB = join(baseDirA, "callback-b.sock");
	const targetPathC = join(baseDirB, "callback-c.sock");
	const callbackListenerA = createServer();
	const callbackListenerB = createServer();
	const callbackListenerC = createServer();
	await Promise.all([
		new Promise<void>((resolve) => callbackListenerA.listen(targetPathA, resolve)),
		new Promise<void>((resolve) => callbackListenerB.listen(targetPathB, resolve)),
		new Promise<void>((resolve) => callbackListenerC.listen(targetPathC, resolve)),
	]);

	const contextA = { cwd: baseDirA, session_id: "session-alpha" };
	const contextB = { cwd: baseDirA, session_id: "session-beta" };
	const contextC = { cwd: baseDirB, session_id: "session-alpha" };
	const baseTarget = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
	};

	const registeredA = await client.requestRegisterCallbackTarget(contextA, {
		target_id: "pi-editor",
		target: {
			...baseTarget,
			socket_path: targetPathA,
			token: "token-a",
		},
	});
	const registeredB = await client.requestRegisterCallbackTarget(contextB, {
		target_id: "pi-editor",
		target: {
			...baseTarget,
			socket_path: targetPathB,
			token: "token-b",
		},
	});
	const registeredC = await client.requestRegisterCallbackTarget(contextC, {
		target_id: "pi-editor",
		target: {
			...baseTarget,
			socket_path: targetPathC,
			token: "token-c",
		},
	});
	assert.equal(registeredA.callback_registered, true);
	assert.equal(registeredB.callback_registered, true);
	assert.equal(registeredC.callback_registered, true);

	const resolvedA = await client.requestResolveCallbackTarget(contextA, "pi-editor");
	const resolvedB = await client.requestResolveCallbackTarget(contextB, "pi-editor");
	const resolvedC = await client.requestResolveCallbackTarget(contextC, "pi-editor");
	assert.equal(resolvedA.callback_available, true);
	assert.equal(resolvedA.target?.token, "token-a");
	assert.equal(resolvedB.callback_available, true);
	assert.equal(resolvedB.target?.token, "token-b");
	assert.equal(resolvedC.callback_available, true);
	assert.equal(resolvedC.target?.token, "token-c");

	const unregisteredB = await client.requestUnregisterCallbackTarget(contextB, "pi-editor");
	assert.equal(unregisteredB.removed, true);

	const afterUnregisterB = await client.requestResolveCallbackTarget(contextB, "pi-editor");
	assert.equal(afterUnregisterB.callback_available, false);
	const remainA = await client.requestResolveCallbackTarget(contextA, "pi-editor");
	assert.equal(remainA.callback_available, true);
	assert.equal(remainA.target?.token, "token-a");
	const remainC = await client.requestResolveCallbackTarget(contextC, "pi-editor");
	assert.equal(remainC.callback_available, true);
	assert.equal(remainC.target?.token, "token-c");

	await server.stop();
	await Promise.all([
		new Promise<void>((resolve) => callbackListenerA.close(() => resolve())),
		new Promise<void>((resolve) => callbackListenerB.close(() => resolve())),
		new Promise<void>((resolve) => callbackListenerC.close(() => resolve())),
	]);
	rmSync(baseDirA, { recursive: true, force: true });
	rmSync(baseDirB, { recursive: true, force: true });
});

test("host service degrades missing and stale callback targets", async () => {
	const baseDir = temporaryDir("host-service-callback-stale-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-stale" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const missing = await client.requestResolveCallbackTarget({ cwd: baseDir }, "missing-target");
	assert.equal(missing.callback_available, false);
	assert.equal(missing.target_id, "missing-target");

	const callbackSocket = join(baseDir, "callback.sock");
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocket, resolve);
	});

	const shortLived = await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "short-lived",
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: callbackSocket,
				token: "stale-token",
			},
			stale_after_ms: 1,
		},
	);
	assert.equal(shortLived.callback_replaced, false);
	assert.equal(shortLived.callback_registered, true);
	await sleep(10);
	const stale = await client.requestResolveCallbackTarget({ cwd: baseDir }, "short-lived");
	assert.equal(stale.callback_available, false);
	assert.equal(stale.target_id, "short-lived");
	await new Promise<void>((resolve) => {
		callbackListener.close(() => resolve());
	});

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service treats orphaned callback sockets as unavailable", async () => {
	const baseDir = temporaryDir("host-service-callback-orphan-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-orphan" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const orphanSocket = join(baseDir, "callback-orphan.sock");
	const orphanServer = await startOrphanSocketServer(orphanSocket);
	await waitForFile(orphanSocket);
	await new Promise<void>((resolve) => {
		orphanServer.once("exit", () => resolve());
		orphanServer.kill("SIGKILL");
	});

	await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "orphaned",
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: orphanSocket,
				token: "orphan-token",
			},
		},
	);
	const resolved = await client.requestResolveCallbackTarget({ cwd: baseDir }, "orphaned");
	assert.equal(resolved.callback_available, false);
	assert.equal(resolved.target_id, "orphaned");
	assert.equal(resolved.target, undefined);

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service validates callback registration protocol", async () => {
	const baseDir = temporaryDir("host-service-callback-validation-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-validation" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	await assert.rejects(
		() => client.requestRegisterCallbackTarget({ cwd: "" }, {
			target_id: "bad-request",
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: "/tmp/callback.sock",
				token: "token",
			},
		}),
		/invalid workspace_context/,
	);

	await assert.rejects(
		() => client.requestRegisterCallbackTarget(
			{ cwd: baseDir },
			{
				target_id: "bad-target",
				target: {
					kind: "not-a-real-kind",
					transport: "unix",
					socket_path: join(baseDir, "callback.sock"),
					token: "token",
				},
			} as any,
		),
		/invalid callback target/,
	);

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });
});

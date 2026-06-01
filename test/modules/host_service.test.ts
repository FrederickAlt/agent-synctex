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

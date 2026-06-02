import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import {
	HOST_SERVICE_SOCKET_PATH_ENV_VAR,
	HostServiceClient,
	HostServiceServer,
	resolveHostServiceSocketPath,
} from "../../src/modules/host_service.ts";

function temporaryDir(prefix: string): string {
	return mkdtempSync(join(process.cwd(), prefix));
}

function waitForStatus(socketPath: string): Promise<void> {
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 250 });
	const deadline = Date.now() + 1_000;
	return new Promise((resolve, reject) => {
		const attempt = async () => {
			if (Date.now() > deadline) {
				reject(new Error("daemon status probe timed out"));
				return;
			}
			try {
				await client.requestStatus({ cwd: process.cwd() });
				resolve();
				return;
			} catch {
				setTimeout(attempt, 25);
			}
		};
		void attempt();
	});
}

function waitForSocket(path: string, timeoutMs = 1_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = () => {
			if (existsSync(path)) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error(`timed out waiting for socket file ${path}`));
				return;
			}
			setTimeout(poll, 25);
		};
		poll();
	});
}

test("host service socket resolver supports override, platform defaults, and fallback", () => {
	const baseDir = temporaryDir("host-service-socket-resolution-");
	const runtimeDir = join(baseDir, "runtime");
	const homeDir = join(baseDir, "home");
	const fallbackDir = join(baseDir, "fallback");
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	mkdirSync(homeDir, { recursive: true, mode: 0o700 });
	mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });

	const override = resolve(baseDir, "explicit.sock");
	const legacyOverride = resolve(baseDir, "legacy.sock");
	const previousOverride = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	const previousLegacy = process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH;
	const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	const previousHomeDir = process.env.HOME;

	try {
		process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = override;
		process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH = legacyOverride;
		assert.equal(resolveHostServiceSocketPath(), override);

		delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		process.env.XDG_RUNTIME_DIR = runtimeDir;
		assert.equal(resolveHostServiceSocketPath(), join(runtimeDir, "tex-actions", "host-service.sock"));

		assert.equal(resolveHostServiceSocketPath({ platform: "linux", runtimeDir, homeDir }), join(runtimeDir, "tex-actions", "host-service.sock"));
		assert.equal(resolveHostServiceSocketPath({ platform: "darwin", homeDir }), join(homeDir, "Library", "Caches", "tex-actions", "host-service.sock"));

		delete process.env.XDG_RUNTIME_DIR;
		delete process.env.HOME;
		assert.equal(resolveHostServiceSocketPath({ platform: "linux", runtimeDir: undefined, homeDir: undefined, fallbackDir }), join(fallbackDir, "tex-actions", "host-service.sock"));
	} finally {
		if (previousOverride === undefined) {
			delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		} else {
			process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = previousOverride;
		}
		if (previousLegacy === undefined) {
			delete process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH;
		} else {
			process.env.PDF_PREVIEW_HOST_SERVICE_SOCKET_PATH = previousLegacy;
		}
		if (previousRuntimeDir === undefined) {
			delete process.env.XDG_RUNTIME_DIR;
		} else {
			process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
		}
		if (previousHomeDir === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHomeDir;
		}
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service refuses symlinked socket directory paths", async () => {
	const baseDir = temporaryDir("host-service-socket-symlink-");
	const realDir = join(baseDir, "real");
	const linkDir = join(baseDir, "socket-dir");
	mkdirSync(realDir, { recursive: true, mode: 0o700 });
	symlinkSync(realDir, linkDir);
	const socketPath = join(linkDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "tex-actions-socket-safety-test" });
	await assert.rejects(
		() => server.start(),
		/host service path is a symlink/, 
	);
	rmSync(baseDir, { recursive: true, force: true });
});


test("tex-actionsctl daemon command starts and serves the host service", async () => {
	const baseDir = mkdtempSync("/tmp/tex-actionsctl-daemon-");
	const socketPath = join(baseDir, "host-service.sock");
	const scriptPath = resolve(process.cwd(), "scripts", "tex-actionsctl.ts");
	const child = spawn(process.execPath, [scriptPath, "daemon", "--socket", socketPath], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			XDG_RUNTIME_DIR: baseDir,
		},
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});

	try {
		await waitForSocket(socketPath);
		await waitForStatus(socketPath);

		const statusClient = new HostServiceClient({ socketPath, requestTimeoutMs: 500 });
		const status = await statusClient.requestStatus({ cwd: baseDir });
		assert.equal(status.service_name, "tex-actions-host-service");
		assert.match(stdout, /TeX Actions host service running/);
		assert.equal(stderr, "");
	} finally {
		child.kill("SIGTERM");
		await new Promise<void>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", () => {
				resolveExit();
			});
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
});

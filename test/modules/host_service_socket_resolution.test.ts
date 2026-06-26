import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HOST_SERVICE_SOCKET_PATH_ENV_VAR,
	resolveHostServiceSocketPath,
} from "../../src/modules/host_service.ts";

function temporaryDir(prefix: string): string {
	return mkdtempSync(join(process.cwd(), prefix));
}

function assertResolvedSocketPath(): void {
	const baseDir = temporaryDir("host-service-socket-resolution-");
	const runtimeDir = join(baseDir, "runtime");
	const homeDir = join(baseDir, "home");
	const fallbackDir = join(baseDir, "fallback");
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	mkdirSync(homeDir, { recursive: true, mode: 0o700 });
	mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });

	const override = resolve(baseDir, "explicit.sock");
	const previousOverride = process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
	const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	const previousHomeDir = process.env.HOME;

	try {
		process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = override;
		assert.equal(resolveHostServiceSocketPath(), override);

		delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		process.env.XDG_RUNTIME_DIR = runtimeDir;
		assert.equal(resolveHostServiceSocketPath(), join(runtimeDir, "tex-actions", "host-service.sock"));
		assert.equal(
			resolveHostServiceSocketPath({ platform: "linux", runtimeDir, homeDir }),
			join(runtimeDir, "tex-actions", "host-service.sock"),
		);
		assert.equal(
			resolveHostServiceSocketPath({ platform: "darwin", homeDir }),
			join(homeDir, "Library", "Caches", "tex-actions", "host-service.sock"),
		);

		delete process.env.XDG_RUNTIME_DIR;
		delete process.env.HOME;
		assert.equal(
			resolveHostServiceSocketPath({ platform: "linux", runtimeDir: undefined, homeDir: undefined, fallbackDir }),
			join(fallbackDir, "tex-actions", "host-service.sock"),
		);
	} finally {
		if (previousOverride === undefined) {
			delete process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR];
		} else {
			process.env[HOST_SERVICE_SOCKET_PATH_ENV_VAR] = previousOverride;
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
}

test("host service socket resolver supports override, platform defaults, and fallback", () => {
	assertResolvedSocketPath();
});

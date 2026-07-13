import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { findExecutable, MACTEX_BIN_DIR, resolveExecutable, executableSearchPath } from "../../src/modules/executable_resolution.ts";
import { parseDarwinProcessIdentity } from "../../src/modules/agent_runtime_context.ts";
import { resolveSystemBrowserOpenConfig } from "../../src/modules/viewer_host_client.ts";

test("macOS browser opener uses open", () => {
	assert.deepEqual(resolveSystemBrowserOpenConfig("http://127.0.0.1/viewer", {}, "darwin"), {
		command: "open",
		args: ["http://127.0.0.1/viewer"],
	});
});

test("macOS TeX discovery falls back to the MacTeX bin directory", () => {
	const latexmk = join(MACTEX_BIN_DIR, "latexmk");
	const executable = (path: string) => path === latexmk;
	assert.equal(findExecutable("latexmk", { platform: "darwin", path: "/usr/bin:/bin", isExecutable: executable }), latexmk);
	assert.equal(resolveExecutable("latexmk", { platform: "darwin", path: "/usr/bin:/bin", isExecutable: executable }), latexmk);
	assert.equal(resolveExecutable("latexmk", { platform: "linux", path: "/usr/bin:/bin", isExecutable: executable }), "latexmk");
	assert.equal(executableSearchPath({ platform: "darwin", path: "/usr/bin:/bin" }), `/usr/bin:/bin:${MACTEX_BIN_DIR}`);
});

test("Darwin ps lineage output provides stable parent and start-time identity", () => {
	assert.deepEqual(parseDarwinProcessIdentity(42, "  7 Mon Jul 13 10:11:12 2026\n"), {
		pid: 42,
		ppid: 7,
		startTime: "Mon-Jul-13-10:11:12-2026",
	});
	assert.equal(parseDarwinProcessIdentity(42, ""), undefined);
});

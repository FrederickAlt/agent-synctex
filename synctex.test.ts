import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createSynctexCallbackArgv,
	createSynctexCallbackCommand,
	formatSynctexPasteBlock,
	SynctexCallbackServer,
} from "./synctex.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "synctex-test-"));
}

function runCallbackProcess(argv: string[]): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(argv[0], argv.slice(1), {
			cwd: process.cwd(),
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (exitCode) => resolvePromise({ exitCode, stderr }));
	});
}

function runCallbackScript(args: string[]): Promise<{ exitCode: number | null; stderr: string }> {
	return runCallbackProcess([process.execPath, "scripts/pi_synctex_callback.mjs", ...args]);
}

function parseZathuraEditorCommandTemplate(command: string): string[] {
	const script = "import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))";
	const result = spawnSync("python3", ["-c", script, command], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as string[];
}

test("formatSynctexPasteBlock uses cwd-relative paths and includes the source line", () => {
	const dir = tempDir();
	const cwd = join(dir, "project");
	const source = join(cwd, "src", "main.tex");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(source, "first line\nsecond line\nthird line\n", { flag: "wx" });

	assert.equal(
		formatSynctexPasteBlock({ file: source, line: 2 }, cwd),
		"PDF click: src/main.tex:2\nsecond line\n\n",
	);
});

test("formatSynctexPasteBlock keeps paths relative to cwd for files outside the project", () => {
	const dir = tempDir();
	const cwd = join(dir, "project");
	const source = join(dir, "shared", "main.tex");
	mkdirSync(join(dir, "shared"), { recursive: true });
	writeFileSync(source, "outside\n", { flag: "wx" });

	assert.equal(
		formatSynctexPasteBlock({ file: source, line: 1 }, cwd),
		"PDF click: ../shared/main.tex:1\noutside\n\n",
	);
});

test("formatSynctexPasteBlock omits the source line when it cannot be read", () => {
	const dir = tempDir();
	const cwd = join(dir, "project");

	assert.equal(
		formatSynctexPasteBlock({ file: join(cwd, "missing.tex"), line: 10 }, cwd),
		"PDF click: missing.tex:10\n\n",
	);
});

test("createSynctexCallbackCommand returns a Zathura placeholder command with session socket and token", () => {
	const command = createSynctexCallbackCommand({
		nodePath: "/usr/bin/node",
		callbackScriptPath: "/tmp/pi synctex/callback.mjs",
		socketPath: "/tmp/pi-synctex.sock",
		token: "abc123",
	});

	assert.equal(
		command,
		"'/usr/bin/node' '/tmp/pi synctex/callback.mjs' '--socket' '/tmp/pi-synctex.sock' '--token' 'abc123' '--file' '%{input}' '--line' '%{line}'",
	);
});

test("createSynctexCallbackArgv keeps Zathura placeholders as whole argv tokens", () => {
	assert.deepEqual(createSynctexCallbackArgv({
		nodePath: "/usr/bin/node",
		callbackScriptPath: "/tmp/callback.mjs",
		socketPath: "/tmp/pi-synctex.sock",
		token: "abc123",
	}), [
		"/usr/bin/node",
		"/tmp/callback.mjs",
		"--socket",
		"/tmp/pi-synctex.sock",
		"--token",
		"abc123",
		"--file",
		"%{input}",
		"--line",
		"%{line}",
	]);
});

test("callback script forwards clicks to only the matching session token", async () => {
	const dir = tempDir();
	const cwd = join(dir, "project");
	const source = join(cwd, "main.tex");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(source, "alpha\nbeta\n", { flag: "wx" });

	const pasted: string[] = [];
	const server = new SynctexCallbackServer({
		tmpDir: dir,
		callbackScriptPath: resolve("scripts/pi_synctex_callback.mjs"),
		nodePath: process.execPath,
	});
	await server.ensureStarted({
		cwd,
		hasUI: true,
		ui: {
			pasteToEditor(text: string) {
				pasted.push(text);
			},
		},
	});

	try {
		const rejected = await runCallbackScript([
			"--socket",
			server.socketPath,
			"--token",
			"wrong-token",
			"--file",
			source,
			"--line",
			"2",
		]);
		assert.equal(rejected.exitCode, 1);
		assert.match(rejected.stderr, /invalid token/);
		assert.deepEqual(pasted, []);

		const accepted = await runCallbackScript([
			"--socket",
			server.socketPath,
			"--token",
			server.token,
			"--file",
			source,
			"--line",
			"2",
		]);
		assert.equal(accepted.exitCode, 0);
		assert.deepEqual(pasted, ["PDF click: main.tex:2\nbeta\n\n"]);
	} finally {
		await server.close();
	}
});

test("callback invocation handles substituted paths containing quotes, spaces, and shell metacharacters", async () => {
	const dir = tempDir();
	const cwd = join(dir, "project with spaces");
	const sourceName = "quote ' and \"double\" $dollar;$(touch pwned)&.tex";
	const source = join(cwd, sourceName);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(source, "strange path line\n", { flag: "wx" });

	const pasted: string[] = [];
	const server = new SynctexCallbackServer({
		tmpDir: dir,
		callbackScriptPath: resolve("scripts/pi_synctex_callback.mjs"),
		nodePath: process.execPath,
	});
	await server.ensureStarted({
		cwd,
		hasUI: true,
		ui: {
			pasteToEditor(text: string) {
				pasted.push(text);
			},
		},
	});

	try {
		const command = createSynctexCallbackCommand({
			nodePath: process.execPath,
			callbackScriptPath: resolve("scripts/pi_synctex_callback.mjs"),
			socketPath: server.socketPath,
			token: server.token,
		});
		const argvTemplate = parseZathuraEditorCommandTemplate(command);
		assert.equal(argvTemplate[argvTemplate.indexOf("--file") + 1], "%{input}");
		assert.equal(argvTemplate[argvTemplate.indexOf("--line") + 1], "%{line}");
		const argv = argvTemplate.map((arg) => arg.replaceAll("%{input}", source).replaceAll("%{line}", "1"));
		const result = await runCallbackProcess(argv);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.deepEqual(pasted, [`PDF click: ${sourceName}:1\nstrange path line\n\n`]);
	} finally {
		await server.close();
	}
});

test("closing a callback server invalidates its command and new sessions rotate endpoints", async () => {
	const dir = tempDir();
	const first = new SynctexCallbackServer({
		tmpDir: dir,
		callbackScriptPath: resolve("scripts/pi_synctex_callback.mjs"),
		nodePath: process.execPath,
	});
	await first.ensureStarted({ cwd: dir, hasUI: false });
	const firstSocket = first.socketPath;
	const firstToken = first.token;
	const firstCommand = first.command;
	await first.close();

	const stale = await runCallbackScript([
		"--socket",
		firstSocket,
		"--token",
		firstToken,
		"--file",
		join(dir, "main.tex"),
		"--line",
		"1",
	]);
	assert.equal(stale.exitCode, 1);
	await assert.rejects(
		() => first.ensureStarted({ cwd: dir, hasUI: false }),
		/closed/,
	);

	const second = new SynctexCallbackServer({
		tmpDir: dir,
		callbackScriptPath: resolve("scripts/pi_synctex_callback.mjs"),
		nodePath: process.execPath,
	});
	await second.ensureStarted({ cwd: dir, hasUI: false });
	try {
		assert.notEqual(second.socketPath, firstSocket);
		assert.notEqual(second.token, firstToken);
		assert.notEqual(second.command, firstCommand);
	} finally {
		await second.close();
	}
});

test("callback server does not paste or submit in headless sessions", async () => {
	const dir = tempDir();
	const server = new SynctexCallbackServer({
		tmpDir: dir,
		callbackScriptPath: resolve("scripts/pi_synctex_callback.mjs"),
		nodePath: process.execPath,
	});
	await server.ensureStarted({ cwd: dir, hasUI: false });

	try {
		const result = await runCallbackScript([
			"--socket",
			server.socketPath,
			"--token",
			server.token,
			"--file",
			join(dir, "main.tex"),
			"--line",
			"1",
		]);
		assert.equal(result.exitCode, 0);
	} finally {
		await server.close();
	}
});

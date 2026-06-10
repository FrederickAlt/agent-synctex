import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	FakeViewerBackend,
	HostServiceClient,
	HostServiceContinuousCompileManager,
	HostServicePdfIdRegistry,
	HostServiceServer,
	HostServiceSessionLeaseService,
} from "../../src/modules/host_service.ts";
import type { ContinuousCompileNotificationSink, ContinuousCompileSpawnOptions } from "../../src/modules/host_service_continuous_compile.ts";
import { LATEXMK_CONTINUOUS_EVENT_PREFIX, LATEXMK_CONTINUOUS_POLL_INTERVAL_SECONDS } from "../../src/modules/latex/latex_file_compiler.ts";

class CoherentPdfOpenBackend extends FakeViewerBackend {
	readonly openedPdfContents: string[] = [];

	async open(requestId: string, details: Record<string, unknown>) {
		this.openedPdfContents.push(readFileSync(String(details.pdf_path), "utf8"));
		return super.open(requestId, details);
	}
}

class FakeContinuousProcess extends EventEmitter {
	readonly pid: number;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
	private readonly autoExitSignals: Set<NodeJS.Signals | number | undefined>;
	killed = false;
	killSignal: NodeJS.Signals | number | undefined;

	constructor(pid: number, autoExitSignals = new Set<NodeJS.Signals | number | undefined>()) {
		super();
		this.pid = pid;
		this.autoExitSignals = autoExitSignals;
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		this.killSignal = signal;
		this.killSignals.push(signal);
		if (this.autoExitSignals.has(signal)) {
			queueMicrotask(() => this.emit("exit", null, typeof signal === "string" ? signal : null));
		}
		return true;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500, intervalMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await sleep(intervalMs);
	}
	assert.equal(predicate(), true);
}

class CountingSessionLeaseService extends HostServiceSessionLeaseService {
	pruneCount = 0;

	override pruneExpired(): string[] {
		this.pruneCount += 1;
		return super.pruneExpired();
	}
}

function makeFakeContinuousManager(options: {
	commandExists?: boolean;
	notificationSink?: ContinuousCompileNotificationSink;
	shutdownGraceMs?: number;
	shutdownForceMs?: number;
	autoExitSignals?: Array<NodeJS.Signals | number | undefined>;
} = {}) {
	let nextPid = 20_000;
	const processes: FakeContinuousProcess[] = [];
	const spawns: Array<{ command: string; args: string[]; options: ContinuousCompileSpawnOptions }> = [];
	const manager = new HostServiceContinuousCompileManager({
		...options,
		commandExists: () => options.commandExists ?? true,
		spawnProcess(command, args, spawnOptions) {
			const child = new FakeContinuousProcess(nextPid++, new Set(options.autoExitSignals ?? ["SIGTERM"]));
			processes.push(child);
			spawns.push({ command, args: [...args], options: spawnOptions });
			return child;
		},
	});
	return { manager, processes, spawns };
}

function temporaryDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeFakeLatexCompiler(binDir: string, options: { delaySeconds?: string } = {}): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(compilerPath, `#!/bin/sh
set -eu
${options.delaySeconds ? `sleep ${options.delaySeconds}\n` : ""}tex_file=""
for arg in "$@"; do
  tex_file="$arg"
done
base="${"${tex_file##*/}"}"
name="${"${base%.*}"}"
out_dir="$(dirname "$tex_file")"
printf 'fake compiler output\n' > "$out_dir/$name.log"
printf '%s' '%PDF-1.4\n' > "$out_dir/$name.pdf"
exit 0
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
}

function writeFailingLatexCompiler(binDir: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(compilerPath, `#!/bin/sh
set -eu
tex_file=""
for arg in "$@"; do
  tex_file="$arg"
done
base="${"${tex_file##*/}"}"
name="${"${base%.*}"}"
out_dir="$(dirname "$tex_file")"
printf 'intentional compile failure\n' > "$out_dir/$name.log"
exit 7
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
}

function writeLatexmkThatLeavesExistingPdfUntouched(binDir: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(compilerPath, `#!/bin/sh
set -eu
tex_file=""
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) tex_file="$arg" ;;
  esac
done
base="${"${tex_file##*/}"}"
name="${"${base%.*}"}"
out_dir="$(dirname "$tex_file")"
printf 'Latexmk: applying rule lualatex\nOutput written on %s.pdf (1 page, 123 bytes).\n' "$name" > "$out_dir/$name.log"
if [ ! -f "$out_dir/$name.pdf" ]; then
  printf '%s' '%PDF-1.4\n' > "$out_dir/$name.pdf"
fi
exit 0
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
}

function writeRecordingLatexmk(binDir: string, recordPath: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(compilerPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + "\\n");
const source = args[args.length - 1];
if (!source) process.exit(1);
const sourceBase = path.basename(source, ".tex");
const outDir = path.resolve(process.cwd(), path.dirname(source));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, sourceBase + ".log"), "Output written on " + sourceBase + ".pdf (1 page, 123 bytes).\\n");
fs.writeFileSync(path.join(outDir, sourceBase + ".pdf"), "%PDF-1.4\\n");
process.exit(0);
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
}

function writeNoopLatexmk(binDir: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(compilerPath, `#!/bin/sh
set -eu
exit 0
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
}

function writeUpToDateNoopLatexmk(binDir: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(compilerPath, `#!/bin/sh
set -eu
tex_file=""
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) tex_file="$arg" ;;
  esac
done
base="${"${tex_file##*/}"}"
name="${"${base%.*}"}"
printf "Latexmk: Nothing to do for '%s'.\n" "$base"
printf "Latexmk: All targets (%s.pdf) are up-to-date\n" "$name"
exit 0
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
}

function writeContinuousRecorderArtifacts(root: string, options: { log?: string; pdf?: boolean } = {}): void {
	const rootDir = dirname(root);
	const rootName = basename(root, ".tex");
	const logPath = join(rootDir, `${rootName}.log`);
	const pdfPath = join(rootDir, `${rootName}.pdf`);
	const flsPath = join(rootDir, `${rootName}.fls`);
	writeFileSync(logPath, options.log ?? `Output written on ${rootName}.pdf (1 page, 123 bytes).\n`);
	if (options.pdf !== false) {
		writeFileSync(pdfPath, "%PDF-1.4\n");
	} else {
		rmSync(pdfPath, { force: true });
	}
	writeFileSync(flsPath, [
		`PWD ${rootDir}`,
		`INPUT ${root}`,
		`OUTPUT ${logPath}`,
		...(options.pdf === false ? [] : [`OUTPUT ${pdfPath}`]),
		`OUTPUT ${flsPath}`,
		"",
	].join("\n"));
}

function emitContinuousEvent(process: FakeContinuousProcess, event: "compiling" | "success" | "warning" | "failure"): void {
	process.stdout.write(`${LATEXMK_CONTINUOUS_EVENT_PREFIX}${event}\n`);
}

function encodeMcpFrame(jsonText: string): string {
	return `Content-Length: ${Buffer.byteLength(jsonText, "utf8")}\r\n\r\n${jsonText}`;
}

async function sendFramedRequest(socketPath: string, payload: string): Promise<unknown> {
	return await new Promise((resolve, reject) => {
		const socket = createConnection({ path: socketPath });
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("timed out waiting for MCP response"));
		}, 2_000);
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const separator = buffer.indexOf("\r\n\r\n");
			if (separator < 0) return;
			const header = buffer.slice(0, separator);
			const match = header.match(/Content-Length: (\d+)/i);
			if (!match) return;
			const length = Number(match[1]);
			const body = buffer.slice(separator + 4);
			if (Buffer.byteLength(body, "utf8") < length) return;
			clearTimeout(timer);
			socket.end();
			resolve(JSON.parse(body.slice(0, length)) as unknown);
		});
		socket.write(encodeMcpFrame(payload));
	});
}

async function withCompileServer<T>(
	fixture: ReturnType<typeof makeFakeContinuousManager>,
	fn: (client: HostServiceClient, baseDir: string, server: HostServiceServer, socketPath: string) => Promise<T>,
	options: { leaseTtlMs?: number; nowNs?: () => number; viewerBackend?: FakeViewerBackend; managedViewerRecords?: HostServicePdfIdRegistry; sessionPruneIntervalMs?: number; sessionLeases?: HostServiceSessionLeaseService; compilerDelaySeconds?: string } = {},
): Promise<T> {
	const baseDir = temporaryDir("host-service-continuous-compile-");
	const socketPath = join(baseDir, "host-service.sock");
	const binDir = join(baseDir, "bin");
	writeFakeLatexCompiler(binDir, { delaySeconds: options.compilerDelaySeconds });
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}hi\\end{document}\n");
	const originalPath = process.env.PATH ?? "";
	process.env.PATH = `${binDir}:${originalPath}`;
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: options.viewerBackend ?? new FakeViewerBackend(),
		managedViewerRecords: options.managedViewerRecords,
		sessionLeases: options.sessionLeases ?? (options.leaseTtlMs === undefined && options.nowNs === undefined
			? undefined
			: new HostServiceSessionLeaseService({ leaseTtlMs: options.leaseTtlMs, nowNs: options.nowNs })),
		continuousCompileManager: fixture.manager,
		sessionPruneIntervalMs: options.sessionPruneIntervalMs,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		return await fn(client, baseDir, server, socketPath);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
}

test("continuous compile manager enforces singleton processes and subscriber lifecycle", async () => {
	const fixture = makeFakeContinuousManager();
	const root = "/tmp/project/main.tex";

	const first = fixture.manager.ensureSubscription(root, "session-A", "lualatex");
	assert.equal(first.status, "started");
	assert.equal(first.subscriber_count, 1);
	assert.equal(fixture.spawns.length, 1);
	assert.deepEqual(fixture.spawns[0]?.args.slice(0, 5), ["-pvc", "-e", fixture.spawns[0]?.args[2], "-norc", "-view=none"]);
	assert.match(fixture.spawns[0]?.args[2] ?? "", new RegExp(`\\$sleep_time = ${LATEXMK_CONTINUOUS_POLL_INTERVAL_SECONDS}`));

	const repeated = fixture.manager.ensureSubscription(root, "session-A", "lualatex");
	assert.equal(repeated.status, "already_active");
	assert.equal(repeated.subscriber_count, 1);
	assert.equal(fixture.spawns.length, 1);

	const mismatchedEngine = fixture.manager.ensureSubscription(root, "session-pdftex", "pdflatex");
	assert.equal(mismatchedEngine.status, "error");
	assert.equal(mismatchedEngine.error_code, "continuous_compiler_engine_mismatch");
	assert.equal(mismatchedEngine.subscriber_count, 1);
	assert.equal(fixture.spawns.length, 1);

	const secondSession = fixture.manager.ensureSubscription(root, "session-B", "lualatex");
	assert.equal(secondSession.status, "already_active");
	assert.equal(secondSession.subscriber_count, 2);
	assert.equal(fixture.spawns.length, 1);

	const removedOne = await fixture.manager.removeSubscription(root, "session-A");
	assert.equal(removedOne.status, "still_active_for_other_subscribers");
	assert.equal(removedOne.subscriber_count, 1);
	assert.equal(fixture.processes[0]?.killed, false);

	const removedLast = await fixture.manager.removeSubscription(root, "session-B");
	assert.equal(removedLast.status, "stopped");
	assert.equal(removedLast.subscriber_count, 0);
	assert.equal(fixture.processes[0]?.killed, true);
});

test("continuous latexmk invocation uses preview-continuous, no-viewer, recorder, SyncTeX, and safe engine flags", () => {
	const expectedEngineArgs: Record<string, string[]> = {
		lualatex: ["-pdf", "-lualatex", "-pdflualatex=lualatex -no-shell-escape %O %S"],
		latexmk: ["-pdf", "-lualatex", "-pdflualatex=lualatex -no-shell-escape %O %S"],
		pdflatex: ["-pdf", "-pdflatex=pdflatex -no-shell-escape %O %S"],
		xelatex: ["-pdfxe", "-xelatex=xelatex -no-shell-escape %O %S"],
	};

	for (const [compiler, engineArgs] of Object.entries(expectedEngineArgs)) {
		const fixture = makeFakeContinuousManager();
		const root = `/tmp/project/${compiler}.tex`;
		fixture.manager.ensureSubscription(root, `session-${compiler}`, compiler);
		assert.equal(fixture.spawns.length, 1);
		const spawn = fixture.spawns[0];
		assert.equal(spawn?.command, "latexmk");
		assert.equal(spawn?.options.cwd, "/tmp/project");
		assert.deepEqual(spawn?.args.slice(0, 2), ["-pvc", "-e"]);
		assert.match(spawn?.args[2] ?? "", new RegExp(`\\$sleep_time = ${LATEXMK_CONTINUOUS_POLL_INTERVAL_SECONDS}`));
		for (const event of ["compiling", "success", "warning", "failure"] as const) {
			assert.match(spawn?.args[2] ?? "", new RegExp(`${LATEXMK_CONTINUOUS_EVENT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}%s\\\\n' ${event}`));
		}
		assert.deepEqual(spawn?.args.slice(3), [
			"-norc",
			"-view=none",
			"-recorder",
			"-synctex=1",
			"-interaction=nonstopmode",
			"-halt-on-error",
			"-file-line-error",
			...engineArgs,
			`${compiler}.tex`,
		]);
		assert.equal(spawn?.args.some((arg) => /(?:^|\s)-shell-escape(?:\s|$)/.test(arg)), false);
	}
});

test("continuous latexmk invocation protects option-looking root filenames", () => {
	const fixture = makeFakeContinuousManager();
	fixture.manager.ensureSubscription("/tmp/project/-paper.tex", "session-option", "lualatex");

	assert.equal(fixture.spawns.length, 1);
	const spawn = fixture.spawns[0];
	assert.equal(spawn?.options.cwd, "/tmp/project");
	assert.equal(spawn?.args.at(-1), "./-paper.tex");
	assert.deepEqual(spawn?.args.slice(0, 10), [
		"-pvc",
		"-e",
		spawn?.args[2],
		"-norc",
		"-view=none",
		"-recorder",
		"-synctex=1",
		"-interaction=nonstopmode",
		"-halt-on-error",
		"-file-line-error",
	]);
	assert.match(spawn?.args[2] ?? "", new RegExp(`\\$sleep_time = ${LATEXMK_CONTINUOUS_POLL_INTERVAL_SECONDS}`));
});

test("one-shot compile_latex_file invokes latexmk without pvc and maps selected engines", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);

		for (const compiler of ["lualatex", "pdflatex", "xelatex", "latexmk"] as const) {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler }, { cwd: baseDir, session_id: `session-${compiler}` });
		}

		const invocations = readFileSync(recordPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		assert.equal(invocations.length, 4);
		assert.deepEqual(invocations.map((args) => args.includes("-pvc")), [false, false, false, false]);
		assert.deepEqual(invocations.map((args) => args.slice(0, 7)), [
			["-norc", "-view=none", "-recorder", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error"],
			["-norc", "-view=none", "-recorder", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error"],
			["-norc", "-view=none", "-recorder", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error"],
			["-norc", "-view=none", "-recorder", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error"],
		]);
		assert.deepEqual(invocations.map((args) => args.slice(7, -1)), [
			["-pdf", "-lualatex", "-pdflualatex=lualatex -no-shell-escape %O %S"],
			["-pdf", "-pdflatex=pdflatex -no-shell-escape %O %S"],
			["-pdfxe", "-xelatex=xelatex -no-shell-escape %O %S"],
			["-pdf", "-lualatex", "-pdflualatex=lualatex -no-shell-escape %O %S"],
		]);
		assert.deepEqual(invocations.map((args) => args.at(-1)), ["paper.tex", "paper.tex", "paper.tex", "paper.tex"]);
		assert.equal(invocations.some((args) => args.some((arg) => /(?:^|\s)-shell-escape(?:\s|$)/.test(arg))), false);
	});
});

test("one-shot compile waits for active compatible continuous cycle without spawning another latexmk", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);
		const root = join(baseDir, "paper.tex");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		emitContinuousEvent(fixture.processes[0]!, "compiling");
		assert.equal(fixture.manager.cycleState(root), "compiling");

		let settled = false;
		const oneShot = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir, session_id: "session-A" })
			.finally(() => {
				settled = true;
			});
		await sleep(50);
		assert.equal(settled, false);

		writeContinuousRecorderArtifacts(root);
		emitContinuousEvent(fixture.processes[0]!, "success");
		const result = await oneShot;
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
		assert.equal(result.compile_status, "ok");
		assert.equal(fixture.manager.cycleState(root), "idle");

		const invocations = readFileSync(recordPath, "utf8").trim().split("\n");
		assert.equal(invocations.length, 1);
	});
});

test("one-shot compile immediately returns fresh idle continuous result", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);
		const root = join(baseDir, "paper.tex");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		emitContinuousEvent(fixture.processes[0]!, "compiling");
		writeContinuousRecorderArtifacts(root, { log: "LaTeX Warning: Reference `x' undefined on input line 1.\nOutput written on paper.pdf (1 page, 123 bytes).\n" });
		emitContinuousEvent(fixture.processes[0]!, "warning");

		const result = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir, session_id: "session-A" });
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
		assert.equal(result.compile_status, "ok_with_warnings");
		assert.equal(result.warning_count, 1);
		assert.equal(readFileSync(recordPath, "utf8").trim().split("\n").length, 1);
	});
});

test("one-shot compile waits for next continuous result when inputs changed after idle result", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);
		const root = join(baseDir, "paper.tex");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		emitContinuousEvent(fixture.processes[0]!, "compiling");
		writeContinuousRecorderArtifacts(root);
		emitContinuousEvent(fixture.processes[0]!, "success");
		writeFileSync(root, "\\documentclass{article}\n\\begin{document}changed\\end{document}\n");

		let settled = false;
		const oneShot = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir, session_id: "session-A" })
			.finally(() => {
				settled = true;
			});
		await sleep(50);
		assert.equal(settled, false);

		emitContinuousEvent(fixture.processes[0]!, "compiling");
		writeContinuousRecorderArtifacts(root);
		emitContinuousEvent(fixture.processes[0]!, "success");
		const result = await oneShot;
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
		assert.equal(readFileSync(recordPath, "utf8").trim().split("\n").length, 1);
	});
});

test("one-shot compile rejects active continuous compiler mismatch without spawning latexmk", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);
		const root = join(baseDir, "paper.tex");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		emitContinuousEvent(fixture.processes[0]!, "compiling");
		writeContinuousRecorderArtifacts(root);
		emitContinuousEvent(fixture.processes[0]!, "success");

		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "pdflatex" }, { cwd: baseDir, session_id: "session-A" });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /active.*compiler lualatex/i);
		assert.match(observed.message, /use the active compiler or stop continuous compilation first/i);
		assert.equal((observed as { statusDetails?: { error_code?: string } }).statusDetails?.error_code, "continuous_compiler_engine_mismatch");
		assert.equal(readFileSync(recordPath, "utf8").trim().split("\n").length, 1);
	});
});

test("MCP compile_latex_file mismatch response preserves agent-facing guidance and details", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir, _server, socketPath) => {
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		const response = await sendFramedRequest(socketPath, JSON.stringify({
			jsonrpc: "2.0",
			id: 91,
			method: "tools/call",
			params: {
				name: "compile_latex_file",
				arguments: {
					latex_file_path: "paper.tex",
					compiler: "pdflatex",
					workspace_context: { cwd: baseDir, session_id: "session-A" },
				},
			},
		})) as { result?: { isError?: boolean; content: Array<{ text: string }>; details?: { error_code?: string } } };

		assert.equal(response.result?.isError, true);
		assert.match(response.result?.content[0]?.text ?? "", /active.*compiler lualatex/i);
		assert.match(response.result?.content[0]?.text ?? "", /use the active compiler or stop continuous compilation first/i);
		assert.equal(response.result?.details?.error_code, "continuous_compiler_engine_mismatch");
	});
});

test("continuous lifecycle failure event resolves one-shot wait without freshness metadata", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const root = join(baseDir, "paper.tex");
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		emitContinuousEvent(fixture.processes[0]!, "compiling");
		const oneShot = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir, session_id: "session-A" });
		await sleep(50);

		writeFileSync(join(baseDir, "paper.log"), "! Undefined control sequence.\nl.1 \\bad\n");
		rmSync(join(baseDir, "paper.fls"), { force: true });
		emitContinuousEvent(fixture.processes[0]!, "failure");

		let observed: unknown;
		try {
			await oneShot;
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /Undefined control sequence|continuous compile failed/);
		assert.equal((observed as { statusDetails?: { error_code?: string; diagnostics?: unknown[] } }).statusDetails?.error_code, "compile_failed");
		assert.ok(((observed as { statusDetails?: { diagnostics?: unknown[] } }).statusDetails?.diagnostics?.length ?? 0) > 0);
		assert.equal(fixture.manager.cycleState(root), "idle");
	});
});


test("clean=true with active continuous stops, cleans, restarts subscribers, and waits for post-clean result", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);
		const root = join(baseDir, "paper.tex");
		const pdf = join(baseDir, "paper.pdf");
		const log = join(baseDir, "paper.log");
		const aux = join(baseDir, "paper.aux");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "pdflatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		fixture.manager.ensureSubscription(root, "session-B", "pdflatex");
		writeFileSync(pdf, "old pdf");
		writeFileSync(log, "old log");
		writeFileSync(aux, "old aux");

		const clean = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "pdflatex", clean: true }, { cwd: baseDir, session_id: "session-A" });
		await waitUntil(() => fixture.processes.length === 2);

		assert.equal(fixture.processes[0]?.killed, true);
		assert.equal(existsSync(pdf), false, "PDF should be deleted before the restarted continuous compiler reports a result");
		assert.equal(existsSync(log), false);
		assert.equal(existsSync(aux), false);
		assert.deepEqual(fixture.spawns[1]?.args.slice(10, -1), ["-pdf", "-pdflatex=pdflatex -no-shell-escape %O %S"]);

		writeContinuousRecorderArtifacts(root, { log: "LaTeX Warning: Reference `after-clean' undefined on input line 1.\nOutput written on paper.pdf (1 page, 123 bytes).\n" });
		emitContinuousEvent(fixture.processes[1]!, "warning");
		const result = await clean;

		assert.equal(result.clean, true);
		assert.equal(result.cleaned_artifacts.includes(pdf), true);
		assert.equal(result.cleaned_artifacts.includes(log), true);
		assert.equal(result.cleaned_artifacts.includes(aux), true);
		assert.equal(result.compile_status, "ok_with_warnings");
		assert.equal(result.warning_count, 1);
		assert.equal(result.continuous?.status, "started");
		assert.equal(result.continuous?.subscriber_count, 2);
		assert.equal(fixture.manager.subscriberCount(root), 2);
		assert.equal(readFileSync(recordPath, "utf8").trim().split("\n").length, 1, "clean restart should not spawn a one-shot latexmk compile");

		const removedA = await fixture.manager.removeSubscription(root, "session-A");
		assert.equal(removedA.status, "still_active_for_other_subscribers");
		const removedB = await fixture.manager.removeSubscription(root, "session-B");
		assert.equal(removedB.status, "stopped");
	});
});

test("clean=true open_pdf waits for continuous restart result before managed viewer open", async () => {
	const fixture = makeFakeContinuousManager();
	const backend = new CoherentPdfOpenBackend();
	await withCompileServer(fixture, async (client, baseDir) => {
		const root = join(baseDir, "paper.tex");
		const pdf = join(baseDir, "paper.pdf");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		writeFileSync(pdf, "%PDF-1.4 old pdf\n");

		const cleanAndOpen = client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", clean: true, open_pdf: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		await waitUntil(() => fixture.processes.length === 2);
		assert.deepEqual(backend.openedPdfContents, [], "managed viewer should not open while clean/restart coordination is still pending");
		assert.equal(existsSync(pdf), false, "old PDF should be removed before the restarted compiler result");

		writeContinuousRecorderArtifacts(root);
		writeFileSync(pdf, "%PDF-1.4 post-clean coherent pdf\n");
		emitContinuousEvent(fixture.processes[1]!, "success");
		const result = await cleanAndOpen;

		assert.equal(Number.isInteger(result.pdf_id ?? 0) && (result.pdf_id ?? 0) > 0, true);
		assert.deepEqual(backend.openedPdfContents, ["%PDF-1.4 post-clean coherent pdf\n"]);
	}, { viewerBackend: backend });
});

test("clean=true active continuous timeout leaves restarted subscribers active", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const root = join(baseDir, "paper.tex");
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		writeFileSync(join(baseDir, "paper.pdf"), "old pdf");

		const clean = client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", clean: true },
			{ cwd: baseDir, session_id: "session-A" },
			undefined,
			80,
		);
		await waitUntil(() => fixture.processes.length === 2);

		let observed: unknown;
		try {
			await clean;
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /timed out/);
		assert.match(observed.message, /cleaning\/restarting continuous compilation|clean\/restart/i);
		assert.match(observed.message, /waiting on active continuous compilation|continuous/i);
		assert.equal(fixture.processes[0]?.killed, true);
		assert.equal(fixture.processes[1]?.killed, false);
		assert.equal(fixture.manager.activeRootCount(), 1);
		assert.equal(fixture.manager.subscriberCount(root), 1);
	});
});

test("clean=true active continuous timeout during stop preserves artifacts and recovers subscribers", async () => {
	const fixture = makeFakeContinuousManager({ autoExitSignals: ["SIGKILL"], shutdownGraceMs: 200, shutdownForceMs: 20 });
	await withCompileServer(fixture, async (client, baseDir) => {
		const root = join(baseDir, "paper.tex");
		const pdf = join(baseDir, "paper.pdf");
		const log = join(baseDir, "paper.log");
		const aux = join(baseDir, "paper.aux");
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		fixture.manager.ensureSubscription(root, "session-B", "lualatex");
		writeFileSync(pdf, "old pdf");
		writeFileSync(log, "old log");
		writeFileSync(aux, "old aux");

		const clean = client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", clean: true },
			{ cwd: baseDir, session_id: "session-A" },
			undefined,
			50,
		);
		await waitUntil(() => fixture.processes[0]?.killSignals.includes("SIGTERM") === true);

		let observed: unknown;
		try {
			await clean;
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /timed out/);
		assert.match(observed.message, /cleaning\/restarting continuous compilation|clean\/restart/i);
		await waitUntil(() => fixture.manager.cycleState(root) === "idle" && fixture.manager.subscriberCount(root) === 2);
		await sleep(250);

		assert.equal(existsSync(pdf), true, "PDF must not be deleted after the request timeout aborts stop");
		assert.equal(existsSync(log), true);
		assert.equal(existsSync(aux), true);
		assert.equal(fixture.processes.length, 1, "abort during stop should not restart while the original process remains active");
		assert.deepEqual(fixture.processes[0]?.killSignals, ["SIGTERM"], "abort should cancel the stop budget before SIGKILL");
		assert.equal(fixture.manager.activeRootCount(), 1);
		assert.equal(fixture.manager.subscriberCount(root), 2);

		fixture.processes[0]!.emit("exit", null, "SIGTERM");
		await waitUntil(() => fixture.processes.length === 2 && fixture.manager.subscriberCount(root) === 2);
		assert.equal(existsSync(pdf), true, "PDF must not be deleted if the aborted stop exits later and subscribers are recovered");
		assert.equal(existsSync(log), true);
		assert.equal(existsSync(aux), true);
	});
});

test("clean=true active continuous reports post-clean compile failures with diagnostics", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const root = join(baseDir, "paper.tex");
		const pdf = join(baseDir, "paper.pdf");
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		writeFileSync(pdf, "old pdf");

		const clean = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", clean: true }, { cwd: baseDir, session_id: "session-A" });
		await waitUntil(() => fixture.processes.length === 2);
		writeFileSync(join(baseDir, "paper.log"), "! Undefined control sequence.\nl.1 \\bad\n");
		rmSync(join(baseDir, "paper.fls"), { force: true });
		emitContinuousEvent(fixture.processes[1]!, "failure");

		let observed: unknown;
		try {
			await clean;
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /Undefined control sequence|continuous compile failed/);
		const details = (observed as { statusDetails?: { error_code?: string; cleaned_artifacts?: string[]; diagnostics?: unknown[] } }).statusDetails;
		assert.equal(details?.error_code, "compile_failed");
		assert.equal(details?.cleaned_artifacts?.includes(pdf), true);
		assert.ok((details?.diagnostics?.length ?? 0) > 0);
		assert.equal(fixture.manager.activeRootCount(), 1);
	});
});

test("clean=true active continuous reports restart failures clearly", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const root = join(baseDir, "paper.tex");
		const pdf = join(baseDir, "paper.pdf");
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		writeFileSync(pdf, "old pdf");
		fixture.manager.setAcceptingSubscriptions(false);

		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", clean: true }, { cwd: baseDir, session_id: "session-A" });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /failed to restart continuous compilation after clean/);
		const details = (observed as { statusDetails?: { error_code?: string; cleaned_artifacts?: string[] } }).statusDetails;
		assert.equal(details?.error_code, "continuous_compiler_restart_failed");
		assert.equal(details?.cleaned_artifacts?.includes(pdf), true);
		assert.equal(fixture.manager.activeRootCount(), 0);
		assert.equal(fixture.manager.subscriberCount(root), 0);
	});
});

test("continuous=false compatible active compile uses continuous result and unsubscribes without spawning another latexmk", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);
		const root = join(baseDir, "paper.tex");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		emitContinuousEvent(fixture.processes[0]!, "compiling");
		const unsubscribe = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: false }, { cwd: baseDir, session_id: "session-A" });
		await sleep(50);
		assert.equal(fixture.processes[0]?.killed, false);

		writeContinuousRecorderArtifacts(root);
		emitContinuousEvent(fixture.processes[0]!, "success");
		const result = await unsubscribe;
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
		assert.equal(result.continuous?.status, "stopped");
		assert.equal(result.continuous?.subscriber_count, 0);
		assert.equal(fixture.processes[0]?.killed, true);
		assert.equal(readFileSync(recordPath, "utf8").trim().split("\n").length, 1);
	});
});


test("continuous=false compiler mismatch rejects with guidance and unsubscribes without spawning latexmk", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const recordPath = join(baseDir, "latexmk-args.jsonl");
		writeRecordingLatexmk(join(baseDir, "bin"), recordPath);

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });

		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "pdflatex", continuous: false }, { cwd: baseDir, session_id: "session-A" });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /active.*compiler lualatex/i);
		assert.match(observed.message, /use the active compiler or stop continuous compilation first/i);
		const details = (observed as { statusDetails?: { error_code?: string; continuous?: { status?: string; subscriber_count?: number } } }).statusDetails;
		assert.equal(details?.error_code, "continuous_compiler_engine_mismatch");
		assert.equal(details?.continuous?.status, "stopped");
		assert.equal(details?.continuous?.subscriber_count, 0);
		assert.equal(fixture.processes[0]?.killed, true);
		assert.equal(readFileSync(recordPath, "utf8").trim().split("\n").length, 1);
	});
});

test("missing latexmk guidance is actionable for MacTeX, TeX Live, and BasicTeX users", () => {
	const fixture = makeFakeContinuousManager({ commandExists: false });
	const details = fixture.manager.ensureSubscription("/tmp/project/main.tex", "session-A", "lualatex");
	assert.equal(details.status, "unavailable");
	assert.equal(details.error_code, "continuous_compiler_unavailable");
	assert.match(details.error ?? "", /MacTeX/);
	assert.match(details.error ?? "", /TeX Live/);
	assert.match(details.error ?? "", /BasicTeX/);
	assert.match(details.error ?? "", /PATH/);
});

test("background continuous compile failure queues session-scoped system-info notifications and delivery clears them", () => {
	const baseDir = temporaryDir("continuous-failure-notify-");
	try {
		const root = join(baseDir, "paper.tex");
		const log = join(baseDir, "paper.log");
		writeFileSync(root, "\\documentclass{article}\n\\begin{document}hi\\badcommand\\end{document}\n");
		writeFileSync(log, "! Undefined control sequence.\nl.2 \\badcommand\n");
		const leases = new HostServiceSessionLeaseService({ nowNs: () => 123_000_000 });
		leases.heartbeat({ cwd: baseDir, session_id: "session-A" });
		leases.heartbeat({ cwd: baseDir, session_id: "session-B" });
		const fixture = makeFakeContinuousManager({
			notificationSink: {
				isSessionLive: (sessionId) => leases.isLive(sessionId),
				queuePendingNotification: (sessionId, notification) => leases.queuePendingNotification(sessionId, notification),
				clearPendingNotificationsForRoot: (rootSource) => leases.clearPendingNotificationsForRoot(rootSource),
				nowNs: () => 123_000_000,
			},
		});

		fixture.manager.ensureSubscription(root, "session-A", "lualatex");
		fixture.manager.ensureSubscription(root, "session-B", "lualatex");
		fixture.processes[0]?.stderr.write("Latexmk: Errors, so I did not complete making targets\n! Undefined control sequence.\nl.2 \\badcommand\n");

		const deliveredA = leases.retrievePendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.equal(deliveredA.length, 1);
		assert.equal(deliveredA[0]?.root_source, root);
		assert.match(deliveredA[0]?.message ?? "", /^\[system info\]/);
		assert.match(deliveredA[0]?.message ?? "", /Background continuous LaTeX compilation failed/);
		assert.match(deliveredA[0]?.message ?? "", new RegExp(`Source: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(deliveredA[0]?.message ?? "", new RegExp(`PDF: ${join(baseDir, "paper.pdf").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(deliveredA[0]?.message ?? "", new RegExp(`Log: ${log.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(deliveredA[0]?.message ?? "", /Undefined control sequence/);
		assert.equal((deliveredA[0]?.details as { source_path?: string } | undefined)?.source_path, root);
		assert.equal((deliveredA[0]?.details as { pdf_path?: string } | undefined)?.pdf_path, join(baseDir, "paper.pdf"));
		assert.equal((deliveredA[0]?.details as { log_path?: string } | undefined)?.log_path, log);
		assert.ok(Array.isArray((deliveredA[0]?.details as { diagnostics?: unknown } | undefined)?.diagnostics));

		const afterDeliveryA = leases.retrievePendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.deepEqual(afterDeliveryA, []);
		const deliveredB = leases.retrievePendingNotifications({ cwd: baseDir, session_id: "session-B" });
		assert.equal(deliveredB.length, 1);
		assert.equal(deliveredB[0]?.root_source, root);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("background continuous compile failures replace prior pending notifications per session and root", () => {
	const baseDir = temporaryDir("continuous-failure-replace-");
	try {
		const root = join(baseDir, "paper.tex");
		const log = join(baseDir, "paper.log");
		writeFileSync(root, "\\documentclass{article}\n\\begin{document}hi\\end{document}\n");
		const leases = new HostServiceSessionLeaseService();
		leases.heartbeat({ cwd: baseDir, session_id: "session-A" });
		const fixture = makeFakeContinuousManager({
			notificationSink: {
				isSessionLive: (sessionId) => leases.isLive(sessionId),
				queuePendingNotification: (sessionId, notification) => leases.queuePendingNotification(sessionId, notification),
				clearPendingNotificationsForRoot: (rootSource) => leases.clearPendingNotificationsForRoot(rootSource),
			},
		});

		fixture.manager.ensureSubscription(root, "session-A", "lualatex");
		writeFileSync(log, "! Undefined control sequence.\nl.2 \\firstbad\n");
		fixture.processes[0]?.stderr.write("Latexmk: Errors, so I did not complete making targets\n! Undefined control sequence.\nl.2 \\firstbad\n");
		assert.equal(leases.pendingNotificationCount("session-A"), 1);

		writeFileSync(log, "! LaTeX Error: Missing $ inserted.\nl.4 $\n");
		fixture.processes[0]?.stderr.write("Latexmk: Errors, so I did not complete making targets\n! LaTeX Error: Missing $ inserted.\nl.4 $\n");
		assert.equal(leases.pendingNotificationCount("session-A"), 1);
		const delivered = leases.retrievePendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.equal(delivered.length, 1);
		assert.match(delivered[0]?.message ?? "", /Missing \$ inserted/);
		assert.doesNotMatch((delivered[0]?.details as { error_summary?: string } | undefined)?.error_summary ?? "", /firstbad/);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("successful background PDF update clears pending continuous compile failures before delivery", () => {
	const baseDir = temporaryDir("continuous-failure-clear-");
	try {
		const root = join(baseDir, "paper.tex");
		const log = join(baseDir, "paper.log");
		const pdf = join(baseDir, "paper.pdf");
		writeFileSync(root, "\\documentclass{article}\n\\begin{document}hi\\end{document}\n");
		writeFileSync(log, "! Undefined control sequence.\nl.2 \\bad\n");
		const leases = new HostServiceSessionLeaseService();
		leases.heartbeat({ cwd: baseDir, session_id: "session-A" });
		const fixture = makeFakeContinuousManager({
			notificationSink: {
				isSessionLive: (sessionId) => leases.isLive(sessionId),
				queuePendingNotification: (sessionId, notification) => leases.queuePendingNotification(sessionId, notification),
				clearPendingNotificationsForRoot: (rootSource) => leases.clearPendingNotificationsForRoot(rootSource),
			},
		});

		fixture.manager.ensureSubscription(root, "session-A", "lualatex");
		fixture.processes[0]?.stderr.write("Latexmk: Errors, so I did not complete making targets\n! Undefined control sequence.\nl.2 \\bad\n");
		assert.equal(leases.pendingNotificationCount("session-A"), 1);

		writeFileSync(pdf, "%PDF-1.7\nupdated\n");
		fixture.processes[0]?.stdout.write("Latexmk: All targets are up-to-date\n");
		assert.deepEqual(leases.retrievePendingNotifications({ cwd: baseDir, session_id: "session-A" }), []);

		fixture.processes[0]?.stdout.write("Latexmk: Nothing to do for 'paper.tex'\n");
		assert.deepEqual(leases.retrievePendingNotifications({ cwd: baseDir, session_id: "session-A" }), []);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service continuous pending notification retrieval is session scoped and clears delivered failures", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-B" });
		rmSync(join(baseDir, "paper.pdf"), { force: true });
		writeFileSync(join(baseDir, "paper.log"), "! Undefined control sequence.\nl.2 \\bad\n");
		fixture.processes[0]?.stderr.write("Latexmk: Errors, so I did not complete making targets\n! Undefined control sequence.\nl.2 \\bad\n");

		const deliveredA = await client.requestPendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.equal(deliveredA.delivered_count, 1);
		assert.equal(deliveredA.notifications[0]?.root_source, join(baseDir, "paper.tex"));
		const afterDeliveryA = await client.requestPendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.equal(afterDeliveryA.delivered_count, 0);
		const deliveredB = await client.requestPendingNotifications({ cwd: baseDir, session_id: "session-B" });
		assert.equal(deliveredB.delivered_count, 1);
	});
});

test("successful one-shot routed through continuous clears stale pending continuous failure for the same session and root", async () => {
	const leases = new HostServiceSessionLeaseService();
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		rmSync(join(baseDir, "paper.pdf"), { force: true });
		writeFileSync(join(baseDir, "paper.log"), "! Undefined control sequence.\nl.2 \\bad\n");
		fixture.processes[0]?.stderr.write("Latexmk: Errors, so I did not complete making targets\n! Undefined control sequence.\nl.2 \\bad\n");
		assert.equal(leases.pendingNotificationCount("session-A"), 1);

		const oneShotPromise = client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex" },
			{ cwd: baseDir, session_id: "session-A" },
		);
		await sleep(20);
		writeContinuousRecorderArtifacts(join(baseDir, "paper.tex"));
		emitContinuousEvent(fixture.processes[0]!, "success");
		const oneShot = await oneShotPromise;
		assert.equal(oneShot.continuous, undefined);
		const delivered = await client.requestPendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.equal(delivered.delivered_count, 0);
	}, { sessionLeases: leases });
});

test("continuous=false clears stale pending continuous failure notifications when unsubscribing", async () => {
	const leases = new HostServiceSessionLeaseService();
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		rmSync(join(baseDir, "paper.pdf"), { force: true });
		writeFileSync(join(baseDir, "paper.log"), "! Undefined control sequence.\nl.2 \\bad\n");
		fixture.processes[0]?.stderr.write("Latexmk: Errors, so I did not complete making targets\n! Undefined control sequence.\nl.2 \\bad\n");
		assert.equal(leases.pendingNotificationCount("session-A"), 1);

		const stoppedPromise = client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: false },
			{ cwd: baseDir, session_id: "session-A" },
		);
		await sleep(20);
		writeContinuousRecorderArtifacts(join(baseDir, "paper.tex"));
		emitContinuousEvent(fixture.processes[0]!, "success");
		const stopped = await stoppedPromise;
		assert.equal(stopped.continuous?.status, "stopped");
		const delivered = await client.requestPendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.equal(delivered.delivered_count, 0);
	}, { sessionLeases: leases });
});

test("continuous=true starts compiler and reports metadata when open_pdf fails after immediate compile succeeds", async () => {
	const fixture = makeFakeContinuousManager();
	const viewerBackend = new FakeViewerBackend();
	viewerBackend.setAvailable(false);
	await withCompileServer(fixture, async (client, baseDir) => {
		let observed: unknown;
		try {
			await client.requestCompileLatexFile(
				{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, continuous: true },
				{ cwd: baseDir, session_id: "session-A" },
			);
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /backend unavailable|backend_unavailable/);
		const details = (observed as { statusDetails?: { continuous?: { status?: string; subscriber_count?: number; pid?: number }; pdf?: string } }).statusDetails;
		assert.equal(details?.pdf, join(baseDir, "paper.pdf"));
		assert.equal(details?.continuous?.status, "started");
		assert.equal(details?.continuous?.subscriber_count, 1);
		assert.equal(details?.continuous?.pid, fixture.processes[0]?.pid);
		assert.equal(fixture.manager.activeRootCount(), 1);
		assert.equal(fixture.processes[0]?.killed, false);
	}, { viewerBackend });
});

test("host service continuous=true/false performs immediate compile and manages shared subscriptions", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const contextA = { cwd: baseDir, session_id: "session-A" };
		const contextB = { cwd: baseDir, session_id: "session-B" };

		const started = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, contextA);
		assert.equal(started.pdf, join(baseDir, "paper.pdf"));
		assert.equal(started.continuous?.status, "started");
		assert.equal(started.continuous?.subscriber_count, 1);
		assert.equal(fixture.spawns.length, 1);

		const repeated = await client.requestCompileLatexFile({ latex_file_path: join(baseDir, "paper.tex"), compiler: "lualatex", continuous: true }, contextA);
		assert.equal(repeated.continuous?.status, "already_active");
		assert.equal(repeated.continuous?.subscriber_count, 1);
		assert.equal(fixture.spawns.length, 1);

		const shared = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, contextB);
		assert.equal(shared.continuous?.status, "already_active");
		assert.equal(shared.continuous?.subscriber_count, 2);
		assert.equal(fixture.spawns.length, 1);

		emitContinuousEvent(fixture.processes[0]!, "compiling");
		writeContinuousRecorderArtifacts(join(baseDir, "paper.tex"));
		emitContinuousEvent(fixture.processes[0]!, "success");

		const stillActive = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: false }, contextA);
		assert.equal(stillActive.continuous?.status, "still_active_for_other_subscribers");
		assert.equal(stillActive.continuous?.subscriber_count, 1);
		assert.equal(fixture.processes[0]?.killed, false);

		const stopped = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: false }, contextB);
		assert.equal(stopped.continuous?.status, "stopped");
		assert.equal(stopped.continuous?.subscriber_count, 0);
		assert.equal(fixture.processes[0]?.killed, true);
	});
});

test("stale previous log output does not bypass stale-PDF detection", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		writeFileSync(join(baseDir, "paper.pdf"), "%PDF-1.4 stale\n");
		writeFileSync(join(baseDir, "paper.log"), "Output written on paper.pdf (1 page, 123 bytes).\n");
		writeNoopLatexmk(join(baseDir, "bin"));

		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "latexmk" }, { cwd: baseDir });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /code=failed_stale_pdf_exists/);
	});
});

test("failed one-shot compile does not report stale project log diagnostics as current failure", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		writeFileSync(join(baseDir, "paper.log"), "! Undefined control sequence.\nl.2 \\oldmacro\n");
		writeNoopLatexmk(join(baseDir, "bin"));

		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "latexmk" }, { cwd: baseDir });
		} catch (error) {
			observed = error;
		}

		assert.ok(observed instanceof Error);
		assert.match(observed.message, /code=failed_no_pdf/);
		assert.doesNotMatch(observed.message, /Undefined control sequence|oldmacro/);
		assert.deepEqual((observed as { statusDetails?: { diagnostics?: unknown[]; error_summary?: string } }).statusDetails?.diagnostics, []);
		assert.doesNotMatch((observed as { statusDetails?: { error_summary?: string } }).statusDetails?.error_summary ?? "", /Undefined control sequence|oldmacro/);
	});
});

test("latexmk target-specific up-to-date no-op succeeds with unchanged PDF and log", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		writeFileSync(join(baseDir, "paper.pdf"), "%PDF-1.4 existing\n");
		writeFileSync(join(baseDir, "paper.log"), "old log without current output-written evidence\n");
		writeUpToDateNoopLatexmk(join(baseDir, "bin"));

		const result = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "latexmk" }, { cwd: baseDir });
		assert.equal(result.compile_status, "ok");
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
	});
});

test("compiler=latexmk repeated continuous calls succeed when latexmk reports PDF output without changing mtime", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		writeLatexmkThatLeavesExistingPdfUntouched(join(baseDir, "bin"));
		const context = { cwd: baseDir, session_id: "session-latexmk" };

		const started = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "latexmk", continuous: true }, context);
		assert.equal(started.continuous?.status, "started");
		assert.equal(started.compile_status, "ok");
		assert.equal(fixture.spawns.length, 1);

		const repeated = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "latexmk", continuous: true }, context);
		assert.equal(repeated.continuous?.status, "already_active");
		assert.equal(repeated.continuous?.subscriber_count, 1);
		assert.equal(repeated.compile_status, "ok");
		assert.equal(fixture.spawns.length, 1);

		emitContinuousEvent(fixture.processes[0]!, "compiling");
		writeContinuousRecorderArtifacts(join(baseDir, "paper.tex"));
		emitContinuousEvent(fixture.processes[0]!, "success");

		const stopped = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "latexmk", continuous: false }, context);
		assert.equal(stopped.continuous?.status, "stopped");
		assert.equal(stopped.continuous?.subscriber_count, 0);
		assert.equal(stopped.compile_status, "ok");
		assert.equal(fixture.processes[0]?.killed, true);
	});
});

test("continuous=true rejects compiler changes for an already-active root", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const started = await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-lua" },
		);
		assert.equal(started.continuous?.status, "started");
		assert.equal(fixture.spawns.length, 1);

		for (const compiler of ["pdflatex", "xelatex"] as const) {
			let observed: unknown;
			try {
				await client.requestCompileLatexFile(
					{ latex_file_path: "paper.tex", compiler, continuous: true },
					{ cwd: baseDir, session_id: `session-${compiler}` },
				);
			} catch (error) {
				observed = error;
			}
			assert.ok(observed instanceof Error);
			assert.match(observed.message, /continuous_compiler_engine_mismatch/);
			const details = (observed as { statusDetails?: { continuous?: { status?: string; subscriber_count?: number; error_code?: string } } }).statusDetails;
			assert.equal(details?.continuous?.status, "error");
			assert.equal(details?.continuous?.error_code, "continuous_compiler_engine_mismatch");
			assert.equal(details?.continuous?.subscriber_count, 1);
			assert.equal(fixture.spawns.length, 1);
		}

		const repeated = await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-lua" },
		);
		assert.equal(repeated.continuous?.status, "already_active");
		assert.equal(repeated.continuous?.subscriber_count, 1);
		assert.equal(fixture.spawns.length, 1);
	});
});

test("missing latexmk fails all file compile modes with install guidance", async () => {
	const fixture = makeFakeContinuousManager({ commandExists: false });
	await withCompileServer(fixture, async (client, baseDir) => {
		const binDir = join(baseDir, "bin");
		rmSync(join(binDir, "latexmk"), { force: true });
		process.env.PATH = binDir;
		for (const request of [
			{ latex_file_path: "paper.tex", compiler: "lualatex" as const },
			{ latex_file_path: "paper.tex", compiler: "pdflatex" as const, continuous: true },
			{ latex_file_path: "paper.tex", compiler: "xelatex" as const, continuous: false },
		]) {
			let observed: unknown;
			try {
				await client.requestCompileLatexFile(request, { cwd: baseDir, session_id: "session-missing-latexmk" });
			} catch (error) {
				observed = error;
			}
			assert.ok(observed instanceof Error);
			assert.match(observed.message, /code=compiler_start_failed/);
			assert.match(observed.message, /latexmk is required/);
			assert.match(observed.message, /MacTeX|TeX Live/);
		}
	});
});

test("host service rejects invalid continuous requests but keeps one-shot compatible", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const oneShot = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		assert.equal(oneShot.continuous, undefined);
		await assert.rejects(
			() => client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: "true" as unknown as boolean }, { cwd: baseDir, session_id: "session-A" }),
			/continuous must be a boolean/,
		);
		await assert.rejects(
			() => client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: oneShot.workspace_context.cwd }),
			/workspace_context\.session_id is required/,
		);
		await assert.rejects(
			() => client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: false }, { cwd: oneShot.workspace_context.cwd }),
			/workspace_context\.session_id is required/,
		);
	});
});

test("MCP-origin continuous subscriptions refresh session leases for expiry cleanup", async () => {
	let nowNs = 1_000_000_000;
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir, _server, socketPath) => {
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			id: 75,
			method: "tools/call",
			params: {
				name: "compile_latex_file",
				arguments: {
					latex_file_path: "paper.tex",
					compiler: "lualatex",
					continuous: true,
					workspace_context: { cwd: baseDir, session_id: "mcp-session-A" },
				},
			},
		});
		const response = (await sendFramedRequest(socketPath, payload)) as { result: { isError?: boolean; details?: { continuous?: { status?: string } } } };
		assert.equal(response.result.isError, undefined);
		assert.equal(response.result.details?.continuous?.status, "started");
		assert.equal(fixture.manager.activeRootCount(), 1);

		nowNs += 2_000_000;
		await client.requestStatus({ cwd: baseDir });
		assert.equal(fixture.manager.activeRootCount(), 0);
		assert.equal(fixture.processes[0]?.killed, true);
	}, { leaseTtlMs: 1, nowNs: () => nowNs });
});


test("continuous=false unsubscribes even when routed continuous compile fails for a tilde-expanded source", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const originalHome = process.env.HOME;
		const homeDir = join(baseDir, "home");
		mkdirSync(homeDir, { recursive: true });
		writeFileSync(join(homeDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}home\\end{document}\n");
		process.env.HOME = homeDir;
		try {
			await client.requestCompileLatexFile(
				{ latex_file_path: "~/paper.tex", compiler: "lualatex", continuous: true },
				{ cwd: baseDir, session_id: "session-A" },
			);
			assert.equal(fixture.manager.activeRootCount(), 1);

			rmSync(join(homeDir, "paper.pdf"), { force: true });
			let observed: unknown;
			try {
				const unsubscribe = client.requestCompileLatexFile(
					{ latex_file_path: "~/paper.tex", compiler: "lualatex", continuous: false },
					{ cwd: baseDir, session_id: "session-A" },
				);
				await sleep(20);
				writeFileSync(join(homeDir, "paper.log"), "! Undefined control sequence.\nl.1 \\bad\n");
				rmSync(join(homeDir, "paper.fls"), { force: true });
				emitContinuousEvent(fixture.processes[0]!, "failure");
				await unsubscribe;
			} catch (error) {
				observed = error;
			}
			assert.ok(observed instanceof Error);
			assert.match(observed.message, /continuous compile failed|Undefined control sequence/);
			const details = (observed as { statusDetails?: { continuous?: { status?: string; subscriber_count?: number; root_source?: string } } }).statusDetails;
			assert.equal(details?.continuous?.status, "stopped");
			assert.equal(details?.continuous?.subscriber_count, 0);
			assert.equal(details?.continuous?.root_source, join(homeDir, "paper.tex"));
			assert.equal(fixture.manager.activeRootCount(), 0);
			assert.equal(fixture.processes[0]?.killed, true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});
});


test("continuous=false unsubscribes even when open_pdf fails", async () => {
	const fixture = makeFakeContinuousManager();
	const viewerBackend = new FakeViewerBackend();
	await withCompileServer(fixture, async (client, baseDir) => {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		viewerBackend.setAvailable(false);
		let observed: unknown;
		try {
			const unsubscribe = client.requestCompileLatexFile(
				{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, continuous: false },
				{ cwd: baseDir, session_id: "session-A" },
			);
			await sleep(20);
			writeContinuousRecorderArtifacts(join(baseDir, "paper.tex"));
			emitContinuousEvent(fixture.processes[0]!, "success");
			await unsubscribe;
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /backend unavailable|backend_unavailable/);
		const details = (observed as { statusDetails?: { continuous?: { status?: string; subscriber_count?: number } } }).statusDetails;
		assert.equal(details?.continuous?.status, "stopped");
		assert.equal(details?.continuous?.subscriber_count, 0);
		assert.equal(fixture.manager.activeRootCount(), 0);
		assert.equal(fixture.processes[0]?.killed, true);
	}, { viewerBackend });
});


test("continuous startup reports missing latexmk without regressing immediate compile dependency", async () => {
	const fixture = makeFakeContinuousManager({ commandExists: false });
	await withCompileServer(fixture, async (client, baseDir) => {
		const oneShot = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		assert.equal(oneShot.pdf, join(baseDir, "paper.pdf"));

		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true }, { cwd: baseDir, session_id: "session-A" });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /continuous compilation requires latexmk/);
		const details = (observed as { statusDetails?: { continuous?: { status?: string }; pdf?: string } }).statusDetails;
		assert.equal(details?.continuous?.status, "unavailable");
		assert.equal(details?.pdf, join(baseDir, "paper.pdf"));
		assert.equal(fixture.spawns.length, 0);
	});
});

test("close_pdf leaves continuous compiler running", async () => {
	const fixture = makeFakeContinuousManager();
	const viewerBackend = new FakeViewerBackend();
	await withCompileServer(fixture, async (client, baseDir) => {
		const compiled = await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		assert.equal(compiled.continuous?.status, "started");
		assert.equal(fixture.manager.activeRootCount(), 1);
		assert.ok(compiled.pdf_id);

		await client.requestClosePdf({ cwd: baseDir, session_id: "session-A" }, compiled.pdf_id);
		assert.equal(fixture.manager.activeRootCount(), 1);
		assert.equal(fixture.processes[0]?.killed, false);
	}, { viewerBackend, managedViewerRecords: new HostServicePdfIdRegistry({ minPdfId: 75, maxPdfId: 75, makePdfId: () => 75 }) });
});

test("immediate success pending clear preserves other sessions and other roots", async () => {
	const leases = new HostServiceSessionLeaseService();
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const root = join(baseDir, "paper.tex");
		const otherRoot = join(baseDir, "other.tex");
		leases.queuePendingNotification("session-A", { id: "a-paper", created_at_ns: 1, root_source: root, message: "paper A" });
		leases.queuePendingNotification("session-B", { id: "b-paper", created_at_ns: 2, root_source: root, message: "paper B" });
		leases.queuePendingNotification("session-A", { id: "a-other", created_at_ns: 3, root_source: otherRoot, message: "other A" });

		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex" },
			{ cwd: baseDir, session_id: "session-A" },
		);

		const deliveredA = await client.requestPendingNotifications({ cwd: baseDir, session_id: "session-A" });
		assert.deepEqual(deliveredA.notifications.map((notification) => notification.id), ["a-other"]);
		const deliveredB = await client.requestPendingNotifications({ cwd: baseDir, session_id: "session-B" });
		assert.deepEqual(deliveredB.notifications.map((notification) => notification.id), ["b-paper"]);
	}, { sessionLeases: leases });
});

test("in-flight compile cannot create a continuous compiler after host service shutdown begins", async () => {
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir, server) => {
		const compilePromise = client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		).catch((error: unknown) => error);
		await sleep(20);

		await server.stop();
		await compilePromise;
		await sleep(80);

		assert.equal(fixture.spawns.length, 0);
		assert.equal(fixture.manager.activeRootCount(), 0);
	}, { compilerDelaySeconds: "0.05" });
});

test("long immediate compile refreshes lease before continuous subscription so autonomous pruning remains bounded", async () => {
	let nowNs = 1_000_000_000;
	const leases = new HostServiceSessionLeaseService({ leaseTtlMs: 1, nowNs: () => nowNs });
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		const compilePromise = client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		await sleep(20);
		nowNs += 2_000_000;
		await waitUntil(() => !leases.isLive("session-A"));

		const compiled = await compilePromise;
		assert.equal(compiled.continuous?.status, "started");
		assert.equal(leases.isLive("session-A"), true);
		assert.equal(fixture.manager.activeRootCount(), 1);

		nowNs += 2_000_000;
		await waitUntil(() => fixture.manager.activeRootCount() === 0);
		assert.equal(fixture.processes[0]?.killed, true);
	}, { sessionLeases: leases, sessionPruneIntervalMs: 5, compilerDelaySeconds: "0.05" });
});

test("host service autonomously prunes expired continuous subscriptions without a subsequent request", async () => {
	let nowNs = 1_000_000_000;
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir) => {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		assert.equal(fixture.manager.activeRootCount(), 1);

		nowNs += 2_000_000;
		await waitUntil(() => fixture.manager.activeRootCount() === 0);
		assert.equal(fixture.processes[0]?.killed, true);
	}, { leaseTtlMs: 1, nowNs: () => nowNs, sessionPruneIntervalMs: 5 });
});

test("host service stops session prune timer on shutdown", async () => {
	const leases = new CountingSessionLeaseService();
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (_client, _baseDir, server) => {
		await waitUntil(() => leases.pruneCount > 0);
		assert.ok(leases.pruneCount > 0);
		await server.stop();
		const countAfterStop = leases.pruneCount;
		await sleep(20);
		assert.equal(leases.pruneCount, countAfterStop);
	}, { sessionLeases: leases, sessionPruneIntervalMs: 5 });
});

test("final unsubscribe waits for process exit before dropping tracking", async () => {
	const fixture = makeFakeContinuousManager({ shutdownGraceMs: 50, shutdownForceMs: 5, autoExitSignals: [] });
	const root = "/tmp/project/main.tex";
	fixture.manager.ensureSubscription(root, "session-A", "lualatex");
	let resolved = false;
	const unsubscribePromise = fixture.manager.removeSubscription(root, "session-A").then((details) => {
		resolved = true;
		return details;
	});
	await sleep(0);
	assert.equal(fixture.processes[0]?.killSignals[0], "SIGTERM");
	assert.equal(resolved, false);
	assert.equal(fixture.manager.activeRootCount(), 1);

	fixture.processes[0]?.emit("exit", 0, null);
	const details = await unsubscribePromise;
	assert.equal(details.status, "stopped");
	assert.equal(fixture.manager.activeRootCount(), 0);
	assert.equal(fixture.processes[0]?.killSignals.includes("SIGKILL"), false);
});

test("final unsubscribe escalates when process ignores graceful shutdown", async () => {
	const fixture = makeFakeContinuousManager({ shutdownGraceMs: 5, shutdownForceMs: 50, autoExitSignals: ["SIGKILL"] });
	const root = "/tmp/project/main.tex";
	fixture.manager.ensureSubscription(root, "session-A", "lualatex");
	const details = await fixture.manager.removeSubscription(root, "session-A");
	assert.equal(details.status, "stopped");
	assert.deepEqual(fixture.processes[0]?.killSignals, ["SIGTERM", "SIGKILL"]);
	assert.equal(fixture.manager.activeRootCount(), 0);
});

test("expiry-driven stop keeps tracking until stubborn process is escalated", async () => {
	const fixture = makeFakeContinuousManager({ shutdownGraceMs: 5, shutdownForceMs: 50, autoExitSignals: ["SIGKILL"] });
	fixture.manager.ensureSubscription("/tmp/project/main.tex", "session-A", "lualatex");
	fixture.manager.removeSessions(["session-A"]);
	assert.equal(fixture.processes[0]?.killSignals[0], "SIGTERM");
	assert.equal(fixture.manager.activeRootCount(), 1);
	await waitUntil(() => fixture.manager.activeRootCount() === 0);
	assert.deepEqual(fixture.processes[0]?.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("continuous compiler shutdown waits for graceful process exit", async () => {
	const fixture = makeFakeContinuousManager({ shutdownGraceMs: 50, shutdownForceMs: 5, autoExitSignals: [] });
	fixture.manager.ensureSubscription("/tmp/project/main.tex", "session-A", "lualatex");
	let resolved = false;
	const stopPromise = fixture.manager.stopAll().then(() => {
		resolved = true;
	});
	await sleep(0);
	assert.equal(fixture.processes[0]?.killSignals[0], "SIGTERM");
	assert.equal(resolved, false);
	fixture.processes[0]?.emit("exit", 0, null);
	await stopPromise;
	assert.equal(resolved, true);
	assert.equal(fixture.processes[0]?.killSignals.includes("SIGKILL"), false);
	assert.equal(fixture.manager.activeRootCount(), 0);
});

test("continuous compiler shutdown escalates when graceful exit times out", async () => {
	const fixture = makeFakeContinuousManager({ shutdownGraceMs: 5, shutdownForceMs: 50, autoExitSignals: ["SIGKILL"] });
	fixture.manager.ensureSubscription("/tmp/project/main.tex", "session-A", "lualatex");
	await fixture.manager.stopAll();
	assert.deepEqual(fixture.processes[0]?.killSignals, ["SIGTERM", "SIGKILL"]);
	assert.equal(fixture.manager.activeRootCount(), 0);
});

test("heartbeat expiry and daemon shutdown stop continuous compilers", async () => {
	let nowNs = 1_000_000_000;
	const fixture = makeFakeContinuousManager();
	await withCompileServer(fixture, async (client, baseDir, server) => {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-A" },
		);
		assert.equal(fixture.manager.activeRootCount(), 1);

		nowNs += 2_000_000;
		await client.requestStatus({ cwd: baseDir });
		assert.equal(fixture.manager.activeRootCount(), 0);
		assert.equal(fixture.processes[0]?.killed, true);

		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", continuous: true },
			{ cwd: baseDir, session_id: "session-B" },
		);
		assert.equal(fixture.manager.activeRootCount(), 1);
		await server.stop();
		assert.equal(fixture.manager.activeRootCount(), 0);
		assert.equal(fixture.processes[1]?.killed, true);
	}, { leaseTtlMs: 1, nowNs: () => nowNs });
});

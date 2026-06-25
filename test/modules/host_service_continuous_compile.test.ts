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

function writeRecordingLatexmk(binDir: string, recordPath: string, options: { writeFls?: boolean } = {}): void {
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
const sourcePath = path.resolve(process.cwd(), source);
const logPath = path.join(outDir, sourceBase + ".log");
const pdfPath = path.join(outDir, sourceBase + ".pdf");
fs.writeFileSync(logPath, "Output written on " + sourceBase + ".pdf (1 page, 123 bytes).\\n");
fs.writeFileSync(pdfPath, "%PDF-1.4\\n");
if (${JSON.stringify(options.writeFls === true)}) {
  const flsPath = path.join(outDir, sourceBase + ".fls");
  fs.writeFileSync(flsPath, ["PWD " + outDir, "INPUT " + sourcePath, "OUTPUT " + logPath, "OUTPUT " + pdfPath, "OUTPUT " + flsPath, ""].join("\\n"));
}
process.exit(0);
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
}

function recordedLatexmkInvocationCount(recordPath: string): number {
	if (!existsSync(recordPath)) {
		return 0;
	}
	return readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).length;
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
			const result = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler }, { cwd: baseDir, session_id: `session-${compiler}` });
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

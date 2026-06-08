import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ContinuousCompileSpawnOptions } from "../../src/modules/host_service_continuous_compile.ts";

class FakeContinuousProcess extends EventEmitter {
	readonly pid: number;
	killed = false;
	killSignal: NodeJS.Signals | number | undefined;

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		this.killSignal = signal;
		return true;
	}
}

function makeFakeContinuousManager(options: { commandExists?: boolean } = {}) {
	let nextPid = 20_000;
	const processes: FakeContinuousProcess[] = [];
	const spawns: Array<{ command: string; args: string[]; options: ContinuousCompileSpawnOptions }> = [];
	const manager = new HostServiceContinuousCompileManager({
		commandExists: () => options.commandExists ?? true,
		spawnProcess(command, args, spawnOptions) {
			const child = new FakeContinuousProcess(nextPid++);
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

function writeFakeLatexCompiler(binDir: string): void {
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const compilerPath = join(binDir, "lualatex");
	writeFileSync(compilerPath, `#!/bin/sh
set -eu
tex_file=""
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

async function withCompileServer<T>(
	fixture: ReturnType<typeof makeFakeContinuousManager>,
	fn: (client: HostServiceClient, baseDir: string, server: HostServiceServer) => Promise<T>,
	options: { leaseTtlMs?: number; nowNs?: () => number; viewerBackend?: FakeViewerBackend; managedViewerRecords?: HostServicePdfIdRegistry } = {},
): Promise<T> {
	const baseDir = temporaryDir("host-service-continuous-compile-");
	const socketPath = join(baseDir, "host-service.sock");
	const binDir = join(baseDir, "bin");
	writeFakeLatexCompiler(binDir);
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}hi\\end{document}\n");
	const originalPath = process.env.PATH ?? "";
	process.env.PATH = `${binDir}:${originalPath}`;
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: options.viewerBackend ?? new FakeViewerBackend(),
		managedViewerRecords: options.managedViewerRecords,
		sessionLeases: options.leaseTtlMs === undefined && options.nowNs === undefined
			? undefined
			: new HostServiceSessionLeaseService({ leaseTtlMs: options.leaseTtlMs, nowNs: options.nowNs }),
		continuousCompileManager: fixture.manager,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		return await fn(client, baseDir, server);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
}

test("continuous compile manager enforces singleton processes and subscriber lifecycle", () => {
	const fixture = makeFakeContinuousManager();
	const root = "/tmp/project/main.tex";

	const first = fixture.manager.ensureSubscription(root, "session-A", "lualatex");
	assert.equal(first.status, "started");
	assert.equal(first.subscriber_count, 1);
	assert.equal(fixture.spawns.length, 1);
	assert.deepEqual(fixture.spawns[0]?.args.slice(0, 2), ["-pvc", "-view=none"]);

	const repeated = fixture.manager.ensureSubscription(root, "session-A", "lualatex");
	assert.equal(repeated.status, "already_active");
	assert.equal(repeated.subscriber_count, 1);
	assert.equal(fixture.spawns.length, 1);

	const secondSession = fixture.manager.ensureSubscription(root, "session-B", "lualatex");
	assert.equal(secondSession.status, "already_active");
	assert.equal(secondSession.subscriber_count, 2);
	assert.equal(fixture.spawns.length, 1);

	const removedOne = fixture.manager.removeSubscription(root, "session-A");
	assert.equal(removedOne.status, "still_active_for_other_subscribers");
	assert.equal(removedOne.subscriber_count, 1);
	assert.equal(fixture.processes[0]?.killed, false);

	const removedLast = fixture.manager.removeSubscription(root, "session-B");
	assert.equal(removedLast.status, "stopped");
	assert.equal(removedLast.subscriber_count, 0);
	assert.equal(fixture.processes[0]?.killed, true);
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

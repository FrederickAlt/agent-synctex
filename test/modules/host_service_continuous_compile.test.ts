import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
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
import type { ContinuousCompileNotificationSink, ContinuousCompileSpawnOptions } from "../../src/modules/host_service_continuous_compile.ts";

class FakeContinuousProcess extends EventEmitter {
	readonly pid: number;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
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

function makeFakeContinuousManager(options: { commandExists?: boolean; notificationSink?: ContinuousCompileNotificationSink } = {}) {
	let nextPid = 20_000;
	const processes: FakeContinuousProcess[] = [];
	const spawns: Array<{ command: string; args: string[]; options: ContinuousCompileSpawnOptions }> = [];
	const manager = new HostServiceContinuousCompileManager({
		...options,
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

function writeFailingLatexCompiler(binDir: string): void {
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
printf 'intentional compile failure\n' > "$out_dir/$name.log"
exit 7
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
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
		return await fn(client, baseDir, server, socketPath);
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


test("continuous=false unsubscribes even when immediate compile fails for a tilde-expanded source", async () => {
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

			writeFailingLatexCompiler(join(baseDir, "bin"));
			rmSync(join(homeDir, "paper.pdf"), { force: true });
			let observed: unknown;
			try {
				await client.requestCompileLatexFile(
					{ latex_file_path: "~/paper.tex", compiler: "lualatex", continuous: false },
					{ cwd: baseDir, session_id: "session-A" },
				);
			} catch (error) {
				observed = error;
			}
			assert.ok(observed instanceof Error);
			assert.match(observed.message, /LaTeX compile failed/);
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
			await client.requestCompileLatexFile(
				{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, continuous: false },
				{ cwd: baseDir, session_id: "session-A" },
			);
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

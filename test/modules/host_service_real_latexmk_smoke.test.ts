import { createConnection } from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeViewerBackend, HostServiceServer } from "../../src/modules/host_service.ts";

interface McpCompileResponse {
	jsonrpc?: string;
	id?: number;
	result?: {
		isError?: boolean;
		content: Array<{ type?: string; text: string }>;
		details?: CompileDetails;
	};
	error?: { code: number; message: string };
}

interface CompileDetails {
	source?: string;
	pdf?: string;
	log?: string;
	clean?: boolean;
	cleaned_artifacts?: string[];
	artifact_paths?: string[];
	compile_status?: string;
	compiler_exit_code?: number | null;
	warning_count?: number;
	pdf_id?: number;
	error_code?: string;
	continuous?: {
		status?: string;
		subscriber_count?: number;
		pid?: number;
		error_code?: string;
	};
}

interface InstrumentedProject {
	dir: string;
	texPath: string;
	pdfPath: string;
	logPath: string;
	lockPath: string;
	label: string;
}

interface InstrumentationEvent {
	event: string;
	root: string;
	clock?: number;
}

class CountingViewerBackend extends FakeViewerBackend {
	openRequests: Record<string, unknown>[] = [];

	override async open(requestId: string, details: Record<string, unknown>) {
		this.openRequests.push({ requestId, ...details });
		return super.open(requestId, details);
	}
}

function realTexSmokeSkipReason(): string | undefined {
	if (process.env.AGENT_SYNCTEX_REAL_TEX_SMOKE !== "1") {
		return "set AGENT_SYNCTEX_REAL_TEX_SMOKE=1 to run the selective real latexmk/lualatex Host Service MCP smoke";
	}
	for (const command of ["latexmk", "lualatex"] as const) {
		const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
		if (probe.error || probe.status !== 0) {
			return `requires real ${command} on PATH`;
		}
	}
	return undefined;
}

function allocateMcpTmpDir(prefix: string) {
	const previous = process.env.MCP_TMPDIR;
	const dir = mkdtempSync(join(tmpdir(), prefix));
	process.env.MCP_TMPDIR = dir;
	return {
		dir,
		restore() {
			if (previous === undefined) {
				delete process.env.MCP_TMPDIR;
				return;
			}
			process.env.MCP_TMPDIR = previous;
		},
	};
}

function encodeMcpFrame(jsonText: string): string {
	return `Content-Length: ${Buffer.byteLength(jsonText, "utf8")}\r\n\r\n${jsonText}`;
}

function parseMcpFrames(raw: string): unknown[] {
	const frames: unknown[] = [];
	const buffer = Buffer.from(raw, "utf8");
	let cursor = 0;
	while (cursor < buffer.length) {
		const separator = buffer.indexOf("\r\n\r\n", cursor);
		if (separator < 0) break;
		const headerText = buffer.slice(cursor, separator).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(headerText);
		if (!match) break;
		const bodyLength = Number.parseInt(match[1], 10);
		const bodyStart = separator + 4;
		const body = buffer.slice(bodyStart, bodyStart + bodyLength);
		if (body.length < bodyLength) break;
		frames.push(JSON.parse(body.toString("utf8")));
		cursor = bodyStart + bodyLength;
	}
	return frames;
}

async function sendRawMcpPayload(socketPath: string, rawPayload: string, timeoutMs = 90_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path: socketPath });
		let raw = "";
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(() => {
			socket.destroy();
			finish(() => reject(new Error("mcp socket timed out waiting for real TeX smoke response")));
		}, timeoutMs);
		timer.unref?.();

		const resolveIfDone = () => {
			if (parseMcpFrames(raw).length < 1) return;
			finish(() => {
				socket.destroy();
				resolve(raw);
			});
		};

		socket.on("connect", () => socket.write(rawPayload));
		socket.on("data", (chunk) => {
			raw += String(chunk);
			resolveIfDone();
		});
		socket.on("error", (error) => {
			finish(() => reject(error));
		});
		socket.on("end", () => {
			if (parseMcpFrames(raw).length >= 1) {
				finish(() => resolve(raw));
				return;
			}
			finish(() => reject(new Error(raw.length ? "incomplete mcp frame" : "empty response")));
		});
	});
}

async function sendFramedRequest(socketPath: string, payload: string): Promise<unknown> {
	const raw = await sendRawMcpPayload(socketPath, encodeMcpFrame(payload));
	const frames = parseMcpFrames(raw);
	assert.equal(frames.length, 1);
	return frames[0];
}

function directLuaInstrumentation(lockPath: string, label: string, sleepSeconds: number): string {
	const header = `
local lfs=require('lfs')
local lockpath=[===[${lockPath}]===]
local root=[===[${label}]===]
local function emit(event)
  local name='compile-event-' .. event .. '-' .. tostring(os.time()) .. '-' .. tostring(os.clock()) .. '.jsonl'
  local f=assert(io.open(name, 'w'))
  local q=string.char(34)
  local o=string.char(123)
  local c=string.char(125)
  f:write(o .. q .. 'event' .. q .. ':' .. q .. event .. q .. ',' .. q .. 'root' .. q .. ':' .. q .. root .. q .. ',' .. q .. 'clock' .. q .. ':' .. tostring(os.clock()) .. c .. string.char(10))
  f:close()
end
`;
	return `\\directlua{${header}
local ok=lfs.mkdir(lockpath)
if not ok then emit('overlap-detected') end
emit('compile-start')
local stop=os.clock()+${sleepSeconds}
while os.clock()<stop do end
}
\\AtEndDocument{\\directlua{${header}
emit('compile-end')
lfs.rmdir(lockpath)
}}
`;
}

function createInstrumentedProject(baseDir: string, label: string, sleepSeconds = 0.2): InstrumentedProject {
	const dir = join(baseDir, label);
	mkdirSync(dir, { recursive: true });
	const texPath = join(dir, "main.tex");
	const pdfPath = join(dir, "main.pdf");
	const logPath = join(dir, "main.log");
	const lockPath = join(dir, "main.compile.lock");
	writeFileSync(texPath, `\\documentclass{article}
${directLuaInstrumentation("main.compile.lock", label, sleepSeconds)}
\\begin{document}
Headless real TeX coordination smoke for ${label}.
\\end{document}
`);
	return { dir, texPath, pdfPath, logPath, lockPath, label };
}

function readEvents(project: InstrumentedProject): InstrumentationEvent[] {
	return readdirSync(project.dir)
		.filter((name) => name.startsWith("compile-event-") && name.endsWith(".jsonl"))
		.flatMap((name) => readFileSync(join(project.dir, name), "utf8")
			.split(/\r?\n/u)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as InstrumentationEvent));
}

function eventCount(project: InstrumentedProject, event: string): number {
	return readEvents(project).filter((entry) => entry.event === event).length;
}

function assertNoOverlapEvents(projects: InstrumentedProject[]): void {
	for (const project of projects) {
		assert.equal(eventCount(project, "overlap-detected"), 0, `${project.label} recorded overlapping TeX runs`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 30_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await sleep(100);
	}
	throw new Error(message);
}

let nextMcpId = 1;
function compileToolPayload(project: InstrumentedProject, args: Record<string, unknown> = {}, sessionId = "smoke-session"): string {
	const id = nextMcpId++;
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: {
			name: "compile_latex_file",
			arguments: {
				latex_file_path: "main.tex",
				compiler: "lualatex",
				open_pdf: false,
				hide_warnings: false,
				workspace_context: {
					cwd: project.dir,
					workspace_root: project.dir,
					session_id: sessionId,
				},
				...args,
			},
		},
	});
}

async function callCompile(socketPath: string, project: InstrumentedProject, args: Record<string, unknown> = {}, sessionId?: string): Promise<McpCompileResponse> {
	return await sendFramedRequest(socketPath, compileToolPayload(project, args, sessionId)) as McpCompileResponse;
}

function expectCompileSuccess(response: McpCompileResponse, label: string): CompileDetails {
	assert.equal(response.error, undefined, `${label} returned top-level MCP error ${response.error?.message ?? ""}`);
	assert.ok(response.result, `${label} missing tool result`);
	assert.equal(response.result.isError, undefined, `${label} failed: ${response.result.content[0]?.text ?? ""}`);
	const details = response.result.details;
	assert.ok(details, `${label} missing details`);
	assert.match(details.compile_status ?? "", /^ok|ok_with_warnings$/u, `${label} unexpected compile status`);
	assert.equal(details.pdf_id, undefined, `${label} unexpectedly opened a viewer-backed PDF`);
	assert.ok(details.pdf && existsSync(details.pdf), `${label} PDF missing at ${details.pdf ?? "[missing path]"}`);
	assert.ok(details.log && existsSync(details.log), `${label} log missing at ${details.log ?? "[missing path]"}`);
	const text = response.result.content[0]?.text ?? "";
	assert.doesNotMatch(text, /failed_no_pdf|compile_failed|compiler_start_failed|stale/i, `${label} returned stale failure-looking text`);
	return details;
}

function expectCompileToolError(response: McpCompileResponse, code: string, pattern: RegExp): CompileDetails {
	assert.equal(response.error, undefined);
	assert.equal(response.result?.isError, true);
	assert.match(response.result?.content[0]?.text ?? "", pattern);
	assert.equal(response.result?.details?.error_code, code);
	return response.result?.details ?? {};
}

test("real latexmk Host Service MCP root coordination smoke", async (t) => {
	const skipReason = realTexSmokeSkipReason();
	if (skipReason) {
		t.skip(skipReason);
		return;
	}

	const runtime = allocateMcpTmpDir("host-service-real-latexmk-runtime-");
	const baseDir = mkdtempSync(join(tmpdir(), "host-service-real-latexmk-smoke-"));
	const socketPath = join(baseDir, "host-service.sock");
	const sameRoot = createInstrumentedProject(baseDir, "same-root", 0.25);
	const otherRootA = createInstrumentedProject(baseDir, "other-root-a", 0.2);
	const otherRootB = createInstrumentedProject(baseDir, "other-root-b", 0.2);
	const continuousRoot = createInstrumentedProject(baseDir, "continuous-root", 0.2);
	const viewerBackend = new CountingViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend });

	await server.start();
	try {
		const burst = await Promise.all([0, 1, 2].map((index) => callCompile(socketPath, sameRoot, {}, `burst-${index}`)));
		burst.forEach((response, index) => expectCompileSuccess(response, `same-root burst ${index}`));
		assertNoOverlapEvents([sameRoot]);

		const beforeReuseStarts = eventCount(sameRoot, "compile-start");
		assert.ok(beforeReuseStarts > 0, "same-root burst should run TeX at least once");
		expectCompileSuccess(await callCompile(socketPath, sameRoot, {}, "reuse"), "same-root cached reuse");
		assert.equal(eventCount(sameRoot, "compile-start"), beforeReuseStarts, "fresh unchanged one-shot should reuse the cached result without another TeX run");

		const beforeOtherAStarts = eventCount(otherRootA, "compile-start");
		const beforeOtherBStarts = eventCount(otherRootB, "compile-start");
		const differentRoots = await Promise.all([
			callCompile(socketPath, otherRootA, {}, "other-A"),
			callCompile(socketPath, otherRootB, {}, "other-B"),
		]);
		differentRoots.forEach((response, index) => expectCompileSuccess(response, `different-root compile ${index}`));
		assert.ok(eventCount(otherRootA, "compile-start") > beforeOtherAStarts, "first different root should compile");
		assert.ok(eventCount(otherRootB, "compile-start") > beforeOtherBStarts, "second different root should compile");
		assertNoOverlapEvents([sameRoot, otherRootA, otherRootB]);

		const firstContinuous = expectCompileSuccess(
			await callCompile(socketPath, continuousRoot, { continuous: true }, "continuous-A"),
			"continuous session A",
		);
		assert.equal(firstContinuous.continuous?.status, "started");
		assert.equal(firstContinuous.continuous?.subscriber_count, 1);
		const firstContinuousPid = firstContinuous.continuous?.pid;
		assert.equal(typeof firstContinuousPid, "number");

		await sleep(1_000);
		const beforeContinuousRebuildStarts = eventCount(continuousRoot, "compile-start");
		const beforeContinuousRebuildEnds = eventCount(continuousRoot, "compile-end");
		appendFileSync(continuousRoot.texPath, "\n% trigger continuous rebuild for one-shot waiter\n");
		await waitUntil(
			() => eventCount(continuousRoot, "compile-start") > beforeContinuousRebuildStarts,
			"active continuous latexmk should rebuild after the root source changes",
			10_000,
		);
		await waitUntil(
			() => eventCount(continuousRoot, "compile-end") > beforeContinuousRebuildEnds,
			"active continuous latexmk should finish the rebuild before a fresh-result one-shot",
			10_000,
		);
		const oneShotDuringContinuous = expectCompileSuccess(
			await callCompile(socketPath, continuousRoot, {}, "continuous-A"),
			"one-shot through active continuous compiler",
		);
		assert.equal(oneShotDuringContinuous.pdf, continuousRoot.pdfPath);
		assertNoOverlapEvents([continuousRoot]);

		const secondContinuous = expectCompileSuccess(
			await callCompile(socketPath, continuousRoot, { continuous: true }, "continuous-B"),
			"continuous session B",
		);
		assert.equal(secondContinuous.continuous?.status, "already_active");
		assert.equal(secondContinuous.continuous?.subscriber_count, 2);
		assert.equal(secondContinuous.continuous?.pid, firstContinuousPid);

		expectCompileSuccess(
			await callCompile(socketPath, continuousRoot, {}, "continuous-A"),
			"fresh continuous result after second subscriber",
		);
		const beforeMismatchStarts = eventCount(continuousRoot, "compile-start");
		const mismatch = await callCompile(socketPath, continuousRoot, { compiler: "pdflatex" }, "continuous-A");
		expectCompileToolError(mismatch, "continuous_compiler_engine_mismatch", /active.*compiler lualatex|use the active compiler/i);
		assert.equal(eventCount(continuousRoot, "compile-start"), beforeMismatchStarts, "compiler mismatch must not spawn a competing TeX run");

		assert.ok(existsSync(continuousRoot.pdfPath), "continuous root PDF should exist before clean");
		const beforeCleanStarts = eventCount(continuousRoot, "compile-start");
		const clean = expectCompileSuccess(
			await callCompile(socketPath, continuousRoot, { clean: true }, "continuous-A"),
			"clean while continuous active",
		);
		assert.equal(clean.clean, true);
		assert.ok(clean.cleaned_artifacts?.includes(continuousRoot.pdfPath), "clean should remove the pre-clean PDF before rebuilding");
		assert.equal(clean.continuous?.status, "started");
		assert.equal(clean.continuous?.subscriber_count, 2);
		assert.ok(eventCount(continuousRoot, "compile-start") > beforeCleanStarts, "clean restart should produce a post-clean TeX run");
		assert.ok(existsSync(continuousRoot.pdfPath), "post-clean PDF should exist");
		assert.ok(existsSync(continuousRoot.logPath), "post-clean log should exist");

		const unsubscribeA = expectCompileSuccess(
			await callCompile(socketPath, continuousRoot, { continuous: false }, "continuous-A"),
			"unsubscribe first continuous session",
		);
		assert.equal(unsubscribeA.continuous?.status, "still_active_for_other_subscribers");
		assert.equal(unsubscribeA.continuous?.subscriber_count, 1);
		const unsubscribeB = expectCompileSuccess(
			await callCompile(socketPath, continuousRoot, { continuous: false }, "continuous-B"),
			"unsubscribe final continuous session",
		);
		assert.equal(unsubscribeB.continuous?.status, "stopped");
		assert.equal(unsubscribeB.continuous?.subscriber_count, 0);

		await waitUntil(() => !existsSync(continuousRoot.lockPath), "continuous root lock marker should be cleared after successful runs");
		assertNoOverlapEvents([sameRoot, otherRootA, otherRootB, continuousRoot]);
		assert.equal(viewerBackend.openRequests.length, 0, "open_pdf=false smoke should not touch the viewer backend");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtime.dir, { recursive: true, force: true });
		runtime.restore();
	}
});

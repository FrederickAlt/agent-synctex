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
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	FakeViewerBackend,
	HostServiceClient,
	HostServicePdfIdRegistry,
	HostServiceServer,
	ZathuraViewerBackend,
	type HostServiceOpenRequest,
} from "../../src/modules/host_service.ts";
import { HostServiceManagedViewerService } from "../../src/modules/host_service_managed_viewer.ts";
import { getMcpFixedPreviewPdfPath } from "../../src/modules/runtime_paths.ts";
import { INLINE_PREVIEW_DIR } from "../../src/modules/preview/inline_preview.ts";

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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 1200): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return;
		}
		await sleep(25);
	}
	throw new Error(`timed out waiting for process ${pid} to exit`);
}

function writeFakeLatexCompiler(binDir: string, options: { exitCode?: number; withLog?: boolean; logText?: string; stdoutText?: string; afterPdfScript?: string } = {}): string {
	const exitCode = options.exitCode ?? 0;
	const withLog = options.withLog ?? true;
	const logText = options.logText ?? "fake compiler output";
	const stdoutText = options.stdoutText ?? "";
	const afterPdfScript = options.afterPdfScript ?? "";
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	const compilerPath = join(binDir, "latexmk");
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
  cat > "$out_dir/$name.log" <<'LOGTEXT'
${logText}
LOGTEXT
fi` : ""}
${stdoutText ? `cat <<'STDOUTTEXT'
${stdoutText}
STDOUTTEXT
` : ""}printf '%s' '%PDF-1.4\n' > "$out_dir/$name.pdf"
${afterPdfScript ? `${afterPdfScript}
` : ""}exit ${exitCode}
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

function writeFakeZathuraViewerBinary(path: string): void {
	const script = `#!/usr/bin/env bash
set -eu
trap 'exit 0' INT TERM
while true; do
	if [ "$PPID" -eq 1 ]; then
		exit 0
	fi
	sleep 0.05
	done
`;
	writeFileSync(path, script, { encoding: "utf8", mode: 0o700 });
	chmodSync(path, 0o700);
}

function shellSingleQuoted(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function writeLatexmkWithRecorderCacheProbe(binDir: string, stateDir: string, options: { dependencyPath?: string; omitRecorder?: boolean } = {}): string {
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	mkdirSync(stateDir, { mode: 0o700, recursive: true });
	const compilerPath = join(binDir, "latexmk");
	const dependencyInput = options.dependencyPath === undefined ? "" : `printf 'INPUT %s\\n' ${shellSingleQuoted(options.dependencyPath)} >> \"$out_dir/$name.fls\"`;
	const recorderOutput = options.omitRecorder === true ? "" : `cat > \"$out_dir/$name.fls\" <<FLS
PWD $out_dir
INPUT $out_dir/$base
FLS
${dependencyInput}`;
	writeFileSync(compilerPath, `#!/usr/bin/env bash
set -eu
state_dir=${shellSingleQuoted(stateDir)}
mkdir -p "$state_dir"
tex_file=""
out_dir="$(pwd)"
prev=""
for arg in "$@"; do
  if [ "$prev" = "-output-directory" ]; then
    out_dir="$arg"
  fi
  tex_file="$arg"
  prev="$arg"
done
base="\${tex_file##*/}"
name="\${base%.*}"
count_file="$state_dir/$name.count"
count=0
if [ -f "$count_file" ]; then
  count=$(cat "$count_file")
fi
printf '%s' "$((count + 1))" > "$count_file"
${recorderOutput}
if grep -q 'FAIL' "$out_dir/$base"; then
  cat > "$out_dir/$name.log" <<'LOGTEXT'
! Undefined control sequence.
l.2 \\bad
LOGTEXT
  exit 7
fi
cat > "$out_dir/$name.log" <<'LOGTEXT'
LaTeX Warning: Reference \`missing' on page 1 undefined on input line 3.
Output written on paper.pdf (1 page, 123 bytes).
LOGTEXT
printf '%s' '%PDF-1.4\\n' > "$out_dir/$name.pdf"
exit 0
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

function writeRootScopedProbeLatexmk(binDir: string, stateDir: string, options: { sleepSeconds?: string; failFirst?: boolean } = {}): string {
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	mkdirSync(stateDir, { mode: 0o700, recursive: true });
	const compilerPath = join(binDir, "latexmk");
	const sleepSeconds = options.sleepSeconds ?? "0.25";
	const failFirst = options.failFirst === true ? "1" : "0";
	writeFileSync(compilerPath, `#!/usr/bin/env bash
set -eu
state_dir=${shellSingleQuoted(stateDir)}
sleep_seconds=${shellSingleQuoted(sleepSeconds)}
fail_first=${failFirst}
mkdir -p "$state_dir"
tex_file=""
out_dir=""
prev=""
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
lock="$state_dir/$name.lock"
if ! mkdir "$lock" 2>/dev/null; then
  printf '%s\n' "$name overlap" >> "$state_dir/overlap.txt"
  cat > "$out_dir/$name.log" <<'LOGTEXT'
Runaway argument?
File ended while scanning use of \\@newl@bel.
LOGTEXT
  exit 13
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT INT TERM
count_file="$state_dir/$name.count"
count=0
if [ -f "$count_file" ]; then
  count=$(cat "$count_file")
fi
printf '%s' "$((count + 1))" > "$count_file"
printf '%s start\n' "$name" >> "$state_dir/events.txt"
printf '%s' started > "$state_dir/$name.started"
sleep "$sleep_seconds"
if [ "$fail_first" = "1" ] && [ "$count" = "0" ]; then
  cat > "$out_dir/$name.log" <<'LOGTEXT'
! Undefined control sequence.
LOGTEXT
  printf '%s end-fail\n' "$name" >> "$state_dir/events.txt"
  exit 7
fi
cat > "$out_dir/$name.log" <<'LOGTEXT'
fake compiler output
Output written on paper.pdf (1 page, 123 bytes).
LOGTEXT
printf '%s' '%PDF-1.4\n' > "$out_dir/$name.pdf"
printf '%s end\n' "$name" >> "$state_dir/events.txt"
exit 0
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

function writeUncoordinatedAuxRaceLatexmk(binDir: string, stateDir: string): string {
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	mkdirSync(stateDir, { mode: 0o700, recursive: true });
	const compilerPath = join(binDir, "latexmk");
	writeFileSync(compilerPath, `#!/usr/bin/env bash
set -eu
state_dir=${shellSingleQuoted(stateDir)}
mkdir -p "$state_dir"
tex_file=""
for arg in "$@"; do tex_file="$arg"; done
base="\${tex_file##*/}"
name="\${base%.*}"
lock="$state_dir/$name.lock"
if ! mkdir "$lock" 2>/dev/null; then
  cat > "$name.log" <<'LOGTEXT'
Runaway argument?
File ended while scanning use of \\@newl@bel.
LOGTEXT
  cat "$name.log"
  exit 12
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT INT TERM
printf '%s' started > "$state_dir/first.started"
sleep 0.25
cat > "$name.log" <<'LOGTEXT'
Output written on paper.pdf (1 page, 123 bytes).
LOGTEXT
printf '%s' '%PDF-1.4\n' > "$name.pdf"
exit 0
`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	return compilerPath;
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env });
		let output = "";
		child.stdout.on("data", (chunk) => { output += String(chunk); });
		child.stderr.on("data", (chunk) => { output += String(chunk); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
	});
}

function writeFakeForkingZathuraViewerBinary(path: string, options: { childPidFile?: string } = {}): void {
	const childPidFile = options.childPidFile ?? "";
	const quotedChildPidFile = shellSingleQuoted(childPidFile);
	const script = `#!/usr/bin/env bash
set -eu
if [ "$1" = "--zathura-existing" ]; then
	shift
	while true; do
		sleep 1
	done
fi
if [ "$1" = "--zathura-fork-child" ]; then
	shift
	childPidFile=${quotedChildPidFile}
	if [ -n "$childPidFile" ]; then
		printf '%s' "$$" > "$childPidFile"
	fi
	while true; do
		sleep 1
	done
fi
"$0" --zathura-fork-child "$@" &
exit 0
`;
	writeFileSync(path, script, { encoding: "utf8", mode: 0o700 });
	chmodSync(path, 0o700);
}

function writeFakeShortLivedZathuraViewerBinary(path: string): void {
	const script = `#!/usr/bin/env bash
set -eu
if [ "$1" = "--zathura-existing" ]; then
	shift
	while true; do
		sleep 1
	done
fi
exit 0
`;
	writeFileSync(path, script, { encoding: "utf8", mode: 0o700 });
	chmodSync(path, 0o700);
}

function createMiniPng(width: number, height: number): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdrLength = Buffer.alloc(4);
	ihdrLength.writeUInt32BE(13, 0);
	const ihdrType = Buffer.from("IHDR");
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	ihdrData[8] = 8;
	ihdrData[9] = 6;
	ihdrData[10] = 0;
	ihdrData[11] = 0;
	ihdrData[12] = 0;
	const ihdrCrc = Buffer.alloc(4);
	const iendLength = Buffer.alloc(4);
	iendLength.writeUInt32BE(0, 0);
	const iendType = Buffer.from("IEND");
	const iendCrc = Buffer.alloc(4);
	return Buffer.concat([
		signature,
		ihdrLength,
		ihdrType,
		ihdrData,
		ihdrCrc,
		iendLength,
		iendType,
		iendCrc,
	]);
}

function writeFakeMutool(binDir: string, width = 64, height = 48): string {
	const png = createMiniPng(width, height).toString("base64");
	mkdirSync(binDir, { mode: 0o700, recursive: true });
	const mutoolPath = join(binDir, "mutool");
	writeFileSync(mutoolPath, `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
if [ -z "$out" ]; then
  exit 1
fi
printf '%s' '${png}' | base64 -d > "$out"
`);
	chmodSync(mutoolPath, 0o700);
	return mutoolPath;
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

class RecordingFakeViewerBackend extends FakeViewerBackend {
	readonly openedDetails: Array<Record<string, unknown>> = [];

	async open(requestId: string, details: Record<string, unknown>) {
		this.openedDetails.push({ ...details });
		return super.open(requestId, details);
	}
}

class ValidatingFakeViewerBackend extends FakeViewerBackend {
	async open(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["open"]> {
		const pdfPath = typeof details.pdf_path === "string" ? details.pdf_path : undefined;
		if (pdfPath) {
			let header = "";
			try {
				header = readFileSync(pdfPath, "utf8");
			} catch {
				return {
					status: "error",
					error: "pdf_path is not a PDF file",
					status_details: {
						protocol_version: 1,
						supported: true,
						service_available: true,
						backend: this.name,
						backend_path: this.name,
						capabilities: this.capabilities,
						owned: false,
						reused: false,
						error_code: "invalid_pdf",
						reason: "pdf_path is not a PDF file",
					},
				};
			}
			if (!header.startsWith("%PDF-")) {
				return {
					status: "error",
					error: "pdf_path is not a PDF file",
					status_details: {
						protocol_version: 1,
						supported: true,
						service_available: true,
						backend: this.name,
						backend_path: this.name,
						capabilities: this.capabilities,
						owned: false,
						reused: false,
						error_code: "invalid_pdf",
						reason: "pdf_path is not a PDF file",
					},
				};
			}
		}
		return super.open(requestId, details);
	}
}

class CloseTrackingFakeViewerBackend extends FakeViewerBackend {
	public closeCalled: string[] = [];
	public closeAllCalled = false;
	public openHandleSequence: string[] = [];

	async open(
		requestId: string,
		details: Record<string, unknown>,
	): ReturnType<FakeViewerBackend["open"]> {
		const result = await super.open(requestId, details);
		if (result.status === "ok") {
			const handle = result.status_details.handle;
			if (typeof handle === "string") {
				this.openHandleSequence.push(handle);
			}
		}
		return result;
	}

	async close(
		requestId: string,
		details: Record<string, unknown>,
	): ReturnType<FakeViewerBackend["close"]> {
		const handle = typeof details.handle === "string" ? details.handle : "unknown";
		this.closeCalled.push(handle);
		return super.close(requestId, details);
	}

	async closeAll(requestId = "service-shutdown"): Promise<void> {
		this.closeAllCalled = true;
		for (const handle of [...this.openHandleSequence]) {
			if (!this.closeCalled.includes(handle)) {
				await this.close(requestId, { handle, backend: this.name });
			}
		}
	}
}

class CloseControlledFakeViewerBackend extends FakeViewerBackend {
	readonly closeMode: "closed" | "not_service_owned" | "not_running" | "backend_unavailable" | "identity_mismatch";

	constructor(
		closeMode: "closed" | "not_service_owned" | "not_running" | "backend_unavailable" | "identity_mismatch",
		options?: ConstructorParameters<typeof FakeViewerBackend>[0],
	) {
		super(options);
		this.closeMode = closeMode;
	}

	async close(
		_requestId: string,
		details: Record<string, unknown>,
	): ReturnType<FakeViewerBackend["close"]> {
		const handle = typeof details.handle === "string" ? details.handle : undefined;
		if (this.closeMode === "closed") {
			return {
				status: "ok",
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: this.name,
					backend_identity_ok: true,
					backend_path: this.name,
					handle,
					closed: true,
				},
			};
		}
		if (this.closeMode === "not_service_owned") {
			return {
				status: "ok",
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: this.name,
					backend_identity_ok: true,
					backend_path: this.name,
					handle,
					closed: false,
					reason: "not_service_owned",
				},
			};
		}
		if (this.closeMode === "not_running") {
			return {
				status: "ok",
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: this.name,
					backend_identity_ok: true,
					backend_path: this.name,
					handle,
					closed: false,
					reason: "not_running",
				},
			};
		}
		if (this.closeMode === "identity_mismatch") {
			return {
				status: "error",
				error: "backend identity mismatch",
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: "different-backend",
					backend_identity_ok: false,
					backend_path: this.name,
					handle,
					closed: false,
					error_code: "identity_mismatch",
					reason: "backend identity mismatch",
				},
			};
		}
		return {
			status: "error",
			error: "backend unavailable",
			status_details: {
				protocol_version: 1,
				supported: false,
				service_available: false,
				backend: this.name,
				backend_identity_ok: true,
				backend_path: this.name,
				handle,
				closed: false,
				error_code: "backend_unavailable",
				reason: "backend unavailable",
			},
		};
	}
}

class OwnedAwareFakeViewerBackend extends FakeViewerBackend {
	readonly openOwned: boolean;

	constructor(openOwned: boolean, options?: ConstructorParameters<typeof FakeViewerBackend>[0]) {
		super(options);
		this.openOwned = openOwned;
	}

	async open(
		requestId: string,
		details: Record<string, unknown>,
	): ReturnType<FakeViewerBackend["open"]> {
		const result = await super.open(requestId, details);
		if (result.status === "ok") {
			const statusDetails = result.status_details as Record<string, unknown>;
			statusDetails.owned = this.openOwned;
		}
		return result;
	}
}

class FakeForwardSearchTracker extends FakeViewerBackend {
	readonly forwardSearchCalls: Array<Record<string, unknown>> = [];
	readonly reopenFailureOnSecondOpen: boolean;
	private openCallCount = 0;
	private forwardSearchResponses: Array<{
		status: "ok" | "error";
		error?: string;
		handled?: boolean;
		error_code?: string;
		reason?: string;
		service_available?: boolean;
		backend_identity_ok?: boolean;
		diagnostics?: Array<Record<string, unknown>>;
	}> = [];

	constructor(
		options: ConstructorParameters<typeof FakeViewerBackend>[0] = {},
		reopenFailureOnSecondOpen = false,
	) {
		super(options);
		this.reopenFailureOnSecondOpen = reopenFailureOnSecondOpen;
	}

	setForwardSearchResponses(
		responses: Array<{
			status: "ok" | "error";
			error?: string;
			handled?: boolean;
			error_code?: string;
			reason?: string;
			service_available?: boolean;
			backend_identity_ok?: boolean;
			diagnostics?: Array<Record<string, unknown>>;
		}>,
	): void {
		this.forwardSearchResponses = responses;
	}

	async open(
		requestId: string,
		details: Record<string, unknown>,
	): ReturnType<FakeViewerBackend["open"]> {
		this.openCallCount += 1;
		if (this.reopenFailureOnSecondOpen && this.openCallCount > 1) {
			return {
				status: "error",
				error: "viewer backend is unavailable",
				status_details: {
					protocol_version: 1,
					supported: false,
					service_available: false,
					backend: this.name,
					backend_path: this.name,
					handle: typeof details.handle === "string" ? details.handle : undefined,
					handled: false,
					backend_identity_ok: false,
					error_code: "backend_unavailable",
					reason: "viewer backend is unavailable",
				},
			};
		}
		return super.open(requestId, details);
	}

	async forwardSearch(
		_requestId: string,
		details: Record<string, unknown>,
	): ReturnType<FakeViewerBackend["forwardSearch"]> {
		this.forwardSearchCalls.push({ ...details });
		const next = this.forwardSearchResponses.shift();
		if (!next) {
			return {
				status: "ok",
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: this.name,
					backend_path: this.name,
					backend_identity_ok: true,
					handled: true,
					handle: typeof details.handle === "string" ? details.handle : undefined,
					reason: "forward search handled",
				},
			};
		}
		return {
			status: next.status,
			error: next.error,
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: next.service_available ?? true,
				backend: this.name,
				backend_path: this.name,
				handle: typeof details.handle === "string" ? details.handle : undefined,
				backend_identity_ok: next.backend_identity_ok ?? false,
				handled: next.handled ?? false,
				error_code: next.error_code,
				reason: next.reason,
				diagnostics: next.diagnostics,
			},
		};
	}
}

class ConcurrentCloseReopenBackend extends FakeForwardSearchTracker {
	readonly closeHandles: string[] = [];
	private raceOpenCallCount = 0;
	private releaseReopen: (() => void) | undefined;
	private readonly reopenReleased = new Promise<void>((resolve) => {
		this.releaseReopen = resolve;
	});
	private reopenRequestedResolve: (() => void) | undefined;
	private readonly reopenRequested = new Promise<void>((resolve) => {
		this.reopenRequestedResolve = resolve;
	});

	async open(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["open"]> {
		this.raceOpenCallCount += 1;
		if (this.raceOpenCallCount === 1) {
			return super.open(requestId, details);
		}
		this.reopenRequestedResolve?.();
		await this.reopenReleased;
		return super.open(requestId, details);
	}

	async forwardSearch(_requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["forwardSearch"]> {
		this.forwardSearchCalls.push({ ...details });
		if (this.forwardSearchCalls.length === 1) {
			return {
				status: "error",
				error: "viewer handle not recognized",
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: this.name,
					backend_path: this.name,
					backend_identity_ok: false,
					handled: false,
					error_code: "handle_not_found",
					reason: "viewer handle not recognized",
					handle: typeof details.handle === "string" ? details.handle : undefined,
				},
			};
		}
		return super.forwardSearch(_requestId, details);
	}

	async close(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["close"]> {
		if (typeof details.handle === "string") {
			this.closeHandles.push(details.handle);
		}
		return super.close(requestId, details);
	}

	async waitForReopenRequest(): Promise<void> {
		await this.reopenRequested;
	}

	finishReopen(): void {
		this.releaseReopen?.();
	}
}

class DeterministicManagedViewerBackend extends FakeForwardSearchTracker {
	private openHandleCounter = 0;

	async open(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["open"]> {
		const pdfPath = typeof details.pdf_path === "string" ? details.pdf_path : undefined;
		if (!pdfPath) {
			return {
				status: "error",
				error: "missing pdf_path",
				status_details: {
					protocol_version: 1,
					supported: false,
					service_available: true,
					backend: this.name,
					backend_path: this.name,
					owned: false,
					reused: false,
					error_code: "invalid_request",
					capabilities: this.capabilities,
				},
			};
		}
		this.openHandleCounter += 1;
		return {
			status: "ok",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: this.name,
				backend_path: this.name,
				capabilities: this.capabilities,
				handle: `managed-${this.openHandleCounter}`,
				owned: true,
				reused: false,
				pid: 4242,
			},
		};
	}

	async close(_requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["close"]> {
		return {
			status: "ok",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: this.name,
				backend_path: this.name,
				backend_identity_ok: true,
				handle: typeof details.handle === "string" ? details.handle : undefined,
				closed: true,
			},
		};
	}
}

class IncrementingHandlePidViewerBackend extends FakeForwardSearchTracker {
	private openHandleCounter = 0;

	async open(_requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["open"]> {
		const pdfPath = typeof details.pdf_path === "string" ? details.pdf_path : undefined;
		if (!pdfPath) {
			return {
				status: "error",
				error: "missing pdf_path",
				status_details: {
					protocol_version: 1,
					supported: false,
					service_available: true,
					backend: this.name,
					backend_path: this.name,
					owned: false,
					reused: false,
					error_code: "invalid_request",
					capabilities: this.capabilities,
				},
			};
		}
		this.openHandleCounter += 1;
		return {
			status: "ok",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: this.name,
				backend_path: this.name,
				capabilities: this.capabilities,
				handle: `viewer-handle-${this.openHandleCounter}`,
				owned: true,
				reused: false,
				pid: 9000 + this.openHandleCounter,
			},
		};
	}

	async close(_requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["close"]> {
		return {
			status: "ok",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: this.name,
				backend_path: this.name,
				backend_identity_ok: true,
				handle: typeof details.handle === "string" ? details.handle : undefined,
				closed: true,
			},
		};
	}
}

class SignalingReadinessBackend extends IncrementingHandlePidViewerBackend {
	private readinessFailureResolve: (() => void) | undefined;
	private readonly readinessFailure = new Promise<void>((resolve) => {
		this.readinessFailureResolve = resolve;
	});

	override async forwardSearch(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["forwardSearch"]> {
		const result = await super.forwardSearch(requestId, details);
		if (this.forwardSearchCalls.length === 2) {
			this.readinessFailureResolve?.();
		}
		return result;
	}

	async waitForReadinessFailure(): Promise<void> {
		await this.readinessFailure;
	}
}

class HangingReopenedForwardSearchBackend extends IncrementingHandlePidViewerBackend {
	override async forwardSearch(_requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["forwardSearch"]> {
		this.forwardSearchCalls.push({ ...details });
		if (this.forwardSearchCalls.length === 1) {
			return {
				status: "error",
				error: "viewer process is not running",
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: this.name,
					backend_path: this.name,
					handle: typeof details.handle === "string" ? details.handle : undefined,
					backend_identity_ok: true,
					handled: false,
					error_code: "not_running",
					reason: "not_running",
				},
			};
		}
		return await new Promise(() => undefined);
	}
}

class CountingOpenViewerBackend extends FakeViewerBackend {
	public openCalls = 0;
	public closeCalls = 0;

	async open(_requestId: string, _details: Record<string, unknown>): ReturnType<FakeViewerBackend["open"]> {
		this.openCalls += 1;
		return super.open(_requestId, _details);
	}

	async close(_requestId: string, _details: Record<string, unknown>): ReturnType<FakeViewerBackend["close"]> {
		this.closeCalls += 1;
		return super.close(_requestId, _details);
	}
}

class ThrowingViewerBackend extends FakeViewerBackend {
	async open(): ReturnType<FakeViewerBackend["open"]> {
		throw new Error("viewer backend exploded");
	}
}

class HangingManagedViewerBackend extends FakeViewerBackend {
	async open(): ReturnType<FakeViewerBackend["open"]> {
		return await new Promise(() => undefined);
	}
}

class LateSuccessManagedViewerBackend extends CountingOpenViewerBackend {
	public closeResults: Awaited<ReturnType<FakeViewerBackend["close"]>>[] = [];
	private readonly delayMs: number;

	constructor(delayMs: number) {
		super({
			name: "agent-synctex-late-success-backend",
			capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
		});
		this.delayMs = delayMs;
	}

	async open(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["open"]> {
		await sleep(this.delayMs);
		return await super.open(requestId, details);
	}

	async close(requestId: string, details: Record<string, unknown>): ReturnType<FakeViewerBackend["close"]> {
		const result = await super.close(requestId, details);
		this.closeResults.push(result);
		return result;
	}
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
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-test",
		viewerBackend: new FakeViewerBackend(),
	});
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


test("host service waits for latex compiler process before reporting success", async () => {
	const baseDir = temporaryDir("host-service-compile-waits-for-exit-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const finishedMarker = join(baseDir, "compiler-finished");
	writeFakeLatexCompiler(join(baseDir, "bin"), {
		afterPdfScript: `sleep 0.35\nprintf 'done' > ${JSON.stringify(finishedMarker)}`,
	});
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-wait-test" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const startedAt = Date.now();
		const result = await client.requestCompileLatexFile(
			{
				latex_file_path: "paper.tex",
				compiler: "lualatex",
				clean: false,
			},
			{ cwd: baseDir },
		);
		const elapsedMs = Date.now() - startedAt;
		assert.equal(result.operation, "compile_latex_file");
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
		assert.equal(existsSync(finishedMarker), true, "compile returned before the compiler reached its final statement");
		assert.ok(elapsedMs >= 300, `compile returned too quickly: ${elapsedMs}ms`);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("uncoordinated same-root latexmk processes can surface aux-read failures while another writes a PDF", async () => {
	const baseDir = temporaryDir("host-service-uncoordinated-aux-race-");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeUncoordinatedAuxRaceLatexmk(join(baseDir, "bin"), stateDir);
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");
	const env = { ...process.env, PATH: `${join(baseDir, "bin")}:${originalPath}` };

	try {
		const first = runProcess("latexmk", ["paper.tex"], baseDir, env);
		await waitForFile(join(stateDir, "first.started"));
		const second = runProcess("latexmk", ["paper.tex"], baseDir, env);
		const results = await Promise.all([first, second]);
		assert.equal(results.some((result) => result.code === 0), true, "one uncoordinated compile should still be able to produce a PDF");
		assert.equal(results.some((result) => result.code !== 0 && /@newl@bel/.test(result.output)), true);
		assert.equal(existsSync(join(baseDir, "paper.pdf")), true);
	} finally {
		process.env.PATH = originalPath;
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service serializes concurrent same-root compile_latex_file requests", async () => {
	const baseDir = temporaryDir("host-service-compile-serialized-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeRootScopedProbeLatexmk(join(baseDir, "bin"), stateDir, { sleepSeconds: "0.25" });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-serialized" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const [relativeResult, absoluteResult] = await Promise.all([
			client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir }),
			client.requestCompileLatexFile({ latex_file_path: join(baseDir, "paper.tex"), compiler: "lualatex" }, { cwd: baseDir }),
		]);
		assert.equal(relativeResult.pdf, join(baseDir, "paper.pdf"));
		assert.equal(absoluteResult.pdf, join(baseDir, "paper.pdf"));
		assert.equal(existsSync(join(stateDir, "overlap.txt")), false);
		assert.deepEqual(readFileSync(join(stateDir, "events.txt"), "utf8").trim().split("\n"), [
			"paper start",
			"paper end",
			"paper start",
			"paper end",
		]);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service reuses fresh same-root one-shot result without spawning latexmk again", async () => {
	const baseDir = temporaryDir("host-service-compile-cache-reuse-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeLatexmkWithRecorderCacheProbe(join(baseDir, "bin"), stateDir);
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-cache-reuse" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const first = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		const second = await client.requestCompileLatexFile({ latex_file_path: join(baseDir, "paper.tex"), compiler: "lualatex" }, { cwd: baseDir });

		assert.equal(first.pdf, join(baseDir, "paper.pdf"));
		assert.equal(second.pdf, first.pdf);
		assert.equal(second.log, first.log);
		assert.deepEqual(second.artifact_paths, first.artifact_paths);
		assert.equal(second.compile_status, "ok_with_warnings");
		assert.equal(second.compiler_exit_code, 0);
		assert.equal(second.compiler_signal, null);
		assert.equal(second.warning_count, 1);
		assert.deepEqual(second.warnings, first.warnings);
		assert.equal(readFileSync(join(stateDir, "paper.count"), "utf8"), "1");

		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "pdflatex" }, { cwd: baseDir });
		assert.equal(readFileSync(join(stateDir, "paper.count"), "utf8"), "2");
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service invalidates cached success when a known latexmk dependency changes", async () => {
	const baseDir = temporaryDir("host-service-compile-cache-stale-dep-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	const dependencyPath = join(baseDir, "chapter.tex");
	writeLatexmkWithRecorderCacheProbe(join(baseDir, "bin"), stateDir, { dependencyPath });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n");
	writeFileSync(dependencyPath, "chapter one\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-cache-stale-dep" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		writeFileSync(dependencyPath, "chapter two\n");
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });

		assert.equal(readFileSync(join(stateDir, "paper.count"), "utf8"), "2");
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service preserves cached fatal diagnostics and replaces stale failures after a fix", async () => {
	const baseDir = temporaryDir("host-service-compile-cache-failure-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeLatexmkWithRecorderCacheProbe(join(baseDir, "bin"), stateDir);
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const sourcePath = join(baseDir, "paper.tex");
	writeFileSync(sourcePath, "\\documentclass{article}\nFAIL\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-cache-failure" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		let firstFailure: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		} catch (error) {
			firstFailure = error;
		}
		let cachedFailure: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		} catch (error) {
			cachedFailure = error;
		}

		assert.ok(firstFailure instanceof Error && "statusDetails" in firstFailure);
		assert.ok(cachedFailure instanceof Error && "statusDetails" in cachedFailure);
		const firstDetails = firstFailure.statusDetails as Record<string, unknown>;
		const cachedDetails = cachedFailure.statusDetails as Record<string, unknown>;
		assert.equal(cachedDetails.error_code, firstDetails.error_code);
		assert.deepEqual(cachedDetails.diagnostics, firstDetails.diagnostics);
		assert.equal(readFileSync(join(stateDir, "paper.count"), "utf8"), "1");

		writeFileSync(sourcePath, "\\documentclass{article}\n\\begin{document}\nfixed\\end{document}\n");
		const success = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		assert.equal(success.compile_status, "ok_with_warnings");
		assert.equal(readFileSync(join(stateDir, "paper.count"), "utf8"), "2");
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service recompiles when latexmk dependency freshness is unavailable", async () => {
	const baseDir = temporaryDir("host-service-compile-cache-conservative-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeLatexmkWithRecorderCacheProbe(join(baseDir, "bin"), stateDir, { omitRecorder: true });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-cache-conservative" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		assert.equal(readFileSync(join(stateDir, "paper.count"), "utf8"), "2");
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service keeps different-root compile_latex_file requests independent", async () => {
	const baseDir = temporaryDir("host-service-compile-different-roots-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeRootScopedProbeLatexmk(join(baseDir, "bin"), stateDir, { sleepSeconds: "0.35" });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "alpha.tex"), "\\documentclass{article}\n\\begin{document}\nalpha\\end{document}\n");
	writeFileSync(join(baseDir, "beta.tex"), "\\documentclass{article}\n\\begin{document}\nbeta\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-independent" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const startedAt = Date.now();
		await Promise.all([
			client.requestCompileLatexFile({ latex_file_path: "alpha.tex", compiler: "lualatex" }, { cwd: baseDir }),
			client.requestCompileLatexFile({ latex_file_path: "beta.tex", compiler: "lualatex" }, { cwd: baseDir }),
		]);
		const elapsedMs = Date.now() - startedAt;
		const events = readFileSync(join(stateDir, "events.txt"), "utf8").trim().split("\n");
		assert.match(events[0], / start$/);
		assert.match(events[1], / start$/);
		assert.ok(elapsedMs < 650, `different roots were unexpectedly serialized: ${elapsedMs}ms`);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service runs queued same-root requests after process failure", async () => {
	const baseDir = temporaryDir("host-service-compile-failure-releases-queue-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeRootScopedProbeLatexmk(join(baseDir, "bin"), stateDir, { sleepSeconds: "0.15", failFirst: true });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-failure-releases" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const results = await Promise.allSettled([
			client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir }),
			client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir }),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		assert.equal(existsSync(join(stateDir, "overlap.txt")), false);
		assert.deepEqual(readFileSync(join(stateDir, "events.txt"), "utf8").trim().split("\n"), [
			"paper start",
			"paper end-fail",
			"paper start",
			"paper end",
		]);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service request timeout cancels queued same-root compile work", async () => {
	const baseDir = temporaryDir("host-service-compile-queue-timeout-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeRootScopedProbeLatexmk(join(baseDir, "bin"), stateDir, { sleepSeconds: "0.45" });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-queue-timeout" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const first = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		await waitForFile(join(stateDir, "paper.started"));
		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir }, undefined, 120);
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /timed out/);
		await first;
		await sleep(180);
		assert.deepEqual(readFileSync(join(stateDir, "events.txt"), "utf8").trim().split("\n"), [
			"paper start",
			"paper end",
		]);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service stop releases queued same-root compile requests", async () => {
	const baseDir = temporaryDir("host-service-compile-stop-releases-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	const stateDir = join(baseDir, "state");
	writeRootScopedProbeLatexmk(join(baseDir, "bin"), stateDir, { sleepSeconds: "1" });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-stop-releases" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const first = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		first.catch(() => undefined);
		await waitForFile(join(stateDir, "paper.started"));
		const second = client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		second.catch(() => undefined);
		await sleep(50);
		await server.stop();
		const results = await Promise.allSettled([first, second]);
		assert.equal(results.every((result) => result.status === "rejected"), true);
		assert.equal(results.some((result) => result.status === "rejected" && /host_service_stopped/.test(String(result.reason))), true);
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

test("host service compile_latex_file reports warning-only compiles without failing", async () => {
	const baseDir = temporaryDir("host-service-compile-warnings-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), {
		logText: "LaTeX Warning: Reference `foo' undefined on input line 3.\nOverfull \\hbox (12.0pt too wide) in paragraph at lines 4--5\nOutput written on paper.pdf (1 page, 123 bytes).",
	});
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-warnings" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const result = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		assert.equal(result.compile_status, "ok_with_warnings");
		assert.equal(result.warning_count, 2);
		assert.equal(result.warnings?.some((warning) => /Reference `foo'/.test(warning.message)), true);
		assert.equal(result.warnings?.some((warning) => /Overfull/.test(warning.message)), true);
		assert.equal(result.log, join(baseDir, "paper.log"));
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_file accepts nonzero compiler status when PDF was freshly written", async () => {
	const baseDir = temporaryDir("host-service-compile-nonzero-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), {
		exitCode: 9,
		logText: "LaTeX Warning: Reference `foo' undefined on input line 3.\nOutput written on paper.pdf (1 page, 123 bytes).",
	});
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nhi\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-nonzero-pdf" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		const result = await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		assert.equal(result.compile_status, "nonzero_but_pdf_updated");
		assert.equal(result.compiler_exit_code, 9);
		assert.equal(result.pdf, join(baseDir, "paper.pdf"));
		assert.equal(result.warning_count, 1);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_file treats nonzero fatal diagnostics as failure even when PDF was written", async () => {
	const baseDir = temporaryDir("host-service-compile-nonzero-fatal-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), {
		exitCode: 9,
		logText: "! Undefined control sequence.\nl.4 \\badmacro\nOutput written on paper.pdf (1 page, 123 bytes).",
	});
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\n\\badmacro\\end{document}\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-nonzero-fatal-pdf" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /code=compile_failed/);
		assert.match(observed.message, /Undefined control sequence/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_file reports stale existing PDFs as compile failures", async () => {
	const baseDir = temporaryDir("host-service-compile-stale-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	mkdirSync(join(baseDir, "bin"), { mode: 0o700, recursive: true });
	const compilerPath = join(baseDir, "bin", "latexmk");
	writeFileSync(compilerPath, `#!/bin/sh\nset -eu\ntex_file=""\nfor arg in "$@"; do tex_file="$arg"; done\nbase="\${tex_file##*/}"\nname="\${base%.*}"\necho "! Undefined control sequence." > "$name.log"\nexit 1\n`, { mode: 0o700 });
	chmodSync(compilerPath, 0o700);
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\n\\badmacro\\end{document}\n");
	writeFileSync(join(baseDir, "paper.pdf"), "%PDF-1.4\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-stale-pdf" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });
	try {
		let observed: unknown;
		try {
			await client.requestCompileLatexFile({ latex_file_path: "paper.tex", compiler: "lualatex" }, { cwd: baseDir });
		} catch (error) {
			observed = error;
		}
		assert.ok(observed instanceof Error);
		assert.match(observed.message, /code=failed_stale_pdf_exists/);
		assert.match(observed.message, /Undefined control sequence/);
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

test("host service rasterize request with missing payload details is rejected", async () => {
	const baseDir = temporaryDir("host-service-rasterize-malformed-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-malformed" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "rasterize-malformed-request-id",
		operation: "rasterize",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.operation, "rasterize");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.match(response.error, /missing rasterize details/);
});

test("host service rasterize missing pdf returns host-service invalid_request code", async () => {
	const baseDir = temporaryDir("host-service-rasterize-missing-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-missing-pdf" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "rasterize-missing-pdf-id",
		operation: "rasterize",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
		details: {
			pdf_path: join(baseDir, "missing.pdf"),
		},
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.operation, "rasterize");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.equal(response.status_details.pdf_path, join(baseDir, "missing.pdf"));
	assert.equal(response.status_details.artifacts.length, 0);
	assert.equal(response.status_details.artifact_paths.length, 0);
	assert.match(response.error, /does not exist/);
});

test("host service rasterize rejects invalid page request as invalid_request", async () => {
	const baseDir = temporaryDir("host-service-rasterize-invalid-page-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeMutool(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "sample.pdf"), "%PDF-1.4\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-invalid-page" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestRasterizePdf({ pdf_path: "sample.pdf", page: 0 }, { cwd: baseDir });
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /page must be a positive integer/);
	assert.match(observed.message, /code=invalid_request/);
	assert.doesNotMatch(observed.message, /Malformed host service response payload/);
});

test("host service rasterize returns artifact metadata", async () => {
	const baseDir = temporaryDir("host-service-rasterize-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeMutool(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "sample.pdf"), "%PDF-1.4\n");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-rasterize-success" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestRasterizePdf({ pdf_path: "sample.pdf" }, { cwd: baseDir });
		assert.equal(result.operation, "rasterize");
		assert.equal(result.supported, true);
		assert.equal(result.service_available, true);
		assert.equal(result.pdf_path, join(baseDir, "sample.pdf"));
		assert.equal(result.artifact_paths.length, 1);
		assert.equal(result.artifacts.length, 1);
		assert.equal(result.artifacts[0].page, 1);
		assert.equal(result.artifacts[0].renderer, "mutool");
		assert.equal(existsSync(result.artifacts[0].pngPath), true);
		assert.equal(result.artifact_paths[0], result.artifacts[0].pngPath);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_snippet rejects public fixed_preview_pdf_path", async () => {
	const originalMcpTmpdir = process.env.MCP_TMPDIR;
	const baseDir = temporaryDir("host-service-snippet-fixed-preview-");
	const socketPath = join(baseDir, "host-service.sock");
	process.env.MCP_TMPDIR = baseDir;
	const invalidPath = "/etc/passwd";
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-snippet-fixed-preview-validation",
	});
	await server.start();
	const requestPayload = {
		protocol_version: 1,
		request_id: "snippet-fixed-preview-invalid-path",
		operation: "compile_latex_snippet",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
		details: {
			latex_source: "\\section{Hello}",
			open_pdf: true,
			fixed_preview_pdf_path: invalidPath,
		},
	};
	let response: { operation: string; status: string; status_details: { error_code?: string }; error?: string };
	try {
		const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>, 2_000);
		response = JSON.parse(raw.trim());
	} finally {
		if (originalMcpTmpdir === undefined) {
			delete process.env.MCP_TMPDIR;
		} else {
			process.env.MCP_TMPDIR = originalMcpTmpdir;
		}
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.equal(response.operation, "compile_latex_snippet");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.match(response.error ?? "", /fixed_preview_pdf_path is not supported; use fixed_preview/);
});

test("host service compile_latex_snippet malformed requests avoid raw snippet in error details", async () => {
	const baseDir = temporaryDir("host-service-snippet-malformed-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-malformed" });
	await server.start();

	const requestPayload = {
		protocol_version: 1,
		request_id: "snippet-workspace-request-id",
		operation: "compile_latex_snippet",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
	};
	const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>);
	const response = JSON.parse(raw.trim());

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });

	assert.equal(response.operation, "compile_latex_snippet");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.source, "");
	assert.equal(response.status_details.log, "");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.match(response.error, /missing compile details/);
});

test("host service compile_latex_file open_pdf allows opening without callback", async () => {
	const baseDir = temporaryDir("host-service-open-pdf-no-callback-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nHello\\end{document}\n");
	const backend = new DeterministicManagedViewerBackend({ name: "agent-synctex-compile-open-no-callback-backend" });
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-compile-open-no-callback",
		viewerBackend: backend,
	});
	await server.start();
	const requestPayload = {
		protocol_version: 1,
		request_id: "compile-latex-file-open-no-callback",
		operation: "compile_latex_file",
		created_at_ns: Date.now() * 1_000_000,
		workspace_context: { cwd: baseDir },
		details: {
			latex_file_path: "paper.tex",
			compiler: "lualatex",
			open_pdf: true,
		},
	};
	try {
		const raw = await writeHostServiceRequest(socketPath, requestPayload as Record<string, unknown>, 2_000);
		const response = JSON.parse(raw.trim());

		assert.equal(response.operation, "compile_latex_file");
		assert.equal(response.status, "ok");
		assert.equal(typeof response.status_details.pdf_id, "number");
		assert.equal(response.status_details.managed_record.id, response.status_details.pdf_id);
		assert.equal(response.status_details.managed_record.callback, undefined);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_file with managed open returns active id and jump/close", async () => {
	const baseDir = temporaryDir("host-service-compile-open-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nHello\\end{document}\n");
	const backend = new DeterministicManagedViewerBackend({
		name: "agent-synctex-compile-open-backend",
	});
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-compile-open-success",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	const callbackSocketPath = join(baseDir, "callback.sock");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: callbackSocketPath,
		token: "compile-open-token",
	};
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocketPath, resolve);
	});
	await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{ target_id: "pi-editor", target: callback },
	);
	const expectedSource = join(baseDir, "paper.tex");

	try {
		const result = await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, callback_target_id: "pi-editor" },
			{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_file");
		assert.equal(result.clean, false);
		if (result.pdf_id === undefined) {
			throw new Error("host service compile response did not include pdf_id");
		}
		const pdfId = result.pdf_id;
		assert.equal(typeof pdfId, "number");
		assert.equal(pdfId >= 1, true);
		assert.equal(typeof result.managed_record?.id, "number");
		assert.equal(result.managed_record?.id, pdfId);
		assert.equal(result.managed_record?.pdfPath, result.pdf);
		assert.equal(result.managed_record?.defaultSourcePath, expectedSource);
		assert.equal(result.managed_record?.callback?.socket_path, callbackSocketPath);
		assert.equal(backend.forwardSearchCalls.length, 0);
		const jumpResponse = await client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 1 });
		assert.equal(jumpResponse.handled, true);
		assert.equal(jumpResponse.pdf_id, pdfId);
		assert.equal(jumpResponse.source_file, expectedSource);
		assert.equal(backend.forwardSearchCalls.length, 1);
		assert.equal(backend.forwardSearchCalls[0]?.line, 1);
		const closeResponse = await client.requestClosePdf({ cwd: baseDir }, pdfId);
		assert.equal(closeResponse.closed, true);
		assert.equal(closeResponse.pdf_id, pdfId);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		await new Promise<void>((resolve) => {
			callbackListener.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_file managed-open failure keeps compile successful", async () => {
	const baseDir = temporaryDir("host-service-compile-open-fail-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nHello\\end{document}\n");
	const backend = new FakeViewerBackend({ available: false });
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-compile-open-fail",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	const callbackSocketPath = join(baseDir, "callback.sock");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: callbackSocketPath,
		token: "compile-open-fail-token",
	};
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocketPath, resolve);
	});
	await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{ target_id: "pi-editor", target: callback },
	);
	let observed: unknown;
	try {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, callback_target_id: "pi-editor" },
			{ cwd: baseDir },
		);
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		await new Promise<void>((resolve) => {
			callbackListener.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /backend_unavailable/);
	assert.match(observed.message, /code=backend_unavailable/);
	assert.doesNotMatch(observed.message, /compile_failed/);
});

test("host service compile_latex_file open_pdf avoids open on compile failure", async () => {
	const baseDir = temporaryDir("host-service-compile-open-failure-no-open-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), { exitCode: 1 });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nHello\\end{document}\n");
	const backend = new CountingOpenViewerBackend({
		name: "agent-synctex-compile-open-no-open-backend",
	});
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-compile-open-no-open",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	const callbackSocketPath = join(baseDir, "callback.sock");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: callbackSocketPath,
		token: "compile-open-no-open-token",
	};
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocketPath, resolve);
	});
	await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{ target_id: "pi-editor", target: callback },
	);
	let observed: unknown;
	try {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, callback_target_id: "pi-editor" },
			{ cwd: baseDir },
		);
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		await new Promise<void>((resolve) => {
			callbackListener.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /compile_failed/);
	assert.equal(backend.openCalls, 0);
	assert.equal(backend.closeCalls, 0);
});

test("host service compile_latex_file open_pdf rejects stale callback target", async () => {
	const baseDir = temporaryDir("host-service-compile-open-stale-target-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nHello\\end{document}\n");
	const backend = new CountingOpenViewerBackend({
		name: "agent-synctex-compile-open-stale-target",
	});
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-compile-open-stale-target",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexFile(
			{ latex_file_path: "paper.tex", compiler: "lualatex", open_pdf: true, callback_target_id: "ghost-target" },
			{ cwd: baseDir },
		);
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /invalid_request/);
	assert.match(observed.message, /code=invalid_request/);
	assert.equal(backend.openCalls, 0);
	assert.equal(backend.closeCalls, 0);
});

test("host service compile_latex_snippet with managed open returns managed record", async () => {
	const baseDir = temporaryDir("host-service-snippet-open-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const backend = new DeterministicManagedViewerBackend({
		name: "agent-synctex-snippet-open-backend",
	});
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-snippet-open-success",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	const callbackSocketPath = join(baseDir, "callback.sock");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: callbackSocketPath,
		token: "snippet-open-token",
	};
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocketPath, resolve);
	});
	await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{ target_id: "pi-editor", target: callback },
	);
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}", open_pdf: true, callback_target_id: "pi-editor" },
			{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_snippet");
		if (result.pdf_id === undefined) {
			throw new Error("host service compile snippet response did not include pdf_id");
		}
		assert.equal(typeof result.pdf_id, "number");
		assert.equal(typeof result.managed_record?.id, "number");
		assert.equal(result.managed_record?.id, result.pdf_id);
		assert.equal(result.managed_record?.defaultSourcePath, result.source);
		assert.equal(result.managed_record?.callback?.token, callback.token);
		const closeResponse = await client.requestClosePdf({ cwd: baseDir }, result.pdf_id);
		assert.equal(closeResponse.closed, true);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		await new Promise<void>((resolve) => {
			callbackListener.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_snippet with explicit inline callback returns managed record", async () => {
	const baseDir = temporaryDir("host-service-snippet-open-inline-callback-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const backend = new DeterministicManagedViewerBackend({
		name: "agent-synctex-snippet-inline-callback-backend",
	});
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-snippet-inline-callback",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	const callbackSocketPath = join(baseDir, "callback.sock");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: callbackSocketPath,
		token: "snippet-inline-token",
	};
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocketPath, resolve);
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}", open_pdf: true, callback },
			{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_snippet");
		if (result.pdf_id === undefined) {
			throw new Error("host service compile snippet response did not include pdf_id");
		}
		assert.equal(typeof result.pdf_id, "number");
		assert.equal(typeof result.managed_record?.id, "number");
		assert.equal(result.managed_record?.id, result.pdf_id);
		assert.equal(result.managed_record?.defaultSourcePath, result.source);
		assert.equal(result.managed_record?.callback?.token, callback.token);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		await new Promise<void>((resolve) => {
			callbackListener.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_snippet managed-open failure keeps compile successful", async () => {
	const baseDir = temporaryDir("host-service-snippet-open-fail-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const backend = new FakeViewerBackend({ available: false });
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-snippet-open-fail",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	const callbackSocketPath = join(baseDir, "callback.sock");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: callbackSocketPath,
		token: "snippet-open-fail-token",
	};
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocketPath, resolve);
	});
	await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{ target_id: "pi-editor", target: callback },
	);
	let observed: unknown;
	try {
		await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}", open_pdf: true, callback_target_id: "pi-editor" },
			{ cwd: baseDir },
		);
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		await new Promise<void>((resolve) => {
			callbackListener.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /backend_unavailable/);
	assert.match(observed.message, /code=backend_unavailable/);
	assert.doesNotMatch(observed.message, /compile_failed/);
});

test("host service compile_latex_snippet with hanging viewer open returns service timeout", async () => {
	const baseDir = temporaryDir("host-service-snippet-open-timeout-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const backend = new HangingManagedViewerBackend({
		name: "agent-synctex-snippet-open-timeout-backend",
		capabilities: { open: true, close: true, forward_search: true, inverse_search: true, reuse: true },
	});
	const server = new HostServiceServer({
		socketPath,
		serviceName: "agent-synctex-snippet-open-timeout",
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 10_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}", open_pdf: true },
			{ cwd: baseDir },
		);
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /service_timeout/);
	assert.match(observed.message, /viewer backend request timed out while opening preview/);
});

test("managed viewer closes a late successful open after timeout", async () => {
	const baseDir = temporaryDir("host-service-late-open-cleanup-");
	try {
		const pdfPath = join(baseDir, "late.pdf");
		writeFileSync(pdfPath, "%PDF-1.4\n%%EOF\n");
		const backend = new LateSuccessManagedViewerBackend(35);
		const registry = new HostServicePdfIdRegistry();
		const service = new HostServiceManagedViewerService({
			viewerBackend: backend,
			managedViewerRecords: registry,
			protocolVersion: 1,
			openTimeoutMs: 5,
		});
		const request: HostServiceOpenRequest = {
			protocol_version: 1,
			request_id: "late-open-cleanup",
			operation: "open_pdf",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		};

		const response = await service.openViewer(request);
		assert.equal(response.status, "error");
		assert.equal(response.status_details.error_code, "service_timeout");

		const deadline = Date.now() + 500;
		while (backend.closeCalls === 0 && Date.now() < deadline) {
			await sleep(10);
		}
		assert.equal(backend.openCalls, 1);
		assert.equal(backend.closeCalls, 1);
		assert.equal(backend.closeResults[0]?.status, "ok");
		assert.equal(backend.closeResults[0]?.status_details.closed, true);
		assert.equal(registry.activeCount, 0);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
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


test("host service compile_latex_snippet wraps bare snippets when no workspace preamble exists", async () => {
	const baseDir = temporaryDir("host-service-snippet-no-preamble-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-no-preamble" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}" },
			{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_snippet");
		assert.equal(result.clean, false);
		assert.equal(result.artifact_paths.includes(result.pdf), true);
		assert.equal(result.artifact_paths.includes(result.log), true);
		assert.equal(existsSync(result.pdf), true);
		assert.equal(existsSync(result.log), true);
		const renderedSource = readFileSync(result.source, "utf8");
		assert.match(renderedSource, /\\documentclass\{article\}/);
		assert.match(renderedSource, /\\begin\{document\}/);
		assert.match(renderedSource, /\\end\{document\}/);
		assert.match(renderedSource, /\\section\{Hello\}/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet applies workspace preamble and document wrapper", async () => {
	const baseDir = temporaryDir("host-service-snippet-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	writeFileSync(join(baseDir, "preamble.tex"), "\\usepackage{paper}");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-success" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Hello}" },
			{ cwd: baseDir },
		);
		assert.equal(result.operation, "compile_latex_snippet");
		assert.equal(result.clean, false);
		assert.equal(result.artifact_paths.includes(result.pdf), true);
		assert.equal(result.artifact_paths.includes(result.log), true);
		assert.equal(existsSync(result.pdf), true);
		assert.equal(existsSync(result.log), true);
		const renderedSource = readFileSync(result.source, "utf8");
		assert.match(renderedSource, /\\usepackage\{paper\}/);
		assert.match(renderedSource, /\\begin\{document\}/);
		assert.match(renderedSource, /\\end\{document\}/);
		assert.match(renderedSource, /\\section\{Hello\}/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet keeps explicit document wrappers when provided", async () => {
	const baseDir = temporaryDir("host-service-snippet-explicit-wrapper-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-explicit-wrapper" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\documentclass{article}\\n\\begin{document}\\n\\section{Body}\\n\\end{document}" },
			{ cwd: baseDir },
		);
		const renderedSource = readFileSync(result.source, "utf8");
		const beginCount = (renderedSource.match(/\\begin\{document\}/g) ?? []).length;
		const endCount = (renderedSource.match(/\\end\{document\}/g) ?? []).length;
		assert.equal(beginCount, 1);
		assert.equal(endCount, 1);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet resolves workspace_root preamble", async () => {
	const baseDir = temporaryDir("host-service-snippet-workspace-root-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const workspaceRoot = join(baseDir, "workspace");
	const compileCwd = join(baseDir, "cwd");
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(compileCwd, { recursive: true });
	writeFileSync(join(workspaceRoot, "preamble.tex"), "\\usepackage{hyperref}");

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-workspace-root" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Root}" },
			{ cwd: compileCwd, workspace_root: workspaceRoot },
		);
		const renderedSource = readFileSync(result.source, "utf8");
		assert.match(renderedSource, /\\usepackage\{hyperref\}/);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet places snippets under workspace_root", async () => {
	const baseDir = temporaryDir("host-service-snippet-output-root-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const workspaceRoot = join(baseDir, "shared-workspace");
	const compileCwd = join(baseDir, "cwd");
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(compileCwd, { recursive: true });

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-output-root" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Output}" },
			{ cwd: compileCwd, workspace_root: workspaceRoot },
		);
		assert.equal(result.source.startsWith(workspaceRoot), true);
		assert.equal(result.source.includes("snippet.tex"), true);
		assert.equal(result.pdf.startsWith(workspaceRoot), true);
		assert.equal(existsSync(result.pdf), true);
		assert.equal(result.artifact_paths.includes(result.pdf), true);
		assert.equal(result.source.includes("host-service-snippets"), true);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service compile_latex_snippet preserves caller workspace_root permissions", async () => {
	const baseDir = temporaryDir("host-service-snippet-output-root-perms-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"));
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;
	const workspaceRoot = join(baseDir, "shared-workspace");
	const compileCwd = join(baseDir, "cwd");
	mkdirSync(workspaceRoot, { recursive: true, mode: 0o755 });
	chmodSync(workspaceRoot, 0o755);
	mkdirSync(compileCwd, { recursive: true });

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-output-root-perms" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	try {
		const result = await client.requestCompileLatexSnippet(
			{ latex_source: "\\section{Output}" },
			{ cwd: compileCwd, workspace_root: workspaceRoot },
		);
		const workspaceRootMode = socketMode(workspaceRoot);
		assert.equal(workspaceRootMode, 0o755);
		assert.equal(result.source.includes("host-service-snippets"), true);
		assert.equal(result.source.startsWith(join(workspaceRoot, "host-service-snippets")), true);
		assert.equal(existsSync(result.pdf), true);
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service compile_latex_snippet preserves compile failures", async () => {
	const baseDir = temporaryDir("host-service-compile-snippet-failure-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalPath = process.env.PATH ?? "";
	writeFakeLatexCompiler(join(baseDir, "bin"), { exitCode: 9 });
	process.env.PATH = `${join(baseDir, "bin")}:${originalPath}`;

	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-failure" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexSnippet({ latex_source: "x", compiler: "lualatex" }, { cwd: baseDir });
	} catch (error) {
		observed = error;
	} finally {
		process.env.PATH = originalPath;
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /LaTeX compile failed/);
	assert.match(observed.message, /code=compile_failed/);
});


test("host service compile_latex_snippet requires absolute workspace cwd", async () => {
	const baseDir = temporaryDir("host-service-compile-snippet-absolute-cwd-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-compile-snippet-absolute" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 2_000,
	});
	let observed: unknown;
	try {
		await client.requestCompileLatexSnippet({ latex_source: "x" }, { cwd: "relative/path" });
	} catch (error) {
		observed = error;
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /must be absolute for compile_latex_snippet/);
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

test("host service client accepts open_pdf responses with envelope-level pdf", async () => {
	const baseDir = temporaryDir("host-service-open-envelope-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const expectedRequestId = "open-existing-pdf-response-id";
	const pdfPath = join(baseDir, "paper.pdf");
	const handle = "fake-viewer:opened-existing-pdf";
	const responsePayload = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "open_pdf",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		pdf: pdfPath,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "open_pdf",
			backend: "fake-viewer",
			backend_path: "fake-viewer",
			capabilities: {
				open: true,
				close: true,
				forward_search: true,
				inverse_search: true,
				reuse: true,
			},
			handle,
			owned: true,
			reused: false,
			pid: 123456,
			pdf_id: 4242,
			managed_record: {
				id: 4242,
				pdfPath,
				viewerHandle: handle,
				viewerBackend: "fake-viewer",
				viewerOwned: true,
				createdAtNs: Date.now() * 1_000_000,
				pid: 123456,
				reused: false,
				capabilities: {
					open: true,
					close: true,
					forward_search: true,
					inverse_search: true,
					reuse: true,
				},
				backendPath: "fake-viewer",
			},
		},
	}) + "\n";
	const openServer = createServer((socket) => {
		socket.end(responsePayload, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		openServer.once("error", reject);
		openServer.listen(socketPath, () => {
			resolve();
		});
	});

	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => expectedRequestId,
	});
	try {
		const response = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: pdfPath, reuse_existing: true },
		);
		assert.equal(response.pdf, pdfPath);
		assert.equal(response.pdf_id, 4242);
		assert.equal(response.managed_record?.pdfPath, pdfPath);
	} finally {
		await new Promise<void>((resolve) => {
			openServer.close(() => resolve());
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("host service client normalizes open_pdf pdf from managed_record pdfPath", async () => {
	const baseDir = temporaryDir("host-service-open-managed-record-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const expectedRequestId = "open-existing-pdf-managed-record-response-id";
	const pdfPath = join(baseDir, "paper.pdf");
	const handle = "fake-viewer:opened-existing-pdf-managed-record";
	const capabilities = {
		open: true,
		close: true,
		forward_search: true,
		inverse_search: true,
		reuse: true,
	};
	const responsePayload = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "open_pdf",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "open_pdf",
			backend: "fake-viewer",
			backend_path: "fake-viewer",
			capabilities,
			handle,
			owned: true,
			reused: false,
			pid: 123456,
			pdf_id: 16227649,
			managed_record: {
				id: 16227649,
				pdfPath,
				viewerHandle: handle,
				viewerBackend: "fake-viewer",
				viewerOwned: true,
				createdAtNs: Date.now() * 1_000_000,
				pid: 123456,
				reused: false,
				capabilities,
				backendPath: "fake-viewer",
			},
		},
	}) + "\n";
	const openServer = createServer((socket) => {
		socket.end(responsePayload, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		openServer.once("error", reject);
		openServer.listen(socketPath, () => {
			resolve();
		});
	});

	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => expectedRequestId,
	});
	try {
		const response = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: pdfPath, reuse_existing: true },
		);
		assert.equal(response.pdf, pdfPath);
		assert.equal(response.pdf_id, 16227649);
		assert.equal(response.managed_record?.pdfPath, pdfPath);
	} finally {
		await new Promise<void>((resolve) => {
			openServer.close(() => resolve());
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

test("host service client validates callback response operation", async () => {
	const baseDir = temporaryDir("host-service-bad-callback-response-");
	const socketPath = join(baseDir, "host-service.sock");
	const expectedRequestId = "callback-response-request-id";
	const mismatchedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "status",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			service_name: "agent-synctex-test-callback-response",
			socket_path: socketPath,
			service_instance_started_ns: Date.now() * 1_000_000,
			service_instance_id: "instance-id",
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "status",
			target_id: "pi-editor",
			callback_available: true,
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: "/tmp/callback.sock",
				token: "token",
			},
			uptime_ns: 1,
			total_requests: 1,
		},
	}) + "\n";
	const mismatchedServer = createServer((socket) => {
		socket.end(mismatchedResponse, () => {
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		mismatchedServer.once("error", reject);
		mismatchedServer.listen(socketPath, () => {
			resolve();
		});
	});
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
		requestIdFactory: () => expectedRequestId,
	});
	await assert.rejects(
		() => client.requestResolveCallbackTarget({ cwd: baseDir }, "pi-editor"),
		/Malformed host service response payload/,
	);
	await new Promise<void>((resolve) => {
		mismatchedServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
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

test("host service client validates rasterize response artifact metadata", async () => {
	const baseDir = temporaryDir("host-service-bad-rasterize-artifact-");
	const socketPath = join(baseDir, "host-service.sock");
	mkdirSync(INLINE_PREVIEW_DIR, { mode: 0o700, recursive: true });
	const previewPng = join(INLINE_PREVIEW_DIR, "rasterize-artifact-invalid-page.png");
	writeFileSync(previewPng, createMiniPng(16, 8));
	const expectedRequestId = "rasterize-page-id";
	const malformedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "rasterize",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "rasterize",
			pdf_path: join(baseDir, "sample.pdf"),
			artifacts: [
				{
					pngPath: previewPng,
					page: 0,
					dpi: 150,
					renderer: "mutool",
					trimmed: false,
					fullPageWidthPx: 16,
					fullPageHeightPx: 8,
					widthPx: 16,
					heightPx: 8,
				},
			],
			artifact_paths: [previewPng],
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
	await assert.rejects(
		() => client.requestRasterizePdf({ pdf_path: "sample.pdf" }, { cwd: baseDir }),
		/Malformed host service response payload/,
	);
	await new Promise<void>((resolve) => {
		malformedServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service client validates rasterize response artifact paths", async () => {
	const baseDir = temporaryDir("host-service-bad-rasterize-artifact-path-");
	const socketPath = join(baseDir, "host-service.sock");
	mkdirSync(INLINE_PREVIEW_DIR, { mode: 0o700, recursive: true });
	const previewPng = join(INLINE_PREVIEW_DIR, "rasterize-artifact-valid.png");
	writeFileSync(previewPng, createMiniPng(16, 8));
	const expectedRequestId = "rasterize-artifact-path-id";
	const malformedResponse = JSON.stringify({
		protocol_version: 1,
		request_id: expectedRequestId,
		operation: "rasterize",
		status: "ok",
		generated_at_ns: Date.now() * 1_000_000,
		status_details: {
			protocol_version: 1,
			supported: true,
			service_available: true,
			workspace_context: { cwd: baseDir },
			request_id: expectedRequestId,
			operation: "rasterize",
			pdf_path: join(baseDir, "sample.pdf"),
			artifacts: [
				{
					pngPath: previewPng,
					page: 1,
					dpi: 150,
					renderer: "mutool",
					trimmed: false,
					fullPageWidthPx: 16,
					fullPageHeightPx: 8,
					widthPx: 16,
					heightPx: 8,
				},
			],
			artifact_paths: [join(baseDir, "outside-preview.png")],
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
	await assert.rejects(
		() => client.requestRasterizePdf({ pdf_path: "sample.pdf" }, { cwd: baseDir }),
		/Malformed host service response payload/,
	);
	await new Promise<void>((resolve) => {
		malformedServer.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service client accepts rasterize response artifact paths from XDG_RUNTIME_DIR", async () => {
	const baseDir = temporaryDir("host-service-rasterize-runtime-artifact-");
	const socketPath = join(baseDir, "host-service.sock");
	const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
	const originalMcpTmpDir = process.env.MCP_TMPDIR;
	const runtimeRoot = mkdtempSync(resolve(tmpdir(), "host-service-rasterize-runtime-dir-"));
	const runtimeInlineDir = resolve(runtimeRoot, "tex-actions", "inline");
	const expectedRequestId = "rasterize-runtime-artifact-id";

	try {
		process.env.XDG_RUNTIME_DIR = runtimeRoot;
		process.env.MCP_TMPDIR = undefined;
		mkdirSync(runtimeInlineDir, { mode: 0o700, recursive: true });
		const previewPng = join(runtimeInlineDir, "rasterize-artifact-runtime.png");
		writeFileSync(previewPng, createMiniPng(16, 8));

		const response = JSON.stringify({
			protocol_version: 1,
			request_id: expectedRequestId,
			operation: "rasterize",
			status: "ok",
			generated_at_ns: Date.now() * 1_000_000,
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				workspace_context: { cwd: baseDir },
				request_id: expectedRequestId,
				operation: "rasterize",
				pdf_path: join(baseDir, "sample.pdf"),
				artifacts: [
					{
						pngPath: previewPng,
						page: 1,
						dpi: 150,
						renderer: "mutool",
						trimmed: false,
						fullPageWidthPx: 16,
						fullPageHeightPx: 8,
						widthPx: 16,
						heightPx: 8,
					},
				],
				artifact_paths: [previewPng],
			},
		}) + "\n";

		const server = createServer((socket) => {
			socket.end(response, () => {
				socket.destroy();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				resolve();
			});
		});
		const client = new HostServiceClient({
			socketPath,
			requestTimeoutMs: 1_000,
			requestIdFactory: () => expectedRequestId,
		});
		const result = await client.requestRasterizePdf({ pdf_path: "sample.pdf" }, { cwd: baseDir });
		assert.equal(result.artifacts[0].pngPath, previewPng);
		assert.equal(result.artifact_paths[0], previewPng);
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	} finally {
		if (originalXdgRuntimeDir === undefined) {
			delete process.env.XDG_RUNTIME_DIR;
		} else {
			process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
		}
		if (originalMcpTmpDir === undefined) {
			delete process.env.MCP_TMPDIR;
		} else {
			process.env.MCP_TMPDIR = originalMcpTmpDir;
		}
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(runtimeRoot, { recursive: true, force: true });
	}
});

test("host service client surfaces malformed close requests as invalid_request", async () => {
	const baseDir = temporaryDir("host-service-close-malformed-request-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-close-malformed-client" });
	await server.start();
	const client = new HostServiceClient({
		socketPath,
		requestTimeoutMs: 1_000,
	});
	const requestId = "close-malformed-request-id";
	const requester = client as unknown as {
		request: (request: unknown, signal: AbortSignal | undefined, requestTimeoutMs: number) => Promise<unknown>;
	};
	const response = await requester.request(
		{
			protocol_version: 1,
			request_id: requestId,
			operation: "close_pdf",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: { cwd: baseDir },
		} as Record<string, unknown>,
		undefined,
		1_000,
	) as {
		operation: string;
		status: "ok" | "error";
		error?: string;
		status_details: {
			request_id?: string;
			error_code?: string;
		};
	};

	assert.equal(response.operation, "close_pdf");
	assert.equal(response.status, "error");
	assert.equal(response.status_details.error_code, "invalid_request");
	assert.equal(response.status_details.request_id, requestId);
	assert.match(response.error ?? "", /invalid pdf_id/);
	await server.stop();
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

test("host service rejects socket directory with unsafe permissions", async () => {
	const baseDir = temporaryDir("host-service-unsafe-mode-");
	const socketDir = join(baseDir, "unsafe");
	const socketPath = join(socketDir, "host-service.sock");
	mkdirSync(socketDir, { mode: 0o777, recursive: true });
	chmodSync(socketDir, 0o777);
	const beforeMode = lstatSync(socketDir).mode & 0o777;

	const server = new HostServiceServer({ socketPath, serviceName: "tex-actions-socket-unsafe-mode" });
	await assert.rejects(() => server.start(), /unsafe mode/);
	assert.equal((lstatSync(socketDir).mode & 0o777), beforeMode, "unsafe socket directory mode should not be corrected in place");

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

test("host service open_pdf resolves relative PDF paths and tracks managed records for reuse", async () => {
	const baseDir = temporaryDir("host-service-open-reuse-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new RecordingFakeViewerBackend();
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const firstOpen = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		assert.equal(firstOpen.reused, false);
		assert.equal(firstOpen.owned, true);
		assert.equal(typeof firstOpen.handle, "string");
		if (firstOpen.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const firstOpenPdfId = firstOpen.pdf_id;
		assert.equal(firstOpenPdfId >= 1, true);
		assert.equal(typeof firstOpenPdfId, "number");
		assert.equal(typeof firstOpen.managed_record?.id, "number");
		assert.equal(firstOpen.managed_record?.id, firstOpenPdfId);
		assert.equal(firstOpen.managed_record?.viewerHandle, firstOpen.handle);
		assert.equal(firstOpen.managed_record?.viewerBackend, firstOpen.backend);
		assert.equal(firstOpen.managed_record?.viewerOwned, firstOpen.owned);
		assert.equal(firstOpen.managed_record?.pdfPath, pdfPath);
		assert.equal(firstOpen.managed_record?.callback?.token, callback.token);
		assert.equal(firstOpen.managed_record?.capabilities?.open, true);
		assert.equal(backend.openedDetails.length, 1);
		assert.equal(backend.openedDetails[0]!.pdf_path, pdfPath);
		const secondOpen = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		assert.equal(secondOpen.reused, true);
		assert.equal(secondOpen.pdf_id, firstOpenPdfId);
		assert.equal(secondOpen.handle, firstOpen.handle);
		const thirdOpen = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback: {
					...callback,
					token: "beta-token",
				},
				reuse_existing: true,
			},
		);
		assert.equal(thirdOpen.reused, false);
		assert.notEqual(thirdOpen.pdf_id, firstOpenPdfId);
		assert.notEqual(thirdOpen.handle, firstOpen.handle);
		assert.equal(backend.openedDetails.length, 3);
		assert.equal(backend.openedDetails[1]!.pdf_path, pdfPath);
		assert.equal(backend.openedDetails[2]!.pdf_path, pdfPath);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service stop disposes backend sessions on shutdown", async () => {
	const baseDir = temporaryDir("host-service-backend-shutdown-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new CloseTrackingFakeViewerBackend();
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		assert.equal(openResponse.reused, false);
		await server.stop();
		assert.equal(backend.closeAllCalled, true);
		assert.equal(backend.closeCalled.length, 1);
		if (openResponse.handle !== undefined) {
			assert.equal(backend.closeCalled[0], openResponse.handle);
		}
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("zathura backend closes previous owned session on replacement and replacement without reuse", async () => {
	const baseDir = temporaryDir("host-service-zathura-replace-");
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const zathuraPath = join(binDir, "zathura");
	writeFakeZathuraViewerBinary(zathuraPath);
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const backend = new ZathuraViewerBackend({ executablePath: zathuraPath, nodePath: process.execPath });
	const callbackA = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback-a.sock"),
		token: "alpha-token",
	};
	const callbackB = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback-b.sock"),
		token: "beta-token",
	};

	try {
		const firstOpen = await backend.open("first", { pdf_path: pdfPath, callback: callbackA, reuse_existing: true });
		assert.equal(firstOpen.status, "ok");
		const rawFirstPid = (firstOpen.status_details as { pid?: number }).pid;
		if (typeof rawFirstPid !== "number") {
			throw new Error("first open response did not include a process id");
		}
		const firstPid = rawFirstPid;

		const secondOpen = await backend.open("second", { pdf_path: pdfPath, callback: callbackB, reuse_existing: true });
		assert.equal(secondOpen.status, "ok");
		const rawSecondPid = (secondOpen.status_details as { pid?: number }).pid;
		if (typeof rawSecondPid !== "number") {
			throw new Error("second open response did not include a process id");
		}
		const secondPid = rawSecondPid;
		assert.notEqual(firstPid, secondPid);
		await waitForProcessExit(firstPid);

		const thirdOpen = await backend.open("third", { pdf_path: pdfPath, callback: callbackB, reuse_existing: false });
		assert.equal(thirdOpen.status, "ok");
		const rawThirdPid = (thirdOpen.status_details as { pid?: number }).pid;
		if (typeof rawThirdPid !== "number") {
			throw new Error("third open response did not include a process id");
		}
		const thirdPid = rawThirdPid;
		assert.equal(typeof thirdPid, "number");
		assert.notEqual(secondPid, thirdPid);
		await waitForProcessExit(secondPid);
	} finally {
		await backend.closeAll();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("zathura backend reports not_running before forward-searching a dead tracked session", async () => {
	const baseDir = temporaryDir("host-service-zathura-forward-not-running-");
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const zathuraPath = join(binDir, "zathura");
	writeFakeZathuraViewerBinary(zathuraPath);
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\n");
	const backend = new ZathuraViewerBackend({ executablePath: zathuraPath, nodePath: process.execPath });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		const openResult = await backend.open("open", { pdf_path: pdfPath, callback, reuse_existing: true });
		assert.equal(openResult.status, "ok");
		const openDetails = openResult.status_details as { handle?: string; pid?: number };
		if (typeof openDetails.handle !== "string" || typeof openDetails.pid !== "number") {
			throw new Error(`open response missing handle or pid: ${JSON.stringify(openDetails)}`);
		}
		process.kill(openDetails.pid, "SIGTERM");
		await waitForProcessExit(openDetails.pid);

		const forwardResult = await backend.forwardSearch("jump", {
			handle: openDetails.handle,
			backend: backend.name,
			source_file: sourcePath,
			line: 1,
			synctex_pid: openDetails.pid,
		});
		assert.equal(forwardResult.status, "error");
		assert.equal((forwardResult.status_details as { error_code?: string }).error_code, "not_running");
		assert.equal((forwardResult.status_details as { reason?: string }).reason, "not_running");
	} finally {
		await backend.closeAll();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("zathura backend reports identity mismatch as a stale handle with failed backend identity", async () => {
	const baseDir = temporaryDir("host-service-zathura-forward-identity-mismatch-");
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const zathuraPath = join(binDir, "zathura");
	writeFakeZathuraViewerBinary(zathuraPath);
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\n");
	const backend = new ZathuraViewerBackend({ executablePath: zathuraPath, nodePath: process.execPath });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	let openPid: number | undefined;
	try {
		const openResult = await backend.open("open", { pdf_path: pdfPath, callback, reuse_existing: true });
		assert.equal(openResult.status, "ok");
		const openDetails = openResult.status_details as { handle?: string; pid?: number };
		openPid = openDetails.pid;
		if (typeof openDetails.handle !== "string") {
			throw new Error(`open response missing handle: ${JSON.stringify(openDetails)}`);
		}
		const session = (backend as unknown as { sessions: Map<string, { identity?: unknown }> }).sessions.get(pdfPath);
		if (session === undefined) {
			throw new Error("zathura session was not tracked");
		}
		session.identity = { comm: "not-zathura", start_time: "0", exe: "/definitely/not/zathura", cmdline: ["not-zathura"] };

		const forwardResult = await backend.forwardSearch("jump", {
			handle: openDetails.handle,
			backend: backend.name,
			source_file: sourcePath,
			line: 1,
		});
		assert.equal(forwardResult.status, "error");
		const details = forwardResult.status_details as { error_code?: string; reason?: string; backend_identity_ok?: boolean };
		assert.equal(details.error_code, "stale_handle");
		assert.equal(details.reason, "identity_mismatch");
		assert.equal(details.backend_identity_ok, false);
	} finally {
		if (openPid !== undefined && isProcessAlive(openPid)) {
			try {
				process.kill(openPid, "SIGKILL");
			} catch {
				/* ignore */
			}
		}
		await backend.closeAll();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("zathura backend ignores pre-existing matching viewer process", async () => {
	const baseDir = temporaryDir("host-service-zathura-preexisting-");
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const zathuraPath = join(binDir, "zathura");
	writeFakeShortLivedZathuraViewerBinary(zathuraPath);
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const preexisting = spawn(zathuraPath, ["--zathura-existing", pdfPath], { stdio: "ignore" });
	const preexistingPid = preexisting.pid;
	if (preexistingPid === undefined) {
		throw new Error("failed to spawn pre-existing fake viewer process");
	}
	const backend = new ZathuraViewerBackend({ executablePath: zathuraPath, nodePath: process.execPath });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		const openResult = await backend.open("open", { pdf_path: pdfPath, callback, reuse_existing: true });
		assert.equal(openResult.status, "ok");
		const openDetails = openResult.status_details as {
			handle?: string;
			owned?: boolean;
			pid?: number;
		};
		assert.equal(openDetails.owned, false);
		assert.equal(openDetails.pid, undefined);
		if (typeof openDetails.handle !== "string") {
			throw new Error("open response did not include a handle");
		}
		const closeResult = await backend.close("close", { handle: openDetails.handle, backend: backend.name });
		assert.equal(closeResult.status, "error");
		assert.equal(closeResult.error, "viewer handle not recognized");
		await sleep(50);
		assert.ok(isProcessAlive(preexistingPid), "pre-existing viewer process should remain alive");
	} finally {
		if (isProcessAlive(preexistingPid)) {
			try {
				process.kill(preexistingPid, "SIGTERM");
			} catch {
				/* ignore */
			}
			try {
				process.kill(preexistingPid, "SIGKILL");
			} catch {
				/* ignore */
			}
		}
		await backend.closeAll();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("zathura backend closes forked persistent session on close", async () => {
	const baseDir = temporaryDir("host-service-zathura-fork-close-");
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const zathuraPath = join(binDir, "bash");
	const childPidPath = join(baseDir, "fork-child.pid");
	writeFakeForkingZathuraViewerBinary(zathuraPath, { childPidFile: childPidPath });
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const backend = new ZathuraViewerBackend({ executablePath: zathuraPath, nodePath: process.execPath });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	let discoveredPid: number | undefined;

	try {
		const openResult = await backend.open("open", { pdf_path: pdfPath, callback, reuse_existing: true });
		const openDetails = openResult.status_details as {
			handle?: string;
			owned?: boolean;
			pid?: number;
		};
		if (openDetails.owned !== true) {
			throw new Error(`open did not report owned session: ${JSON.stringify(openDetails)}`);
		}
		if (typeof openDetails.handle !== "string") {
			throw new Error("open response did not include a handle");
		}
		if (typeof openDetails.pid !== "number") {
			throw new Error("open response did not include a process id");
		}
		const persistentPid = openResult.status_details.pid as number;
		assert.ok(isProcessAlive(persistentPid), "open session pid should be alive");
		const deadline = Date.now() + 1000;
		while (Date.now() < deadline) {
			try {
				discoveredPid = Number(readFileSync(childPidPath, "utf8").trim());
				if (Number.isInteger(discoveredPid) && discoveredPid > 0) {
					break;
				}
				discoveredPid = undefined;
			} catch {
				discoveredPid = undefined;
			}
			await sleep(25);
		}
		if (discoveredPid === undefined) {
			throw new Error("forked fake viewer child did not write PID");
		}
		assert.equal(openDetails.pid, discoveredPid);

		const closeResult = await backend.close("close", { handle: openDetails.handle, backend: backend.name });
		assert.equal(closeResult.status, "ok");
		const closeClosed = (closeResult.status_details as { closed?: boolean }).closed;
		if (closeClosed !== true) {
			assert.equal((closeResult.status_details as { reason?: string }).reason, "not_running");
		}
		await waitForProcessExit(persistentPid);
	} finally {
		if (discoveredPid !== undefined && isProcessAlive(discoveredPid)) {
			try {
				process.kill(discoveredPid, "SIGKILL");
			} catch {
				/* ignore */
			}
		}
		await backend.closeAll();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("zathura backend closeAll closes forked persistent sessions", async () => {
	const baseDir = temporaryDir("host-service-zathura-fork-closeall-");
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const zathuraPath = join(binDir, "bash");
	writeFakeForkingZathuraViewerBinary(zathuraPath);
	const pdfPathA = join(baseDir, "sample-a.pdf");
	const pdfPathB = join(baseDir, "sample-b.pdf");
	writeFileSync(pdfPathA, "%PDF-1.4\n");
	writeFileSync(pdfPathB, "%PDF-1.4\n");
	const backend = new ZathuraViewerBackend({ executablePath: zathuraPath, nodePath: process.execPath });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		const firstOpen = await backend.open("first", { pdf_path: pdfPathA, callback, reuse_existing: true });
		assert.equal(firstOpen.status, "ok");
		const firstDetails = firstOpen.status_details as { handle?: string; owned?: boolean; pid?: number };
		if (firstDetails.owned !== true || typeof firstDetails.handle !== "string" || typeof firstDetails.pid !== "number") {
			throw new Error("first open response missing expected session data");
		}
		const firstPid = firstDetails.pid;

		const secondOpen = await backend.open("second", { pdf_path: pdfPathB, callback, reuse_existing: true });
		assert.equal(secondOpen.status, "ok");
		const secondDetails = secondOpen.status_details as { handle?: string; owned?: boolean; pid?: number };
		if (secondDetails.owned !== true || typeof secondDetails.handle !== "string" || typeof secondDetails.pid !== "number") {
			throw new Error("second open response missing expected session data");
		}
		const secondPid = secondDetails.pid;
		assert.notEqual(firstPid, secondPid);

		await backend.closeAll();
		await waitForProcessExit(firstPid);
		await waitForProcessExit(secondPid);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service open_pdf returns backend-provided invalid-PDF errors", async () => {
	const baseDir = temporaryDir("host-service-open-invalid-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "not-pdf.txt");
	writeFileSync(pdfPath, "just text\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new ValidatingFakeViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		await assert.rejects(
			() => client.requestOpenPdf(
				{ cwd: baseDir },
				{
					pdf_path: "not-pdf.txt",
					callback,
					reuse_existing: true,
				},
			),
			/invalid_pdf/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service managed open validation rejects missing, non-PDF, and non-regular files without backend calls or records", async () => {
	const scenarios = [
		{
			name: "missing",
			path: "missing.pdf",
			prepare: (_baseDir: string): void => {},
			errCode: "invalid_request",
		},
		{
			name: "non-pdf",
			path: "not-pdf.txt",
			prepare: (baseDir: string): void => {
				writeFileSync(join(baseDir, "not-pdf.txt"), "just text\n");
			},
			errCode: "invalid_pdf",
		},
		{
			name: "directory",
			path: "dir",
			prepare: (baseDir: string): void => {
				mkdirSync(join(baseDir, "dir"), { mode: 0o700, recursive: true });
			},
			errCode: "invalid_request",
		},
	];
	for (const scenario of scenarios) {
		const baseDir = temporaryDir(`host-service-open-validation-${scenario.name}-`);
		const socketPath = join(baseDir, "host-service.sock");
		const managedRecords = new HostServicePdfIdRegistry();
		scenario.prepare(baseDir);
		const backend = new CountingOpenViewerBackend({ name: `managed-open-validator-${scenario.name}` });
		const server = new HostServiceServer({
			socketPath,
			viewerBackend: backend,
			managedViewerRecords: managedRecords,
		});
		await server.start();

		const payload = {
			protocol_version: 1,
			request_id: `invalid-open-${scenario.name}`,
			operation: "open_pdf",
			created_at_ns: Date.now() * 1_000_000,
			workspace_context: { cwd: baseDir },
			details: {
				pdf_path: scenario.path,
			},
		};
		try {
			const raw = await writeHostServiceRequest(socketPath, payload as Record<string, unknown>);
			const response = JSON.parse(raw.trim());
			assert.equal(response.operation, "open_pdf");
			assert.equal(response.status, "error");
			assert.equal(response.status_details.error_code, scenario.errCode);
			assert.equal(response.status_details.pdf_id, undefined);
			assert.equal(response.status_details.managed_record, undefined);
			assert.equal(backend.openCalls, 0);
			assert.equal(managedRecords.activeCount, 0);
		} finally {
			await server.stop();
			rmSync(baseDir, { recursive: true, force: true });
		}
	}
});

test("host service client surfaces invalid_request for malformed open_pdf payloads", async () => {
	const baseDir = temporaryDir("host-service-open-pdf-invalid-request-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	let observed: unknown;
	try {
		await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: 123 as unknown as string,
				callback: "bad" as unknown as {
					kind: "pi-synctex-callback-v1";
					transport: "unix";
					socket_path: string;
					token: string;
				},
			},
		);
	} catch (error) {
		observed = error;
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
	assert.ok(observed instanceof Error);
	assert.match(observed.message, /code=invalid_request/);
	assert.doesNotMatch(observed.message, /Malformed host service open_pdf response payload/);
});

test("host service open_pdf returns backend-unavailable errors", async () => {
	const baseDir = temporaryDir("host-service-open-backend-unavailable-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new FakeViewerBackend({ available: false });
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		await assert.rejects(
			() => client.requestOpenPdf(
				{ cwd: baseDir },
				{
					pdf_path: "sample.pdf",
					callback,
					reuse_existing: true,
				},
			),
			/backend_unavailable/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service open_pdf allocates active pdf ids from random range", async () => {
	const baseDir = temporaryDir("host-service-open-id-range-");
	const socketPath = join(baseDir, "host-service.sock");
	const backend = new RecordingFakeViewerBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const callbackBase = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
	};

	try {
		const pdfIds = new Set<number>();
		for (let i = 0; i < 5; i += 1) {
			const pdfPath = join(baseDir, `sample-${i}.pdf`);
			writeFileSync(pdfPath, "%PDF-1.4\n");
			const response = await client.requestOpenPdf(
				{ cwd: baseDir },
				{
					pdf_path: `sample-${i}.pdf`,
					callback: {
						...callbackBase,
						token: `token-${i}`,
					},
					reuse_existing: true,
				},
			);
			if (response.pdf_id === undefined) {
				throw new Error("host service open response did not include pdf_id");
			}
			const pdfId = response.pdf_id;
			assert.equal(pdfId >= 1 && pdfId <= 99_999_999, true);
			pdfIds.add(pdfId);
		}
		assert.equal(pdfIds.size, 5);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service close_pdf closes active ids and invalidates registry records", async () => {
	const baseDir = temporaryDir("host-service-close-pdf-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\\n");
	const registry = new HostServicePdfIdRegistry();
	const backend = new CloseControlledFakeViewerBackend("closed");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
		managedViewerRecords: registry,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		assert.equal(registry.activeCount, 1);
		const closeResponse = await client.requestClosePdf({ cwd: baseDir }, pdfId);
		assert.equal(closeResponse.pdf_id, pdfId);
		assert.equal(closeResponse.closed, true);
		assert.equal(registry.activeCount, 0);
		await assert.rejects(
			() => client.requestClosePdf({ cwd: baseDir }, pdfId),
			/Closed pdf_id=/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service close_pdf handles unowned-style no-op responses", async () => {
	const baseDir = temporaryDir("host-service-close-pdf-noop-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\\n");
	const registry = new HostServicePdfIdRegistry();
	const backend = new CloseControlledFakeViewerBackend("not_service_owned");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
		managedViewerRecords: registry,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		const closeResponse = await client.requestClosePdf({ cwd: baseDir }, pdfId);
		assert.equal(closeResponse.closed, false);
		assert.equal(closeResponse.reason, "not_service_owned");
		assert.equal(registry.activeCount, 0);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service close_pdf no-ops close for unowned managed records", async () => {
	const baseDir = temporaryDir("host-service-close-pdf-unowned-record-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\\n");
	const registry = new HostServicePdfIdRegistry();
	const backend = new OwnedAwareFakeViewerBackend(false, {
		name: "host-service-zathura-unowned",
	});
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
		managedViewerRecords: registry,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		assert.equal(openResponse.owned, false);
		assert.equal(registry.activeCount, 1);
		const closeResponse = await client.requestClosePdf({ cwd: baseDir }, pdfId);
		assert.equal(closeResponse.closed, false);
		assert.equal(closeResponse.reason, "not_service_owned");
		assert.equal(registry.activeCount, 0);
		await assert.rejects(
			() => client.requestClosePdf({ cwd: baseDir }, pdfId),
			/Closed pdf_id=/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service close_pdf returns clear errors for unknown, stale, and closed ids", async () => {
	const baseDir = temporaryDir("host-service-close-pdf-id-classification-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\\n");
	const registry = new HostServicePdfIdRegistry();
	const backend = new CloseControlledFakeViewerBackend("closed");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
		managedViewerRecords: registry,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		await assert.rejects(
			() => client.requestClosePdf({ cwd: baseDir }, 999_999_999),
			/Unknown pdf_id=999999999:/,
		);

		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const staleId = openResponse.pdf_id;
		registry.markRecordStale(staleId);
		await assert.rejects(
			() => client.requestClosePdf({ cwd: baseDir }, staleId),
			/Stale pdf_id=/,
		);

		const secondOpen = await client.requestOpenPdf(
			{ cwd: baseDir },
			{
				pdf_path: "sample.pdf",
				callback,
				reuse_existing: true,
			},
		);
		if (secondOpen.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const closedId = secondOpen.pdf_id;
		await client.requestClosePdf({ cwd: baseDir }, closedId);
		await assert.rejects(
			() => client.requestClosePdf({ cwd: baseDir }, closedId),
			/Closed pdf_id=/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service close_pdf surfaces backend close failures", async () => {
	const baseDir = temporaryDir("host-service-close-pdf-failures-");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const unsupportedSocket = join(baseDir, "unsupported.sock");
	const unavailableSocket = join(baseDir, "unavailable.sock");
	const mismatchSocket = join(baseDir, "mismatch.sock");

	const unsupportedBackend = new FakeViewerBackend({
		name: "host-service-unsupported-close-backend",
		capabilities: {
			open: true,
			close: false,
			forward_search: false,
			inverse_search: false,
			reuse: false,
		},
	});
	const unsupportedService = new HostServiceServer({
		socketPath: unsupportedSocket,
		viewerBackend: unsupportedBackend,
	});
	const unavailableService = new HostServiceServer({
		socketPath: unavailableSocket,
		viewerBackend: new CloseControlledFakeViewerBackend("backend_unavailable"),
	});
	const mismatchService = new HostServiceServer({
		socketPath: mismatchSocket,
		viewerBackend: new CloseControlledFakeViewerBackend("identity_mismatch"),
	});
	await Promise.all([
		unsupportedService.start(),
		unavailableService.start(),
		mismatchService.start(),
	]);
	const unsupportedClient = new HostServiceClient({ socketPath: unsupportedSocket, requestTimeoutMs: 1_000 });
	const unavailableClient = new HostServiceClient({ socketPath: unavailableSocket, requestTimeoutMs: 1_000 });
	const mismatchClient = new HostServiceClient({ socketPath: mismatchSocket, requestTimeoutMs: 1_000 });

	try {
		const unsupportedOpen = await unsupportedClient.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (unsupportedOpen.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const unsupportedPdfId = unsupportedOpen.pdf_id;
		await assert.rejects(
			() => unsupportedClient.requestClosePdf({ cwd: baseDir }, unsupportedPdfId),
			/unsupported_operation/,
		);

		const unavailableOpen = await unavailableClient.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (unavailableOpen.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const unavailablePdfId = unavailableOpen.pdf_id;
		await assert.rejects(
			() => unavailableClient.requestClosePdf({ cwd: baseDir }, unavailablePdfId),
			/backend_unavailable/,
		);

		const mismatchOpen = await mismatchClient.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (mismatchOpen.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const mismatchPdfId = mismatchOpen.pdf_id;
		await assert.rejects(
			() => mismatchClient.requestClosePdf({ cwd: baseDir }, mismatchPdfId),
			/identity_mismatch/,
		);
	} finally {
		await Promise.all([
			unsupportedService.stop(),
			unavailableService.stop(),
			mismatchService.stop(),
		]);
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf forwards to viewer backend with inferred default source", async () => {
	const baseDir = temporaryDir("host-service-jump-success-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\nbeta\ngamma\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new FakeForwardSearchTracker();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		const jumpResponse = await client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 3 });
		assert.equal(jumpResponse.handled, true);
		assert.equal(jumpResponse.reopened, false);
		assert.equal(jumpResponse.pdf_id, pdfId);
		assert.equal(jumpResponse.source_file, sourcePath);
		assert.equal(jumpResponse.line, 3);
		assert.equal(jumpResponse.source_line, "gamma");
		assert.equal(backend.forwardSearchCalls.length, 1);
		assert.equal(backend.forwardSearchCalls[0]?.source_file, sourcePath);
		assert.equal(backend.forwardSearchCalls[0]?.line, 3);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf fails without default source unless source_file is provided", async () => {
	const baseDir = temporaryDir("host-service-jump-missing-default-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: new FakeForwardSearchTracker(),
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 2 }),
			/No default source_file is known for tracked pdf_id=.*Pass source_file explicitly\./,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf requires explicit source_file when default source is unavailable", async () => {
	const baseDir = temporaryDir("host-service-jump-explicit-source-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const explicitSourcePath = join(baseDir, "manual.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(explicitSourcePath, "first\nsecond\nthird\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: new FakeForwardSearchTracker(),
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		const jumpResponse = await client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: pdfId, line: 2, source_file: "manual.tex" },
		);
		assert.equal(jumpResponse.handled, true);
		assert.equal(jumpResponse.source_file, explicitSourcePath);
		assert.equal(jumpResponse.line, 2);
		assert.equal(jumpResponse.source_line, "second");
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service requestJumpPdf includes backend diagnostics and source context", async () => {
	const baseDir = temporaryDir("host-service-jump-diagnostics-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\nbeta\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new FakeForwardSearchTracker({ name: "jump-faulty-backend" });
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "forward search command failed",
			handled: false,
			error_code: "backend_unavailable",
			reason: "forward search execution failed",
			service_available: false,
			backend_identity_ok: true,
			diagnostics: [{ command: "viewer-forward-search", exit_code: 42, stderr: "not found" }],
		},
	]);
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		await assert.rejects(
			async () => {
				await client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 2 });
			},
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /backend_unavailable/);
				assert.match(error.message, /backend=jump-faulty-backend/);
				assert.match(error.message, /source_line="beta"/);
				assert.match(error.message, /source_file=/);
				assert.match(error.message, /diagnostics=\[\{"command":"viewer-forward-search","exit_code":42,"stderr":"not found"\}\]/);
				assert.match(error.message, /line=2/);
				return true;
			},
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf rejects invalid line/source inputs", async () => {
	const baseDir = temporaryDir("host-service-jump-invalid-input-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeViewerBackend() });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 0 }),
			/line must be a positive integer/,
		);
		await assert.rejects(
			() => client.requestJumpPdf(
				{ cwd: baseDir },
				{ pdf_id: pdfId, line: 2, source_file: "missing.tex" },
			),
			/Cannot stat source_file/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf reports missing retained PDF before reopening", async () => {
	const baseDir = temporaryDir("host-service-jump-missing-retained-pdf-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const server = new HostServiceServer({ socketPath, viewerBackend: new FakeForwardSearchTracker() });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		await client.requestClosePdf({ cwd: baseDir }, pdfId);
		rmSync(pdfPath);
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 1 }),
			/Cannot stat PDF file/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf reopens known stale and closed pdf_ids while rejecting unknown ids", async () => {
	const baseDir = temporaryDir("host-service-jump-id-classification-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\nbeta\n");
	const registry = new HostServicePdfIdRegistry();
	const backend = new FakeForwardSearchTracker();
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
		managedViewerRecords: registry,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};

	try {
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: 999_999_999, line: 1 }),
			/Unknown pdf_id=999999999:/,
		);

		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const staleId = openResponse.pdf_id;
		registry.markRecordStale(staleId);
		const staleJump = await client.requestJumpPdf({ cwd: baseDir }, { pdf_id: staleId, line: 2 });
		assert.equal(staleJump.pdf_id, staleId);
		assert.equal(staleJump.reopened, true);
		assert.equal(staleJump.source_file, sourcePath);
		assert.equal(staleJump.source_line, "beta");
		assert.equal(registry.getActiveRecord(staleId).id, staleId);

		const reopenable = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: false },
		);
		if (reopenable.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const reopenablePdfId = reopenable.pdf_id;
		await client.requestClosePdf({ cwd: baseDir }, reopenablePdfId);
		const closedJump = await client.requestJumpPdf({ cwd: baseDir }, { pdf_id: reopenablePdfId, line: 1 });
		assert.equal(closedJump.pdf_id, reopenablePdfId);
		assert.equal(closedJump.reopened, true);
		assert.equal(closedJump.source_file, sourcePath);
		assert.equal(closedJump.source_line, "alpha");
		assert.equal(registry.getActiveRecord(reopenablePdfId).id, reopenablePdfId);
		assert.equal(backend.forwardSearchCalls.at(-1)?.line, 1);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service closed pdf_ids are forgotten after service restart", async () => {
	const baseDir = temporaryDir("host-service-closed-id-restart-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\n");
	const registry = new HostServicePdfIdRegistry({ minPdfId: 1234, maxPdfId: 1234, makePdfId: () => 1234 });
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	let server = new HostServiceServer({
		socketPath,
		viewerBackend: new FakeForwardSearchTracker(),
		managedViewerRecords: registry,
	});
	await server.start();
	let client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		assert.equal(openResponse.pdf_id, 1234);
		await client.requestClosePdf({ cwd: baseDir }, 1234);
		await server.stop();

		server = new HostServiceServer({
			socketPath,
			viewerBackend: new FakeForwardSearchTracker(),
			managedViewerRecords: registry,
		});
		await server.start();
		client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: 1234, line: 1, source_file: sourcePath }),
			/Unknown pdf_id=1234:/,
		);
	} finally {
		await server.stop().catch(() => undefined);
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf reopens a closed no-callback viewer", async () => {
	const baseDir = temporaryDir("host-service-jump-no-callback-closed-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "alpha\nbeta\n");
	const backend = new FakeForwardSearchTracker();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", reuse_existing: true, require_persistent_viewer: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		await client.requestClosePdf({ cwd: baseDir }, openResponse.pdf_id);
		const jumpResponse = await client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: openResponse.pdf_id, line: 2, source_file: "sample.tex" },
		);
		assert.equal(jumpResponse.pdf_id, openResponse.pdf_id);
		assert.equal(jumpResponse.reopened, true);
		assert.equal(jumpResponse.handled, true);
		assert.equal(jumpResponse.source_file, sourcePath);
		assert.equal(jumpResponse.source_line, "beta");
		assert.equal(backend.forwardSearchCalls.at(-1)?.line, 2);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf recovers from stale forward-search handles", async () => {
	const baseDir = temporaryDir("host-service-jump-stale-handle-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new FakeForwardSearchTracker();
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "viewer handle not recognized",
			handled: false,
			error_code: "handle_not_found",
			reason: "viewer handle not recognized",
			service_available: true,
			backend_identity_ok: false,
		},
		{
			status: "ok",
			handled: true,
			reason: "handled on reopen",
		},
	]);
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: backend,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const jumpPdfId = openResponse.pdf_id;
		const jumpResponse = await client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: jumpPdfId, line: 1 },
		);
		assert.equal(jumpResponse.handled, true);
		assert.equal(jumpResponse.reopened, true);
		assert.equal(backend.forwardSearchCalls.length, 2);
		assert.equal(backend.forwardSearchCalls[0]?.source_file, sourcePath);
		assert.equal(backend.forwardSearchCalls[1]?.source_file, sourcePath);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf does not revive when close_pdf wins concurrent reopen race", async () => {
	const baseDir = temporaryDir("host-service-jump-close-race-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new ConcurrentCloseReopenBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		const jumpPromise = client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: pdfId, line: 2 },
		).then(
			(value) => ({ status: "ok" as const, value }),
			(error: unknown) => ({ status: "error" as const, error }),
		);
		await backend.waitForReopenRequest();
		await client.requestClosePdf({ cwd: baseDir }, pdfId);
		backend.finishReopen();
		const jumpResult = await jumpPromise;
		assert.equal(jumpResult.status, "error");
		const jumpErrorText = jumpResult.status === "error" && jumpResult.error instanceof Error
			? jumpResult.error.message
			: String(jumpResult);
		assert.match(jumpErrorText, /conflict/);
		assert.equal(backend.forwardSearchCalls.length, 1);
		assert.ok(backend.closeHandles.length >= 2);
		await assert.rejects(
			() => client.requestClosePdf({ cwd: baseDir }, pdfId),
			/Closed pdf_id=/,
		);
	} finally {
		backend.finishReopen();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf reopens when backend reports viewer process not running", async () => {
	const baseDir = temporaryDir("host-service-jump-not-running-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new FakeForwardSearchTracker();
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "viewer process is not running",
			handled: false,
			error_code: "not_running",
			reason: "not_running",
			service_available: true,
			backend_identity_ok: true,
		},
		{
			status: "ok",
			handled: true,
			reason: "handled after not-running reopen",
		},
	]);
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const jumpResponse = await client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: openResponse.pdf_id, line: 2 },
		);
		assert.equal(jumpResponse.pdf_id, openResponse.pdf_id);
		assert.equal(jumpResponse.reopened, true);
		assert.equal(jumpResponse.handled, true);
		assert.equal(backend.forwardSearchCalls.length, 2);
		assert.equal(backend.forwardSearchCalls[0]?.source_file, sourcePath);
		assert.equal(backend.forwardSearchCalls[1]?.source_file, sourcePath);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf retries a not-running reopen with the new handle and pid", async () => {
	const baseDir = temporaryDir("host-service-jump-new-handle-pid-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new IncrementingHandlePidViewerBackend();
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "viewer process is not running",
			handled: false,
			error_code: "not_running",
			reason: "not_running",
			service_available: true,
			backend_identity_ok: true,
		},
		{
			status: "ok",
			handled: true,
			reason: "handled after new-session reopen",
			backend_identity_ok: true,
		},
	]);
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const jumpResponse = await client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: openResponse.pdf_id, line: 2 },
		);
		assert.equal(jumpResponse.pdf_id, openResponse.pdf_id);
		assert.equal(jumpResponse.reopened, true);
		assert.equal(jumpResponse.handled, true);
		assert.equal(jumpResponse.managed_record?.viewerHandle, "viewer-handle-2");
		assert.equal(jumpResponse.managed_record?.pid, 9002);
		assert.equal(backend.forwardSearchCalls.length, 2);
		assert.equal(backend.forwardSearchCalls[0]?.handle, "viewer-handle-1");
		assert.equal(backend.forwardSearchCalls[0]?.synctex_pid, 9001);
		assert.equal(backend.forwardSearchCalls[1]?.handle, "viewer-handle-2");
		assert.equal(backend.forwardSearchCalls[1]?.synctex_pid, 9002);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf retries transient forward-search failures after reopening", async () => {
	const baseDir = temporaryDir("host-service-jump-reopen-readiness-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new IncrementingHandlePidViewerBackend();
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "viewer process is not running",
			handled: false,
			error_code: "not_running",
			reason: "not_running",
			service_available: true,
			backend_identity_ok: true,
		},
		{
			status: "error",
			error: "viewer D-Bus session is not ready",
			handled: false,
			error_code: "not_ready",
			reason: "viewer D-Bus session is not ready",
			service_available: true,
			backend_identity_ok: true,
		},
		{
			status: "error",
			error: "viewer forward_search failed (returncode=255)",
			handled: false,
			error_code: "backend_unavailable",
			reason: "viewer forward_search failed (returncode=255)",
			service_available: true,
			backend_identity_ok: true,
			diagnostics: [{ stderr: "GDBus service not ready" }],
		},
		{
			status: "ok",
			handled: true,
			reason: "handled after readiness retry",
			backend_identity_ok: true,
		},
	]);
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const jumpResponse = await client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: openResponse.pdf_id, line: 2 },
		);
		assert.equal(jumpResponse.pdf_id, openResponse.pdf_id);
		assert.equal(jumpResponse.reopened, true);
		assert.equal(jumpResponse.handled, true);
		assert.equal(backend.forwardSearchCalls.length, 4);
		assert.equal(backend.forwardSearchCalls[0]?.handle, "viewer-handle-1");
		assert.equal(backend.forwardSearchCalls[0]?.synctex_pid, 9001);
		assert.equal(backend.forwardSearchCalls[1]?.handle, "viewer-handle-2");
		assert.equal(backend.forwardSearchCalls[1]?.synctex_pid, 9002);
		assert.equal(backend.forwardSearchCalls[2]?.handle, "viewer-handle-2");
		assert.equal(backend.forwardSearchCalls[2]?.synctex_pid, 9002);
		assert.equal(backend.forwardSearchCalls[3]?.handle, "viewer-handle-2");
		assert.equal(backend.forwardSearchCalls[3]?.synctex_pid, 9002);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf does not retry generic backend_unavailable after reopening", async () => {
	const baseDir = temporaryDir("host-service-jump-generic-backend-unavailable-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new IncrementingHandlePidViewerBackend();
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "viewer process is not running",
			handled: false,
			error_code: "not_running",
			reason: "not_running",
			service_available: true,
			backend_identity_ok: true,
		},
		{
			status: "error",
			error: "viewer backend failed permanently",
			handled: false,
			error_code: "backend_unavailable",
			reason: "viewer backend failed permanently",
			service_available: false,
			backend_identity_ok: true,
		},
		{
			status: "ok",
			handled: true,
			reason: "should not be retried",
		},
	]);
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 2 }),
			/backend_unavailable/,
		);
		assert.equal(backend.forwardSearchCalls.length, 2);
		assert.equal(backend.forwardSearchCalls[1]?.handle, "viewer-handle-2");
		assert.equal(backend.forwardSearchCalls[1]?.synctex_pid, 9002);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf bounds reopened forward-search attempts", async () => {
	const baseDir = temporaryDir("host-service-jump-reopen-timeout-budget-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new HangingReopenedForwardSearchBackend();
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const pdfId = openResponse.pdf_id;
		const startedAt = Date.now();
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: pdfId, line: 2 }),
			/service_timeout/,
		);
		const elapsedMs = Date.now() - startedAt;
		assert.ok(elapsedMs < 1_500, `reopened jump was not bounded: ${elapsedMs}ms`);
		assert.equal(backend.forwardSearchCalls.length, 2);
		assert.equal(backend.forwardSearchCalls[1]?.forward_search_timeout_ms, 500);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf aborts if close_pdf runs during reopened readiness retry", async () => {
	const baseDir = temporaryDir("host-service-jump-close-during-readiness-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new SignalingReadinessBackend();
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "viewer process is not running",
			handled: false,
			error_code: "not_running",
			reason: "not_running",
			service_available: true,
			backend_identity_ok: true,
		},
		{
			status: "error",
			error: "viewer forward_search failed (returncode=255)",
			handled: false,
			error_code: "backend_unavailable",
			reason: "viewer forward_search failed (returncode=255)",
			service_available: true,
			backend_identity_ok: true,
			diagnostics: [{ returncode: 255, stderr: "GDBus ServiceUnknown" }],
		},
		{
			status: "ok",
			handled: true,
			reason: "should not succeed after close",
		},
	]);
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 2_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const jumpPromise = client.requestJumpPdf(
			{ cwd: baseDir },
			{ pdf_id: openResponse.pdf_id, line: 2 },
		).then(
			(value) => ({ status: "ok" as const, value }),
			(error: unknown) => ({ status: "error" as const, error }),
		);
		await backend.waitForReadinessFailure();
		const closeResponse = await client.requestClosePdf({ cwd: baseDir }, openResponse.pdf_id);
		assert.equal(closeResponse.closed, true);
		const jumpResult = await jumpPromise;
		assert.equal(jumpResult.status, "error");
		const jumpErrorText = jumpResult.status === "error" && jumpResult.error instanceof Error
			? jumpResult.error.message
			: String(jumpResult);
		assert.match(jumpErrorText, /conflict/);
		assert.equal(backend.forwardSearchCalls.length, 2);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service jump_pdf surfaces handle-not-found reopen failures", async () => {
	const baseDir = temporaryDir("host-service-jump-stale-handle-fail-");
	const socketPath = join(baseDir, "host-service.sock");
	const pdfPath = join(baseDir, "sample.pdf");
	const sourcePath = join(baseDir, "sample.tex");
	writeFileSync(pdfPath, "%PDF-1.4\n");
	writeFileSync(sourcePath, "line one\nline two\n");
	const callback = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: join(baseDir, "callback.sock"),
		token: "alpha-token",
	};
	const backend = new FakeForwardSearchTracker({}, true);
	backend.setForwardSearchResponses([
		{
			status: "error",
			error: "viewer handle not recognized",
			handled: false,
			error_code: "handle_not_found",
			reason: "viewer handle not recognized",
		},
	]);
	const server = new HostServiceServer({ socketPath, viewerBackend: backend });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	try {
		const openResponse = await client.requestOpenPdf(
			{ cwd: baseDir },
			{ pdf_path: "sample.pdf", callback, reuse_existing: true },
		);
		if (openResponse.pdf_id === undefined) {
			throw new Error("host service open response did not include pdf_id");
		}
		const reopenFailPdfId = openResponse.pdf_id;
		await assert.rejects(
			() => client.requestJumpPdf({ cwd: baseDir }, { pdf_id: reopenFailPdfId, line: 2 }),
			/backend_unavailable/,
		);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("host service supports callback target register, replace, and unregister", async () => {
	const baseDir = temporaryDir("host-service-callback-register-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const targetPath = join(baseDir, "callback.sock");
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(targetPath, resolve);
	});
	const baseTarget = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
		socket_path: targetPath,
		token: "alpha-token",
	};

	const first = await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "pi-editor",
			target: baseTarget,
		},
	);
	assert.equal(first.target_id, "pi-editor");
	assert.equal(first.callback_registered, true);
	assert.equal(first.callback_replaced, false);
	assert.equal(first.target?.token, "alpha-token");

	const second = await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "pi-editor",
			target: {
				...baseTarget,
				token: "beta-token",
			},
		},
	);
	assert.equal(second.target_id, "pi-editor");
	assert.equal(second.callback_replaced, true);
	assert.equal(second.target?.token, "beta-token");

	const unregistered = await client.requestUnregisterCallbackTarget({ cwd: baseDir }, "pi-editor");
	assert.equal(unregistered.target_id, "pi-editor");
	assert.equal(unregistered.removed, true);
	const recheck = await client.requestUnregisterCallbackTarget({ cwd: baseDir }, "pi-editor");
	assert.equal(recheck.target_id, "pi-editor");
	assert.equal(recheck.removed, false);

	const resolved = await client.requestResolveCallbackTarget({ cwd: baseDir }, "pi-editor");
	assert.equal(resolved.operation, "resolve_callback_target");
	assert.equal(resolved.callback_available, false);
	assert.equal(resolved.target_id, "pi-editor");

	await server.stop();
	await new Promise<void>((resolve) => {
		callbackListener.close(() => resolve());
	});
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service isolates callback targets by workspace context", async () => {
	const baseDirA = temporaryDir("host-service-callback-context-a-");
	const baseDirB = temporaryDir("host-service-callback-context-b-");
	const socketPath = join(baseDirA, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-context" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const targetPathA = join(baseDirA, "callback-a.sock");
	const targetPathB = join(baseDirA, "callback-b.sock");
	const targetPathC = join(baseDirB, "callback-c.sock");
	const callbackListenerA = createServer();
	const callbackListenerB = createServer();
	const callbackListenerC = createServer();
	await Promise.all([
		new Promise<void>((resolve) => callbackListenerA.listen(targetPathA, resolve)),
		new Promise<void>((resolve) => callbackListenerB.listen(targetPathB, resolve)),
		new Promise<void>((resolve) => callbackListenerC.listen(targetPathC, resolve)),
	]);

	const contextA = { cwd: baseDirA, session_id: "session-alpha" };
	const contextB = { cwd: baseDirA, session_id: "session-beta" };
	const contextC = { cwd: baseDirB, session_id: "session-alpha" };
	const baseTarget = {
		kind: "pi-synctex-callback-v1" as const,
		transport: "unix" as const,
	};

	const registeredA = await client.requestRegisterCallbackTarget(contextA, {
		target_id: "pi-editor",
		target: {
			...baseTarget,
			socket_path: targetPathA,
			token: "token-a",
		},
	});
	const registeredB = await client.requestRegisterCallbackTarget(contextB, {
		target_id: "pi-editor",
		target: {
			...baseTarget,
			socket_path: targetPathB,
			token: "token-b",
		},
	});
	const registeredC = await client.requestRegisterCallbackTarget(contextC, {
		target_id: "pi-editor",
		target: {
			...baseTarget,
			socket_path: targetPathC,
			token: "token-c",
		},
	});
	assert.equal(registeredA.callback_registered, true);
	assert.equal(registeredB.callback_registered, true);
	assert.equal(registeredC.callback_registered, true);

	const resolvedA = await client.requestResolveCallbackTarget(contextA, "pi-editor");
	const resolvedB = await client.requestResolveCallbackTarget(contextB, "pi-editor");
	const resolvedC = await client.requestResolveCallbackTarget(contextC, "pi-editor");
	assert.equal(resolvedA.callback_available, true);
	assert.equal(resolvedA.target?.token, "token-a");
	assert.equal(resolvedB.callback_available, true);
	assert.equal(resolvedB.target?.token, "token-b");
	assert.equal(resolvedC.callback_available, true);
	assert.equal(resolvedC.target?.token, "token-c");

	const unregisteredB = await client.requestUnregisterCallbackTarget(contextB, "pi-editor");
	assert.equal(unregisteredB.removed, true);

	const afterUnregisterB = await client.requestResolveCallbackTarget(contextB, "pi-editor");
	assert.equal(afterUnregisterB.callback_available, false);
	const remainA = await client.requestResolveCallbackTarget(contextA, "pi-editor");
	assert.equal(remainA.callback_available, true);
	assert.equal(remainA.target?.token, "token-a");
	const remainC = await client.requestResolveCallbackTarget(contextC, "pi-editor");
	assert.equal(remainC.callback_available, true);
	assert.equal(remainC.target?.token, "token-c");

	await server.stop();
	await Promise.all([
		new Promise<void>((resolve) => callbackListenerA.close(() => resolve())),
		new Promise<void>((resolve) => callbackListenerB.close(() => resolve())),
		new Promise<void>((resolve) => callbackListenerC.close(() => resolve())),
	]);
	rmSync(baseDirA, { recursive: true, force: true });
	rmSync(baseDirB, { recursive: true, force: true });
});

test("host service degrades missing and stale callback targets", async () => {
	const baseDir = temporaryDir("host-service-callback-stale-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-stale" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const missing = await client.requestResolveCallbackTarget({ cwd: baseDir }, "missing-target");
	assert.equal(missing.callback_available, false);
	assert.equal(missing.target_id, "missing-target");

	const callbackSocket = join(baseDir, "callback.sock");
	const callbackListener = createServer();
	await new Promise<void>((resolve) => {
		callbackListener.listen(callbackSocket, resolve);
	});

	const shortLived = await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "short-lived",
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: callbackSocket,
				token: "stale-token",
			},
			stale_after_ms: 1,
		},
	);
	assert.equal(shortLived.callback_replaced, false);
	assert.equal(shortLived.callback_registered, true);
	await sleep(10);
	const stale = await client.requestResolveCallbackTarget({ cwd: baseDir }, "short-lived");
	assert.equal(stale.callback_available, false);
	assert.equal(stale.target_id, "short-lived");
	await new Promise<void>((resolve) => {
		callbackListener.close(() => resolve());
	});

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service treats orphaned callback sockets as unavailable", async () => {
	const baseDir = temporaryDir("host-service-callback-orphan-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-orphan" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	const orphanSocket = join(baseDir, "callback-orphan.sock");
	const orphanServer = await startOrphanSocketServer(orphanSocket);
	await waitForFile(orphanSocket);
	await new Promise<void>((resolve) => {
		orphanServer.once("exit", () => resolve());
		orphanServer.kill("SIGKILL");
	});

	await client.requestRegisterCallbackTarget(
		{ cwd: baseDir },
		{
			target_id: "orphaned",
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: orphanSocket,
				token: "orphan-token",
			},
		},
	);
	const resolved = await client.requestResolveCallbackTarget({ cwd: baseDir }, "orphaned");
	assert.equal(resolved.callback_available, false);
	assert.equal(resolved.target_id, "orphaned");
	assert.equal(resolved.target, undefined);

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });
});

test("host service validates callback registration protocol", async () => {
	const baseDir = temporaryDir("host-service-callback-validation-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({ socketPath, serviceName: "agent-synctex-callback-validation" });
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });

	await assert.rejects(
		() => client.requestRegisterCallbackTarget({ cwd: "" }, {
			target_id: "bad-request",
			target: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: "/tmp/callback.sock",
				token: "token",
			},
		}),
		/invalid workspace_context/,
	);

	await assert.rejects(
		() => client.requestRegisterCallbackTarget(
			{ cwd: baseDir },
			{
				target_id: "bad-target",
				target: {
					kind: "not-a-real-kind",
					transport: "unix",
					socket_path: join(baseDir, "callback.sock"),
					token: "token",
				},
			} as any,
		),
		/invalid callback target/,
	);

	await server.stop();
	rmSync(baseDir, { recursive: true, force: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
const SERVICE_SCRIPT = resolve("scripts/show_latex_viewer.py");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function writeResultRequest(baseDir: string, requestId: string, operation: string, details: Record<string, unknown>): string {
	const path = join(baseDir, "viewer-requests", `${requestId}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			protocol_version: 1,
			request_id: requestId,
			created_at_ns: Date.now() * 1_000_000,
			operation,
			details,
		}),
		{ mode: 0o600 },
	);
	return path;
}

async function waitForFile(path: string, timeoutMs = 2000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf8").trim();
			if (raw.length > 0) return raw;
		}
		await sleep(25);
	}
	throw new Error(`timed out waiting for file: ${path}`);
}

async function waitForPath(path: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			return;
		}
		await sleep(25);
	}
	throw new Error(`timed out waiting for path: ${path}`);
}

async function waitForViewerResult(baseDir: string, requestId: string): Promise<any> {
	const path = join(baseDir, "viewer-results", `${requestId}.json`);
	const raw = await waitForFile(path, 3000);
	return JSON.parse(raw) as any;
}

async function waitForServiceDirs(baseDir: string): Promise<void> {
	await waitForPath(join(baseDir, "viewer-requests"), 1500);
	await waitForPath(join(baseDir, "viewer-results"), 1500);
}

async function withViewerService(environment: Record<string, string>, fn: (baseDir: string) => Promise<void>): Promise<void> {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-service-backend-wrapper-"));
	mkdirSync(baseDir, { recursive: true, mode: 0o700 });
	const proc: ChildProcess = spawn(PYTHON_BIN, [SERVICE_SCRIPT], {
		env: {
			...process.env,
			MCP_TMPDIR: baseDir,
			VIEWER_SERVICE_BACKEND: "fake",
			...environment,
		},
		stdio: ["ignore", "ignore", "ignore"],
	});

	try {
		await waitForServiceDirs(baseDir);
		await fn(baseDir);
	} finally {
		await new Promise<void>((resolveStop) => {
			if (proc.exitCode !== null) {
				resolveStop();
				return;
			}
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolveStop();
			};
			proc.once("exit", finish);
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!done) proc.kill("SIGKILL");
				setTimeout(finish, 50);
			}, 100);
		});
		rmSync(baseDir, { recursive: true, force: true });
	}
}


test("show_latex_viewer backend wrapper reports status via selected backend", async () => {
	await withViewerService({}, async (baseDir) => {
		writeResultRequest(baseDir, "status-backend-wrapper", "status", {});
		const result = await waitForViewerResult(baseDir, "status-backend-wrapper");
		assert.equal(result.status, "ok");
		assert.equal(result.operation, "status");
		assert.equal(result.status_details.operation, "status");
		assert.equal(result.status_details.backend.name, "fake-viewer");
		assert.equal(result.status_details.backend.path, "fake-viewer");
		assert.equal(result.status_details.service_available, true);
	});
});

test("show_latex_viewer backend wrapper routes open through fake adapter", async () => {
	await withViewerService({}, async (baseDir) => {
		const openDetails = {
			callback: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: "/tmp/show-latex-fake-callback.sock",
				token: "fake-token",
			},
			pdf_path: "/tmp/fake.pdf",
		};

		writeResultRequest(baseDir, "open-first", "open", openDetails);
		const first = await waitForViewerResult(baseDir, "open-first");
		assert.equal(first.status, "ok");
		assert.equal(first.status_details.backend, "fake-viewer");
		assert.equal(first.status_details.capabilities.open, true);
		assert.equal(first.status_details.reused, false);

		writeResultRequest(baseDir, "open-second", "open", openDetails);
		const second = await waitForViewerResult(baseDir, "open-second");
		assert.equal(second.status, "ok");
		assert.equal(second.status_details.backend, "fake-viewer");
		assert.equal(second.status_details.reused, true);
		assert.equal(second.status_details.handle, first.status_details.handle);
	});
});

test("show_latex_viewer fake backend can report unsupported capabilities", async () => {
	await withViewerService({ FAKE_VIEWER_OPEN: "false" }, async (baseDir) => {
		const openDetails = {
			callback: {
				kind: "pi-synctex-callback-v1",
				transport: "unix",
				socket_path: "/tmp/show-latex-fake-callback.sock",
				token: "fake-token",
			},
			pdf_path: "/tmp/fake.pdf",
		};

		writeResultRequest(baseDir, "open-unsupported", "open", openDetails);
		const first = await waitForViewerResult(baseDir, "open-unsupported");
		assert.equal(first.status, "error");
		assert.equal(first.status_details.supported, false);
		assert.equal(first.status_details.error_code, "unsupported_operation");
		assert.equal(first.status_details.backend, "fake-viewer");
		assert.equal(first.status_details.capabilities.close, false);
		assert.equal(first.status_details.capabilities.forward_search, false);

		writeResultRequest(baseDir, "status-unsupported", "status", {});
		const second = await waitForViewerResult(baseDir, "status-unsupported");
		assert.equal(second.status_details.supported, true);
	});
});

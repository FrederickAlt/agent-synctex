import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ViewerServiceClient,
	viewerServiceRequestPath,
	viewerServiceResultPath,
} from "./viewer_service.ts";
import type { SynctexCallbackConfig } from "./viewer_service.ts";

function fileMode(path: string): number {
	return lstatSync(path).mode & 0o777;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function temporaryDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function awaitFileMode(path: string, expected: number, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (fileMode(path) === expected) {
				return;
			}
		} catch {
			/* ignore */
		}
		await sleep(5);
	}
	throw new Error(`Expected ${path} mode ${expected.toString(8)}, got ${fileMode(path).toString(8)}`);
}

test("viewer service client returns matching status result", async () => {
	const baseDir = temporaryDir("viewer-client-success-");
	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 2_000,
		pollIntervalMs: 20,
		requestIdFactory: () => "ok",
	});

	const writeResult = async () => {
		await sleep(20);
		const resultPath = viewerServiceResultPath(baseDir, "ok");
		writeFileSync(resultPath, JSON.stringify({
			protocol_version: 1,
			request_id: "ok",
			operation: "status",
			status: "ok",
			generated_at_ns: Date.now() * 1_000_000,
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: { name: "zathura", available: true, path: "/usr/bin/zathura" },
				protocol_directories: {
					base: baseDir,
					requests: join(baseDir, "viewer-requests"),
					results: join(baseDir, "viewer-results"),
					state: join(baseDir, "viewer-state.json"),
				},
				diagnostics: { log_tail: "", recent_events: [] },
				service_instance_started_ns: Date.now() * 1_000_000,
				request_id: "ok",
				operation: "status",
			},
		}), { encoding: "utf8", mode: 0o600 });
	};

	const writePromise = writeResult();
	const status = await client.requestStatus();
	await writePromise;

	const requestPath = viewerServiceRequestPath(baseDir, "ok");
	assert.equal(status.request_id, "ok");
	assert.equal(status.operation, "status");
	assert.equal(status.service_available, true);
	assert.equal(status.backend.name, "zathura");
	assert.equal(existsSync(requestPath), false, "request file should be cleaned up");
	assert.equal(existsSync(viewerServiceResultPath(baseDir, "ok")), false, "result file should be cleaned up");
});

test("viewer service client errors on malformed result payload", async () => {
	const baseDir = temporaryDir("viewer-client-malformed-");
	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 1_500,
		pollIntervalMs: 20,
		requestIdFactory: () => "bad",
	});

	const writeMalformed = async () => {
		await sleep(20);
		writeFileSync(viewerServiceResultPath(baseDir, "bad"), "not-json", { encoding: "utf8", mode: 0o600 });
	};

	await Promise.all([
		writeMalformed(),
		(async () => {
			await assert.rejects(
				() => client.requestStatus(),
				/Malformed viewer service result payload: not-json/,
			);
		})(),
	]);
});

test("viewer service requestOpenPdf surfaces invalid-PDF open errors", async () => {
	const baseDir = temporaryDir("viewer-client-open-error-invalid-pdf-");
	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 1_500,
		pollIntervalMs: 20,
		requestIdFactory: () => "open-error",
	});
	const callback: SynctexCallbackConfig = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/synctex.sock",
		token: "abc123",
	};

	const writeOpenError = async () => {
		await sleep(20);
		writeFileSync(viewerServiceResultPath(baseDir, "open-error"), JSON.stringify({
			protocol_version: 1,
			request_id: "open-error",
			operation: "open",
			status: "error",
			generated_at_ns: Date.now() * 1_000_000,
			error: "pdf_path is not a PDF file",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: "zathura",
				capabilities: {
					open: true,
					close: true,
					forward_search: true,
					inverse_search: true,
					reuse: true,
				},
				owned: false,
				reused: false,
				protocol_directories: {
					base: baseDir,
					requests: join(baseDir, "viewer-requests"),
					results: join(baseDir, "viewer-results"),
					state: join(baseDir, "viewer-state.json"),
				},
				service_instance_started_ns: Date.now() * 1_000_000,
				request_id: "open-error",
				operation: "open",
				error_code: "invalid_pdf",
			},
		}), { encoding: "utf8", mode: 0o600 });
	};

	await Promise.all([
		writeOpenError(),
		(async () => {
			await assert.rejects(
				() => client.requestOpenPdf("/tmp/not-a-pdf", callback),
				/pdf_path is not a PDF file.*code=invalid_pdf/,
			);
		})(),
	]);
});

test("viewer service requestOpenPdf surfaces backend-unavailable open errors", async () => {
	const baseDir = temporaryDir("viewer-client-open-error-backend-");
	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 1_500,
		pollIntervalMs: 20,
		requestIdFactory: () => "open-backend",
	});
	const callback: SynctexCallbackConfig = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/synctex.sock",
		token: "abc123",
	};

	const writeOpenError = async () => {
		await sleep(20);
		writeFileSync(viewerServiceResultPath(baseDir, "open-backend"), JSON.stringify({
			protocol_version: 1,
			request_id: "open-backend",
			operation: "open",
			status: "error",
			generated_at_ns: Date.now() * 1_000_000,
			error: "viewer backend is unavailable",
			status_details: {
				protocol_version: 1,
				supported: true,
				service_available: true,
				backend: "zathura",
				capabilities: {
					open: true,
					close: true,
					forward_search: true,
					inverse_search: true,
					reuse: true,
				},
				owned: false,
				reused: false,
				protocol_directories: {
					base: baseDir,
					requests: join(baseDir, "viewer-requests"),
					results: join(baseDir, "viewer-results"),
					state: join(baseDir, "viewer-state.json"),
				},
				service_instance_started_ns: Date.now() * 1_000_000,
				request_id: "open-backend",
				operation: "open",
				error_code: "backend_unavailable",
			},
		}), { encoding: "utf8", mode: 0o600 });
	};

	await Promise.all([
		writeOpenError(),
		(async () => {
			await assert.rejects(
				() => client.requestOpenPdf("/tmp/some.pdf", callback),
				/viewer backend is unavailable.*code=backend_unavailable/,
			);
		})(),
	]);
});

test("viewer service client times out when no result is produced", async () => {
	const baseDir = temporaryDir("viewer-client-timeout-");
	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 80,
		pollIntervalMs: 10,
		requestIdFactory: () => "timeout",
	});

	await assert.rejects(() => client.requestStatus(), /viewer service request timed out/);
	const requestPath = viewerServiceRequestPath(baseDir, "timeout");
	const resultPath = viewerServiceResultPath(baseDir, "timeout");
	assert.equal(existsSync(requestPath), false, "request file should be cleaned up on timeout");
	assert.equal(existsSync(resultPath), false, "result file should be cleaned up on timeout");
});

test("viewer service client aborts and cleans up pending request", async () => {
	const baseDir = temporaryDir("viewer-client-abort-");
	const controller = new AbortController();
	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 2_000,
		pollIntervalMs: 20,
		requestIdFactory: () => "aborted",
	});

	setTimeout(() => {
		controller.abort(new Error("user canceled"));
	}, 30);

	await assert.rejects(() => client.requestStatus(controller.signal), /viewer service request aborted/);
	assert.equal(existsSync(viewerServiceRequestPath(baseDir, "aborted")), false, "request should be cleaned up after abort");
});

test("viewer service client enforces request/result permissions and directory hardening", async () => {
	const baseDir = temporaryDir("viewer-client-permissions-");
	const requestDir = join(baseDir, "viewer-requests");
	const resultDir = join(baseDir, "viewer-results");
	mkdirSync(requestDir, { recursive: true });
	mkdirSync(resultDir, { recursive: true });
	chmodSync(requestDir, 0o755);
	chmodSync(resultDir, 0o775);

	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 1_000,
		pollIntervalMs: 20,
		requestIdFactory: () => "perms",
	});

	const resultPath = viewerServiceResultPath(baseDir, "perms");
	const writeResult = async () => {
		await sleep(20);
		await awaitFileMode(viewerServiceRequestPath(baseDir, "perms"), 0o600);
		writeFileSync(
			resultPath,
			JSON.stringify({
				protocol_version: 1,
				request_id: "perms",
				operation: "status",
				status: "ok",
				generated_at_ns: Date.now() * 1_000_000,
				status_details: {
					protocol_version: 1,
					supported: true,
					service_available: true,
					backend: { name: "zathura", available: true, path: "/usr/bin/zathura" },
					protocol_directories: {
						base: baseDir,
						requests: requestDir,
						results: resultDir,
						state: join(baseDir, "viewer-state.json"),
					},
					diagnostics: { log_tail: "", recent_events: [] },
					service_instance_started_ns: Date.now() * 1_000_000,
					request_id: "perms",
					operation: "status",
				},
			}),
			{ encoding: "utf8", mode: 0o600 },
		);
		assert.equal(fileMode(resultPath), 0o600, "result file should be 0600");
	};

	const statusPromise = client.requestStatus(undefined, 500);
	const [, status] = await Promise.all([writeResult(), statusPromise]);
	assert.equal(status.request_id, "perms");
	assert.equal(fileMode(requestDir), 0o700, "request directory should be hardened to 0700");
	assert.equal(fileMode(resultDir), 0o700, "result directory should be hardened to 0700");
});

test("viewer service client rejects symlinked request directory", async () => {
	const baseDir = temporaryDir("viewer-client-symlink-request-");
	const requestDir = join(baseDir, "viewer-requests");
	const requestTarget = join(baseDir, "real-requests");
	mkdirSync(requestTarget, { recursive: true });
	symlinkSync(requestTarget, requestDir);

	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 500,
		pollIntervalMs: 20,
		requestIdFactory: () => "symlink-request",
	});

	await assert.rejects(
		() => client.requestStatus(),
		/viewer service request directory is a symlink:/,
	);
});

test("viewer service client rejects symlinked result directory", async () => {
	const baseDir = temporaryDir("viewer-client-symlink-result-");
	const resultDir = join(baseDir, "viewer-results");
	const resultTarget = join(baseDir, "real-results");
	mkdirSync(resultTarget, { recursive: true });
	symlinkSync(resultTarget, resultDir);

	const client = new ViewerServiceClient(baseDir, {
		requestTimeoutMs: 500,
		pollIntervalMs: 20,
		requestIdFactory: () => "symlink-result",
	});

	await assert.rejects(
		() => client.requestStatus(),
		/viewer service result directory is a symlink:/,
	);
});
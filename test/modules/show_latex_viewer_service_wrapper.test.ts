import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
const SERVICE_SCRIPT = resolve("scripts/show_latex_viewer.py");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function killProcess(pid: number): void {
	spawnSync("kill", ["-9", String(pid)], {
		stdio: ["ignore", "ignore", "ignore"],
	});
}

function isProcessAlive(pid: number): boolean {
	const result = spawnSync("kill", ["-0", String(pid)], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	return result.status === 0;
}

async function waitForProcessExit(pid: number, timeoutMs = 800): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return;
		}
		await sleep(25);
	}
	throw new Error(`timed out waiting for process ${pid} to exit`);
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

function writeFakeZathuraViewerBinaryWithForwardSearch(path: string, options: { logPath?: string; forwardExitCode?: number } = {}): void {
	const logPath = options.logPath ?? "";
	const forwardExitCode = options.forwardExitCode ?? 0;
	const script = `#!/usr/bin/env bash
set -eu
if [ "$1" = "--synctex-forward" ]; then
	if [ -n "${logPath}" ]; then
		echo "$0" >> "${logPath}"
		for arg in "$@"; do
			echo "$arg" >> "${logPath}"
			done
	fi
	exit ${forwardExitCode}
fi
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

async function waitForServiceDirs(baseDir: string): Promise<void> {
	await waitForPath(join(baseDir, "viewer-requests"), 1500);
	await waitForPath(join(baseDir, "viewer-results"), 1500);
}

async function withViewerService(
	environment: Record<string, string>,
	fn: (baseDir: string) => Promise<void>,
	serviceBaseDir?: string,
): Promise<void> {
	const baseDir = serviceBaseDir ?? mkdtempSync(join(tmpdir(), "viewer-service-backend-wrapper-"));
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


test("show_latex_viewer fake backend routes forward_search through adapter", async () => {
	await withViewerService({}, async (baseDir) => {
		const sourceFile = join(baseDir, "source.tex");
		writeFileSync(sourceFile, "\\begin{document}\n", { mode: 0o600 });

		writeResultRequest(baseDir, "forward-unsupported", "forward_search", {
			handle: "does-not-exist",
			backend: "fake-viewer",
			source_file: sourceFile,
			line: 1,
		});
		const result = await waitForViewerResult(baseDir, "forward-unsupported");
		assert.equal(result.status, "error");
		assert.equal(result.status_details.error_code, "unsupported_operation");
		assert.equal(result.status_details.backend, "fake-viewer");
		assert.equal(result.error.includes("does not support forward_search"), true);
	});
});

test("show_latex_viewer fake backend exits cleanly on SIGTERM", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-fake-shutdown-"));
	const service = spawn(PYTHON_BIN, [SERVICE_SCRIPT], {
		env: {
			...process.env,
			MCP_TMPDIR: serviceBaseDir,
			VIEWER_SERVICE_BACKEND: "fake",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";

	try {
		if (service.stderr !== null) {
			service.stderr.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
			});
		}
		await waitForServiceDirs(serviceBaseDir);

		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			const timer = setTimeout(() => {
				service.kill("SIGKILL");
				reject(new Error("timeout waiting for fake viewer service exit during shutdown test"));
			}, 1200);
			service.once("exit", (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal });
			});
			service.kill("SIGTERM");
		});

		assert.equal(exit.code, 0);
		assert.equal(exit.signal, null);
		assert.equal(stderr.includes("AttributeError"), false);
		assert.equal(stderr.includes("Traceback"), false);
	} finally {
		if (service.exitCode === null) {
			service.kill("SIGKILL");
		}
		await new Promise<void>((resolve) => {
			if (service.exitCode !== null) {
				resolve();
				return;
			}
			service.once("exit", () => resolve());
		});
		rmSync(serviceBaseDir, { recursive: true, force: true });
	}
});


test("show_latex_viewer zathura backend reuses persistent open sessions", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-open-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	writeFakeZathuraViewerBinary(fakeViewer);
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-callback.sock",
		token: "zathura-token",
	};
	const otherCallback = {
		...callback,
		token: "different-token",
	};

	const openDetails = {
		callback,
		pdf_path: pdfPath,
	};
	const openDetailsWithDifferentCallback = {
		callback: otherCallback,
		pdf_path: pdfPath,
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		async (baseDir) => {
			writeResultRequest(baseDir, "status-zathura", "status", {});
			const status = await waitForViewerResult(baseDir, "status-zathura");
			assert.equal(status.status, "ok");
			assert.equal(status.status_details.backend.name, "zathura");
			assert.equal(status.status_details.backend.path, fakeViewer);

			writeResultRequest(baseDir, "zathura-open-first", "open", openDetails);
			const first = await waitForViewerResult(baseDir, "zathura-open-first");
			assert.equal(first.status, "ok");
			assert.equal(first.status_details.backend, "zathura");
			assert.equal(first.status_details.reused, false);
			assert.equal(first.status_details.owned, true);
			assert.equal(first.status_details.pid > 0, true);

			writeResultRequest(baseDir, "zathura-open-second", "open", openDetails);
			const second = await waitForViewerResult(baseDir, "zathura-open-second");
			assert.equal(second.status, "ok");
			assert.equal(second.status_details.backend, "zathura");
			assert.equal(second.status_details.reused, true);
			assert.equal(second.status_details.handle, first.status_details.handle);
			assert.equal(second.status_details.pid, first.status_details.pid);

			writeResultRequest(baseDir, "zathura-open-third", "open", openDetailsWithDifferentCallback);
			const third = await waitForViewerResult(baseDir, "zathura-open-third");
			assert.equal(third.status, "ok");
			assert.equal(third.status_details.backend, "zathura");
			assert.equal(third.status_details.reused, false);
			assert.notEqual(third.status_details.handle, first.status_details.handle);
		},
		serviceBaseDir,
	);
});

test("show_latex_viewer zathura backend closes prior owned session when callback changes or reuse is disabled", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-replace-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	writeFakeZathuraViewerBinary(fakeViewer);
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-replace-callback.sock",
		token: "alpha-token",
	};
	const otherCallback = {
		...callback,
		token: "different-token",
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		async (baseDir) => {
			const openRequestBase = {
				callback,
				pdf_path: pdfPath,
			};
			const openRequestDifferent = {
				callback: otherCallback,
				pdf_path: pdfPath,
			};

			writeResultRequest(baseDir, "zathura-open-a", "open", openRequestBase);
			const first = await waitForViewerResult(baseDir, "zathura-open-a");
			assert.equal(first.status, "ok");
			const firstPid = typeof first.status_details.pid === "number" ? first.status_details.pid : undefined;
			assert.equal(typeof firstPid, "number");

			writeResultRequest(baseDir, "zathura-open-b", "open", openRequestDifferent);
			const second = await waitForViewerResult(baseDir, "zathura-open-b");
			assert.equal(second.status, "ok");
			assert.notEqual(second.status_details.handle, first.status_details.handle);
			await waitForProcessExit(firstPid);

			writeResultRequest(baseDir, "zathura-open-c", "open", { ...openRequestBase, reuse_existing: false });
			const third = await waitForViewerResult(baseDir, "zathura-open-c");
			assert.equal(third.status, "ok");
			assert.notEqual(third.status_details.handle, second.status_details.handle);
			await waitForProcessExit(second.status_details.pid);
		},
		serviceBaseDir,
	);
});

test("show_latex_viewer service stop closes owned viewer processes", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-shutdown-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	writeFakeZathuraViewerBinary(fakeViewer);
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });
	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-shutdown-callback.sock",
		token: "zathura-token",
	};

	const service = spawn(PYTHON_BIN, [SERVICE_SCRIPT], {
		env: {
			...process.env,
			MCP_TMPDIR: serviceBaseDir,
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		stdio: ["ignore", "ignore", "ignore"],
	});
	try {
		await waitForServiceDirs(serviceBaseDir);
		writeResultRequest(serviceBaseDir, "shutdown-open", "open", {
			callback,
			pdf_path: pdfPath,
		});
		const opened = await waitForViewerResult(serviceBaseDir, "shutdown-open");
		assert.equal(opened.status, "ok");
		const pid = opened.status_details.pid;
		assert.equal(typeof pid, "number");

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				service.kill("SIGKILL");
				reject(new Error("timeout waiting for viewer service exit during shutdown test"));
			}, 1200);
			service.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			service.kill("SIGTERM");
		});
		await waitForProcessExit(pid);
	} finally {
		if (service.exitCode === null) {
			service.kill("SIGKILL");
		}
		rmSync(serviceBaseDir, { recursive: true, force: true });
	}
});

test("show_latex_viewer zathura backend executes forward_search with synctex command args", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-forward-args-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	const commandLog = join(serviceBaseDir, "forward-search-args.log");
	writeFakeZathuraViewerBinaryWithForwardSearch(fakeViewer, { logPath: commandLog });
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });
	const sourcePath = join(serviceBaseDir, "source.tex");
	writeFileSync(sourcePath, "\\section{X}\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-forward-callback.sock",
		token: "zathura-token",
	};
	const openDetails = {
		callback,
		pdf_path: pdfPath,
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		async (baseDir) => {
			writeResultRequest(baseDir, "zathura-forward-open", "open", openDetails);
			const open = await waitForViewerResult(baseDir, "zathura-forward-open");
			assert.equal(open.status, "ok");

			writeResultRequest(baseDir, "zathura-forward-search", "forward_search", {
				handle: open.status_details.handle,
				backend: "zathura",
				source_file: sourcePath,
				line: 9,
				synctex_pid: open.status_details.pid,
			});
			const forwardResult = await waitForViewerResult(baseDir, "zathura-forward-search");
			assert.equal(forwardResult.status, "ok");
			assert.equal(forwardResult.status_details.handled, true);
			assert.equal(forwardResult.status_details.backend_identity_ok, true);
			assert.equal(forwardResult.status_details.handle, open.status_details.handle);

			const commandArgs = readFileSync(commandLog, "utf8").trim().split(/\n/);
			const forwardIndex = commandArgs.indexOf("--synctex-forward");
			assert.equal(forwardIndex >= 0, true);
			assert.equal(commandArgs[0], fakeViewer);
			assert.equal(commandArgs[forwardIndex + 1], `9:1:${sourcePath}`);
			assert.equal(commandArgs[forwardIndex + 2], `--synctex-pid=${open.status_details.pid}`);
			assert.equal(commandArgs[forwardIndex + 3], pdfPath);
		},
		serviceBaseDir,
	);
});


test("show_latex_viewer zathura backend returns forward_search failure diagnostics", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-forward-fail-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	writeFakeZathuraViewerBinaryWithForwardSearch(fakeViewer, { forwardExitCode: 17 });
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });
	const sourcePath = join(serviceBaseDir, "source.tex");
	writeFileSync(sourcePath, "\\section{X}\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-forward-fail-callback.sock",
		token: "zathura-token",
	};
	const openDetails = {
		callback,
		pdf_path: pdfPath,
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		async (baseDir) => {
			writeResultRequest(baseDir, "zathura-forward-open", "open", openDetails);
			const open = await waitForViewerResult(baseDir, "zathura-forward-open");
			assert.equal(open.status, "ok");

			writeResultRequest(baseDir, "zathura-forward-search", "forward_search", {
				handle: open.status_details.handle,
				backend: "zathura",
				source_file: sourcePath,
				line: 1,
			});
			const forwardResult = await waitForViewerResult(baseDir, "zathura-forward-search");
			assert.equal(forwardResult.status, "error");
			assert.equal(forwardResult.status_details.error_code, "backend_unavailable");
			assert.equal(forwardResult.status_details.handled, false);
			assert.equal(forwardResult.status_details.diagnostics.length, 1);
			assert.equal(forwardResult.status_details.diagnostics[0].label, "tracked");
			assert.equal(forwardResult.status_details.diagnostics[0].returncode, 17);
			assert.equal(forwardResult.error.includes("returncode=17"), true);
		},
		serviceBaseDir,
	);
});


test("show_latex_viewer zathura backend surfaces backend-unavailable", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-bad-"));
	const missingViewer = join(serviceBaseDir, "missing-zathura");
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-callback.sock",
		token: "zathura-token",
	};
	const openDetails = {
		callback,
		pdf_path: pdfPath,
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: missingViewer,
		},
		async (baseDir) => {
			writeResultRequest(baseDir, "status-zathura-unavailable", "status", {});
			const status = await waitForViewerResult(baseDir, "status-zathura-unavailable");
			assert.equal(status.status, "ok");
			assert.equal(status.status_details.backend.name, "zathura");
			assert.equal(status.status_details.backend.available, false);
			assert.equal(status.status_details.backend.path, missingViewer);

			writeResultRequest(baseDir, "open-zathura-unavailable", "open", openDetails);
			const result = await waitForViewerResult(baseDir, "open-zathura-unavailable");
			assert.equal(result.status, "error");
			assert.equal(result.error, "viewer backend is unavailable");
			assert.equal(result.status_details.error_code, "backend_unavailable");
			assert.equal(result.status_details.owned, false);
			assert.equal(result.status_details.reused, false);
		},
		serviceBaseDir,
	);
});


test("show_latex_viewer zathura backend relaunches after stale tracked session", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-stale-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	writeFakeZathuraViewerBinary(fakeViewer);
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-callback.sock",
		token: "zathura-token",
	};
	const openDetails = {
		callback,
		pdf_path: pdfPath,
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		async (baseDir) => {
			writeResultRequest(baseDir, "zathura-open-first", "open", openDetails);
			const first = await waitForViewerResult(baseDir, "zathura-open-first");
			assert.equal(first.status, "ok");
			assert.equal(first.status_details.reused, false);

			killProcess(first.status_details.pid);
			await sleep(120);

			writeResultRequest(baseDir, "zathura-open-second", "open", openDetails);
			const second = await waitForViewerResult(baseDir, "zathura-open-second");
			assert.equal(second.status, "ok");
			assert.equal(second.status_details.reused, false);
			assert.notEqual(second.status_details.handle, first.status_details.handle);
			assert.notEqual(second.status_details.pid, first.status_details.pid);
		},
		serviceBaseDir,
	);
});


test("show_latex_viewer zathura backend closes owned viewers through backend adapter", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-close-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	writeFakeZathuraViewerBinary(fakeViewer);
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-close-callback.sock",
		token: "zathura-token",
	};
	const openDetails = {
		callback,
		pdf_path: pdfPath,
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		async (baseDir) => {
			writeResultRequest(baseDir, "zathura-close-open", "open", openDetails);
			const opened = await waitForViewerResult(baseDir, "zathura-close-open");
			assert.equal(opened.status, "ok");
			assert.equal(opened.status_details.closed, undefined);

			const pid = opened.status_details.pid;
			assert.equal(typeof pid, "number");
			writeResultRequest(baseDir, "zathura-close", "close", {
				handle: opened.status_details.handle,
				backend: "zathura",
			});
			const closeResult = await waitForViewerResult(baseDir, "zathura-close");
			assert.equal(closeResult.status, "ok");
			assert.equal(closeResult.status_details.closed, true);
			assert.equal(closeResult.status_details.reason, undefined);
			await waitForProcessExit(pid);
		},
		serviceBaseDir,
	);
});


test("show_latex_viewer zathura backend close preserves stale and mismatched handles", async () => {
	const serviceBaseDir = mkdtempSync(join(tmpdir(), "viewer-service-zathura-close-stale-"));
	const fakeViewer = join(serviceBaseDir, "zathura");
	writeFakeZathuraViewerBinary(fakeViewer);
	const pdfPath = join(serviceBaseDir, "sample.pdf");
	writeFileSync(pdfPath, "%PDF-1.7\n", { mode: 0o600 });

	const callback = {
		kind: "pi-synctex-callback-v1",
		transport: "unix",
		socket_path: "/tmp/show-latex-zathura-close-callback.sock",
		token: "zathura-token",
	};
	const openDetails = {
		callback,
		pdf_path: pdfPath,
	};

	await withViewerService(
		{
			VIEWER_SERVICE_BACKEND: "zathura",
			ZATHURA_VIEWER_PATH: fakeViewer,
		},
		async (baseDir) => {
			writeResultRequest(baseDir, "zathura-close-open-stale", "open", openDetails);
			const opened = await waitForViewerResult(baseDir, "zathura-close-open-stale");
			assert.equal(opened.status, "ok");

			const handle = opened.status_details.handle;
			const pid = opened.status_details.pid;

			writeResultRequest(baseDir, "zathura-close-backend-mismatch", "close", {
				handle,
				backend: "fake-viewer",
			});
			const mismatch = await waitForViewerResult(baseDir, "zathura-close-backend-mismatch");
			assert.equal(mismatch.status, "error");
			assert.equal(mismatch.status_details.reason, "backend_mismatch");

			killProcess(pid);
			await sleep(120);

			writeResultRequest(baseDir, "zathura-close-stale", "close", {
				handle,
				backend: "zathura",
			});
			const staleClose = await waitForViewerResult(baseDir, "zathura-close-stale");
			assert.equal(staleClose.status, "ok");
			assert.equal(staleClose.status_details.closed, false);
			assert.equal(staleClose.status_details.reason, "not_running");

			writeResultRequest(baseDir, "zathura-close-unknown", "close", {
				handle: "does-not-exist",
				backend: "zathura",
			});
			const unknown = await waitForViewerResult(baseDir, "zathura-close-unknown");
			assert.equal(unknown.status, "error");
			assert.equal(unknown.status_details.reason, "unknown_handle");
		},
		serviceBaseDir,
	);
});

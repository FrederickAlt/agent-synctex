import { accessSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, constants, lstatSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	commandAvailableInPath,
	checkGuiAvailability,
	run,
	runDoctor,
	runSetup,
	runUninstall,
} from "../../scripts/tex-actionsctl.ts";
import { HOST_SERVICE_TOOL_NAMES } from "../../src/modules/host_service_mcp.ts";
import { FakeViewerBackend, HostServiceServer } from "../../src/modules/host_service.ts";

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) {
			delete process.env[key];
			continue;
		}
		process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function writeExecutable(path: string): void {
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}

function noopDiagnostic() {
	return {
		info() {
			/* no-op */
		},
		warn() {
			/* no-op */
		},
		error() {
			/* no-op */
		},
	};
}

function captureConsole(): {
	outputs: string[];
	restore(): void;
} {
	const outputs: string[] = [];
	const originalLog = console.log;
	const originalWarn = console.warn;
	const originalError = console.error;
	const push = (...parts: unknown[]) => {
		outputs.push(parts.map((part) => String(part)).join(" "));
	};
	console.log = push;
	console.warn = push;
	console.error = push;
	return {
		outputs,
		restore() {
			console.log = originalLog;
			console.warn = originalWarn;
			console.error = originalError;
		},
	};
}

function encodeMcpPayload(payload: string): string {
	return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

function withMockedPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
	return fn().finally(() => {
		if (descriptor) {
			Object.defineProperty(process, "platform", descriptor);
		}
	});
}

interface FakeMcpInitializeOptions {
	initializeId?: string | number | null;
	initializeError?: boolean;
	initializeWrongServer?: boolean;
	initializeMissingResult?: boolean;
}

function startFakeDoctorServer(
	socketPath: string,
	responseTools: string[],
	options: FakeMcpInitializeOptions = {},
): ReturnType<typeof createServer> {
	return createServer((socket) => {
		let raw = "";
		socket.on("data", (chunk) => {
			raw += String(chunk);

			if (raw.includes("\"operation\":\"status\"")) {
				try {
					const request = JSON.parse(raw.trim());
					socket.end(
						JSON.stringify({
							protocol_version: 1,
							request_id: request.request_id,
							operation: "status",
							status: "ok",
							generated_at_ns: 1,
							status_details: {
								protocol_version: 1,
								supported: true,
								service_available: true,
								service_name: "tex-actions-host-service",
								socket_path: socketPath,
								service_instance_started_ns: 1,
								service_instance_id: "test",
								workspace_context: request.workspace_context,
								request_id: request.request_id,
								operation: "status",
								uptime_ns: 1,
								total_requests: 1,
								viewer_backend_name: "fake",
								viewer_backend_available: true,
								viewer_backend_capabilities: {
									open: true,
									close: true,
									forward_search: true,
									inverse_search: true,
									reuse: true,
								},
							},
						}) + "\n",
				);
				} catch {
					socket.end();
				}
				return;
			}

			if (raw.includes("\"method\":\"initialize\"")) {
				const initializeId = options.initializeId ?? 1;
				if (options.initializeError) {
					socket.end(
						encodeMcpPayload(
							JSON.stringify({
								jsonrpc: "2.0",
								id: initializeId,
								error: { code: -32600, message: "invalid request" },
							}),
					),
					);
					return;
				}
				if (options.initializeMissingResult) {
					socket.end(encodeMcpPayload(JSON.stringify({ jsonrpc: "2.0", id: initializeId })));
					return;
				}
				socket.end(
					encodeMcpPayload(
						JSON.stringify({
							jsonrpc: "2.0",
							id: initializeId,
							result: {
								serverInfo: {
									name: options.initializeWrongServer ? "wrong-tex-actions-server" : "tex-actions",
								},
								capabilities: { tools: { listChanged: false } },
							},
						}),
					),
				);
				return;
			}

			if (raw.includes("\"method\":\"tools/list\"")) {
				socket.end(
					encodeMcpPayload(
						JSON.stringify({
							jsonrpc: "2.0",
							id: 2,
							result: {
								tools: responseTools.map((name) => ({ name })),
							},
						}),
					),
				);
			}
		});
	});
}

function fakeCommandRunnerFactory(commands: string[]) {
	return (_command: string, _args: string[]): { exitCode: number; stdout: string; stderr: string } => {
		commands.push(`${_command} ${_args.join(" ")}`);
		return { exitCode: 0, stdout: "", stderr: "" };
	};
}

test("tex-actionsctl setup renders absolute paths into managed systemd unit", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-setup-"));
	const configDir = join(base, "config");
	const runtimeDir = join(base, "runtime");
	const repoRoot = process.cwd();
	const commands: string[] = [];
	const context = {
		platform: "linux" as NodeJS.Platform,
		homeDir: base,
		configDir,
		tempDir: runtimeDir,
		nodePath: "/usr/bin/node-test",
		repoRoot,
		serviceName: "show-latex.service",
		socketPath: "/tmp/tex-actionsctl-setup.sock",
		commandRunner: fakeCommandRunnerFactory(commands),
		diagnosticOutput: noopDiagnostic(),
	};
	const outcome = await runSetup(context as any);
	assert.equal(outcome.serviceFilePath, resolve(configDir, "systemd", "user", "show-latex.service"));
	const unitPath = outcome.serviceFilePath;
	const unit = readFileSync(unitPath, "utf8");
	assert.match(unit, /# Managed by tex-actionsctl/);
	assert.match(unit, /ExecStart=.*node-test .*tex-actionsctl\.ts daemon/);
	assert.equal(unit.includes(`${repoRoot}/scripts/tex-actionsctl.ts daemon`), true);
	assert.match(unit, /WorkingDirectory=/);
	const dirLine = unit.split(/\r?\n/).find((line) => line.startsWith("WorkingDirectory="));
	assert.equal(dirLine, `WorkingDirectory=${repoRoot}`);
	assert.match(unit, /NoNewPrivileges=true/);
	assert.equal(commands[0], "systemctl --user daemon-reload");
	assert.equal(commands[1], "systemctl --user enable --now show-latex.service");
	rmSync(base, { recursive: true, force: true });
});

test("tex-actionsctl setup refuses to overwrite unowned service unit", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-setup-unmanaged-"));
	const configDir = join(base, "config");
	const servicePath = resolve(configDir, "systemd", "user", "show-latex.service");
	mkdirSync(dirname(servicePath), { recursive: true, mode: 0o700 });
	writeFileSync(servicePath, "# third-party managed unit\n");
	const context = {
		platform: "linux" as NodeJS.Platform,
		homeDir: base,
		configDir,
		tempDir: join(base, "runtime"),
		nodePath: "/usr/bin/node-test",
		repoRoot: process.cwd(),
		serviceName: "show-latex.service",
		socketPath: "/tmp/tex-actionsctl-unmanaged.sock",
		commandRunner: fakeCommandRunnerFactory([]),
		diagnosticOutput: noopDiagnostic(),
	};
	await assert.rejects(
		() => runSetup(context as any),
		(error) => {
			const message = String(error);
			assert.match(message, /unmanaged/);
			return true;
		},
	);
	const after = readFileSync(servicePath, "utf8");
	assert.equal(after, "# third-party managed unit\n");
	rmSync(base, { recursive: true, force: true });
});

test("tex-actionsctl setup on non-Linux reports partial support without claiming write", async () => {
	const output = captureConsole();
	const previousArgv = process.argv.slice();
	const previousExitCode = process.exitCode;
	await withMockedPlatform("darwin", async () => {
		process.argv = [previousArgv[0] ?? "node", previousArgv[1] ?? "tex-actionsctl.ts", "setup"];
		process.exitCode = undefined;
		await run();
	});
	output.restore();
	process.argv = previousArgv;
	process.exitCode = previousExitCode;
	assert.equal(output.outputs.some((entry) => entry.includes("wrote unit")), false);
	assert.equal(
		output.outputs.some((entry) => entry.includes("setup currently supports Linux user services only")),
		true,
	);
});

test("tex-actionsctl uninstall is idempotent and only removes owned integration", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-uninstall-"));
	const configDir = join(base, "config");
	const socketPath = resolve(base, "tex-actions", "host-service.sock");
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const commands: string[] = [];
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen(socketPath, resolve);
	});
	const context = {
		platform: "linux" as NodeJS.Platform,
		homeDir: base,
		configDir,
		tempDir: base,
		nodePath: process.execPath,
		repoRoot: process.cwd(),
		serviceName: "show-latex.service",
		socketPath,
		commandRunner: fakeCommandRunnerFactory(commands),
		diagnosticOutput: noopDiagnostic(),
	};

	try {
		await runSetup(context as any);
		commands.length = 0;
		const first = await runUninstall(context as any);
		assert.equal(first.serviceRemoved, true);
		assert.equal(commands[0], "systemctl --user stop show-latex.service");
		assert.equal(commands[1], "systemctl --user disable show-latex.service");
		assert.ok(commands.some((command) => command === "systemctl --user daemon-reload"));

		commands.length = 0;
		const second = await runUninstall(context as any);
		assert.equal(second.serviceRemoved, true);
		assert.equal(commands.length >= 1, true);
		assert.ok(commands.some((command) => command === "systemctl --user daemon-reload"));
	} finally {
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		rmSync(base, { recursive: true, force: true });
	}
});

test("tex-actionsctl uninstall preserves unowned/live socket runtime path", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-uninstall-unowned-"));
	const configDir = join(base, "config");
	const socketPath = resolve(base, "custom", "tex-actions.sock");
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen(socketPath, resolve);
	});
	const context = {
		platform: "linux" as NodeJS.Platform,
		homeDir: base,
		configDir,
		tempDir: base,
		nodePath: process.execPath,
		repoRoot: process.cwd(),
		serviceName: "show-latex.service",
		socketPath,
		commandRunner: fakeCommandRunnerFactory([]),
		diagnosticOutput: noopDiagnostic(),
	};
	try {
		await runSetup(context as any);
		const outcome = await runUninstall(context as any);
		assert.equal(outcome.runtimeFilesRemoved.includes(socketPath), false);
		assert.equal(outcome.serviceRemoved, true);
		assert.equal(lstatSync(socketPath).isSocket(), true);
	} finally {
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		rmSync(base, { recursive: true, force: true });
	}
});

test("tex-actionsctl doctor reports healthy and unhealthy states", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-doctor-"));
	const runtimeDir = resolve(base, "runtime");
	const texDir = resolve(runtimeDir, "tex-actions");
	mkdirSync(texDir, { recursive: true, mode: 0o700 });
	const compileBin = join(base, "bin");
	mkdirSync(compileBin, { recursive: true, mode: 0o700 });
	for (const compiler of ["lualatex", "pdflatex", "xelatex", "latexmk"] as const) {
		writeExecutable(join(compileBin, compiler));
		accessSync(join(compileBin, compiler), constants.X_OK);
	}
	const socketPath = resolve(texDir, "host-service.sock");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: new FakeViewerBackend(),
	});
	await server.start();
	const basePath = join(base, "env");
	await withEnv(
		{
			HOME: base,
			XDG_RUNTIME_DIR: runtimeDir,
			XDG_CONFIG_HOME: basePath,
			PATH: `${compileBin}:${process.env.PATH ?? ""}`,
			DISPLAY: ":0",
			WAYLAND_DISPLAY: undefined,
			X11_UNIX: undefined,
			GDK_BACKEND: undefined,
		},
		async () => {
			const context = {
				platform: "linux" as NodeJS.Platform,
				homeDir: base,
				configDir: basePath,
				tempDir: runtimeDir,
				nodePath: process.execPath,
				repoRoot: process.cwd(),
				serviceName: "show-latex.service",
				socketPath,
				commandRunner: fakeCommandRunnerFactory([]),
				diagnosticOutput: noopDiagnostic(),
			};
			const report = await runDoctor(context as any);
			assert.equal(report.daemonReachable, true);
			assert.equal(report.mcpReachable, true);
			assert.equal(report.mcpChecks?.initialize, true);
			assert.equal(report.mcpChecks?.toolsList, true);
			assert.equal(report.errors.length, 0);
			assert.equal(report.remediation.length, 0);
			assert.equal(checkGuiAvailability(), true);
			assert.equal(commandAvailableInPath("lualatex"), true);
		},
	);
	await server.stop();

	const customSocketPath = resolve(base, "custom-socket", "missing.sock");
	const customSocketDir = dirname(customSocketPath);
	mkdirSync(customSocketDir, { recursive: true, mode: 0o700 });
	const failureReport = await withEnv(
		{
			HOME: base,
			XDG_RUNTIME_DIR: runtimeDir,
			XDG_CONFIG_HOME: basePath,
			PATH: compileBin,
			DISPLAY: undefined,
		},
		async () => {
			const context = {
				platform: "linux" as NodeJS.Platform,
				homeDir: base,
				configDir: basePath,
				tempDir: runtimeDir,
				nodePath: process.execPath,
				repoRoot: process.cwd(),
				serviceName: "show-latex.service",
				socketPath: customSocketPath,
				commandRunner: fakeCommandRunnerFactory([]),
				diagnosticOutput: noopDiagnostic(),
			};
			const failure = await runDoctor(context as any);
			assert.equal(failure.daemonReachable, false);
			assert.equal(failure.errors.length > 0, true);
			assert.equal(failure.remediation.includes("systemctl --user restart show-latex.service"), true);
			assert.equal(failure.socketDirectory.path, customSocketDir);
			return failure;
		},
	);
	assert.equal(failureReport.daemonReachable, false);

	rmSync(base, { recursive: true, force: true });
});

test("tex-actionsctl doctor tolerates missing optional compilers", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-doctor-optional-compilers-"));
	const runtimeDir = resolve(base, "runtime");
	const texDir = resolve(runtimeDir, "tex-actions");
	mkdirSync(texDir, { recursive: true, mode: 0o700 });
	const compileBin = join(base, "bin");
	mkdirSync(compileBin, { recursive: true, mode: 0o700 });
	writeExecutable(join(compileBin, "lualatex"));
	const socketPath = resolve(texDir, "host-service.sock");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: new FakeViewerBackend(),
	});
	await server.start();
	const basePath = join(base, "env");
	try {
		const report = await withEnv(
			{
				HOME: base,
				XDG_RUNTIME_DIR: runtimeDir,
				XDG_CONFIG_HOME: basePath,
			PATH: compileBin,
				DISPLAY: ":0",
			},
			async () => {
				const context = {
					platform: "linux" as NodeJS.Platform,
					homeDir: base,
					configDir: basePath,
					tempDir: runtimeDir,
					nodePath: process.execPath,
					repoRoot: process.cwd(),
					serviceName: "show-latex.service",
					socketPath,
					commandRunner: fakeCommandRunnerFactory([]),
					diagnosticOutput: noopDiagnostic(),
				};
				return await runDoctor(context as any);
			},
		);
		assert.equal(report.daemonReachable, true);
		assert.equal(report.mcpReachable, true);
		assert.equal(report.mcpChecks?.initialize, true);
		assert.equal(report.mcpChecks?.toolsList, true);
		assert.equal(report.errors.length, 0);
		assert.equal(report.warnings.some((message) => message.includes("Optional LaTeX compiler missing from PATH: pdflatex")), true);
		assert.equal(report.warnings.some((message) => message.includes("Optional LaTeX compiler missing from PATH: xelatex")), true);
		assert.equal(report.warnings.some((message) => message.includes("Optional LaTeX compiler missing from PATH: latexmk")), true);
	} finally {
		await server.stop();
		rmSync(base, { recursive: true, force: true });
	}
});


test("tex-actionsctl doctor fails when required compiler missing", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-doctor-required-compiler-"));
	const runtimeDir = resolve(base, "runtime");
	const texDir = resolve(runtimeDir, "tex-actions");
	mkdirSync(texDir, { recursive: true, mode: 0o700 });
	const compileBin = join(base, "bin");
	mkdirSync(compileBin, { recursive: true, mode: 0o700 });
	writeExecutable(join(compileBin, "pdflatex"));
	const socketPath = resolve(texDir, "host-service.sock");
	const server = new HostServiceServer({
		socketPath,
		viewerBackend: new FakeViewerBackend(),
	});
	await server.start();
	const basePath = join(base, "env");
	try {
		const report = await withEnv(
			{
				HOME: base,
				XDG_RUNTIME_DIR: runtimeDir,
				XDG_CONFIG_HOME: basePath,
			PATH: compileBin,
				DISPLAY: ":0",
			},
			async () => {
				const context = {
					platform: "linux" as NodeJS.Platform,
					homeDir: base,
					configDir: basePath,
					tempDir: runtimeDir,
					nodePath: process.execPath,
					repoRoot: process.cwd(),
					serviceName: "show-latex.service",
					socketPath,
					commandRunner: fakeCommandRunnerFactory([]),
					diagnosticOutput: noopDiagnostic(),
				};
				return await runDoctor(context as any);
			},
		);
		assert.equal(report.daemonReachable, true);
		assert.equal(report.errors.some((message) => message.includes("Required LaTeX compiler missing from PATH: lualatex")), true);
	} finally {
		await server.stop();
		rmSync(base, { recursive: true, force: true });
	}
});


test("tex-actionsctl doctor fails when MCP tools/list returns unexpected tool set", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-doctor-tools-"));
	const runtimeDir = resolve(base, "runtime");
	const socketPath = resolve(runtimeDir, "tex-actions", "host-service.sock");
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const compileBin = join(base, "bin");
	mkdirSync(compileBin, { recursive: true, mode: 0o700 });
	for (const compiler of ["lualatex", "pdflatex", "xelatex", "latexmk"] as const) {
		writeExecutable(join(compileBin, compiler));
	}
	const server = startFakeDoctorServer(socketPath, ["show_latex", "compile_latex_file"]);
	await new Promise<void>((resolve) => {
		server.listen(socketPath, resolve);
	});

	try {
		const report = await withEnv(
			{
				HOME: base,
				XDG_RUNTIME_DIR: runtimeDir,
				XDG_CONFIG_HOME: join(base, "env"),
				PATH: `${compileBin}:${process.env.PATH ?? ""}`,
				DISPLAY: ":0",
			},
			async () => {
				const context = {
					platform: "linux" as NodeJS.Platform,
					homeDir: base,
					configDir: join(base, "env"),
					tempDir: runtimeDir,
					nodePath: process.execPath,
					repoRoot: process.cwd(),
					serviceName: "show-latex.service",
					socketPath,
					commandRunner: fakeCommandRunnerFactory([]),
					diagnosticOutput: noopDiagnostic(),
				};
				return await runDoctor(context as any);
			},
		);
		assert.equal(report.daemonReachable, true);
		assert.equal(report.mcpChecks?.initialize, true);
		assert.equal(report.mcpChecks?.toolsList, false);
		assert.equal(report.errors.length > 0, true);
		assert.equal(report.mcpChecks?.toolNames.length, 2);
		assert.equal(
			report.mcpChecks?.toolNames.every((name) => HOST_SERVICE_TOOL_NAMES.includes(name as (typeof HOST_SERVICE_TOOL_NAMES)[number])),
			true,
		);
		assert.equal(report.mcpChecks?.toolNames.includes("compile_latex_file"), true);
	} finally {
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		rmSync(base, { recursive: true, force: true });
	}
});


test("tex-actionsctl doctor fails when MCP initialize returns MCP error", async () => {
	const base = mkdtempSync(join(tmpdir(), "tex-actionsctl-doctor-init-error-"));
	const runtimeDir = resolve(base, "runtime");
	const socketPath = resolve(runtimeDir, "tex-actions", "host-service.sock");
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const compileBin = join(base, "bin");
	mkdirSync(compileBin, { recursive: true, mode: 0o700 });
	for (const compiler of ["lualatex", "pdflatex", "xelatex", "latexmk"] as const) {
		writeExecutable(join(compileBin, compiler));
	}
	const server = startFakeDoctorServer(socketPath, ["show_latex"], { initializeError: true });
	await new Promise<void>((resolve) => {
		server.listen(socketPath, resolve);
	});

	try {
		const report = await withEnv(
			{
				HOME: base,
				XDG_RUNTIME_DIR: runtimeDir,
				XDG_CONFIG_HOME: join(base, "env"),
				PATH: `${compileBin}:${process.env.PATH ?? ""}`,
				DISPLAY: ":0",
			},
			async () => {
				const context = {
					platform: "linux" as NodeJS.Platform,
					homeDir: base,
					configDir: join(base, "env"),
					tempDir: runtimeDir,
					nodePath: process.execPath,
					repoRoot: process.cwd(),
					serviceName: "show-latex.service",
					socketPath,
					commandRunner: fakeCommandRunnerFactory([]),
					diagnosticOutput: noopDiagnostic(),
				};
				return await runDoctor(context as any);
			},
		);
		assert.equal(report.daemonReachable, true);
		assert.equal(report.mcpReachable, false);
		assert.equal(report.mcpChecks?.initialize, false);
		assert.equal(report.errors.length > 0, true);
		assert.equal(report.errors.some((message) => message.includes("MCP initialize failed")), true);
		assert.equal(report.errors.some((message) => message.includes("invalid request")), true);
		assert.equal(report.remediation.includes("systemctl --user restart show-latex.service"), true);
	} finally {
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
		rmSync(base, { recursive: true, force: true });
	}
});

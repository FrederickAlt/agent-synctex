import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const BASE_PATH = process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function runPython(script: string): string {
	const env = { ...process.env };
	delete env.MCP_TMPDIR;
	env.PATH = BASE_PATH;
	const result = spawnSync("python3", ["-c", script], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...env, PYTHONDONTWRITEBYTECODE: "1" },
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("legacy standalone MCP writes operation-scoped ready descriptors with matching SyncTeX commands", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_mcp.py")
mcp = types.ModuleType("show_latex_mcp")
mcp.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), mcp.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-mcp-test-"))
mcp.DEFAULT_TMPDIR = str(tmp)
mcp.choose_compiler = lambda compiler=None: ("fake", ["fake-compiler"])

class Result:
    returncode = 0
    stdout = ""

def fake_run(cmd, cwd, env, text, stdout, stderr, timeout, check):
    tex = Path(cwd, mcp.TEX_NAME).read_text(encoding="utf-8")
    Path(cwd, mcp.PDF_NAME).write_bytes(("%PDF-1.4\n" + tex).encode("utf-8"))
    Path(cwd, mcp.SYNCTEX_GZ_NAME).write_bytes(b"synctex")
    return Result()

mcp.subprocess.run = fake_run
mcp.compile_latex("first", synctex_editor_command="cmd-A")
first = json.loads(mcp.path_ready().read_text(encoding="utf-8"))
first_fixed_pdf = mcp.path_pdf().read_bytes().decode("utf-8")
first_fixed_tex = mcp.path_tex().read_text(encoding="utf-8")
first_fixed_synctex = mcp.path_synctex_gz().read_bytes().decode("utf-8")
mcp.compile_latex("second", synctex_editor_command="cmd-B")
second = json.loads(mcp.path_ready().read_text(encoding="utf-8"))
second_fixed_pdf = mcp.path_pdf().read_bytes().decode("utf-8")
second_fixed_tex = mcp.path_tex().read_text(encoding="utf-8")
print(json.dumps({
    "first": first,
    "second": second,
    "first_fixed_pdf": first_fixed_pdf,
    "first_fixed_tex": first_fixed_tex,
    "first_fixed_synctex": first_fixed_synctex,
    "second_fixed_pdf": second_fixed_pdf,
    "second_fixed_tex": second_fixed_tex,
}))
`);
	const descriptors = JSON.parse(output) as {
		first: { pdf: string; synctex_editor_command: string; operation_id: string };
		second: { pdf: string; synctex_editor_command: string; operation_id: string };
		first_fixed_pdf: string;
		first_fixed_tex: string;
		first_fixed_synctex: string;
		second_fixed_pdf: string;
		second_fixed_tex: string;
	};

	assert.equal(descriptors.first.synctex_editor_command, "cmd-A");
	assert.equal(descriptors.second.synctex_editor_command, "cmd-B");
	assert.notEqual(descriptors.first.operation_id, descriptors.second.operation_id);
	assert.notEqual(descriptors.first.pdf, descriptors.second.pdf);
	assert.match(descriptors.first.pdf, /^runs\/.+\/show-latex\.pdf$/);
	assert.match(descriptors.second.pdf, /^runs\/.+\/show-latex\.pdf$/);
	assert.ok(descriptors.first_fixed_pdf.includes("first"));
	assert.ok(descriptors.first_fixed_tex.includes("first"));
	assert.equal(descriptors.first_fixed_synctex, "synctex");
	assert.ok(descriptors.second_fixed_pdf.includes("second"));
	assert.ok(descriptors.second_fixed_tex.includes("second"));
});

test("legacy standalone MCP can suppress ready descriptor while still producing PDFs", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_mcp.py")
mcp = types.ModuleType("show_latex_mcp")
mcp.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), mcp.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-mcp-write-ready-test-"))
mcp.DEFAULT_TMPDIR = str(tmp)
mcp.choose_compiler = lambda compiler=None: ("fake", ["fake-compiler"])

class Result:
    returncode = 0
    stdout = ""

def fake_run(cmd, cwd, env, text, stdout, stderr, timeout, check):
    tex = Path(cwd, mcp.TEX_NAME).read_text(encoding="utf-8")
    Path(cwd, mcp.PDF_NAME).write_bytes(("%PDF-1.4\n" + tex).encode("utf-8"))
    return Result()

mcp.subprocess.run = fake_run
mcp.path_pdf().write_bytes(b"%PDF-1.4\nstale fixed")
mcp.path_ready().write_text('{"pdf":"stale"}\n', encoding="utf-8")
suppressed_pdf = mcp.compile_latex("inline", write_ready=False, write_fixed=False)
suppressed_ready_text = mcp.path_ready().read_text(encoding="utf-8")
fixed_pdf_after_suppressed = mcp.path_pdf().read_bytes().decode("utf-8")
ready_result = mcp.compile_latex("zathura", write_ready=True)
ready = json.loads(mcp.path_ready().read_text(encoding="utf-8"))
print(json.dumps({
    "suppressed_pdf": str(suppressed_pdf),
    "suppressed_ready_text": suppressed_ready_text,
    "fixed_pdf_after_suppressed": fixed_pdf_after_suppressed,
    "ready_pdf": str(ready_result),
    "ready_descriptor_pdf": ready["pdf"],
    "fixed_pdf_after_ready": mcp.path_pdf().read_bytes().decode("utf-8"),
}))
`);
	const result = JSON.parse(output) as {
		suppressed_pdf: string;
		suppressed_ready_text: string;
		fixed_pdf_after_suppressed: string;
		ready_pdf: string;
		ready_descriptor_pdf: string;
		fixed_pdf_after_ready: string;
	};

	assert.equal(result.suppressed_ready_text, '{"pdf":"stale"}\n');
	assert.match(result.suppressed_pdf, /\/runs\/.+\/show-latex\.pdf$/);
	assert.equal(result.fixed_pdf_after_suppressed, "%PDF-1.4\nstale fixed");
	assert.match(result.ready_pdf, /\/runs\/.+\/show-latex\.pdf$/);
	assert.match(result.ready_descriptor_pdf, /^runs\/.+\/show-latex\.pdf$/);
	assert.ok(result.fixed_pdf_after_ready.includes("zathura"));
});

test("legacy standalone MCP show_latex accepts write_ready false and returns PDF details", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_mcp.py")
mcp = types.ModuleType("show_latex_mcp")
mcp.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), mcp.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-mcp-call-tool-test-"))
mcp.DEFAULT_TMPDIR = str(tmp)
mcp.choose_compiler = lambda compiler=None: ("fake", ["fake-compiler"])

class Result:
    returncode = 0
    stdout = ""

def fake_run(cmd, cwd, env, text, stdout, stderr, timeout, check):
    Path(cwd, mcp.PDF_NAME).write_bytes(b"%PDF-1.4\n")
    return Result()

mcp.subprocess.run = fake_run
schema = mcp.tool_schema()[0]["inputSchema"]["properties"]
result = mcp.call_tool("show_latex", {"latex_source": "inline", "write_ready": False, "write_fixed": False})
print(json.dumps({
    "has_write_ready": "write_ready" in schema,
    "write_ready_default": schema["write_ready"]["default"],
    "has_write_fixed": "write_fixed" in schema,
    "write_fixed_default": schema["write_fixed"]["default"],
    "text": result["content"][0]["text"],
    "is_error": result["isError"],
    "pdf": result["details"]["pdf"],
    "ready_exists": mcp.path_ready().exists(),
    "fixed_exists": mcp.path_pdf().exists(),
}))
`);
	const result = JSON.parse(output) as {
		has_write_ready: boolean;
		write_ready_default: boolean;
		has_write_fixed: boolean;
		write_fixed_default: boolean;
		text: string;
		is_error: boolean;
		pdf: string;
		ready_exists: boolean;
		fixed_exists: boolean;
	};

	assert.equal(result.has_write_ready, true);
	assert.equal(result.write_ready_default, true);
	assert.equal(result.has_write_fixed, true);
	assert.equal(result.write_fixed_default, true);
	assert.equal(result.text, "ok");
	assert.equal(result.is_error, false);
	assert.match(result.pdf, /\/runs\/.+\/show-latex\.pdf$/);
	assert.equal(result.ready_exists, false);
	assert.equal(result.fixed_exists, false);
});

test("viewer service writes structured status results for valid requests", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path
import time

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-status-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()
request_id = "status-success"
request = {
    "protocol_version": viewer.PROTOCOL_VERSION,
    "request_id": request_id,
    "operation": "status",
    "created_at_ns": int(time.time_ns()),
}
viewer.atomic_write_text(viewer.request_path(request_id), json.dumps(request), mode=0o600)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
print(json.dumps({
    "processed": processed,
    "result": result,
    "state_exists": viewer.path_state().exists(),
    "request_gone": not viewer.request_path(request_id).exists(),
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		state_exists: boolean;
		request_gone: boolean;
		result: {
			protocol_version: number;
			request_id: string;
			operation: string;
			status: string;
			status_details: {
				protocol_version: number;
				protocol_directories: { base: string; requests: string; results: string; state: string };
				backend: { name: string; available: boolean; path?: string };
				service_available: boolean;
			};
		};
	};

	assert.equal(result.processed, 1);
	assert.equal(result.result.request_id, "status-success");
	assert.equal(result.result.operation, "status");
	assert.equal(result.result.status, "ok");
	assert.equal(result.result.status_details.protocol_version, 1);
	assert.equal(result.result.status_details.backend.name, "zathura");
	assert.equal(result.state_exists, true);
	assert.equal(result.request_gone, true);
	assert.ok(result.result.status_details.protocol_directories.requests.endsWith("viewer-requests"));
	assert.ok(result.result.status_details.protocol_directories.results.endsWith("viewer-results"));
	assert.ok(typeof result.result.status_details.service_available === "boolean");
});

test("viewer service open request tracks PID and reuses handle for matching opens", () => {
	const output = runPython(String.raw`
import json
import os
import signal
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-open-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

dir = tmp / "bin"
dir.mkdir()
backend_argv_log = dir / "fakezathura-argv.log"
os.environ["FAKE_BACKEND_ARGV_LOG"] = str(backend_argv_log)
zathura = dir / viewer.BACKEND_NAME
zathura.write_text("""#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path

log_path = os.environ.get("FAKE_BACKEND_ARGV_LOG")
if log_path:
    Path(log_path).open("a", encoding="utf-8").write(" ".join(sys.argv) + "\\n")

if "--fork" in sys.argv:
    pid = os.fork()
    if pid != 0:
        os._exit(0)

while True:
    time.sleep(0.1)
""")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{dir}:{os.environ.get('PATH', '')}"

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
pdf_key = str(pdf.resolve())
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}

def pid_alive(pid: int) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def reap_pid(pid: int) -> None:
    for signal_to_send in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, signal_to_send)
        except OSError:
            return
        for _ in range(40):
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            except OSError:
                break
            if waited != 0:
                return
            time.sleep(0.05)


def cmdline_has_fork(cmdline: object | None) -> bool:
    if not isinstance(cmdline, list):
        return False
    return any(part == "--fork" for part in cmdline)

launched_pids: list[int] = []

try:
    request_id = "open-first"
    viewer.atomic_write_text(
        viewer.request_path(request_id),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": request_id,
            "operation": "open",
            "created_at_ns": int(time.time_ns()),
            "details": {"pdf_path": str(pdf), "callback": callback},
        }),
        mode=0o600,
    )
    processed_first = viewer.scan_requests()
    first = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
    first_open_pid = first["status_details"].get("pid")
    if isinstance(first_open_pid, int):
        launched_pids.append(first_open_pid)

    def wait_for_invocations(min_count: int) -> list[str]:
        for _ in range(20):
            if not backend_argv_log.exists():
                time.sleep(0.05)
                continue
            lines = [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line]
            if len(lines) >= min_count:
                return lines
            time.sleep(0.05)
        return [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line] if backend_argv_log.exists() else []

    invocation_lines = wait_for_invocations(1)

    request_id_2 = "open-second"
    viewer.atomic_write_text(
        viewer.request_path(request_id_2),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": request_id_2,
            "operation": "open",
            "created_at_ns": int(time.time_ns()),
            "details": {"pdf_path": str(pdf), "callback": callback},
        }),
        mode=0o600,
    )
    processed_second = viewer.scan_requests()
    second = json.loads(viewer.result_path(request_id_2).read_text(encoding="utf-8"))

    first_details = first["status_details"]
    second_details = second["status_details"]
    first_pid = first_details.get("pid")
    second_pid = second_details.get("pid")
    if isinstance(second_pid, int):
        launched_pids.append(second_pid)

    tracked = viewer.OPEN_SESSIONS.get(pdf_key, {})
    tracker_pid = tracked.get("pid")
    tracker_handle = tracked.get("handle")
    invocation_lines = invocation_lines if len(invocation_lines) >= 1 else wait_for_invocations(1)

    tracked_identity = None
    if isinstance(first_pid, int):
        tracked_identity = viewer._snapshot_process_identity(first_pid)
    tracked_cmdline = tracked_identity.get("cmdline", []) if isinstance(tracked_identity, dict) else []

    print(json.dumps({
        "processed_first": processed_first,
        "processed_second": processed_second,
        "first_status": first["status"],
        "second_status": second["status"],
        "first_reused": first_details.get("reused", False),
        "second_reused": second_details.get("reused", False),
        "first_handle": first_details.get("handle", ""),
        "second_handle": second_details.get("handle", ""),
        "same_handle": first_details.get("handle") == second_details.get("handle"),
        "first_pid": first_pid if isinstance(first_pid, int) else None,
        "second_pid": second_pid if isinstance(second_pid, int) else None,
        "tracker_has_path": pdf_key in viewer.OPEN_SESSIONS,
        "tracker_handle": tracker_handle,
        "tracked_pid": tracker_pid if isinstance(tracker_pid, int) else None,
        "same_pid": first_pid == second_pid,
        "tracker_matches_pid": isinstance(first_pid, int) and tracker_pid == first_pid,
        "first_pid_alive_after_open": pid_alive(first_pid) if isinstance(first_pid, int) else False,
        "second_pid_alive_after_open": pid_alive(second_pid) if isinstance(second_pid, int) else False,
        "invocation_count": len(invocation_lines),
        "invocation_lines": invocation_lines,
        "invocation_has_fork": any("--fork" in entry for entry in invocation_lines),
        "tracked_cmdline_has_no_fork": not cmdline_has_fork(tracked_cmdline),
    }))
finally:
    for pid in set(launched_pids):
        reap_pid(pid)
`);
	const result = JSON.parse(output) as {
		processed_first: number;
		processed_second: number;
		first_status: string;
		second_status: string;
		first_reused: boolean;
		second_reused: boolean;
		first_handle: string;
		second_handle: string;
		same_handle: boolean;
		first_pid: number | null;
		second_pid: number | null;
		tracker_has_path: boolean;
		tracker_handle: string;
		tracked_pid: number | null;
		same_pid: boolean;
		tracker_matches_pid: boolean;
		first_pid_alive_after_open: boolean;
		second_pid_alive_after_open: boolean;
		invocation_count: number;
		invocation_lines: string[];
		invocation_has_fork: boolean;
		tracked_cmdline_has_no_fork: boolean;
	};
	assert.equal(result.processed_first, 1);
	assert.equal(result.processed_second, 1);
	assert.equal(result.first_status, "ok");
	assert.equal(result.second_status, "ok");
	assert.equal(result.first_reused, false);
	assert.equal(result.second_reused, true);
	assert.equal(result.same_handle, true);
	assert.equal(result.first_handle.length > 0, true);
	assert.equal(result.second_handle.length > 0, true);
	assert.equal(result.first_handle, result.second_handle);
	assert.equal(typeof result.first_pid, "number");
	assert.equal(result.first_pid, result.second_pid);
	assert.equal(result.same_pid, true);
	assert.equal(result.tracker_has_path, true);
	assert.equal(result.tracker_handle.length > 0, true);
	assert.equal(result.tracker_handle, result.first_handle);
	assert.equal(result.tracker_matches_pid, true);
	assert.equal(result.first_pid_alive_after_open, true);
	assert.equal(result.second_pid_alive_after_open, true);
	assert.equal(result.tracked_pid, result.first_pid);
	assert.equal(result.invocation_count, 1);
	assert.equal(result.invocation_has_fork, false);
	assert.equal(result.invocation_lines.length, 1);
	assert.equal(result.tracked_cmdline_has_no_fork, true);
});

test("viewer service open request can skip reuse when reuse_existing=false", () => {
	const output = runPython(String.raw`
import json
import os
import signal
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-open-no-reuse-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

dir = tmp / "bin"
dir.mkdir()
backend_argv_log = dir / "fakezathura-argv.log"
os.environ["FAKE_BACKEND_ARGV_LOG"] = str(backend_argv_log)
zathura = dir / viewer.BACKEND_NAME
zathura.write_text("""#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path

log_path = os.environ.get("FAKE_BACKEND_ARGV_LOG")
if log_path:
    Path(log_path).open("a", encoding="utf-8").write(" ".join(sys.argv) + "\\n")

if "--fork" in sys.argv:
    pid = os.fork()
    if pid != 0:
        os._exit(0)

while True:
    time.sleep(0.1)
""")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{dir}:{os.environ.get('PATH', '')}"
pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}


def reap_pid(pid: int) -> None:
    for signal_to_send in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, signal_to_send)
        except OSError:
            return
        for _ in range(40):
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            except OSError:
                break
            if waited != 0:
                return
            time.sleep(0.05)

launched_pids: list[int] = []

try:
    request_id = "open-first"
    viewer.atomic_write_text(
        viewer.request_path(request_id),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": request_id,
            "operation": "open",
            "created_at_ns": int(time.time_ns()),
            "details": {"pdf_path": str(pdf), "callback": callback},
        }),
        mode=0o600,
    )
    processed_first = viewer.scan_requests()
    first = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
    first_open_pid = first["status_details"].get("pid")
    if isinstance(first_open_pid, int):
        launched_pids.append(first_open_pid)

    def wait_for_invocations(min_count: int) -> list[str]:
        for _ in range(20):
            if not backend_argv_log.exists():
                time.sleep(0.05)
                continue
            lines = [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line]
            if len(lines) >= min_count:
                return lines
            time.sleep(0.05)
        return [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line] if backend_argv_log.exists() else []

    _ = wait_for_invocations(1)

    request_id_2 = "open-third"
    viewer.atomic_write_text(
        viewer.request_path(request_id_2),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": request_id_2,
            "operation": "open",
            "created_at_ns": int(time.time_ns()),
            "details": {"pdf_path": str(pdf), "callback": callback, "reuse_existing": False},
        }),
        mode=0o600,
    )
    processed_second = viewer.scan_requests()
    second = json.loads(viewer.result_path(request_id_2).read_text(encoding="utf-8"))

    first_pid = first["status_details"].get("pid")
    second_pid = second["status_details"].get("pid")
    if isinstance(second_pid, int):
        launched_pids.append(second_pid)

    invocation_lines = wait_for_invocations(2)

    print(json.dumps({
        "processed_first": processed_first,
        "processed_second": processed_second,
        "first_status": first["status"],
        "second_status": second["status"],
        "first_reused": first["status_details"].get("reused", False),
        "second_reused": second["status_details"].get("reused", False),
        "first_handle": first["status_details"].get("handle", ""),
        "second_handle": second["status_details"].get("handle", ""),
        "tracker_has_path": str(Path(pdf).resolve()) in viewer.OPEN_SESSIONS,
        "first_pid": first_pid if isinstance(first_pid, int) else None,
        "second_pid": second_pid if isinstance(second_pid, int) else None,
        "invocation_count": len(invocation_lines),
        "invocation_lines": invocation_lines,
    }))
finally:
    for pid in set(launched_pids):
        reap_pid(pid)
`);
	const result = JSON.parse(output) as {
		processed_first: number;
		processed_second: number;
		first_status: string;
		second_status: string;
		first_reused: boolean;
		second_reused: boolean;
		first_handle: string;
		second_handle: string;
		tracker_has_path: boolean;
		first_pid: number | null;
		second_pid: number | null;
		invocation_count: number;
		invocation_lines: string[];
	};
	assert.equal(result.processed_first, 1);
	assert.equal(result.processed_second, 1);
	assert.equal(result.first_status, "ok");
	assert.equal(result.second_status, "ok");
	assert.equal(result.first_reused, false);
	assert.equal(result.second_reused, false);
	assert.equal(result.first_handle === result.second_handle, false);
	assert.equal(result.tracker_has_path, true);
	assert.equal(typeof result.first_pid, "number");
	assert.equal(typeof result.second_pid, "number");
	assert.equal(result.first_pid !== result.second_pid, true);
	assert.equal(result.invocation_count, 2);
	assert.equal(result.invocation_lines.every((line) => !line.includes("--fork")), true);
});

test("viewer service does not reuse exited backend sessions", () => {
	const output = runPython(String.raw`
import json
import os
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-exited-open-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

bin_dir = tmp / "bin"
bin_dir.mkdir()
backend_argv_log = bin_dir / "fakezathura-argv.log"
os.environ["FAKE_BACKEND_ARGV_LOG"] = str(backend_argv_log)
zathura = bin_dir / viewer.BACKEND_NAME
zathura.write_text("""#!/bin/sh
log_path="$FAKE_BACKEND_ARGV_LOG"
if [ -n "$log_path" ]; then
    printf '%s\\n' "$0 $*" >> "$log_path"
fi
exit 0
""")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{bin_dir}:{os.environ.get('PATH', '')}"

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}

def write_open(request_id: str):
    viewer.atomic_write_text(
        viewer.request_path(request_id),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": request_id,
            "operation": "open",
            "created_at_ns": int(time.time_ns()),
            "details": {"pdf_path": str(pdf), "callback": callback},
        }),
        mode=0o600,
    )
    processed = viewer.scan_requests()
    result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
    return processed, result


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def wait_for_invocations(min_count: int) -> list[str]:
    for _ in range(20):
        if not backend_argv_log.exists():
            time.sleep(0.05)
            continue
        lines = [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line]
        if len(lines) >= min_count:
            return lines
        time.sleep(0.05)
    return [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line] if backend_argv_log.exists() else []

processed_first, first = write_open("open-exited-first")
first_pid = first["status_details"].get("pid")
if isinstance(first_pid, int):
    for _ in range(20):
        if not pid_alive(first_pid):
            break
        time.sleep(0.05)
processed_second, second = write_open("open-exited-second")
invocation_lines = wait_for_invocations(2)
pdf_key = str(pdf.resolve())
tracker_has_path = pdf_key in viewer.OPEN_SESSIONS
if tracker_has_path:
    for _ in range(20):
        time.sleep(0.05)
        tracker_has_path = pdf_key in viewer.OPEN_SESSIONS
        if not tracker_has_path:
            break

print(json.dumps({
    "processed_first": processed_first,
    "processed_second": processed_second,
    "first_status": first["status"],
    "second_status": second["status"],
    "first_owned": first["status_details"].get("owned"),
    "second_owned": second["status_details"].get("owned"),
    "first_reused": first["status_details"].get("reused"),
    "second_reused": second["status_details"].get("reused"),
    "same_handle": first["status_details"].get("handle") == second["status_details"].get("handle"),
    "tracker_has_path": tracker_has_path,
    "invocation_count": len(invocation_lines),
    "invocation_has_fork": any("--fork" in line for line in invocation_lines),
}))
`);
	const result = JSON.parse(output) as {
		processed_first: number;
		processed_second: number;
		first_status: string;
		second_status: string;
		first_owned: boolean;
		second_owned: boolean;
		first_reused: boolean;
		second_reused: boolean;
		same_handle: boolean;
		tracker_has_path: boolean;
		invocation_count: number;
		invocation_has_fork: boolean;
	};
	assert.equal(result.processed_first, 1);
	assert.equal(result.processed_second, 1);
	assert.equal(result.first_status, "ok");
	assert.equal(result.second_status, "ok");
	assert.equal(result.first_owned, false);
	assert.equal(result.second_owned, false);
	assert.equal(result.first_reused, false);
	assert.equal(result.second_reused, false);
	assert.equal(result.same_handle, false);
	assert.equal(result.tracker_has_path, false);
	assert.equal(result.invocation_count, 2);
	assert.equal(result.invocation_has_fork, false);
});

test("viewer service close request reports not_running after owned backend exits", () => {
	const output = runPython(String.raw`
import json
import os
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-close-exited-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

bin_dir = tmp / "bin"
bin_dir.mkdir()
zathura = bin_dir / viewer.BACKEND_NAME
zathura.write_text("""#!/usr/bin/env python3
import time
time.sleep(0.15)
""")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{bin_dir}:{os.environ.get('PATH', '')}"

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}
pdf_key = str(pdf.resolve())

viewer.atomic_write_text(
    viewer.request_path("open-then-exit"),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": "open-then-exit",
        "operation": "open",
        "created_at_ns": int(time.time_ns()),
        "details": {"pdf_path": str(pdf), "callback": callback},
    }),
    mode=0o600,
)
processed_open = viewer.scan_requests()
open_result = json.loads(viewer.result_path("open-then-exit").read_text(encoding="utf-8"))
handle = open_result["status_details"].get("handle")
pid = open_result["status_details"].get("pid")
if not isinstance(handle, str) or not isinstance(pid, int):
    raise RuntimeError("open did not return handle and pid")

time.sleep(0.3)
viewer.atomic_write_text(
    viewer.request_path("close-after-exit"),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": "close-after-exit",
        "operation": "close",
        "created_at_ns": int(time.time_ns()),
        "details": {"handle": handle, "backend": "fakezathura"},
    }),
    mode=0o600,
)
processed_close = viewer.scan_requests()
close_result = json.loads(viewer.result_path("close-after-exit").read_text(encoding="utf-8"))

print(json.dumps({
    "processed_open": processed_open,
    "processed_close": processed_close,
    "open_status": open_result["status"],
    "close_status": close_result["status"],
    "open_owned": open_result["status_details"].get("owned"),
    "closed": close_result["status_details"].get("closed"),
    "reason": close_result["status_details"].get("reason"),
    "session_still_tracked": pdf_key in viewer.OPEN_SESSIONS,
}))
`);
	const result = JSON.parse(output) as {
		processed_open: number;
		processed_close: number;
		open_status: string;
		close_status: string;
		open_owned: boolean;
		closed: boolean;
		reason: string;
		session_still_tracked: boolean;
	};

	assert.equal(result.processed_open, 1);
	assert.equal(result.processed_close, 1);
	assert.equal(result.open_status, "ok");
	assert.equal(result.close_status, "ok");
	assert.equal(result.open_owned, true);
	assert.equal(result.closed, false);
	assert.equal(result.reason, "not_running");
	assert.equal(result.session_still_tracked, false);
});

test("viewer service close request terminates tracked backend process", () => {
	const output = runPython(String.raw`
import json
import os
import signal
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-close-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

dir = tmp / "bin"
dir.mkdir()
backend_argv_log = dir / "fakezathura-argv.log"
os.environ["FAKE_BACKEND_ARGV_LOG"] = str(backend_argv_log)
zathura = dir / viewer.BACKEND_NAME
zathura.write_text("""#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path

log_path = os.environ.get("FAKE_BACKEND_ARGV_LOG")
if log_path:
    with Path(log_path).open("a", encoding="utf-8") as log_file:
        log_file.write(" ".join(sys.argv) + "\\n")
        log_file.flush()
        import os as _os
        _os.fsync(log_file.fileno())

if "--fork" in sys.argv:
    pid = os.fork()
    if pid != 0:
        os._exit(0)

while True:
    time.sleep(0.1)
""")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{dir}:{os.environ.get('PATH', '')}"

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}

pdf_key = str(pdf.resolve())


def pid_alive(pid: int) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def reap_pid(pid: int) -> None:
    for signal_to_send in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, signal_to_send)
        except OSError:
            return
        for _ in range(40):
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            except OSError:
                break
            if waited != 0:
                return
            time.sleep(0.05)


def cmdline_has_fork(cmdline: object | None) -> bool:
    if not isinstance(cmdline, list):
        return False
    return any(part == "--fork" for part in cmdline)

pid = None
try:
    request_id = "open-for-close"
    viewer.atomic_write_text(
        viewer.request_path(request_id),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": request_id,
            "operation": "open",
            "created_at_ns": int(time.time_ns()),
            "details": {"pdf_path": str(pdf), "callback": callback},
        }),
        mode=0o600,
    )
    processed_open = viewer.scan_requests()
    open_result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
    handle = open_result["status_details"].get("handle")
    pid = open_result["status_details"].get("pid")
    open_session = viewer.OPEN_SESSIONS.get(pdf_key, {})
    expected_identity = open_session.get("process_identity")
    expected_cmdline = expected_identity.get("cmdline") if isinstance(expected_identity, dict) else []

    def wait_for_invocations(min_count: int) -> list[str]:
        for _ in range(20):
            if not backend_argv_log.exists():
                time.sleep(0.05)
                continue
            lines = [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line]
            if len(lines) >= min_count:
                return lines
            time.sleep(0.05)
        return [line for line in backend_argv_log.read_text(encoding="utf-8").splitlines() if line] if backend_argv_log.exists() else []
    
    invocation_lines = wait_for_invocations(1)
    alive_before_close = isinstance(pid, int) and pid_alive(pid)

    if not isinstance(handle, str) or not isinstance(pid, int):
        raise RuntimeError("open request did not return a handle and pid")

    request_id_close = "close-matching"
    viewer.atomic_write_text(
        viewer.request_path(request_id_close),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": request_id_close,
            "operation": "close",
            "created_at_ns": int(time.time_ns()),
            "details": {
                "handle": handle,
                "backend": "fakezathura",
            },
        }),
        mode=0o600,
    )
    processed_close = viewer.scan_requests()
    close_result = json.loads(viewer.result_path(request_id_close).read_text(encoding="utf-8"))

    deadline = time.time() + 2.0
    while isinstance(pid, int) and pid_alive(pid) and time.time() < deadline:
        time.sleep(0.05)
    alive_after_close = isinstance(pid, int) and pid_alive(pid)

    print(json.dumps({
        "processed_open": processed_open,
        "processed_close": processed_close,
        "open_status": open_result["status"],
        "close_status": close_result["status"],
        "closed": close_result["status_details"].get("closed"),
        "reason": close_result["status_details"].get("reason"),
        "backend_identity_ok": close_result["status_details"].get("backend_identity_ok"),
        "pid": pid,
        "alive_before_close": alive_before_close,
        "alive_after_close": alive_after_close,
        "session_still_tracked": pdf_key in viewer.OPEN_SESSIONS,
        "invocation_count": len(invocation_lines),
        "invocation_has_fork": any("--fork" in entry for entry in invocation_lines),
        "invocation_uses_pdf_path": any(str(pdf.resolve()) in entry for entry in invocation_lines),
        "invocation_uses_procfd": any("/proc/self/fd/" in entry for entry in invocation_lines),
        "tracked_cmdline_has_no_fork": not cmdline_has_fork(expected_cmdline),
    }))
finally:
    if isinstance(pid, int):
        reap_pid(pid)
`);
	const result = JSON.parse(output) as {
		processed_open: number;
		processed_close: number;
		open_status: string;
		close_status: string;
		closed: boolean;
		reason: null | string;
		backend_identity_ok: boolean;
		pid: number;
		alive_before_close: boolean;
		alive_after_close: boolean;
		session_still_tracked: boolean;
		invocation_count: number;
		invocation_has_fork: boolean;
		invocation_uses_pdf_path: boolean;
		invocation_uses_procfd: boolean;
		tracked_cmdline_has_no_fork: boolean;
	};

	assert.equal(result.processed_open, 1);
	assert.equal(result.processed_close, 1);
	assert.equal(result.open_status, "ok");
	assert.equal(result.close_status, "ok");
	assert.equal(result.closed, true);
	assert.equal(result.backend_identity_ok, true);
	assert.equal(result.reason, null);
	assert.ok(Number.isInteger(result.pid));
	assert.equal(result.alive_before_close, true);
	assert.equal(result.alive_after_close, false);
	assert.equal(result.session_still_tracked, false);
	assert.equal(result.invocation_count, 1);
	assert.equal(result.invocation_has_fork, false);
	assert.equal(result.invocation_uses_pdf_path, true);
	assert.equal(result.invocation_uses_procfd, false);
	assert.equal(result.tracked_cmdline_has_no_fork, true);
});

test("viewer service close request does not SIGTERM on identity mismatch", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-close-mismatch-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\\n")
viewer.OPEN_SESSIONS[str(pdf)] = {
    "handle": "fakezathura:handle:1",
    "pid": 99999,
    "backend": "fakezathura",
    "owned": True,
    "process_identity": {
        "comm": "fakezathura",
        "start_time": 111,
        "cmdline": ["/tmp/fake", "--fork"],
        "exe": "/tmp/fake",
    },
}

killed: list[tuple[int, int]] = []
orig_kill = viewer.os.kill

def fake_kill(pid: int, signal: int) -> None:
    killed.append((pid, signal))

viewer.os.kill = fake_kill
viewer._pid_alive = lambda pid: True
viewer._snapshot_process_identity = lambda pid: {
    "comm": "fakezathura",
    "start_time": 222,
    "cmdline": ["/tmp/fake", "--fork"],
    "exe": "/tmp/fake",
}

request_id = "close-mismatch"
viewer.atomic_write_text(
    viewer.request_path(request_id),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": "close",
        "created_at_ns": int(time.time_ns()),
        "details": {
            "handle": "fakezathura:handle:1",
            "backend": "fakezathura",
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
viewer.os.kill = orig_kill

print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "closed": result["status_details"].get("closed"),
    "reason": result["status_details"].get("reason"),
    "backend_identity_ok": result["status_details"].get("backend_identity_ok"),
    "killed": killed,
    "session_still_tracked": str(pdf) in viewer.OPEN_SESSIONS,
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		status: string;
		closed: boolean;
		reason: string;
		backend_identity_ok: boolean;
		killed: Array<[number, number]>;
		session_still_tracked: boolean;
	};

	assert.equal(result.processed, 1);
	assert.equal(result.status, "ok");
	assert.equal(result.closed, false);
	assert.equal(result.reason, "identity_mismatch");
	assert.equal(result.backend_identity_ok, false);
	assert.equal(result.killed.length, 0);
	assert.equal(result.session_still_tracked, false);
});

test("viewer service close request returns not_service_owned for external-viewer sessions", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-close-not-service-owned-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
pdf_key = str(pdf.resolve())
viewer.OPEN_SESSIONS[pdf_key] = {
    "handle": "fakezathura:close-not-owned:1",
    "pid": 424242,
    "backend": "fakezathura",
    "owned": False,
    "process_identity": {
        "comm": "fakezathura",
        "start_time": 111,
        "cmdline": ["/tmp/fakezathura"],
        "exe": "/tmp/fakezathura",
    },
}

viewer.atomic_write_text(
    viewer.request_path("close-not-service-owned"),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": "close-not-service-owned",
        "operation": "close",
        "created_at_ns": int(__import__("time").time_ns()),
        "details": {
            "handle": "fakezathura:close-not-owned:1",
            "backend": "fakezathura",
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path("close-not-service-owned").read_text(encoding="utf-8"))

print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "closed": result["status_details"].get("closed"),
    "reason": result["status_details"].get("reason"),
    "backend_identity_ok": result["status_details"].get("backend_identity_ok"),
    "session_still_tracked": pdf_key in viewer.OPEN_SESSIONS,
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		status: string;
		closed: boolean;
		reason: string;
		backend_identity_ok: boolean;
		session_still_tracked: boolean;
	};

	assert.equal(result.processed, 1);
	assert.equal(result.status, "ok");
	assert.equal(result.closed, false);
	assert.equal(result.reason, "not_service_owned");
	assert.equal(result.backend_identity_ok, true);
	assert.equal(result.session_still_tracked, true);
});

test("viewer service close request reports backend_unavailable for SIGTERM permission failures", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-close-backend-unavailable-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
pdf_key = str(pdf.resolve())
viewer.OPEN_SESSIONS[pdf_key] = {
    "handle": "fakezathura:close-backend-unavailable:1",
    "pid": 424243,
    "backend": "fakezathura",
    "owned": True,
    "process_identity": {
        "comm": "fakezathura",
        "start_time": 111,
        "cmdline": ["/tmp/fakezathura"],
        "exe": "/tmp/fakezathura",
    },
}

orig_kill = viewer.os.kill
orig_snapshot_identity = viewer.ZathuraViewerBackend._snapshot_process_identity
killed: list[tuple[int, int]] = []

def deny_kill(pid: int, signal: int) -> None:
    killed.append((pid, signal))
    raise PermissionError("permission denied")

viewer.os.kill = deny_kill
viewer._pid_alive = lambda pid: True
viewer.ZathuraViewerBackend._snapshot_process_identity = lambda self, pid: {
    "comm": "fakezathura",
    "start_time": 111,
    "cmdline": ["/tmp/fakezathura"],
    "exe": "/tmp/fakezathura",
}

try:
    viewer.atomic_write_text(
        viewer.request_path("close-backend-unavailable"),
        json.dumps({
            "protocol_version": viewer.PROTOCOL_VERSION,
            "request_id": "close-backend-unavailable",
            "operation": "close",
            "created_at_ns": int(__import__("time").time_ns()),
            "details": {
                "handle": "fakezathura:close-backend-unavailable:1",
                "backend": "fakezathura",
            },
        }),
        mode=0o600,
    )
    processed = viewer.scan_requests()
    result = json.loads(viewer.result_path("close-backend-unavailable").read_text(encoding="utf-8"))
finally:
    viewer.os.kill = orig_kill
    viewer.ZathuraViewerBackend._snapshot_process_identity = orig_snapshot_identity

print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "closed": result["status_details"].get("closed"),
    "reason": result["status_details"].get("reason"),
    "error_code": result["status_details"].get("error_code"),
    "session_still_tracked": pdf_key in viewer.OPEN_SESSIONS,
    "killed": killed,
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		status: string;
		closed: boolean;
		reason: string;
		error_code: string;
		session_still_tracked: boolean;
		killed: Array<[number, number]>;
	};

	assert.equal(result.processed, 1);
	assert.equal(result.status, "error");
	assert.equal(result.closed, false);
	assert.equal(result.reason, "backend_unavailable");
	assert.equal(result.error_code, "backend_unavailable");
	assert.equal(result.session_still_tracked, true);
	assert.deepEqual(result.killed, [[424243, 15]]);
});

test("viewer service close request keeps not_running on terminate race", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path
import subprocess

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-close-terminate-race-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

class GoneBeforeTerminate(subprocess.Popen):
    def __init__(self):
        pass

    def poll(self):
        return None

    def terminate(self) -> None:
        raise ProcessLookupError(3, "gone", 99999)

    def wait(self, timeout: float | None = None) -> None:
        raise AssertionError("wait should not run if terminate fails")

    def kill(self) -> None:
        raise AssertionError("kill should not run if terminate fails")

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
pdf_key = str(pdf.resolve())
viewer.OPEN_SESSIONS[pdf_key] = {
    "handle": "fakezathura:close-terminate-race:1",
    "pid": 424244,
    "backend": "fakezathura",
    "owned": True,
    "process": GoneBeforeTerminate(),
    "process_identity": {
        "comm": "fakezathura",
        "start_time": 111,
        "cmdline": ["/tmp/fakezathura"],
        "exe": "/tmp/fakezathura",
    },
}

viewer.atomic_write_text(
    viewer.request_path("close-terminate-race"),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": "close-terminate-race",
        "operation": "close",
        "created_at_ns": int(__import__("time").time_ns()),
        "details": {
            "handle": "fakezathura:close-terminate-race:1",
            "backend": "fakezathura",
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path("close-terminate-race").read_text(encoding="utf-8"))

print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "closed": result["status_details"].get("closed"),
    "reason": result["status_details"].get("reason"),
    "session_still_tracked": pdf_key in viewer.OPEN_SESSIONS,
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		status: string;
		closed: boolean;
		reason: string;
		session_still_tracked: boolean;
	};

	assert.equal(result.processed, 1);
	assert.equal(result.status, "ok");
	assert.equal(result.closed, false);
	assert.equal(result.reason, "not_running");
	assert.equal(result.session_still_tracked, false);
});

test("viewer service close request keeps not_running on kill race", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path
import subprocess

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-close-kill-race-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

class KillDisappearsAfterTerminate(subprocess.Popen):
    def __init__(self):
        self._kill_called = False

    def poll(self):
        return None

    def terminate(self) -> None:
        pass

    def wait(self, timeout: float | None = None):
        if not self._kill_called:
            raise subprocess.TimeoutExpired("fake-viewer", 1.0)
        raise AssertionError("unexpected second wait")

    def kill(self) -> None:
        self._kill_called = True
        raise ProcessLookupError(3, "gone", 99999)

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
pdf_key = str(pdf.resolve())
viewer.OPEN_SESSIONS[pdf_key] = {
    "handle": "fakezathura:close-kill-race:1",
    "pid": 424245,
    "backend": "fakezathura",
    "owned": True,
    "process": KillDisappearsAfterTerminate(),
    "process_identity": {
        "comm": "fakezathura",
        "start_time": 111,
        "cmdline": ["/tmp/fakezathura"],
        "exe": "/tmp/fakezathura",
    },
}

viewer.atomic_write_text(
    viewer.request_path("close-kill-race"),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": "close-kill-race",
        "operation": "close",
        "created_at_ns": int(__import__("time").time_ns()),
        "details": {
            "handle": "fakezathura:close-kill-race:1",
            "backend": "fakezathura",
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path("close-kill-race").read_text(encoding="utf-8"))

print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "closed": result["status_details"].get("closed"),
    "reason": result["status_details"].get("reason"),
    "session_still_tracked": pdf_key in viewer.OPEN_SESSIONS,
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		status: string;
		closed: boolean;
		reason: string;
		session_still_tracked: boolean;
	};

	assert.equal(result.processed, 1);
	assert.equal(result.status, "ok");
	assert.equal(result.closed, false);
	assert.equal(result.reason, "not_running");
	assert.equal(result.session_still_tracked, false);
});

test("viewer service forward_search retries with rediscovered pid on mismatch", () => {
	const output = runPython(String.raw`
import json
import os
import signal
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-forward-search-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

bin_dir = tmp / "bin"
bin_dir.mkdir()
backend_log = bin_dir / "fakezathura-argv.log"
worker_pid_file = bin_dir / "fakezathura-worker.pid"
os.environ["FAKE_BACKEND_ARGV_LOG"] = str(backend_log)
os.environ["FAKE_VIEWER_WORKER_PID_FILE"] = str(worker_pid_file)

zathura = bin_dir / viewer.BACKEND_NAME
zathura.write_text("""#!/usr/bin/env python3\nimport os\nimport sys\nimport time\nfrom pathlib import Path\n\nlog_path = os.environ.get(\"FAKE_BACKEND_ARGV_LOG\")\npid_file = os.environ.get(\"FAKE_VIEWER_WORKER_PID_FILE\")\nscript_path = Path(sys.argv[0])\n\ndef write_log() -> None:\n    if log_path:\n        Path(log_path).open(\"a\", encoding=\"utf-8\").write(\" \".join(sys.argv) + \"\\n\")\n\ndef read_target_pid() -> int | None:\n    if not pid_file:\n        return None\n    try:\n        raw = Path(pid_file).read_text(encoding=\"utf-8\").strip()\n        return int(raw) if raw else None\n    except Exception:\n        return None\n\ndef requested_synctex_pid() -> int | None:\n    for arg in sys.argv:\n        if arg.startswith(\"--synctex-pid=\"):\n            try:\n                return int(arg.split(\"=\", 1)[1])\n            except ValueError:\n                return None\n    return None\n\nwrite_log()\n\nif \"--synctex-forward\" in sys.argv:\n    expected = read_target_pid()\n    requested = requested_synctex_pid()\n    if expected is None or requested != expected:\n        sys.stderr.write(f\"rejecting pid={requested}; expected={expected}\")\n        raise SystemExit(2)\n    raise SystemExit(0)\n\nif \"--worker\" in sys.argv:\n    while True:\n        time.sleep(0.1)\n\ntry:\n    pdf_path = os.readlink(sys.argv[-1])\nexcept Exception:\n    pdf_path = sys.argv[-1]\npid = os.fork()\nif pid == 0:\n    os.execl(sys.executable, sys.executable, str(script_path), \"--worker\", pdf_path)\nif pid_file:\n    Path(pid_file).write_text(str(pid), encoding=\"utf-8\")\nwhile True:\n    time.sleep(0.1)\n""")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{bin_dir}:{os.environ.get('PATH', '')}"

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\\n")
source = Path(tempfile.mkstemp(prefix="source-", suffix=".tex", dir=str(tmp))[1])
source.write_text("forward search", encoding="utf-8")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def reap_pid(pid: int) -> None:
    for signal_to_send in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, signal_to_send)
        except OSError:
            return
        for _ in range(30):
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            except OSError:
                break
            if waited != 0:
                return
            time.sleep(0.05)


request_id = "open-forward-retry"
viewer.atomic_write_text(
    viewer.request_path(request_id),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": "open",
        "created_at_ns": int(time.time_ns()),
        "details": {"pdf_path": str(pdf), "callback": callback},
    }),
    mode=0o600,
)
processed_open = viewer.scan_requests()
open_result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
open_pid = open_result["status_details"].get("pid")

for _ in range(50):
    if worker_pid_file.exists() and worker_pid_file.read_text(encoding="utf-8").strip():
        break
    time.sleep(0.05)
worker_pid = int(worker_pid_file.read_text(encoding="utf-8").strip()) if worker_pid_file.exists() else None

request_id_forward = "forward-mismatch"
viewer.atomic_write_text(
    viewer.request_path(request_id_forward),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id_forward,
        "operation": "forward_search",
        "created_at_ns": int(time.time_ns()),
        "details": {
            "handle": open_result["status_details"].get("handle"),
            "backend": "fakezathura",
            "source_file": str(source),
            "line": 1,
            "synctex_pid": open_pid,
        },
    }),
    mode=0o600,
)
processed_forward = viewer.scan_requests()
forward_result = json.loads(viewer.result_path(request_id_forward).read_text(encoding="utf-8"))
invocation_lines = [line for line in backend_log.read_text(encoding="utf-8").splitlines() if line]
session_pid = None
session = viewer.OPEN_SESSIONS.get(str(pdf.resolve()), {})
if isinstance(session.get("pid"), int):
    session_pid = session.get("pid")

after_open = pid_alive(open_pid) if isinstance(open_pid, int) else False
if isinstance(open_pid, int):
    reap_pid(open_pid)
if isinstance(worker_pid, int):
    reap_pid(worker_pid)

print(json.dumps({
    "processed_open": processed_open,
    "processed_forward": processed_forward,
    "open_status": open_result["status"],
    "forward_status": forward_result["status"],
    "after_open_alive": after_open,
    "request_handle": open_result["status_details"].get("handle"),
    "open_pid": open_pid if isinstance(open_pid, int) else None,
    "rediscovered_pid": worker_pid,
    "session_pid": session_pid,
    "invocation_count": len(invocation_lines),
    "invocation_lines": invocation_lines,
    "contains_wrong_pid_forward": any("--synctex-forward" in line and (f"--synctex-pid={open_pid}" in line) for line in invocation_lines),
    "contains_rediscovered_forward": any("--synctex-forward" in line and worker_pid is not None and (f"--synctex-pid={worker_pid}" in line) for line in invocation_lines),
}))
`);
	const result = JSON.parse(output) as {
		processed_open: number;
		processed_forward: number;
		open_status: string;
		forward_status: string;
		after_open_alive: boolean;
		request_handle: string;
		open_pid: number;
		rediscovered_pid: number;
		session_pid: number;
		invocation_count: number;
		invocation_lines: string[];
		contains_wrong_pid_forward: boolean;
		contains_rediscovered_forward: boolean;
	};

	assert.equal(result.processed_open, 1);
	assert.equal(result.processed_forward, 1);
	assert.equal(result.open_status, "ok");
	assert.equal(result.forward_status, "ok");
	assert.equal(result.request_handle.startsWith("fakezathura:"), true);
	assert.equal(result.session_pid === result.rediscovered_pid, true);
	assert.equal(result.contains_wrong_pid_forward, true);
	assert.equal(result.contains_rediscovered_forward, true);
	assert.equal(result.invocation_count >= 3, true);
});

test("viewer service forward_search failure includes command diagnostics", () => {
	const output = runPython(String.raw`
import json
import os
import signal
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-forward-failed-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

bin_dir = tmp / "bin"
bin_dir.mkdir()
backend_log = bin_dir / "fakezathura-argv.log"
os.environ["FAKE_BACKEND_ARGV_LOG"] = str(backend_log)

zathura = bin_dir / viewer.BACKEND_NAME
zathura.write_text("""#!/usr/bin/env python3\nimport os\nimport sys\nimport time\nfrom pathlib import Path\n\nlog_path = os.environ.get(\"FAKE_BACKEND_ARGV_LOG\")\nif log_path:\n    Path(log_path).open(\"a\", encoding=\"utf-8\").write(\" \".join(sys.argv) + \"\\n\")\nif \"--synctex-forward\" in sys.argv:\n    sys.stderr.write(\"forced forward-search failure\\n\")\n    raise SystemExit(3)\nwhile True:\n    time.sleep(0.1)\n""")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{bin_dir}:{os.environ.get('PATH', '')}"

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\n")
source = Path(tempfile.mkstemp(prefix="source-", suffix=".tex", dir=str(tmp))[1])
source.write_text("forward search", encoding="utf-8")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}


def reap_pid(pid: int) -> None:
    for signal_to_send in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, signal_to_send)
        except OSError:
            return
        for _ in range(20):
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            except OSError:
                break
            if waited != 0:
                return
            time.sleep(0.05)

request_id = "open-forward-fail"
viewer.atomic_write_text(
    viewer.request_path(request_id),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": "open",
        "created_at_ns": int(time.time_ns()),
        "details": {"pdf_path": str(pdf), "callback": callback},
    }),
    mode=0o600,
)
viewer.scan_requests()
open_result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
open_pid = open_result["status_details"].get("pid")

request_id_forward = "forward-search-fail"
viewer.atomic_write_text(
    viewer.request_path(request_id_forward),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id_forward,
        "operation": "forward_search",
        "created_at_ns": int(time.time_ns()),
        "details": {
            "handle": open_result["status_details"].get("handle"),
            "backend": "fakezathura",
            "source_file": str(source),
            "line": 1,
            "synctex_pid": open_pid,
        },
    }),
    mode=0o600,
)
viewer.scan_requests()
forward_result = json.loads(viewer.result_path(request_id_forward).read_text(encoding="utf-8"))
diagnostics = forward_result.get("status_details", {}).get("diagnostics", [])

if isinstance(open_pid, int):
    reap_pid(open_pid)

print(json.dumps({
    "forward_status": forward_result["status"],
    "forward_error": forward_result.get("error", ""),
    "diagnostics": diagnostics,
    "has_diagnostic_returncode": any(isinstance(item, dict) and item.get("returncode") == 3 for item in diagnostics),
    "has_diagnostic_stderr": any(isinstance(item, dict) and "forced forward-search failure" in str(item.get("stderr", "")) for item in diagnostics),
    "reason": forward_result["status_details"].get("reason"),
}))
`);
	const result = JSON.parse(output) as {
		forward_status: string;
		forward_error: string;
		diagnostics: Array<{ returncode?: number; stderr?: string; label?: string }>;
		has_diagnostic_returncode: boolean;
		has_diagnostic_stderr: boolean;
		reason: string;
	};

	assert.equal(result.forward_status, "error");
	assert.equal(/viewer forward_search failed/.test(result.forward_error), true);
	assert.equal(/returncode=3/.test(result.reason), true);
	assert.equal(result.has_diagnostic_returncode, true);
	assert.equal(result.has_diagnostic_stderr, true);
	assert.equal(result.diagnostics.length >= 1, true);
});

test("viewer service rejects invalid PDF files for open requests", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-open-invalid-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()

pdf = Path(tempfile.mkstemp(prefix="bad-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_text("not-a-pdf", encoding="utf-8")
request_id = "open-invalid"
viewer.atomic_write_text(
    viewer.request_path(request_id),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": "open",
        "created_at_ns": int(time.time_ns()),
        "details": {
            "pdf_path": str(pdf),
            "callback": {
                "kind": viewer.SYNCTEX_CALLBACK_KIND,
                "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
                "socket_path": "/tmp/synctex.sock",
                "token": "abc123",
            },
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "error": result.get("error", ""),
    "request_gone": not viewer.request_path(request_id).exists(),
}))
`);
	const result = JSON.parse(output) as { processed: number; status: string; error: string; request_gone: boolean };

	assert.equal(result.processed, 1);
	assert.equal(result.status, "error");
	assert.match(result.error, /pdf_path is not a PDF file/);
	assert.equal(result.request_gone, true);
});

test("viewer service rejects symlinked PDFs for open requests", () => {
	const output = runPython(String.raw`
import json
import os
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-open-symlink-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()

real_pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
real_pdf.write_bytes(b"%PDF-1.4\n")
link_pdf = tmp / "pdf-link"
os.symlink(real_pdf, link_pdf)
request_id = "open-symlink"
viewer.atomic_write_text(
    viewer.request_path(request_id),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": "open",
        "created_at_ns": int(time.time_ns()),
        "details": {
            "pdf_path": str(link_pdf),
            "callback": {
                "kind": viewer.SYNCTEX_CALLBACK_KIND,
                "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
                "socket_path": "/tmp/synctex.sock",
                "token": "abc123",
            },
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "error": result.get("error", ""),
}))
`);
	const result = JSON.parse(output) as { processed: number; status: string; error: string };

	assert.equal(result.processed, 1);
	assert.equal(result.status, "error");
	assert.match(result.error, /must not be a symlink/);
});

test("viewer service validates open request callback configuration", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-open-callback-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.4\n")
request_id = "open-bad-callback"
viewer.atomic_write_text(
    viewer.request_path(request_id),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": "open",
        "created_at_ns": int(time.time_ns()),
        "details": {
            "pdf_path": str(pdf),
            "callback": {
                "kind": viewer.SYNCTEX_CALLBACK_KIND,
                "transport": "tcp",
                "socket_path": "/tmp/synctex.sock",
                "token": "abc123",
            },
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "error": result.get("error", ""),
}))
`);
	const result = JSON.parse(output) as { processed: number; status: string; error: string };

	assert.equal(result.processed, 1);
	assert.equal(result.status, "error");
	assert.match(result.error, /callback transport must be unix/);
});

test("viewer service returns backend-unavailable for missing backend", () => {
	const output = runPython(String.raw`
import json
import os
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-open-backend-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "definitely-missing-viewer-backend"
viewer.ensure_protocol_dirs()
os.environ["PATH"] = "/tmp"

pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.4\n")
request_id = "open-no-backend"
viewer.atomic_write_text(
    viewer.request_path(request_id),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": "open",
        "created_at_ns": int(time.time_ns()),
        "details": {
            "pdf_path": str(pdf),
            "callback": {
                "kind": viewer.SYNCTEX_CALLBACK_KIND,
                "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
                "socket_path": "/tmp/synctex.sock",
                "token": "abc123",
            },
        },
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
result = json.loads(viewer.result_path(request_id).read_text(encoding="utf-8"))
print(json.dumps({
    "processed": processed,
    "status": result["status"],
    "error": result.get("error", ""),
}))
`);
	const result = JSON.parse(output) as { processed: number; status: string; error: string };

	assert.equal(result.processed, 1);
	assert.equal(result.status, "error");
	assert.match(result.error, /viewer backend is unavailable/);
});

test("viewer service ignores malformed status requests", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-malformed-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()
request_id = "malformed"
viewer.atomic_write_text(viewer.request_path(request_id), "{", mode=0o600)
processed = viewer.scan_requests()
print(json.dumps({
    "processed": processed,
    "request_exists": viewer.request_path(request_id).exists(),
    "result_exists": viewer.result_path(request_id).exists(),
    "request_count": len(list(viewer.path_requests().glob("*.json"))),
    "result_count": len(list(viewer.path_results().glob("*.json"))),
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		request_exists: boolean;
		result_exists: boolean;
		request_count: number;
		result_count: number;
	};

	assert.equal(result.processed, 0);
	assert.equal(result.request_exists, false);
	assert.equal(result.result_exists, false);
	assert.equal(result.request_count, 0);
	assert.equal(result.result_count, 0);
});

test("viewer service ignores stale requests and cleans up stale artifacts", () => {
	const output = runPython(String.raw`
import json
import os
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-stale-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()
request_id = "stale-request"
stale = {
    "protocol_version": viewer.PROTOCOL_VERSION,
    "request_id": request_id,
    "operation": "status",
    "created_at_ns": time.time_ns() - (viewer.REQUEST_TTL_SECONDS + 10) * 1_000_000_000,
}
viewer.atomic_write_text(viewer.request_path(request_id), json.dumps(stale), mode=0o600)
result_id = "stale-result"
viewer.atomic_write_text(viewer.result_path(result_id), json.dumps({"status": "ok"}), mode=0o600)
# Force the stale-result file to be old enough for cleanup.
now = time.time() - (viewer.RESULT_TTL_SECONDS + 10)
os.utime(viewer.result_path(result_id), (now, now))
processed = viewer.scan_requests()
print(json.dumps({
    "processed": processed,
    "request_exists": viewer.request_path(request_id).exists(),
    "result_exists": viewer.result_path(result_id).exists(),
    "request_count": len(list(viewer.path_requests().glob("*.json"))),
    "result_count": len(list(viewer.path_results().glob("*.json"))),
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		request_exists: boolean;
		result_exists: boolean;
		request_count: number;
		result_count: number;
	};

	assert.equal(result.processed, 0);
	assert.equal(result.request_exists, false);
	assert.equal(result.result_exists, false);
	assert.equal(result.request_count, 0);
	assert.equal(result.result_count, 0);
});

test("viewer service rejects request filename/body id mismatch", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-mismatch-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()
viewer.atomic_write_text(
    viewer.request_path("request-filename"),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": "payload-id",
        "operation": "status",
        "created_at_ns": int(time.time_ns()),
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
print(json.dumps({
    "processed": processed,
    "filename_exists": viewer.request_path("request-filename").exists(),
    "payload_file_exists": viewer.request_path("payload-id").exists(),
    "request_count": len(list(viewer.path_requests().glob("*.json"))),
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		filename_exists: boolean;
		payload_file_exists: boolean;
		request_count: number;
	};

	assert.equal(result.processed, 0);
	assert.equal(result.filename_exists, false);
	assert.equal(result.payload_file_exists, false);
	assert.equal(result.request_count, 0);
});

test("viewer service rejects oversized request payloads", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-too-big-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()
viewer.atomic_write_text(
    viewer.request_path("oversize"),
    json.dumps({
        "protocol_version": viewer.PROTOCOL_VERSION,
        "request_id": "oversize",
        "operation": "status",
        "created_at_ns": int(time.time_ns()),
        "details": {"blob": "x" * (viewer.MAX_REQUEST_BYTES + 128)},
    }),
    mode=0o600,
)
processed = viewer.scan_requests()
print(json.dumps({
    "processed": processed,
    "request_exists": viewer.request_path("oversize").exists(),
    "request_count": len(list(viewer.path_requests().glob("*.json"))),
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		request_exists: boolean;
		request_count: number;
	};

	assert.equal(result.processed, 0);
	assert.equal(result.request_exists, false);
	assert.equal(result.request_count, 0);
});

test("viewer service ignores symlinked request and result files", () => {
	const output = runPython(String.raw`
import json
import os
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-symlink-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()

request_target = tmp / "real-request.json"
request_target.write_text("{}", encoding="utf-8")
request_symlink = viewer.request_path("symlink-request")
os.symlink(request_target, request_symlink)

result_target = tmp / "real-result.json"
result_target.write_text('{"status": "ok"}', encoding="utf-8")
result_symlink = viewer.result_path("symlink-result")
os.symlink(result_target, result_symlink)

processed = viewer.scan_requests()
print(json.dumps({
    "processed": processed,
    "request_symlink_exists": request_symlink.exists() and request_symlink.is_symlink(),
    "result_symlink_exists": result_symlink.exists() and result_symlink.is_symlink(),
    "target_request_exists": request_target.exists(),
    "target_result_exists": result_target.exists(),
    "request_count": len(list(viewer.path_requests().glob("*.json"))),
    "result_count": len(list(viewer.path_results().glob("*.json"))),
}))
`);
	const result = JSON.parse(output) as {
		processed: number;
		request_symlink_exists: boolean;
		result_symlink_exists: boolean;
		target_request_exists: boolean;
		target_result_exists: boolean;
		request_count: number;
		result_count: number;
	};

	assert.equal(result.processed, 0);
	assert.equal(result.request_symlink_exists, false);
	assert.equal(result.result_symlink_exists, false);
	assert.equal(result.target_request_exists, true);
	assert.equal(result.target_result_exists, true);
	assert.equal(result.request_count, 0);
	assert.equal(result.result_count, 0);
});

test("viewer service enforces directory mode 0700", () => {
	const output = runPython(String.raw`
import json
import os
import tempfile
import types
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-perms-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()
os.chmod(tmp, 0o755)
os.chmod(viewer.path_requests(), 0o755)
os.chmod(viewer.path_results(), 0o750)
viewer.ensure_protocol_dirs()
print(json.dumps({
    "base_mode": oct(os.stat(tmp).st_mode & 0o777),
    "request_mode": oct(os.stat(viewer.path_requests()).st_mode & 0o777),
    "result_mode": oct(os.stat(viewer.path_results()).st_mode & 0o777),
}))
`);
	const result = JSON.parse(output) as {
		base_mode: string;
		request_mode: string;
		result_mode: string;
	};

	assert.equal(result.base_mode, "0o700");
	assert.equal(result.request_mode, "0o700");
	assert.equal(result.result_mode, "0o700");
});

test("viewer service writes request and result files with mode 0600", () => {
	const output = runPython(String.raw`
import json
import tempfile
import types
import time
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-file-mode-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.ensure_protocol_dirs()

request_id = "mode-check"
request = {
    "protocol_version": viewer.PROTOCOL_VERSION,
    "request_id": request_id,
    "operation": "status",
    "created_at_ns": int(time.time_ns()),
}
viewer.atomic_write_text(viewer.request_path(request_id), json.dumps(request), mode=0o600)
viewer.write_status_result(
    request_id,
    "status",
    "ok",
    {
        "protocol_version": viewer.PROTOCOL_VERSION,
        "supported": True,
        "service_available": True,
        "backend": {"name": "zathura", "available": True, "path": "/usr/bin/zathura"},
        "protocol_directories": {
            "base": str(tmp),
            "requests": str(viewer.path_requests()),
            "results": str(viewer.path_results()),
            "state": str(viewer.path_state()),
        },
        "diagnostics": {"log_tail": "", "recent_events": []},
        "service_instance_started_ns": int(time.time_ns()),
        "request_id": request_id,
        "operation": "status",
    },
)
print(json.dumps({
    "request_mode": oct((viewer.request_path(request_id).stat().st_mode) & 0o777),
    "result_mode": oct((viewer.result_path(request_id).stat().st_mode) & 0o777),
}))
`);
	const result = JSON.parse(output) as {
		request_mode: string;
		result_mode: string;
	};

	assert.equal(result.request_mode, "0o600");
	assert.equal(result.result_mode, "0o600");
});

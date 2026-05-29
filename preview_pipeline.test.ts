import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runPython(script: string): string {
	const result = spawnSync("python3", ["-c", script], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("show_latex writes operation-scoped ready descriptors with matching SyncTeX commands", () => {
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

test("show_latex can suppress ready descriptor while still producing PDFs", () => {
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

test("MCP show_latex accepts write_ready false and returns PDF details", () => {
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

test("viewer service open request returns structured open result and tracks reusable sessions", () => {
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
zathura = dir / viewer.BACKEND_NAME
zathura.write_text("#!/bin/sh\nwhile true; do sleep 0.1; done\n")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{dir}:{os.environ.get('PATH', '')}"
pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\\n")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}
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

tracked = viewer.OPEN_SESSIONS.get(str(pdf), {})
pid = tracked.get("pid")
if pid is not None:
    try:
        os.kill(int(pid), signal.SIGKILL)
    except OSError:
        pass
print(json.dumps({
    "processed_first": processed_first,
    "processed_second": processed_second,
    "first_status": first["status"],
    "second_status": second["status"],
    "first_reused": first["status_details"].get("reused", False),
    "second_reused": second["status_details"].get("reused", False),
    "same_handle": first["status_details"].get("handle") == second["status_details"].get("handle"),
    "tracker_has_path": str(pdf) in viewer.OPEN_SESSIONS,
    "tracker_handle": tracked.get("handle"),
}))
`);
	const result = JSON.parse(output) as {
		processed_first: number;
		processed_second: number;
		first_status: string;
		second_status: string;
		first_reused: boolean;
		second_reused: boolean;
		same_handle: boolean;
		tracker_has_path: boolean;
		tracker_handle: string;
	};

	assert.equal(result.processed_first, 1);
	assert.equal(result.processed_second, 1);
	assert.equal(result.first_status, "ok");
	assert.equal(result.second_status, "ok");
	assert.equal(result.first_reused, false);
	assert.equal(result.second_reused, true);
	assert.equal(result.same_handle, true);
	assert.equal(result.tracker_has_path, true);
	assert.ok(result.tracker_handle.length > 0);
});

test("viewer service open request can skip reuse when reuse_existing=false", () => {
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

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-open-no-reuse-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.BACKEND_NAME = "fakezathura"
viewer.ensure_protocol_dirs()

dir = tmp / "bin"
dir.mkdir()
zathura = dir / viewer.BACKEND_NAME
zathura.write_text("#!/bin/sh\nwhile true; do sleep 0.1; done\n")
os.chmod(zathura, 0o700)
os.environ["PATH"] = f"{dir}:{os.environ.get('PATH', '')}"
pdf = Path(tempfile.mkstemp(prefix="doc-", suffix=".pdf", dir=str(tmp))[1])
pdf.write_bytes(b"%PDF-1.7\\n")
callback = {
    "kind": viewer.SYNCTEX_CALLBACK_KIND,
    "transport": viewer.SYNCTEX_CALLBACK_TRANSPORT,
    "socket_path": "/tmp/synctex.sock",
    "token": "abc123",
}
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
}))
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
	};

	assert.equal(result.processed_first, 1);
	assert.equal(result.processed_second, 1);
	assert.equal(result.first_status, "ok");
	assert.equal(result.second_status, "ok");
	assert.equal(result.first_reused, false);
	assert.equal(result.second_reused, false);
	assert.equal(result.first_handle === result.second_handle, false);
	assert.equal(result.tracker_has_path, true);
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

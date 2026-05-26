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

test("viewer opens interleaved ready operations with their own PDF and SyncTeX command", () => {
	const output = runPython(String.raw`
import json
import tempfile
import time
import types
from pathlib import Path

script = Path("scripts/show_latex_viewer.py")
viewer = types.ModuleType("show_latex_viewer")
viewer.__file__ = str(script)
exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"), viewer.__dict__)

tmp = Path(tempfile.mkdtemp(prefix="preview-viewer-test-"))
viewer.DEFAULT_TMPDIR = str(tmp)
viewer.find_viewer = lambda: "/usr/bin/zathura"
viewer.gui_env = lambda: {}
viewer.zathura_already_open = lambda pdf, synctex_command=None: False
opened = []

class FakeProc:
    pid = 987654
    def poll(self):
        return 0

def fake_popen(cmd, **kwargs):
    opened.append(cmd)
    return FakeProc()

viewer.subprocess.Popen = fake_popen

def write_operation(name, command):
    pdf = tmp / "runs" / name / viewer.PDF_NAME
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF-1.4\n")
    descriptor = {
        "version": 1,
        "operation_id": name,
        "timestamp_ns": time.time_ns(),
        "pdf": str(pdf.relative_to(tmp)),
        "synctex_editor_command": command,
    }
    viewer.ready_path().write_text(json.dumps(descriptor), encoding="utf-8")
    return viewer.read_ready_operation()

first = write_operation("op-a", "cmd-A")
second = write_operation("op-b", "cmd-B")
viewer.open_pdf_if_needed(None, first.pdf, first.synctex_command)
viewer.open_pdf_if_needed(None, second.pdf, second.synctex_command)
print(json.dumps(opened))
`);
	const opened = JSON.parse(output) as string[][];

	assert.equal(opened.length, 2);
	assert.deepEqual(opened[0].slice(0, 2), ["/usr/bin/zathura", "--synctex-editor-command=cmd-A"]);
	assert.deepEqual(opened[1].slice(0, 2), ["/usr/bin/zathura", "--synctex-editor-command=cmd-B"]);
	assert.match(opened[0][2], /\/runs\/op-a\/show-latex\.pdf$/);
	assert.match(opened[1][2], /\/runs\/op-b\/show-latex\.pdf$/);
});

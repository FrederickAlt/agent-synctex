#!/usr/bin/env python3
"""Dependency-free stdio MCP server for LaTeX previews.

Security model:
- This process compiles LaTeX into operation-scoped files under /tmp/codex-show-latex.
- It never launches a GUI application.
- A separate desktop-session helper watches show-latex.ready and opens the descriptor PDF.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

# Keep generated preview/log files private to the user.
os.umask(0o077)
from typing import Any, Dict, Iterable, Optional, Tuple

SERVER_NAME = "codex-show-latex-secure-split"
SERVER_VERSION = "2.1.0"
PROTOCOL_VERSION = "2025-06-18"

DEFAULT_TMPDIR = "/tmp/codex-show-latex"
TEX_NAME = "show-latex.tex"
PDF_NAME = "show-latex.pdf"
LOG_NAME = "show-latex.log"
SYNCTEX_NAME = "show-latex.synctex"
SYNCTEX_GZ_NAME = "show-latex.synctex.gz"
READY_NAME = "show-latex.ready"
MCP_DEBUG_NAME = "mcp-debug.log"
RUNS_DIR_NAME = "runs"

MAX_RETURN_CHARS = 3000
DEFAULT_TIMEOUT_SEC = 45
DEFAULT_COMPILER = "lualatex"
SUPPORTED_COMPILERS = ("lualatex", "pdflatex", "xelatex", "latexmk")

Json = Dict[str, Any]


def tmpdir() -> Path:
    # Fixed path by design: the desktop helper also watches this exact path.
    return Path(DEFAULT_TMPDIR)


def path_tex() -> Path:
    return tmpdir() / TEX_NAME


def path_pdf() -> Path:
    return tmpdir() / PDF_NAME


def path_log() -> Path:
    return tmpdir() / LOG_NAME


def path_synctex() -> Path:
    return tmpdir() / SYNCTEX_NAME


def path_synctex_gz() -> Path:
    return tmpdir() / SYNCTEX_GZ_NAME


def path_ready() -> Path:
    return tmpdir() / READY_NAME


def path_debug() -> Path:
    return tmpdir() / MCP_DEBUG_NAME


def path_runs() -> Path:
    return tmpdir() / RUNS_DIR_NAME


def operation_id() -> str:
    return f"{time.time_ns()}-{os.getpid()}"


def ready_descriptor_pdf_path() -> Optional[Path]:
    try:
        data = json.loads(path_ready().read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    pdf = data.get("pdf")
    if not isinstance(pdf, str) or not pdf:
        return None
    path = Path(pdf)
    return path if path.is_absolute() else tmpdir() / path


def ensure_secure_tmpdir(create: bool = True) -> Path:
    d = tmpdir()
    if d.exists() or d.is_symlink():
        try:
            st_l = os.lstat(d)
        except FileNotFoundError:
            st_l = None
        if st_l is not None:
            if stat.S_ISLNK(st_l.st_mode):
                raise RuntimeError(f"refusing symlink temp directory: {d}")
            if not stat.S_ISDIR(st_l.st_mode):
                raise RuntimeError(f"temp path exists but is not a directory: {d}")
            if st_l.st_uid != os.geteuid():
                raise RuntimeError(f"temp directory is not owned by uid {os.geteuid()}: {d}")
            if (st_l.st_mode & 0o077) != 0:
                os.chmod(d, 0o700)
    else:
        if not create:
            raise RuntimeError(f"temp directory does not exist: {d}")
        d.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    return d


def debug(message: str) -> None:
    try:
        ensure_secure_tmpdir(create=True)
        ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with path_debug().open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {message}\n")
    except Exception:
        pass


def atomic_write_text(path: Path, text: str, mode: int = 0o600) -> None:
    d = path.parent
    tmp = d / f".{path.name}.tmp.{os.getpid()}.{time.monotonic_ns()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass


def atomic_copy_file(source: Path, destination: Path, mode: int = 0o600) -> None:
    tmp = destination.parent / f".{destination.name}.tmp.{os.getpid()}.{time.monotonic_ns()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with source.open("rb") as src, os.fdopen(fd, "wb") as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(tmp, destination)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass


def safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def normalize_compiler(compiler: Optional[str]) -> str:
    if compiler is None or not compiler.strip():
        return DEFAULT_COMPILER
    compiler = compiler.strip().lower()
    if compiler not in SUPPORTED_COMPILERS:
        raise RuntimeError(
            f"unsupported compiler: {compiler}; expected one of: {', '.join(SUPPORTED_COMPILERS)}"
        )
    return compiler


def choose_compiler(compiler: Optional[str] = None) -> Tuple[str, list[str]]:
    requested = normalize_compiler(compiler)
    if requested == "latexmk":
        if not shutil.which("latexmk"):
            raise RuntimeError("requested compiler 'latexmk' is not available on PATH")
        if not shutil.which(DEFAULT_COMPILER):
            raise RuntimeError("requested compiler 'latexmk' requires lualatex on PATH")
        return "latexmk(lualatex)", [
            "latexmk", "-pdf", "-lualatex", "-synctex=1", "-interaction=nonstopmode",
            "-halt-on-error", "-file-line-error", "-pdflualatex=lualatex -no-shell-escape %O %S", TEX_NAME,
        ]

    if not shutil.which(requested):
        raise RuntimeError(f"requested compiler '{requested}' is not available on PATH")
    return requested, [
        requested, "-synctex=1", "-interaction=nonstopmode",
        "-halt-on-error", "-file-line-error", "-no-shell-escape", TEX_NAME,
    ]


def tail_text(text: str, limit: int = MAX_RETURN_CHARS) -> str:
    if len(text) <= limit:
        return text
    return "...\n" + text[-limit:]


def read_tail(path: Path, limit: int = MAX_RETURN_CHARS) -> str:
    try:
        data = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""
    return tail_text(data, limit)


def compiler_error_message(reason: str, compiler_output: str, log_path: Optional[Path] = None) -> str:
    reason = reason.strip()
    log_tail = read_tail(log_path or path_log()).strip()
    if log_tail:
        return reason + "\n\nlog tail:\n" + log_tail
    output_tail = tail_text(compiler_output.strip())
    if output_tail:
        return reason + "\n\ncompiler output:\n" + output_tail
    return reason


def is_regular_file_owned_by_user(path: Path) -> bool:
    try:
        st_l = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(st_l.st_mode):
        return False
    if not stat.S_ISREG(st_l.st_mode):
        return False
    if st_l.st_uid != os.geteuid():
        return False
    return st_l.st_size > 0


def normalize_latex_source(latex_source: str) -> str:
    if "\\documentclass" in latex_source:
        return latex_source
    return "\n".join([
        r"\documentclass{article}",
        r"\usepackage[utf8]{inputenc}",
        r"\usepackage[T1]{fontenc}",
        r"\usepackage{amsmath,amssymb,mathtools}",
        r"\usepackage{xcolor}",
        r"\pagestyle{empty}",
        r"\begin{document}",
        latex_source,
        r"\end{document}",
        "",
    ])


def compile_latex(
    latex_source: str,
    compiler: Optional[str] = None,
    synctex_editor_command: Optional[str] = None,
    write_ready: bool = True,
    write_fixed: bool = True,
) -> Path:
    d = ensure_secure_tmpdir(create=True)
    if write_ready:
        safe_unlink(path_ready())

    run_id = operation_id()
    run_dir = path_runs() / run_id
    run_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(run_dir, 0o700)
    tex_path = run_dir / TEX_NAME
    pdf_path = run_dir / PDF_NAME
    log_path = run_dir / LOG_NAME
    atomic_write_text(tex_path, normalize_latex_source(latex_source))

    compiler_name, cmd = choose_compiler(compiler)
    timeout_sec = DEFAULT_TIMEOUT_SEC
    debug(f"compile start id={run_id} compiler={compiler_name} timeout={timeout_sec}s cwd={run_dir}")

    env = os.environ.copy()
    env.setdefault("HOME", str(Path.home()))
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")

    try:
        proc = subprocess.run(
            cmd, cwd=str(run_dir), env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=timeout_sec, check=False,
        )
    except subprocess.TimeoutExpired as e:
        output = e.stdout if isinstance(e.stdout, str) else ""
        raise RuntimeError(compiler_error_message(f"compiler timed out after {timeout_sec}s", output, log_path))

    output = proc.stdout or ""
    if proc.returncode != 0:
        debug(f"compile failed id={run_id} returncode={proc.returncode}")
        raise RuntimeError(compiler_error_message(f"compiler exited nonzero: {proc.returncode}", output, log_path))

    if not is_regular_file_owned_by_user(pdf_path):
        debug(f"compile command succeeded but pdf missing/invalid id={run_id}")
        raise RuntimeError(compiler_error_message(f"PDF was not created at {pdf_path}", output, log_path))

    if write_fixed:
        # Keep a fixed-path copy for older viewer helpers and for the Pi extension's
        # single-window "current preview" fallback.  Inline previews disable this
        # so existing Zathura windows do not auto-reload another agent's compile.
        atomic_copy_file(pdf_path, path_pdf())
        atomic_copy_file(tex_path, path_tex())
        fixed_log_path = path_log()
        if log_path.exists():
            atomic_copy_file(log_path, fixed_log_path)
        else:
            safe_unlink(fixed_log_path)
        for run_synctex, fixed_synctex in [
            (run_dir / SYNCTEX_NAME, path_synctex()),
            (run_dir / SYNCTEX_GZ_NAME, path_synctex_gz()),
        ]:
            if run_synctex.exists():
                atomic_copy_file(run_synctex, fixed_synctex)
            else:
                safe_unlink(fixed_synctex)

    descriptor = {
        "version": 1,
        "operation_id": run_id,
        "timestamp_ns": time.time_ns(),
        "pdf": str(pdf_path.relative_to(d)),
        "synctex_editor_command": synctex_editor_command or "",
    }
    if write_ready:
        atomic_write_text(path_ready(), json.dumps(descriptor, separators=(",", ":")) + "\n", mode=0o600)
        debug(f"compile ok id={run_id}; ready marker updated")
    else:
        debug(f"compile ok id={run_id}; ready marker suppressed")
    return pdf_path


def status_text() -> str:
    current_pdf = ready_descriptor_pdf_path() or path_pdf()
    lines = [f"tmpdir={tmpdir()}"]
    for name, path in [
        ("pdf", current_pdf),
        ("ready", path_ready()),
        ("tex", path_tex()),
        ("fixed_pdf", path_pdf()),
        ("log", path_log()),
        ("mcp_debug", path_debug()),
    ]:
        try:
            st = os.lstat(path)
            kind = "symlink" if stat.S_ISLNK(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
            lines.append(f"{name}={path} exists kind={kind} size={st.st_size} mtime={int(st.st_mtime)}")
        except FileNotFoundError:
            lines.append(f"{name}={path} missing")
    lines.append(f"default_compiler={DEFAULT_COMPILER}")
    for compiler in SUPPORTED_COMPILERS:
        lines.append(f"{compiler}={shutil.which(compiler) or 'missing'}")
    return "\n".join(lines)


def tool_schema() -> list[Json]:
    return [
        {
            "name": "show_latex",
            "description": (
                "Compile LaTeX source to an operation-scoped PDF under /tmp/codex-show-latex. "
                "It uses the active preamble from /tmp/codex-show-latex/preamble.tex, which is initialized from "
                "any existing ./preamble.tex or ./praeamble.tex in the working directory, so fragments should not "
                "repeat those definitions. Returns only 'ok' on success. A separate desktop helper opens the ready "
                "descriptor PDF."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "latex_source": {"type": "string", "description": "LaTeX source. Full documents compile as-is; fragments are wrapped automatically. The active preamble from /tmp/codex-show-latex/preamble.tex is applied automatically."},
                    "compiler": {"type": "string", "enum": list(SUPPORTED_COMPILERS), "default": DEFAULT_COMPILER, "description": "Optional LaTeX compiler to use. Defaults to lualatex."},
                    "synctex_editor_command": {"type": "string", "description": "Session-specific Zathura inverse SyncTeX callback command for this preview operation."},
                    "write_ready": {"type": "boolean", "default": True, "description": "Whether to write the ready descriptor consumed by external preview helpers."},
                    "write_fixed": {"type": "boolean", "default": True, "description": "Whether to refresh fixed-path compatibility preview files."}
                },
                "required": ["latex_source"],
                "additionalProperties": False,
            },
        },
        {
            "name": "show_latex_status",
            "description": "Show concise diagnostic information for the LaTeX preview files. No arguments.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    ]


def result_text(text: str, is_error: bool = False, details: Optional[Json] = None) -> Json:
    result: Json = {"content": [{"type": "text", "text": text}], "isError": bool(is_error)}
    if details is not None:
        result["details"] = details
    return result


def validate_no_extra(args: Json, allowed: Iterable[str]) -> None:
    extras = sorted(k for k in args.keys() if k not in set(allowed))
    if extras:
        raise RuntimeError("unsupported parameter(s): " + ", ".join(extras))


def call_tool(name: str, arguments: Any) -> Json:
    args = arguments if isinstance(arguments, dict) else {}
    if name == "show_latex":
        validate_no_extra(args, ["latex_source", "compiler", "synctex_editor_command", "write_ready", "write_fixed"])
        latex_source = args.get("latex_source")
        if not isinstance(latex_source, str) or not latex_source.strip():
            raise RuntimeError("show_latex requires a non-empty string parameter: latex_source")
        compiler = args.get("compiler")
        if compiler is not None and not isinstance(compiler, str):
            raise RuntimeError("show_latex compiler must be a string when provided")
        synctex_editor_command = args.get("synctex_editor_command")
        if synctex_editor_command is not None and not isinstance(synctex_editor_command, str):
            raise RuntimeError("show_latex synctex_editor_command must be a string when provided")
        write_ready = args.get("write_ready", True)
        if not isinstance(write_ready, bool):
            raise RuntimeError("show_latex write_ready must be a boolean when provided")
        write_fixed = args.get("write_fixed", True)
        if not isinstance(write_fixed, bool):
            raise RuntimeError("show_latex write_fixed must be a boolean when provided")
        pdf_path = compile_latex(latex_source, compiler, synctex_editor_command, write_ready=write_ready, write_fixed=write_fixed)
        return result_text("ok", is_error=False, details={"pdf": str(pdf_path)})
    if name == "show_latex_status":
        validate_no_extra(args, [])
        return result_text(status_text(), is_error=False)
    raise RuntimeError(f"unknown tool: {name}")


def send(obj: Json) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def respond_ok(req_id: Any, result: Json) -> None:
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def respond_error(req_id: Any, code: int, message: str) -> None:
    send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def handle_request(msg: Json) -> None:
    method = msg.get("method")
    req_id = msg.get("id")
    if req_id is None:
        return
    try:
        if method == "initialize":
            respond_ok(req_id, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            })
        elif method == "tools/list":
            respond_ok(req_id, {"tools": tool_schema()})
        elif method == "tools/call":
            params = msg.get("params") or {}
            if not isinstance(params, dict):
                raise RuntimeError("tools/call params must be an object")
            name = params.get("name")
            if not isinstance(name, str):
                raise RuntimeError("tools/call requires string params.name")
            respond_ok(req_id, call_tool(name, params.get("arguments") or {}))
        elif method == "ping":
            respond_ok(req_id, {})
        else:
            respond_error(req_id, -32601, f"method not found: {method}")
    except Exception as e:
        debug(f"request error method={method}: {e}")
        if method == "tools/call":
            respond_ok(req_id, result_text(str(e), is_error=True))
        else:
            respond_error(req_id, -32603, str(e))


def serve_stdio() -> None:
    debug("mcp server start")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if isinstance(msg, dict):
                handle_request(msg)
            else:
                respond_error(None, -32600, "invalid JSON-RPC message")
        except Exception as e:
            debug(f"invalid request: {e}")
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(e)}})


def self_test() -> int:
    src = r"""\documentclass{article}
\begin{document}
Hello from codex-show-latex-secure.
\end{document}
"""
    try:
        print(compile_latex(src))
        return 0
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1


def protocol_smoke_test() -> int:
    print(json.dumps({"tools": [t["name"] for t in tool_schema()]}))
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--protocol-smoke-test" in argv:
        return protocol_smoke_test()
    serve_stdio()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

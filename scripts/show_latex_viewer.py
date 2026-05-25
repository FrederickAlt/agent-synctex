#!/usr/bin/env python3
"""Desktop-session helper for codex-show-latex-secure-split.

Runs outside the Codex sandbox, normally as a systemd --user service.
Watches the fixed ready marker and opens the ready descriptor's PDF path in Zathura.
The descriptor atomically pairs each preview PDF with that operation's optional
session callback command under the private fixed temp directory.
"""

from __future__ import annotations

import glob
import json
import os
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import NamedTuple, Optional

# Keep generated preview/log files private to the user.
os.umask(0o077)

DEFAULT_TMPDIR = "/tmp/codex-show-latex"
PDF_NAME = "show-latex.pdf"
READY_NAME = "show-latex.ready"
ZATHURA_LOG_NAME = "zathura.log"
DEFAULT_POLL_SEC = 0.5
MIN_REOPEN_INTERVAL_SEC = 1.0


def tmpdir() -> Path:
    # Fixed path by design: this helper never accepts arbitrary paths.
    return Path(DEFAULT_TMPDIR)


def pdf_path() -> Path:
    return tmpdir() / PDF_NAME


def ready_path() -> Path:
    return tmpdir() / READY_NAME


def log_path() -> Path:
    return tmpdir() / ZATHURA_LOG_NAME


class ReadyOperation(NamedTuple):
    signature: tuple[int, int]
    pdf: Path
    synctex_command: Optional[str]


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


def log(message: str) -> None:
    try:
        ensure_secure_tmpdir(create=True)
        ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with log_path().open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] helper: {message}\n")
    except Exception:
        pass


def pdf_from_ready_value(value: object) -> Optional[Path]:
    if not isinstance(value, str) or not value:
        return None
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = tmpdir() / candidate
    try:
        root = tmpdir().resolve(strict=True)
        parent = candidate.parent.resolve(strict=True)
    except Exception as e:
        log(f"ignoring ready pdf path with unsafe parent {candidate}: {e}")
        return None
    if parent != root and root not in parent.parents:
        log(f"ignoring ready pdf path outside preview tmpdir: {candidate}")
        return None
    return candidate


def read_ready_operation() -> Optional[ReadyOperation]:
    path = ready_path()
    try:
        st_l = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(st_l.st_mode) or not stat.S_ISREG(st_l.st_mode):
        log(f"ignoring unsafe ready marker: {path}")
        return None
    if st_l.st_uid != os.geteuid():
        log(f"ignoring ready marker not owned by uid {os.geteuid()}: {path}")
        return None

    signature = (st_l.st_mtime_ns, st_l.st_size)
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:
        log(f"failed to read ready marker: {e}")
        return None

    pdf = pdf_path()
    synctex_command: Optional[str] = None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = None
    if isinstance(data, dict):
        descriptor_pdf = pdf_from_ready_value(data.get("pdf"))
        if descriptor_pdf is None:
            log("ignoring ready marker without a valid operation PDF")
            return None
        pdf = descriptor_pdf
        command = data.get("synctex_editor_command")
        if isinstance(command, str) and command:
            synctex_command = command
    return ReadyOperation(signature, pdf, synctex_command)


def marker_signature() -> tuple[int, int] | None:
    operation = read_ready_operation()
    return operation.signature if operation is not None else None


def regular_pdf_is_safe_enough(path: Path) -> bool:
    try:
        st_l = os.lstat(path)
    except FileNotFoundError:
        log(f"pdf missing: {path}")
        return False
    if stat.S_ISLNK(st_l.st_mode):
        log(f"refusing symlink pdf path: {path}")
        return False
    if not stat.S_ISREG(st_l.st_mode):
        log(f"refusing non-regular pdf path: {path}")
        return False
    if st_l.st_uid != os.geteuid():
        log(f"refusing pdf not owned by uid {os.geteuid()}: {path}")
        return False
    if st_l.st_size <= 0:
        log(f"refusing empty pdf: {path}")
        return False
    return True


def detect_xauthority(uid: int) -> Optional[str]:
    candidates = []
    env_xauth = os.environ.get("XAUTHORITY")
    if env_xauth:
        candidates.append(env_xauth)
    candidates.extend(glob.glob(f"/run/user/{uid}/.mutter-Xwaylandauth.*"))
    candidates.append(str(Path.home() / ".Xauthority"))
    for c in candidates:
        try:
            st = os.stat(c)
        except FileNotFoundError:
            continue
        if stat.S_ISREG(st.st_mode) and st.st_uid == uid:
            return c
    return None


def detect_wayland_display(runtime_dir: str) -> Optional[str]:
    env_val = os.environ.get("WAYLAND_DISPLAY")
    if env_val and Path(runtime_dir, env_val).exists():
        return env_val
    for name in ("wayland-0", "wayland-1"):
        if Path(runtime_dir, name).exists():
            return name
    return env_val


def gui_env() -> dict[str, str]:
    uid = os.geteuid()
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}"
    env = os.environ.copy()
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.setdefault("HOME", str(Path.home()))
    env["XDG_RUNTIME_DIR"] = runtime_dir

    wayland = detect_wayland_display(runtime_dir)
    if wayland:
        env["WAYLAND_DISPLAY"] = wayland

    if "DBUS_SESSION_BUS_ADDRESS" not in env:
        bus = Path(runtime_dir) / "bus"
        if bus.exists():
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"

    env.setdefault("DISPLAY", ":0")
    env.setdefault("XDG_SESSION_TYPE", "wayland")

    xauth = detect_xauthority(uid)
    if xauth:
        env["XAUTHORITY"] = xauth

    return env


def process_has_zathura_pdf(pid: int, pdf: Path, synctex_command: Optional[str] = None) -> bool:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except Exception:
        return False
    if not raw:
        return False
    args = [a.decode("utf-8", errors="replace") for a in raw.split(b"\0") if a]
    if not args:
        return False
    exe = Path(args[0]).name
    if "zathura" not in exe:
        return False
    wanted = str(pdf)
    if not any(arg == wanted for arg in args[1:]):
        return False
    if synctex_command is None:
        return True
    return any(arg == f"--synctex-editor-command={synctex_command}" for arg in args[1:])


def zathura_already_open(pdf: Path, synctex_command: Optional[str] = None) -> bool:
    for child in Path("/proc").iterdir():
        if not child.name.isdigit():
            continue
        try:
            pid = int(child.name)
        except ValueError:
            continue
        if process_has_zathura_pdf(pid, pdf, synctex_command):
            return True
    return False


def find_viewer() -> str:
    # Fixed viewer command. No environment-controlled arbitrary command.
    fixed = Path("/usr/bin/zathura")
    if fixed.exists() and os.access(fixed, os.X_OK):
        return str(fixed)
    for part in os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin").split(":"):
        candidate = Path(part) / "zathura"
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return "zathura"


def open_pdf_if_needed(
    last_proc: Optional[subprocess.Popen],
    pdf: Path,
    synctex_command: Optional[str],
) -> Optional[subprocess.Popen]:
    if not regular_pdf_is_safe_enough(pdf):
        return last_proc

    if last_proc is not None and last_proc.poll() is None:
        if process_has_zathura_pdf(last_proc.pid, pdf, synctex_command):
            log("zathura already tracked with current SyncTeX command; relying on auto-reload")
            return last_proc
        log("tracked zathura lacks current SyncTeX command; launching configured viewer")

    if zathura_already_open(pdf, synctex_command):
        log("zathura already open for ready pdf with current SyncTeX command; relying on auto-reload")
        return None

    env = gui_env()
    viewer = find_viewer()
    cmd = [viewer]
    if synctex_command:
        cmd.append(f"--synctex-editor-command={synctex_command}")
    cmd.append(str(pdf))
    log(
        "launching "
        + " ".join(cmd)
        + f" DISPLAY={env.get('DISPLAY','')} WAYLAND_DISPLAY={env.get('WAYLAND_DISPLAY','')}"
    )
    ensure_secure_tmpdir(create=True)
    with log_path().open("ab") as lf:
        proc = subprocess.Popen(
            cmd,
            cwd=str(tmpdir()),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=lf,
            stderr=lf,
            close_fds=True,
            start_new_session=True,
        )
    return proc


def run_check() -> int:
    ensure_secure_tmpdir(create=True)
    operation = read_ready_operation()
    pdf = operation.pdf if operation is not None else pdf_path()
    ok = regular_pdf_is_safe_enough(pdf)
    print("ok" if ok else "not-ready")
    return 0 if ok else 1


def status_text() -> str:
    ensure_secure_tmpdir(create=True)
    operation = read_ready_operation()
    pdf = operation.pdf if operation is not None else pdf_path()
    lines = [f"tmpdir={tmpdir()}"]
    for name, path in (("pdf", pdf), ("ready", ready_path()), ("fixed_pdf", pdf_path()), ("log", log_path())):
        try:
            st = os.lstat(path)
            kind = "symlink" if stat.S_ISLNK(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
            lines.append(f"{name}={path} exists kind={kind} size={st.st_size} mtime={int(st.st_mtime)}")
        except FileNotFoundError:
            lines.append(f"{name}={path} missing")
    lines.append(f"viewer={find_viewer()}")
    return "\n".join(lines)


def main() -> int:
    if "--check" in sys.argv:
        return run_check()
    if "--status" in sys.argv:
        print(status_text())
        return 0

    stop = False

    def handle_stop(signum: int, frame: object) -> None:
        nonlocal stop
        stop = True
        log(f"received signal {signum}; stopping")

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    poll_sec = DEFAULT_POLL_SEC

    ensure_secure_tmpdir(create=True)
    log("viewer helper started")
    initial_operation = read_ready_operation()
    last_sig = initial_operation.signature if initial_operation is not None else None
    last_open_at = 0.0
    last_proc: Optional[subprocess.Popen] = None

    while not stop:
        operation = read_ready_operation()
        if operation is not None and operation.signature != last_sig:
            last_sig = operation.signature
            now = time.monotonic()
            if now - last_open_at >= MIN_REOPEN_INTERVAL_SEC:
                try:
                    last_proc = open_pdf_if_needed(last_proc, operation.pdf, operation.synctex_command)
                    last_open_at = now
                except Exception as e:
                    log(f"open failed: {e}")
            else:
                log("rate-limited viewer open request")
        time.sleep(poll_sec)

    log("viewer helper stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

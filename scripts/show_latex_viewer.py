#!/usr/bin/env python3
"""Desktop-session viewer service for codex-show-latex.

This helper exposes a filesystem protocol consumed by the Pi extension so that
file operations are validated, serialized, and sandbox-safe.

Clients create per-request files under:
  /tmp/codex-show-latex/viewer-requests/<id>.json
and poll matching result files under:
  /tmp/codex-show-latex/viewer-results/<id>.json

Supports status checks and viewer `open` requests.
"""

from __future__ import annotations

import errno
import json
import os
import signal
import stat
import sys
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

# Keep generated preview/service files private to the user.
os.umask(0o077)

OPEN_SESSIONS: Dict[str, Dict[str, Any]] = {}

DEFAULT_TMPDIR = "/tmp/codex-show-latex"
REQUESTS_NAME = "viewer-requests"
RESULTS_NAME = "viewer-results"
STATE_NAME = "viewer-state.json"
LOG_NAME = "viewer.log"
BACKEND_NAME = "zathura"

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 32 * 1024
REQUEST_TTL_SECONDS = 120
RESULT_TTL_SECONDS = 600
POLL_SECONDS = 0.25
MIN_BACKEND_REOPEN_SECONDS = 1.0
LOG_TAIL_LINES = 12
MAX_STATE_EVENTS = 20

SERVICE_STARTED_NS = time.time_ns()
SYNCTEX_CALLBACK_KIND = "pi-synctex-callback-v1"
SYNCTEX_CALLBACK_TRANSPORT = "unix"
OPEN_REQUEST_OPERATION = "open"
VIEWER_OPEN_CAPABILITIES = {
    "open": True,
    "close": True,
    "forward_search": True,
    "inverse_search": True,
    "reuse": True,
}


def tmpdir() -> Path:
	# Fixed path by design: this helper never accepts arbitrary paths.
	return Path(DEFAULT_TMPDIR)


def path_requests() -> Path:
	return tmpdir() / REQUESTS_NAME


def path_results() -> Path:
	return tmpdir() / RESULTS_NAME


def path_state() -> Path:
	return tmpdir() / STATE_NAME


def path_log() -> Path:
	return tmpdir() / LOG_NAME


def service_dirs() -> list[Path]:
	return [tmpdir(), path_requests(), path_results()]


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


def ensure_protocol_dir(path: Path) -> None:
	if path.exists() or path.is_symlink():
		try:
			st_l = os.lstat(path)
		except FileNotFoundError:
			st_l = None
		if st_l is not None:
			if stat.S_ISLNK(st_l.st_mode):
				raise RuntimeError(f"refusing symlink path: {path}")
			if not stat.S_ISDIR(st_l.st_mode):
				raise RuntimeError(f"protocol path exists but is not a directory: {path}")
			if st_l.st_uid != os.geteuid():
				raise RuntimeError(f"protocol path is not owned by uid {os.geteuid()}: {path}")
			if (st_l.st_mode & 0o077) != 0:
				os.chmod(path, 0o700)
			return

	path.mkdir(parents=True, mode=0o700, exist_ok=True)
	os.chmod(path, 0o700)


def ensure_protocol_dirs() -> None:
	for dir_path in service_dirs():
		ensure_protocol_dir(dir_path)


def log(message: str) -> None:
	try:
		ensure_protocol_dirs()
		ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
		with path_log().open("a", encoding="utf-8") as f:
			f.write(f"[{ts}] viewer-service: {message}\n")
	except Exception:
		pass


def atomic_write_text(path: Path, text: str, mode: int = 0o600) -> None:
	tmp = path.parent / f".{path.name}.tmp.{os.getpid()}.{time.monotonic_ns()}"
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


def safe_unlink(path: Path) -> None:
	try:
		path.unlink()
	except FileNotFoundError:
		pass


def is_regular_file(path: Path) -> bool:
	try:
		st_l = os.lstat(path)
	except FileNotFoundError:
		return False
	if stat.S_ISLNK(st_l.st_mode):
		return False
	return stat.S_ISREG(st_l.st_mode)


def read_text_file(path: Path, max_bytes: int) -> str:
	if not is_regular_file(path):
		raise ValueError("not a regular file")
	st = path.stat()
	if st.st_size > max_bytes:
		raise ValueError("request exceeds size limit")
	return path.read_text(encoding="utf-8")


def open_pdf_file_and_validate(path: Path) -> tuple[str | None, str | None, int | None]:
	# Best-effort TOCTOU hardening: O_NOFOLLOW is used when available, but older
	# runtimes without it still perform fd-based validation without symlink denial.
	flags = os.O_RDONLY
	if hasattr(os, "O_NOFOLLOW"):
		flags |= os.O_NOFOLLOW
	try:
		pdf_fd = os.open(path, flags)
	except OSError as exc:
		if exc.errno == getattr(errno, "ELOOP", 0):
			return ("pdf_path must not be a symlink", None, None)
		return (f"cannot open pdf_path: {path}", None, None)

	try:
		st = os.fstat(pdf_fd)
		if not stat.S_ISREG(st.st_mode):
			os.close(pdf_fd)
			return (f"pdf_path must be a regular file: {path}", None, None)
		if st.st_uid != os.geteuid():
			os.close(pdf_fd)
			return (f"pdf_path is not owned by current user: {path}", None, None)
		header = os.pread(pdf_fd, 5, 0) if hasattr(os, "pread") else _read_from_fd(pdf_fd)
		if header != b"%PDF-":
			os.close(pdf_fd)
			return (f"pdf_path is not a PDF file: {path}", None, None)
		return (None, str(path.resolve()), pdf_fd)
	except Exception as exc:
		try:
			os.close(pdf_fd)
		except Exception:
			pass
		return (str(exc), None, None)


def _read_from_fd(file_descriptor: int) -> bytes:
	os.lseek(file_descriptor, 0, os.SEEK_SET)
	return os.read(file_descriptor, 5)


def find_synctex_callback_script() -> Path:
	candidates = [
		Path(__file__).resolve().parent / "pi_synctex_callback.mjs",
		Path(__file__).resolve().parent.parent / "scripts" / "pi_synctex_callback.mjs",
	]
	for candidate in candidates:
		if candidate.is_file() and os.access(candidate, os.X_OK):
			return candidate
		if candidate.is_file() and os.access(candidate, os.R_OK):
			return candidate
	raise RuntimeError("missing trusted pi_synctex_callback.mjs helper")


def build_synctex_callback_command(config: Dict[str, Any]) -> str:
	node_path = shutil.which("node") or "node"
	command = [
		node_path,
		str(find_synctex_callback_script()),
		"--socket",
		str(config["socket_path"]),
		"--token",
		str(config["token"]),
		"--file",
		"%{input}",
		"--line",
		"%{line}",
	]
	return " ".join(shlex.quote(part) for part in command)


def request_path(request_id: str) -> Path:
	return path_requests() / f"{request_id}.json"


def result_path(request_id: str) -> Path:
	return path_results() / f"{request_id}.json"


def is_request_id_valid(request_id: str) -> bool:
	if not isinstance(request_id, str):
		return False
	if not request_id or len(request_id) > 128:
		return False
	for char in request_id:
		if char.isalnum() or char in "._-":
			continue
		return False
	return True


def validate_callback_config(config: Dict[str, Any]) -> Optional[str]:
	if not isinstance(config, dict):
		return "callback must be an object"
	if config.get("kind") != SYNCTEX_CALLBACK_KIND:
		return "callback kind must be pi-synctex-callback-v1"
	if config.get("transport") != SYNCTEX_CALLBACK_TRANSPORT:
		return "callback transport must be unix"
	socket_path = config.get("socket_path")
	token = config.get("token")
	if not isinstance(socket_path, str) or not socket_path:
		return "callback socket_path must be a non-empty string"
	if not isinstance(token, str) or not token:
		return "callback token must be a non-empty string"
	return None


def validate_open_request_details(details: Dict[str, Any]) -> Optional[str]:
	pdf_path = details.get("pdf_path")
	if not isinstance(pdf_path, str) or not pdf_path:
		return "missing or invalid pdf_path"
	callback = details.get("callback")
	if not isinstance(callback, dict):
		return "missing or invalid callback"
	error = validate_callback_config(callback)
	if error:
		return error
	return None


def request_is_stale(created_at_ns: int, now_ns: int) -> bool:
	return now_ns - created_at_ns > REQUEST_TTL_SECONDS * 1_000_000_000


def parse_request(path: Path, now_ns: int) -> Optional[Dict[str, Any]]:
	if path.suffix != ".json":
		return None
	if not is_regular_file(path):
		log(f"ignoring unsafe request path: {path}")
		safe_unlink(path)
		return None

	try:
		payload_text = read_text_file(path, MAX_REQUEST_BYTES)
	except ValueError as exc:
		log(f"request rejected {path}: {exc}")
		safe_unlink(path)
		return None

	try:
		obj = json.loads(payload_text)
	except Exception:
		log(f"ignoring malformed request JSON: {path}")
		safe_unlink(path)
		return None

	if not isinstance(obj, dict):
		log(f"request not an object: {path}")
		safe_unlink(path)
		return None

	request_id = obj.get("request_id")
	if not is_request_id_valid(request_id):
		log(f"request has invalid id: {path}")
		safe_unlink(path)
		return None
	if path.name != f"{request_id}.json":
		log(f"request id mismatch for {path}: {request_id}")
		safe_unlink(path)
		return None

	protocol_version = obj.get("protocol_version")
	if protocol_version != PROTOCOL_VERSION:
		log(f"request protocol_version unsupported: {path}")
		safe_unlink(path)
		return None

	operation = obj.get("operation")
	if not isinstance(operation, str):
		log(f"request missing operation: {path}")
		safe_unlink(path)
		return None

	created_at_ns = obj.get("created_at_ns")
	if not isinstance(created_at_ns, int):
		created_at_ns = path.stat().st_mtime_ns
	if request_is_stale(created_at_ns, now_ns):
		log(f"ignoring stale request: {path}")
		safe_unlink(path)
		return None

	details = obj.get("details") if isinstance(obj.get("details"), dict) else {}
	return {
		"request_id": request_id,
		"protocol_version": protocol_version,
		"operation": operation,
		"created_at_ns": int(created_at_ns),
		"details": details,
	}


def find_viewer() -> str:
	fixed = Path(f"/usr/bin/{BACKEND_NAME}")
	if fixed.exists() and os.access(fixed, os.X_OK):
		return str(fixed)
	for part in os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin").split(":"):
		candidate = Path(part) / BACKEND_NAME
		if candidate.exists() and os.access(candidate, os.X_OK):
			return str(candidate)
	return BACKEND_NAME


def _pid_alive(pid: int) -> bool:
	if pid <= 0:
		return False
	try:
		os.kill(pid, 0)
	except ProcessLookupError:
		return False
	except PermissionError:
		return True
	except Exception:
		return False
	return True


def _find_viewer_pid_for_pdf(viewer_path: str, pdf_paths: list[str]) -> Optional[int]:
	if not pdf_paths:
		return None

	for entry in Path("/proc").iterdir():
		if not entry.name.isdigit():
			continue
		pid = int(entry.name)
		try:
			cmdline = entry.joinpath("cmdline").read_bytes().split(b"\0")
			parts = [part.decode("utf-8", errors="replace") for part in cmdline if part]
		except Exception:
			continue
		if not parts:
			continue
		if Path(parts[0]).name != Path(viewer_path).name:
			continue
		for path in pdf_paths:
			if path and any(part == path or part.endswith(path) for part in parts):
				return pid
	return None


def build_open_result_details(
	request_id: str,
	handle: Optional[str],
	owned: bool,
	reused: bool,
	pid: Optional[int],
	pid_diagnostic: Optional[str],
	error_code: Optional[str] = None,
) -> Dict[str, Any]:
	details = {
		"protocol_version": PROTOCOL_VERSION,
		"supported": True,
		"service_available": True,
		"backend": BACKEND_NAME,
		"capabilities": VIEWER_OPEN_CAPABILITIES,
		"owned": bool(owned),
		"reused": bool(reused),
		"protocol_directories": protocol_directories(),
		"service_instance_started_ns": SERVICE_STARTED_NS,
		"request_id": request_id,
		"operation": OPEN_REQUEST_OPERATION,
	}
	if handle:
		details["handle"] = handle
	if error_code is not None:
		details["error_code"] = error_code
	if pid is not None:
		details["pid"] = pid
	if pid_diagnostic:
		details["pid_diagnostic"] = pid_diagnostic
	return details


def open_pdf_with_viewer(request_id: str, details: Dict[str, Any], _state: Dict[str, Any]) -> Dict[str, Any]:
	error = validate_open_request_details(details)
	if error:
		return {
			"status": "error",
			"error": error,
			"status_details": build_open_result_details(
				request_id,
				None,
				False,
				False,
				None,
				None,
				"callback_invalid" if "callback" in error else "invalid_request",
			),
		}

	pdf_path_value = details["pdf_path"]
	pdf_error, normalized_pdf_path, pdf_fd = open_pdf_file_and_validate(Path(pdf_path_value))
	if pdf_error:
		return {
			"status": "error",
			"error": pdf_error,
			"status_details": build_open_result_details(
				request_id,
				None,
				False,
				False,
				None,
				None,
				"invalid_pdf",
			),
		}

	callback = details["callback"]
	reuse_existing = details.get("reuse_existing", True)
	if not isinstance(reuse_existing, bool):
		reuse_existing = True
	require_persistent_viewer = details.get("require_persistent_viewer", False)
	if not isinstance(require_persistent_viewer, bool):
		require_persistent_viewer = False

	viewer_path = find_viewer()
	backend_available = Path(viewer_path).exists() and os.access(viewer_path, os.X_OK)
	if not backend_available:
		os.close(pdf_fd)
		return {
			"status": "error",
			"error": "viewer backend is unavailable",
			"status_details": build_open_result_details(request_id, None, False, False, None, "backend unavailable", "backend_unavailable"),
		}

	reused = False
	handle = None
	session = OPEN_SESSIONS.get(normalized_pdf_path, {})
	if reuse_existing:
		handle = session.get("handle")
		if handle:
			if session.get("callback") != callback:
				handle = None
			else:
				current_pid = session.get("pid")
				if current_pid and _pid_alive(current_pid):
					reused = True
				else:
					OPEN_SESSIONS.pop(normalized_pdf_path, None)
					handle = None

	if reuse_existing and handle:
		os.close(pdf_fd)
		return {
			"status": "ok",
			"status_details": build_open_result_details(
				request_id,
				handle,
				True,
				reused,
				session.get("pid"),
				None,
			),
		}

	handle = f"{BACKEND_NAME}:{request_id}:{int(time.time_ns())}"
	callback_command = build_synctex_callback_command(callback)
	fd_argument = f"/proc/self/fd/{pdf_fd}"
	args = [viewer_path, "--fork", fd_argument, f"--synctex-editor-command={callback_command}"]
	process = None
	try:
		process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, pass_fds=(pdf_fd,))
	except Exception as exc:
		os.close(pdf_fd)
		return {
			"status": "error",
			"error": f"failed to launch viewer: {exc}",
			"status_details": build_open_result_details(request_id, handle, False, False, None, str(exc), "launch_failed"),
		}
	# Keep fd open until launcher inherits it, then close to avoid leak.
	os.close(pdf_fd)

	time.sleep(0.05)
	owned_pid = process.pid
	owned = _pid_alive(process.pid or -1)
	pid_diagnostic = None
	if not owned:
		owned_pid = _find_viewer_pid_for_pdf(viewer_path, [normalized_pdf_path, fd_argument])
		if owned_pid is None:
			owned = False
			if process.stderr is not None:
				pid_diagnostic = process.stderr.read().decode("utf-8", errors="replace").strip()
		else:
			owned = True

	OPEN_SESSIONS[normalized_pdf_path] = {
		"handle": handle,
		"pid": owned_pid,
		"backend": BACKEND_NAME,
		"callback": dict(callback),
	}

	if require_persistent_viewer and not owned:
		return {
			"status": "error",
			"error": "viewer did not produce a persistent viewer process",
			"status_details": build_open_result_details(
				request_id,
				handle,
				False,
				reused,
				owned_pid,
				pid_diagnostic,
				"launch_failed",
			),
		}

	return {
		"status": "ok",
		"status_details": build_open_result_details(
			request_id,
			handle,
			bool(owned_pid) and owned,
			reused,
			owned_pid,
			pid_diagnostic,
		),
	}


def protocol_directories() -> Dict[str, str]:
	return {
		"base": str(tmpdir()),
		"requests": str(path_requests()),
		"results": str(path_results()),
		"state": str(path_state()),
	}


def read_tail(path: Path, max_lines: int = LOG_TAIL_LINES) -> str:
	if not path.exists() or not is_regular_file(path):
		return ""
	try:
		lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
	except Exception:
		return ""
	return "\n".join(lines[-max_lines:])


def read_state() -> Dict[str, Any]:
	if not is_regular_file(path_state()):
		return {
			"protocol_version": PROTOCOL_VERSION,
			"protocol_directories": protocol_directories(),
			"events": [],
			"service_started_ns": SERVICE_STARTED_NS,
		}
	try:
		obj = json.loads(path_state().read_text(encoding="utf-8"))
	except Exception:
		return {
			"protocol_version": PROTOCOL_VERSION,
			"protocol_directories": protocol_directories(),
			"events": [],
			"service_started_ns": SERVICE_STARTED_NS,
		}
	if isinstance(obj, dict):
		return obj
	return {
		"protocol_version": PROTOCOL_VERSION,
		"protocol_directories": protocol_directories(),
		"events": [],
		"service_started_ns": SERVICE_STARTED_NS,
	}


def write_state(payload: Dict[str, Any]) -> None:
	atomic_write_text(path_state(), json.dumps(payload, separators=(",", ":")) + "\n", mode=0o600)


def add_state_event(state: Dict[str, Any], message: str) -> None:
	events = state.setdefault("events", [])
	if not isinstance(events, list):
		events = []
	state["events"] = events[-(MAX_STATE_EVENTS - 1):]
	state["events"].append(message)


def build_status_details(request_id: str, operation: str) -> Dict[str, Any]:
	viewer = find_viewer()
	state = read_state()
	backend_available = Path(viewer).exists() and os.access(viewer, os.X_OK)
	return {
		"protocol_version": PROTOCOL_VERSION,
		"supported": True,
		"service_available": True,
		"backend": {
			"name": BACKEND_NAME,
			"available": bool(backend_available),
			"path": viewer,
		},
		"protocol_directories": protocol_directories(),
		"diagnostics": {
			"log_tail": read_tail(path_log()),
			"recent_events": list(state.get("events", [])),
		},
		"service_instance_started_ns": SERVICE_STARTED_NS,
		"request_id": request_id,
		"operation": operation,
	}


def write_status_result(request_id: str, operation: str, status: str, status_details: Dict[str, Any], error: Optional[str] = None) -> None:
	result = {
		"protocol_version": PROTOCOL_VERSION,
		"request_id": request_id,
		"operation": operation,
		"status": status,
		"generated_at_ns": time.time_ns(),
		"status_details": status_details,
	}
	if error:
		result["error"] = error
	path = result_path(request_id)
	atomic_write_text(path, json.dumps(result, separators=(",", ":")) + "\n", mode=0o600)
	log(f"wrote {operation} result for {request_id}")


def cleanup_stale_files(now_ns: int) -> None:
	for path in path_requests().iterdir():
		if path.is_symlink():
			safe_unlink(path)
			continue
		if not path.is_file():
			continue
		if now_ns - path.stat().st_mtime_ns > REQUEST_TTL_SECONDS * 1_000_000_000:
			safe_unlink(path)

	for path in path_results().iterdir():
		if path.is_symlink():
			safe_unlink(path)
			continue
		if not path.is_file():
			continue
		if now_ns - path.stat().st_mtime_ns > RESULT_TTL_SECONDS * 1_000_000_000:
			safe_unlink(path)


def scan_requests(now_ns: Optional[int] = None) -> int:
	if now_ns is None:
		now_ns = time.time_ns()

	processed = 0
	state = read_state()
	state["protocol_version"] = PROTOCOL_VERSION
	state["protocol_directories"] = protocol_directories()
	state["last_scan_ns"] = now_ns
	state["service_started_ns"] = SERVICE_STARTED_NS
	state["service_available"] = True
	state["backend_name"] = BACKEND_NAME
	state["backend_path"] = find_viewer()
	for path in sorted(path_requests().iterdir(), key=lambda p: p.name):
		request = parse_request(path, now_ns)
		if request is None:
			continue

		request_id = request["request_id"]
		operation = request["operation"]
		req_path = request_path(request_id)

		if operation == OPEN_REQUEST_OPERATION:
			open_result = open_pdf_with_viewer(request_id, request["details"], state)
			status = open_result.get("status", "error")
			error = open_result.get("error")
			status_details = open_result.get("status_details", {
				"protocol_version": PROTOCOL_VERSION,
				"supported": False,
				"service_available": False,
				"backend": BACKEND_NAME,
				"capabilities": VIEWER_OPEN_CAPABILITIES,
				"owned": False,
				"reused": False,
				"handle": "",
				"protocol_directories": protocol_directories(),
				"service_instance_started_ns": SERVICE_STARTED_NS,
				"request_id": request_id,
				"operation": OPEN_REQUEST_OPERATION,
			})
			write_status_result(request_id, operation, status, status_details, error)
			add_state_event(state, f"handled open request_id={request_id} status={status}")
			safe_unlink(req_path)
			processed += 1
			continue

		if operation != "status":
			error = f"unsupported operation: {operation}"
			viewer_path = find_viewer()
			write_status_result(
				request_id,
				operation,
				"error",
				{
					"protocol_version": PROTOCOL_VERSION,
					"supported": False,
					"service_available": True,
					"backend": {
						"name": BACKEND_NAME,
						"available": Path(viewer_path).exists() and os.access(viewer_path, os.X_OK),
						"path": viewer_path,
					},
					"protocol_directories": protocol_directories(),
					"diagnostics": {"log_tail": read_tail(path_log()), "recent_events": list(state.get("events", []))},
					"service_instance_started_ns": SERVICE_STARTED_NS,
					"request_id": request_id,
					"operation": operation,
				},
				error,
			)
			add_state_event(state, f"unsupported operation request_id={request_id} operation={operation}")
			safe_unlink(req_path)
			continue

		details = build_status_details(request_id, operation)
		write_status_result(request_id, operation, "ok", details)
		add_state_event(state, f"handled status request_id={request_id}")
		safe_unlink(req_path)
		processed += 1

	cleanup_stale_files(now_ns)
	write_state(state)
	return processed


def main() -> int:
	if "--status" in sys.argv:
		ensure_secure_tmpdir(create=True)
		ensure_protocol_dirs()
		status = build_status_details("cli", "status")
		print(json.dumps({"protocol_version": PROTOCOL_VERSION, "status": status}, separators=(",", ":")))
		return 0
	if "--check" in sys.argv:
		ensure_secure_tmpdir(create=True)
		ensure_protocol_dirs()
		if path_requests().is_dir() and path_results().is_dir():
			print("ok")
			return 0
		print("not-ready")
		return 1

	stop = False

	def handle_stop(signum: int, _frame: object) -> None:
		nonlocal stop
		stop = True
		log(f"received signal {signum}; stopping")

	signal.signal(signal.SIGTERM, handle_stop)
	signal.signal(signal.SIGINT, handle_stop)

	ensure_protocol_dirs()
	log("viewer service started")
	last_open_at = 0
	while not stop:
		now_ns = time.time_ns()
		if now_ns - last_open_at >= int(MIN_BACKEND_REOPEN_SECONDS * 1_000_000_000):
			last_open_at = now_ns
		scan_requests(now_ns)
		time.sleep(POLL_SECONDS)

	log("viewer service stopped")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())

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

DEFAULT_TMPDIR = os.environ.get("MCP_TMPDIR", "/tmp/codex-show-latex")
REQUESTS_NAME = "viewer-requests"
RESULTS_NAME = "viewer-results"
STATE_NAME = "viewer-state.json"
LOG_NAME = "viewer.log"
BACKEND_NAME = "zathura"
VIEWER_BACKEND_ENV = "VIEWER_SERVICE_BACKEND"
ZATHURA_VIEWER_PATH_ENV = "ZATHURA_VIEWER_PATH"

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
CLOSE_REQUEST_OPERATION = "close"
FORWARD_SEARCH_REQUEST_OPERATION = "forward_search"
VIEWER_OPEN_CAPABILITIES = {
    "open": True,
    "close": True,
    "forward_search": True,
    "inverse_search": True,
    "reuse": True,
}


def tmpdir() -> Path:
	return Path(os.environ.get("MCP_TMPDIR", DEFAULT_TMPDIR))


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


def source_file_and_validate(path: Path) -> tuple[str | None, str | None, int | None]:
	flags = os.O_RDONLY
	if hasattr(os, "O_NOFOLLOW"):
		flags |= os.O_NOFOLLOW
	try:
		source_fd = os.open(path, flags)
	except OSError as exc:
		if exc.errno == getattr(errno, "ELOOP", 0):
			return ("source_file must not be a symlink", None, None)
		return (f"cannot open source_file: {path}", None, None)

	try:
		st = os.fstat(source_fd)
		if stat.S_ISLNK(st.st_mode):
			os.close(source_fd)
			return ("source_file must not be a symlink", None, None)
		if not stat.S_ISREG(st.st_mode):
			os.close(source_fd)
			return (f"source_file must be a regular file: {path}", None, None)
		if st.st_uid != os.geteuid():
			os.close(source_fd)
			return (f"source_file is not owned by current user: {path}", None, None)
		return (None, str(path.resolve()), source_fd)
	except Exception as exc:
		try:
			os.close(source_fd)
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


def validate_close_request_details(details: Dict[str, Any]) -> Optional[str]:
	handle = details.get("handle")
	backend = details.get("backend")
	if not isinstance(handle, str) or not handle:
		return "missing or invalid handle"
	if not isinstance(backend, str) or not backend:
		return "missing or invalid backend"
	return None


def validate_forward_search_request_details(details: Dict[str, Any]) -> Optional[str]:
	handle = details.get("handle")
	backend = details.get("backend")
	source_file = details.get("source_file")
	line = details.get("line")
	if not isinstance(handle, str) or not handle:
		return "missing or invalid handle"
	if not isinstance(backend, str) or not backend:
		return "missing or invalid backend"
	if not isinstance(source_file, str) or not source_file:
		return "missing or invalid source_file"
	if isinstance(line, bool) or not isinstance(line, int) or line < 1:
		return "line must be a positive integer"
	if "synctex_pid" in details:
		pid = details.get("synctex_pid")
		if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1:
			return "invalid synctex_pid"
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


def _read_bool_env(name: str, default: bool = True) -> bool:
	value = os.environ.get(name)
	if value is None:
		return default
	return value.strip().lower() not in {"", "0", "false", "f", "no", "off", "n"}


class ViewerBackendAdapter:
	def __init__(self, name: str, capabilities: Dict[str, bool]):
		self.name = name
		self.capabilities = capabilities

	def supports(self, operation: str) -> bool:
		return bool(self.capabilities.get(operation, False))

	def resolve_path(self) -> str:
		return self.name

	def is_available(self) -> bool:
		path = self.resolve_path()
		return Path(path).exists() and os.access(path, os.X_OK)

	def status(self, request_id: str, operation: str) -> Dict[str, Any]:
		return build_status_details(request_id, operation, backend=self)

	def open(self, request_id: str, details: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
		return {
			"status": "error",
			"error": f"backend {self.name} does not support open",
			"status_details": build_open_result_details(
				request_id,
				None,
				False,
				False,
				None,
				None,
				"unsupported_operation",
				backend=self,
				supported=False,
			),
		}

	def close(self, request_id: str, details: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
		return {
			"status": "error",
			"error": f"backend {self.name} does not support close",
			"status_details": build_close_result_details(
				request_id,
				False,
				None,
				None,
				self.name,
				False,
				"unsupported_operation",
			),
		}


class ZathuraViewerBackend(ViewerBackendAdapter):
	def __init__(self, executable_path: Optional[str] = None) -> None:
		super().__init__(BACKEND_NAME, VIEWER_OPEN_CAPABILITIES)
		self._executable_path = executable_path

	def resolve_path(self) -> str:
		return self._executable_path if self._executable_path else find_viewer()

	def _snapshot_process_identity(self, pid: int) -> Optional[Dict[str, Any]]:
		if pid <= 0:
			return None
		proc_path = Path("/proc") / str(pid)
		try:
			stat_text = (proc_path / "stat").read_text(encoding="utf-8")
		except Exception:
			return None

		identity: Dict[str, Any] = {}
		try:
			start = stat_text.find("(")
			end = stat_text.rfind(")")
			if start != -1 and end != -1 and end > start:
				identity["comm"] = stat_text[start + 1:end]
				tail = stat_text[end + 2 :].split()
				identity["start_time"] = int(tail[19])
		except Exception:
			pass

		try:
			raw_cmdline = (proc_path / "cmdline").read_bytes()
			identity["cmdline"] = [arg.decode("utf-8", errors="replace") for arg in raw_cmdline.split(b"\0") if arg]
		except Exception:
			pass

		try:
			exe = os.readlink(proc_path / "exe")
			identity["exe"] = exe
		except Exception:
			pass

		return identity if identity else None

	def _is_process_identity_match(self, pid: int, session: Dict[str, Any]) -> bool:
		if not isinstance(pid, int) or pid <= 0:
			return False
		expected_identity = session.get("process_identity")
		if not isinstance(expected_identity, dict) or not expected_identity:
			return False
		current_identity = self._snapshot_process_identity(pid)
		if current_identity is None:
			return False
		for marker in ("comm", "start_time", "exe", "cmdline"):
			expected_value = expected_identity.get(marker)
			current_value = current_identity.get(marker)
			if expected_value is not None and expected_value != current_value:
				return False
		return True

	def _find_owned_viewer_pid_for_pdf(self, viewer_path: str, pdf_path: str) -> Optional[int]:
		pids = _iter_viewer_pids_for_pdf(viewer_path, [pdf_path], allow_wrapped=False)
		return pids[0] if pids else None

	def _is_reusable_session(self, normalized_pdf_path: str, callback: Dict[str, Any]) -> bool:
		session = OPEN_SESSIONS.get(normalized_pdf_path)
		if not isinstance(session, dict):
			OPEN_SESSIONS.pop(normalized_pdf_path, None)
			return False
		if session.get("callback") != callback:
			return False

		current_pid = session.get("pid")
		session_process = session.get("process")
		if not isinstance(current_pid, int):
			OPEN_SESSIONS.pop(normalized_pdf_path, None)
			return False

		if isinstance(session_process, subprocess.Popen):
			if session_process.poll() is not None:
				try:
					session_process.wait(timeout=0)
				except Exception:
					pass
				OPEN_SESSIONS.pop(normalized_pdf_path, None)
				return False
			if self._is_process_identity_match(current_pid, session):
				return True
			OPEN_SESSIONS.pop(normalized_pdf_path, None)
			return False

		if not _pid_alive(current_pid):
			OPEN_SESSIONS.pop(normalized_pdf_path, None)
			return False
		if self._is_process_identity_match(current_pid, session):
			return True
		OPEN_SESSIONS.pop(normalized_pdf_path, None)
		return False

	def _start_viewer_process(self, args: list[str]) -> subprocess.Popen:
		return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

	def _discover_owned_pid(self, viewer_path: str, normalized_pdf_path: str, process: subprocess.Popen) -> tuple[bool, Optional[int], Optional[subprocess.Popen], Optional[str]]:
		owned_pid = process.pid if isinstance(process.pid, int) else None
		owned_process = process if isinstance(owned_pid, int) and process.poll() is None else None
		owned = owned_process is not None
		pid_diagnostic: Optional[str] = None
		if not owned:
			owned_pid = self._find_owned_viewer_pid_for_pdf(viewer_path, normalized_pdf_path)
			if owned_pid is None:
				pid_diagnostic = _read_process_stderr_if_finished(process)
			else:
				owned = True
		return owned, owned_pid, owned_process, pid_diagnostic

	def _build_session_state(self, handle: str, owned_pid: int, viewer_path: str, callback: Dict[str, Any], process: Optional[subprocess.Popen]) -> Dict[str, Any]:
		session = {
			"handle": handle,
			"pid": owned_pid,
			"backend": self.name,
			"backend_path": str(Path(viewer_path).resolve()),
			"callback": dict(callback),
			"owned": True,
			"process_identity": self._snapshot_process_identity(owned_pid),
		}
		if isinstance(process, subprocess.Popen):
			session["process"] = process
		return session

	def open(self, request_id: str, details: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
		if not self.supports("open"):
			return {
				"status": "error",
				"error": f"backend {self.name} does not support open",
				"status_details": build_open_result_details(
					request_id,
					None,
					False,
					False,
					None,
					None,
					"unsupported_operation",
					backend=self,
					supported=False,
				),
			}

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
					backend=self,
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
					backend=self,
				),
			}

		callback = details["callback"]
		reuse_existing = details.get("reuse_existing", True)
		if not isinstance(reuse_existing, bool):
			reuse_existing = True
		require_persistent_viewer = details.get("require_persistent_viewer", False)
		if not isinstance(require_persistent_viewer, bool):
			require_persistent_viewer = False

		viewer_path = self.resolve_path()
		backend_available = Path(viewer_path).exists() and os.access(viewer_path, os.X_OK)
		if not backend_available:
			os.close(pdf_fd)
			return {
				"status": "error",
				"error": "viewer backend is unavailable",
				"status_details": build_open_result_details(
					request_id,
					None,
					False,
					False,
					None,
					"backend unavailable",
					"backend_unavailable",
					backend=self,
				),
			}

		reused = False
		handle = None
		if reuse_existing and self._is_reusable_session(normalized_pdf_path, callback):
			session = OPEN_SESSIONS.get(normalized_pdf_path)
			if session:
				handle = session.get("handle")
				reused = True

		if reuse_existing and handle:
			os.close(pdf_fd)
			return {
				"status": "ok",
				"status_details": build_open_result_details(
					request_id,
					handle,
					bool(session.get("owned")) if isinstance(session, dict) else False,
					reused,
					session.get("pid") if isinstance(session, dict) else None,
					None,
					backend=self,
				),
			}

		handle = f"{self.name}:{request_id}:{int(time.time_ns())}"
		callback_command = build_synctex_callback_command(callback)
		# Launch Zathura with the canonical PDF path rather than /proc/self/fd/<fd>.
		# Zathura records the opened filename in its D-Bus state and uses that filename
		# to locate SyncTeX data during forward search. When launched through a procfd,
		# real Zathura exposes a temporary /tmp/zathura.stdin.* filename and
		# --synctex-forward cannot find the PDF's .synctex sidecar.
		args = [viewer_path, f"--synctex-editor-command={callback_command}", normalized_pdf_path]
		try:
			process = self._start_viewer_process(args)
		except Exception as exc:
			os.close(pdf_fd)
			return {
				"status": "error",
				"error": f"failed to launch viewer: {exc}",
				"status_details": build_open_result_details(
					request_id,
					handle,
					False,
					False,
					None,
					str(exc),
					"launch_failed",
					backend=self,
				),
			}
		os.close(pdf_fd)

		time.sleep(0.05)
		owned, owned_pid, owned_process, pid_diagnostic = self._discover_owned_pid(viewer_path, normalized_pdf_path, process)

		if owned and isinstance(owned_pid, int):
			OPEN_SESSIONS[normalized_pdf_path] = self._build_session_state(
				handle,
				owned_pid,
				viewer_path,
				callback,
				owned_process,
			)

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
					backend=self,
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
				backend=self,
			),
		}


	def _find_session_by_handle(self, handle: str) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
		for pdf_path, session in list(OPEN_SESSIONS.items()):
			if isinstance(session, dict) and session.get("handle") == handle:
				return pdf_path, session
		return None, None

	def _terminate_owned_process(
		self,
		process: subprocess.Popen,
		pid: int,
		matched_path: str,
		request_id: str,
		handle: str,
		backend: str,
	) -> Optional[Dict[str, Any]]:
		try:
			process.terminate()
		except ProcessLookupError:
			OPEN_SESSIONS.pop(matched_path, None)
			return {
				"status": "ok",
				"status_details": build_close_result_details(
					request_id,
					False,
					"not_running",
					handle,
					backend,
					True,
				),
			}
		except PermissionError:
			return {
				"status": "error",
				"error": f"could not send SIGTERM to viewer pid {pid}",
				"status_details": build_close_result_details(
					request_id,
					False,
					"backend_unavailable",
					handle,
					backend,
					True,
					"backend_unavailable",
				),
			}
		except Exception:
			return {
				"status": "error",
				"error": f"could not send SIGTERM to viewer pid {pid}",
				"status_details": build_close_result_details(
					request_id,
					False,
					"backend_unavailable",
					handle,
					backend,
					True,
					"backend_unavailable",
				),
			}

		try:
			process.wait(timeout=1.0)
			return None
		except subprocess.TimeoutExpired:
			try:
				process.kill()
			except PermissionError:
				return {
					"status": "error",
					"error": f"could not send SIGKILL to viewer pid {pid}",
					"status_details": build_close_result_details(
						request_id,
						False,
						"backend_unavailable",
						handle,
						backend,
						True,
						"backend_unavailable",
					),
				}
			except ProcessLookupError:
				OPEN_SESSIONS.pop(matched_path, None)
				return {
					"status": "ok",
					"status_details": build_close_result_details(
						request_id,
						False,
						"not_running",
						handle,
						backend,
						True,
					),
				}
			except Exception:
				return {
					"status": "error",
					"error": f"could not send SIGKILL to viewer pid {pid}",
					"status_details": build_close_result_details(
						request_id,
						False,
						"backend_unavailable",
						handle,
						backend,
						True,
						"backend_unavailable",
					),
				}

			try:
				process.wait(timeout=1.0)
			except subprocess.TimeoutExpired:
				return {
					"status": "error",
					"error": f"viewer did not exit after SIGTERM/SIGKILL for pid {pid}",
					"status_details": build_close_result_details(
						request_id,
						False,
						"backend_unavailable",
						handle,
						backend,
						True,
						"backend_unavailable",
					),
				}
			except Exception:
				return {
					"status": "error",
					"error": f"could not verify termination of viewer pid {pid}",
					"status_details": build_close_result_details(
						request_id,
						False,
						"backend_unavailable",
						handle,
						backend,
						True,
						"backend_unavailable",
					),
				}
		return None
	def close(self, request_id: str, details: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
		if not self.supports("close"):
			return {
				"status": "error",
				"error": f"backend {self.name} does not support close",
				"status_details": build_close_result_details(
					request_id,
					False,
					None,
					None,
					self.name,
					False,
					"unsupported_operation",
				),
			}

		handle = details.get("handle")
		backend = details.get("backend")
		if not isinstance(handle, str) or not isinstance(backend, str) or not backend:
			return {
				"status": "error",
				"error": "invalid request details",
				"status_details": build_close_result_details(
					request_id,
					False,
					"invalid_request",
					None,
					backend if isinstance(backend, str) else None,
					False,
					"invalid_request",
				),
			}

		matched_path, matched_session = self._find_session_by_handle(handle)
		if matched_session is None or matched_path is None:
			return {
				"status": "error",
				"error": "viewer handle not recognized",
				"status_details": build_close_result_details(
					request_id,
					False,
					"unknown_handle",
					handle,
					backend,
					False,
					"unknown_handle",
				),
			}

		session_backend = matched_session.get("backend")
		if session_backend != backend:
			return {
				"status": "error",
				"error": "backend identity mismatch for viewer handle",
				"status_details": build_close_result_details(
					request_id,
					False,
					"backend_mismatch",
					handle,
					backend,
					False,
					"backend_mismatch",
				),
			}

		if not bool(matched_session.get("owned")):
			return {
				"status": "ok",
				"status_details": build_close_result_details(
					request_id,
					False,
					"not_service_owned",
					handle,
					backend,
					True,
				),
			}

		pid = matched_session.get("pid")
		if not isinstance(pid, int):
			OPEN_SESSIONS.pop(matched_path, None)
			return {
				"status": "ok",
				"status_details": build_close_result_details(
					request_id,
					False,
					"not_running",
					handle,
					backend,
					True,
				),
			}

		service_process = matched_session.get("process")
		if isinstance(service_process, subprocess.Popen):
			if service_process.poll() is not None:
				try:
					service_process.wait(timeout=0)
				except Exception:
					pass
				OPEN_SESSIONS.pop(matched_path, None)
				return {
					"status": "ok",
					"status_details": build_close_result_details(
						request_id,
						False,
						"not_running",
						handle,
						backend,
						True,
					),
				}

			terminated_error = self._terminate_owned_process(service_process, pid, matched_path, request_id, handle, backend)
			if terminated_error is not None:
				return terminated_error

			OPEN_SESSIONS.pop(matched_path, None)
			return {
				"status": "ok",
				"status_details": build_close_result_details(
					request_id,
					True,
					None,
					handle,
					backend,
					True,
				),
			}

		if not _pid_alive(pid):
			OPEN_SESSIONS.pop(matched_path, None)
			return {
				"status": "ok",
				"status_details": build_close_result_details(
					request_id,
					False,
					"not_running",
					handle,
					backend,
					True,
				),
			}

		if not self._is_process_identity_match(pid, matched_session):
			OPEN_SESSIONS.pop(matched_path, None)
			return {
				"status": "ok",
				"status_details": build_close_result_details(
					request_id,
					False,
					"identity_mismatch",
					handle,
					backend,
					False,
					"identity_mismatch",
				),
			}

		try:
			os.kill(pid, signal.SIGTERM)
		except PermissionError:
			return {
				"status": "error",
				"error": f"could not send SIGTERM to viewer pid {pid}",
				"status_details": build_close_result_details(
					request_id,
					False,
					"backend_unavailable",
					handle,
					backend,
					True,
					"backend_unavailable",
				),
			}
		except ProcessLookupError:
			OPEN_SESSIONS.pop(matched_path, None)
			return {
				"status": "ok",
				"status_details": build_close_result_details(
					request_id,
					False,
					"not_running",
					handle,
					backend,
					True,
				),
			}

		OPEN_SESSIONS.pop(matched_path, None)
		return {
			"status": "ok",
			"status_details": build_close_result_details(
				request_id,
				True,
				None,
				handle,
				backend,
				True,
			),
		}


class FakeViewerBackend(ViewerBackendAdapter):
	def __init__(self) -> None:
		super().__init__(
			"fake-viewer",
			{
				"open": _read_bool_env("FAKE_VIEWER_OPEN", True),
				"close": False,
				"forward_search": False,
				"inverse_search": False,
				"reuse": _read_bool_env("FAKE_VIEWER_REUSE", True),
			},
		)
		self._mode = os.environ.get("FAKE_VIEWER_BACKEND_MODE", "ok")
		self._open_count = 0
		self._open_sessions: Dict[str, str] = {}

	def resolve_path(self) -> str:
		return self.name

	def is_available(self) -> bool:
		return self._mode not in {"backend_unavailable", "service_unavailable"}

	def status(self, request_id: str, operation: str) -> Dict[str, Any]:
		return build_status_details(
			request_id,
			operation,
			backend=self,
			service_available=self._mode != "service_unavailable",
		)

	def open(self, request_id: str, details: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
		if not self.is_available():
			return {
				"status": "error",
				"error": "viewer backend is unavailable",
				"status_details": build_open_result_details(
					request_id,
					None,
					False,
					False,
					None,
					"backend unavailable",
					"backend_unavailable",
					backend=self,
					supported=self.supports("open"),
					service_available=False,
				),
			}
		if not self.supports("open"):
			return {
				"status": "error",
				"error": "open operation is disabled",
				"status_details": build_open_result_details(
					request_id,
					None,
					False,
					False,
					None,
					None,
					"unsupported_operation",
					backend=self,
					supported=False,
				),
			}

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
					backend=self,
					service_available=True,
				),
			}

		reuse_existing = details.get("reuse_existing", True)
		if not isinstance(reuse_existing, bool):
			reuse_existing = True
		pdf_path = details["pdf_path"]
		if not isinstance(pdf_path, str):
			return {
				"status": "error",
				"error": "pdf_path must be a string",
				"status_details": build_open_result_details(
					request_id,
					None,
					False,
					False,
					None,
					None,
					"invalid_request",
					backend=self,
					service_available=True,
				),
			}

		handle = None
		reused = False
		if reuse_existing:
			handle = self._open_sessions.get(pdf_path)
			if handle is not None:
				reused = True
		if handle is None:
			self._open_count += 1
			handle = f"{self.name}:fake:{self._open_count}"
			self._open_sessions[pdf_path] = handle

		return {
			"status": "ok",
			"status_details": build_open_result_details(
				request_id,
				handle,
				True,
				reused,
				123456,
				None,
				backend=self,
			),
		}


_VIEWER_BACKEND: Optional[ViewerBackendAdapter] = None


def select_viewer_backend() -> ViewerBackendAdapter:
	backend_name = os.environ.get(VIEWER_BACKEND_ENV, BACKEND_NAME)
	zathura_path_env = os.environ.get(ZATHURA_VIEWER_PATH_ENV)
	zathura_path = zathura_path_env.strip() if isinstance(zathura_path_env, str) else None

	if backend_name in {"fake", "fake-viewer"}:
		return FakeViewerBackend()
	if backend_name in {"zathura", BACKEND_NAME}:
		return ZathuraViewerBackend(zathura_path)
	return ZathuraViewerBackend(zathura_path)


def viewer_backend() -> ViewerBackendAdapter:
	global _VIEWER_BACKEND
	if _VIEWER_BACKEND is None:
		_VIEWER_BACKEND = select_viewer_backend()
	return _VIEWER_BACKEND


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


def _iter_viewer_pids_for_command(viewer_path: str, *, allow_wrapped: bool = False) -> list[int]:
	viewer_name = Path(viewer_path).name
	pids: list[int] = []
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
		parts_path_names = tuple(p for p in parts if isinstance(p, str))
		if not parts_path_names:
			continue
		if not allow_wrapped:
			if Path(parts_path_names[0]).name != viewer_name:
				continue
		else:
			if not any(part_name == viewer_name for part_name in [Path(part).name for part in parts_path_names]):
				continue
		pids.append(pid)
	return pids



def _iter_viewer_pids_for_pdf(
	viewer_path: str,
	pdf_paths: list[str],
	*,
	allow_wrapped: bool = False,
) -> list[int]:
	if not pdf_paths:
		return []

	pids: list[int] = []
	for pid in _iter_viewer_pids_for_command(viewer_path, allow_wrapped=allow_wrapped):
		if not Path(f"/proc/{pid}").exists():
			continue
		try:
			parts = [part.decode("utf-8", errors="replace") for part in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if part]
		except Exception:
			continue
		for path in pdf_paths:
			if path and any(part == path or part.endswith(path) for part in parts):
				pids.append(pid)
				break
	return pids

def _find_viewer_pid_for_pdf(viewer_path: str, pdf_paths: list[str]) -> Optional[int]:
	pids = _iter_viewer_pids_for_pdf(viewer_path, pdf_paths, allow_wrapped=False)
	return pids[0] if pids else None


def _iter_wrapped_viewer_pids_for_pdf(viewer_path: str, pdf_paths: list[str]) -> list[int]:
	return _iter_viewer_pids_for_pdf(viewer_path, pdf_paths, allow_wrapped=True)


def _is_process_identity_match_for_session_reuse(pid: int, session: Dict[str, Any]) -> bool:
	if not isinstance(pid, int) or pid <= 0:
		return False
	expected_identity = session.get("process_identity")
	if not isinstance(expected_identity, dict) or not expected_identity:
		return False
	current_identity = _snapshot_process_identity(pid)
	if current_identity is None:
		return False
	for marker in ("comm", "exe"):
		expected_value = expected_identity.get(marker)
		current_value = current_identity.get(marker)
		if expected_value is not None and expected_value != current_value:
			return False
	return True


def _extract_rediscovery_path_hints(pdf_path: str, session: Dict[str, Any]) -> list[str]:
	paths: list[str] = []
	if pdf_path:
		paths.append(pdf_path)
	identity = session.get("process_identity")
	if isinstance(identity, dict):
		cmdline = identity.get("cmdline")
		if isinstance(cmdline, list):
			for arg in cmdline:
				if isinstance(arg, str) and arg.startswith("/proc/self/fd/"):
					paths.append(arg)
	return list(dict.fromkeys(paths))


def _find_viewer_pid_for_pdf_with_session_identity(
	viewer_path: str,
	pdf_path: str,
	session: Dict[str, Any],
	exclude_pid: Optional[int] = None,
) -> Optional[int]:
	pdf_paths = _extract_rediscovery_path_hints(pdf_path, session)
	for pid in _iter_wrapped_viewer_pids_for_pdf(viewer_path, pdf_paths):
		if exclude_pid is not None and pid == exclude_pid:
			continue
		if _is_process_identity_match_for_session_reuse(pid, session):
			return pid

	for pid in _iter_viewer_pids_for_command(viewer_path, allow_wrapped=True):
		if exclude_pid is not None and pid == exclude_pid:
			continue
		if _is_process_identity_match_for_session_reuse(pid, session):
			return pid
	return None


def _read_process_stderr_if_finished(process: subprocess.Popen) -> Optional[str]:
	if process.poll() is None or process.stderr is None:
		return None
	try:
		_stdin, stderr = process.communicate(timeout=0)
	except Exception:
		return None
	if isinstance(stderr, bytes):
		return stderr.decode("utf-8", errors="replace").strip()
	if isinstance(stderr, str):
		return stderr.strip()
	return None


def _snapshot_process_identity(pid: int) -> Optional[Dict[str, Any]]:
	if pid <= 0:
		return None
	proc_path = Path("/proc") / str(pid)
	try:
		stat_text = (proc_path / "stat").read_text(encoding="utf-8")
	except Exception:
		return None

	identity: Dict[str, Any] = {}
	try:
		start = stat_text.find("(")
		end = stat_text.rfind(")")
		if start != -1 and end != -1 and end > start:
			identity["comm"] = stat_text[start + 1:end]
			tail = stat_text[end + 2 :].split()
			identity["start_time"] = int(tail[19])
	except Exception:
		pass

	try:
		raw_cmdline = (proc_path / "cmdline").read_bytes()
		identity["cmdline"] = [arg.decode("utf-8", errors="replace") for arg in raw_cmdline.split(b"\0") if arg]
	except Exception:
		pass
	try:
		exe = os.readlink(proc_path / "exe")
		identity["exe"] = exe
	except Exception:
		pass

	return identity if identity else None


def _is_process_identity_match(pid: int, session: Dict[str, Any]) -> bool:
	if not isinstance(pid, int):
		return False
	expected_identity = session.get("process_identity")
	if not isinstance(expected_identity, dict) or not expected_identity:
		return False
	current_identity = _snapshot_process_identity(pid)
	if current_identity is None:
		return False
	for marker in ("comm", "start_time", "exe", "cmdline"):
		expected_value = expected_identity.get(marker)
		current_value = current_identity.get(marker)
		if expected_value is not None and expected_value != current_value:
			return False
	return True


def build_open_result_details(
	request_id: str,
	handle: Optional[str],
	owned: bool,
	reused: bool,
	pid: Optional[int],
	pid_diagnostic: Optional[str],
	error_code: Optional[str] = None,
	*,
	backend: Optional["ViewerBackendAdapter"] = None,
	supported: bool = True,
	service_available: bool = True,
) -> Dict[str, Any]:
	details = {
		"protocol_version": PROTOCOL_VERSION,
		"supported": bool(supported),
		"service_available": bool(service_available),
		"backend": backend.name if backend else BACKEND_NAME,
		"capabilities": backend.capabilities if backend else VIEWER_OPEN_CAPABILITIES,
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


def build_close_result_details(
	request_id: str,
	closed: bool,
	reason: Optional[str] = None,
	handle: Optional[str] = None,
	backend: Optional[str] = None,
	backend_identity_ok: bool = False,
	error_code: Optional[str] = None,
) -> Dict[str, Any]:
	details = {
		"protocol_version": PROTOCOL_VERSION,
		"supported": True,
		"service_available": True,
		"backend": backend if backend else BACKEND_NAME,
		"backend_identity_ok": bool(backend_identity_ok),
		"protocol_directories": protocol_directories(),
		"service_instance_started_ns": SERVICE_STARTED_NS,
		"request_id": request_id,
		"operation": CLOSE_REQUEST_OPERATION,
		"closed": bool(closed),
	}
	if reason:
		details["reason"] = reason
	if handle:
		details["handle"] = handle
	if error_code is not None:
		details["error_code"] = error_code
	return details


def build_forward_search_result_details(
	request_id: str,
	handled: bool,
	reason: Optional[str] = None,
	handle: Optional[str] = None,
	backend: Optional[str] = None,
	backend_identity_ok: bool = False,
	error_code: Optional[str] = None,
	diagnostics: Optional[list[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
	details = {
		"protocol_version": PROTOCOL_VERSION,
		"supported": True,
		"service_available": True,
		"backend": backend if backend else BACKEND_NAME,
		"backend_identity_ok": bool(backend_identity_ok),
		"protocol_directories": protocol_directories(),
		"service_instance_started_ns": SERVICE_STARTED_NS,
		"request_id": request_id,
		"operation": FORWARD_SEARCH_REQUEST_OPERATION,
		"handled": bool(handled),
	}
	if reason:
		details["reason"] = reason
	if handle:
		details["handle"] = handle
	if error_code is not None:
		details["error_code"] = error_code
	if diagnostics:
		details["diagnostics"] = diagnostics
	return details


def _format_forward_search_output(value: Optional[str], limit: int = 2048) -> str:
	if not value:
		return ""
	text = value.strip()
	if len(text) <= limit:
		return text
	return f"{text[:limit]}..."


def _build_forward_search_diagnostic(
	label: str,
	args: list[str],
	synctex_pid: Optional[int],
	completed: Optional[subprocess.CompletedProcess] = None,
	error: Optional[str] = None,
) -> Dict[str, Any]:
	diagnostic: Dict[str, Any] = {
		"label": label,
		"command": args,
	}
	if synctex_pid is not None:
		diagnostic["synctex_pid"] = synctex_pid
	if completed is not None:
		diagnostic["returncode"] = completed.returncode
		stdout = completed.stdout if isinstance(completed.stdout, str) else ""
		stderr = completed.stderr if isinstance(completed.stderr, str) else ""
		formatted_stdout = _format_forward_search_output(stdout)
		formatted_stderr = _format_forward_search_output(stderr)
		if formatted_stdout:
			diagnostic["stdout"] = formatted_stdout
		if formatted_stderr:
			diagnostic["stderr"] = formatted_stderr
	if error is not None:
		diagnostic["error"] = error
	return diagnostic


def _run_forward_search_command(
	viewer_path: str,
	line: int,
	normalized_source_file: str,
	matched_path: str,
	synctex_pid: Optional[int],
	timeout_seconds: float,
) -> tuple[Optional[subprocess.CompletedProcess], Optional[str], list[str]]:
	args = [viewer_path, "--synctex-forward", f"{line}:1:{normalized_source_file}"]
	if isinstance(synctex_pid, int):
		args.append(f"--synctex-pid={synctex_pid}")
	args.append(matched_path)

	try:
		completed = subprocess.run(args, capture_output=True, text=True, check=False, timeout=timeout_seconds)
	except FileNotFoundError:
		return None, "viewer backend is unavailable", args
	except subprocess.TimeoutExpired as exc:
		return None, f"viewer command timed out: {exc}", args
	except Exception as exc:
		return None, f"failed to invoke viewer command: {exc}", args

	return completed, None, args


def open_pdf_with_viewer(request_id: str, details: Dict[str, Any], state: Dict[str, Any], backend: Optional[ViewerBackendAdapter] = None) -> Dict[str, Any]:
	if backend is None:
		backend = viewer_backend()
	return backend.open(request_id, details, state)


def close_pdf_in_viewer(request_id: str, details: Dict[str, Any], _state: Dict[str, Any]) -> Dict[str, Any]:
	error = validate_close_request_details(details)
	if error:
		return {
			"status": "error",
			"error": error,
			"status_details": build_close_result_details(
				request_id,
				False,
				error,
				None,
				None,
				False,
				"invalid_request",
			),
		}
	return viewer_backend().close(request_id, details, _state)



def forward_search_in_viewer(request_id: str, details: Dict[str, Any], _state: Dict[str, Any]) -> Dict[str, Any]:
	error = validate_forward_search_request_details(details)
	if error:
		return {
			"status": "error",
			"error": error,
			"status_details": build_forward_search_result_details(
				request_id,
				False,
				error,
				None,
				None,
				False,
				"invalid_request",
			),
		}

	handle = details["handle"]
	backend = details["backend"]
	source_file_value = details["source_file"]
	line = details["line"]
	synctex_pid = details.get("synctex_pid")

	matched_session: Optional[Dict[str, Any]] = None
	matched_path = None
	for pdf_path, session in list(OPEN_SESSIONS.items()):
		if session.get("handle") == handle:
			matched_session = session
			matched_path = pdf_path
			break
	if matched_session is None or matched_path is None:
		return {
			"status": "error",
			"error": "viewer handle not recognized",
			"status_details": build_forward_search_result_details(
				request_id,
				False,
				"handle_not_found",
				handle,
				backend,
				False,
				"handle_not_found",
			),
		}

	session_backend = matched_session.get("backend")
	if session_backend != backend:
		return {
			"status": "error",
			"error": "backend identity mismatch for viewer handle",
			"status_details": build_forward_search_result_details(
				request_id,
				False,
				"backend_mismatch",
				handle,
				backend,
				False,
				"backend_mismatch",
			),
		}

	source_file_error, normalized_source_file, source_fd = source_file_and_validate(Path(source_file_value))
	if source_file_error:
		return {
			"status": "error",
			"error": source_file_error,
			"status_details": build_forward_search_result_details(
				request_id,
				False,
				source_file_error,
				handle,
				backend,
				False,
				"invalid_source_file",
			),
		}
	if source_fd is not None:
		try:
			os.close(source_fd)
		except Exception:
			pass

	viewer_path = matched_session.get("backend_path") or find_viewer()
	forward_diagnostics: list[Dict[str, Any]] = []

	def attempt_forward_search(current_pid: Optional[int], attempt_label: str, timeout_seconds: float = 10.0) -> Optional[subprocess.CompletedProcess]:
		completed, command_error, command = _run_forward_search_command(
			viewer_path,
			line,
			normalized_source_file,
			matched_path,
			current_pid,
			timeout_seconds,
		)
		if command_error is not None:
			forward_diagnostics.append(_build_forward_search_diagnostic(attempt_label, command, current_pid, error=command_error))
			return None
		forward_diagnostics.append(_build_forward_search_diagnostic(attempt_label, command, current_pid, completed=completed))
		return completed

	requested_pid = synctex_pid if isinstance(synctex_pid, int) else None
	completed = attempt_forward_search(requested_pid, "tracked")
	if completed is not None and completed.returncode == 0:
		return {
			"status": "ok",
			"status_details": build_forward_search_result_details(
				request_id,
				True,
				handle=handle,
				backend=backend,
				backend_identity_ok=True,
			),
		}

	if completed is None:
		error_detail = forward_diagnostics[-1].get("error", "viewer forward_search failed")
		log(f"forward_search failed for handle={handle} pid={requested_pid}: {error_detail}")
		return {
			"status": "error",
			"error": error_detail,
			"status_details": build_forward_search_result_details(
				request_id,
				False,
				error_detail,
				handle,
				backend,
				False,
				"backend_unavailable",
				diagnostics=forward_diagnostics,
			),
		}

	rediscovered_pid = None
	next_attempt = None
	if requested_pid is not None:
		matched_candidate = _find_viewer_pid_for_pdf_with_session_identity(
			viewer_path,
			matched_path,
			matched_session,
			exclude_pid=requested_pid,
		)
		if matched_candidate is not None and matched_candidate != requested_pid:
			rediscovered_pid = matched_candidate
			log(f"forward_search retrying with rediscovered pid={rediscovered_pid} for handle={handle}")
			next_attempt = attempt_forward_search(rediscovered_pid, "rediscovered")

	if next_attempt is not None and next_attempt.returncode == 0:
		matched_session["pid"] = rediscovered_pid
		matched_session["process_identity"] = _snapshot_process_identity(rediscovered_pid) if isinstance(rediscovered_pid, int) else None
		return {
			"status": "ok",
			"status_details": build_forward_search_result_details(
				request_id,
				True,
				handle=handle,
				backend=backend,
				backend_identity_ok=True,
			),
		}

	if rediscovered_pid is None and requested_pid is not None:
		log(f"forward_search did not find rediscoverable pid for handle={handle} current pid={requested_pid}")

	final_attempt = forward_diagnostics[-1]
	final_return_code = final_attempt.get("returncode")
	final_error = final_attempt.get("error")
	reason = "viewer forward_search failed"
	if isinstance(final_return_code, int):
		reason = f"viewer forward_search failed (returncode={final_return_code})"
	elif final_error:
		reason = f"viewer forward_search failed ({final_error})"

	log(f"forward_search failed for handle={handle}: {reason}; diagnostics={json.dumps(forward_diagnostics, separators=(',', ':'))}")
	return {
		"status": "error",
		"error": reason if isinstance(reason, str) else "viewer forward_search failed",
		"status_details": build_forward_search_result_details(
			request_id,
			False,
			reason,
			handle,
			backend,
			False,
			"backend_unavailable",
			diagnostics=forward_diagnostics,
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


def build_status_details(
	request_id: str,
	operation: str,
	*,
	backend: Optional["ViewerBackendAdapter"] = None,
	supported: bool = True,
	service_available: bool = True,
) -> Dict[str, Any]:
	state = read_state()
	backend_name = backend.name if backend else BACKEND_NAME
	backend_path = backend.resolve_path() if backend else find_viewer()
	backend_available = bool(backend.is_available()) if backend else (Path(backend_path).exists() and os.access(backend_path, os.X_OK))
	return {
		"protocol_version": PROTOCOL_VERSION,
		"supported": bool(supported),
		"service_available": bool(service_available),
		"backend": {
			"name": backend_name,
			"available": bool(backend_available),
			"path": backend_path,
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
	backend = viewer_backend()
	state = read_state()
	state["protocol_version"] = PROTOCOL_VERSION
	state["protocol_directories"] = protocol_directories()
	state["last_scan_ns"] = now_ns
	state["service_started_ns"] = SERVICE_STARTED_NS
	state["service_available"] = True
	state["backend_name"] = backend.name
	state["backend_path"] = backend.resolve_path()
	for path in sorted(path_requests().iterdir(), key=lambda p: p.name):
		request = parse_request(path, now_ns)
		if request is None:
			continue

		request_id = request["request_id"]
		operation = request["operation"]
		req_path = request_path(request_id)

		if operation == OPEN_REQUEST_OPERATION:
			open_result = backend.open(request_id, request["details"], state)
			status = open_result.get("status", "error")
			error = open_result.get("error")
			status_details = open_result.get("status_details", {
				"protocol_version": PROTOCOL_VERSION,
				"supported": False,
				"service_available": False,
				"backend": backend.name,
				"capabilities": backend.capabilities,
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

		if operation == CLOSE_REQUEST_OPERATION:
			close_result = close_pdf_in_viewer(request_id, request["details"], state)
			status = close_result.get("status", "error")
			error = close_result.get("error")
			status_details = close_result.get("status_details", {
				"protocol_version": PROTOCOL_VERSION,
				"supported": False,
				"service_available": False,
				"backend": BACKEND_NAME,
				"backend_identity_ok": False,
				"closed": False,
				"protocol_directories": protocol_directories(),
				"service_instance_started_ns": SERVICE_STARTED_NS,
				"request_id": request_id,
				"operation": CLOSE_REQUEST_OPERATION,
			})
			write_status_result(request_id, operation, status, status_details, error)
			add_state_event(state, f"handled close request_id={request_id} status={status}")
			safe_unlink(req_path)
			processed += 1
			continue

		if operation == FORWARD_SEARCH_REQUEST_OPERATION:
			forward_result = forward_search_in_viewer(request_id, request["details"], state)
			status = forward_result.get("status", "error")
			error = forward_result.get("error")
			status_details = forward_result.get("status_details", {
				"protocol_version": PROTOCOL_VERSION,
				"supported": False,
				"service_available": False,
				"backend": BACKEND_NAME,
				"backend_identity_ok": False,
				"handled": False,
				"protocol_directories": protocol_directories(),
				"service_instance_started_ns": SERVICE_STARTED_NS,
				"request_id": request_id,
				"operation": FORWARD_SEARCH_REQUEST_OPERATION,
			})
			write_status_result(request_id, operation, status, status_details, error)
			add_state_event(state, f"handled forward_search request_id={request_id} status={status}")
			safe_unlink(req_path)
			processed += 1
			continue

		if operation != "status":
			error = f"unsupported operation: {operation}"
			write_status_result(
				request_id,
				operation,
				"error",
				build_status_details(
					request_id,
					operation,
					backend=backend,
					supported=False,
				),
				error,
			)
			add_state_event(state, f"unsupported operation request_id={request_id} operation={operation}")
			safe_unlink(req_path)
			continue

		details = backend.status(request_id, operation)
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
		status = viewer_backend().status("cli", "status")
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

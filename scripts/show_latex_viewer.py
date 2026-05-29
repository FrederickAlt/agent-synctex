#!/usr/bin/env python3
"""Desktop-session viewer service for codex-show-latex.

This helper exposes a filesystem protocol consumed by the Pi extension so that
file operations are validated, serialized, and sandbox-safe.

Clients create per-request files under:
  /tmp/codex-show-latex/viewer-requests/<id>.json
and poll matching result files under:
  /tmp/codex-show-latex/viewer-results/<id>.json

Only the `status` operation is implemented in this tracer slice.
"""

from __future__ import annotations

import json
import os
import signal
import stat
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

# Keep generated preview/service files private to the user.
os.umask(0o077)

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

# PDF Preview Desktop Viewer Bundle

Thin Tauri wrapper for the Viewer Host Server.

## Behavior

- Starts the host process from `PDF_PREVIEW_VIEWER_HOST_COMMAND` and `PDF_PREVIEW_VIEWER_HOST_ARGS`.
- In debug/dev builds only, defaults to `node ../../../scripts/viewer-host-server.ts` when `PDF_PREVIEW_VIEWER_HOST_COMMAND` is unset.
- `PDF_PREVIEW_VIEWER_HOST_COMMAND` is required for packaged/release app startup; startup fails clearly if it is unset. Set it to an installed Viewer Host Server executable; set `PDF_PREVIEW_VIEWER_HOST_ARGS` when that executable needs arguments.
- Waits for the host process to print a JSON `ready` line with `app_url`.
- Validates that `app_url` is exactly a loopback HTTP Viewer Client URL of the form `http://127.0.0.1:<non-zero-port>/app`; `https`, `localhost`, `[::1]`, remote hosts, missing ports, query strings, fragments, and non-`/app` paths are rejected.
- Opens the Tauri window at the validated Host-served `/app` URL.
- Sends `shutdown` to the host process on window/app exit so the Host Server can close sockets and release its local port.

The Viewer Host Server and Viewer Client remain normal TypeScript/web modules. Tauri does not implement PDF registration, PDF serving, SyncTeX, refresh, or tab business logic.

## Platform scope

Required build path:

- macOS: `app`, `dmg`
- Linux: `deb`, `appimage`

Windows best-effort: the Rust wrapper should compile on Windows, but Windows packaging/signing/install behavior is not verified for issue #114 and is not listed in the required bundle targets.

## Packaged host contract

Issue #114 uses an external-host contract rather than bundling a Node sidecar. Packaged macOS/Linux apps must be launched with `PDF_PREVIEW_VIEWER_HOST_COMMAND` pointing at a Viewer Host Server executable that speaks the stdin/stdout lifecycle used by `scripts/viewer-host-server.ts`:

1. Start an HTTP Viewer Host Server bound to `127.0.0.1`.
2. Print one JSON line containing `type: "ready"` and an `app_url` exactly matching `http://127.0.0.1:<non-zero-port>/app`.
3. Keep running until stdin receives `shutdown`, then close sockets and exit.

This keeps the Host Server separable from Tauri APIs and leaves native sidecar packaging for a later hardening slice.

`PDF_PREVIEW_VIEWER_HOST_ARGS` is currently split on ASCII/Unicode whitespace by the Rust wrapper. Paths or arguments containing spaces are not supported by this v1 contract; wrap them in a small launcher script and point `PDF_PREVIEW_VIEWER_HOST_COMMAND` at that script if needed.

## Local commands

From the repository root:

```bash
npm run viewer-host:desktop
```

From `apps/viewer-desktop-tauri/src-tauri`, with Rust, Cargo, Tauri CLI, and Tauri system dependencies installed:

```bash
cargo tauri dev
cargo tauri build
PDF_PREVIEW_VIEWER_HOST_COMMAND=/path/to/viewer-host-server ./target/release/pdf-preview-viewer
```

Current verification gap: this worktree does not configure the Rust toolchain itself. If `cargo` reports that rustup has no default toolchain, run `rustup default stable` before attempting Tauri builds.

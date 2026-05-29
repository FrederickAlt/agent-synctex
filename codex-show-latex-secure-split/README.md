# codex-show-latex secure split

This version separates compilation from desktop viewer control:

```text
MCP/server-side compile path inside Codex/sandbox:
  compile LaTeX only
  write an operation-scoped PDF under /tmp/codex-show-latex/runs/
  optionally refresh fixed compatibility copies under /tmp/codex-show-latex/

Pi extension / viewer-service client path:
  write structured JSON requests under /tmp/codex-show-latex/viewer-requests/
  poll structured JSON results under /tmp/codex-show-latex/viewer-results/

Desktop viewer service outside Codex/sandbox:
  process status/open/close/forward_search requests
  launch and control the viewer backend (currently Zathura) from the desktop session
```

The MCP/Pi client process no longer needs `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, D-Bus, or Wayland/X11 socket access for default viewer control. Compiles are SyncTeX-enabled by default (`-synctex=1`). The client does not launch viewers directly; it only writes/reads protocol files and lets the desktop helper handle GUI control. `show-latex.ready` is now only a compatibility artifact for older standalone MCP callers; the current extension's default external preview path uses the viewer-service request/result protocol, not a ready-marker watcher.

The default boundary is file-protocol based: Pi sends requests through files under `/tmp/codex-show-latex/viewer-requests`, and the viewer helper responds with request/result status records under `/tmp/codex-show-latex/viewer-results`. The MCP/Pi client process does not probe D-Bus or scan `/proc`; the desktop viewer service may inspect `/proc` internally to verify backend process ownership before reuse/close operations.

## Tool parameters

### `show_latex`

```text
latex_source: string, required
compiler: string, optional; default lualatex; one of lualatex, pdflatex, xelatex, latexmk
synctex_editor_command: string, optional; compatibility callback override for standalone MCP callers (not used by default service-mode callers)
write_ready: boolean, optional; compatibility ready descriptor, default true for standalone MCP calls
write_fixed: boolean, optional; fixed compatibility PDF copies, default true
```

`show_latex` uses the active `/tmp/codex-show-latex/preamble.tex`, which is initialized from any `./preamble.tex` or `./praeamble.tex` in the working directory when present. Do not repeat that preamble in `latex_source` unless you intentionally want to override it.

`latexmk` runs latexmk with LuaLaTeX.

On success, the tool returns only:

```text
ok
```

On failure, it returns the compiler error/log tail.

### `show_latex_status`

```text
no parameters
```

Debug-only status tool.

## Runtime files

```text
/tmp/codex-show-latex/runs/<operation-id>/show-latex.tex
/tmp/codex-show-latex/runs/<operation-id>/show-latex.pdf
/tmp/codex-show-latex/runs/<operation-id>/show-latex.log
/tmp/codex-show-latex/show-latex.pdf
/tmp/codex-show-latex/show-latex.tex
/tmp/codex-show-latex/show-latex.synctex.gz
/tmp/codex-show-latex/show-latex.ready        # compatibility artifact only; not watched by default service
/tmp/codex-show-latex/viewer-requests/<request-id>.json
/tmp/codex-show-latex/viewer-results/<request-id>.json
/tmp/codex-show-latex/viewer-state.json
/tmp/codex-show-latex/mcp-debug.log
/tmp/codex-show-latex/viewer.log
```

The temp directory is created as mode `0700` and must be owned by the current user.

## Install

```bash
cd /path/to/codex-show-latex-secure-split
./install.sh
```

The installer:

```text
copies files to ~/plugins/codex-show-latex-mcp
installs/updates [mcp_servers.show-latex] in ~/.codex/config.toml
installs and starts codex-show-latex-viewer.service as a systemd --user service
creates /tmp/codex-show-latex with mode 0700
```

The service only runs `scripts/show_latex_viewer.py` (with `scripts/pi_synctex_callback.mjs` packaged beside it); it does not install a global SyncTeX receiver and does not edit `~/.config/zathura/zathurarc`. The default Pi extension sends structured callback config (`kind: pi-synctex-callback-v1`, `transport: unix`, `socket_path`, `token`) in viewer-service requests, and the service builds the Zathura `--synctex-editor-command=...` value from the packaged `pi_synctex_callback.mjs` helper.

Restart Codex fully after installing. If you already installed an older copy, rerun `./install.sh` or restart `codex-show-latex-viewer.service` so the viewer helper can process the current viewer-service protocol.

## Debug commands

```bash
systemctl --user status codex-show-latex-viewer.service
~/plugins/codex-show-latex-mcp/scripts/show_latex_mcp.py --self-test
~/plugins/codex-show-latex-mcp/scripts/show_latex_viewer.py --status
cat /tmp/codex-show-latex/mcp-debug.log
cat /tmp/codex-show-latex/viewer.log
```

Viewer operations are serviced by the background viewer service and can fail in a few distinct ways:

- **Timeout / service not processing requests**: if a client reports `viewer service request timed out; is the viewer service running?` from an external open/close/jump request (including `show_latex(inline=false)` or `compile_latex_file(open_pdf=true)`), restart the user
  service and inspect `/tmp/codex-show-latex/viewer.log` plus the JSON protocol directories above.
- **Backend unavailable**: failures that mention `viewer backend is unavailable` (or `code=backend_unavailable`) usually mean the configured backend command is missing/unlaunchable. Run
  `~/plugins/codex-show-latex-mcp/scripts/show_latex_viewer.py --status` and verify backend availability before retrying.
- **Compile failures**: `show_latex`/`compile_latex_file` compile errors are separate from service availability; check log files under `/tmp/codex-show-latex/` for compiler details and service diagnostics.

## Security notes

The unsandboxed helper accepts only fixed-shape JSON request files in the private `viewer-requests` directory; it does not accept socket messages or arbitrary shell snippets. Open requests carry structured SyncTeX callback config, not a raw callback command, and the service constructs the Zathura inverse SyncTeX command itself.

It refuses unsafe temp/PDF paths such as symlinks, non-regular PDF files, or files not owned by the current user. Close and forward-search requests are checked against service-owned viewer handles and backend identity before acting.

The remaining intentional capability is narrow: a client that can write valid requests under `/tmp/codex-show-latex/viewer-requests` can ask the desktop service to open, close, or forward-search a validated PDF through the configured viewer backend (currently Zathura).

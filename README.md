# pdf-preview

Pi extension that exposes seven tools:

- `show_latex` — FREEFORM/raw LaTeX preview with optional front matter for `compiler` and `inline`; renders inline by default, or pass `inline=false` for an external viewer-service preview. It automatically loads `./preamble.tex` or `./praeamble.tex` from the current working directory when present, so do not repeat that preamble in the snippet.
- `open_pdf` — send a viewer-service request to open an existing local PDF and return a session-local numeric `pdf_id` for later PDF actions.
- `close_pdf` — close a tracked viewer-service PDF by `pdf_id`.
- `jump_pdf` — perform a line-based viewer-service forward SyncTeX jump in a tracked PDF by `pdf_id`, returning a short “line N contains:” header followed by the jumped-to LaTeX source line.
- `get_synctex_callback_command` — print the current session's exact Zathura inverse SyncTeX callback command for manual configuration only.
- `compile_latex_file` — compile a local LaTeX source file in place, optionally sending a viewer-service open request to track the resulting PDF.
- `set_latex_preamble` — write preamble lines to the fixed temp preamble used by snippet compiles.

Snippet previews communicate with an MCP-style stdio service (`show_latex_mcp.py`) and forward
`tools/call` with `show_latex`. Each successful preview writes an operation-scoped PDF and refreshes
a fixed `/tmp/codex-show-latex/show-latex.pdf` compatibility copy only for external preview calls.
For example:

```tex
---
compiler: lualatex
inline: true
---
\[
x
\]
```

By default, `show_latex` leaves the ready descriptor and fixed preview files untouched, rasterizes each
PDF page to a local PNG with `mutool` or `pdftoppm`, trims image whitespace when ImageMagick is available,
and, for multi-page PDFs, merges the page PNGs into one vertical image when ImageMagick is available
(falling back to sequential PNGs otherwise). It renders inline in Pi chat without returning image bytes in
the tool result; the text result includes an `image_path=<png>` field for the primary local preview image.
Inline image width is proportional to the cropped content width relative to the full PDF
page width, so small symbols stay small while wide formulas use more of the TUI. With `inline=false`, it
refreshes fixed compatibility files and submits an `open` request to the viewer-service protocol handled by
`scripts/show_latex_viewer.py` (or the installed background service). The default extension path does not use
a ready-marker watcher and never launches Zathura or any GUI viewer directly; it only writes/reads viewer-service protocol files.
Inline preview details persist metadata locally in the tool result (`image_path`, `inline_previews`, and `pdf`), containing only
safe artifact paths plus dimensions, so repeated renders in the same process can reuse an in-memory preview ID while a
`/reload` can still recover images from the persisted metadata as long as `/tmp/codex-show-latex/inline` artifacts
remain on disk.
File compiles are spawned directly by the extension so normal LaTeX project-relative includes/assets
resolve without using the backend service.

## Files

- `index.ts` — Pi extension entry point.
- `pdf_tracking.ts` — PDF validation, viewer-service-aware session tracking helpers.
- `synctex.ts` and `scripts/pi_synctex_callback.mjs` — session-scoped inverse SyncTeX IPC and Zathura callback forwarding.
- `scripts/show_latex_mcp.py` — copied service bridge used by the extension.
- `scripts/show_latex_viewer.py` and `systemd/codex-show-latex-viewer.service` — helper service files (viewer service + `pi_synctex_callback.mjs`).

## Install in Pi

```bash
# from repo checkout
pi -e /path/to/pdf-preview
# or (for testing only)
# pi -e /path/to/pdf-preview/index.ts
```

Keep the checked-out `scripts/` directory with the extension. The inverse SyncTeX callback helper
is `scripts/pi_synctex_callback.mjs`; it is spawned on demand by Zathura callback commands and is
not a systemd service. The preview viewer helper remains `scripts/show_latex_viewer.py` (or the
installed `codex-show-latex-viewer.service` from the secure-split package). That unsandboxed service owns
all GUI/reader behavior; the sandboxed extension writes viewer-service protocol requests only. The extension
never edits `~/.config/zathura/zathurarc` automatically.

Viewer-service setup/status:

```bash
# install/start the packaged user service
(cd codex-show-latex-secure-split && ./install.sh)

systemctl --user status codex-show-latex-viewer.service
~/plugins/codex-show-latex-mcp/scripts/show_latex_viewer.py --status
cat /tmp/codex-show-latex/viewer.log
```

The service protocol uses `/tmp/codex-show-latex/viewer-requests`, `/tmp/codex-show-latex/viewer-results`,
and `/tmp/codex-show-latex/viewer-state.json` (all under the mode-0700 base directory). External open/close/jump requests
require the viewer service and are handled only by the unsandboxed helper.

### Viewer troubleshooting

- **Timeout / service not processing requests**: if `open_pdf`, `close_pdf`, `jump_pdf`, `show_latex(inline=false)`, or `compile_latex_file(open_pdf=true)` fail with
  `viewer service request timed out; is the viewer service running?`, start/restart `codex-show-latex-viewer.service` and
  check `systemctl --user status codex-show-latex-viewer.service` plus `/tmp/codex-show-latex/viewer.log`.
- **Backend unavailable**: failures like `viewer backend is unavailable` or `(code=backend_unavailable)` usually mean
  the configured backend command is missing/unlaunchable. Run
  `~/plugins/codex-show-latex-mcp/scripts/show_latex_viewer.py --status` and check the `backend` field for executable
  availability/path before restarting the service.
- The extension sends the service structured callback data (`kind`, `transport`, `socket_path`, `token`); raw callback commands are only
  for manual Zathura configuration via `get_synctex_callback_command`, not for driving viewer operations from the extension.
- For viewer-open failures, inspect `/tmp/codex-show-latex/viewer.log` and `/tmp/codex-show-latex/*.log` for details.
- If LaTeX compilation fails (for `show_latex` or `compile_latex_file`), check `/tmp/codex-show-latex/*.log`; compile and service failures are separate.

## PDF tracking and jumps

`open_pdf(pdf_file_path)` validates that the path exists, is readable, and is a regular PDF file. In default mode, it sends the configured viewer service (`show_latex_viewer.py`) an open/reuse request for the PDF, stores service metadata (`viewer_handle`, `viewer_backend`, capability flags), and returns a session-local `pdf_id`. IDs are short-lived session values only; they are cleared on Pi session shutdown and are not persisted across restarts. Opening the same normalized PDF path again reuses the existing ID where practical.

Tracked PDFs also remember a default source file when possible. `compile_latex_file(..., open_pdf=true)` stores the compiled source path exactly. `open_pdf(existing.pdf)` attempts to infer a default source from `<basename>.tex` next to the normalized PDF and from available `.synctex`/`.synctex.gz` input records.

`jump_pdf(pdf_id, line, source_file?)` performs a forward SyncTeX jump via service forward-search using the tracked numeric `pdf_id`; it does not accept arbitrary PDF paths. The public tool is line-based, so callers do not pass a column. If the default source is unknown, call it again with `source_file`. For content located in a file included with `\input`, `\include`, or similar, pass that included file as `source_file` and use the line number from that file, not the parent file’s include directive line. If the tracked service handle is stale, the tool reopens the PDF through the viewer service before retrying the jump. After a successful jump, the text result names the line and then shows the verbatim LaTeX source line that was jumped to (metadata remains in tool details), so the agent can immediately notice when edits shifted the intended row. The agent should not tell the user which line it jumped to unless the user explicitly asks for the exact line; the user will see the line in the PDF viewer.

`close_pdf(pdf_id)` forwards close via service metadata and removes that PDF from the in-memory tracking table.

Open, close, and jump failures are reported as tool errors and logged under `/tmp/codex-show-latex` and `/tmp/codex-show-latex/viewer.log`. These include service timeout, timeout-like unavailability, stale/unknown handle, and backend availability failures.

## Inverse SyncTeX PDF clicks

Each Pi session starts a private Unix-socket callback endpoint with a random token; session switches and shutdowns close the old endpoint so older callback commands stop working. Zathura is the viewer backend launched and controlled by the unsandboxed `scripts/show_latex_viewer.py` service. PDFs opened through `open_pdf` and LaTeX previews opened by the service are launched with Zathura's `--synctex-editor-command=<command>` already set to the correct session-specific callback.

When Zathura invokes the callback, the extension pastes this block at the current interactive editor cursor and does not submit it or trigger/steer an agent turn:

```text
PDF click: relative/path/main.tex:123
<source line>

```

The path is relative to the Pi session cwd. The source line is included when the clicked source file is readable; otherwise the block still ends with the blank line.

For manual Zathura configuration, call `get_synctex_callback_command` or run the `/synctex_callback_command` slash command in the current Pi session. The returned command is exact for that session only and should be configured as Zathura's `synctex-editor-command`; do not reuse it in another Pi session. The command is built as a Zathura argv template so `%{input}` is substituted as one file-path argument, including paths with quotes, spaces, or shell metacharacters. It only helps with manual inverse SyncTeX configuration and does not imply the extension can open viewers directly.

Manual patterns:

```bash
# One PDF opened by you; pass the returned command as one argument.
callback_command="<paste command returned by get_synctex_callback_command>"
zathura --synctex-editor-command="$callback_command" path/to/file.pdf
```

```conf
# ~/.config/zathura/zathurarc, managed and refreshed by you for each Pi session.
set synctex true
set synctex-editor-command "<paste command returned by get_synctex_callback_command>"
```

The extension does not write or update `zathurarc`; if you use a persistent config entry, replace it when starting a new Pi session because the socket path/token change.

In headless/non-interactive sessions the callback never submits a message automatically. If a PDF click arrives while the agent is busy/streaming, it only pastes into the editor.

## Development

Install dev dependencies once with `npm install`, then run `npm run verify` to typecheck and execute the Node built-in test suite. Unit tests avoid real Zathura/LaTeX dependencies by using temp files and fake helper commands. Inline previews require either `mutool` (from `mupdf-tools`) or `pdftoppm` (from `poppler-utils`) at runtime; optional whitespace trimming uses ImageMagick's `magick` when available. Actual terminal image display requires Pi/TUI image support in the current terminal (Kitty, Ghostty, WezTerm, or iTerm2; tmux/screen generally disable it).

## Compiler selection

`show_latex` and `compile_latex_file` both accept an optional `compiler` parameter. The default is `lualatex`.
`show_latex` also accepts `inline` (default `true`). Use `inline=false` when you specifically want the external viewer-service preview workflow.
Supported values are `lualatex`, `pdflatex`, `xelatex`, and `latexmk` (which runs latexmk with LuaLaTeX).

Prefer `compile_latex_file` over invoking a bare compiler directly when you already have a `.tex` file to build.
It can compile without requesting external viewer state: leave `open_pdf` unset/false for a build/check only run.
Pass `clean=true` to remove common same-basename LaTeX artifacts before compiling, including the previous PDF and SyncTeX sidecars.

Both snippet previews and file compiles pass `-synctex=1` to the selected LaTeX command by default, so generated PDFs have SyncTeX sidecars when the compiler succeeds.

For `compile_latex_file`, the selected compiler is spawned with the source file's directory as the
working directory, using the original file name as the job input. The resulting `<name>.pdf` stays
next to the source file. By default, successful output is a single short `ok: <pdf>` line and no
viewer state changes, so the tool remains useful as a compile/check operation. With `open_pdf=true`,
the tool sends a viewer-service open request for the PDF after a successful compile and returns both `pdf` and `pdf_id` in its
details. If compile succeeds but open fails, re-check service status/logs for `open`/`jump`-style viewer failures.

Both `show_latex` and `compile_latex_file` report only a short error on failure and write diagnostic
details to `/tmp/codex-show-latex/*.log`.

## Preamble behavior

`show_latex` always applies a preamble, even when the caller does not specify one.

For production flows, extension behavior is fixed to service-driven viewer control.

Runtime paths are hardcoded:

- Preview temp directory: `/tmp/codex-show-latex`
- Active preamble file: `/tmp/codex-show-latex/preamble.tex`

At extension initialization, `./preamble.tex` or `./praeamble.tex` in the Pi agent's current working directory is searched in that order. If one exists, its contents are copied to `/tmp/codex-show-latex/preamble.tex` and become the default preamble. During `show_latex` snippet compilation, the extension loads the preamble from `/tmp/codex-show-latex/preamble.tex`; `/tmp/codex-show-latex/praeamble.tex` is also accepted as a fallback if no canonical preamble exists. This means the model should assume the preamble is already in effect and provide only the body unless it intentionally wants to override those definitions.

The preamble can also be changed at runtime with `set_latex_preamble`, which writes `/tmp/codex-show-latex/preamble.tex`. Preamble files should contain only pre-`\begin{document}` code such as `\documentclass`, `\usepackage`, and macro definitions. `show_latex` inputs should then contain only the document body, or the `\begin{document}`...`\end{document}` block. `compile_latex_file` compiles complete files directly and does not inject this temp preamble.

## Firejail note

Your Pi runtime is firejail sandboxed. Keep `/tmp/codex-show-latex` accessible to the sandbox
so the extension and viewer service can communicate via request/result files and preview artifacts.
# agent-synctex

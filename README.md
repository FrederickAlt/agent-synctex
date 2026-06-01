# pdf-preview

Pi extension that exposes six tools:

- `show_latex` — FREEFORM/raw LaTeX preview with optional front matter for `compiler` and `inline`; renders inline by default, or pass `inline=false` for a host-service external preview. It automatically loads `./preamble.tex` or `./praeamble.tex` from the current working directory when present, so do not repeat that preamble in the snippet.
- `open_pdf` — request the host service to open an existing local PDF and return a session-local numeric `pdf_id` for later PDF actions.
- `close_pdf` — close a host-service-tracked PDF by `pdf_id`.
- `jump_pdf` — perform a line-based host-service forward SyncTeX jump in a tracked PDF by `pdf_id`, returning a short “line N contains:” header followed by the jumped-to LaTeX source line.
- `compile_latex_file` — compile a local LaTeX source file in place, optionally sending a host service open request to track the resulting PDF.
- `set_latex_preamble` — write preamble lines to the fixed temp preamble used by snippet compiles.

The TypeScript Host Service now owns backend `show_latex` compilation/open/jump/close flows and viewer backend dispatch. Pi remains the frontend coordinator for tool registration, inline rendering, and editor paste behavior.

When `inline=false`, previews are opened through the local host service using this extension's request context. Each successful preview writes an operation-scoped PDF and refreshes a fixed `${XDG_RUNTIME_DIR}/show-latex/show-latex.pdf` external-preview copy only for external preview calls.
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
refreshes fixed external-preview files and submits an `open` request to the host service. The extension does not use a ready-marker watcher and never launches Zathura or any GUI viewer directly; it only sends host-service protocol requests.
Inline preview details persist metadata locally in the tool result (`image_path`, `inline_previews`, and `pdf`), containing only
safe artifact paths plus dimensions, so repeated renders in the same process can reuse an in-memory preview ID while a
`/reload` can still recover images from the persisted metadata as long as `${XDG_RUNTIME_DIR}/show-latex/inline` artifacts
remain on disk.
LaTeX compile workflows (snippets and files), plus open/jump/close/external preview orchestration, go through the TypeScript Host Service. Pi remains the frontend coordinator and request sender; it does not spawn GUI viewers directly.

## Module layout (post-refactor)

- `index.ts` — Pi composition root and tool wiring.
- `src/modules/pi_adapter/pi_adapter.ts` — **thin** Pi adapter facade (`createUniversalToolFacade`, `registerTracerTools`) used for universal tool dispatch.
- `src/modules/latex/latex_file_compiler.ts` and `src/modules/latex/latex_preamble.ts` — universal LaTeX compiler + preamble application logic shared by preview+file compile flows.
- `src/modules/preview/` — universal preview modules:
  - `show_latex_pipeline.ts` parses front matter, delegates compile/open work to the Host Service flow, and builds inline artifacts.
  - `inline_preview*` modules rasterize PDFs, cache state, render preview output, and validate Kitty placeholder output.
  - `terminal_refresh_policy.ts` manages terminal/kitty refresh invalidation behavior for inline previews.
- `src/modules/synctex/synctex.ts` — session-scoped inverse SyncTeX callback server and click parsing helpers.
- `src/modules/host_service.ts` — protocol client for host-service operations (open/close/jump/compile) and response handling.
- `src/modules/pdf_tracking/pdf_tracking.ts` + `src/modules/pdf_session/pdf_session.ts` — protocol-agnostic PDF open/jump/close session orchestration and per-Pi-context tracking metadata.
- `src/modules/host_service_viewer_backends.ts` and `scripts/agent-synctex-host-service.ts` — host-service backed viewer protocol and host-process transport.
- `scripts/pi_synctex_callback.mjs` — callback helper used by advanced manual callback validation paths.

## Files

- `index.ts` — Pi extension entry point / composition root.
- `src/modules/pi_adapter/pi_adapter.ts` — thin Pi tool facade and registration helper.
- `src/modules/latex/latex_file_compiler.ts` — compile orchestration and validation for local `.tex` files.
- `src/modules/latex/latex_preamble.ts` — preamble merge/normalization helpers.
- `src/modules/preview/*` — preview pipeline, inline rendering, placeholder/image adapters, and terminal refresh handling.
- `src/modules/synctex/synctex.ts` — session-scoped SyncTeX callback socket support.
- `src/modules/pdf_tracking/pdf_tracking.ts` — shared PDF tracking, open/jump/close metadata state.
- `src/modules/pdf_session/pdf_session.ts` — per-context wrapper around tracking with Pi-session callbacks.
- `src/modules/host_service.ts` — protocol client for the host service.
- `scripts/agent-synctex-host-service.ts` — host service executable.
- `scripts/pi_synctex_callback.mjs` — callback script helper for advanced setups and debugging.

## Install in Pi

```bash
# from repo checkout
pi -e /path/to/pdf-preview
# or (for testing only)
# pi -e /path/to/pdf-preview/index.ts
```

Keep the checked-out `scripts/` directory with the extension. The inverse SyncTeX callback helper
is `scripts/pi_synctex_callback.mjs`; it is spawned on demand by Zathura callback commands and is
not a direct part of extension tool code.

Host service setup/status for normal runtime is a user systemd unit from this repo:

```bash
systemctl --user enable --now show-latex.service
systemctl --user status show-latex.service
```

`npm run host-service:start` and `npm run host-service:status` are foreground debug helpers that run the same
TypeScript Host Service directly; they are useful for HITL but are not the normal daemon entrypoint.
During HITL, run them in a separate terminal (or background with a tracked PID).
If your project has `pdf-preview-servicectl`, it targets `show-latex.service` for host-service maintenance
commands (`restart`, `status`, and `logs`).

The host service socket lives under `${XDG_RUNTIME_DIR}/agent-synctex/host-service.sock`, and logs are written under `${XDG_RUNTIME_DIR}/show-latex/*.log`; host-service status logs should be consulted when open/close/jump requests fail unexpectedly.
Before first start, `npm run host-service:status` may return ENOENT when the service runtime directory has not been created yet; this is expected.

Viewer backends are configured in-host by the service runtime; Zathura is the default local backend, with optional test backends for repository-level verification.


### Project-local service broker

For development in this repo, a narrow host-side broker may be available through the project Firejail include:

```bash
pdf-preview-servicectl sync
pdf-preview-servicectl restart
pdf-preview-servicectl status
pdf-preview-servicectl logs
```

The broker socket is project-specific at `~/.cache/pdf-preview-servicectl/broker.sock`; it is intentionally not
placed under the shared show-latex cache. Its purpose is only to let this project sync the host-service helper files, restart/status the host service, and read its diagnostics without exposing the
user session D-Bus to the agent sandbox.

For the external broker migration boundary and expected file/service locations, see [docs/host-service-broker.md](docs/host-service-broker.md).

Do **not** broaden or repurpose this broker. It is a narrow privileged escape hatch for maintaining/testing the PDF
host service only: opening PDFs, closing PDFs, and SyncTeX/forward-search behavior. It must not be used for
unrelated host commands, unrelated services, or non-viewer automation.

### Viewer troubleshooting

- **Timeout / service not processing requests**: if `open_pdf`, `close_pdf`, `jump_pdf`, `show_latex(inline=false)`, or `compile_latex_file(open_pdf=true)` fail with
  `Host service request timed out: is the host service running?`, restart the normal unit with `systemctl --user restart show-latex.service` (or `npm run host-service:start` for foreground debug) and rerun the operation.
- **Backend unavailable**: failures like `viewer backend is unavailable` or `(code=backend_unavailable)` usually mean
  the configured backend command is missing/unlaunchable. Run
  `npm run host-service:status` and check returned backend/daemon diagnostics before restarting the service.
- The extension sends the service structured callback data (`kind`, `transport`, `socket_path`, `token`); raw callback commands are internal and are not a public tool path.
- For host-open failures, inspect `${XDG_RUNTIME_DIR}/show-latex/*.log` for details.
- If LaTeX compilation fails (for `show_latex` or `compile_latex_file`), check `${XDG_RUNTIME_DIR}/show-latex/*.log`; compile and service failures are separate.

## PDF tracking and jumps

`open_pdf(pdf_file_path)` validates that the path exists, is readable, and is a regular PDF file. In normal mode, it sends an open/reuse request to the host service, stores service metadata (`viewer_handle`, `viewer_backend`, capability flags), and returns a session-local `pdf_id`. IDs are short-lived session values only; they are cleared on Pi session shutdown and are not persisted across restarts. Opening the same normalized PDF path again reuses the existing ID where practical.

Tracked PDFs also remember a default source file when possible. `compile_latex_file(..., open_pdf=true)` stores the compiled source path exactly. `open_pdf(existing.pdf)` attempts to infer a default source from `<basename>.tex` next to the normalized PDF and from available `.synctex`/`.synctex.gz` input records.

`jump_pdf(pdf_id, line, source_file?)` performs a forward SyncTeX jump via service forward-search using the tracked numeric `pdf_id`; it does not accept arbitrary PDF paths. The public tool is line-based, so callers do not pass a column. If the default source is unknown, call it again with `source_file`. For content located in a file included with `\input`, `\include`, or similar, pass that included file as `source_file` and use the line number from that file, not the parent file’s include directive line. If the tracked service handle is stale, the tool requests reopen through the host service before retrying the jump. After a successful jump, the text result names the line and then shows the verbatim LaTeX source line that was jumped to (metadata remains in tool details), so the agent can immediately notice when edits shifted the intended row. The agent should not tell the user which line it jumped to unless the user explicitly asks for the exact line; the user will see the line in the PDF viewer.

`close_pdf(pdf_id)` forwards close via service metadata and removes that PDF from the in-memory tracking table.

Open, close, and jump failures are reported as tool errors and logged under `${XDG_RUNTIME_DIR}/show-latex` and `${XDG_RUNTIME_DIR}/show-latex/*.log`. These include service timeout, timeout-like unavailability, stale/unknown handle, and backend availability failures.

## Inverse SyncTeX PDF clicks

Each Pi session starts a private Unix-socket callback endpoint with a random token; session switches and shutdowns close the old endpoint so older callbacks stop working. PDFs opened through `open_pdf` and LaTeX previews are launched with a session-specific callback command wired into the viewer launch command.

When the callback fires, the extension pastes this block at the current interactive editor cursor and does not submit it or trigger/steer an agent turn:

```text
PDF click: relative/path/main.tex:123
<source line>

```

The path is relative to the Pi session cwd. The source line is included when the clicked source file is readable; otherwise the block still ends with the blank line.

Manual callback command details are intentionally not exposed as a public tool path. Use service logs and `npm run host-service:status` for troubleshooting; callback command reconstruction is not part of the stable user-facing flow.

In headless/non-interactive sessions the callback never submits a message automatically. If a PDF click arrives while the agent is busy/streaming, it only pastes into the editor.

## Development

Install dev dependencies once with `npm install`, then run `npm run verify` to typecheck and execute the Node built-in test suite. Unit tests avoid real Zathura/LaTeX dependencies by using temp files and fake helper commands. They validate the extension protocol and a headless host-service workflow, but they do not prove real Zathura D-Bus/SyncTeX behavior.

For service and viewer behavior, also run a manual smoke test from Pi after starting/restarting the host daemon via `systemctl --user restart show-latex.service` (or `npm run host-service:start` for foreground debug; this remains a human-only verification and is not covered by `npm run verify`):

1. `show_latex` default inline flow shows an inline preview artifact in Pi UI.
2. `show_latex` with `inline=false` opens a Zathura window through the TypeScript Host Service backend.
3. `compile_latex_file(path/to/file.tex, {"open_pdf": true})` returns `pdf_id` and opens the compiled PDF through the TypeScript Host Service.
4. `jump_pdf(pdf_id, line)` sends a Host Service forward-search request and jumps the viewer to the matching source location.
5. Trigger a SyncTeX click in the viewer (e.g. click a body equation): the editor should receive a pasted block like `PDF click: path/to/file.tex:NN` with the source line.
6. `close_pdf(pdf_id)` requests close; only service-owned handles should terminate the expected window while unowned/reused views remain untouched.

When diagnosing that smoke test, prefer service logs/status over sandboxed shell invocations of `zathura`, because bare commands run from the agent sandbox do not exercise the same unsandboxed service environment. Inline previews require either `mutool` (from `mupdf-tools`) or `pdftoppm` (from `poppler-utils`) at runtime; optional whitespace trimming uses ImageMagick's `magick` when available. Actual terminal image display requires Pi/TUI image support in the current terminal (Kitty, Ghostty, WezTerm, or iTerm2; tmux/screen generally disable it).

Also keep `viewer_guardrails.test.ts` in mind: it is the explicit regression guard that extension-side code never spawns or probes GUI viewers directly.

## Compiler selection

`show_latex` and `compile_latex_file` both accept an optional `compiler` parameter. The default is `lualatex`.
`show_latex` also accepts `inline` (default `true`). Use `inline=false` when you specifically want the external host-service preview workflow.
Supported values are `lualatex`, `pdflatex`, `xelatex`, and `latexmk` (which runs latexmk with LuaLaTeX).

Prefer `compile_latex_file` over invoking a bare compiler directly when you already have a `.tex` file to build.
It can compile without requesting external viewer state: leave `open_pdf` unset/false for a build/check only run.
Pass `clean=true` to remove common same-basename LaTeX artifacts before compiling, including the previous PDF and SyncTeX sidecars.

Both snippet previews and file compiles pass `-synctex=1` to the selected LaTeX command by default, so generated PDFs have SyncTeX sidecars when the compiler succeeds.

For `compile_latex_file`, the selected compiler is spawned with the source file's directory as the
working directory, using the original file name as the job input. The resulting `<name>.pdf` stays
next to the source file. By default, successful output is a single short `ok: <pdf>` line and no
viewer state changes, so the tool remains useful as a compile/check operation. With `open_pdf=true`,
the tool sends a host-service open request for the PDF after a successful compile and returns both `pdf` and `pdf_id` in its
details. If compile succeeds but open fails, re-check service status/logs for `open`/`jump`-style viewer failures.

Both `show_latex` and `compile_latex_file` report only a short error on failure and write diagnostic
details to `${XDG_RUNTIME_DIR}/show-latex/*.log`.

## Preamble behavior

`show_latex` always applies a preamble, even when the caller does not specify one.

For production flows, extension behavior is fixed to service-driven viewer control.

Runtime paths are hardcoded:

- Preview temp directory: `${XDG_RUNTIME_DIR}/show-latex`
- Active preamble file: `${XDG_RUNTIME_DIR}/show-latex/preamble.tex`

At extension initialization, `./preamble.tex` or `./praeamble.tex` in the Pi agent's current working directory is searched in that order. If one exists, its contents are copied to `${XDG_RUNTIME_DIR}/show-latex/preamble.tex` and become the default preamble. During `show_latex` snippet compilation, the extension loads the preamble from `${XDG_RUNTIME_DIR}/show-latex/preamble.tex`; `${XDG_RUNTIME_DIR}/show-latex/praeamble.tex` is also accepted as a fallback if no canonical preamble exists. This means the model should assume the preamble is already in effect and provide only the body unless it intentionally wants to override those definitions.

The preamble can also be changed at runtime with `set_latex_preamble`, which writes `${XDG_RUNTIME_DIR}/show-latex/preamble.tex`. Preamble files should contain only pre-`\begin{document}` code such as `\documentclass`, `\usepackage`, and macro definitions. `show_latex` inputs should then contain only the document body, or the `\begin{document}`...`\end{document}` block. `compile_latex_file` compiles complete files directly and does not inject this temp preamble.

## Firejail note

Your Pi runtime is firejail sandboxed. Keep `${XDG_RUNTIME_DIR}/show-latex` accessible to the sandbox
so the extension and host service can communicate via request/result files and preview artifacts.
# agent-synctex

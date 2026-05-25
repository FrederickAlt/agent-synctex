# pdf-preview

Pi extension that exposes seven tools:

- `show_latex` — compile LaTeX source and trigger the preview pipeline.
- `open_pdf` — open an existing local PDF in Zathura and return a session-local numeric `pdf_id` for later PDF actions.
- `close_pdf` — close a tracked Zathura PDF window by `pdf_id`.
- `jump_pdf` — perform a line-based Zathura forward SyncTeX jump in a tracked PDF by `pdf_id`.
- `get_synctex_callback_command` — print the current session's exact Zathura inverse SyncTeX callback command for manual configuration.
- `compile_latex_file` — compile a local LaTeX source file in place, optionally opening/tracking the resulting PDF.
- `set_latex_preamble` — write preamble lines to the fixed temp preamble used by snippet compiles.

Snippet previews communicate with an MCP-style stdio service (`show_latex_mcp.py`) and forward
`tools/call` with `show_latex`. Each successful preview writes an operation-scoped PDF, refreshes
a fixed `/tmp/codex-show-latex/show-latex.pdf` compatibility copy, and atomically writes a ready
descriptor that pairs the operation PDF with the session's SyncTeX callback command. The extension
also falls back to opening the fixed preview PDF itself if no viewer helper opens the new preview.
File compiles are spawned directly by the extension so normal LaTeX project-relative includes/assets
resolve without using the backend service.

## Files

- `index.ts` — Pi extension entry point.
- `pdf_tracking.ts` — PDF validation, Zathura opening, and in-memory session tracking helpers.
- `synctex.ts` and `scripts/pi_synctex_callback.mjs` — session-scoped inverse SyncTeX IPC and Zathura callback forwarding.
- `scripts/show_latex_mcp.py` — copied service bridge used by the extension.
- `scripts/show_latex_viewer.py` and `systemd/codex-show-latex-viewer.service` — same helper service files from the original implementation.

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
installed `codex-show-latex-viewer.service` from the secure-split package). The extension never
edits `~/.config/zathura/zathurarc` automatically.

## PDF tracking and jumps

`open_pdf(pdf_file_path)` validates that the path exists, is readable, is a regular PDF file, then launches Zathura with `--fork` unless a local Zathura process for the same normalized PDF path is already visible. Successful calls return `ok: pdf_id=<id> pdf=<path>` and include `pdf_id` in tool details. IDs are short-lived, session-local values valid only in the current running Pi session/process; they are cleared on Pi session shutdown and are not persisted across restarts. Opening the same normalized PDF path again reuses the existing ID within that session where practical, while distinct PDFs receive distinct IDs.

Tracked PDFs also remember a default source file when possible. `compile_latex_file(..., open_pdf=true)` stores the compiled source path exactly. `open_pdf(existing.pdf)` attempts to infer a default source from `<basename>.tex` next to the normalized PDF and from available `.synctex`/`.synctex.gz` input records.

`jump_pdf(pdf_id, line, source_file?)` performs a forward SyncTeX jump with Zathura using the tracked numeric `pdf_id`; it does not accept arbitrary PDF paths. The public tool is line-based, so callers do not pass a column. If the default source is unknown, call it again with `source_file`. For content located in a file included with `\input`, `\include`, or similar, pass that included file as `source_file` and use the line number from that file, not the parent file’s include directive line. If the tracked Zathura window was closed or is unavailable, the tool tries to reopen the same tracked PDF before retrying the jump.

`close_pdf(pdf_id)` sends `SIGTERM` only to local `zathura` processes whose command line contains the tracked PDF path, then removes that PDF from the in-memory tracking table. If no matching process is found, the PDF is still untracked.

Open, close, and jump failures are reported as tool errors and logged under `/tmp/codex-show-latex`.

## Inverse SyncTeX PDF clicks

Each Pi session starts a private Unix-socket callback endpoint with a random token; session switches and shutdowns close the old endpoint so older callback commands stop working. PDFs opened through `open_pdf` and LaTeX previews opened by `scripts/show_latex_viewer.py` are launched with Zathura's `--synctex-editor-command=<command>` already set to the correct session-specific callback.

When Zathura invokes the callback, the extension pastes this block at the current interactive editor cursor and does not submit it or trigger/steer an agent turn:

```text
PDF click: relative/path/main.tex:123
<source line>

```

The path is relative to the Pi session cwd. The source line is included when the clicked source file is readable; otherwise the block still ends with the blank line.

For manual Zathura configuration, call `get_synctex_callback_command` or run the `/synctex_callback_command` slash command in the current Pi session. The returned command is exact for that session only and should be configured as Zathura's `synctex-editor-command`; do not reuse it in another Pi session. The command is built as a Zathura argv template so `%{input}` is substituted as one file-path argument, including paths with quotes, spaces, or shell metacharacters.

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

Install dev dependencies once with `npm install`, then run `npm run verify` to typecheck and execute the Node built-in test suite. Unit tests avoid real Zathura/LaTeX dependencies by using temp files and fake helper commands.

## Compiler selection

`show_latex` and `compile_latex_file` both accept an optional `compiler` parameter. The default is `lualatex`.
Supported values are `lualatex`, `pdflatex`, `xelatex`, and `latexmk` (which runs latexmk with LuaLaTeX).

Both snippet previews and file compiles pass `-synctex=1` to the selected LaTeX command by default, so generated PDFs have SyncTeX sidecars when the compiler succeeds.

For `compile_latex_file`, the selected compiler is spawned with the source file's directory as the
working directory, using the original file name as the job input. The resulting `<name>.pdf` stays
next to the source file. By default, successful output is a single short `ok: <pdf>` line and no
viewer state changes, so the tool remains useful as a compile/check operation. With `open_pdf=true`,
the tool opens/tracks the PDF after a successful compile and returns both `pdf` and `pdf_id` in its
details.

Both `show_latex` and `compile_latex_file` report only a short error on failure and write diagnostic
details to `/tmp/codex-show-latex/*.log`.

## Preamble behavior

There are no environment-variable configuration knobs for this extension. Runtime paths are hardcoded:

- Preview temp directory: `/tmp/codex-show-latex`
- Active preamble file: `/tmp/codex-show-latex/preamble.tex`

At extension initialization, `./preamble.tex` or `./praeamble.tex` in the Pi agent's current working directory is searched in that order. If one exists, its contents are copied to `/tmp/codex-show-latex/preamble.tex` and become the default preamble. During `show_latex` snippet compilation, the extension loads the preamble from `/tmp/codex-show-latex/preamble.tex`; `/tmp/codex-show-latex/praeamble.tex` is also accepted as a fallback if no canonical preamble exists.

The preamble can also be changed at runtime with `set_latex_preamble`, which writes `/tmp/codex-show-latex/preamble.tex`. Preamble files should contain only pre-`\begin{document}` code such as `\documentclass`, `\usepackage`, and macro definitions. `show_latex` inputs should then contain only the document body, or the `\begin{document}`...`\end{document}` block. `compile_latex_file` compiles complete files directly and does not inject this temp preamble.

## Firejail note

Your Pi runtime is firejail sandboxed. Keep `/tmp/codex-show-latex` accessible to the sandbox
so the helper + viewer can communicate via marker/pdf files.
# agent-synctex

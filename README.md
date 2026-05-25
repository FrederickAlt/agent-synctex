# pdf-preview

Pi extension that exposes five tools:

- `show_latex` — compile LaTeX source and trigger the fixed preview pipeline.
- `open_pdf` — open an existing local PDF in Zathura and return a session-local numeric `pdf_id` for later PDF actions.
- `get_synctex_callback_command` — print the current session's exact Zathura inverse SyncTeX callback command for manual configuration.
- `compile_latex_file` — compile a local LaTeX source file in place without opening or publishing a preview.
- `set_latex_preamble` — write preamble lines to the fixed temp preamble used by snippet compiles.

Snippet previews communicate with an MCP-style stdio service (`show_latex_mcp.py`) and forward
`tools/call` with `show_latex`. File compiles are spawned directly by the extension so normal
LaTeX project-relative includes/assets resolve without using the backend service.

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

## PDF tracking

`open_pdf(pdf_file_path)` validates that the path exists, is readable, is a regular PDF file, then launches Zathura with `--fork`. Successful calls return `ok: pdf_id=<id> pdf=<path>` and include `pdf_id` in tool details. IDs are short-lived, session-local values; they are cleared on Pi session shutdown and are not persisted across restarts. Opening the same normalized PDF path again reuses the existing ID within that session where practical, while distinct PDFs receive distinct IDs.

Open failures are reported as tool errors and logged under `/tmp/codex-show-latex`.

## Inverse SyncTeX PDF clicks

Each Pi session starts a private Unix-socket callback endpoint with a random token; session switches and shutdowns close the old endpoint so older callback commands stop working. PDFs opened through `open_pdf` and LaTeX previews opened by `scripts/show_latex_viewer.py` are launched with Zathura's `--synctex-editor-command=<command>` already set to the correct session-specific callback.

When Zathura invokes the callback, the extension pastes this block at the current interactive editor cursor and does not submit it or trigger/steer an agent turn:

```text
PDF click: relative/path/main.tex:123
<source line>

```

The path is relative to the Pi session cwd. The source line is included when the clicked source file is readable; otherwise the block still ends with the blank line.

For manual Zathura configuration, call `get_synctex_callback_command` or run the `/synctex_callback_command` slash command in the current Pi session. The returned command is exact for that session only and should be configured as Zathura's `synctex-editor-command`; do not reuse it in another Pi session. The command is built as a Zathura argv template so `%{input}` is substituted as one file-path argument, including paths with quotes, spaces, or shell metacharacters.

In headless/non-interactive sessions the callback never submits a message automatically. If a PDF click arrives while the agent is busy/streaming, it only pastes into the editor.

## Development

Install dev dependencies once with `npm install`, then run `npm run verify` to typecheck and execute the Node built-in test suite. Unit tests avoid real Zathura/LaTeX dependencies by using temp files and fake helper commands.

## Compiler selection

`show_latex` and `compile_latex_file` both accept an optional `compiler` parameter. The default is `lualatex`.
Supported values are `lualatex`, `pdflatex`, `xelatex`, and `latexmk` (which runs latexmk with LuaLaTeX).

For `compile_latex_file`, the selected compiler is spawned with the source file's directory as the
working directory, using the original file name as the job input. The resulting `<name>.pdf` stays
next to the source file. Successful output is a single short `ok: <pdf>` line.

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

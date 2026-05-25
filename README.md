# pdf-preview

Pi extension that exposes three tools:

- `show_latex` — compile LaTeX source and trigger the fixed preview pipeline.
- `compile_latex_file` — compile a local LaTeX source file in place without opening or publishing a preview.
- `set_latex_preamble` — write preamble lines to the fixed temp preamble used by snippet compiles.

Snippet previews communicate with an MCP-style stdio service (`show_latex_mcp.py`) and forward
`tools/call` with `show_latex`. File compiles are spawned directly by the extension so normal
LaTeX project-relative includes/assets resolve without using the backend service.

## Files

- `index.ts` — Pi extension entry point.
- `scripts/show_latex_mcp.py` — copied service bridge used by the extension.
- `scripts/show_latex_viewer.py` and `systemd/codex-show-latex-viewer.service` — same helper service files from the original implementation.

## Install in Pi

```bash
# from repo checkout
pi -e /path/to/pdf-preview
# or (for testing only)
# pi -e /path/to/pdf-preview/index.ts
```

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

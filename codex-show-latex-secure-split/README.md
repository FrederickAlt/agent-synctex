# codex-show-latex secure split

This version separates the two jobs:

```text
MCP server inside Codex/sandbox:
  compile LaTeX only
  write an operation-scoped PDF under /tmp/codex-show-latex/runs/
  refresh fixed compatibility copies under /tmp/codex-show-latex/
  atomically write /tmp/codex-show-latex/show-latex.ready on success

Desktop helper outside Codex/sandbox:
  watch /tmp/codex-show-latex/show-latex.ready
  open the PDF named in that ready descriptor in Zathura
```

The MCP process no longer needs `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, D-Bus, or Wayland/X11 socket access. Compiles are SyncTeX-enabled by default (`-synctex=1`), and each ready descriptor can carry an operation-scoped Zathura inverse SyncTeX callback command.

## Tool parameters

### `show_latex`

```text
latex_source: string, required
compiler: string, optional; default lualatex; one of lualatex, pdflatex, xelatex, latexmk
synctex_editor_command: string, optional; operation-scoped Zathura inverse SyncTeX callback
```

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
/tmp/codex-show-latex/show-latex.ready
/tmp/codex-show-latex/mcp-debug.log
/tmp/codex-show-latex/zathura.log
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

The service only runs `scripts/show_latex_viewer.py`; it does not install a global SyncTeX receiver and does not edit `~/.config/zathura/zathurarc`. When a ready descriptor includes `synctex_editor_command`, the viewer passes it to Zathura with `--synctex-editor-command=...` for that opened preview.

Restart Codex fully after installing. If you already installed an older copy, rerun `./install.sh` or restart `codex-show-latex-viewer.service` so the viewer helper can read the new ready descriptor fields.

## Debug commands

```bash
systemctl --user status codex-show-latex-viewer.service
~/plugins/codex-show-latex-mcp/scripts/show_latex_mcp.py --self-test
~/plugins/codex-show-latex-mcp/scripts/show_latex_viewer.py --status
cat /tmp/codex-show-latex/mcp-debug.log
cat /tmp/codex-show-latex/zathura.log
```

## Security notes

The unsandboxed helper does not accept JSON requests, socket messages, or arbitrary shell snippets. It only reacts to the fixed ready marker and opens the operation PDF named there. The optional `synctex_editor_command` field is passed to Zathura as its inverse SyncTeX editor command for the current preview operation.

It refuses unsafe temp/PDF paths such as symlinks, non-regular PDF files, files outside `/tmp/codex-show-latex`, or files not owned by the current user.

The remaining intentional capability is narrow: a successful sandboxed compile can cause Zathura to open the operation PDF declared in `/tmp/codex-show-latex/show-latex.ready`.

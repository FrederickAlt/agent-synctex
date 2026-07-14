# Agent SyncTeX

Agent SyncTeX is a local stdio MCP server for LaTeX workflows. It can compile LaTeX, open PDFs in a local viewer, jump via SyncTeX, and pass user-marked PDF comments back to an agent as source-cited context.

![Agent SyncTeX demo](https://raw.githubusercontent.com/FrederickAlt/agent-synctex/main/demo.gif)

## Requirements

- Node.js 22 or newer
- A TeX installation providing `latexmk` and `synctex`
- A local web browser for the PDF viewer

## Install from npm

Install the CLI globally so agent harnesses and generated hooks can invoke it:

```bash
npm install --global agent-synctex
```

Verify the executable is available:

```bash
agent-synctex --help
```

Configure one supported harness:

```bash
agent-synctex install --harness claude
```

Replace `claude` with `codex`, `cline`, `pi`, or `opencode`. To configure every detected harness:

```bash
agent-synctex install --harness all
```

Restart the configured harness after installation. Check the integration and external commands with:

```bash
agent-synctex doctor --harness claude
```

Use `--local` to write project-local harness configuration instead of user-level configuration:

```bash
agent-synctex install --harness claude --local
```

To install the MCP config and hooks separately:

```bash
agent-synctex install mcp --harness claude
agent-synctex install hooks --harness claude
```

Upgrade the npm package, then rerun the installer to refresh managed configuration and hooks:

```bash
npm install --global agent-synctex@latest
agent-synctex install --harness claude
```

Uninstall managed configuration and hooks before removing the package:

```bash
agent-synctex uninstall --harness claude
npm uninstall --global agent-synctex
```

## MCP command

Hook-capable mode, used by installed MCP configs:

```bash
agent-synctex mcp --harness claude
```

Pure MCP/manual mode:

```bash
agent-synctex mcp --harness claude --no-hooks
```

Install pure MCP mode with:

```bash
agent-synctex install --harness claude --no-hooks
```

## Tools

- `show_latex` — render LaTeX and open the result. Pass a complete document, or pass `preamble_root_file` to wrap body content with a root preamble.
- `compile_latex_file` — compile a `.tex` file, optionally opening the PDF.
- `open_pdf` — open/register an existing PDF.
- `jump_pdf` — forward SyncTeX jump to a source line.
- `fetch_pdf_context` — fetch pending PDF marks/comments as source-cited context. Advertised only in manual/no-hooks mode; hook-capable harness mode uses prompt hooks instead.

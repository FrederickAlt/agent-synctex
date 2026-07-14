# Agent SyncTeX

Agent SyncTeX is a local stdio MCP server for LaTeX workflows. It can compile LaTeX, open PDFs in a local viewer, jump via SyncTeX, and pass user-marked PDF comments back to an agent as source-cited context.

![Agent SyncTeX demo](https://raw.githubusercontent.com/FrederickAlt/agent-synctex/main/demo.gif)

## Requirements

- Node.js 22 or newer
- A TeX installation providing `latexmk` and `synctex`
- A local web browser for the PDF viewer

## Supported harnesses

- Codex (tested)
- Pi (tested)
- Claude (untested)
- Cline (untested)
- OpenCode (untested)

Supported platforms:

- Linux (tested)
- macOS (untested)

## Install from npm

Install the CLI globally, then configure Codex:

```bash
npm install --global agent-synctex
agent-synctex install --harness codex
```

Use `--harness pi` for Pi, `--harness all` to configure every detected harness, or `--local` for project-local configuration. Restart the harness after installation. Check the installation with `agent-synctex doctor --harness codex`.

## Hooks and manual mode

The default hook-enabled installation injects PDF comments into the agent automatically at the appropriate prompt or tool-hook boundary.

If hooks are unavailable or undesired, install manual mode:

```bash
agent-synctex install --harness codex --no-hooks
```

In manual mode, the agent must explicitly call the `fetch_pdf_context` MCP tool to retrieve pending PDF marks and comments. They are not injected automatically.

## Uninstall

Remove managed harness configuration and hooks, then remove the npm package:

```bash
agent-synctex uninstall --harness codex
npm uninstall --global agent-synctex
```

Use the same harness and `--local` options used during installation.

## MCP command

Hook-capable mode, used by installed MCP configs:

```bash
agent-synctex mcp --harness codex
```

Pure MCP/manual mode:

```bash
agent-synctex mcp --harness codex --no-hooks
```

Install pure MCP mode with:

```bash
agent-synctex install --harness codex --no-hooks
```

## Tools

- `show_latex` — render LaTeX and open the result. Pass a complete document, or pass `preamble_root_file` to wrap body content with a root preamble.
- `compile_latex_file` — compile a `.tex` file, optionally opening the PDF.
- `open_pdf` — open/register an existing PDF.
- `jump_pdf` — forward SyncTeX jump to a source line.
- `fetch_pdf_context` — fetch pending PDF marks/comments as source-cited context. Advertised only in manual/no-hooks mode; hook-capable harness mode uses prompt hooks instead.

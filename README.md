# Agent SyncTeX

Agent SyncTeX is a local stdio MCP server for LaTeX workflows. It can compile LaTeX, open PDFs in a local viewer, jump via SyncTeX, and pass user-marked PDF comments back to an agent as source-cited context.

## Install

```bash
npm install -g agent-synctex
```

Install MCP config and current-turn PDF comment injection hooks for all detected harness directories:

```bash
agent-synctex install --harness all
```

Install for one harness:

```bash
agent-synctex install --harness claude
```

Project-local install:

```bash
agent-synctex install --harness claude --local
```

Advanced split install:

```bash
agent-synctex install mcp --harness claude
agent-synctex install hooks --harness claude
```

Supported harnesses:

```text
claude | codex | cline | pi | opencode | all
```

Uninstall managed config and hooks:

```bash
agent-synctex uninstall --harness claude
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
- `fetch_pdf_context` — fetch pending PDF marks/comments as source-cited context. Hidden when hook-capable mode detects installed hooks.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm publish --dry-run
```

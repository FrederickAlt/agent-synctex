# PRD — Harness hooks, MCP launch modes, and installer CLI

## Status

Implemented draft.

## Problem

Agent SyncTeX must inject PDF marks/comments into the current agent turn without advertising raw viewer events to the model. Users need one npm-installed CLI that can configure MCP and post-user-message hooks for Claude Code, Codex CLI, Cline, Pi, and OpenCode, and uninstall only managed artifacts.

## Goals

- Publish one public CLI: `agent-synctex`.
- Start MCP with `agent-synctex mcp [--harness <harness>] [--no-hooks]`.
- Install MCP and hooks together by default:
  - `agent-synctex install --harness <harness|all> [--local]`
- Keep split/manual modes available:
  - `agent-synctex install mcp --harness <harness> [--local|--scope project|user] [--no-hooks]`
  - `agent-synctex install hooks --harness <harness> [--local|--scope project|user]`
- Use `agent-synctex fetch-info --harness <harness>` from harness hooks.
- Never advertise `get_pdf_events`.
- Hide `fetch_pdf_context` when installed hooks inject PDF context automatically.
- Show `fetch_pdf_context` in explicit `--no-hooks`, missing-harness fallback, or missing-hooks modes.
- Clear consumed viewer marks/comments after successful collection.
- Generate only managed hook/plugin/extension files containing `Managed by agent-synctex`.
- Uninstall only managed entries/files.

## User flows

### MCP only / manual context

```bash
agent-synctex install --harness claude --no-hooks
```

Result: MCP config launches `agent-synctex mcp --harness claude --no-hooks`, and the agent can manually call `fetch_pdf_context`.

### Hook-capable MCP plus hooks

```bash
agent-synctex install --harness claude
```

Result: MCP config launches `agent-synctex mcp --harness claude`; hooks call `agent-synctex fetch-info --harness claude`; `fetch_pdf_context` is hidden once managed hooks are detected.

### Missing harness fallback

If MCP is started as `agent-synctex mcp` without `--harness` and without `--no-hooks`, it falls back to no-hooks mode, warns on launch, warns once on first tool call, and exposes `fetch_pdf_context`.

### Uninstall

```bash
agent-synctex uninstall --harness claude --local
agent-synctex uninstall --harness all
```

Result: managed MCP entries and managed hook files/entries are removed; unrelated user config is preserved.

## CLI surface

```bash
agent-synctex mcp [--harness claude|codex|cline|pi|opencode] [--no-hooks]
agent-synctex fetch-info --harness claude|codex|cline|pi|opencode
agent-synctex install [mcp|hooks] --harness auto|all|claude|codex|cline|pi|opencode [--local|--scope project|user] [--no-hooks] [--dry-run] [--yes]
agent-synctex uninstall --harness auto|all|claude|codex|cline|pi|opencode [--local|--scope project|user] [--dry-run] [--yes]
agent-synctex doctor --harness auto|all|claude|codex|cline|pi|opencode [--scope project|user]
```

## MCP launch modes

- `agent-synctex mcp --harness <harness>`: hook-capable mode. Starts a private bridge named `agent-synctex-<harness>` and hides `fetch_pdf_context` only when managed hooks are installed.
- `agent-synctex mcp --harness <harness> --no-hooks`: explicit manual mode. Does not start the bridge and advertises `fetch_pdf_context`.
- `agent-synctex mcp`: missing-harness fallback. Behaves like no-hooks and warns.

## Context format

```md
## PDF marks from Agent SyncTeX

- `main.tex:42` — `E = mc^2`
  User comment: Check notation here.
```

## Harness support

- Claude Code: MCP in `.mcp.json` or `~/.claude.json`; hooks in `.claude/settings.json`/`~/.claude/settings.json` plus managed shell script.
- Codex CLI: MCP in `.codex/config.toml` or `~/.codex/config.toml`; hooks in hooks JSON plus managed shell script.
- Cline: MCP in `.cline_mcp_settings.json` or user settings path; hook in `UserPromptSubmit`.
- Pi: MCP via `pi-mcp-adapter` `mcp.json` with `"lifecycle": "keep-alive"`; hook as standalone Pi extension.
- OpenCode: MCP in `opencode.json`; hook as `chat.message` plugin.

## Success criteria

- All five harnesses install MCP and hooks for user/global scope by default and project-local scope with `--local`.
- Generated configs use `agent-synctex mcp --harness <harness>` unless `--no-hooks` is requested.
- Hook helpers use `agent-synctex fetch-info --harness <harness>`.
- `get_pdf_events` is not advertised.
- `fetch_pdf_context` visibility follows runtime hook mode and install state.
- Consumed viewer marks/comments are cleared.
- `npm run check`, `npm test`, `npm pack`, and `npm publish --dry-run` pass.

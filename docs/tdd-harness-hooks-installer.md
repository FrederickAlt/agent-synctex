# TDD — Harness hooks, MCP launch modes, and installer CLI

## Target behavior

Implement the single public CLI model:

```bash
agent-synctex mcp [--harness claude|codex|cline|pi|opencode] [--no-hooks]
agent-synctex fetch-info --harness claude|codex|cline|pi|opencode
agent-synctex install [mcp|hooks] --harness <harness|all> [--local|--scope project|user] [--no-hooks]
agent-synctex uninstall --harness <harness|all> [--local|--scope project|user]
agent-synctex doctor --harness <harness|all> [--local|--scope project|user]
```

## Runtime test matrix

1. `agent-synctex mcp --no-hooks`
   - `tools/list` includes `fetch_pdf_context`.
   - `tools/list` excludes `get_pdf_events`.
   - no hook bridge discovery file is created.
2. `agent-synctex mcp --harness claude` with managed hooks installed
   - bridge discovery path uses `agent-synctex-claude`.
   - `tools/list` excludes `fetch_pdf_context` and `get_pdf_events`.
3. `agent-synctex mcp --harness claude` without managed hooks
   - `tools/list` excludes `fetch_pdf_context` and `get_pdf_events`.
   - first tool call returns the missing-hooks note once.
4. `agent-synctex mcp` without `--harness` and without `--no-hooks`
   - stderr warns on launch.
   - `tools/list` includes `fetch_pdf_context`.
   - first tool call returns the missing-harness fallback note once.
5. `agent-synctex fetch-info --harness codex`
   - reads stdin.
   - connects only to `agent-synctex-codex` bridge.
   - prints formatted context when available.
   - exits 0 with empty output when bridge is missing/unreachable.

## Context collector tests

- Produces concise Markdown:

```md
## PDF marks from the User

- `main.tex:42` — `...source line...`
  User comment: ...
```

- Deduplicates annotation updates.
- Bounds event count, source line length, comment length, and total output size.
- Clears consumed viewer marks/comments after successful collection.
- Excludes debug-only selection events from user-facing output.

## Installer test matrix

For each harness (`claude`, `codex`, `cline`, `pi`, `opencode`):

1. `install --harness <harness>` writes managed user/global MCP config and hook/plugin/extension artifacts for:
   - `agent-synctex mcp --harness <harness>`
   - `agent-synctex fetch-info --harness <harness>`
2. `install --harness <harness> --local` writes the same managed artifacts under project-local paths.
3. `install --harness <harness> --no-hooks` writes managed MCP config with `--no-hooks` and does not write hooks.
4. `install hooks --harness <harness>` upgrades an existing managed `--no-hooks` MCP config to hook-capable args.
5. Re-running install does not duplicate managed entries.
6. `uninstall --harness <harness>` removes only managed MCP/hook entries and managed files.

User-scope path coverage:

- Claude: `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/hooks/agent-synctex-fetch-info.sh`.
- Codex: `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.codex/hooks/agent-synctex-fetch-info.sh`.
- Cline: `~/.cline/data/settings/cline_mcp_settings.json` or `CLINE_MCP_SETTINGS_PATH`, `~/Documents/Cline/Hooks/UserPromptSubmit`.
- Pi: `$PI_CODING_AGENT_DIR/mcp.json` or `~/.pi/agent/mcp.json`, extension under the same agent dir.
- OpenCode: `~/.config/opencode/opencode.json`, `~/.config/opencode/plugins/agent-synctex-post-user.ts`.

## Harness-specific assertions

- Claude/Cline/Pi JSON MCP shape uses `mcpServers.agent-synctex.command = "agent-synctex"` and args `['mcp', '--harness', '<harness>']`.
- Pi MCP config also contains `"lifecycle": "keep-alive"`.
- Codex TOML MCP shape uses `[mcp_servers.agent-synctex]` with command `agent-synctex`.
- OpenCode MCP shape uses `mcp.agent-synctex.command = ['agent-synctex', 'mcp', '--harness', 'opencode']`.
- OpenCode plugin uses deterministic `chat.message` mutation.
- Pi extension uses `before_agent_start`.

## Packaging checks

- `package.json` bin exposes only `agent-synctex`.
- `npm pack` contains `dist/scripts/agent-synctex.js` and not old public MCP entrypoints.
- Generated tarball is publishable with `npm publish --dry-run`.

## Verification commands

```bash
npm run check
npm test
npm pack
npm publish --dry-run
```

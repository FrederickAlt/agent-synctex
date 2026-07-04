# PRD — Harness hooks, MCP launch modes, and installer CLI

## Status

Draft.

## Problem

Agent SyncTeX currently exposes PDF viewer events through an agent-callable tool (`get_pdf_events`). That works but is a poor default UX:

- agents must remember to poll for marks/comments;
- the event tool is advertised even when hooks can inject context automatically;
- users need per-harness setup instructions;
- uninstalling hook/config edits manually is error-prone.

We need a bundled install flow for five harnesses:

- Claude Code
- Codex CLI
- Cline
- Pi
- OpenCode

The install flow must support:

1. installing MCP config without hooks;
2. later installing post-user-message hooks;
3. uninstalling all managed integration files/config for one harness or all harnesses.

## Goals

- Provide a two-stage installer:
  - **Stage 1:** install MCP config only.
  - **Stage 2:** install harness post-user-message hooks/plugins/extensions.
- Add an MCP launch mode flag:
  - default/no flag: pure MCP mode, graceful without hooks;
  - `--with-hooks`: hook-aware mode, used by installer when hooks are configured.
- In pure MCP mode, advertise a manual context-fetch tool so a non-hook MCP setup still works.
- In hook-aware mode, do not advertise the manual context-fetch tool; hooks inject context automatically.
- Remove the old raw event tool surface (`get_pdf_events`) from normal advertised tools.
- Support atomic per-harness uninstall: remove both MCP config and hooks for the selected harness.
- Keep edits idempotent, reversible, and limited to managed entries.

## Non-goals

- Do not build separate package-manager uninstall hooks. Package managers remove package files; our CLI removes harness config.
- Do not make the model call `get_pdf_events` in hook mode.
- Do not expose raw debug `selection_debug` events through the normal user-facing manual context tool.
- Do not require users to install all five harness integrations.

## User flows

### Stage 1: MCP only

```bash
agent-synctex install mcp --harness claude
```

Result:

- Claude MCP config is installed.
- MCP command is launched without `--with-hooks`.
- MCP advertises normal TeX/PDF tools plus a bounded manual context tool, e.g. `fetch_pdf_context`.
- No prompt hook is installed.

### Stage 2: hooks

```bash
agent-synctex install hooks --harness claude
```

Result:

- Claude `UserPromptSubmit` hook is installed.
- Claude MCP config is updated to include `--with-hooks`.
- MCP no longer advertises the manual context-fetch tool.
- The hook calls `agent-synctex fetch-info` on every user prompt.
- `fetch-info` returns empty output if no context/runtime is available.

### Uninstall per harness

```bash
agent-synctex uninstall --harness claude
```

Result:

- Managed Claude MCP config entry is removed.
- Managed Claude hook entry/script is removed.
- Other Claude settings remain untouched.

### Uninstall all managed harnesses

```bash
agent-synctex uninstall --harness all
npm uninstall -g agent-synctex
```

`agent-synctex uninstall --harness all` must remove all managed MCP config and hook artifacts before the package itself is removed.

## CLI surface

```bash
agent-synctex install mcp [--harness auto|all|claude|codex|cline|pi|opencode] [--scope project|user] [--dry-run] [--yes]
agent-synctex install hooks [--harness auto|all|claude|codex|cline|pi|opencode] [--scope project|user] [--dry-run] [--yes]
agent-synctex uninstall [--harness auto|all|claude|codex|cline|pi|opencode] [--dry-run] [--yes]
agent-synctex doctor [--harness auto|all|claude|codex|cline|pi|opencode]
agent-synctex fetch-info
tex-actions-mcp [--with-hooks]
```

Aliases may be supported:

```bash
agent-synctex uninstall claude
agent-synctex uninstall all
```

## MCP launch modes

### Default pure MCP mode

Command:

```bash
tex-actions-mcp
```

Behavior:

- Advertise normal MCP tools:
  - `show_latex`
  - `compile_latex_file`
  - `open_pdf`
  - `jump_pdf`
  - `set_latex_preamble`
- Advertise one bounded manual context tool, suggested name:
  - `fetch_pdf_context`
- Do not advertise `get_pdf_events`.
- `fetch_pdf_context` drains marks/comments, formats user-facing context, clears consumed viewer annotations, and returns text to the agent.

Rationale: the trivial MCP command works gracefully even when no harness hook is configured.

### Hook-aware mode

Command:

```bash
tex-actions-mcp --with-hooks
```

Behavior:

- Advertise normal TeX/PDF tools only.
- Do not advertise manual `fetch_pdf_context`.
- Start or register a local private hook bridge used by `agent-synctex fetch-info`.
- Hook bridge must be discoverable by the hook helper, for example through a runtime file containing URL/token.
- Hook bridge must not be listed in `tools/list`.

Rationale: once hooks are installed, context is injected before the model turn and should not appear as an agent-callable tool.

## Shared context behavior

Both `fetch_pdf_context` and hook-driven `fetch-info` must use the same internal collector and formatter.

Required behavior:

- Drain pending Viewer Host events.
- Include user-facing PDF marks/comments:
  - `pdf_annotation` events with source location, attached LaTeX source line, and comment;
  - optionally explicit marked clicks/selections if the viewer records them as user marks.
- The injected block must clearly identify itself as MCP/hook-provided PDF context and distinguish user-authored comments from fetched source metadata.
- Every context item with a source location must cite the exact LaTeX location as `source_file:line` and quote the attached source-line excerpt when available.
- Exclude `selection_debug` by default.
- Deduplicate annotation updates by `(pdf_id, annotation_id)` and keep the latest data.
- Format concise Markdown context.
- Enforce bounds on event count, comment length, source-line length, and total output size.
- Clear consumed annotations from the viewer after successful collection.
- Return empty text when no context exists.

Suggested output:

```md
## PDF marks from Agent SyncTeX

- `main.tex:42` — `E = mc^2`
  User comment: Check notation here.
```

## Harness hook behavior

### Claude Code

Install:

- `.claude/settings.json` or `.claude/settings.local.json`
- `.claude/hooks/user-prompt-mcp.sh`

Hook:

- event: `UserPromptSubmit`
- command calls `agent-synctex fetch-info`
- output uses `hookSpecificOutput.additionalContext`

### Codex CLI

Install:

- `.codex/hooks.json`
- `.codex/hooks/user-prompt-mcp.sh`

Hook:

- event: `UserPromptSubmit`
- command calls `agent-synctex fetch-info`
- output uses `hookSpecificOutput.additionalContext`
- user must trust project hooks via `/hooks`

### Cline

Install:

- `.clinerules/hooks/UserPromptSubmit`

Hook:

- executable file, no extension
- command calls `agent-synctex fetch-info`
- output uses `contextModification`

### Pi

Install:

- project-local `.pi/extensions/agent-synctex-post-user.ts`

Pi uses a standalone extension wrapper because Pi prompt hooks are exposed through extensions. The generated extension calls `agent-synctex fetch-info`, which communicates with the hook-aware MCP bridge.

Hook:

- event: `before_agent_start`
- injects `{ message: { customType: "pdf-viewer-context", content, display: true } }`

### OpenCode

Install:

- `.opencode/plugins/agent-synctex-post-user.ts`

Hook:

- `chat.message`
- mutate `output.parts`
- append a text `Part` with `id`, `messageID`, `sessionID`, `type: "text"`, `text`, and optional `time`

DeepWiki for `anomalyco/opencode` confirmed `chat.message` is triggered from `SessionPrompt.prompt` before onward LLM processing.

## Detection rules

`--harness auto` should detect project files first, then binaries/configs:

- Claude Code: `.claude/`, Claude MCP config, `claude` on `PATH`
- Codex CLI: `.codex/`, Codex config, `codex` on `PATH`
- Cline: `.clinerules/`, known Cline config paths
- Pi: `.pi/`, `pi` on `PATH`
- OpenCode: `opencode.jsonc`, `.opencode/`, `opencode` on `PATH`

If multiple harnesses are detected and `--yes` is not supplied, prompt the user. In non-interactive mode, require `--harness` or fail with a clear message.

## Install safety

The installer must be:

- idempotent;
- manifest-backed;
- backup-backed for edited config files;
- non-destructive;
- dry-run capable;
- explicit about ambiguous harness detection.

Manifest path:

```text
.agent-synctex/install-manifest.json
```

The manifest should record:

- harness;
- scope;
- installed MCP config paths/managed keys;
- installed hook paths/managed keys;
- MCP command/args, including `--with-hooks` when hooks are installed;
- backup paths;
- version of installer that wrote the entries.

## Success criteria

- Stage 1 MCP install works without hooks and exposes manual `fetch_pdf_context`.
- Stage 2 hook install updates MCP launch args to `--with-hooks` and installs the correct harness hook.
- Hook-injected context appears in the current prompt/turn for all five harnesses.
- Consumed viewer annotations disappear after injection/fetch.
- `get_pdf_events` is not advertised in normal tools.
- Uninstall removes both MCP config and hook artifacts for the chosen harness.
- Re-running install/uninstall is safe and does not duplicate or remove unrelated user config.

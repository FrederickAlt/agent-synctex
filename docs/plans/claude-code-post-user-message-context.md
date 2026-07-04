# Claude Code plan — post-user-message PDF context injection

## Target behavior

Use Claude Code `UserPromptSubmit` to inject consumed PDF viewer marks/comments into the same turn before the model sees the user prompt. The hook must not expose `get_pdf_events` as an agent tool.

## Recommended route

Use a command hook that calls the shared helper:

```text
Claude Code UserPromptSubmit -> .claude/hooks/user-prompt-mcp.sh -> scripts/mcp-fetch-info -> private/internal context collection -> viewer clear
```

This is preferred over calling the primary TeX Actions MCP directly because `get_pdf_events` is being removed from the advertised tool surface. A Claude `mcp_tool` hook remains acceptable only if it points at a separate context MCP server/tool named `fetch_info`, not at the main TeX Actions tool list.

## Files to add in consuming projects

### `.claude/settings.json` or `.claude/settings.local.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/user-prompt-mcp.sh",
            "args": [],
            "timeout": 10,
            "statusMessage": "Fetching PDF viewer context"
          }
        ]
      }
    ]
  }
}
```

### `.claude/hooks/user-prompt-mcp.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
prompt="$(jq -r '.prompt // ""' <<<"$payload")"
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"

context="$(printf '%s' "$prompt" | "$root/scripts/mcp-fetch-info" 2>/tmp/claude-mcp-hook.err || true)"
[ -z "$context" ] && exit 0

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
```

Then:

```bash
chmod +x .claude/hooks/user-prompt-mcp.sh
```

## Optional `mcp_tool` route

Only use this if a separate already-connected context MCP server is configured in Claude Code:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "tex_actions_context",
            "tool": "fetch_info",
            "input": { "prompt": "${prompt}" },
            "timeout": 10,
            "statusMessage": "Fetching PDF viewer context"
          }
        ]
      }
    ]
  }
}
```

The `fetch_info` result should return plain text or:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

## Implementation notes

- `UserPromptSubmit` has no matcher; keep the helper cheap and bounded.
- The hook should tolerate missing MCP/viewer state and continue with empty output.
- Do not configure the hook to call `get_pdf_events`; that tool should no longer be listed or callable as a supported public tool.
- Context text should be short and should not include secrets or full source files.

## Verification

- In Claude Code, run `/hooks` or inspect hook status to confirm the hook is loaded.
- Mark/comment a PDF region, submit a prompt, and confirm injected context appears in the turn.
- Confirm viewer annotations are cleared after injection.
- Confirm `tools/list` for the primary TeX Actions MCP does not advertise `get_pdf_events`.

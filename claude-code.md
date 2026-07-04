# Claude Code — after-user-prompt MCP context hook

## Status

**Native and recommended.** Claude Code has `UserPromptSubmit`, and it can inject context before the prompt is sent to the model. It also has an `mcp_tool` hook type that calls an already-connected MCP server.

## Shared helper contract

All examples call a project helper named `scripts/mcp-fetch-info`.

Expected behavior:

```text
stdin:  raw user prompt
stdout: context text to inject, or empty output if unavailable
exit:   0 even when the MCP is unavailable, unless you intentionally want to fail the hook
```

Implement it either as an MCP SDK client that connects to the same server and calls your tool, or as a tiny local HTTP sidecar that already owns the MCP connection and exposes one deterministic endpoint such as `POST /fetch_info`.


## Option A: call the already-connected MCP directly

Put this in `.claude/settings.json` or `.claude/settings.local.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "my_context_mcp",
            "tool": "fetch_info",
            "input": {
              "prompt": "${prompt}"
            },
            "timeout": 10,
            "statusMessage": "Fetching MCP context"
          }
        ]
      }
    ]
  }
}
```

Your MCP tool should return either plain text or this structured JSON as text content:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "context returned by fetch_info"
  }
}
```

If the MCP server is not connected, Claude reports a non-blocking hook error and continues.

## Option B: command hook that calls your helper

Use this when your hook needs custom connection checks or sidecar logic.

`.claude/settings.json`:

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
            "statusMessage": "Fetching MCP context"
          }
        ]
      }
    ]
  }
}
```

`.claude/hooks/user-prompt-mcp.sh`:

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

## Notes

- `UserPromptSubmit` has no matcher support; it fires on every user prompt.
- Keep output short. This text is inserted into the model context.
- Prefer `mcp_tool` when your target MCP is already configured in Claude Code.

## Sources

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide

# Codex CLI plan — post-user-message PDF context injection

## Target behavior

Use Codex CLI `UserPromptSubmit` to inject consumed PDF viewer marks/comments into the same turn. Codex hooks are command hooks, so the hook calls the shared helper.

## Route

```text
Codex CLI UserPromptSubmit -> .codex/hooks/user-prompt-mcp.sh -> scripts/mcp-fetch-info -> private/internal context collection -> viewer clear
```

## Files to add in consuming projects

### `.codex/hooks.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash .codex/hooks/user-prompt-mcp.sh",
            "timeout": 10,
            "statusMessage": "Fetching PDF viewer context"
          }
        ]
      }
    ]
  }
}
```

### `.codex/hooks/user-prompt-mcp.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
prompt="$(jq -r '.prompt // ""' <<<"$payload")"
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

context="$(printf '%s' "$prompt" | "$root/scripts/mcp-fetch-info" 2>/tmp/codex-mcp-hook.err || true)"
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
chmod +x .codex/hooks/user-prompt-mcp.sh
```

## Trust step

Project-local Codex hooks require trust. In Codex, open:

```text
/hooks
```

Review and trust the hook source.

## Implementation notes

- Codex does not currently need or use a native `mcp_tool` hook here.
- The command runs with the session `cwd`; resolving `git rev-parse --show-toplevel` makes the example robust when launched from subdirectories.
- The helper must exit 0 with empty stdout when the viewer/MCP is unavailable.
- Do not rely on `get_pdf_events`; it should be removed from the public TeX Actions MCP tool surface.

## Verification

- Confirm Codex lists and trusts the hook under `/hooks`.
- Mark/comment a PDF region, submit a prompt, and confirm the model receives the injected PDF context.
- Confirm viewer marks/comments are cleared after injection.
- Confirm `tools/list` for the TeX Actions MCP does not include `get_pdf_events`.

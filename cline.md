# Cline — after-user-prompt MCP context hook

## Status

**Native.** Cline hooks include `UserPromptSubmit`, and hook output can use `contextModification` to inject text into the conversation.

## Shared helper contract

All examples call a project helper named `scripts/mcp-fetch-info`.

Expected behavior:

```text
stdin:  raw user prompt
stdout: context text to inject, or empty output if unavailable
exit:   0 even when the MCP is unavailable, unless you intentionally want to fail the hook
```

Implement it either as an MCP SDK client that connects to the same server and calls your tool, or as a tiny local HTTP sidecar that already owns the MCP connection and exposes one deterministic endpoint such as `POST /fetch_info`.


## Project hook

Create a project-local hook file named exactly:

```text
.clinerules/hooks/UserPromptSubmit
```

No extension. Make it executable.

```bash
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
root="$(jq -r '.workspaceRoots[0] // .workspace_roots[0] // env.PWD' <<<"$payload")"
prompt="$(jq -r '.prompt // .userPrompt // .message // ""' <<<"$payload")"

context="$(printf '%s' "$prompt" | "$root/scripts/mcp-fetch-info" 2>/tmp/cline-mcp-hook.err || true)"

if [ -z "$context" ]; then
  printf '{"cancel":false}
'
else
  jq -n --arg ctx "$context" '{
    cancel: false,
    contextModification: $ctx
  }'
fi
```

Then:

```bash
chmod +x .clinerules/hooks/UserPromptSubmit
```

## Optional global hook

For a global installation, use:

```text
~/Documents/Cline/Rules/Hooks/UserPromptSubmit
```

## MCP setup

Configure your MCP in Cline as usual, but do not assume the hook can reuse Cline's in-process MCP client. The most robust pattern is still:

```text
Cline hook -> scripts/mcp-fetch-info -> MCP SDK client or local sidecar -> fetch_info
```

## Notes

- The Bash example assumes macOS/Linux. On Windows, use a Node or PowerShell script with the same stdin/stdout contract.
- Keep injected context bounded; hooks can silently bloat the chat.
- If your Cline version exposes a different JSON field name for the prompt, inspect the hook payload once by logging `payload` to a temp file.

## Sources

- https://cline.bot/blog/cline-v3-36-hooks
- https://docs.cline.bot/customization/hooks
- https://docs.cline.bot/mcp/mcp-overview

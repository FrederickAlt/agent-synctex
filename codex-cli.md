# Codex CLI — after-user-prompt MCP context hook

## Status

**Native for current-turn injection.** Codex CLI supports `UserPromptSubmit`; plain stdout or `hookSpecificOutput.additionalContext` is added as extra context before the prompt proceeds. Current Codex exposes `additionalContext` only as a string and chooses the injected message role itself, so Agent SyncTeX cannot force it to be a `user` message from the hook output. Current Codex hooks are command hooks, so the hook itself must call your helper or sidecar.

## Shared helper contract

All examples call a project helper named `scripts/mcp-fetch-info`.

Expected behavior:

```text
stdin:  raw user prompt
stdout: context text to inject, or empty output if unavailable
exit:   0 even when the MCP is unavailable, unless you intentionally want to fail the hook
```

Implement it either as an MCP SDK client that connects to the same server and calls your tool, or as a tiny local HTTP sidecar that already owns the MCP connection and exposes one deterministic endpoint such as `POST /fetch_info`.


## Hook config

Create `.codex/hooks.json`:

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
            "statusMessage": "Fetching MCP context"
          }
        ]
      }
    ]
  }
}
```

Create `.codex/hooks/user-prompt-mcp.sh`:

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

Project-local Codex hooks run only after the project hook source is trusted. In Codex, open:

```text
/hooks
```

Review and trust the hook.

## Notes

- `UserPromptSubmit` ignores `matcher`.
- Commands run with the session `cwd`. The example assumes Codex is launched from the repo root; if you launch from subdirectories, use an absolute command path or a small wrapper that resolves `git rev-parse --show-toplevel`.
- Codex does not currently have a native `mcp_tool` hook type, so use your own MCP client/sidecar in `scripts/mcp-fetch-info`.

## Sources

- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/config

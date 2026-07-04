# Cline plan — post-user-message PDF context injection

## Target behavior

Use Cline `UserPromptSubmit` hooks to inject consumed PDF viewer marks/comments into the current conversation turn through `contextModification`.

## Route

```text
Cline UserPromptSubmit -> .clinerules/hooks/UserPromptSubmit -> scripts/mcp-fetch-info -> private/internal context collection -> viewer clear
```

## Files to add in consuming projects

Create a project-local hook file named exactly:

```text
.clinerules/hooks/UserPromptSubmit
```

No file extension. Make it executable.

```bash
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
root="$(jq -r '.workspaceRoots[0] // .workspace_roots[0] // env.PWD' <<<"$payload")"
prompt="$(jq -r '.prompt // .userPrompt // .message // ""' <<<"$payload")"

context="$(printf '%s' "$prompt" | "$root/scripts/mcp-fetch-info" 2>/tmp/cline-mcp-hook.err || true)"

if [ -z "$context" ]; then
  printf '{"cancel":false}\n'
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

Prefer project-local hooks when the helper path and host-service socket are project-specific.

## MCP setup

Configure the TeX Actions MCP server in Cline as usual for compile/open/jump tools. The hook should not assume it can reuse Cline's in-process MCP client. The robust path remains:

```text
Cline hook -> scripts/mcp-fetch-info -> internal host-service/context API -> fetch and clear viewer annotations
```

## Implementation notes

- The Bash hook assumes macOS/Linux. On Windows, provide a Node or PowerShell equivalent with the same stdin/stdout contract.
- If a Cline version changes the prompt payload shape, log the hook payload once to a temp file and update the prompt extraction fallback.
- Keep injected context bounded; Cline will insert it into the chat.
- Do not call or advertise `get_pdf_events` to the model.

## Verification

- Submit a prompt with no PDF marks; the hook should return `{"cancel":false}` and not block.
- Mark/comment a PDF region, submit a prompt, and verify `contextModification` contains the formatted viewer context.
- Confirm viewer marks/comments are cleared after injection.
- Confirm the primary MCP tool list no longer includes `get_pdf_events`.

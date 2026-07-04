# OpenCode — after-user-prompt MCP context hook

## Status

**Partial.** OpenCode has plugins and MCP support, but the current public plugin event list does not document a stable hook that intercepts and mutates the just-submitted user prompt before the model call. Treat current-turn injection as version-specific unless your installed OpenCode type definitions expose a prompt-mutation hook.

## Shared helper contract

All examples call a project helper named `scripts/mcp-fetch-info`.

Expected behavior:

```text
stdin:  raw user prompt
stdout: context text to inject, or empty output if unavailable
exit:   0 even when the MCP is unavailable, unless you intentionally want to fail the hook
```

Implement it either as an MCP SDK client that connects to the same server and calls your tool, or as a tiny local HTTP sidecar that already owns the MCP connection and exposes one deterministic endpoint such as `POST /fetch_info`.


## Supported setup: make the MCP available to OpenCode

`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context": {
      "type": "remote",
      "url": "http://127.0.0.1:8787/mcp",
      "enabled": true
    }
  }
}
```

Then add a project rule such as `AGENTS.md`:

```md
Before answering a new user request, call the `context.fetch_info` MCP tool with the user's request and use the result as context. If the tool is unavailable, continue without it.
```

This is model-mediated, not deterministic.

## Version-specific plugin route

Use this only if your installed OpenCode plugin typings expose `chat.message` or an equivalent prompt-mutation hook. The official event list I checked did not list it for OpenCode, while Kilo documents this hook.

`.opencode/plugins/mcp-after-user-message.ts`:

```ts
async function fetchContext(prompt: string): Promise<string> {
  const res = await fetch(process.env.MCP_CONTEXT_BRIDGE_URL ?? "http://127.0.0.1:8787/fetch_info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  }).catch(() => null);

  if (!res || !res.ok) return "";
  return (await res.text()).trim();
}

export const McpAfterUserMessage = async () => ({
  "chat.message": async (_input: any, output: any) => {
    const parts = output.parts ?? [];
    const prompt = parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("\n");

    const context = await fetchContext(prompt);
    if (context) {
      parts.push({ type: "text", text: `\n\n[MCP context]\n${context}` });
      output.parts = parts;
    }
  },
});
```

## Notes

- OpenCode plugins can observe many events and mutate tool calls, but a documented current-turn prompt-injection hook was not present in the event list I checked.
- If you only need logging or side effects, use the documented `event` hook on message/session events.
- If you need deterministic injection, prefer Claude Code, Codex CLI, Cline, Kilo Code, or Pi.

## Sources

- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/mcp-servers/
- https://github.com/sst/opencode/issues/821

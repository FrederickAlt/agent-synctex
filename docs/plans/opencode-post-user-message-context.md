# OpenCode plan — post-user-message PDF context injection

## Target behavior

Inject consumed PDF viewer marks/comments into the current OpenCode turn and clear the consumed viewer annotations.

DeepWiki for `anomalyco/opencode` confirms the relevant hook is `chat.message`: it is triggered from `SessionPrompt.prompt` after resolving user message parts and before those parts are saved/sent onward to the LLM. The hook receives mutable `output.message` and `output.parts`, so appending a text part is the deterministic OpenCode integration route.

## Route

```text
OpenCode chat.message plugin hook -> HTTP/helper fetch_info -> private/internal context collection -> viewer clear -> append context part
```

## Plugin loading

Local plugins are auto-loaded from:

- `.opencode/plugins/` for project plugins
- `~/.config/opencode/plugins/` for global plugins

No `opencode.jsonc` plugin entry is required for a plain local plugin file. If the plugin needs npm dependencies, add them under `.opencode/package.json`; OpenCode can install them at startup.

## Deterministic plugin route

### `.opencode/plugins/mcp-after-user-message.ts`

```ts
async function fetchContext(prompt: string): Promise<string> {
  const endpoint = process.env.MCP_CONTEXT_BRIDGE_URL ?? "http://127.0.0.1:8787/fetch_info";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  }).catch(() => null);

  if (!res || !res.ok) return "";
  return (await res.text()).trim();
}

export const McpAfterUserMessage = async () => ({
  "chat.message": async (input: any, output: any) => {
    const parts = output.parts ?? [];
    const prompt = parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text ?? "")
      .join("\n");

    const context = await fetchContext(prompt);
    if (!context) return;

    const now = Date.now();
    parts.push({
      id: `pdf-viewer-context-${now}`,
      messageID: input.messageID ?? output.message?.id,
      sessionID: input.sessionID,
      type: "text",
      text: `\n\n[PDF viewer context]\n${context}`,
      time: { start: now, end: now },
    });
    output.parts = parts;
  },
});
```

A text `Part` should include `id`, `messageID`, `sessionID`, `type: "text"`, and `text`; `time` is optional but included here.

## Helper/sidecar requirement

OpenCode plugins run inside OpenCode, not as stdin/stdout command hooks. Use one of these shared bridges:

1. A local HTTP sidecar exposing `POST /fetch_info` and internally calling the shared collection API.
2. A tiny wrapper endpoint around `scripts/mcp-fetch-info`.
3. A separate context MCP server if OpenCode plugin code can call it reliably.

Do not call `get_pdf_events`; the primary TeX Actions MCP tool surface should not advertise it.

## Verification

- Put the plugin in `.opencode/plugins/mcp-after-user-message.ts` and restart OpenCode.
- Mark/comment a PDF region.
- Submit a prompt.
- Confirm the plugin appends a `[PDF viewer context]` text part to the user message.
- Confirm viewer annotations clear after context is fetched.
- Confirm the primary MCP tool list does not include `get_pdf_events`.

## Sources checked

DeepWiki for `anomalyco/opencode` reports:

- `chat.message` is defined in `packages/plugin/src/index.ts` as a hook receiving `output: { message: UserMessage; parts: Part[] }`.
- It is triggered from `packages/opencode/src/session/prompt.ts` during `SessionPrompt.prompt`, after message part resolution and before onward processing.
- Local plugin files in `.opencode/plugins/` and `~/.config/opencode/plugins/` are auto-loaded.
- Text parts require `id`, `messageID`, `sessionID`, `type`, and `text`; `time` is optional/recommended.

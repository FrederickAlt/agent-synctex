# Pi — after-user-prompt MCP context hook

## Status

**Native and recommended.** Pi extensions support `before_agent_start`, fired after the user submits a prompt and before the agent loop. The handler can inject a persistent message sent to the LLM.

## Shared helper contract

All examples call a project helper named `scripts/mcp-fetch-info`.

Expected behavior:

```text
stdin:  raw user prompt
stdout: context text to inject, or empty output if unavailable
exit:   0 even when the MCP is unavailable, unless you intentionally want to fail the hook
```

Implement it either as an MCP SDK client that connects to the same server and calls your tool, or as a tiny local HTTP sidecar that already owns the MCP connection and exposes one deterministic endpoint such as `POST /fetch_info`.


## Project extension

Create `.pi/extensions/mcp-after-user.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { join } from "node:path";

function runHelper(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const helper = join(cwd, "scripts", "mcp-fetch-info");
    const child = spawn(helper, [], { cwd, stdio: ["pipe", "pipe", "ignore"] });

    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("");
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve(stdout.trim());
    });

    child.stdin.end(prompt);
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const content = await runHelper(ctx.cwd, event.prompt).catch(() => "");
    if (!content) return;

    return {
      message: {
        customType: "mcp-context",
        content,
        display: true,
      },
    };
  });
}
```

Then reload Pi:

```text
/reload
```

## Direct MCP variant

If your MCP is remote HTTP, you can skip `scripts/mcp-fetch-info` and call the sidecar endpoint directly from the extension:

```ts
const res = await fetch("http://127.0.0.1:8787/fetch_info", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: event.prompt }),
});
```

## Notes

- Project extensions live in `.pi/extensions/` and can be hot-reloaded with `/reload`.
- `before_agent_start` can return a `message` and/or modify `systemPrompt`.
- The injected message is stored in the session, so avoid secrets unless that is intended.

## Sources

- https://pi.dev/docs/latest/extensions

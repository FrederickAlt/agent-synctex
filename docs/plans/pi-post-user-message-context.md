# Pi plan — post-user-message PDF context injection

## Target behavior

Use Pi `before_agent_start` to inject consumed PDF viewer marks/comments into the same turn after the user submits a prompt and before the agent loop starts.

## Route

For this repository's Pi extension, prefer direct registration in the existing composition root:

```text
Pi before_agent_start -> src/modules/pi_extension/post_user_message_context.ts -> private/internal context collection -> viewer clear -> injected Pi message
```

A project-local `.pi/extensions/mcp-after-user.ts` helper remains useful for external consumers, but the built-in support for this package should live in `index.ts` alongside the existing tool/lifecycle registrations.

## Repo implementation plan

### 1. Update Pi runtime typings

`types/pi-extension-runtime.d.ts` currently declares only `session_start` and `session_shutdown` on `ExtensionAPI`. Add the `before_agent_start` event shape used by Pi docs:

```ts
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: unknown[];
  systemPrompt: string;
  systemPromptOptions?: unknown;
}

export interface ExtensionAPI {
  // existing overloads...
  on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown): void;
}
```

Match this repo's current package name (`@mariozechner/pi-coding-agent`) unless the project is deliberately migrated to the package name in upstream docs (`@earendil-works/pi-coding-agent`).

### 2. Add a Pi extension module

Create `src/modules/pi_extension/post_user_message_context.ts`:

- export `registerPostUserMessageContext(pi: ExtensionAPI): void`;
- subscribe to `pi.on("before_agent_start", async (event, ctx) => { ... })`;
- collect context through the shared internal API or through `scripts/mcp-fetch-info`;
- return nothing if context is empty;
- return an injected message when context exists:

```ts
return {
  message: {
    customType: "pdf-viewer-context",
    content,
    display: true,
  },
};
```

### 3. Register it in the composition root

Update `index.ts`:

```ts
import { registerPostUserMessageContext } from "./src/modules/pi_extension/post_user_message_context.ts";

export default function (pi: ExtensionAPI): void {
  // existing init...
  registerPostUserMessageContext(pi);
}
```

Keep `index.ts` as the composition root and do not move host/runtime protocol code into the Pi adapter.

### 4. Collection strategy

Preferred: call a shared TypeScript function or private host-service operation directly, so Pi does not spawn a shell for every prompt.

Fallback: call the same helper used by command-hook harnesses:

```ts
import { spawn } from "node:child_process";
import { join } from "node:path";

// stdin = event.prompt, stdout = injected context, timeout < 10s
```

The direct strategy should still preserve the helper contract for the other harnesses.

### 5. Message content

Use the shared formatter from `docs/plans/shared-post-user-message-context.md`. Keep it compact and LLM-oriented:

```md
## PDF viewer context

- `main.tex:42` — PDF page 3
  Source: `...`
  User comment: ...
```

## External project-local extension option

For projects that cannot use this package's built-in Pi extension, create `.pi/extensions/mcp-after-user.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { join } from "node:path";

function runHelper(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const helper = join(cwd, "scripts", "mcp-fetch-info");
    const child = spawn(helper, [], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(""); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => { clearTimeout(timeout); resolve(""); });
    child.on("close", () => { clearTimeout(timeout); resolve(stdout.trim()); });
    child.stdin.end(prompt);
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const content = await runHelper(ctx.cwd, event.prompt).catch(() => "");
    if (!content) return;
    return { message: { customType: "pdf-viewer-context", content, display: true } };
  });
}
```

Then run `/reload` in Pi.

## Verification

- `npm run check` validates the new event typings and registration.
- Pi manual smoke:
  - open a PDF;
  - create a viewer annotation/comment;
  - submit a prompt;
  - confirm a `pdf-viewer-context` message appears before the agent response;
  - confirm viewer annotations are cleared.
- Confirm `get_pdf_events` is no longer in the MCP tool list advertised to Pi/agents.

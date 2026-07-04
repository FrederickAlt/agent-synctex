# Shared plan — post-user-message PDF context injection

## Goal

On every supported harness user-prompt event, collect the PDF viewer context the user intentionally marked, inject a short message into the current agent turn, and clear the consumed marks/comments from the viewer. Also remove `get_pdf_events` from the public agent-visible tool surface.

Supported harnesses consuming this shared behavior:

- Claude Code
- Codex CLI
- Cline
- Pi
- OpenCode, with the caveats in `docs/plans/opencode-post-user-message-context.md`

## Current repo seams

- Public MCP tools are defined in `src/modules/host_service_mcp.ts`; `get_pdf_events` is currently advertised in `mcpToolDescriptions()` and included in `HOST_SERVICE_TOOL_NAMES`.
- Stdio MCP runtime injects workspace context in `src/modules/stdio_mcp_runtime.ts`.
- Viewer events are stored in `src/modules/pdf_events.ts` and drained through `ViewerHostMcpService.getPdfEvents()` in `src/modules/viewer_host_client.ts`.
- Viewer annotations already exist in `src/viewer_lw/host_lw_adapter.mjs` as in-memory overlays/comments and are emitted as `pdf_annotation` viewer messages.
- `host_lw_adapter.mjs` already has a local `clearAnnotations()` function, but no host protocol command currently calls it.

## Product behavior

1. User marks text/location in the PDF viewer and optionally adds a comment.
2. User submits the next prompt in a supported harness.
3. The harness hook calls the shared fetch helper.
4. The helper drains pending viewer events, formats them as bounded Markdown context, and clears the consumed annotations from the viewer.
5. If no context is available or the viewer/MCP is unavailable, the hook returns no injected context and the user prompt proceeds normally.
6. The agent should not see or be advertised a `get_pdf_events` tool.

## Shared implementation plan

### 1. Remove `get_pdf_events` from the public tool surface

- In `src/modules/host_service_mcp.ts`:
  - Remove the `get_pdf_events` entry from `mcpToolDescriptions()`.
  - Remove `"get_pdf_events"` from `HOST_SERVICE_TOOL_NAMES`.
  - Remove it from the `toolHandlers` dispatch map.
  - Leave reusable parsing/formatting code only if it is needed by internal helpers; otherwise delete it with tests.
- Update documentation:
  - `README.md`
  - `CONTEXT.md`
- Update tests:
  - `test/modules/mcp_tool_surface_v1.test.ts`
  - `test/modules/stdio_mcp_runtime.test.ts`
  - any tests that currently call `tools/call get_pdf_events` should move to the new internal collection API or host helper path.

Acceptance: `tools/list` no longer contains `get_pdf_events`, and `tools/call` returns the normal unimplemented-tool response.

### 2. Add a shared internal collection API

Create a module such as `src/modules/post_user_pdf_context.ts` with these responsibilities:

- Drain pending host/viewer events.
- Select user-facing events only:
  - `pdf_annotation` for marks/comments.
  - optionally `reverse_synctex` when it represents an intentional mark/click and has useful source mapping.
  - never include `selection_debug` by default.
- Deduplicate annotation updates by `(pdf_id, annotation_id)` and keep the latest comment/source line.
- Format a concise Markdown block, for example:

```md
## PDF viewer context

- `main.tex:42` — selected from PDF page 3
  Source: `E = mc^2`
  User comment: Check notation here.
```

- Enforce bounds:
  - max events/annotations, e.g. 20.
  - max selected text/comment/source-line length.
  - total output byte/character cap.
- Return empty string if there are no relevant events.

Suggested API shape:

```ts
export interface PostUserPdfContextRequest {
  maxEvents?: number;
  clearViewer?: boolean;
  includeClicksWithoutComments?: boolean;
}

export interface PostUserPdfContextResult {
  text: string;
  pdfIds: number[];
  eventCount: number;
  cleared: boolean;
}
```

### 3. Add viewer clearing protocol

Add a host-to-viewer clear command instead of relying only on event-store unread state.

- In `src/modules/viewer_host_protocol.ts`:
  - Add an MCP/Host-to-viewer message, e.g. `{ type: "clear_pdf_annotations", pdf_id?: number }` or per-PDF `{ type: "clear_pdf_annotations", pdf_id: number }`.
  - Validate it like existing protocol messages.
- In `src/modules/viewer_host_server.ts`:
  - Accept the new control message.
  - Broadcast it to connected viewer sockets for the relevant `pdf_id` values.
  - Optionally remove matching queued `pdf_annotation` backlog entries after successful collection.
- In `src/viewer_lw/host_lw_adapter.mjs`:
  - Handle `clear_pdf_annotations` by calling the existing `clearAnnotations()`.
  - Do not send `pdf_annotation_deleted` for hook-driven clearing; clearing is consumption, not a user deletion event.

Acceptance: after the hook consumes context, existing red annotation boxes/comment bubbles disappear from the viewer.

### 4. Add helper executable

Create `scripts/mcp-fetch-info` with the shared contract from the injected harness docs:

```text
stdin:  raw user prompt
stdout: context text to inject, or empty output if unavailable
exit:   0 even when unavailable
```

Implementation options, in preference order:

1. Use a local host-service/client request that calls the internal collection API. This keeps the feature off the public MCP tool surface.
2. If the active runtime is only available through stdio MCP, add a separate private context endpoint/server rather than re-advertising `get_pdf_events`.
3. For Claude Code only, a separate already-connected context MCP server may expose `fetch_info`; do not add it to the primary TeX Actions agent tool list unless explicitly accepted.

The helper should:

- read the prompt from stdin, but not need to parse or trust it;
- apply a hard timeout, preferably below the harness hook timeout;
- swallow failures and emit empty output;
- write diagnostic details only to stderr/temp logs;
- avoid secrets and avoid including full source files.

### 5. Add host-service/internal request, if needed

If hooks need to reach a long-running daemon rather than the in-process stdio runtime, add a private host-service operation such as `get_post_user_pdf_context`.

- Add protocol request/response types in `src/modules/host_service_protocol.ts`.
- Add client method in `src/modules/host_service.ts`.
- Route it to the same shared collection API.
- Do not expose it via `tools/list`.

### 6. Verification plan

Run targeted tests first:

```bash
npm run check
node --test --test-reporter=./scripts/fail-only-test-reporter.ts \
  test/modules/mcp_tool_surface_v1.test.ts \
  test/modules/stdio_mcp_runtime.test.ts \
  test/modules/host_service_mcp_pdf_events.test.ts \
  test/modules/viewer_host_viewer_socket.test.ts \
  test/modules/viewer_host_browser.test.ts
```

Then run full verification for broad changes:

```bash
npm run verify
```

Add or update tests for:

- `get_pdf_events` absent from `tools/list`.
- internal context collection returns annotation comments and source location.
- internal context collection omits `selection_debug`.
- collection marks consumed events unread/cleared.
- viewer receives `clear_pdf_annotations` and removes overlays.
- helper exits 0 and empty when no viewer/daemon is available.

## Open decisions

- Whether plain reverse SyncTeX clicks without comments count as “marked” context. Safer default: include annotations/comments; include clicks only if explicitly marked by viewer UI.
- Whether context should be injected before the user message or appended after it. Harnesses differ; use the native current-turn injection point where available.
- Whether a separate context-only MCP server is worth supporting for Claude `mcp_tool`. Default plan: command hooks call `scripts/mcp-fetch-info` to keep the main tool surface clean.

# TDD — Harness hooks, MCP launch modes, and installer CLI

## Status

Draft.

## Related PRD

- `docs/prd-harness-hooks-installer.md`
- Existing hook plans under `docs/plans/`:
  - `docs/plans/shared-post-user-message-context.md`
  - `docs/plans/claude-code-post-user-message-context.md`
  - `docs/plans/codex-cli-post-user-message-context.md`
  - `docs/plans/cline-post-user-message-context.md`
  - `docs/plans/pi-post-user-message-context.md`
  - `docs/plans/opencode-post-user-message-context.md`

## Architecture overview

Add three cooperating pieces:

1. **MCP launch-mode support**
   - default pure MCP mode advertises a manual `fetch_pdf_context` tool;
   - `--with-hooks` hides that tool and enables the private hook bridge.
2. **Shared context collector**
   - drains viewer events;
   - formats marks/comments;
   - clears consumed viewer annotations.
3. **Installer CLI**
   - installs MCP config;
   - installs harness hooks and updates MCP args to `--with-hooks`;
   - uninstalls both MCP config and hooks per harness.

## Proposed files

```text
scripts/agent-synctex.ts
scripts/mcp-fetch-info.ts              # optional compatibility wrapper to CLI fetch-info

src/modules/post_user_pdf_context.ts
src/modules/hook_context_bridge.ts
src/modules/installer/
  cli.ts
  detect_harnesses.ts
  manifest.ts
  config_edit.ts
  jsonc_edit.ts
  shell_quote.ts
  adapters/
    claude.ts
    codex.ts
    cline.ts
    pi.ts
    opencode.ts
```

`package.json` should expose bins similar to:

```json
{
  "bin": {
    "tex-actions-mcp": "scripts/tex-actions-mcp.ts",
    "agent-synctex": "scripts/agent-synctex.ts"
  }
}
```

## MCP launch-mode design

### CLI arg parsing

Update `scripts/tex-actions-mcp.ts` to parse:

```bash
tex-actions-mcp --with-hooks
tex-actions-mcp --help
```

Pass the mode into `startTexActionsStdioMcpRuntime({ hooksEnabled: true })`.

Add to `TexActionsStdioMcpRuntimeOptions`:

```ts
hooksEnabled?: boolean;
```

### Tool surface

Update `src/modules/host_service_mcp.ts` to accept tool-surface options, e.g.:

```ts
export interface HostServiceMcpOptions {
  hooksEnabled?: boolean;
}
```

Then route `tools/list` and `tools/call` through a mode-aware tool registry:

- Always include normal tools.
- Include `fetch_pdf_context` only when `hooksEnabled !== true`.
- Do not include `get_pdf_events` in either mode.

Implementation detail: avoid scattering conditionals. Prefer a helper such as:

```ts
function hostServiceToolNames(options: HostServiceMcpOptions): readonly HostServiceToolName[]
function mcpToolDescriptions(options: HostServiceMcpOptions): McpToolDefinition[]
```

### Manual context tool

Add a public MCP tool only for pure MCP mode:

```text
fetch_pdf_context
```

Suggested schema:

```json
{
  "type": "object",
  "properties": {
    "pdf_id": { "type": "integer", "minimum": 1 },
    "max_events": { "type": "integer", "minimum": 1 }
  },
  "required": [],
  "additionalProperties": false
}
```

Defaults:

- `max_events`: 20
- `pdf_id`: absent means all tracked PDFs
- consumed marks are always cleared from the viewer

Result:

- text content is formatted PDF context or a short “No PDF viewer context is pending.” message;
- details include event count, pdf IDs, and cleared status.

### Hook bridge

In `--with-hooks` mode, start a private local bridge in the MCP runtime process.

Requirements:

- listens only on loopback or a Unix socket;
- uses a random token;
- writes a discovery file in the agent runtime directory;
- endpoint supports `POST /fetch_info` with `{ prompt?: string }`;
- returns plain text context;
- returns empty body when no context exists;
- does not appear in MCP `tools/list`.

`agent-synctex fetch-info` should:

1. read raw prompt from stdin;
2. locate the discovery file;
3. call the bridge with token;
4. print text response to stdout;
5. exit 0 even if unavailable.

## Shared context collector

Create `src/modules/post_user_pdf_context.ts`.

Suggested API:

```ts
export interface PostUserPdfContextRequest {
  pdfId?: number;
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

`ViewerHostMcpService` should expose an internal method, e.g.:

```ts
collectPostUserPdfContext(request: PostUserPdfContextRequest): Promise<PostUserPdfContextResult>
```

It should:

- drain host events first;
- gather user-facing events from `PdfEventStore`;
- format context;
- send clear command to viewer when `clearViewer` is true.

## Viewer clearing protocol

Add a host-to-viewer protocol message:

```ts
{ type: "clear_pdf_annotations", pdf_id: number }
```

Changes:

- `src/modules/viewer_host_protocol.ts`
  - add type and validation.
- `src/modules/viewer_host_client.ts`
  - send clear messages for consumed pdf IDs.
- `src/modules/viewer_host_server.ts`
  - route clear control messages to viewer sockets for the PDF.
- `src/viewer_lw/host_lw_adapter.mjs`
  - handle `clear_pdf_annotations` by calling existing `clearAnnotations()`.
  - do not emit `pdf_annotation_deleted` for hook-driven clearing.

## Installer CLI design

### Command parser

Implement a small no-dependency parser unless project conventions prefer a dependency.

Commands:

```bash
agent-synctex install mcp
agent-synctex install hooks
agent-synctex uninstall
agent-synctex doctor
agent-synctex fetch-info
```

Flags:

```text
--harness auto|all|claude|codex|cline|pi|opencode
--scope project|user
--dry-run
--yes
--cwd <path>
--help
```

### Adapter interface

```ts
export interface HarnessAdapter {
  readonly id: "claude" | "codex" | "cline" | "pi" | "opencode";
  detect(ctx: InstallContext): Promise<HarnessDetection>;
  installMcp(ctx: InstallContext): Promise<InstallChange[]>;
  installHooks(ctx: InstallContext): Promise<InstallChange[]>;
  uninstall(ctx: InstallContext): Promise<InstallChange[]>;
  doctor(ctx: InstallContext): Promise<DoctorFinding[]>;
}
```

`installHooks()` must also ensure the MCP config for that harness uses `tex-actions-mcp --with-hooks`.

`uninstall()` removes both managed MCP config and managed hooks for that harness.

### Manifest

Write `.agent-synctex/install-manifest.json` after successful changes.

Use stable managed IDs, for example:

```text
agent-synctex:mcp:claude
agent-synctex:hook:claude:user-prompt-submit
```

The uninstall path should prefer the manifest, but also recognize current managed markers for recovery when the manifest is missing.

### Config editing

Use structured edits where possible:

- JSON: parse/stringify with stable indentation.
- JSONC: preserve enough comments where practical; if not possible, use a small targeted block edit with managed markers.
- Shell hook scripts: overwrite only files recorded as managed or containing a managed marker.

Every generated file should include a marker comment, e.g.:

```bash
# Managed by agent-synctex. Do not edit this block unless you also update .agent-synctex/install-manifest.json.
```

## Harness adapter details

### Claude Code

Stage 1:

- Add MCP server config with command `tex-actions-mcp`.

Stage 2:

- Add/update `UserPromptSubmit` hook in `.claude/settings.json` or `.claude/settings.local.json`.
- Write `.claude/hooks/agent-synctex-fetch-info.sh`.
- Update MCP command args to include `--with-hooks`.

Uninstall:

- remove managed MCP entry;
- remove managed hook entry;
- remove managed script if no longer referenced.

### Codex CLI

Stage 1:

- Add MCP server config for Codex.

Stage 2:

- Add `.codex/hooks.json` `UserPromptSubmit` command hook.
- Write `.codex/hooks/agent-synctex-fetch-info.sh`.
- Update MCP command args to include `--with-hooks`.

Uninstall:

- remove managed MCP entry;
- remove managed hook entry;
- remove managed script.

Note: doctor should remind users that Codex project hooks must be trusted via `/hooks`.

### Cline

Stage 1:

- Add MCP server to Cline MCP settings.

Stage 2:

- Write executable `.clinerules/hooks/UserPromptSubmit` if absent or managed.
- If an unmanaged file exists, do not overwrite without confirmation; offer a manual snippet.
- Update MCP command args to include `--with-hooks`.

Uninstall:

- remove managed MCP entry;
- remove managed hook file only if it contains our marker.

### Pi

Stage 1:

- Pi has no separate prompt-hook config surface in this design; the MCP runtime must be configured/started with `tex-actions-mcp --with-hooks` by the Pi MCP environment.

Stage 2:

- Write standalone project extension `.pi/extensions/agent-synctex-post-user.ts`.
- The extension registers `before_agent_start` and calls `agent-synctex fetch-info`.
- This keeps the Pi artifact as a thin wrapper around the hook API and the private MCP hook bridge.

Uninstall:

- remove the managed Pi extension file.

### OpenCode

Stage 1:

- Add `mcp` entry to `opencode.jsonc` with command `tex-actions-mcp`.

Stage 2:

- Write `.opencode/plugins/agent-synctex-post-user.ts`.
- Plugin uses `chat.message` and appends a text `Part` to `output.parts`.
- Update MCP command args to include `--with-hooks`.

Uninstall:

- remove managed `mcp` entry;
- remove managed plugin file.

## Test plan

### Unit tests

Add tests for:

- CLI parser:
  - install mcp/hooks/uninstall/doctor/fetch-info;
  - invalid command/flag combinations;
  - `--harness all`, `--harness auto`, aliases.
- Harness detection:
  - each harness project marker;
  - multiple detections;
  - non-interactive ambiguity failure.
- Manifest:
  - write/read/update;
  - uninstall uses manifest;
  - missing manifest fallback markers.
- Config edits:
  - idempotent install;
  - no duplicate hook entries;
  - uninstall removes only managed entries.
- MCP tool surface:
  - default mode lists `fetch_pdf_context` and not `get_pdf_events`;
  - `--with-hooks` lists neither `fetch_pdf_context` nor `get_pdf_events`;
  - normal tools remain listed in both modes.
- Context formatter:
  - formats annotation comments;
  - includes the attached LaTeX source line when `source_line` is available;
  - clearly labels the block as MCP/hook-provided PDF context from user-marked viewer comments;
  - distinguishes fetched source metadata from user-authored comments;
  - cites every sourced item as `source_file:line` with a quoted source-line excerpt;
  - deduplicates annotation updates;
  - truncates long comments/source lines;
  - excludes `selection_debug`.

### Integration tests

Update/extend:

- `test/modules/mcp_tool_surface_v1.test.ts`
- `test/modules/stdio_mcp_runtime.test.ts`
- `test/modules/host_service_mcp_pdf_events.test.ts`
- `test/modules/viewer_host_viewer_socket.test.ts`
- `test/modules/viewer_host_browser.test.ts`

Add tests for:

- `tex-actions-mcp --with-hooks` starts and handles MCP frames.
- `agent-synctex fetch-info` returns empty output and code 0 when bridge is unavailable.
- `agent-synctex fetch-info` returns formatted context when bridge is available.
- Hook bridge requires token and rejects unauthenticated requests.
- Viewer clear message removes annotation overlays without sending deletion events.

### Harness fixture tests

Use temp directories containing representative config files:

```text
test/fixtures/harnesses/claude/
test/fixtures/harnesses/codex/
test/fixtures/harnesses/cline/
test/fixtures/harnesses/pi/
test/fixtures/harnesses/opencode/
```

For each harness:

1. run `install mcp`;
2. assert MCP config exists and command does not include `--with-hooks`;
3. run `install hooks`;
4. assert hook exists and MCP config includes `--with-hooks`;
5. run install again;
6. assert no duplicates;
7. run `uninstall`;
8. assert managed MCP config and hook artifacts are removed;
9. assert unrelated config remains.

## Verification commands

Targeted:

```bash
npm run check
node --test --test-reporter=./scripts/fail-only-test-reporter.ts \
  test/modules/mcp_tool_surface_v1.test.ts \
  test/modules/stdio_mcp_runtime.test.ts \
  test/modules/host_service_mcp_pdf_events.test.ts \
  test/modules/viewer_host_viewer_socket.test.ts \
  test/modules/viewer_host_browser.test.ts
```

Broad:

```bash
npm run verify
```

## Migration notes

- Replace public `get_pdf_events` with private/shared collection code.
- Any existing tests asserting `get_pdf_events` is advertised should be updated.
- Tests that need raw event internals should use lower-level `PdfEventStore` or private service methods, not public MCP tools.
- Documentation should present `fetch_pdf_context` as the pure-MCP fallback and hooks as the preferred UX.

## Open questions

- Final public name for the manual context tool: `fetch_pdf_context`, `fetch_viewer_context`, or `get_pdf_context`.
- Whether Pi should use direct native extension collection only, or also support stdio MCP config in the installer.
- Exact user/global config paths for Claude, Codex, and Cline should be verified against current official docs during implementation.

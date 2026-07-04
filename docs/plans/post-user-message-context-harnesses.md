# Post-user-message PDF context injection — harness implementation plan

## Scope

Support PDF viewer mark/comment context injection for these harnesses:

1. Claude Code
2. Codex CLI
3. Cline
4. Pi
5. OpenCode

Also remove `get_pdf_events` from the public agent-visible MCP tool surface.

## Plan files

- Shared implementation: `docs/plans/shared-post-user-message-context.md`
- Claude Code: `docs/plans/claude-code-post-user-message-context.md`
- Codex CLI: `docs/plans/codex-cli-post-user-message-context.md`
- Cline: `docs/plans/cline-post-user-message-context.md`
- Pi: `docs/plans/pi-post-user-message-context.md`
- OpenCode: `docs/plans/opencode-post-user-message-context.md`

## Recommended architecture

```text
viewer annotations/comments
  -> Viewer Host event backlog / PdfEventStore
  -> private internal context collection API
  -> scripts/mcp-fetch-info or local HTTP sidecar
  -> harness post-user-message hook
  -> injected current-turn context
  -> clear annotations in viewer
```

## Key implementation decisions

- `get_pdf_events` should be removed from `tools/list` and public `tools/call` dispatch.
- Context collection should move behind a private helper/API used by hooks, not by the model.
- Viewer clearing needs a host-to-viewer protocol message; unread event state alone is not enough because visible annotation overlays must disappear.
- Command-hook harnesses share `scripts/mcp-fetch-info`.
- Pi should use native `before_agent_start` in the package extension registration.
- OpenCode uses its `chat.message` plugin hook and mutates `output.parts` to append context.

## Cross-harness helper contract

```text
stdin:  raw user prompt
stdout: context text to inject, or empty output if unavailable
exit:   0 even when the MCP/viewer is unavailable
```

The helper must be fast, bounded, and safe to run on every prompt.

## Rollout order

1. Implement shared internal collection and formatter.
2. Add viewer clear protocol and browser handling.
3. Remove `get_pdf_events` from the public MCP surface and update tests/docs.
4. Add `scripts/mcp-fetch-info` and, if needed, a local HTTP sidecar endpoint.
5. Add Pi native `before_agent_start` support.
6. Add harness template files/docs for Claude Code, Codex CLI, Cline, and OpenCode.
7. Run targeted tests, then `npm run verify`.

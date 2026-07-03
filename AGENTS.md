# AGENTS

## Architecture overview

`CONTEXT.md` outlines the current repository architecture, active viewer/server split, important module ownership, and high-signal tests. Read it before making architectural, viewer, SyncTeX, MCP runtime, or compile-flow changes. Unless it is clear where to start reading when discovering, this should be the first place.

## Implementation lineage

This implementation is based on/derived from the sibling LaTeX Workshop repo (`../latex-workshop`; this workspace may have it as `../LaTeX-Workshop`). When changing LaTeX build, SyncTeX, or PDF viewer behavior, compare the relevant behavior and design against that repo before diverging.

## Test environment setup

Fresh git worktrees do not include `node_modules`. Before treating test failures as environment/sandbox issues, install dependencies and rerun verification:

```bash
npm ci || npm install
npm run verify
```

If `npm run verify` fails with `tsc: not found` or `ERR_MODULE_NOT_FOUND: typescript`, the worktree dependencies are incomplete; run the install command above and retry.

Before changing viewer architecture, refresh policy, SyncTeX behavior, or PDF.js UI behavior in this repo, read the forward-looking docs:

- docs/prd-desktop-viewer-host-v1.md
- docs/tdd-desktop-viewer-host-v1.md
- docs/prd-viewer-client-ux-followups.md
- docs/tdd-viewer-client-ux-followups.md

For extension composition and transport, keep `index.ts` as the composition root:

- `src/modules/pi_adapter/pi_adapter.ts` should remain the thin Pi dispatch adapter.
- MCP tool protocol and tool schemas are implemented in `src/modules/host_service_mcp.ts`.
- Keep runtime and artifact-facing operations in `src/modules/stdio_mcp_runtime.ts` and `src/modules/viewer_host_client.ts`; do not reintroduce the removed legacy `pdfjs_viewer_*` stack.
- `scripts/tex-actionsctl.ts`, `scripts/agent-synctex-host-service.ts`, and `scripts/pi_synctex_callback.mjs` are removed in this branch; do not reintroduce these entrypoints.

Avoid reintroducing direct viewer-command spawning in production TypeScript. `test/viewer_guardrails.test.ts` is the production regression guard for this boundary.

# AGENTS

## Implementation lineage

This implementation is based on/derived from the sibling LaTeX Workshop repo (`../latex-workshop`; this workspace may have it as `../LaTeX-Workshop`). When changing LaTeX build, SyncTeX, or PDF viewer behavior, compare the relevant behavior and design against that repo before diverging.

## Test environment setup

Fresh git worktrees do not include `node_modules`. Before treating test failures as environment/sandbox issues, install dependencies and rerun verification:

```bash
npm ci || npm install
npm run verify
```

If `npm run verify` fails with `tsc: not found` or `ERR_MODULE_NOT_FOUND: typescript`, the worktree dependencies are incomplete; run the install command above and retry.

Before changing any preview rendering, refresh policy, or image output paths in this repo, read:

- docs/testing-preview-framework.md

For extension composition and transport, keep `index.ts` as the composition root:
- `src/modules/pi_adapter/pi_adapter.ts` should remain the thin Pi dispatch adapter.
- MCP tool protocol and tool schemas are implemented in `src/modules/host_service_mcp.ts`.
- Keep runtime and artifact-facing operations in `src/modules/stdio_mcp_runtime.ts` and `src/modules/pdfjs_viewer_mcp_service.ts`.
- `scripts/tex-actionsctl.ts`, `scripts/agent-synctex-host-service.ts`, and `scripts/pi_synctex_callback.mjs` are removed in this branch; do not reintroduce these entrypoints.

Avoid reintroducing direct viewer-command spawning in production TypeScript. `test/viewer_guardrails.test.ts` is the production regression guard for this boundary.
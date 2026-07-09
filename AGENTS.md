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

For extension composition and transport, keep the installed MCP/runtime path as the composition root:

- `scripts/agent-synctex.ts` dispatches installed CLI/MCP flows.
- `src/modules/pi_adapter/pi_adapter.ts` should remain the thin Pi dispatch adapter.
- MCP tool protocol and tool schemas are implemented in `src/modules/host_service_mcp.ts`.
- Keep runtime and artifact-facing operations in `src/modules/stdio_mcp_runtime.ts` and `src/modules/viewer_host_client.ts`; do not reintroduce the removed legacy `pdfjs_viewer_*`, native `pi_extension`, HostService/Zathura, or inline-preview stacks.
- `index.ts`, `scripts/tex-actionsctl.ts`, `scripts/agent-synctex-host-service.ts`, and `scripts/pi_synctex_callback.mjs` are removed in this branch; do not reintroduce these entrypoints.

Avoid reintroducing direct viewer-command spawning in production TypeScript. `test/viewer_guardrails.test.ts` is the production regression guard for this boundary.

## Hidden development switches

Reverse SyncTeX hover/debug overlays are intentionally not advertised in MCP tool schemas and should not be used during normal user work. Use them only when the user explicitly asks for SyncTeX/debug overlay diagnostics by passing `debug_synctex: true` to `show_latex`, `compile_latex_file` with `open_pdf: true`, `open_pdf`, or `jump_pdf`. Omit it or pass `debug_synctex: false` for the normal mode.

## MCP runtime concurrency

One agent session owns one MCP runtime. Normal request-flow coordination should assume a single MCP process per agent and serialize intra-runtime tool calls instead of adding cross-process locks. Add cross-process locks only for explicitly supported multi-process scenarios.

## Test guardrails

Do not add tests that assert documentation files exist. Documentation may be absent, moved, or pruned in worktrees; tests should verify executable behavior, APIs, protocols, and production guardrails instead of using doc-file existence as a pass/fail condition.

# AGENTS

## Architecture overview

`CONTEXT.md` outlines the current repository architecture, active viewer/server split, important module ownership, and high-signal tests. Read it before making architectural, viewer, SyncTeX, MCP runtime, or compile-flow changes. Unless it is clear where to start reading when discovering, this should be the first place.

## Vocabulary

- **Box score**: the lower-is-better numerical score assigned to one candidate geometry box during reverse SyncTeX resolution. The selected box's score is used to choose its containing group and source proposal.

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

- `scripts/agent-synctex.ts` is the installed CLI entrypoint and dispatches `mcp`, `fetch-info`, installer, uninstaller, and doctor flows through `src/modules/installer/cli.ts`.
- `scripts/viewer-host-server.ts` is the Viewer Host process entrypoint. Together these are the active production entrypoints tracked by `test/viewer_guardrails.test.ts`.
- Harness MCP configuration and hook/plugin wrappers are owned by `src/modules/installer/`; Pi uses `src/modules/installer/adapters/pi.ts` and generated wrapper source from `src/modules/installer/pi_extension_source.ts`.
- `src/modules/pi_adapter/pi_adapter.ts` is an unwired generic Pi tool-registration helper, not an active production entrypoint or integration path.
- MCP tool protocol and tool schemas are implemented in `src/modules/host_service_mcp.ts`.
- Keep MCP runtime coordination in `src/modules/stdio_mcp_runtime.ts` and Viewer Host lifecycle, PDF registration, and browser launch/focus at the `src/modules/viewer_host_client.ts` boundary. Do not reintroduce the removed legacy `pdfjs_viewer_*`, native packaged `pi_extension`, HostService/Zathura, or inline-preview stacks.
- `scripts/tex-actions-mcp.ts` is a source-tree convenience entrypoint and `scripts/pdf-preview-mcp.ts` is its compatibility shim; neither is part of the installed package build.
- `index.ts`, `scripts/tex-actionsctl.ts`, `scripts/agent-synctex-host-service.ts`, and `scripts/pi_synctex_callback.mjs` are removed in this branch; do not reintroduce these entrypoints.

Do not spawn or control native PDF viewers, and do not launch/focus the browser outside `SystemBrowserViewerLauncher` in `src/modules/viewer_host_client.ts`. `test/viewer_guardrails.test.ts` is the production regression guard for this boundary.

## Hidden development switches

Reverse SyncTeX hover/debug overlays are intentionally not advertised in MCP tool schemas and should not be used during normal user work. Use them only when the user explicitly asks for SyncTeX/debug overlay diagnostics by passing `debug_synctex: true` to `show_latex`, `compile_latex_file` with `open_pdf: true`, `open_pdf`, or `jump_pdf`. Omit it or pass `debug_synctex: false` for the normal mode.

## MCP runtime concurrency

One agent session owns one MCP runtime. Normal request-flow coordination should assume a single MCP process per agent and serialize intra-runtime tool calls instead of adding cross-process locks. Add cross-process locks only for explicitly supported multi-process scenarios.

## Test guardrails

Do not add tests that assert documentation files exist. Documentation may be absent, moved, or pruned in worktrees; tests should verify executable behavior, APIs, protocols, and production guardrails instead of using doc-file existence as a pass/fail condition.

# Preview Testing Framework

This document describes the active v1 preview/runtime test strategy.

## Active preview path

The committed production runtime is stdio MCP plus a browser-hosted PDF.js viewer:

1. For local development, start with `node scripts/tex-actions-mcp.ts`; MCP clients should launch the installed `tex-actions-mcp` bin.
2. Use MCP `show_latex`, `compile_latex_file(open_pdf=true)`, or `open_pdf` to register/open PDFs.
3. Use MCP `jump_pdf` for forward SyncTeX.
4. Use MCP `get_pdf_events` to fetch browser PDF.js reverse SyncTeX events.
5. Use MCP `close_pdf` to untrack PDFs and notify connected PDF.js viewers.

Do not validate active runtime behavior with desktop PDF viewer commands, host service managers, or service units. Those paths are not part of v1 MCP production.

## Primary committed seams

- `test/modules/show_latex_viewer_flow.test.ts` — snippet compile to PDF.js viewer metadata.
- `test/modules/compile_latex_file_mcp_pdfjs.test.ts` — file compile, open, refresh, diagnostics, and removed input validation.
- `test/modules/pdfjs_viewer_mcp_service.test.ts` — PDF.js viewer registration, refresh, close, and reverse SyncTeX event capture.
- `test/modules/pdfjs_viewer_server.test.ts` — HTTP/WebSocket behavior for the browser viewer.
- `test/modules/stdio_mcp_runtime.test.ts` — stdio framing, runtime workspace injection, and preamble behavior.
- `test/viewer_guardrails.test.ts` — production entrypoint graph guardrails.

## Guardrail expectations

The guardrail test derives active entrypoints from `package.json` scripts/bins and walks their production import graph. It should fail if active runtime reintroduces:

- callback schemas or callback-target public inputs,
- removed inline/continuous public schemas or stdio compatibility stripping,
- raster/Kitty/direct desktop viewer runtime imports,
- legacy daemon/socket/systemd entrypoints,
- session heartbeat or pending-notification flows,
- `pi.extensions` metadata.

Historical files may retain legacy terminology only when they are clearly outside the active package entrypoint graph or explicitly marked as historical/archive.

## Headless real-TeX coordination smoke

The selective smoke `test/modules/host_service_real_latexmk_smoke.test.ts` is historical/diagnostic. It starts an isolated in-process compatibility service and drives `compile_latex_file` over MCP Content-Length frames with `open_pdf=false`. Run it only where TeX Live/MacTeX is available:

```bash
npm run test:real-tex-smoke
# equivalent:
AGENT_SYNCTEX_REAL_TEX_SMOKE=1 node --test test/modules/host_service_real_latexmk_smoke.test.ts
```

Without `AGENT_SYNCTEX_REAL_TEX_SMOKE=1`, or when `latexmk`/`lualatex` are missing from `PATH`, the test skips with a clear reason. It is headless and must not require desktop GUI tooling, D-Bus, terminal graphics, or human interaction.

## Verification commands

- Full typecheck: `npm run check`
- Full tests: `npm test`
- Guardrails: `node --test test/viewer_guardrails.test.ts`
- Targeted v1 checks:
  - `node --test test/modules/stdio_mcp_runtime.test.ts`
  - `node --test test/modules/show_latex_viewer_flow.test.ts`
  - `node --test test/modules/compile_latex_file_mcp_pdfjs.test.ts`
  - `node --test test/modules/pdfjs_viewer_mcp_service.test.ts`
  - `node --test test/modules/pdfjs_viewer_server.test.ts`

## Constraints and limitations

These tests are deterministic, offline checks and do not rely on live Pi interaction, desktop GUI tooling, real terminal graphics, or a full VT/graphics emulator. Browser PDF.js behavior is tested through the local HTTP/WebSocket seams and fake browser launchers where possible.

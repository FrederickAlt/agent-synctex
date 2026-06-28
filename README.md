# TeX Actions

TeX Actions is a local stdio MCP server for LaTeX snippet rendering, file compilation, and PDF navigation through a browser-hosted PDF.js viewer.

The active v1 runtime is stdio MCP plus PDF.js in the browser. It does not require a socket daemon, systemd unit, direct desktop PDF viewer integration, or callback transport from the browser.

## Exposed MCP tools

- `show_latex`
  - Compile LaTeX source and open the generated PDF in the browser PDF.js viewer.
  - Returns compile metadata, `pdf_id`, and `viewer_url`.
- `compile_latex_file`
  - Compile an existing `.tex` source file.
  - Optional `open_pdf=true` registers/opens the generated PDF in the PDF.js viewer and returns a runtime `pdf_id`.
- `open_pdf`
  - Open an existing PDF in the PDF.js viewer and register it in runtime state.
- `jump_pdf`
  - Forward-search a tracked PDF by `pdf_id` and source line.
- `close_pdf`
  - Untrack a runtime PDF id and notify connected PDF.js viewers.
- `set_latex_preamble`
  - Set the runtime preamble used by snippet compilation.
- `get_pdf_events`
  - Fetch recent process-local PDF.js reverse SyncTeX events.

## Runtime architecture

- Entry point: `scripts/tex-actions-mcp.ts` (alias: `scripts/pdf-preview-mcp.ts`).
- Runtime host: `src/modules/stdio_mcp_runtime.ts`.
- MCP tool handling: `src/modules/host_service_mcp.ts`.
- Browser/PDF.js viewer: `src/modules/pdfjs_viewer_mcp_service.ts` and `src/modules/pdfjs_viewer_server.ts`.
- Compile orchestration: `src/modules/host_service_compile.ts` with LaTeX primitives in `src/modules/latex/`.

The runtime seeds a process-owned workspace under `${MCP_TMPDIR:-$XDG_RUNTIME_DIR/tex-actions}/agents/<agent-id>` and stores temporary snippet/preamble artifacts there. PDF.js HTTP serving is delegated to a lightweight local viewer broker at `${MCP_TMPDIR:-$XDG_RUNTIME_DIR/tex-actions}/pdfjs-viewer-broker.sock` so returned `viewer_url` values remain reachable even when a stdio MCP client tears down the short-lived tool transport after a call.

## Start the runtime

For local development, run the MCP entrypoint directly so stdout remains reserved for MCP stdio frames:

```bash
node scripts/tex-actions-mcp.ts
```

For MCP client configuration after installation, use the package bin:

```bash
tex-actions-mcp
```

Pi's local MCP config supports `lifecycle` values `"lazy"`, `"eager"`, and `"keep-alive"`. Use `"keep-alive"` for `tex-actions` so process-local tool state survives between calls; the viewer broker also keeps returned PDF.js `viewer_url` values reachable if a client still tears down the stdio transport after a call.

```json
{
  "mcpServers": {
    "tex-actions": {
      "command": "tex-actions-mcp",
      "lifecycle": "keep-alive",
      "directTools": true
    }
  }
}
```

## Verification

```bash
npm run check
npm test
npm run smoke:stdio-viewer
```

`test/viewer_guardrails.test.ts` enforces that active package entrypoints remain stdio MCP/PDF.js-only and do not reintroduce removed callback schemas, legacy viewer commands, daemon entrypoints, or inline/raster compatibility paths.

## Historical note

Some internal module names still contain `host_service` because they define current v1 MCP DTOs or compile helpers. File names alone are not compatibility promises; active behavior is the stdio MCP + PDF.js path above.

# Host-service broker notes (legacy)

This repository has transitioned to the in-process stdio MCP runtime (`scripts/tex-actions-mcp.ts`) and PDF.js viewer backend.
A host-service broker remains out-of-scope for active runtime.

## Status

- Legacy broker/daemon entrypoints are no longer used by production runtime.
- Legacy artifacts that should not exist in active runtime:
  - `systemd/show-latex.service`
  - `scripts/tex-actionsctl.ts`
  - `scripts/agent-synctex-host-service.ts`
  - `scripts/pi_synctex_callback.mjs`

## Current contract

- Runtime starts from stdio MCP:
  - local development: `node scripts/tex-actions-mcp.ts`
  - MCP client configuration: installed `tex-actions-mcp` bin
- MCP tool surface remains: `show_latex`, `compile_latex_file`, `open_pdf`, `jump_pdf`, `close_pdf`, `set_latex_preamble`, `get_pdf_events`.
- `get_pdf_events` requires `max_events`; optional `pdf_id` filters events for a single PDF. Reads are non-destructive: the runtime selects the last `max_events` matching events and returns them in chronological order.
- Viewer behavior is provided by the in-repo PDF.js runtime (`src/modules/pdfjs_viewer_mcp_service.ts`) and `src/modules/pdfjs_viewer_server.ts`.

## Validation

`test/viewer_guardrails.test.ts` enforces that deprecated daemon/service artifacts and callback scripts are absent from active runtime paths.

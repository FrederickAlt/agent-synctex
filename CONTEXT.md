# Context

## Active runtime

TeX Actions runs as a local stdio MCP server. The active v1 path is:

- MCP entrypoint: `scripts/tex-actions-mcp.ts`
- Runtime host: `src/modules/stdio_mcp_runtime.ts`
- Tool protocol/parser/handlers: `src/modules/host_service_mcp.ts`
- Browser/PDF.js viewer backend: `src/modules/pdfjs_viewer_mcp_service.ts`

There is no active socket service manager, systemd unit, browser-to-agent callback transport, or direct desktop PDF viewer backend in the v1 MCP path.

## LaTeX PDF production

LaTeX PDF production covers snippet and file compilation flows. Snippets and files compile through the shared compile service. Generated PDFs are either returned as compile artifacts or registered with the browser PDF.js viewer when a tool opens a PDF.

## Browser PDF.js viewer / IDs

`show_latex`, `open_pdf`, and `compile_latex_file(open_pdf=true)` register PDFs in process-local runtime state. `jump_pdf`, `close_pdf`, and `get_pdf_events` address those records by `pdf_id`.

PDF ids are process memory only and survive only while the stdio MCP runtime process stays up.

## Reverse SyncTeX events

Browser PDF.js reverse SyncTeX clicks are stored as process-local events and fetched by agents with `get_pdf_events`. The active v1 MCP API does not expose or accept callback objects or callback target ids.

## MCP tool surface

The stdio MCP runtime is the user-facing integration layer:

- exposes LaTeX and PDF navigation tools,
- formats tool responses,
- manages process-local runtime workspace context,
- opens and coordinates PDFs through the browser PDF.js viewer.

## Preview artifacts

A preview artifact is generated output such as a PDF, log, SyncTeX sidecar, or runtime preamble file. Active MCP user flows consume PDFs through the browser PDF.js viewer.

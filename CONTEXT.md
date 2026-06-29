# Context

## Active runtime

TeX Actions runs as a local stdio MCP server. The active #107 path is:

- MCP entrypoint: `scripts/tex-actions-mcp.ts`
- Runtime host: `src/modules/stdio_mcp_runtime.ts`
- Tool protocol/parser/handlers: `src/modules/host_service_mcp.ts`
- Viewer Host Client boundary: `src/modules/viewer_host_client.ts`
- Typed Viewer Host protocol: `src/modules/viewer_host_protocol.ts`

There is no active socket service manager, systemd unit, browser-to-agent callback transport, direct desktop PDF viewer backend, or real Viewer Host Server in the #107 runtime. The current default Viewer Host Client is fake/test-backed until #108+ provide the real Host Server/client.

## LaTeX PDF production

LaTeX PDF production covers snippet and file compilation flows. Snippets and files compile through the shared compile service. Generated PDFs are either returned as compile artifacts or registered in MCP state and sent through the Viewer Host Client boundary when a tool opens a PDF.

## Viewer Host boundary / IDs

`show_latex`, `open_pdf`, and `compile_latex_file(open_pdf=true)` keep MCP-owned `pdf_id` records and send Viewer Host protocol messages. `jump_pdf` computes SyncTeX in MCP and sends `synctex_forward` to the Viewer Host Client.

`close_pdf` is not public. Viewer/tab close must not delete MCP-owned `pdf_id` state.

PDF ids are process memory only and survive only while the stdio MCP runtime process stays up.

## Viewer events

Reverse SyncTeX/viewer events are stored as process-local events and fetched by agents with `get_pdf_events`. The active MCP API does not expose or accept callback objects or callback target ids.

## MCP tool surface

The stdio MCP runtime is the user-facing integration layer:

- exposes LaTeX and PDF navigation tools,
- formats tool responses,
- manages process-local runtime workspace context,
- routes viewer operations through the Viewer Host Client boundary.

## Preview artifacts

A preview artifact is generated output such as a PDF, log, SyncTeX sidecar, or runtime preamble file. In #107, viewer consumption is represented by typed boundary messages rather than a reachable in-process PDF.js page.

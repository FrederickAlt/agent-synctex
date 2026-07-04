# Context

This repository implements TeX Actions: a stdio MCP server for compiling LaTeX, opening PDFs in a Host-served PDF.js/LaTeX-Workshop viewer, and performing forward/reverse SyncTeX navigation.

The important architecture goal is a clean split between:

- the **MCP runtime** that exposes tools to agents;
- the **Viewer Host Client** inside the MCP runtime that owns MCP-side `pdf_id` state and sends typed messages;
- the **Viewer Host Server** that serves the app, PDF bytes, sockets, registration, refresh routing, and server-side SyncTeX hover/probe responses;
- the **Viewer Client app** that runs in a browser/Tauri webview and owns visible tabs, PDF.js interaction, browser coordinate conversion, overlays, scrolling, and user interaction;
- the **SyncTeX resolution** module that owns parsing/scoring/source repair/result shaping on the Node side.

The viewer is the Viewer Host app + `viewer_lw` route. There is one active viewer architecture: Viewer Host Client, Viewer Host Server, Viewer Client app, and `viewer_lw` PDF.js browser glue.

## Composition root and active entrypoints

- Extension composition root: `index.ts`
- Pi dispatch adapter: `src/modules/pi_adapter/pi_adapter.ts`
- MCP stdio entrypoint: `scripts/tex-actions-mcp.ts`
- Alternate MCP entrypoint: `scripts/pdf-preview-mcp.ts`
- Stdio runtime module: `src/modules/stdio_mcp_runtime.ts`
- MCP tool parser/handler module: `src/modules/host_service_mcp.ts`
- Viewer Host Client / MCP-owned PDF state: `src/modules/viewer_host_client.ts`
- Viewer Host protocol types and validators: `src/modules/viewer_host_protocol.ts`
- Viewer Host Server process entrypoint: `scripts/viewer-host-server.ts`
- Viewer Host Server module: `src/modules/viewer_host_server.ts`
- Desktop/Tauri host wrapper helper: `src/modules/tauri_viewer_wrapper.ts`
- Tauri app shell: `apps/viewer-desktop-tauri/src-tauri/src/main.rs`

`src/modules/stdio_mcp_runtime.ts` creates the default `ViewerHostMcpService` unless tests inject custom `pdfOperations`. That service is the active viewer integration path for `open_pdf`, `jump_pdf`, `show_latex`, and `compile_latex_file(open_pdf=true)`.

## MCP tool surface

MCP tool protocol, validation, workspace-context parsing, and user-facing result formatting live in:

- `src/modules/host_service_mcp.ts`

The exported MCP tools are:

- `show_latex`
- `compile_latex_file`
- `open_pdf`
- `jump_pdf`
- `set_latex_preamble`
- `fetch_pdf_context` (pure MCP mode only; hidden when launched with `--with-hooks`)

Tool handlers delegate PDF operations through the `HostServiceMcpPdfOperations` interface in `src/modules/host_service_mcp.ts`. In normal stdio runtime, those operations come from `ViewerHostMcpService.pdfOperations` in `src/modules/viewer_host_client.ts`.

Important MCP invariants:

- `workspace_context` is injected by `src/modules/stdio_mcp_runtime.ts` for stdio callers.
- `open_pdf` and compile-open flows return a process-local `pdf_id`.
- `jump_pdf` requires a known active `pdf_id` and a readable source file, or enough information to infer the default `.tex` source from the PDF path.
- `fetch_pdf_context` drains Viewer Host events, formats user-marked PDF comments as source-cited context, and consumes/clears pending viewer marks.

## LaTeX PDF production

LaTeX compile orchestration lives in:

- `src/modules/host_service_compile.ts`
- LaTeX compiler helpers under `src/modules/latex/`
- Runtime preamble helpers in `src/modules/runtime_preamble.ts` and `src/modules/pi_extension/latex_preamble_manager.ts`

`show_latex` and `compile_latex_file` both use `HostServiceCompileService` from `src/modules/host_service_compile.ts`.

Compile behavior:

- Snippets are written to runtime files, compiled with SyncTeX enabled, and opened by default.
- File compilation can run compile-only or `open_pdf=true`.
- Compile-only calls mark an already tracked PDF as maybe updated through `pdfOperations.markTrackedPdfUpdated`.
- Compile-open calls open the resulting PDF through `pdfOperations.openPdf`, which in the active runtime is `ViewerHostMcpService.openPdf`.

## Viewer Host Client

The Viewer Host Client module is:

- `src/modules/viewer_host_client.ts`

Its main class is `ViewerHostMcpService`.

Responsibilities:

- allocate MCP-owned `pdf_id` values;
- keep process-local records mapping `pdf_id` to PDF path, workspace cwd, revision metadata, and viewer URL;
- launch/connect to a Viewer Host Server via `createDefaultViewerHostClientFactory`;
- send typed Viewer Host protocol messages over a `ViewerHostClient` adapter;
- recover from Viewer Host reconnects by re-registering known PDFs;
- implement `openPdf`, `jumpPdf`, `getPdfEvents`/`fetchPdfContext` internals, and `markTrackedPdfUpdated` for MCP handlers;
- store agent-readable PDF events in `PdfEventStore` from `src/modules/pdf_events.ts`.

Important concrete adapters/classes in `src/modules/viewer_host_client.ts`:

- `ViewerHostClient` — the interface used by `ViewerHostMcpService` to send Host messages.
- `FakeViewerHostClient` — test adapter that records messages.
- `LocalViewerHostProcessClient` — production adapter that starts/talks to `scripts/viewer-host-server.ts` and its `/control` endpoint.
- `DesktopViewerAppProcessLauncher` — launches/focuses the Tauri desktop app when the Host needs to be visible.

Important flows:

- `openPdf` validates the PDF path, allocates/reuses `pdf_id`, sends `open_pdf` or `focus_pdf` to the Host, and returns viewer metadata.
- `jumpPdf` resolves forward SyncTeX through `src/modules/synctex/synctex_resolution.ts`, then sends `synctex_forward` to the Host.
- `markTrackedPdfUpdated` sends `pdf_maybe_updated` to the Host so the Host can verify the file snapshot and broadcast refresh if needed.
- `getPdfEvents` asks the Host client to drain queued viewer events, maps reverse SyncTeX events through SyncTeX resolution, and returns agent-readable events.

## Viewer Host protocol

Typed Host protocol definitions and validators live in:

- `src/modules/viewer_host_protocol.ts`

MCP/Client-to-Host messages include:

- `hello`
- `open_pdf`
- `focus_pdf`
- `synctex_forward`
- `pdf_maybe_updated`
- `reverse_synctex_hover_result`
- `reverse_synctex_forward_probe_result`

Viewer-to-MCP/Host messages include:

- `viewer_loaded`
- `viewer_tab_closed`
- `reverse_synctex`
- `selection_debug`
- `reverse_synctex_hover`
- `reverse_synctex_forward_probe`

The protocol is JSON-serializable. Keep it browser-friendly and avoid leaking Node/Tauri objects into message payloads.

## Viewer Host Server

The Viewer Host Server module is:

- `src/modules/viewer_host_server.ts`

The standalone process entrypoint is:

- `scripts/viewer-host-server.ts`

The server binds locally by default and announces a ready line on stdout. The MCP-side `LocalViewerHostProcessClient` reads that line and then launches/focuses the desktop app with the Host-served app URL.

Viewer Host Server responsibilities:

- listen on HTTP/WebSocket;
- expose `/control` for MCP-to-Host messages;
- serve `/app` Viewer Client app shell;
- serve `/assets/viewer-client-tabs.js`;
- serve `/viewer-lw/:pdf_id` and vendored PDF.js/LaTeX-Workshop assets;
- serve `/config/:pdf_id.json` with PDF URL, revision, and viewer socket URL;
- serve `/pdf/:pdf_id?revision=N` with registered PDF bytes only when the requested revision matches the registered snapshot;
- expose `/app-events` SSE stream for visible tab events;
- expose `/app-tab-closed` for tab close notifications;
- expose `/mcp-events/drain` so MCP can collect viewer events;
- accept `/viewer-socket` WebSocket connections from Viewer Client frames;
- track connected viewer sockets per `pdf_id`;
- detect PDF file changes, debounce them, increment revisions, and broadcast `pdf_refresh`;
- compute low-latency hover/probe SyncTeX results through `src/modules/synctex/synctex_resolution.ts`.

Important separation rule: the Host Server serves and routes browser code but does not own user-facing PDF.js UI policy. Visible tabs and rendering behavior belong to the Viewer Client app. SyncTeX parsing/scoring belongs to SyncTeX resolution.

## Viewer Host access policy

The access/origin policy module is:

- `src/modules/viewer_host_access_policy.ts`

Its interface is `ViewerHostAccessPolicy`.

Responsibilities:

- decide bind host;
- construct browser-facing origin from server address;
- construct `/app`, `/viewer-lw`, `/pdf`, and `/viewer-socket` URLs;
- decide whether a viewer WebSocket `Origin` header is allowed.

Current adapter:

- `LocalLoopbackViewerHostAccessPolicy`

It is intentionally loopback-only (`127.0.0.1`). If adding LAN/mobile support, add or extend an adapter at this seam instead of scattering host/origin/auth decisions through `ViewerHostServer`, the Tauri wrapper, or the Viewer Client.

Security note for future LAN/mobile mode: socket tokens already exist per PDF, but remote access would also need explicit policy for `/app`, `/config`, `/pdf`, `/control`, `/app-events`, and `/mcp-events/drain` before exposing the server beyond loopback.

## Viewer Client app

The top-level Viewer Client app files are:

- `src/viewer_client/app.html`
- `src/viewer_client/viewer-client-tabs.js`

These are served by `ViewerHostServer` at:

- `/app`
- `/assets/viewer-client-tabs.js`

Responsibilities:

- maintain visible PDF tabs;
- focus/open iframes for `/viewer-lw/:pdf_id`;
- close visible tabs without unregistering MCP-owned `pdf_id` state;
- listen to `/app-events` for `open_pdf` and `focus_pdf` messages;
- route app-shell back/forward mouse/key shortcuts into the active viewer iframe.

The Viewer Client app is portable browser code. It must not import Tauri APIs, Node filesystem APIs, or MCP internals.

## PDF.js / LaTeX-Workshop viewer route

The per-PDF viewer route is:

- `/viewer-lw/:pdf_id`

The Host serves the vendored viewer shell from:

- `src/viewer_lw/viewer.html`

The main Host-specific browser glue is:

- `src/viewer_lw/host_lw_adapter.mjs`

Vendored PDF.js/LaTeX-Workshop assets are under:

- `src/viewer_lw/`

`host_lw_adapter.mjs` responsibilities:

- fetch `/config/:pdf_id.json`;
- configure PDF.js options and default PDF URL;
- connect to `viewer_socket_url`;
- convert browser click/selection geometry into PDF-space coordinates;
- send `reverse_synctex`, `reverse_synctex_hover`, `reverse_synctex_forward_probe`, and `selection_debug` messages;
- handle `pdf_refresh` by reloading PDF bytes while preserving page/scale/scroll state;
- handle `synctex_forward` by rendering overlays and scrolling;
- render hover/probe overlays returned by the server;
- keep SyncTeX overlays aligned after resize, scale, and page render events;
- maintain viewer-local navigation history/back-forward behavior.

Important rule: `host_lw_adapter.mjs` may compute PDF coordinates and draw overlays, but it must not parse SyncTeX sidecars, score candidates, repair source locations, or choose source files/lines. That logic belongs in `src/modules/synctex/synctex_resolution.ts`.

## SyncTeX resolution

The deep SyncTeX resolution module is:

- `src/modules/synctex/synctex_resolution.ts`

It wraps lower-level SyncTeX and text-repair functionality from:

- `src/modules/synctex/forward_synctex.ts`
- `src/modules/synctex/latex_workshop/worker.ts`
- `src/modules/synctex/text_repair.ts`
- `src/modules/synctex/source_line.ts`
- `src/modules/synctex/source_index.ts`

Responsibilities:

- resolve forward SyncTeX jump requests into page/x/y/ranges/source diagnostics;
- resolve reverse SyncTeX viewer messages into `PdfEventStore` inputs;
- repair selection endpoints when selected text uniquely maps in source;
- inspect hover candidates and shape hover result messages;
- map reverse-click-to-forward-probe results and shape probe result messages;
- centralize SyncTeX parsing/scoring/source-repair payload shaping so MCP and Host paths do not duplicate it.

Callers:

- `ViewerHostMcpService.jumpPdf` in `src/modules/viewer_host_client.ts` uses `resolveForwardSynctexJump`.
- `ViewerHostMcpService` reverse-event handling uses `reverseSynctexPdfEventFromViewerMessage`.
- `ViewerHostServer` hover/probe socket handlers use `reverseSynctexHoverResult` and `reverseSynctexForwardProbeResult`.

## Viewer events and agent-readable PDF events

PDF event types and storage live in:

- `src/modules/pdf_events.ts`

`PdfEventStore` stores process-local events with monotonically increasing sequence numbers. It supports:

- filtering by `pdf_id`;
- hiding `selection_debug` events by default;
- returning only unread events unless `stale=true`.

Agent flow:

1. Viewer sends reverse/selection/annotation messages over viewer socket.
2. Host queues/drains messages or sends them to MCP event sink.
3. `ViewerHostMcpService.getPdfEvents` drains Host events for internal consumers.
4. Reverse SyncTeX messages are resolved through SyncTeX resolution.
5. In pure MCP mode, agents receive concise marked-comment context through `fetch_pdf_context`; in hook-aware mode (`--with-hooks`), harness hooks inject that context before the model turn.

## Desktop Viewer / Tauri wrapper

Desktop wrapper files:

- `apps/viewer-desktop-tauri/src-tauri/src/main.rs`
- `apps/viewer-desktop-tauri/README.md`
- `src/modules/tauri_viewer_wrapper.ts`

The wrapper is intentionally thin:

- it loads a Host-served `/app` URL;
- in app-owned mode it can spawn a Host process and wait for its ready line;
- in MCP-owned mode it uses `PDF_PREVIEW_VIEWER_HOST_APP_URL` from the MCP-side app launcher;
- it validates loopback app URLs for the current local-only mode.

The wrapper must not implement PDF registration, PDF serving, SyncTeX resolution, refresh policy, tab business logic, or PDF.js UI logic.

## Important tests and verification targets

Core commands:

```bash
npm run check
npm test
npm run verify
```

High-signal tests by area:

- MCP/runtime tool surface: `test/modules/host_service_mcp.test.ts`, `test/modules/stdio_mcp_runtime.test.ts`, `test/modules/mcp_tool_surface_v1.test.ts`
- Viewer Host MCP seam: `test/modules/viewer_host_mcp_boundary.test.ts`
- Viewer Host server routes/control: `test/modules/viewer_host_server.test.ts`, `test/modules/viewer_host_control_channel.test.ts`
- Viewer Host sockets/events: `test/modules/viewer_host_viewer_socket.test.ts`, `test/modules/host_service_mcp_pdf_events.test.ts`
- Viewer Host refresh detection: `test/modules/viewer_host_pdf_change_detection.test.ts`
- Viewer Client tabs/app shell: `test/modules/viewer_host_tabs.test.ts`, `test/modules/viewer_host_browser.test.ts`
- Viewer access/origin policy: `test/modules/viewer_host_access_policy.test.ts`
- SyncTeX: `test/modules/synctex/forward_synctex.test.ts`, `test/modules/synctex/text_repair.test.ts`, `test/modules/synctex/forward_synctex_oracle.test.ts`
- Coordinate conversion: `test/modules/viewer_coordinate_transform.test.ts`
- Compile/show flows through Viewer Host: `test/modules/compile_latex_file_mcp_viewer_host.test.ts`, `test/modules/show_latex_viewer_flow.test.ts`
- Architectural guardrails: `test/viewer_guardrails.test.ts`

When changing viewer architecture, run at least:

```bash
npm run check
node --test --test-reporter=./scripts/fail-only-test-reporter.ts \
  test/modules/viewer_host_mcp_boundary.test.ts \
  test/modules/viewer_host_server.test.ts \
  test/modules/viewer_host_viewer_socket.test.ts \
  test/modules/viewer_host_pdf_change_detection.test.ts \
  test/modules/viewer_host_tabs.test.ts \
  test/modules/viewer_host_browser.test.ts \
  test/viewer_guardrails.test.ts
```

For broad changes, run full `npm test` or `npm run verify`.

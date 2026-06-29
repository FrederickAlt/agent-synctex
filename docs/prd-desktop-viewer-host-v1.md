# PRD: Desktop Viewer Host v1

## Status

Draft / accepted direction from planning discussion.

## Summary

Build a desktop-only v1 standalone viewer bundle for the LaTeX MCP PDF.js workflow.

The bundle is a Tauri desktop application for macOS and Linux at minimum, with Windows best-effort. Internally it must be split into two explicit components:

- **Viewer Host Server**: runs on the same computer as the MCP process, LaTeX files, PDFs, and SyncTeX files. It owns PDF serving, viewer web asset serving, active viewer sockets, and debounced PDF file-change detection.
- **Viewer Client**: a web UI served by the Viewer Host Server. It provides a minimal tabbed shell and embeds the existing custom PDF.js-based viewer for each open PDF.

For v1, both components are launched together by the Tauri desktop bundle and run only on the local computer. Future mobile/remote viewing is intentionally out of scope, but the code and terminology should preserve the Host Server vs Viewer Client boundary so a later mobile/browser client can connect to a PC-side Host Server.

## Goals

- Provide a standalone desktop viewer bundle instead of opening arbitrary browser tabs.
- Keep one viewer bundle associated with one MCP session.
- Move PDF serving out of the MCP process and into the Viewer Host Server.
- Serve the Viewer Client web UI, PDF.js assets, and registered PDF bytes from the Viewer Host Server.
- Add minimal tab support:
  - open/focus a tab for a PDF;
  - close tabs inside the Viewer Client;
  - show an empty state when no tabs are open.
- Remove the public `close_pdf` MCP tool for this version.
- Keep MCP-owned `pdf_id` records valid until MCP session shutdown, regardless of local tab close.
- Reuse the current custom PDF.js canvas viewer for v1 rather than porting the full stock PDF.js viewer or LaTeX-Workshop UI.
- Detect PDF file changes in the Viewer Host Server with debounced stat/polling and notify viewer tabs to refresh.
- Preserve current MCP responsibilities for compilation, `pdf_id` allocation, SyncTeX mapping, and agent-readable event storage.

## Non-goals

- No mobile app or mobile browser support in v1.
- No remote LAN mode in v1.
- No authentication/session token in v1; bind only to `127.0.0.1`.
- No full GUI/toolbar polish beyond minimal tabs.
- No zoom controls beyond whatever the existing custom viewer already exposes or hardcodes.
- No stock PDF.js sidebar/outline/search toolbar port in v1.
- No comments UI in v1.
- No continuous compilation UI in v1.
- No app-initiated connection to an MCP process in v1.
- No public `close_pdf` tool and no remote viewer close capability.
- No guarantee that closing a tab unregisters or invalidates a PDF id.

## Terminology

### Viewer Host Server

The local PC-side server component launched by the Tauri desktop bundle. It runs where LaTeX compilation outputs and PDF/SyncTeX files are accessible.

### Viewer Client

The web frontend served by the Viewer Host Server. It owns visible tabs and user interaction. In v1 it runs inside the Tauri window.

### Desktop Viewer Bundle

The Tauri application packaging the Viewer Host Server and Viewer Client for local desktop use.

### MCP Viewer Host Client

The MCP-side adapter that launches/reconnects to the Desktop Viewer Bundle and sends control messages to the Viewer Host Server.

## Architecture

```text
Agent
  <stdio MCP>
MCP process
  ├─ LaTeX compile / snippet compile
  ├─ runtime preamble
  ├─ MCP tool handlers
  ├─ MCP-owned pdf_id session registry
  ├─ SyncTeX forward/reverse mapping
  ├─ PDF event store for get_pdf_events
  └─ MCP Viewer Host Client
        │ launches/connects locally
        ▼
Desktop Viewer Bundle (Tauri)
  ├─ Viewer Host Server
  │    ├─ HTTP routes for app/viewer/assets/PDF bytes
  │    ├─ control WebSocket/API for MCP messages
  │    ├─ viewer WebSocket hub
  │    ├─ active serving/watch registry
  │    └─ debounced PDF file-change checker
  └─ Viewer Client
       ├─ tab shell
       └─ iframe/viewer instance per PDF tab
```

The Viewer Host Server is a distinct component even though v1 launches it from Tauri. It should be structured so it could later become a headless PC-side server without rewriting the Viewer Client.

## Platform scope

- Required: macOS, Linux.
- Best effort: Windows.
- The Viewer Host Server binds to `127.0.0.1` only in v1.
- The Tauri window loads the Host-Server-served Viewer Client URL, not a separately bundled UI entry that bypasses the server.

## Component responsibilities

### MCP process owns

- MCP protocol and tool schema.
- `show_latex`, `compile_latex_file`, `open_pdf`, `jump_pdf`, `get_pdf_events`, `set_latex_preamble`.
- `pdf_id` allocation and session registry.
- LaTeX compilation and runtime preamble behavior.
- SyncTeX mapping.
- Agent-readable PDF event store.
- Launch/reconnect logic for the Desktop Viewer Bundle.
- Re-registering known PDFs with a restarted Viewer Host Server when needed.

### Viewer Host Server owns

- Serving Viewer Client web UI:
  - `/app` or equivalent tab shell route;
  - `/viewer/<pdf_id>` or equivalent per-PDF viewer route.
- Serving PDF.js and viewer assets.
- Serving registered PDF bytes by MCP-provided `pdf_id` only.
- Active server-side registry mirror for currently registered PDFs:
  - `pdf_id`;
  - PDF path;
  - display title;
  - current revision;
  - file snapshot;
  - connected viewer clients.
- Debounced PDF file-change checking:
  - stat/poll tracked PDFs;
  - wait for stable size/mtime;
  - increment server-side revision;
  - broadcast `pdf_refresh` to connected viewer clients.
- Forwarding SyncTeX display messages from MCP to viewer clients.
- Forwarding reverse SyncTeX click/tap coordinates from viewer clients to MCP.

### Viewer Client owns

- Minimal tab shell.
- Opening/focusing tabs requested by the Host Server.
- Closing visible tabs locally.
- Embedding a PDF viewer instance per tab.
- Rendering the existing custom PDF.js-based viewer.
- Receiving `pdf_refresh` and reloading PDF bytes.
- Receiving forward SyncTeX messages and scrolling/highlighting.
- Sending reverse SyncTeX click coordinates.

## MCP tool surface v1

Keep:

- `show_latex`
- `compile_latex_file`
- `open_pdf`
- `jump_pdf`
- `get_pdf_events`
- `set_latex_preamble`

Remove:

- `close_pdf`

Tool behavior changes:

- `open_pdf`, `show_latex`, and `compile_latex_file(open_pdf=true)` register/open PDFs through the Viewer Host Server.
- `jump_pdf` computes SyncTeX in MCP and sends a viewer display request through the Viewer Host Server.
- `get_pdf_events` continues to read MCP-owned event state.
- Closing a tab in the Viewer Client does not remove or invalidate the MCP `pdf_id`.

## Viewer Host control protocol

The exact framing is an implementation detail, but v1 should use explicit typed JSON messages between MCP and Viewer Host Server.

Representative MCP → Host messages:

```json
{ "type": "hello", "protocol_version": 1 }
{ "type": "open_pdf", "pdf_id": 123, "pdf_path": "/path/main.pdf", "title": "main.pdf" }
{ "type": "focus_pdf", "pdf_id": 123 }
{ "type": "synctex_forward", "pdf_id": 123, "page": 2, "x": 100, "y": 500, "source_file": "/path/main.tex", "line": 42 }
{ "type": "pdf_maybe_updated", "pdf_id": 123 }
```

Representative Host → MCP messages:

```json
{ "type": "ready", "protocol_version": 1, "origin": "http://127.0.0.1:43125" }
{ "type": "viewer_loaded", "pdf_id": 123 }
{ "type": "viewer_tab_closed", "pdf_id": 123 }
{ "type": "reverse_synctex", "pdf_id": 123, "page": 2, "x": 100, "y": 500 }
```

`pdf_maybe_updated` is a latency hint only. The Viewer Host Server verifies file snapshots before incrementing revision or refreshing viewers.

## HTTP/WebSocket serving requirements

Logical routes:

- `GET /app` — tab shell Viewer Client.
- `GET /viewer/<pdf_id>` — per-PDF viewer page or iframe route.
- `GET /config/<pdf_id>.json` — viewer config for a registered PDF.
- `GET /pdf/<pdf_id>?revision=<n>` — PDF bytes for a registered PDF.
- `GET /assets/...` — PDF.js and viewer assets.
- Viewer WebSocket route for viewer-client messages.
- Control route/socket for MCP messages.

Requirements:

- Bind only to `127.0.0.1` in v1.
- Serve PDF bytes only for registered `pdf_id`s.
- Do not accept raw filesystem paths in viewer URLs.
- Reject unknown `pdf_id`s.
- Use `revision` as a cache-busting value for PDF refreshes.
- Support basic `GET`/`HEAD`; range request support is desirable for PDF.js robustness but not a user-facing v1 feature unless required by the chosen viewer implementation.

## Tab behavior

- Opening a PDF creates a tab if none exists for the `pdf_id`.
- Opening an already-visible `pdf_id` focuses the existing tab.
- Closing a tab removes the visible viewer instance.
- Closing the last tab shows an empty state.
- Closing a tab may notify the MCP for diagnostics/events, but it must not invalidate the MCP `pdf_id`.
- If MCP later opens or jumps to a closed-tab `pdf_id`, the Host Server/Viewer Client should recreate or focus a visible tab.

## PDF refresh behavior

The Viewer Host Server performs debounced file-change checking for registered PDFs.

Expected behavior:

1. On `open_pdf`, store an initial file snapshot and revision.
2. Poll/stat registered PDF paths.
3. When size or mtime changes, wait until the snapshot is stable for a short debounce period.
4. Increment the server-side revision.
5. Broadcast `pdf_refresh` to connected viewer clients for that `pdf_id`.
6. Viewer clients reload `/pdf/<pdf_id>?revision=<revision>`.

This makes user-initiated or external PDF changes visible without requiring MCP to be the only update source.

## Lifecycle behavior

- MCP starts or connects to one Desktop Viewer Bundle per MCP session.
- The Desktop Viewer Bundle launches the Viewer Host Server.
- The Viewer Host Server exits when the viewer bundle exits.
- If the viewer bundle/server exits while MCP remains alive, MCP keeps its session registry.
- On the next viewer operation, MCP relaunches/reconnects and re-registers PDFs as needed.
- PDF ids remain MCP-session-local and do not survive MCP process restart.

## Security and boundary requirements

- Local-only bind to `127.0.0.1`.
- No auth/session token in v1.
- No LAN exposure in v1.
- No arbitrary file serving.
- PDF paths cross the MCP → Host Server control boundary only; they are not exposed in viewer URLs.
- The Host Server should treat MCP control messages as trusted local-session input for v1.

## Current viewer implementation scope

V1 reuses the existing custom PDF.js-based viewer rather than the full stock PDF.js viewer application.

Required viewer capabilities:

- render registered PDF pages;
- refresh PDF bytes after `pdf_refresh`;
- display forward SyncTeX highlight/marker;
- send reverse SyncTeX click coordinates;
- operate inside a tab iframe or equivalent isolated viewer container.

Deferred viewer capabilities:

- stock PDF.js outline/sidebar;
- search;
- full zoom UI;
- trim UI;
- comments;
- jump history;
- connection/status polish beyond minimal diagnostics.

## Testing and verification goals

Automated verification should cover:

- `tools/list` does not include `close_pdf`.
- MCP can use a fake Viewer Host Client for open/jump flows.
- `open_pdf` sends an `open_pdf` message with MCP-owned `pdf_id` and resolved PDF path.
- `show_latex` and `compile_latex_file(open_pdf=true)` route viewer opens through the Viewer Host Client.
- `jump_pdf` sends `synctex_forward` after mapping coordinates.
- Viewer Host Server rejects unregistered `pdf_id` PDF requests.
- Viewer Host Server serves registered PDF bytes.
- Viewer Host Server increments revision and broadcasts refresh after debounced file changes.
- Viewer Client tab close does not call or require an MCP close flow.
- MCP can relaunch/re-register with a restarted fake or test Host Server.

Manual smoke verification:

1. Start the MCP server through the agent MCP configuration.
2. Call `show_latex`; confirm the Tauri desktop viewer opens with one tab.
3. Call `open_pdf` for another PDF; confirm a second tab appears or existing tab focuses.
4. Close a tab in the viewer; confirm the app remains open and no `close_pdf` tool is involved.
5. Reopen the same PDF; confirm the tab returns.
6. Call `jump_pdf`; confirm the visible viewer scrolls/highlights the target.
7. Modify or regenerate a tracked PDF; confirm the visible tab refreshes after debounce.
8. Confirm `close_pdf` is absent from MCP tools.

## Relevant implementation areas

Current PDF.js integration worktree/reference areas:

- `src/modules/pdfjs_viewer_mcp_service.ts`
- `src/modules/pdfjs_viewer_server.ts`
- `src/modules/pdfjs_viewer_registry.ts`
- `src/modules/stdio_mcp_runtime.ts`
- `src/modules/host_service_mcp.ts`

Reference viewer implementation:

- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/connection.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/refresh.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/synctex.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/preview/server.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/preview/viewer.ts`

## Open follow-ups after v1

- Remote/mobile client support.
- Auth/pairing/session token design.
- Stock PDF.js viewer/sidebar/search/toolbar evaluation.
- Zoom and richer GUI controls.
- Comments UI and agent comment-fetch workflow.
- Continuous compilation controls.
- Persistent/headless Host Server mode.

# PRD: Stdio MCP PDF.js Viewer and SyncTeX Runtime

## Status

Draft / accepted direction from planning discussion.

## Summary

Replace the current persistent host-service/Zathura architecture with a stdio MCP server that is launched by the agent when the MCP server is loaded. The MCP process owns all runtime state for LaTeX compilation, PDF registrations, PDF.js viewer communication, file-change polling, and SyncTeX mapping. It starts a loopback HTTP/WebSocket viewer server on demand and opens PDFs in a browser-hosted PDF.js viewer for v1.

This PRD intentionally removes all custom inline rendering, Zathura integration, persistent daemon/systemd machinery, and continuous compilation from v1.

## Goals

- Expose all user-facing capabilities as MCP tools over stdio.
- Launch no persistent daemon. The MCP process is the runtime authority while it is alive.
- Run PDF.js in a normal browser tab/window for v1, served from a loopback HTTP server owned by the MCP process.
- Keep the viewer protocol app-neutral so a future standalone app can wrap the same viewer.
- Port only viewer and SyncTeX-relevant code from LaTeX-Workshop, but keep v1 viewer scope minimal.
- Use browser/PDF.js viewer for all `show_latex` previews; remove inline image rendering entirely.
- Store reverse SyncTeX click events in the MCP runtime and let agents fetch the last N events with a tool.
- Automatically detect changes to tracked PDF files and tell connected viewers to refresh.
- Preserve current runtime preamble behavior for snippets: automatically seed from `preamble.tex` or `praeamble.tex`, and keep the preamble-setting tool.
- Remove continuous compilation entirely from v1 schemas, docs, code paths, and tests.

## Non-goals

- No Zathura support.
- No systemd user service.
- No long-running Unix-socket host-service daemon.
- No Pi inline Kitty/image rendering.
- No continuous compilation or `latexmk -pvc` mode.
- No guaranteed browser window process close in v1.
- No auth/capability-token design for the loopback viewer in v1; registered `pdf_id` plus loopback binding is the intended boundary.
- Licensing/notice cleanup is deferred to a later pass per project direction.

## Runtime architecture

```text
Agent
  <stdio MCP>
tex-actions-mcp process
  ├─ MCP protocol/framing
  ├─ MCP tool handlers
  ├─ one-shot LaTeX file compiler
  ├─ snippet compiler + runtime preamble support
  ├─ in-memory PDF registry
  ├─ tracked-PDF file-change poller
  ├─ in-memory PDF event store
  ├─ SyncTeX parser/mapper
  └─ loopback HTTP + WebSocket viewer server
        └─ browser tab/window running PDF.js viewer
```

The MCP server starts when the agent loads the server. Runtime state, including `pdf_id`s, connected viewers, file-change snapshots, stored PDF events, and the loopback PDF.js HTTP/WebSocket server, is in memory and ends when the MCP process exits. A returned `viewer_url` is valid only while that same stdio MCP process remains alive; clients that need active viewers across tool calls must keep the MCP server process alive. MCP client configuration must launch the installed `tex-actions-mcp` bin or another direct Node command, not `npm run ...`, because npm output can corrupt stdio framing.

## Workspace and path resolution

The MCP server uses the process working directory it was launched from as the workspace base. Relative paths passed to tools are resolved relative to that launch cwd. Absolute paths are used as provided after normal path normalization.

The MCP process must not infer paths from browser URLs or from arbitrary HTTP request paths. HTTP PDF serving is by registered `pdf_id` only.

## Runtime preamble behavior

Snippet compilation preserves the current preamble model:

- On MCP startup, look for `./preamble.tex` and then `./praeamble.tex` relative to the MCP launch cwd.
- If found, copy/use that content as the runtime snippet preamble.
- `show_latex` applies the active runtime preamble to snippets.
- `set_latex_preamble` remains a v1 MCP tool and updates the active runtime preamble for subsequent snippets.
- `compile_latex_file` compiles complete files directly and does not inject the runtime preamble.

## Viewer location

For v1, PDF.js runs in a normal browser tab/window opened to a loopback URL, for example:

```text
http://127.0.0.1:<port>/viewer.html?pdf_id=123
```

The MCP process serves the viewer shell, viewer JavaScript/CSS, PDF.js assets, configuration JSON, and registered PDF bytes.

## Viewer communication

Communication is browser WebSocket based:

```text
MCP process <--HTTP/WebSocket on 127.0.0.1--> browser PDF.js viewer
```

### HTTP endpoints

The exact paths may vary, but v1 should provide these logical endpoints:

- `GET /viewer.html?pdf_id=<id>` — browser viewer shell.
- `GET /config.json` — viewer configuration.
- `GET /pdf/<pdf_id>` — PDF bytes for a registered PDF.
- `GET /viewer/...` — adapted viewer client assets.
- `GET /build/...`, `/cmaps/...`, `/standard_fonts/...`, `/wasm/...` — PDF.js runtime assets, preferably from `pdfjs-dist`.

The server must only serve registered PDFs by `pdf_id`; arbitrary filesystem reads from URL paths are out of scope and must be rejected. `pdf_id` is sufficient for v1; do not add a token/capability layer unless the project revisits this decision.

### WebSocket endpoint

```text
ws://127.0.0.1:<port>/viewer-ws?pdf_id=<id>
```

The MCP process tracks connected viewer sockets by `pdf_id`.

### Viewer to MCP messages

Representative messages:

```json
{ "type": "open", "pdf_id": 123 }
{ "type": "loaded", "pdf_id": 123 }
{ "type": "reverse_synctex", "pdf_id": 123, "page": 2, "pos": [100, 500], "textBeforeSelection": "", "textAfterSelection": "" }
{ "type": "ping" }
{ "type": "add_log", "message": "..." }
{ "type": "cannot_synctex" }
```

Reverse SyncTeX clicks are computed server-side and appended to the in-memory PDF event store.

### MCP to viewer messages

Use clearer names than LaTeX-Workshop's original `refresh`/`reload` wire names:

```json
{ "type": "pdf_refresh", "revision": 4 }
{ "type": "viewer_reload" }
{ "type": "synctex", "data": { "page": 2, "x": 100, "y": 500, "indicator": true } }
```

Definitions:

- `pdf_refresh`: reload the PDF document inside the existing PDF.js viewer while preserving viewer state where possible. Used after recompilation or file-change polling detects updated PDF bytes. Include a monotonically increasing PDF `revision` so the viewer can cache-bust when requesting `/pdf/<pdf_id>?revision=<revision>`.
- `viewer_reload`: reload the entire browser page with `location.reload()`. Used only for full viewer reset or configuration/asset/protocol changes.
- `synctex`: scroll/highlight a forward SyncTeX target in the viewer.

## Automatic PDF refresh

The browser viewer is mostly passive: it can reload when told, but it cannot reliably watch local files itself. The MCP runtime should therefore watch/poll tracked PDF paths.

V1 behavior:

- Each registered PDF record stores a file snapshot, such as size and `mtimeMs`.
- The MCP process periodically polls tracked PDF files.
- When size or mtime changes and the file appears stable after a short debounce, increment the record revision and send `pdf_refresh` to connected viewers for that `pdf_id`.
- Tool-driven recompiles should also update the registry snapshot and send `pdf_refresh` when they modify an already tracked PDF.
- `pdf_refresh` should preserve current viewer state where possible: page, zoom, scroll, trim if implemented, and sidebar/scroll mode if implemented.

## MCP tool surface v1

### `show_latex`

Compile a LaTeX snippet into a temporary document and open the resulting PDF in the PDF.js viewer.

- Always creates a temporary `.tex` document.
- Always opens via the viewer.
- No `inline` argument.
- No inline image/raster payload.
- Returns `pdf_id`, `pdf`, `source`, `log`, and `viewer_url`.
- Each call may allocate a new operation-scoped snippet PDF and `pdf_id`; no fixed-preview reuse is required for v1.

### `compile_latex_file`

Compile an existing local `.tex` file once with latexmk-backed behavior.

- Supports `latex_file_path`, `compiler`, `clean`, `open_pdf`, and warning verbosity if retained.
- Relative `latex_file_path` values resolve against the MCP launch cwd.
- If `open_pdf=true`, registers/opens the resulting PDF in the PDF.js viewer.
- If the resulting PDF is already registered, reuse the existing record where practical, update its revision/snapshot, and send `pdf_refresh` to connected viewers.
- No `continuous` argument.
- No continuous compile subscription, heartbeat, pending notification, or background compiler state.

### `open_pdf`

Register an existing PDF and open it in the PDF.js viewer.

- Relative `pdf_file_path` values resolve against the MCP launch cwd.
- Returns `pdf_id`, `pdf`, and `viewer_url`.
- Reopening an already registered normalized PDF path should return/reuse the existing active record where practical.

### `jump_pdf`

Perform forward SyncTeX into a tracked PDF.

- Inputs: `pdf_id`, `line`, optional `source_file`.
- Relative `source_file` values resolve against the MCP launch cwd.
- Computes page/coordinates using the ported SyncTeX mapper.
- Sends a `synctex` WebSocket message to connected viewer(s).
- Returns the source line for agent verification.

### `get_pdf_events`

Fetch the last N stored PDF events, especially reverse SyncTeX click events.

Input:

```json
{
  "max_events": 20,
  "pdf_id": 123
}
```

- `max_events` is required and must be a positive integer.
- `pdf_id` is optional; when omitted, return the last N events across tracked PDFs.
- Results are non-destructive.
- Return events in chronological order after selecting the last N matching events.

Suggested output event shape:

```json
{
  "sequence": 18,
  "pdf_id": 123,
  "kind": "reverse_synctex",
  "source_file": "/path/main.tex",
  "line": 42,
  "column": 0,
  "source_line": "\\section{Intro}",
  "created_at": "2026-06-25T00:00:00.000Z"
}
```

### `close_pdf`

Untrack a registered PDF and best-effort ask connected viewer(s) to close or disconnect.

- Browser window/tab close is not guaranteed in v1.
- Tool output must not promise process termination.

### `set_latex_preamble`

Set the runtime preamble used by subsequent snippet compilations.

## Viewer v1 scope

V1 should be explicit about the difference between the minimum viewer needed and LaTeX-Workshop features that can wait.

Required v1 viewer capabilities:

- load PDF.js in a browser tab/window;
- connect to the MCP WebSocket;
- open a registered `pdf_id`;
- handle `pdf_refresh` without full page reload;
- handle `viewer_reload` as full page reload;
- handle forward SyncTeX `synctex` scroll/highlight;
- send reverse SyncTeX click coordinates to the MCP server;
- keep enough page/zoom/scroll state to make PDF refresh usable;
- keep connection ping/reconnect behavior simple and robust.

Deferrable LaTeX-Workshop viewer features unless needed for basic usability:

- trim-margin UI and trimming CSS;
- custom toolbar buttons for SyncTeX enable/disable and auto-refresh enable/disable;
- sidebar persistence and advanced PDF.js UI patching;
- hand tool, invert mode, theme/color customization;
- history back/forward buttons and mouse-button navigation;
- VS Code iframe keyboard rebroadcast and parent `postMessage` state restore;
- VS Code-specific external-link/copy forwarding;
- broad localization assets beyond what PDF.js requires for the bundled viewer.

## Code to port/adapt from LaTeX-Workshop

Viewer-side candidates:

- `viewer/latexworkshop.ts`
- `viewer/components/connection.ts`
- `viewer/components/synctex.ts`
- `viewer/components/refresh.ts`
- `viewer/components/state.ts`
- `viewer/components/gui.ts` only to the extent needed for required v1 capabilities;
- `viewer/components/trimming.ts` only if trim is retained in v1;
- `viewer/components/viewerhistory.ts` only if history navigation is retained in v1;
- `viewer/components/utils.ts`
- `viewer/components/interface.ts`
- `viewer/latexworkshop.css` only for required v1 styling and SyncTeX indicators.

SyncTeX-side:

- `src/locate/synctex/synctexjs.ts`
- Coordinate logic from `src/locate/synctex/worker.ts`, adapted to pure Node paths/filesystem APIs.

Do not port VS Code-facing wrappers from LaTeX-Workshop.

## Existing implementation locations

Reference repo root: `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop`.

- Viewer architecture notes: `viewer/README.md`.
- PDF.js viewer shell/assets: `viewer/viewer.html`, `viewer/viewer.css`, `viewer/viewer.mjs`.
- Viewer initialization/root wiring: `viewer/latexworkshop.ts`.
- Browser WebSocket protocol: `viewer/components/connection.ts`.
- Browser forward/reverse SyncTeX: `viewer/components/synctex.ts`.
- Browser PDF refresh/state restore: `viewer/components/refresh.ts`, `viewer/components/state.ts`.
- Viewer URL/config helpers and PDF.js internal typings: `viewer/components/utils.ts`, `viewer/components/interface.ts`.
- Original protocol shapes: `types/latex-workshop-protocol-types/index.d.ts`.
- HTTP/static/PDF/WebSocket serving model: `src/preview/server.ts`.
- Server-side viewer message handling and locate/refresh flow: `src/preview/viewer.ts`.
- SyncTeX parser and coordinate mapper: `src/locate/synctex/synctexjs.ts`, `src/locate/synctex/worker.ts`.
- VS Code-facing reverse SyncTeX context to inspect but not port: `src/locate/synctex.ts`.

Current repo locations to supersede or reuse:

- Stdio relay to replace: `scripts/tex-actions-mcp.ts`, `src/modules/codex_mcp/codex_mcp_server.ts`.
- Current MCP framing/schema logic to mine: `src/modules/host_service_mcp.ts`.
- Current persistent daemon/socket runtime to remove: `src/modules/host_service.ts`.
- Current Zathura backend to remove: `src/modules/host_service_viewer_backends.ts`.
- One-shot compiler and preamble code to reuse/adapt: `src/modules/latex/latex_file_compiler.ts`, `src/modules/latex/latex_preamble.ts`, `src/modules/runtime_preamble.ts`.
- Current inline renderer/raster preview code to remove: `src/modules/preview/inline_preview.ts`, `src/modules/pi_extension/inline_renderer.ts`.
- Current continuous compilation code to remove: `src/modules/host_service_continuous_compile.ts`.

## Dependencies and assets

Add dependencies required by the copied/adapted implementation rather than preserving the old dependency set.

Expected additions:

- `pdfjs-dist` for PDF.js runtime assets;
- `ws` or another WebSocket implementation if Node's built-in APIs are insufficient for the target runtime;
- `iconv-lite` if preserving LaTeX-Workshop's SyncTeX filename decoding behavior.

The viewer build should have an explicit TypeScript/browser build path or asset-copy step so `viewer/latexworkshop.ts` and components are available to the loopback HTTP server as browser JavaScript.

## Current code to remove or supersede

The implementation should remove or fully supersede these architectural areas:

- persistent Host Service server/client/socket protocol;
- Codex daemon relay;
- Zathura viewer backend and callback command machinery;
- systemd service files and broker docs/scripts;
- Pi inline renderer and Kitty/raster preview support;
- continuous compilation manager, session leases, heartbeats, and pending notifications;
- `inline` and `continuous` fields in MCP schemas and prompt guidance.

## PDF registry requirements

Each opened PDF gets a runtime `pdf_id` allocated by the MCP process.

A PDF registry record should include at least:

- `pdf_id`;
- normalized PDF path;
- inferred/default source path when known;
- viewer URL;
- connected WebSocket clients;
- created timestamp;
- file snapshot used by the poller;
- monotonically increasing PDF revision;
- optional metadata for snippet operation PDF/source/log paths.

`pdf_id`s are process-local and do not survive MCP process exit.

## SyncTeX requirements

- Snippet and file compiles must produce SyncTeX sidecars when possible.
- `jump_pdf` must use JS SyncTeX mapping, not viewer-native command-line forward search.
- Reverse clicks are computed server-side from PDF page coordinates sent by the viewer.
- Source paths from SyncTeX should be normalized and decoded enough to support common LaTeX engine encodings.
- If SyncTeX data is missing or cannot map a point/line, tools/events should report a clear error.

## Security and boundary requirements

- HTTP server binds to loopback only.
- PDF endpoint serves only registered `pdf_id`s; no unregistered filesystem paths are served.
- Static file serving must prevent directory traversal.
- Tool path inputs are resolved relative to the MCP process launch cwd unless absolute.
- Browser URL launching is allowed only through a dedicated browser-launcher boundary.
- Do not shell out to GUI PDF viewers to open PDF files directly.
- No access to arbitrary host-service/broker/systemd control paths.

## Testing and verification

Automated verification should cover:

- actual `scripts/tex-actions-mcp.ts` entrypoint speaks MCP over stdio and does not relay to a daemon socket;
- MCP initialize/tools/list works over stdio framing;
- tools list contains no `inline` or `continuous` fields;
- relative tool paths resolve against the MCP launch cwd;
- startup preamble is seeded from launch-cwd `preamble.tex`/`praeamble.tex`;
- `show_latex` creates a temporary document and returns a viewer URL plus `pdf_id`;
- `compile_latex_file` performs one-shot compile only and rejects/removes `continuous`;
- HTTP PDF endpoint serves registered PDFs and rejects unregistered paths/IDs;
- WebSocket viewer registration associates clients with `pdf_id`;
- `jump_pdf` sends a `synctex` message to connected viewers;
- reverse SyncTeX WebSocket message stores an event retrievable by `get_pdf_events`;
- `get_pdf_events` returns the last requested N events;
- file-change polling sends `pdf_refresh` after tracked PDF bytes change and stabilize;
- `pdf_refresh` preserves the browser page and reloads PDF bytes;
- `viewer_reload` maps to a full viewer page reload;
- guardrail tests reject Zathura/direct PDF viewer commands, persistent host-service socket references, systemd assumptions, inline raster preview regressions, and continuous-compilation regressions.

Manual smoke verification:

1. Start the MCP server through the agent MCP configuration.
2. Call `show_latex`; confirm a browser PDF.js viewer opens.
3. Call `compile_latex_file(..., open_pdf=true)`; confirm the compiled PDF opens.
4. Call `jump_pdf`; confirm the viewer scrolls/highlights the target.
5. Ctrl-click/double-click in the viewer; call `get_pdf_events`; confirm the source location and source line are returned.
6. Modify a tracked PDF externally or via one-shot compile; confirm polling/tool behavior sends `pdf_refresh` and updates the visible PDF without full browser reload.
7. Confirm no persistent daemon remains after MCP process exit.

## Open follow-ups

- Licensing and notices for vendored LaTeX-Workshop/PDF.js-derived assets are explicitly deferred.
- Browser launch strategy should be minimal in v1 and isolated so a standalone app can replace it later.
- Browser tab/window closing semantics are intentionally weak in v1; a future standalone app can provide stronger lifecycle control.

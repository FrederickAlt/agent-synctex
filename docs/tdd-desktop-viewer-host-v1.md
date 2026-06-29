# TDD Plan: Desktop Viewer Host v1

## Status

Draft plan for `docs/prd-desktop-viewer-host-v1.md`.

Implementation note for the #115 integrated branch: automated verification uses the headless loopback Viewer Host Server process launched from MCP. Native Tauri Desktop Viewer Bundle launch and HITL/manual desktop-window audit remain deferred to #116 or explicit configured packaging.

## Scope

This TDD plan covers only the first computer-based version of the standalone viewer bundle:

- Tauri desktop bundle for macOS/Linux minimum and Windows best-effort.
- Separate Viewer Host Server component launched by Tauri.
- Host-Server-served Viewer Client web UI.
- Minimal tab support.
- Existing custom PDF.js-based viewer.
- App/Host-owned PDF serving and debounced PDF file-change refresh.
- MCP integration through a Viewer Host Client.
- Removal of public `close_pdf`.

This plan intentionally excludes full GUI controls, stock PDF.js toolbar/sidebar/search, comments, continuous compilation UI, mobile, remote LAN mode, and auth/session-token design.

## Test strategy

Use small red-green-refactor slices. Prefer pure module tests first, then protocol/server tests, then MCP integration tests, then minimal UI tests and manual smoke.

Recommended test layers:

1. **Protocol/unit tests** for message schemas and state transitions.
2. **MCP unit/integration tests** with a fake Viewer Host Client.
3. **Viewer Host Server tests** using temporary PDFs and local HTTP/WebSocket clients.
4. **Viewer Client logic tests** for tab state and message handling.
5. **Desktop bundle smoke tests** where practical, plus manual verification for Tauri window behavior.

## Phase 0: test harness and fixtures

### Add fixtures/helpers

Create test helpers for:

- temporary PDF files;
- fake PDF content changes with controlled `mtime`/size;
- fake Viewer Host Client;
- in-memory or local-loopback Host Server startup;
- WebSocket test clients;
- tab-state reducer tests for the Viewer Client.

### Verification

- A fixture PDF can be served/read in tests.
- A fake Viewer Host Client can record messages from MCP code without launching Tauri.
- Host Server tests can bind to an ephemeral local port and shut down cleanly.

## Phase 1: remove `close_pdf` from MCP surface

### Red tests

Add/adjust MCP tool-list tests:

- `tools/list` does not include `close_pdf`.
- `tools/list` still includes:
  - `show_latex`
  - `compile_latex_file`
  - `open_pdf`
  - `jump_pdf`
  - `get_pdf_events`
  - `set_latex_preamble`
- Calls to removed `close_pdf` return a normal unknown-tool error.

### Green implementation

- Remove `close_pdf` from schema/listing.
- Remove public handler path for `close_pdf`.
- Keep internal records available until MCP session shutdown.

### Refactor checks

- Remove obsolete close capability claims from viewer-facing status/details where this v1 path uses the Viewer Host.
- Do not remove unrelated close code from old architectures unless the implementation slice explicitly supersedes it.

## Phase 2: define Viewer Host protocol types

### Red tests

Add protocol tests for representative messages:

MCP → Host:

- `hello`
- `open_pdf`
- `focus_pdf`
- `synctex_forward`
- `pdf_maybe_updated`

Host → MCP:

- `ready`
- `viewer_loaded`
- `viewer_tab_closed`
- `reverse_synctex`

Validation tests should reject:

- missing `type`;
- unknown message type;
- invalid `pdf_id`;
- empty `pdf_path` for `open_pdf`;
- invalid coordinates for SyncTeX messages.

### Green implementation

- Add shared protocol module/types.
- Keep message versioning explicit with `protocol_version` where applicable.

### Refactor checks

- Protocol types must be framework-neutral: no Tauri imports, no MCP transport imports, no browser globals.

## Phase 3: MCP Viewer Host Client boundary

### Red tests

Using a fake Viewer Host Client:

- `open_pdf` resolves/validates a PDF and sends Host `open_pdf` with MCP-owned `pdf_id` and normalized path.
- Opening an already-known PDF reuses the MCP record and sends `focus_pdf` or `open_pdf` according to the chosen implementation behavior.
- `show_latex` compiles snippet and routes viewer open through the Viewer Host Client.
- `compile_latex_file(open_pdf=true)` routes viewer open through the Viewer Host Client.
- `jump_pdf` computes SyncTeX and sends `synctex_forward` with page/x/y/source/line.
- If the Viewer Host Client is disconnected, the MCP attempts relaunch/reconnect before the next viewer operation.

### Green implementation

- Introduce `ViewerHostClient` interface on the MCP side.
- Replace MCP-owned PDF.js HTTP/browser launching in the v1 path with Viewer Host Client calls.
- Keep MCP `pdf_id` session registry durable for the MCP process lifetime.

### Refactor checks

- MCP remains responsible for SyncTeX mapping and event storage.
- Viewer Host Client interface should not expose UI-specific tab internals beyond open/focus/update/jump and inbound events.

## Phase 4: Viewer Host Server registry

### Red tests

Add Host Server registry tests:

- Register `pdf_id` with path/title and initial snapshot.
- Re-register same `pdf_id` updates metadata without allocating a new id.
- Unknown `pdf_id` lookup fails clearly.
- Closing a viewer tab does not remove the PDF registration.
- Registry can list active registered PDFs for rehydrating the Viewer Client.

### Green implementation

- Implement Host Server active registry mirror.
- Store:
  - `pdf_id`;
  - PDF path;
  - title;
  - revision;
  - file snapshot;
  - client/tab connection metadata as needed.

### Refactor checks

- Do not make the Host Server allocate MCP-visible `pdf_id`s.
- Keep registry independent from Tauri APIs.

## Phase 5: Host Server HTTP PDF serving

### Red tests

Start Host Server on `127.0.0.1:0` and assert:

- `GET /pdf/<registered_id>?revision=1` returns PDF bytes.
- `HEAD /pdf/<registered_id>?revision=1` returns success and no body.
- `GET /pdf/<unknown_id>` returns 404.
- URL paths cannot read arbitrary files.
- Raw filesystem paths in URLs are ignored/rejected.
- PDF response uses no-store or revision-safe cache behavior.

Optional/desirable if practical:

- `Range` requests return valid partial content for registered PDFs.

### Green implementation

- Add HTTP routes for registered PDF bytes.
- Serve only by registered `pdf_id`.
- Bind local-only for v1.

### Refactor checks

- Keep PDF path out of browser-visible URLs.
- Ensure server shutdown closes sockets and releases port.

## Phase 6: Host Server serves Viewer Client and assets

### Red tests

- `GET /app` returns the tab shell HTML.
- `GET /viewer/<registered_id>` returns viewer iframe/page HTML.
- `GET /config/<registered_id>.json` returns PDF config with `pdf_id`, current revision, PDF URL, and viewer socket URL.
- Unknown `pdf_id` config/viewer routes fail safely.
- PDF.js asset routes return expected JavaScript assets or bundled files.

### Green implementation

- Serve Host-Server-owned Viewer Client assets.
- Serve current custom PDF.js viewer script/assets.
- Keep Tauri loading the Host Server `/app` URL rather than a separate direct file entry.

### Refactor checks

- Viewer Client must be usable from normal HTTP in the local desktop shell.
- Avoid hardcoding Tauri-only APIs in viewer web code.

## Phase 7: Host Server control channel

### Red tests

Using a local control client:

- Host emits/returns `ready` with protocol version and origin.
- Host handles `hello`.
- Host handles `open_pdf` by registering PDF and notifying Viewer Client state.
- Host handles `focus_pdf` by notifying Viewer Client state.
- Host handles `synctex_forward` by broadcasting to viewer clients for that `pdf_id`.
- Invalid control messages get deterministic errors and do not mutate registry.

### Green implementation

- Add control WebSocket or equivalent local JSON channel.
- Implement message dispatch.
- Wire it to the Host Server registry and viewer hub.

### Refactor checks

- Keep v1 unauthenticated but local-only.
- Keep protocol implementation separable from Tauri window code.

## Phase 8: Viewer WebSocket hub

### Red tests

With fake viewer WebSocket clients:

- A viewer client can connect for a registered `pdf_id`.
- Unknown `pdf_id` viewer connection is rejected.
- `synctex_forward` is delivered only to clients for the target `pdf_id`.
- `pdf_refresh` is delivered only to clients for the target `pdf_id`.
- Reverse SyncTeX message from viewer is forwarded to MCP control side.
- Disconnect cleanup removes viewer client registration.

### Green implementation

- Add viewer WebSocket route.
- Track clients by `pdf_id`.
- Broadcast targeted messages.
- Forward reverse SyncTeX events to MCP.

### Refactor checks

- A closed UI tab should remove its viewer socket but not unregister the PDF.

## Phase 9: debounced PDF file-change checker

### Red tests

Use temporary PDF files and controlled polling intervals:

- No refresh when size/mtime snapshot is unchanged.
- First changed snapshot starts pending debounce but does not immediately refresh.
- Stable changed snapshot after debounce increments revision and broadcasts `pdf_refresh`.
- Multiple rapid changes collapse to one refresh with the latest snapshot.
- Unreadable/missing PDF does not crash the server and reports a clear diagnostic state.
- `pdf_maybe_updated` triggers an immediate check or short-circuits polling latency but still verifies snapshot.

### Green implementation

- Add poll/stat checker owned by Viewer Host Server.
- Store pending snapshots and stable timestamps.
- Increment Host Server revision after stable changes.
- Broadcast `pdf_refresh` with new revision and PDF URL.

### Refactor checks

- Pause or reduce expensive work when no viewer clients are connected if simple, but do not change registration lifetime.
- Keep debounce parameters injectable for tests.

## Phase 10: Viewer Client tab shell

### Red tests

Add pure tab-state tests:

- `open_pdf` creates a tab.
- Opening same `pdf_id` focuses existing tab.
- Multiple PDFs create multiple tabs.
- Closing active tab selects a reasonable neighboring tab or empty state.
- Closing a tab emits `viewer_tab_closed` but does not request MCP close.
- Host `focus_pdf` for a closed-but-registered PDF recreates or reopens a visible tab according to chosen UI behavior.

### Green implementation

- Implement minimal Viewer Client tab shell.
- Use iframe-per-PDF-tab or equivalent isolated viewer containers.
- Add close button per tab and empty state.

### Refactor checks

- Do not add zoom/sidebar/full toolbar work in this phase.
- Keep tab shell separate from PDF.js viewer internals.

## Phase 11: custom PDF.js viewer integration

### Red tests

Where browser/DOM tests are practical:

- Viewer route loads config for `pdf_id`.
- Viewer requests `/pdf/<pdf_id>?revision=<revision>`.
- Receiving `pdf_refresh` updates revision/PDF URL and reloads document.
- Receiving `synctex_forward` scrolls/highlights or calls the extracted marker function with expected values.
- Click handler sends `reverse_synctex` coordinates.

For logic hard to prove in jsdom/headless tests, extract pure helpers and leave manual smoke for rendering.

### Green implementation

- Adapt current custom PDF.js viewer to run as Host-Server-served viewer page.
- Connect to viewer WebSocket.
- Handle refresh, forward SyncTeX, and reverse SyncTeX.

### Refactor checks

- Keep viewer independent from Tauri-specific APIs.
- Avoid broad port of stock PDF.js/LaTeX-Workshop UI in v1.

## Phase 12: Tauri desktop bundle

### Red tests/checks

Automated where practical:

- Tauri-side startup code launches Viewer Host Server.
- Host Server origin is passed to/loaded by the Tauri window.
- Server shutdown is requested when the viewer bundle exits.
- Build/config includes macOS and Linux targets; Windows remains best-effort.

Manual or CI-smoke if native window automation is impractical:

- `npm`/workspace command starts desktop viewer bundle.
- Tauri window loads `/app` from Host Server.

### Green implementation

- Add Tauri app package/wrapper.
- Launch Host Server component from Tauri.
- Load Host Server `/app` URL.

### Refactor checks

- Keep Host Server usable as a separate core library/module.
- Do not put PDF serving logic directly in Tauri command handlers.

## Phase 13: MCP relaunch/re-register behavior

### Red tests

With fake client/server lifecycle:

- MCP detects Viewer Host disconnection.
- Next `open_pdf` relaunches/reconnects.
- Next `jump_pdf` for known `pdf_id` relaunches/reconnects, re-registers that PDF, then sends `synctex_forward`.
- Re-registration preserves MCP `pdf_id`.
- If relaunch fails, tool response explains viewer host unavailable without losing MCP registry state.

### Green implementation

- Add Viewer Host lifecycle manager around Viewer Host Client.
- Store enough MCP session registry metadata to re-register PDFs.

### Refactor checks

- Do not reintroduce public `close_pdf` or remote close semantics.

## Phase 14: end-to-end/manual smoke

Manual verification checklist:

1. Start MCP through normal agent MCP configuration.
2. Call `tools/list`; verify `close_pdf` is absent.
3. Call `show_latex`; verify Tauri viewer opens with one tab.
4. Call `open_pdf` for a different PDF; verify a second tab appears.
5. Call `open_pdf` again for an already-open PDF; verify existing tab focuses.
6. Close a tab; verify no MCP close tool/action is required.
7. Reopen the same PDF; verify tab reappears.
8. Call `jump_pdf`; verify visible tab scrolls/highlights.
9. Click in PDF viewer; call `get_pdf_events`; verify reverse SyncTeX event is available.
10. Modify or regenerate a tracked PDF externally; verify debounced refresh updates the visible tab.
11. Close the viewer app while MCP remains alive; call `open_pdf` or `jump_pdf`; verify relaunch/re-register behavior.

## Guardrail tests

Add/adjust guardrails to prevent regressions:

- No public `close_pdf` tool in v1.
- No MCP-owned PDF.js HTTP server path in the v1 open flow.
- No browser launcher direct `xdg-open`/`open`/`cmd start` path for v1 PDF viewing.
- No raw PDF file paths in viewer URLs.
- No LAN bind or token/auth implementation in v1 unless a later PRD explicitly changes scope.
- No full GUI/zoom/sidebar/comments features added under this v1 plan.

## Suggested implementation sequence

1. Protocol types and fake client tests.
2. Remove `close_pdf` from MCP tools.
3. MCP Viewer Host Client boundary with fake implementation.
4. Host Server registry and PDF serving.
5. Host Server asset/viewer routes.
6. Control and viewer WebSockets.
7. Debounced file-change checker.
8. Viewer Client tab shell.
9. Custom PDF.js viewer adaptation.
10. Tauri wrapper startup/shutdown.
11. MCP relaunch/re-register behavior.
12. Manual smoke.

## Relevant files and future locations

Existing/current integration areas to refactor or supersede:

- `src/modules/pdfjs_viewer_mcp_service.ts`
- `src/modules/pdfjs_viewer_server.ts`
- `src/modules/pdfjs_viewer_registry.ts`
- `src/modules/stdio_mcp_runtime.ts`
- `src/modules/host_service_mcp.ts`

Possible new areas:

- `src/modules/viewer_host_client.ts`
- `src/modules/viewer_host_protocol.ts`
- `apps/viewer-desktop-tauri/`
- `crates/viewer-host-server/` or equivalent host-server core area
- `packages/viewer-web/` or equivalent Host-Server-served Viewer Client area

Reference code:

- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/connection.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/refresh.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/synctex.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/preview/server.ts`
- `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/preview/viewer.ts`

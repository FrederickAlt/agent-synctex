# PRD: Viewer Client UX Follow-ups

## Status

Follow-up scope after `docs/prd-desktop-viewer-host-v1.md`.

This document supersedes the older browser-hosted PDF.js UX follow-up framing. The features remain useful, but they are now scoped to the Viewer Client and Viewer Host Server architecture introduced by Desktop Viewer Host v1.

## Summary

After Desktop Viewer Host v1 is working, improve the viewing experience without thickening the desktop wrapper or moving UI/runtime responsibilities back into the MCP process.

The follow-ups should preserve this split:

- **MCP process** owns MCP tools, LaTeX compilation, `pdf_id` allocation, SyncTeX mapping, and agent-readable event storage.
- **Viewer Host Server** owns PDF serving, viewer asset serving, viewer sockets, registered-PDF mirrors, file-change detection, revision updates, and Host/Client protocol routing.
- **Viewer Client** owns visible tabs, PDF.js rendering, local viewer state, user interaction, refresh handling, jump history, trim UI, and status display.
- **Desktop Viewer Bundle/Tauri wrapper** remains a thin shell that starts/contains the Host Server and loads the Host-served Viewer Client. UX logic should not live in Tauri command handlers.

The Viewer Client should stay portable web code. It should avoid Tauri-only APIs, Node filesystem access, and direct MCP calls so a later mobile/browser client can reuse the same Host protocol against a PC-side Viewer Host Server.

## Goals

- Improve human usability after Desktop Viewer Host v1 lands.
- Keep UX features in the Viewer Client unless they truly require Viewer Host Server protocol support.
- Keep the desktop wrapper thin and replaceable.
- Preserve future browser/mobile-client options by using normal HTTP/WebSocket-facing Viewer Client code.
- Preserve SyncTeX correctness while adding trim, refresh polish, and navigation state.
- Keep each feature independently implementable after the host/client split is stable.

## Non-goals

- No mobile app or remote/LAN mode in this follow-up.
- No new MCP tools unless a later PRD explicitly changes the MCP tool surface.
- No direct Viewer Client calls into the MCP process.
- No Tauri-specific Viewer Client feature logic.
- No persistent background daemon outside the Desktop Viewer Host architecture.
- No full LaTeX-Workshop toolbar port.
- No custom `.tex` section parser for document navigation.
- No full localization effort for custom controls.

## Architecture constraints

### MCP boundary

The MCP process may expose or receive only the data already required by the Desktop Viewer Host protocol, such as `pdf_id`, SyncTeX display requests, reverse SyncTeX events, and compile/open requests.

UX features should not make the MCP process responsible for browser state, tab state, trim state, pause state, or visible scroll position.

### Viewer Host Server boundary

The Viewer Host Server may need small protocol additions for status/revision metadata, but it should not own presentation policy such as trim percentage, jump-history stack, or whether a user temporarily pauses visual refresh.

The server continues to serve registered PDF bytes by `pdf_id` only and broadcasts revision/refresh information when tracked PDFs change.

### Viewer Client boundary

The Viewer Client owns local UI state and rendering behavior:

- tab selection and visible viewer instances;
- PDF.js viewer state;
- trim percentage and CSS/layout application;
- jump history/back navigation;
- pause/resume visual refresh;
- connection/revision/pending-update status display;
- reverse SyncTeX pointer/touch event capture.

Viewer Client code must remain usable in a normal browser context served by the Viewer Host Server.

## Feature 1: Connection, revision, and refresh status

### User behavior

The Viewer Client shows a small unobtrusive status indicator so users know whether the tab is connected to the Viewer Host Server and whether the visible PDF is current.

### Requirements

Status should communicate:

- Viewer Client connection to the Viewer Host Server: connected / reconnecting / disconnected;
- current `pdf_id` and tab title when known;
- current visible PDF revision;
- latest known server revision;
- whether an update is pending because visual auto-refresh is paused;
- last refresh time when cheap to show.

Status must not claim MCP connectivity unless the Viewer Host Server explicitly exposes that state. If only Host connection is known, label it as Host/viewer connection.

### Acceptance criteria

- WebSocket connect/disconnect/reconnect changes status.
- Receiving a refresh/revision message updates latest-known revision.
- Completing PDF reload updates visible revision.
- Paused refresh with a newer revision shows pending-update status.
- Status UI does not cover meaningful PDF content.

## Feature 2: Pause visual auto-refresh

### User behavior

Users can pause automatic visual reloads while reading. The Viewer Host Server may continue detecting PDF changes and broadcasting refresh/revision messages, but the Viewer Client should not reload the visible PDF until the user resumes or manually refreshes.

This is not continuous compilation. It only controls Viewer Client reload behavior after the Host Server reports changed PDF bytes.

### Requirements

- Add a Viewer Client pause/resume control.
- When not paused, refresh messages reload the PDF normally.
- When paused:
  - do not reload the visible PDF immediately;
  - remember the latest pending revision;
  - show pending-update status.
- When resumed:
  - refresh once to the latest pending revision;
  - clear pending status.
- Optional: add “refresh now” while staying paused.

### Acceptance criteria

- With pause off, Host refresh messages reload the PDF.
- With pause on, Host refresh messages do not reload immediately.
- Multiple paused revisions collapse to the latest pending revision.
- Resuming refreshes once to the latest pending revision.

## Feature 3: Refresh polish and state preservation

### User behavior

When the PDF reloads after a change, the Viewer Client should remain visually stable and preserve the reader's context.

### Requirements

- Preserve page, zoom, scroll, and trim across refresh.
- Avoid jumping to page 1 on normal refresh.
- Cache-bust PDF fetches using the Host-provided revision.
- Avoid excessive flicker where practical.
- Optional: use a lightweight visible-page mask/fade similar to LaTeX-Workshop if basic refresh remains visibly jarring.
- Do not block correctness on animation polish.

### Acceptance criteria

- Refreshing an updated PDF keeps the user near the previous visible location.
- Zoom and trim values remain unchanged after refresh.
- Refresh fetches the intended revision.
- If a loading mask/fade is implemented, it is removed after rendering completes and does not trap pointer/keyboard/touch interactions.

## Feature 4: Jump history/back navigation

### User behavior

When the agent performs a forward SyncTeX jump, the Viewer Client remembers the user's previous reading position. The user can return to that position.

### Requirements

- Before handling a forward SyncTeX display message, record current page/scroll position.
- Provide simple back navigation, such as Backspace, mouse back button, or a small viewer-local control.
- Keep history bounded.
- Avoid noisy duplicate positions.
- Keep history independent of PDF refresh as much as practical.

### Acceptance criteria

- After `jump_pdf`, back navigation returns near the pre-jump reading position.
- Repeated jumps create a bounded stack of prior locations.
- Duplicate/no-op jumps do not spam history.

## Feature 5: Trim-margin UI

### User behavior

Users can reduce visible PDF margins by setting a trim percentage. This is useful for LaTeX PDFs with large margins and for snippet-like PDFs.

### Requirements

- Add a small Viewer Client UI control for trim percentage.
- Trim value range: 0–99 percent.
- Default trim value: 0.
- Apply trimming using browser-side CSS/layout logic, adapted from `../LaTeX-Workshop` only as far as needed.
- Preserve trim across refresh and tab re-render.
- Prefer preserving trim across app restart/browser profile when simple and safe.
- Trimming must not break forward/reverse SyncTeX coordinate conversion.
- Trimming must not hide the SyncTeX visual indicator.

### Acceptance criteria

- Changing trim percentage visibly reduces page margins.
- Refresh keeps the same trim percentage.
- Forward SyncTeX still lands near the expected location with trim enabled.
- Reverse SyncTeX clicks/taps still produce plausible source locations with trim enabled.

## Feature 6: PDF outline/navigation

### User behavior

When a PDF contains bookmarks/outline metadata, users should be able to navigate those entries from the Viewer Client.

### Requirements

- This is a post-Desktop-Host-v1 feature, not part of Desktop Viewer Host v1.
- Prefer using PDF.js document outline APIs from the custom Viewer Client.
- Do not require porting the full stock PDF.js viewer shell or toolbar.
- Do not parse LaTeX source to synthesize sections in this follow-up.
- Custom CSS must not make future outline/navigation controls impossible.
- Optional later behavior: remember whether the outline panel was open and selected.

### Acceptance criteria

- A fixture/manual PDF with bookmarks displays an outline tree or equivalent navigation UI.
- Users can select outline entries and navigate within the PDF.
- The implementation does not pull in unrelated LaTeX-Workshop or stock PDF.js toolbar behavior.

## Protocol impact

No new MCP tools are expected.

Viewer Client-only features should stay local. If a feature needs protocol support, prefer adding explicit typed Host/Client messages rather than MCP tool changes.

Representative Host → Viewer Client messages remain in the Desktop Viewer Host protocol family:

```json
{ "type": "pdf_refresh", "pdf_id": 123, "revision": 4 }
{ "type": "viewer_reload", "pdf_id": 123 }
{ "type": "synctex_forward", "pdf_id": 123, "page": 2, "x": 100, "y": 500, "indicator": true }
```

Representative Viewer Client → Host messages remain viewer/host events:

```json
{ "type": "reverse_synctex", "pdf_id": 123, "page": 2, "x": 100, "y": 500 }
{ "type": "viewer_loaded", "pdf_id": 123, "revision": 4 }
{ "type": "viewer_tab_closed", "pdf_id": 123 }
```

Pause refresh affects only how the Viewer Client handles Host refresh messages. The Host Server should continue file-change detection and revision broadcasts.

## Existing implementation references

Reference repo root: `../LaTeX-Workshop`.

Use LaTeX-Workshop as a behavioral reference, not as a mandate to port its full UI:

- Trim CSS/state/UI logic: `viewer/components/trimming.ts`, `viewer/components/gui.ts`, `viewer/latexworkshop.css`.
- Jump/back scroll history: `viewer/components/viewerhistory.ts`, `viewer/components/gui.ts`, `viewer/components/synctex.ts`.
- State-preserving refresh and optional masks/fade: `viewer/components/refresh.ts`, `viewer/components/state.ts`.
- Viewer connection/reconnect hooks: `viewer/components/connection.ts`.
- Forward/reverse SyncTeX indicator and scroll behavior: `viewer/components/synctex.ts`, `viewer/latexworkshop.css`.
- PDF outline behavior to inspect selectively: `viewer/viewer.html`, `viewer/viewer.css`, `viewer/components/state.ts`, `viewer/components/gui.ts`.

Avoid VS Code embedded-webview behavior, broad toolbar rewrites, localization tables, and extension-specific command bridges unless a later PRD explicitly requires them.

## Testing and verification

Automated tests should cover:

- Viewer Client modules do not import Tauri, Node filesystem APIs, or MCP internals.
- status model/UI updates on Host connection lifecycle and revision messages;
- pause refresh queues latest pending revision and refreshes once on resume;
- refresh preserves page/zoom/scroll/trim;
- `synctex_forward` pushes prior scroll position into history;
- back navigation restores previous scroll position;
- trim control validates range and updates CSS/layout;
- trim persists across refresh;
- forward/reverse SyncTeX remain functional with trim enabled;
- outline/navigation works for a PDF with bookmarks once that feature is selected.

Manual smoke should include:

1. Open the Desktop Viewer Host app and verify the Viewer Client loads from the Host Server.
2. Open a PDF and observe Host connection/revision status.
3. Pause refresh, change/recompile the PDF, verify pending update status, then resume.
4. Refresh a changed PDF and verify page/zoom/scroll/trim are preserved.
5. Run `jump_pdf`, then use back navigation to return.
6. Change trim percentage and verify margins shrink/grow without breaking SyncTeX.
7. For the outline follow-up, open a PDF with bookmarks and verify outline navigation.

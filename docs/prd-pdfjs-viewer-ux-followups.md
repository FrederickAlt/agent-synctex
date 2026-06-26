# PRD: PDF.js Viewer UX Follow-ups

## Status

Follow-up scope after `docs/prd-stdio-mcp-pdfjs-viewer.md` v1.

## Summary

After the stdio MCP + browser-hosted PDF.js viewer v1 is working, improve the viewer experience with a focused set of browser-side UX features:

- keep the stock PDF.js outline/sidebar available for section/bookmark navigation;
- add trim-margin UI for LaTeX PDFs;
- add jump history/back navigation after SyncTeX jumps;
- add connection/revision/refresh status in the viewer;
- add a pause auto-refresh toggle for file-change-driven `pdf_refresh` events;
- polish PDF refresh so it feels stable and minimally jarring.

These follow-ups should not change the core v1 architecture. The MCP stdio process remains the runtime authority, PDF.js still runs in a browser tab/window, and viewer communication remains HTTP/WebSocket based.

## Goals

- Improve human usability of the browser viewer without reintroducing Zathura, daemon, systemd, Pi inline rendering, or continuous compilation.
- Preserve and expose the stock PDF.js outline/sidebar so papers with PDF bookmarks show section navigation.
- Support margin trimming in the viewer, adapted from LaTeX-Workshop only as far as needed.
- Let users return to their previous reading position after agent-driven SyncTeX jumps.
- Make viewer connectivity and PDF freshness visible to the user.
- Let users pause automatic PDF refreshes while reading.
- Keep each feature independently implementable after v1.

## Non-goals

- No custom `.tex` section parser for the sidebar.
- No new MCP tools unless later implementation proves one is necessary.
- No persistent background daemon.
- No browser window lifecycle guarantees.
- No VS Code iframe/postMessage bridge.
- No broad LaTeX-Workshop toolbar port.
- No full localization effort for custom controls in this follow-up.

## Feature 1: Stock PDF.js outline/sidebar

### User behavior

When a PDF contains an outline/bookmarks tree, the viewer should make PDF.js's built-in outline/sidebar available so users can navigate sections of papers and books.

This is the same general sidebar users see in PDF viewers for papers with sections such as Abstract, Introduction, Methods, Results, and References.

### Requirements

- Do not hide or disable the stock PDF.js sidebar/outline controls.
- The outline view should work for PDFs that contain bookmark/outline metadata, commonly produced by LaTeX `hyperref`.
- Do not parse LaTeX source to synthesize sections in this follow-up.
- If custom CSS or toolbar simplification is applied, it must not remove the outline/sidebar affordance.
- Optional later behavior: remember whether the sidebar was open and which sidebar tab was selected.

### Acceptance criteria

- A fixture or manual PDF with bookmarks displays the stock PDF.js outline tree.
- Viewer custom CSS does not hide the outline button/menu.
- Users can select outline entries and navigate within the PDF.

## Feature 2: Trim-margin UI

### User behavior

Users can reduce visible PDF margins by entering/selecting a trim percentage in the viewer. This is useful for LaTeX PDFs with large margins and for snippet-like PDFs.

### Requirements

- Add a small viewer UI control for trim percentage.
- Trim value range: 0-99 percent.
- Default trim value: 0.
- Apply trimming using browser-side CSS/layout logic, adapted from LaTeX-Workshop's trimming component where practical.
- Preserve trim value across `pdf_refresh`.
- Prefer preserving trim value across `viewer_reload` within the same browser profile, using local storage if simple and safe.
- Trimming must not break forward/reverse SyncTeX coordinate conversion.
- Trimming must not hide the SyncTeX visual indicator.

### Acceptance criteria

- Changing trim percentage visibly reduces page margins.
- `pdf_refresh` keeps the same trim percentage.
- Forward `jump_pdf` still lands at the expected location with trim enabled.
- Reverse SyncTeX clicks still produce plausible source locations with trim enabled.

## Feature 3: Jump history/back navigation

### User behavior

When the agent performs a forward SyncTeX jump, the viewer remembers the user's previous reading position. The user can go back to that position.

### Requirements

- Before handling a `synctex` forward-jump message, record current scroll/page position.
- Provide a simple way to navigate back, such as:
  - Backspace;
  - browser mouse back button;
  - optional small toolbar/status button.
- History should be bounded to avoid unbounded memory growth.
- History should not record noisy duplicate positions.
- History should work independently of PDF.js document refresh.

### Acceptance criteria

- After `jump_pdf`, invoking back returns near the pre-jump reading position.
- Repeated jumps create a bounded stack of prior locations.
- Duplicate/no-op jumps do not spam history.

## Feature 4: Connection, revision, and refresh status

### User behavior

The viewer shows a small unobtrusive status indicator so users know whether the viewer is connected to the MCP runtime and whether the visible PDF is current.

### Requirements

Status should display or otherwise communicate:

- connected / reconnecting / disconnected;
- current `pdf_id`;
- current PDF `revision` when known;
- last refresh time or latest refresh event;
- whether an update is pending because auto-refresh is paused.

The status UI should be lightweight and not require a full toolbar rewrite.

### Acceptance criteria

- WebSocket connect/disconnect/reconnect changes status.
- Receiving `pdf_refresh` with a new revision updates the displayed revision after refresh.
- When refresh is paused and a new revision arrives, status indicates an update is pending.

## Feature 5: Pause auto-refresh toggle

### User behavior

Users can pause automatic viewer refreshes while reading. The MCP runtime may continue detecting PDF changes and sending `pdf_refresh`, but the viewer should not reload the PDF until the user resumes or manually refreshes.

This is not continuous compilation. It only controls viewer reload behavior after the server reports changed PDF bytes.

### Requirements

- Add a viewer-side pause/resume control.
- When not paused, `pdf_refresh` behaves normally.
- When paused:
  - do not reload the PDF immediately;
  - remember the latest pending revision;
  - show status that an update is pending.
- When resumed:
  - refresh once to the latest pending revision;
  - clear pending status.
- Optional: add a “refresh now” action while staying paused.

### Acceptance criteria

- With pause off, server `pdf_refresh` reloads the PDF.
- With pause on, server `pdf_refresh` does not reload immediately.
- With pause on, receiving multiple revisions collapses to the latest pending revision.
- Resuming refreshes once to the latest pending revision.

## Feature 6: Refresh polish

### User behavior

When the PDF reloads after a change, the viewer should remain visually stable and preserve the reader's context.

### Requirements

- Preserve page, zoom, scroll, and trim across `pdf_refresh`.
- Avoid jumping to page 1 on normal refresh.
- Avoid excessive flicker where practical.
- Optional: use a lightweight visible-page mask/fade similar to LaTeX-Workshop if it remains simple.
- Do not block correctness on animation polish.

### Acceptance criteria

- Refreshing an updated PDF keeps the user near the previous visible location.
- Zoom and trim values remain unchanged after refresh.
- If a loading mask/fade is implemented, it is removed after rendering completes and does not trap pointer/keyboard interactions.

## Protocol impact

No new MCP tools are expected.

The existing viewer protocol from v1 is sufficient:

```json
{ "type": "pdf_refresh", "revision": 4 }
{ "type": "viewer_reload" }
{ "type": "synctex", "data": { "page": 2, "x": 100, "y": 500, "indicator": true } }
```

Viewer-side pause auto-refresh affects only how the browser handles `pdf_refresh` messages. The server should continue sending refresh messages when tracked PDF revisions change.

## Existing implementation locations

Reference repo root: `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop`.

- Stock PDF.js outline/sidebar shell: `viewer/viewer.html`, `viewer/viewer.css`.
- Sidebar/open-state handling to inspect selectively: `viewer/components/state.ts`, `viewer/components/gui.ts`.
- Trim CSS/state/UI logic: `viewer/components/trimming.ts`, `viewer/components/gui.ts`, `viewer/latexworkshop.css`.
- Jump/back scroll history: `viewer/components/viewerhistory.ts`, `viewer/components/gui.ts`, `viewer/components/synctex.ts`.
- State-preserving refresh and optional masks/fade: `viewer/components/refresh.ts`, `viewer/components/state.ts`.
- Viewer connection/reconnect/ping hooks: `viewer/components/connection.ts`.
- Forward/reverse SyncTeX indicator and scroll behavior: `viewer/components/synctex.ts`, `viewer/latexworkshop.css`.
- Viewer initialization root: `viewer/latexworkshop.ts`.

Avoid pulling in VS Code embedded-webview behavior, broad toolbar rewrites, or localization tables unless required by the selected UX controls.

## Testing and verification

Automated tests should cover:

- outline/sidebar controls are not hidden by custom viewer CSS;
- trim control validates range and updates CSS;
- trim persists across `pdf_refresh`;
- forward/reverse SyncTeX remain functional with trim enabled;
- `synctex` jumps push prior scroll position into history;
- back navigation restores previous scroll position;
- connection status updates on WebSocket lifecycle events;
- revision status updates on `pdf_refresh`;
- pause auto-refresh queues latest pending revision and refreshes once on resume;
- refresh preserves page/zoom/scroll/trim.

Manual smoke should include:

1. Open a PDF with bookmarks and verify section outline navigation.
2. Change trim percentage and verify margins shrink/grow.
3. Run `jump_pdf`, then use back navigation to return.
4. Disconnect/restart MCP runtime and observe status changes.
5. Pause refresh, change/recompile PDF, verify pending update status, then resume.
6. Refresh a changed PDF and verify page/zoom/scroll/trim are preserved.

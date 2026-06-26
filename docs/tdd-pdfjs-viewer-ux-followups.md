# TDD Plan: PDF.js Viewer UX Follow-ups

## Purpose

This document defines the test-first sequence for `docs/prd-pdfjs-viewer-ux-followups.md`.

These tests should be implemented after the core stdio MCP + browser PDF.js viewer v1 is functional. The follow-ups are intentionally viewer-focused and should not change the core MCP runtime architecture.

## Test strategy

Use a mix of:

- browser-viewer TypeScript unit tests where practical;
- DOM tests using a lightweight DOM test harness if available;
- protocol-level tests with fake PDF.js viewer objects;
- integration-style viewer WebSocket tests using fake clients;
- manual browser smoke tests for PDF.js UI behavior that is hard to prove headlessly.

If the repository does not yet have a browser DOM harness, prefer extracting small pure functions for state/history/status behavior and keep direct DOM assertions narrow.

## Core success criteria

- PDF.js stock outline/sidebar remains available.
- Trim-margin UI works and persists through `pdf_refresh`.
- Forward/reverse SyncTeX still work with trim enabled.
- SyncTeX jumps record prior position and back navigation restores it.
- Viewer status reflects WebSocket connection and PDF revision.
- Pause auto-refresh queues latest pending revision and refreshes once on resume.
- PDF refresh preserves page/zoom/scroll/trim.

## Existing implementation references

Reference repo root: `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop`.

- Phase 1 outline/sidebar: `viewer/viewer.html`, `viewer/viewer.css`, `viewer/components/state.ts`, `viewer/components/gui.ts`.
- Phase 2-4 trim and SyncTeX-with-trim: `viewer/components/trimming.ts`, `viewer/components/synctex.ts`, `viewer/components/interface.ts`, `viewer/latexworkshop.css`.
- Phase 5-6 jump history: `viewer/components/viewerhistory.ts`, `viewer/components/gui.ts`, `viewer/components/synctex.ts`.
- Phase 7-8 status UI connection signals: `viewer/components/connection.ts`, `viewer/latexworkshop.ts`, `viewer/latexworkshop.css`.
- Phase 9-11 pause/refresh preservation: `viewer/components/refresh.ts`, `viewer/components/state.ts`, `viewer/components/connection.ts`.
- Phase 12 optional refresh mask/fade: `viewer/components/refresh.ts`, `viewer/latexworkshop.css`.

## Phase 1: outline/sidebar preservation

### Red

Add viewer static/DOM tests, e.g. `test/viewer/outline_sidebar.test.ts`:

- the viewer HTML contains the stock PDF.js outline/sidebar elements or does not remove them from the PDF.js viewer shell;
- custom viewer CSS does not hide the outline/sidebar controls needed for section navigation;
- viewer initialization does not force-disable PDF.js outline view.

If using a real PDF.js fixture in manual/automated browser smoke:

- open a PDF with bookmarks;
- assert/verify that outline entries are visible and clickable.

### Green

Keep or restore the stock PDF.js sidebar/outline controls while applying only minimal custom UI changes.

### Refactor

Avoid custom `.tex` section parsing. Treat PDF outlines as PDF.js-owned functionality.

## Phase 2: trim state model

### Red

Add pure unit tests for a trim model, e.g. `test/viewer/trim_state.test.ts`:

- default trim is 0;
- valid values 0-99 are accepted;
- negative values clamp/reject according to chosen behavior;
- values above 99 clamp/reject according to chosen behavior;
- trim state can be serialized/restored;
- trim state survives a simulated `pdf_refresh` state snapshot.

### Green

Implement a small trim state module independent from PDF.js DOM internals.

### Refactor

Keep trim validation separate from UI controls and CSS application.

## Phase 3: trim UI and CSS application

### Red

Add DOM/PDF.js-fake tests, e.g. `test/viewer/trim_ui.test.ts`:

- trim input/control renders in the viewer UI;
- changing trim updates viewer state;
- changing trim applies expected CSS custom property or generated CSS rules;
- trim CSS is re-applied after PDF pages initialize/re-render;
- SyncTeX indicator remains visible above trimmed pages.

### Green

Adapt minimal logic from LaTeX-Workshop `trimming.ts` and only the UI wiring needed for the trim control.

### Refactor

Do not import full LaTeX-Workshop toolbar patching just to host the trim control. Keep the control placement simple.

## Phase 4: SyncTeX with trim enabled

### Red

Add protocol/viewer tests with fake PDF.js page geometry, e.g. `test/viewer/synctex_with_trim.test.ts`:

- forward `synctex` scroll/highlight still computes the expected viewport position when trim is nonzero;
- reverse SyncTeX click sends PDF coordinates, not trimmed CSS coordinates;
- enabling/disabling trim does not change the server-facing reverse SyncTeX payload shape.

### Green

Adjust viewer coordinate handling only if needed. Prefer keeping PDF.js `getPagePoint`/viewport APIs as the source of truth.

### Refactor

Document any PDF.js internal assumptions used for trim + SyncTeX interaction.

## Phase 5: jump history model

### Red

Add pure unit tests, e.g. `test/viewer/jump_history.test.ts`:

- empty history back is a no-op;
- recording a position pushes it onto the stack;
- duplicate/noisy positions are ignored or coalesced;
- history is bounded to a fixed maximum;
- back returns the most recent prior position;
- forward is optional, but if implemented, it behaves predictably.

### Green

Implement a small scroll/page history model.

### Refactor

Keep history independent of keyboard/mouse event binding.

## Phase 6: jump history viewer integration

### Red

Add viewer integration tests with fake container/PDF.js state:

- before handling a `synctex` message, current position is recorded;
- invoking the configured back action restores the prior scroll position;
- repeated `synctex` messages create bounded history;
- normal scrolling does not spam history unless explicitly chosen.

### Green

Wire history recording into forward SyncTeX handling and bind simple back controls such as Backspace/mouse-back.

### Refactor

Avoid custom toolbar buttons unless keyboard/mouse navigation is insufficient in manual smoke.

## Phase 7: connection/revision status model

### Red

Add unit tests, e.g. `test/viewer/viewer_status.test.ts`:

- initial state is disconnected/connecting as chosen;
- WebSocket open sets connected;
- reconnect attempt sets reconnecting;
- WebSocket close/error sets disconnected or reconnecting;
- receiving `pdf_refresh` with revision updates latest known revision;
- completing refresh updates visible/current revision;
- paused refresh with newer revision sets pending update state.

### Green

Implement a status state model and small renderer adapter.

### Refactor

Keep status rendering independent from the WebSocket implementation.

## Phase 8: status UI integration

### Red

Add DOM tests, e.g. `test/viewer/status_ui.test.ts`:

- status element renders without covering PDF content significantly;
- status text/class changes on connect/reconnect/disconnect;
- status shows current `pdf_id` and revision when available;
- status indicates pending update when refresh is paused.

### Green

Add minimal CSS/DOM for status display.

### Refactor

Do not bring in broad custom localization or full toolbar patching.

## Phase 9: pause auto-refresh model

### Red

Add pure unit tests, e.g. `test/viewer/refresh_pause.test.ts`:

- default state is not paused;
- when not paused, `pdf_refresh(revision)` requests immediate refresh;
- when paused, `pdf_refresh(revision)` does not request immediate refresh;
- paused mode stores the latest pending revision;
- multiple paused refreshes collapse to the highest/latest revision;
- resume returns exactly one refresh request for the latest pending revision;
- resume with no pending revision performs no refresh.

### Green

Implement pause/queue/resume logic independent from PDF.js refresh.

### Refactor

Keep this as viewer-side behavior; do not add MCP tools.

## Phase 10: pause auto-refresh UI integration

### Red

Add DOM/protocol integration tests:

- pause control toggles paused state;
- while paused, incoming `pdf_refresh` does not call the PDF.js refresh function;
- while paused, status indicates update pending;
- resume calls refresh once with latest pending revision;
- optional refresh-now action refreshes while remaining paused, if implemented.

### Green

Wire pause control into WebSocket message handling and status UI.

### Refactor

Ensure pause state is local to the viewer and does not suppress server-side polling or registry revision updates.

## Phase 11: refresh state preservation

### Red

Add tests around refresh snapshots, e.g. `test/viewer/pdf_refresh_state.test.ts`:

- captures page before refresh;
- captures zoom/current scale before refresh;
- captures scroll top/left before refresh;
- captures trim before refresh;
- restores captured state after PDF document reload;
- cache-busts PDF fetch with supplied revision;
- does not call full `location.reload()` for `pdf_refresh`.

### Green

Implement/extend state-preserving refresh.

### Refactor

Separate `pdf_refresh` from `viewer_reload` clearly in code and tests.

## Phase 12: optional refresh mask/fade polish

Only implement this if basic refresh remains visibly jarring in manual smoke.

### Red

Add DOM tests if implemented:

- visible page masks are added before refresh;
- masks are removed after pages render;
- masks do not remain after refresh failure/timeouts;
- masks do not block interactions after removal.

### Green

Adapt the smallest possible version of LaTeX-Workshop's page-loading mask behavior.

### Refactor

Keep animation polish optional and removable.

## Phase 13: combined viewer UX integration

### Red

Add an integration-style test with fake PDF.js state and WebSocket messages:

1. Viewer starts and status shows connecting/connected.
2. Trim is set to a nonzero value.
3. A `synctex` message records prior position and scrolls to target.
4. Back navigation restores prior position.
5. Pause refresh.
6. Receive multiple `pdf_refresh` messages with increasing revisions.
7. Assert no PDF reload while paused and pending revision is latest.
8. Resume and assert one refresh to latest revision.
9. Assert trim/page/zoom/scroll preservation after refresh.

### Green

Finish wiring feature interactions.

### Refactor

Remove duplicated state storage. The viewer should have one coherent state model for refresh, trim, status, and history where practical.

## Manual smoke checklist

After automated tests pass:

1. Open a PDF with bookmarks; verify PDF.js outline/sidebar section navigation.
2. Open a LaTeX PDF with large margins; adjust trim and verify readability improves.
3. Run `jump_pdf`; verify indicator appears and back navigation returns to prior location.
4. Trigger PDF update while not paused; verify `pdf_refresh` updates in place and preserves state.
5. Pause refresh, trigger multiple PDF updates, verify pending update status and one refresh on resume.
6. Kill/restart the MCP runtime; verify viewer status changes appropriately.
7. Confirm no Zathura/daemon/inline/continuous behavior is reintroduced.

## Verification commands

After implementation slices:

```bash
npm run check
npm test
```

Before merging follow-up UX work:

```bash
npm run verify
```

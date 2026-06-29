# TDD Plan: Viewer Client UX Follow-ups

## Purpose

This document defines the test-first sequence for `docs/prd-viewer-client-ux-followups.md`.

These tests should be implemented after `docs/prd-desktop-viewer-host-v1.md` is functional. The follow-ups are intentionally Viewer-Client-focused and must preserve the Desktop Viewer Host split between MCP process, Viewer Host Server, Viewer Client, and thin desktop wrapper.

## Test strategy

Use a mix of:

- pure TypeScript unit tests for state models;
- DOM tests for Viewer Client UI controls;
- protocol-level tests with fake Host/Client messages;
- browser tests for PDF.js behavior where practical;
- manual desktop smoke tests for Tauri/Host/Client integration.

If the repository does not yet have a browser DOM harness, extract small pure functions for state/history/status behavior and keep direct DOM assertions narrow.

## Core success criteria

- Viewer Client code remains portable web code: no Tauri-only APIs, Node filesystem APIs, or direct MCP imports.
- Desktop wrapper remains thin: UX behavior is not implemented in Tauri command handlers.
- Viewer Host Server remains responsible for serving, registered PDFs, revisions, sockets, and file-change notifications.
- Status reflects Viewer Client ↔ Viewer Host Server state and PDF revision state.
- Pause refresh queues latest pending revision and refreshes once on resume.
- Refresh preserves page/zoom/scroll/trim.
- SyncTeX jumps record prior position and back navigation restores it.
- Trim-margin UI works and does not break forward/reverse SyncTeX.
- PDF outline/navigation can be added later without porting the full stock PDF.js shell.

## Existing implementation references

Reference repo root: `../LaTeX-Workshop`.

Use LaTeX-Workshop as a reference for behavior and algorithms, not as a broad UI port:

- Trim and SyncTeX with trim: `viewer/components/trimming.ts`, `viewer/components/synctex.ts`, `viewer/components/interface.ts`, `viewer/latexworkshop.css`.
- Jump history: `viewer/components/viewerhistory.ts`, `viewer/components/gui.ts`, `viewer/components/synctex.ts`.
- Status/connection signals: `viewer/components/connection.ts`, `viewer/latexworkshop.ts`, `viewer/latexworkshop.css`.
- Refresh preservation and optional masks: `viewer/components/refresh.ts`, `viewer/components/state.ts`, `viewer/components/connection.ts`.
- PDF outline behavior to inspect selectively: `viewer/viewer.html`, `viewer/viewer.css`, `viewer/components/state.ts`, `viewer/components/gui.ts`.

Avoid VS Code embedded-webview behavior, broad toolbar rewrites, localization tables, and extension command bridges unless a later PRD explicitly requires them.

## Phase 0: architecture guardrails

### Red

Add tests or static guardrails, for example `test/viewer_client_architecture.test.ts`:

- Viewer Client modules do not import Tauri APIs.
- Viewer Client modules do not import Node filesystem/path/process APIs.
- Viewer Client modules do not import MCP tool handlers or MCP runtime internals.
- Tauri command handlers do not implement PDF rendering, trim, history, pause, or status business logic.
- Host/Client protocol types are plain serializable JSON types with no framework-specific objects.

### Green

Introduce or adjust module boundaries so Viewer Client state and UI are normal browser code served by the Viewer Host Server.

### Refactor

Keep any guardrail allowlist explicit and small. If a test needs too many exceptions, the architecture boundary is probably wrong.

## Phase 1: status model

### Red

Add pure unit tests, e.g. `test/viewer/status_model.test.ts`:

- initial state is connecting or disconnected according to the chosen startup behavior;
- Host WebSocket open sets connected;
- reconnect attempt sets reconnecting;
- Host WebSocket close/error sets disconnected or reconnecting;
- receiving a refresh/revision message updates latest known revision;
- completing refresh updates visible/current revision;
- paused refresh with newer revision sets pending update state;
- status does not claim MCP connectivity unless such state is explicitly supplied by the Host protocol.

### Green

Implement a small status state model independent from DOM and WebSocket classes.

### Refactor

Keep labels precise: “Host connected” is preferable to “MCP connected” unless the Host actually reports MCP state.

## Phase 2: status UI integration

### Red

Add DOM tests, e.g. `test/viewer/status_ui.test.ts`:

- status element renders without covering PDF content significantly;
- status text/class changes on connect/reconnect/disconnect;
- status shows current `pdf_id` and revision when available;
- status indicates pending update when refresh is paused;
- status remains usable in a normal browser DOM without Tauri globals.

### Green

Add minimal CSS/DOM for status display.

### Refactor

Do not bring in broad custom localization or full toolbar patching.

## Phase 3: pause refresh model

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

Implement pause/queue/resume logic independent from PDF.js refresh and WebSocket handling.

### Refactor

Keep this as Viewer Client behavior. Do not add MCP tools.

## Phase 4: pause refresh UI/protocol integration

### Red

Add DOM/protocol integration tests:

- pause control toggles paused state;
- while paused, incoming Host `pdf_refresh` does not call the PDF.js reload function;
- while paused, status indicates update pending;
- resume calls reload once with latest pending revision;
- optional refresh-now action reloads while remaining paused, if implemented;
- the Host Server still receives no pause command unless a later protocol decision explicitly adds one.

### Green

Wire pause control into Viewer Client Host-message handling and status UI.

### Refactor

Ensure pause state is local to the Viewer Client and does not suppress Host-side file watching or revision updates.

## Phase 5: refresh state preservation

### Red

Add tests around refresh snapshots, e.g. `test/viewer/pdf_refresh_state.test.ts`:

- captures page before refresh;
- captures zoom/current scale before refresh;
- captures scroll top/left before refresh;
- captures trim before refresh;
- reloads PDF bytes with the supplied Host revision;
- restores captured state after PDF document reload;
- does not call full `location.reload()` for normal `pdf_refresh`.

### Green

Implement or extend state-preserving refresh in the Viewer Client.

### Refactor

Separate Host `pdf_refresh` from full `viewer_reload` clearly in code and tests.

## Phase 6: optional refresh mask/fade polish

Only implement this if basic refresh remains visibly jarring in manual smoke.

### Red

Add DOM tests if implemented:

- visible page masks are added before refresh;
- masks are removed after pages render;
- masks do not remain after refresh failure/timeouts;
- masks do not block mouse/keyboard/touch interactions after removal.

### Green

Adapt the smallest possible version of LaTeX-Workshop's page-loading mask behavior.

### Refactor

Keep animation polish optional and removable.

## Phase 7: jump history model

### Red

Add pure unit tests, e.g. `test/viewer/jump_history.test.ts`:

- empty history back is a no-op;
- recording a position pushes it onto the stack;
- duplicate/noisy positions are ignored or coalesced;
- history is bounded to a fixed maximum;
- back returns the most recent prior position;
- history entries survive a simulated refresh if the underlying document still has compatible pages.

### Green

Implement a small page/scroll history model.

### Refactor

Keep history independent of keyboard/mouse/touch event binding.

## Phase 8: jump history viewer integration

### Red

Add Viewer Client integration tests with fake container/PDF.js state:

- before handling a Host `synctex_forward` message, current position is recorded;
- invoking the configured back action restores the prior scroll position;
- repeated `synctex_forward` messages create bounded history;
- normal scrolling does not spam history unless explicitly chosen;
- behavior works without Tauri globals.

### Green

Wire history recording into forward SyncTeX handling and bind simple back controls such as Backspace, mouse-back, or a small viewer-local button.

### Refactor

Avoid custom toolbar complexity unless keyboard/mouse navigation is insufficient in manual smoke.

## Phase 9: trim state model

### Red

Add pure unit tests, e.g. `test/viewer/trim_state.test.ts`:

- default trim is 0;
- valid values 0–99 are accepted;
- negative values clamp/reject according to the chosen behavior;
- values above 99 clamp/reject according to the chosen behavior;
- trim state can be serialized/restored;
- trim state survives a simulated refresh state snapshot.

### Green

Implement a small trim state module independent from PDF.js DOM internals.

### Refactor

Keep trim validation separate from UI controls and CSS application.

## Phase 10: trim UI and CSS application

### Red

Add DOM/PDF.js-fake tests, e.g. `test/viewer/trim_ui.test.ts`:

- trim input/control renders in the Viewer Client UI;
- changing trim updates viewer state;
- changing trim applies expected CSS custom property or generated CSS rules;
- trim CSS is re-applied after PDF pages initialize/re-render;
- SyncTeX indicator remains visible above trimmed pages;
- UI works in a normal browser DOM without Tauri APIs.

### Green

Adapt minimal logic from LaTeX-Workshop `trimming.ts` and only the UI wiring needed for the trim control.

### Refactor

Do not import full LaTeX-Workshop toolbar patching just to host the trim control.

## Phase 11: SyncTeX with trim enabled

### Red

Add protocol/viewer tests with fake PDF.js page geometry, e.g. `test/viewer/synctex_with_trim.test.ts`:

- forward `synctex_forward` scroll/highlight still computes the expected viewport position when trim is nonzero;
- reverse SyncTeX click sends PDF coordinates, not trimmed CSS coordinates;
- touch/pointer events and mouse events produce equivalent reverse-coordinate payloads where practical;
- enabling/disabling trim does not change the Host-facing reverse SyncTeX payload shape.

### Green

Adjust Viewer Client coordinate handling only if needed. Prefer PDF.js `getPagePoint`/viewport APIs as the source of truth.

### Refactor

Document any PDF.js internal assumptions used for trim + SyncTeX interaction.

## Phase 12: PDF outline/navigation

This is a post-Desktop-Host-v1 UX feature and can be implemented after the core status/refresh/history/trim work.

### Red

Add viewer static/DOM/browser tests, e.g. `test/viewer/outline_navigation.test.ts`:

- a PDF.js document outline fixture can be read by the Viewer Client;
- outline entries render in a minimal Viewer Client panel or equivalent navigation UI;
- selecting an outline entry navigates to the expected destination;
- custom viewer CSS does not make the outline UI unusable;
- implementation does not require the full stock PDF.js viewer shell.

If using manual/automated browser smoke:

- open a PDF with bookmarks;
- verify that outline entries are visible and clickable.

### Green

Use PDF.js outline/destination APIs or a minimal subset of the stock PDF.js behavior needed for bookmark navigation.

### Refactor

Avoid custom `.tex` section parsing. Treat PDF outlines as PDF-owned metadata.

## Phase 13: combined Viewer Client integration

### Red

Add an integration-style test with fake PDF.js state and fake Host messages:

1. Viewer Client starts and status shows connecting/connected.
2. A PDF tab is opened for a `pdf_id`.
3. Trim is set to a nonzero value.
4. A `synctex_forward` message records prior position and scrolls to target.
5. Back navigation restores prior position.
6. Pause refresh.
7. Receive multiple `pdf_refresh` messages with increasing revisions.
8. Assert no PDF reload while paused and pending revision is latest.
9. Resume and assert one refresh to latest revision.
10. Assert trim/page/zoom/scroll preservation after refresh.
11. Assert no Tauri or MCP imports are required for the tested Viewer Client behavior.

### Green

Finish wiring feature interactions.

### Refactor

Remove duplicated state storage. The Viewer Client should have one coherent state model for refresh, trim, status, and history where practical.

## Manual smoke checklist

After automated tests pass:

1. Start the Desktop Viewer Host app and confirm the Viewer Client is loaded from the Viewer Host Server URL.
2. Open a PDF through MCP and verify a Viewer Client tab opens/focuses.
3. Observe Host connection/revision status.
4. Trigger PDF update while not paused; verify refresh updates in place and preserves page/zoom/scroll/trim.
5. Pause refresh, trigger multiple PDF updates, verify pending update status and one refresh on resume.
6. Run `jump_pdf`; verify indicator appears and back navigation returns to prior location.
7. Adjust trim and verify margins shrink/grow.
8. Confirm forward/reverse SyncTeX still produce plausible locations with trim enabled.
9. For the outline follow-up, open a PDF with bookmarks and verify outline navigation.
10. Confirm no Zathura/legacy broker/inline/continuous behavior is reintroduced.
11. Confirm Viewer Client behavior still works in a normal browser context served by the Host Server, not only inside Tauri.

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

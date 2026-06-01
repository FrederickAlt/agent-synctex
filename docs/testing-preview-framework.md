# Preview Testing Framework

This repo ships a three-way test seam set for extension-side preview rendering and refresh behavior:

- `KittyPlaceholderOracle` — semantic parser/validator for Kitty/tmux placeholder output.
- `createInlinePreviewRenderer(...)` — render-branch and cache diagnostics for inline preview output.
- `createTerminalRefreshPolicy(...)` — focus/tmux-hook/resize invalidation sequencing and registration behavior.

Use these seams when changing preview rendering, terminal refresh behavior, or Kitty placeholder emission.

## 1) KittyPlaceholderOracle

`KittyPlaceholderOracle` is used to validate emitted terminal escape output for semantic correctness.

- Parse output from both plain Kitty DCS and tmux-wrapped DCS payloads.
- Validate setup command lifecycle (including chunked setup, `U=1`, dimensions).
- Validate placeholder cells map back to valid command image ids and in-bounds coordinates.
- Detect missing setup, orphan placeholders, coordinate failures, incomplete chunk chains.

### Common usage pattern

```ts
const oracle = new KittyPlaceholderOracle(output, {
  expectedImageIds: [5200, 5201],
  requireImageSetup: true,
  requirePlaceholders: true,
  includeRawOutput: true,
});

assert.equal(oracle.isValid, true, oracle.summary);
assert.deepEqual(oracle.getCommandImageIds(), [5200, 5201]);
assert.deepEqual(oracle.getPlaceholderImageIds(), [5200, 5201]);
```

Useful diagnostics to check (from `oracle.diagnostics` / `oracle.summary`; use `oracle.commandCount` for the decoded command count):
- `commandImageIds`
- `placeholderImageIds`
- `placements`
- `placeholders`
- `orphanPlaceholders`
- `invalidCoordinatePlaceholders`
- `failures`

### When to use

Use it for tests that need to verify rendered Kitty output without relying on a live Kitty/tmux terminal.

## 2) `createInlinePreviewRenderer(...)`

This seam tests metadata interpretation and branch behavior for inline previews without any real terminal image backends.

Key branches in diagnostics (`render().diagnostics.branch`):
- `no-previews`
- `missing-image-data`
- `images-disabled`
- `tmux-embedded`
- `generic-image`

Key terminal categories (`render().diagnostics.terminalKind`):
- `tmux-kitty`
- `generic-capability`
- `images-unsupported`

### Fake environment helpers used in tests

In tests (`inline_preview_renderer.test.ts`, parts of `index_rendering.test.ts`) inject a mocked environment:

- `readState`
- image policy checks (`canShowImages`, `terminalSupportsImages`)
- `isTmuxKittyTerminal`
- `readImageBase64` (fake map)
- `makeText`, `makeContainer`, `makeInlineImage`, `makeKittyPlaceholderImage`
- `calculateDisplayColumns`, `getCellDimensions`, `getPngDimensions`
- `allocateImageId`
- `rememberInvalidator`

### Cache events (`diagnostics.cacheLog`)

Rendered image components emit cache events with types:
- `cache-hit`
- `cache-miss`
- `cache-width-recalculation`
- `cache-invalidation`

Check these per output width and after `invalidate()` to verify memoization behavior.

### Fallback reason (`diagnostics.fallbackReason`)

Expected reasons are:
- `no-previews`
- `missing-preview-state`
- `images-disabled-by-context`
- `images-disabled-by-terminal`
- `missing-image:<pngPath>`

## 3) `createTerminalRefreshPolicy(...)`

This seam simulates terminal focus/resize/event-driven invalidation without real tmux or signals.

Event types available in `eventLog`:
- `refresh_scheduled` (`delayMs`)
- `input_processed` (`hadFocusIn`, `hadFocusOut`, `consumed`, `remainingLength`)
- `invalidation_registered` (`key`, `context`)
- `invalidation_called` (`count`, `keys`, `contextTypes`)

Important behavior to assert:
- Focus-in input schedules two refresh timers (`refreshDelayMs`, default `[50, 200]`).
- Focus-out input strips markers and preserves surrounding data.
- tmux hooks are installed/removed with process-specific names and include both `pane-focus-in` and `window-layout-changed` hooks.
- `SIGWINCH` and `SIGUSR1` drive invalidation refresh.
- `rememberInvalidator(...)` stores contexts in registry only when running in tmux/kitty mode and context has `invalidate`.

## Full fixture in `index_rendering.test.ts`

The test
`tmux/kitty preview refresh fixture keeps ids and placeholder mappings stable across focus and resize invalidations`
exercises the end-to-end extension-side path for preview rendering + refresh policy.

### Fixture shape

The fixture composes:
1. `FakeAdapter` (`isTmuxKittyTerminal`, `runTmux`, `writeOutput`, `onSignal`).
2. `FakeInvalidationRegistry` (remember/refresh/clear tracking + snapshot).
3. `FakeTerminalInput` (focus-input hook capture).
4. `createTerminalRefreshPolicy({ refreshDelayMs: [10, 20], eventLog })`.
5. `createInlinePreviewRenderer(...)` with fake dependencies:
   - `readState` from `inlinePreviewRenderStateFromDetails`
   - fake image read + dimension maps
   - fake image renderers and container
   - deterministic `allocateImageId`
   - `rememberInvalidator: (ctx) => fixturePolicy.rememberInvalidator(ctx)`

### What it verifies

- Initial render chooses branch `tmux-embedded` with terminal kind `tmux-kitty`.
- Initial `imageIds` are allocated and stable.
- Focus input (`FOCUS_IN_SEQUENCE`) plus resize signal drive exactly three invalidation passes:
  - two from focus timer delays
  - one from signal resize (`SIGWINCH`)
- `invalidation_called` count equals refresh count, and `cache-invalidation` events equal refreshes × image count.
- Re-render after refresh keeps:
  - identical command/placeholder id sets
  - unchanged command count
  - bounded output shape after width changes
- Oracle checks (`KittyPlaceholderOracle`) are applied to every render pass.

## Headless Pi TUI repros

For extension-triggered scroll, resize, or render bugs that need the real Pi TUI render loop, Pi's monorepo has a headless terminal helper:

- `/home/frederick/projects/AI/pi_extensions/pi-mono/packages/tui/test/virtual-terminal.ts`

`VirtualTerminal` wraps `@xterm/headless` and implements Pi's `Terminal` interface, so a throwaway repro can instantiate a real `TUI` without opening an interactive terminal. Useful patterns:

- Subclass `VirtualTerminal` and override `write()` to capture raw ANSI output; this is often more diagnostic than viewport assertions alone.
- Use `terminal.resize(cols, rows)` to exercise maximize / resize-handler behavior.
- Await `terminal.waitForRender()` after `tui.start()`, `tui.requestRender()`, or `resize()`; TUI renders are deferred/throttled.
- Use `getViewport()` for what the user sees, and captured writes or `getScrollBuffer()` to detect history replay.
- To reproduce extension-driven tool rendering bugs, mimic Pi `ToolExecution.invalidate()` behavior: invalidate/rebuild the rendered tool component, then call `tui.requestRender()`.

These Pi-internal imports are best for throwaway/debug repros unless this repo gains an explicit test dependency on Pi internals. Keep committed tests at the extension seams above when possible.

## Host-service testing

The default test suite is intentionally headless. It uses fake host-service backends and protocol files to test service
open/reuse/close/forward-search behavior without launching a real GUI. Use this layer for committed regressions around:

- ambient `MCP_TMPDIR` isolation;
- protocol shape and request/result hardening;
- PDF/source validation and lifecycle behavior;
- backend PID tracking, stale/exited process handling, and close cleanup;
- forward-search command construction and diagnostic propagation.

Real Zathura behavior still needs an opt-in smoke test because D-Bus and SyncTeX behavior cannot be fully represented by fake processes.
From Pi, start the normal host unit with `systemctl --user restart show-latex.service` (or `pdf-preview-servicectl restart` if your local broker targets it), then run:

1. `show_latex` (default inline flow) and confirm an inline artifact is rendered in the Pi result.
2. `show_latex` with `inline=false` and confirm the host service opens a viewer.
3. `compile_latex_file(<repo-local.tex>, {"open_pdf": true})` and confirm a `pdf_id` is returned and opens in the service-controlled viewer.
4. `jump_pdf(pdf_id, line)` and confirm forward-search moves the viewer to the source line.
5. Click a clickable PDF region in the opened viewer and confirm the session receives a pasted block `PDF click: path/to/file.tex:LINE`.
6. `close_pdf(pdf_id)` and confirm service-owned windows close, with unowned/reused handles acknowledged as not closed.

Do not treat direct `zathura ...` commands launched from an agent `bash` tool as equivalent to the host service path: those commands run in the agent sandbox, while the host service runs in the user's desktop session. Use `npm run host-service:status`, `show-latex`-relevant diagnostics under `${XDG_RUNTIME_DIR}/show-latex/*.log`, and tool error logs under the preview temp directory for diagnostics.

A dedicated runtime guardrail test (`viewer_guardrails.test.ts`) enforces that extension production code never directly controls GUI viewers (no direct `zathura`/`evince` spawns, no session discovery via `/proc`, no raw session-env probing). Keep it green whenever the viewer path changes.

### Brokered real-service iteration

When the project-local Firejail include is installed, agents in this repo may have access to a narrow host broker via
`pdf-preview-servicectl` and `~/.cache/pdf-preview-servicectl/broker.sock`. Use it only for this host-service smoke
loop:

```bash
pdf-preview-servicectl sync
pdf-preview-servicectl restart
pdf-preview-servicectl status
pdf-preview-servicectl logs
```

This broker exists solely to sync/restart/status/log host-service support files so real open/close/SyncTeX behavior
can be tested outside the sandbox. It is not a general host-control channel and should forward to the same
`show-latex.service` workflow (for example `pdf-preview-servicectl restart`, `pdf-preview-servicectl status`, and `pdf-preview-servicectl logs`).
Do not use it for unrelated commands, unrelated services, or any purpose other than maintaining/testing the PDF host
service used by `open_pdf`, `close_pdf`, `jump_pdf`, `show_latex(inline=false)`, and
`compile_latex_file(open_pdf=true)`. 

## Verification commands

- Full: `npm run verify`
- Focused examples:
  - `node --test preview_pipeline.test.ts`
  - `node --test test/modules/viewer_service.test.ts`
  - `node --test show_latex.test.ts compile_latex_file.test.ts`
  - `node --test test/modules/preview/inline_preview_renderer.test.ts`
  - `node --test test/modules/preview/kitty_placeholder_image.test.ts`
  - `node --test test/modules/preview/kitty_placeholder_oracle.test.ts`
  - `node --test test/modules/preview/index_rendering.test.ts`
  - `node --test viewer_guardrails.test.ts`

## Constraints and limitations

These tests are designed as deterministic, offline checks and do **not** rely on:
- Live Pi runtime interaction beyond unit/test harness.
- Real Zathura/D-Bus desktop behavior.
- Real Kitty/tmux terminals.
- Real terminal screenshots/HITL.
- A full VT/graphics emulator.

They validate extension-side behavior only:
- output generation branches,
- refresh scheduling/registration,
- cache hit/miss/invalidation behavior,
- metadata loading and fallback handling,
- and semantic validity of rendered Kitty placeholder streams via the oracle.

They do not validate raw pixel-accurate rendering in actual terminal graphics backends.

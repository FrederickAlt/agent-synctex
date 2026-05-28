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

Useful diagnostics to check (from `oracle.diagnostics` / `oracle.summary`):
- `commandImageIds`
- `placeholderImageIds`
- `placements`
- `placeholders`
- `orphanPlaceholders`
- `invalidCoordinatePlaceholders`
- `commandCount`
- rendered failure reasons

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

## Verification commands

- Full: `npm run verify`
- Focused examples:
  - `node --test inline_preview_renderer.test.ts`
  - `node --test kitty_placeholder_oracle.test.ts`
  - `node --test index_rendering.test.ts`

## Constraints and limitations

These tests are designed as deterministic, offline checks and do **not** rely on:
- Live Pi runtime interaction beyond unit/test harness.
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
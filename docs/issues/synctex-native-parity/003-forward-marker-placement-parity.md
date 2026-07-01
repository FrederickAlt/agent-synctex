# Forward marker placement parity for circle indicators

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Fix and verify circle indicator placement so forward SyncTeX markers appear at the mapped PDF point, not pinned to the left edge or wrong container.

This slice should either closely copy LaTeX-Workshop's indicator placement/scrolling model or prove our Viewer Host adaptation with browser tests that exercise actual rendered page/canvas coordinates.

## Parent PRD coverage

- User stories covered:
  - forward circle appears at the mapped PDF point;
  - forward marker remains correct for left, center, and right PDF points.
- Implementation decisions covered:
  - prefer LaTeX-Workshop indicator placement where practical;
  - if adapted, prove the adaptation with browser-level assertions.
- Parent invariants this slice must preserve:
- viewer owns DOM/PDF.js marker placement; server must not compute CSS positions;
  - no custom SyncTeX lookup changes;
  - no fake rectangle dimensions for circle markers;
  - marker scrolling/focus policy remains separate from lookup.

## Acceptance criteria

- [ ] Browser test covers left, center, and right forward points.
- [ ] Marker bounding box is inside the rendered page/canvas at the expected x/y.
- [ ] Marker is not pinned to viewport or page left edge unless the SyncTeX point is actually there.
- [ ] Scroll/focus behavior makes the marker visible without changing mapped geometry.
- [ ] Native circle results and JS fallback circle results both use the same correct placement path.
- [ ] `npm run check` and relevant browser/viewer tests pass.

## Blocked by

- `001-native-forward-first-js-fallback.md`

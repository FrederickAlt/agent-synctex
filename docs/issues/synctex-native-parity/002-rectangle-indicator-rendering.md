# Rectangle indicator mode from native SyncTeX results

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Add end-to-end rectangle indicator support for native forward SyncTeX results.

When rectangle mode is configured and native lookup succeeds, the viewer should render all returned rectangles at the correct PDF locations. When rectangle mode is configured but native lookup fails and JS fallback succeeds, the viewer should show the LaTeX-Workshop fallback circle, not fake rectangles.

Use the LaTeX-Workshop and `../synctex_ideas/ideas.md` references from the parent PRD for rectangle parsing, dispatch, rendering, highlighting all result rectangles, and scrolling to highlight geometry.

## Parent PRD coverage

- User stories covered:
  - rectangle configured + native success renders rectangles;
  - rectangle configured + native failure + JS success renders a circle.
- Implementation decisions covered:
  - support native rectangle arrays;
  - render all primary-page rectangles;
  - do not synthesize rectangles for JS point fallback.
- Parent invariants this slice must preserve:
- server parses/chooses rectangle data; viewer only converts protocol rectangles through PDF.js and renders them;
  - PDF.js viewport conversion is used for rectangle geometry;
  - source lookup remains separate from viewer rendering;
  - secondary-page behavior is either supported or explicitly documented.

## Acceptance criteria

- [ ] Native rectangle output parses into a rectangle/range array.
- [ ] Viewer protocol accepts and validates rectangle arrays.
- [ ] Viewer renders multiple rectangles at expected positions.
- [ ] Viewer scrolls to rectangle geometry/union so highlights are visible.
- [ ] Rectangle configured + JS fallback success renders a circle, matching LaTeX-Workshop.
- [ ] Tests cover rectangle parsing, protocol, browser rendering, and fallback-to-circle behavior.
- [ ] `npm run check` and relevant viewer/protocol tests pass.

## Blocked by

- `001-native-forward-first-js-fallback.md`

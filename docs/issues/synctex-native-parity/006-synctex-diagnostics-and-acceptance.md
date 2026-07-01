# SyncTeX diagnostics and final acceptance audit

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Add/finish agent-facing SyncTeX diagnostics and perform the final acceptance audit for the parent PRD.

Diagnostics should make it clear which branch was used, what candidates were available, what was selected, and why. The final audit should verify the parent intent, not just that child issues merged.

Use `../synctex_ideas/ideas.md` idea 24 for debug/introspection inspiration.

## Parent PRD coverage

- User stories covered:
  - agents can diagnose forward/reverse SyncTeX failures without guessing;
  - parent behavior is verified end-to-end before closure.
- Implementation decisions covered:
  - expose native-vs-JS branch decisions;
  - expose native rectangles and JS fallback points;
  - expose reverse context/candidates/ranking where applicable.
- Parent invariants this slice must preserve:
- diagnostics must show server/client boundary data separately: lookup inputs/results vs viewer-rendered geometry;
  - diagnostics must not change production lookup behavior;
  - manual desktop Viewer Host smoke is required before parent closure;
  - deviations must be documented explicitly.

## Acceptance criteria

- [ ] Debug output records whether native or JS fallback handled forward sync.
- [ ] Debug output includes native parsed rectangles when applicable.
- [ ] Debug output includes JS fallback point when applicable.
- [ ] Debug output includes reverse context, candidates, and selected result where applicable.
- [ ] Manual desktop smoke covers forward circle, forward rectangles, native fallback circle, reverse prose click, and reverse formula/environment click.
- [ ] Final audit distinguishes implemented child issues, parent PRD satisfaction, manual gaps, and deferred work.
- [ ] `npm run check` and `npm test` pass.

## Blocked by

- `001-native-forward-first-js-fallback.md`
- `002-rectangle-indicator-rendering.md`
- `003-forward-marker-placement-parity.md`
- `004-reverse-selection-context-parity.md`
- `005-formula-reverse-geometry-ranking.md`

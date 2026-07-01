# Local issue drafts: SyncTeX native parity, rectangles, and reverse quality

Parent PRD/TDD:

- `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

These are local issue drafts because GitHub was unavailable when they were created.
Publish in numeric dependency order when GitHub is available.

## Proposed vertical slices

1. `001-native-forward-first-js-fallback.md`
2. `002-rectangle-indicator-rendering.md`
3. `003-forward-marker-placement-parity.md`
4. `004-reverse-selection-context-parity.md`
5. `005-formula-reverse-geometry-ranking.md`
6. `006-synctex-diagnostics-and-acceptance.md`

## Dependency graph

```text
001 native forward first + JS fallback
 ├─> 002 rectangle indicator rendering
 └─> 003 forward marker placement parity

004 reverse selection-context parity
 └─> 005 formula reverse geometry ranking

001,002,003,004,005 ─> 006 diagnostics and acceptance
```

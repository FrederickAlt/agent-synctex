# Native forward SyncTeX first, JS fallback second

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Implement the LaTeX-Workshop forward lookup order end-to-end: try native `synctex view` first, and only fall back to the existing JS parser when native lookup fails or returns no usable result.

This slice is complete when `jump_pdf` can demonstrate both branches:

- native success returns a native-derived forward result;
- native failure falls back to the JS parser and still returns a circle-style point result when the JS parser can map the source line.

Use the LaTeX-Workshop references from the parent PRD:

- native forward orchestration and fallback;
- native forward parsing;
- JS fallback forward mapper.

Do not implement rectangle rendering in this slice beyond returning a shape that the next slice can consume.

## Parent PRD coverage

- User stories covered:
  - forward sync should use LaTeX-Workshop's preferred native branch before JS fallback;
  - native failure should not break forward sync if JS fallback can map the source.
- Implementation decisions covered:
  - native `synctex view` first;
  - JS parser fallback second;
  - no custom SyncTeX parser reintroduction.
- Parent invariants this slice must preserve:
- server owns native `synctex` invocation and JS fallback; viewer receives only protocol results;
  - lookup stays separate from viewer policy;
  - no one-off formula heuristics;
  - clear native-vs-fallback branch reporting in tests/diagnostics.

## Acceptance criteria

- [ ] `jump_pdf` attempts native forward lookup before JS fallback.
- [ ] Native success returns a native-derived result without invoking JS fallback.
- [ ] Native failure/no-result falls back to the existing LaTeX-Workshop JS parser.
- [ ] Native failure plus JS success returns circle-style point data.
- [ ] Native failure plus JS failure reports no usable mapping clearly.
- [ ] Tests cover native success, native failure fallback, and total failure.
- [ ] `npm run check` and relevant targeted SyncTeX tests pass.

## Blocked by

None - can start immediately.

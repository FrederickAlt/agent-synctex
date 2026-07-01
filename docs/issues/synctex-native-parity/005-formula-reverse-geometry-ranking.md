# Formula reverse-sync geometry ranking

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Improve user-click reverse SyncTeX for displayed formulas and environments after LaTeX-Workshop parity is in place.

Formula clicks cannot rely primarily on PDF text extraction. Implement a geometry-first candidate ranking strategy inspired by `../synctex_ideas/ideas.md` ideas 14 and 15:

- prefer candidates geometrically close to the click;
- prefer smaller/local/content candidates over large environment boxes;
- penalize `\begin`, `\end`, labels, and tags when content candidates exist;
- use nearby text only as secondary evidence for prose or reliable text regions.

This slice must start with an oracle fixture that reproduces the current bad behavior: clicking formula content resolves to `\end{...}` or another structural line.

## Parent PRD coverage

- User stories covered:
  - clicking formula content should not always resolve to `\end{...}`;
  - reverse sync should prefer the clicked visual row/content where candidate data supports it.
- Implementation decisions covered:
  - geometry-first ranking for formulas;
  - text repair is secondary, not primary, for math.
- Parent invariants this slice must preserve:
- server owns ranking decisions; client only supplies click coordinates/context and renders results;
  - no one-off formula heuristics before test reproduction;
  - ranking must be based on candidate evidence and geometry;
  - compare against LaTeX-Workshop/native behavior where possible before diverging.

## Acceptance criteria

- [ ] A compiled fixture covers `equation`, `align`, `aligned`, and at least one nested environment.
- [ ] Test reproduces a bad reverse result such as resolving formula content to `\end{...}`.
- [ ] Ranking prefers closer/smaller/content candidate over enclosing environment candidate.
- [ ] Formula reverse tests pass without relying on PDF text extraction as the primary signal.
- [ ] Prose reverse behavior does not regress.
- [ ] Diagnostics expose candidate/ranking data for failed formula cases.
- [ ] `npm run check` and relevant reverse/oracle tests pass.

## Blocked by

- `004-reverse-selection-context-parity.md`

# Formula reverse SyncTeX candidate diagnostics and native comparison

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Before implementing formula reverse ranking, add diagnostics that answer whether the data currently available can support correct formula reverse sync.

For each clicked formula point in a compiled fixture, compare:

- expected source line;
- current LaTeX-Workshop JS reverse candidates;
- current JS-selected result;
- native `synctex edit` result for the same PDF point;
- whether the expected source line exists among candidate data;
- enough geometry metadata to decide whether a grounded ranker can pick the right line.

If diagnostics prove the expected line is present in candidate data and a geometry-first ranking rule can be justified, continue to implement the ranking in this slice. If not, stop and report the blocker before inventing heuristics.

## Parent PRD coverage

- User stories covered:
  - formula reverse-sync failures can be diagnosed without guessing;
  - clicking formula content should not be improved via speculative one-off heuristics;
  - native reverse behavior is compared before deciding whether JS candidate ranking is sufficient.
- Implementation decisions covered:
  - diagnostics first;
  - native `synctex edit` is allowed as a diagnostic/candidate source;
  - geometry-first ranking may proceed only if candidate evidence supports it;
  - text extraction is not the primary formula signal.
- Parent invariants this slice must preserve:
  - server owns diagnostics/ranking decisions; client only supplies click coordinates/context;
  - no speculative formula heuristics;
  - if candidate data is insufficient, stop and report rather than diverging.

## Acceptance criteria

- [ ] A compiled fixture covers `equation`, `align`, `aligned`, and at least one nested environment.
- [ ] Diagnostic output includes the clicked PDF point, expected line, JS selected result, native `synctex edit` result, and all JS reverse candidates considered.
- [ ] Each candidate includes source line, source text, rectangle geometry, distance to click, area, and whether the click is inside its rectangle.
- [ ] Tests prove diagnostics can reproduce or explain a formula reverse failure such as choosing `\end{...}` or an unrelated formula row.
- [ ] If JS candidates include the expected line with sufficient geometry evidence, ranking is implemented and tested.
- [ ] If JS candidates do not include sufficient evidence but native does, native reverse first / JS fallback is recommended or implemented only if clearly in scope.
- [ ] If neither JS nor native provides sufficient evidence, implementation stops and reports the limitation.
- [ ] Prose reverse behavior does not regress.
- [ ] `npm run check` and relevant reverse/oracle tests pass for any implemented changes.

## Blocked by

- `004-reverse-selection-context-parity.md`

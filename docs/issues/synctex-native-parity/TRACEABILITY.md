# Traceability matrix: SyncTeX native parity, rectangles, and reverse quality

Parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## User-facing promises

| Parent item | Owner issue(s) |
|---|---|
| Native `synctex view` forward path is attempted before JS fallback | 001 |
| Native failure falls back to JS parser | 001 |
| Rectangle configured + native success renders rectangles | 002 |
| Rectangle configured + native failure + JS success renders circle | 002 |
| Circle appears at mapped PDF point, not left edge | 003 |
| Reverse click events include LW selection context where available | 004 |
| Reverse row/column correction uses copied LW logic where applicable | 004 |
| Formula reverse click should not always resolve to `\end{...}` when candidate data supports content row | 005 |
| Agent-facing diagnostics expose branch/candidate/selection data | 006 |
| Manual desktop smoke verifies visible behavior | 006 |

## Implementation decisions

| Decision | Owner issue(s) |
|---|---|
| Keep lookup separate from UI/editor policy | 001,002,003,004,005 |
| Use LW native forward branch first | 001 |
| Use LW JS fallback second | 001 |
| Implement rectangle parsing/rendering from native output | 002 |
| Do not synthesize rectangles for JS fallback | 002 |
| Prefer LW indicator placement or prove adaptation with browser tests | 003 |
| Port LW reverse selection-context payload/correction | 004 |
| Use geometry-first ranking for formulas after LW parity | 005 |
| Treat text repair as secondary for math | 005 |
| Expose debug/introspection data | 006 |

## Testing decisions

| Test requirement | Owner issue(s) |
|---|---|
| Native success / native failure fallback / total failure | 001 |
| Rectangle parser/protocol/viewer rendering | 002 |
| Left/center/right circle browser placement | 003 |
| Reverse context correction and no-context fallback | 004 |
| Formula/environment reverse oracle | 005 |
| Candidate/ranking diagnostics | 005,006 |
| Full `npm run check` and `npm test` | Each issue, final in 006 |
| Manual desktop Viewer Host smoke | 006 |

## Out-of-scope constraints

| Constraint | Handling |
|---|---|
| Do not clone the full LaTeX-Workshop viewer | Applies to 002,003,004; implementation should adapt only SyncTeX-relevant behavior |
| Do not add passive cursor-following | Out of scope for all issues |
| Do not implement inverse-sync ranges yet | Out of scope for all issues |
| Do not implement native C library unless CLI/native output is insufficient | Applies to 001,005; must stop and ask if needed |
| Do not invent one-off formula heuristics before LW parity | Enforced by 001-004 blocking 005 |

## Lifecycle/security/concurrency/data-loss invariants

| Invariant | Owner issue(s) |
|---|---|
| Loopback/token/viewer security behavior must not regress | 002,003,004,006 |
| Viewer focus/scroll policy remains separate from lookup | 002,003,006 |
| SyncTeX data lifetime/reload behavior must not use stale sidecars silently | 001,006 |
| Reverse click failures should not create noisy modal-style errors | 004,005 |
| Existing MCP APIs remain agent-usable | All issues |
| SyncTeX lookup stays server-side; PDF.js viewport/DOM rendering stays client-side; protocol is the only boundary | All issues |
| Browser client must not receive filesystem/parser/native-process responsibilities | 001,004,005,006 |
| Server lookup layer must not depend on DOM/PDF.js viewport state | 002,003,004,005 |

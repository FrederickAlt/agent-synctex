# SyncTeX native parity final acceptance report

Parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## Child issue implementation audit

| Issue | Status | Evidence |
|---|---|---|
| 001 native forward first + JS fallback | Implemented | Forward mapper attempts native `synctex view` before JS fallback; tests cover native success, native failure fallback, and total failure. |
| 002 rectangle indicator protocol/rendering | Implemented | Native parsed rectangle ranges are carried in the protocol/result; JS fallback remains circle-style and does not synthesize rectangles. |
| 003 forward marker placement parity | Implemented | Browser/forward tests cover mapped point placement; debug CLI separates lookup points from rasterized viewer geometry. |
| 004 reverse selection context parity | Implemented | Reverse click payload supports `textBeforeSelection`/`textAfterSelection`; mapper uses LW-style row/column correction with fallback column `0`. |
| 005 formula reverse geometry ranking | Implemented for merged slice scope | Reverse diagnostics preserve raw mapped result and formula normalization context; formula fixtures assert closing structural hits expose enclosing formula spans. |
| 006 diagnostics and acceptance | Implemented except manual HITL | Forward and reverse diagnostics expose branch/context/candidates/selection data; this report documents manual smoke gap. |

## Diagnostics acceptance

- Forward diagnostics record the handling branch: `native` or `js_fallback`.
- Forward diagnostics preserve server lookup inputs/results separately from viewer-rendered geometry:
  - server lookup: command, args, cwd, status/stdout/stderr, parsed native point/rectangles, JS fallback point when used;
  - viewer geometry: debug CLI raster/image coordinates under `viewerRenderedGeometry`.
- Native parsed rectangles are exposed in `diagnostics.native.parsedRectangles` when native output contains rectangle records.
- JS fallback point is exposed in `diagnostics.jsFallback.point` when fallback handles forward sync.
- Reverse diagnostics expose lookup input, selection context, raw/context/formula candidates, and selected result.

## Parent PRD satisfaction

Automated coverage supports the parent SyncTeX parity promises for native-first forward lookup, JS fallback, rectangle/circle protocol behavior, forward marker placement tests, reverse selection context correction, formula-span normalization diagnostics, and agent-facing introspection.

## Manual desktop smoke checklist

Manual Viewer Host desktop HITL was not performed in this slice, per instruction. Before closing the parent PRD, run and record:

- [ ] Forward circle visibly appears at mapped PDF point.
- [ ] Forward rectangle mode visibly renders native rectangles.
- [ ] Native forward failure with JS fallback visibly renders a circle, not rectangles.
- [ ] Reverse prose click opens/selects the expected source row/column.
- [ ] Reverse formula/environment click does not collapse only to the enclosing `\end{...}` when a useful content/span result is available.

## Verification run

Latest automated verification for this slice:

- `npm run check`
- `node --test test/modules/synctex/forward_synctex.test.ts`
- `node --test test/modules/synctex/forward_synctex_debug_cli.test.ts`
- `node --test test/modules/viewer_host_mcp_boundary.test.ts`
- `node --test test/modules/pdfjs_viewer_mcp_service.test.ts`
- `npm test`

## Deferred or manual gaps

- Manual desktop Viewer Host smoke remains required and unverified here.
- No new SyncTeX lookup behavior was intentionally added in issue 006; changes are diagnostic/reporting only.
- Inverse-sync ranges and passive cursor-following remain out of scope per the parent PRD.

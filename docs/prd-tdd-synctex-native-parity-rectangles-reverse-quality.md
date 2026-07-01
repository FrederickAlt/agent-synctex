## PRD/TDD: SyncTeX parity and quality roadmap

Supersedes #117.

## Problem

The previous PRD focused on porting LaTeX-Workshop's JS/TS SyncTeX fallback. That was too narrow. It missed LaTeX-Workshop's preferred native forward path and rectangle indicator mode, and it did not include the reader-derived quality ideas needed for reliable reverse/user-click sync.

Observed HITL issues after the JS-only port:

- forward sync shows a circle at the left edge instead of at the mapped PDF location;
- reverse sync in environments can report the `\end{...}` block instead of the clicked formula/content row.

These are not acceptable as final behavior.

## Goal

Implement SyncTeX in this order:

1. **LaTeX-Workshop parity first**
   - native `synctex view` forward path first;
   - JS parser fallback second;
   - rectangle indicator mode from native results;
   - circle fallback when native fails but JS fallback succeeds;
   - LaTeX-Workshop reverse text-context protocol/correction where applicable.
2. **Then add reverse-sync quality improvements from `../synctex_ideas/ideas.md`**
   - prioritize geometry-based reverse candidate ranking for formula/math clicks;
   - use text repair as a secondary signal for prose, not as the primary formula strategy.

## Source references

### LaTeX-Workshop source of truth

Local reference bundle:

```text
/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/synctex_impl
```

Use these exact source areas:

- Native forward orchestration and fallback:
  - `synctex_impl/src/locate/synctex.ts:225-235`
  - `synctex_impl/src/locate/synctex.ts:318-374`
- Native rectangle parsing:
  - `synctex_impl/src/locate/synctex.ts:84-133`
- JS fallback forward mapper:
  - `synctex_impl/src/locate/synctex/worker.ts:146-178`
- JS reverse mapper:
  - `synctex_impl/src/locate/synctex/worker.ts:181-255`
- Viewer circle/rectangle dispatch and rendering:
  - `synctex_impl/viewer/components/synctex.ts:84-110`
  - `synctex_impl/viewer/components/synctex.ts:112-132`
  - `synctex_impl/viewer/components/synctex.ts:134-183`
- Reverse selection context payload:
  - `synctex_impl/viewer/components/synctex.ts:23-48`
- Reverse text-context correction:
  - `synctex_impl/src/locate/synctex.ts:540-557`
  - `synctex_impl/src/locate/synctex.ts:629-702`
- Protocol shapes:
  - `synctex_impl/types/latex-workshop-protocol-types/index.d.ts:2-14`
  - `synctex_impl/types/latex-workshop-protocol-types/index.d.ts:16-33`
  - `synctex_impl/types/latex-workshop-protocol-types/index.d.ts:77-111`

### Reader ideas source of truth

Local ideas file:

```text
/home/frederick/projects/AI/pi_extensions/synctex_ideas/ideas.md
```

Important sections from that file:

- Architecture/lifecycle:
  - idea 1: lookup separate from UI/editor policy;
  - idea 2: tie SyncTeX data lifetime to PDF reloads;
- Forward sync:
  - idea 3: robust source identity;
  - idea 4: repair/preprocess SyncTeX files;
  - idea 6: highlight all result rectangles;
  - idea 7: scroll to highlight geometry and explicit mark lifetime;
  - idea 11: bounded nearby-line fallback;
- Backward sync:
  - idea 12: page-local coordinate pipeline;
  - idea 13: normalize inverse source filenames;
  - idea 14: filter/rank inverse-search candidates;
  - idea 15: proximity/nearby-text repair;
  - idea 18: clear stale forward highlights before inverse sync;
  - idea 19: suppress noisy inverse-click errors;
- Diagnostics:
  - idea 24: SyncTeX debug/introspection view.

Concrete code references from `../synctex_ideas/ideas.md` to use when implementing non-LW improvements:

- Candidate filtering/ranking:
  - TeXworks: `readers/texworks/src/TWSynchronizer.cpp:133-151`, `readers/texworks/src/TWSynchronizer.cpp:287-301`
  - TeXstudio: `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4452-4469`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4491`
- Proximity/text repair:
  - SumatraPDF: `readers/sumatrapdf/src/PdfSync.cpp:345-412`
  - TeXworks: `readers/texworks/src/TWSynchronizer.cpp:158-224`, `readers/texworks/src/TWSynchronizer.cpp:246-313`, `readers/texworks/src/TWSynchronizer.cpp:317-368`
  - TeXstudio: `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4471-4489`, `readers/texstudio/src/texstudio.cpp:9103-9189`, `readers/texstudio/src/texstudio.cpp:9212-9235`
- Rectangle/highlight behavior:
  - SumatraPDF: `readers/sumatrapdf/src/PdfSync.cpp:923-950`, `readers/sumatrapdf/src/SearchAndDDE.cpp:1234-1265`
  - TeXworks: `readers/texworks/src/TWSynchronizer.cpp:100-111`, `readers/texworks/src/PDFDocumentWindow.cpp:700-708`
  - TeXstudio: `readers/texstudio/src/pdfviewer/qsynctex.cpp:135-143`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4517-4525`
  - Zathura: `readers/zathura/zathura/synctex.c:155-199`, `readers/zathura/zathura/synctex.c:328-363`
- Page-local inverse coordinate pipeline:
  - SumatraPDF: `readers/sumatrapdf/src/SearchAndDDE.cpp:1148-1194`
  - TeXworks: `readers/texworks/src/PDFDocumentWindow.cpp:563-619`, `readers/texworks/src/PDFDocumentWindow.cpp:999-1017`, `readers/texworks/src/PDFDocumentWindow.cpp:1045-1091`
  - TeXstudio: `readers/texstudio/src/pdfviewer/PDFDocument.cpp:1376-1379`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:1764-1777`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:1880-1898`
  - Zathura: `readers/zathura/zathura/synctex.c:44-68`, `readers/zathura/zathura/synctex.c:77-98`
- Inverse source path normalization:
  - SumatraPDF: `readers/sumatrapdf/src/PdfSync.cpp:799-871`, `readers/sumatrapdf/src/PdfSync.cpp:334-343`
  - TeXworks: `readers/texworks/src/TWSynchronizer.cpp:227-237`, `readers/texworks/src/PDFDocumentWindow.cpp:629-631`, `readers/texworks/src/PDFDocumentWindow.cpp:661-667`
  - TeXstudio: `readers/texstudio/src/pdfviewer/qsynctex.cpp:73-90`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4452-4456`


## Architecture boundary invariant

Keep the SyncTeX server/client split intact.

Server/backend responsibilities:

- MCP tool orchestration;
- PDF registration and source-path resolution;
- native `synctex` invocation and JS fallback lookup;
- forward/reverse SyncTeX result selection/ranking;
- diagnostics and event storage.

Viewer/client responsibilities:

- PDF.js rendering;
- browser click to page-local PDF coordinate conversion;
- collecting optional reverse selection context from the rendered PDF text layer;
- circle/rectangle marker rendering;
- scroll/focus/marker lifetime UI policy.

Protocol boundary:

- forward point data;
- forward rectangle arrays;
- reverse page-local PDF click coordinates;
- optional reverse text context;
- no filesystem paths or SyncTeX parser internals in the browser beyond what is required for display/event payloads.

Do not move SyncTeX parsing, source path handling, native process execution, or ranking decisions into the PDF.js client. Do not move PDF.js viewport/DOM rendering decisions into the SyncTeX lookup layer.

## Required behavior

### Forward sync

Implement LaTeX-Workshop behavior:

```text
configured indicator = rectangle/circle/none
→ try native synctex forward path first
→ if native succeeds:
     rectangle mode returns rectangle array
     circle mode returns point/circle
     none returns no visible indicator
→ if native fails:
     fallback to JS parser
     JS fallback returns point/circle-style data if it finds a mapping
→ if JS fallback also fails:
     no indicator / clear failure response
```

Important clarification:

```text
If rectangle mode is configured but native fails and JS fallback succeeds, LaTeX-Workshop shows a circle, not rectangles.
```

### Rectangle rendering

Support rectangle data from native forward results:

- accept an array of rectangles/ranges;
- convert rectangle corners through PDF.js viewport functions;
- render all primary-page rectangles;
- scroll to highlight geometry/union;
- preserve secondary-page hits if feasible, otherwise document the limitation.

### Forward circle placement

Fix the current HITL symptom:

```text
circle must appear at the mapped PDF point, not pinned to the left edge.
```

Do not invent a new positioning model without tests. Prefer copying/adapting LaTeX-Workshop indicator placement, or prove the adaptation with left/center/right browser tests using actual rendered canvas/page coordinates.

### Reverse sync

Implement LaTeX-Workshop reverse parity first:

- page-local click coordinate pipeline;
- selection-context payload:
  - `textBeforeSelection`
  - `textAfterSelection`
- copied/adapted row/column correction from LW;
- `column: 0` only when correction cannot improve it.

Then add reader-derived quality improvements:

- geometry-based candidate ranking for formula/math clicks;
- text repair as a secondary prose signal;
- avoid treating math text extraction as reliable primary evidence.

### Formula-specific policy

Displayed formulas are hard because PDF text extraction may be unreliable. For formulas, prefer:

1. native SyncTeX candidates;
2. geometry/candidate ranking;
3. smaller/local boxes over large environment boxes;
4. penalize `\begin`, `\end`, labels/tags when content candidates exist;
5. text repair only as weak secondary evidence.

## Non-goals

- Do not invent one-off formula heuristics before implementing LW native-forward/rectangle parity.
- Do not replace the Viewer Host architecture with a full LaTeX-Workshop viewer clone.
- Do not add passive cursor-following or cursor-follows-scroll in this PRD.
- Do not implement inverse-sync ranges yet.
- Do not implement native C library integration unless CLI/native `synctex` output is proven insufficient for the selected slice.

## Acceptance criteria

- Native forward path is attempted before JS fallback.
- Rectangle configured + native success renders rectangles.
- Rectangle configured + native failure + JS success renders a circle, matching LaTeX-Workshop.
- Circle placement is visually and testably correct for left/center/right PDF points.
- Reverse click events include LW selection context where available.
- Reverse row/column correction uses copied LW logic where applicable.
- Formula reverse test does not always resolve to `\end{...}` for clicked content rows unless direct comparison proves this is also LaTeX-Workshop behavior.
- Tests cover `.synctex`, `.synctex.gz`, native success, native failure fallback, rectangle rendering, circle rendering, reverse text context, formula reverse fixture, and diagnostics.
- `npm run check` and `npm test` pass.

## TDD plan / vertical slices

### Slice 1: Native forward first + JS fallback

Implement the LaTeX-Workshop native forward branch before the existing JS fallback.

References:

- `synctex_impl/src/locate/synctex.ts:225-235`
- `synctex_impl/src/locate/synctex.ts:318-374`
- `synctex_impl/src/locate/synctex/worker.ts:146-178`

Tests first:

- native command success returns native result;
- native command failure falls back to JS result;
- native failure + JS failure reports no mapping clearly;
- no custom parser path is reintroduced.

Expected state:

- forward lookup order matches LW.

### Slice 2: Rectangle indicator protocol and rendering

Implement rectangle parsing and viewer rendering.

References:

- LW rectangle parser: `synctex_impl/src/locate/synctex.ts:84-133`
- LW viewer rectangle renderer: `synctex_impl/viewer/components/synctex.ts:112-132`
- LW dispatch: `synctex_impl/viewer/components/synctex.ts:146-162`
- Ideas.md #6 and #7 rectangle/highlight references listed above.

Tests first:

- native rectangle output parses into rectangle array;
- viewer protocol accepts rectangle array;
- browser/viewer test renders multiple rectangles at expected positions;
- rectangle configured + JS fallback renders circle.

Expected state:

- real rectangle mode works when native data is available.

### Slice 3: Forward marker placement parity

Fix current circle-left symptom.

References:

- LW circle renderer/scrolling: `synctex_impl/viewer/components/synctex.ts:134-183`
- LW indicator lifecycle: `synctex_impl/viewer/components/synctex.ts:84-110`
- Ideas.md #7 scroll/highlight lifecycle.

Tests first:

- browser test for left/center/right PDF points;
- assert marker bounding box is inside the rendered page/canvas at expected x;
- assert scroll/focus does not pin marker to viewport left.

Expected state:

- circle appears at mapped PDF point.

### Slice 4: LW reverse selection-context parity

Add LW selection-context fields and row/column correction.

References:

- viewer context payload: `synctex_impl/viewer/components/synctex.ts:23-48`
- correction path: `synctex_impl/src/locate/synctex.ts:540-557`
- correction helpers: `synctex_impl/src/locate/synctex.ts:629-702`
- protocol types: `synctex_impl/types/latex-workshop-protocol-types/index.d.ts:89-95`

Tests first:

- viewer reverse click sends context fields when text is selected/available;
- reverse mapper uses context to improve column/row;
- no context preserves fallback `column: 0` behavior.

Expected state:

- user-click reverse sync matches LW correction behavior.

### Slice 5: Formula reverse oracle and geometry ranking

Add formula-specific reverse quality after LW parity.

References:

- Ideas.md #14:
  - TeXworks `readers/texworks/src/TWSynchronizer.cpp:133-151`, `287-301`
  - TeXstudio `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4452-4469`, `4491`
- Ideas.md #15:
  - SumatraPDF `readers/sumatrapdf/src/PdfSync.cpp:345-412`
  - TeXworks `readers/texworks/src/TWSynchronizer.cpp:158-224`, `246-313`, `317-368`
  - TeXstudio `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4471-4489`

Tests first:

- compile fixture with `equation`, `align`, `aligned`, nested environments;
- click visible content rows;
- assert result is not always `\end{...}`;
- compare against direct LW/native behavior where possible;
- geometry-ranking test prefers closer/smaller/content candidate over enclosing environment candidate.

Expected state:

- formula reverse sync improves without text-first assumptions.

### Slice 6: Diagnostics and acceptance

Update diagnostics to expose native/JS branch decisions and candidate data.

References:

- Ideas.md #24:
  - TeXstudio `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4373-4422`

Tests first:

- debug output records:
  - branch used: native or JS fallback;
  - native stdout/parsed rectangles where applicable;
  - JS fallback point where applicable;
  - reverse candidate/context data;
  - final selected result.

Expected state:

- future sync bugs can be diagnosed from agent-facing artifacts.

## Verification commands

Each slice must run relevant targeted tests plus:

```bash
npm run check
npm test
```

For viewer-visible changes, also run a manual desktop Viewer Host smoke before closing the parent PRD:

- forward circle;
- forward rectangles;
- native failure fallback circle;
- reverse prose click;
- reverse formula/environment click.

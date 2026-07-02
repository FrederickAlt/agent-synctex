# PRD: Robust Reverse SyncTeX Ranking and Forward Verification

Status: Draft  
Owner: agent-synctex  
Date: 2026-07-02

## Summary

Reverse SyncTeX currently works for many prose clicks, but complex LaTeX layouts such as minipages, figures, captions, display math, and natural page boundaries can produce useless structural mappings such as:

```tex
\end{document}
\newpage
\end{minipage}
\end{figure}
```

The current JS-first reverse path can correctly locate a SyncTeX block near the cursor, but the selected block can be a tiny layout artifact whose recorded source line is structural junk. Forward-syncing that structural source line is useless.

This PRD defines a robust reverse-sync workflow that combines:

1. JS SyncTeX candidate collection from parsed blocks.
2. Source-quality-aware candidate ranking.
3. PDF text-context repair.
4. Forward-sync verification and box filtering.
5. Confidence metadata and hover introspection.
6. The same repair path for point clicks and selection endpoints.

The goal is not perfect semantic SyncTeX. The goal is to avoid catastrophic mappings when nearby useful source evidence exists.

## Current state

The implementation currently has these relevant pieces:

- The standalone `synctex-js` parser is copied byte-for-byte:
  - `src/modules/synctex/latex_workshop/synctexjs.ts`
- LaTeX-Workshop worker/util code is adapted for Node:
  - `src/modules/synctex/latex_workshop/worker.ts`
  - `src/modules/synctex/latex_workshop/convertfilename.ts`
  - `src/modules/synctex/latex_workshop/pathnormalize.ts`
- Reverse SyncTeX point lookup is now LaTeX-Workshop JS-first:
  - `src/modules/synctex/forward_synctex.ts`
  - native `synctex edit` is fallback only after JS no-result/throw.
- Viewer Host supports:
  - Ctrl+Click reverse events;
  - selected-text range events;
  - a `SyncTeX hover` button;
  - reverse hover overlay;
  - hover-mode plain click reverse→forward probe.
- Diagnostics are hidden by default from `get_pdf_events`, with `debug: true` opt-in.

## Problem statement

In complex documents, SyncTeX blocks can have valid geometry but useless source associations. Example observed behavior:

```text
Clicked visible text: PAGETWODISPLAYINT
Reverse result:      line 78, \end{document}
Text context:        before=PAGETWOD, after=ISPLAYINT
Correct source:      line 66, \text{PAGETWODISPLAYINT}\quad J=...
```

The `.synctex` data is not semantically wrong globally; the nearest selected block is simply a bad candidate. A nearby or text-matched candidate can be better.

The workflow must prefer:

```text
near useful text/source box
```

over:

```text
exact/tiny useless structural block
```

## Goals

1. Avoid accepting structural junk when nearby useful candidates or text context exist.
2. Use the JS SyncTeX parser to collect and rank multiple reverse candidates on the clicked page.
3. Use PDF text context (`textBeforeSelection`, `textAfterSelection`) for source-text repair.
4. Verify repaired source lines by forward-syncing them and checking whether useful forward boxes align with the click.
5. Filter forward boxes before displaying or using them for verification.
6. Expose confidence/precision metadata so the model and user can distinguish verified/text/line-level results.
7. Extend robust mapping to selection endpoints, not only point clicks.
8. Improve hover/probe introspection by showing top candidates, repaired winner, and forward verification boxes.
9. Preserve raw SyncTeX result and diagnostics.

## Non-goals

- Do not integrate the SyncTeX C API in this slice.
- Do not make native CLI reverse primary again.
- Do not modify `src/modules/synctex/latex_workshop/synctexjs.ts` unless a separate parser bug is proven.
- Do not invent formula semantic heuristics such as guessing math meaning.
- Do not lie about `selected_text`. It remains the exact browser/PDF.js selection/copy text.
- Do not implement passive cursor-following or editor-scroll feedback loops.
- Do not solve edited-source-vs-compiled-line snapshot drift in this slice.

## Reader/reference ideas

The design is grounded in `../synctex_ideas/synctex_ideas.md`:

### #14 Filter, validate, or rank inverse-search candidates

References:

- TeXworks: `readers/texworks/src/TWSynchronizer.cpp:133-151`, `readers/texworks/src/TWSynchronizer.cpp:287-301`
- TeXstudio: `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4452-4469`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4491`

Applied as:

```text
collect candidates -> penalize bad source lines -> rank by proximity/source quality -> do not accept first/nearest blindly
```

### #15 Proximity or nearby text repair

References:

- SumatraPDF: `readers/sumatrapdf/src/PdfSync.cpp:19-25`, `readers/sumatrapdf/src/PdfSync.cpp:345-412`
- TeXworks: `readers/texworks/src/TWSynchronizer.cpp:158-224`, `readers/texworks/src/TWSynchronizer.cpp:246-313`, `readers/texworks/src/TWSynchronizer.cpp:317-368`
- TeXstudio: `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4471-4489`, `readers/texstudio/src/texstudio.cpp:9103-9189`, `readers/texstudio/src/texstudio.cpp:9212-9235`

Applied as:

```text
use nearby SyncTeX blocks and PDF/source text around click as repair signals
```

### #22 Inverse-sync ranges

References:

- TeXworks: `readers/texworks/src/PDFDocumentWindow.cpp:582-667`, `readers/texworks/src/PDFDocumentWindow.cpp:1045-1091`

Applied as:

```text
run the robust mapping pipeline for selection endpoints as well as point clicks
```

### #23 Precision policy

References:

- TeXworks: `readers/texworks/src/TWSynchronizer.h:40-43`
- TeXworks: `readers/texworks/src/PDFDocumentWindow.cpp:563-579`, `readers/texworks/src/PDFDocumentWindow.cpp:674-686`
- TeXworks: `readers/texworks/src/TWSynchronizer.cpp:115-117`, `readers/texworks/src/TWSynchronizer.cpp:143-151`, `readers/texworks/src/TWSynchronizer.cpp:216-224`, `readers/texworks/src/TWSynchronizer.cpp:303-313`

Applied as internal confidence metadata:

```text
precision = verified | text | line | raw
```

### #13 Source filename normalization

References:

- SumatraPDF: `readers/sumatrapdf/src/PdfSync.cpp:799-871`, `readers/sumatrapdf/src/PdfSync.cpp:334-343`
- TeXworks: `readers/texworks/src/TWSynchronizer.cpp:227-237`, `readers/texworks/src/PDFDocumentWindow.cpp:629-631`, `readers/texworks/src/PDFDocumentWindow.cpp:661-667`
- TeXstudio: `readers/texstudio/src/pdfviewer/qsynctex.cpp:73-90`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4452-4456`

Applied as:

```text
normalize/resolve candidate paths consistently before source-text repair and source comparison
```

### #18 Clear stale forward highlights before inverse sync

References:

- SumatraPDF: `readers/sumatrapdf/src/SearchAndDDE.cpp:1158-1160`
- TeXworks: `readers/texworks/src/PDFDocumentWindow.cpp:582-588`
- TeXstudio: `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4450-4451`

Applied as:

```text
real reverse clicks should clear stale probe/forward overlays when appropriate
```

### #19 Do not show noisy errors for every failed inverse-click

References:

- SumatraPDF: `readers/sumatrapdf/src/SearchAndDDE.cpp:1162-1174`
- TeXworks: `readers/texworks/src/PDFDocumentWindow.cpp:584-624`

Applied as:

```text
hover/probe failures clear overlays quietly and do not spam events
```

### #24 SyncTeX debug/introspection view

References:

- TeXstudio: `readers/texstudio/src/texstudio.cpp:2276-2280`, `readers/texstudio/src/pdfviewer/PDFDocument.cpp:4373-4422`

Applied as:

```text
hover mode should expose top candidates, raw winner, repaired winner, and forward verification boxes
```

### Forward-related #6/#7/#11

References:

- #6 Highlight all result rectangles and preserve secondary-page hits.
- #7 Scroll to/highlight geometry and explicit marker lifetime.
- #11 Nearby-line fallback when exact forward lookup misses.

Applied as:

```text
filter forward boxes and use nearby-line fallback only if exact forward lookup is empty/bad
```

## Proposed workflow

### Step 1: Collect enough JS SyncTeX reverse candidates

Use the parsed JS SyncTeX data, not CLI probing, for the initial candidate set.

For a PDF click:

```text
input: page, pdfX, pdfY, pdfPath, source context
output: candidate blocks on the clicked page
```

Candidate fields:

```ts
{
  sourceFile: string
  line: number
  column: number
  sourceLine?: string
  rect: { left: number; right: number; top: number; bottom: number }
  type?: string
  distanceX: number
  distanceY: number
  distance: number
  area: number
  containsClick: boolean
  structuralPenalty: number
  score: number
}
```

Candidate collection policy:

```text
include all candidates within minDistance
if fewer than minCandidates, add nearest candidates until minCandidates reached
if many high-quality candidates exist within the radius, keep them up to maxCandidates
```

Suggested initial constants:

```text
minCandidates = 8
maxCandidates = 40
minDistance = 12 PDF units or equivalent practical threshold
```

Exact values must be tuned with fixtures.

Initial ranking score:

```text
score = yDistance + 2 * xDistance + areaPenalty + structuralPenalty
```

Decision: x/column distance costs 2x y/row distance.

Rationale: it is acceptable to be slightly off row/line, but horizontally far candidates often reflect a different column/region.

Structural lines are heavily penalized but retained as fallback:

```tex
\end{document}
\newpage
\end{minipage}
\end{figure}
\begin{document}
```

Potential future structural patterns:

```tex
\end{table}
\end{center}
\end{flushleft}
\end{flushright}
```

These should be added cautiously based on evidence.

### Step 2: Text-context repair

Use PDF text context from the viewer:

```text
textBeforeSelection
textAfterSelection
```

This context is already passed in reverse events and hover/probe paths.

Preprocess context before searching source:

1. Normalize whitespace.
2. Split on Unicode/math glyphs that will not appear verbatim in TeX source.
3. Split on punctuation or glyph runs that are unlikely to map to source tokens.
4. Keep non-empty consecutive source-like strings.
5. Search longest useful strings first.

Examples:

```text
before=PAGETWOD, after=ISPLAYINT
candidate token=PAGETWODISPLAYINT
```

```text
selected/copied: ∫ 1 −1 (1 − u2) du
source-like fragments may be empty or weak; do not guess math semantics
```

#### Unique match

If source search finds exactly one match:

1. Forward-sync that matched source line.
2. Filter forward boxes.
3. If a filtered forward box contains the click, accept immediately with precision `verified`.
4. If no filtered box contains the click, keep the unique text match as a strong candidate with precision `text` and continue ranking/fallback.

Decision: a unique text match is not blindly final unless forward verification confirms the click geometry. It is, however, stronger than a structural SyncTeX candidate.

#### Ambiguous but small match set

If source search finds more than one but no more than a small threshold:

```text
maxTextMatchesForForwardVerification = 5
```

Then:

1. Forward-sync every candidate line.
2. Filter forward boxes.
3. Prefer the smallest filtered box containing the click.
4. If none contain the click, prefer nearest filtered box.
5. If forward verification cannot distinguish candidates, fall back to combined candidate ranking.

#### Too many/no matches

If text repair has no result or too many matches:

```text
fall back to ranked JS SyncTeX candidates
```

### Step 3: Forward verification and filtering

For a candidate source line, run existing forward SyncTeX mapping.

Forward boxes must be filtered even though forward results have usually been better than reverse results.

Forward filtering policy:

1. Prefer boxes on the clicked page.
2. Reject invalid boxes:
   - NaN coordinates;
   - non-positive width/height after minimum visibility normalization;
   - absurdly large page-sized boxes unless no alternative exists.
3. Prefer boxes containing the click.
4. Prefer smaller area.
5. Prefer nearest distance to click.
6. Preserve multiple useful rectangles for display when appropriate.

If exact forward lookup misses or returns only garbage, optionally try nearby source lines:

```text
line - 1
line + 1
line - 2
line + 2
```

This is reader idea #11 and should be implemented only after exact-line filtering is in place.

### Step 4: Final candidate selection

The final result should include:

```ts
{
  sourceFile: string
  line: number
  column: number
  sourceLine?: string
  precision: 'verified' | 'text' | 'line' | 'raw'
  rawWinner: Candidate
  repairedWinner?: Candidate
  topCandidates: Candidate[]
  forwardVerification?: {
    page: number
    boxes: ForwardBox[]
    chosenBox?: ForwardBox
    containsClick: boolean
  }
  diagnostics: ...
}
```

Precision meanings:

- `verified`: text/source repair or candidate selected and forward box contains click.
- `text`: unique or strong source text match, but forward verification did not contain click.
- `line`: ranked SyncTeX candidate only.
- `raw`: only raw structural/noisy candidate available.

### Step 5: Apply to all reverse use cases

The robust pipeline applies to:

1. Ctrl+Click point reverse.
2. Hover overlay winner/top candidates.
3. Hover-mode plain click reverse→forward probe.
4. Selected-text range start endpoint.
5. Selected-text range end endpoint.

Selection endpoint behavior:

- Keep `selected_text` exact from browser/PDF.js.
- Use robust point mapping for start/end endpoint coordinates.
- If selected text uniquely maps to source, prefer source-text range repair.
- Expose confidence metadata for start/end mappings.

## User-facing behavior

### Ctrl+Click reverse

Before:

```text
PAGETWODISPLAYINT -> \end{document}
```

After:

```text
PAGETWODISPLAYINT -> line 66
precision=verified or text
raw_winner=\end{document}
repair=text_context+forward_verification
```

### Hover mode

Hover should display:

- current raw SyncTeX winner;
- repaired winner, if different;
- top N candidates;
- forward verification boxes.

Example label:

```text
raw: line 78 \end{document}
repair: line 66 PAGETWODISPLAYINT [verified]
```

### Hover-mode plain click

Plain click with hover mode enabled should:

```text
resolve robust reverse -> forward-sync repaired line -> draw filtered forward boxes
```

No `get_pdf_events` entry is created.

### `get_pdf_events`

Normal reverse events should include compact diagnostics:

```text
source_file=...
line=66
precision=verified
raw_mapped_line=78
raw_mapped_source_line=\end{document}
repair=text_context
selected_text=... when applicable
```

Full details should include top candidates and scoring data behind a diagnostics/debug field.

## Acceptance criteria

1. `PAGETWODISPLAYINT` in the complex minipage/display fixture no longer maps to `\end{document}` when text context is available.
2. `FIGURETWOSMALLBOX` with context `FIGURE` + `TWOSMALLBOX` maps to its source line when unique.
3. Page-boundary/minipage clicks prefer nearby useful source lines over `\newpage` / `\end{minipage}` when candidates exist.
4. Hover overlay can show raw winner and repaired winner.
5. Plain-click hover-mode probe forward-syncs the repaired source line, not the raw structural line.
6. Ctrl+Click events preserve raw diagnostics while surfacing repaired result as the primary result.
7. Selection endpoint mappings use the robust pipeline and no longer expose structural endpoints when a verified/text repair exists.
8. Existing good prose reverse mappings remain stable.
9. Native reverse remains fallback only after JS no-result/throw.
10. `selected_text` remains exact browser/PDF.js selection text.
11. No hover/probe request is appended to `get_pdf_events`.
12. `npm run check` and `npm test` pass.

## Risks and tradeoffs

### False positive text repair

A text fragment may match the wrong source occurrence.

Mitigations:

- require uniqueness for terminal text repair;
- for small ambiguous match sets, forward-verify candidates;
- expose precision metadata;
- keep raw candidate in diagnostics.

### Math glyph mismatch

PDF text may contain glyphs such as:

```text
∫, ∞, √π, α, −
```

These do not match TeX source directly.

Mitigation:

- split on glyphs and search remaining source-like strings;
- do not implement speculative math semantic translation in this slice.

### Candidate ranking instability

Changing ranking can move some previously accepted results.

Mitigations:

- keep structural penalty narrow and evidence-based;
- add fixtures for known good prose/caption cases;
- expose top candidates in hover for debugging.

### Performance

Collecting candidates and forward-verifying multiple text matches could be expensive.

Mitigations:

- cache parsed SyncTeX data by sidecar path/mtime/size;
- cap top candidates and text matches;
- only forward-verify small ambiguous match sets;
- throttle hover.

### Forward boxes can be noisy

Forward verification depends on forward SyncTeX quality.

Mitigations:

- filter boxes;
- use forward containment as strongest signal but not the only signal;
- keep `text` precision if forward verification is inconclusive.

## Rollout plan

1. Implement candidate collection/top-N inspection without changing primary result.
2. Show top candidates in hover mode.
3. Add text-context source search and diagnostics, still non-primary.
4. Enable repaired winner for hover-mode plain click probe.
5. Enable repaired winner for Ctrl+Click events.
6. Apply to selection endpoints.
7. Tune ranking constants with complex fixtures.

## Deferred items

- SyncTeX C API integration.
- CLI nearby probing fallback.
- Compiled-line snapshot mapping for edited sources.
- Passive cursor-following.
- Full formula semantic translation.
- User-configurable precision policy.

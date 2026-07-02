# TDD: Robust Reverse SyncTeX Ranking and Forward Verification

Status: Draft  
Date: 2026-07-02

This TDD describes test-first implementation for the workflow in `docs/prd-robust-reverse-synctex-ranking.md`.

## Testing principles

1. Reproduce bad mappings before changing ranking.
2. Keep raw SyncTeX diagnostics visible in details.
3. Do not change `selected_text`; it must remain the exact browser/PDF.js selection text.
4. Treat robust repair as a backend concern.
5. Keep viewer responsibilities limited to pointer capture, text context capture, and rendering overlays.
6. Prove each behavior at the smallest layer first, then through browser/HITL-style integration.

## Implementation layers

### Layer A: JS worker candidate collection

Files:

- `src/modules/synctex/latex_workshop/worker.ts`
- `test/modules/synctex/forward_synctex.test.ts`

Add an inspection helper that can return top candidates from parsed SyncTeX blocks on a page.

Possible API:

```ts
inspectSyncTeXToTeXCandidates(page, x, y, pdfPath, options)
```

Where options include:

```ts
{
  minCandidates: number
  maxCandidates: number
  minDistance: number
  structuralPenalty: number
}
```

Candidate shape:

```ts
interface ReverseSyncTeXCandidate {
  input: string
  line: number
  column: number
  sourceLine?: string
  rect: { left: number; right: number; top: number; bottom: number }
  distanceX: number
  distanceY: number
  distance: number
  area: number
  containsClick: boolean
  structural: boolean
  structuralReason?: string
  score: number
}
```

#### Test A1: candidate collection preserves current winner

Fixture: simple synthetic `.synctex` or existing fixture.

Given current `syncTeXToTeX()` returns line N, `inspectSyncTeXToTeXCandidates(...).winner` should initially return same line N when no repair options are active.

Assertions:

```text
winner.line === syncTeXToTeX(...).line
winner.rect exists
winner.distance is finite
candidates.length >= 1
```

#### Test A2: minCandidates fills from nearest blocks

Create a parsed block fixture with:

- one block inside `minDistance`;
- several blocks outside `minDistance`.

With:

```text
minCandidates=4
minDistance=small
```

Assert:

```text
candidates.length >= 4
candidates sorted by score/distance
```

#### Test A3: minDistance keeps many high-quality candidates

Create fixture with many nearby blocks inside radius.

Assert:

```text
all blocks inside minDistance are included up to maxCandidates
```

#### Test A4: structural penalty demotes structural lines

Fixture blocks:

- tiny/near block mapped to `\end{document}`;
- slightly farther block mapped to `\text{PAGETWODISPLAYINT}...`.

Assert:

```text
without structural penalty: structural may win
with structural penalty: useful line wins
raw/top candidates still include structural block
```

#### Test A5: scoring applies x/column distance at 2x y/row distance

Fixture blocks arranged so one is vertically farther and one horizontally farther.

Assert ordering matches:

```text
score = yDistance + 2 * xDistance + penalties
```

## Layer B: source text-context repair

Files:

- `src/modules/synctex/forward_synctex.ts`
- test file: `test/modules/synctex/forward_synctex.test.ts`

Add helper(s):

```ts
buildSourceSearchFragments(before: string, after: string): string[]
findSourceTextMatches(sourceFile: string, fragments: string[]): SourceTextMatch[]
```

### Preprocessing rules

Input examples:

```text
before=PAGETWOD
after=ISPLAYINT
```

Expected fragments:

```text
PAGETWODISPLAYINT
PAGETWOD
ISPLAYINT
```

Input with glyphs:

```text
I = ∫ 1 −1 (1 − u2) du PAGETWODISPLAYINT
```

Expected behavior:

- split on math glyphs and punctuation that cannot match source directly;
- keep non-empty source-like strings;
- search longest useful fragments first;
- do not translate math glyphs to TeX commands in this slice.

#### Test B1: reconstruct split token from before/after

Given:

```text
before=PAGETWOD
after=ISPLAYINT
```

Assert first search fragment is:

```text
PAGETWODISPLAYINT
```

#### Test B2: split unicode/math glyphs

Given:

```text
before="I = ∫ 1 −1 "
after="PAGETWODISPLAYINT"
```

Assert fragments include:

```text
PAGETWODISPLAYINT
```

and do not require finding:

```text
∫
−
```

in source.

#### Test B3: unique text match returns strong candidate

Source line:

```tex
\text{PAGETWODISPLAYINT}\quad J=...
```

Context:

```text
before=PAGETWOD
after=ISPLAYINT
```

Assert:

```text
matches.length === 1
match.line === source line
match.column points to token
```

#### Test B4: ambiguous text matches <= threshold return all matches

Source has 3 occurrences of `TOKENALPHA`.

Assert:

```text
matches.length === 3
status === ambiguous-small
```

#### Test B5: too many matches are rejected for repair

Source has more than threshold occurrences.

Assert:

```text
status === too-many
no terminal repair
```

## Layer C: forward verification and box filtering

Files:

- `src/modules/synctex/forward_synctex.ts`
- `test/modules/synctex/forward_synctex.test.ts`

Add helper(s):

```ts
verifySourceLineByForwardBoxes(match, click, pdfPath): ForwardVerification
filterForwardBoxes(boxes, click, page): FilteredForwardBoxes
```

### Filtering policy

1. Prefer same page.
2. Reject invalid boxes.
3. Penalize absurdly giant boxes.
4. Prefer boxes containing click.
5. Prefer smaller area.
6. Prefer nearest box.

#### Test C1: unique text match verified by containing forward box

Given unique source text match and forward boxes where one contains click.

Assert:

```text
precision === verified
chosen line === match.line
chosen box contains click
```

#### Test C2: unique text match without containing box remains strong but not verified

Forward boxes exist but none contain click.

Assert:

```text
precision === text
candidate retained
pipeline can continue to JS candidate ranking
```

#### Test C3: ambiguous small matches choose smallest containing forward box

Matches lines A/B/C. Forward boxes:

- A contains click but huge;
- B contains click and small;
- C does not contain click.

Assert B wins.

#### Test C4: ambiguous small matches fallback to nearest box

No boxes contain click.

Assert nearest filtered box wins.

#### Test C5: giant garbage box filtered/penalized

Forward boxes include page-sized box and smaller nearby box.

Assert smaller nearby box wins.

## Layer D: robust reverse point pipeline

Files:

- `src/modules/synctex/forward_synctex.ts`
- `test/modules/synctex/forward_synctex.test.ts`

Possible API:

```ts
mapReverseSynctexRobust({ pdfPath, page, x, y, textBeforeSelection, textAfterSelection })
```

or integrate into existing `mapReverseSynctex()` behind tests.

Returned diagnostics should include:

```ts
{
  rawWinner: ...
  topCandidates: ...
  textRepair?: ...
  forwardVerification?: ...
  precision: 'verified' | 'text' | 'line' | 'raw'
}
```

#### Test D1: PAGETWODISPLAYINT repair beats `\end{document}`

Fixture modeled after observed failure:

- raw JS candidate winner maps to `\end{document}`;
- text context reconstructs `PAGETWODISPLAYINT`;
- source has unique token on line 66;
- forward boxes for line 66 contain click.

Assert:

```text
result.line === 66
result.precision === verified
result.rawWinner.sourceLine === \end{document}
result.diagnostics.textRepair.used === true
```

#### Test D2: structural candidate remains fallback when no repair exists

No useful text context and no better candidates.

Assert:

```text
result may remain structural
precision === raw or line
raw diagnostics preserved
```

#### Test D3: nearby useful candidate beats tiny structural block

Candidates include:

- structural block with distance 0;
- useful line with distance 4.

With structural penalty, useful line wins.

#### Test D4: good prose mappings do not regress

Existing prose reverse fixtures should still resolve to same lines/columns.

Assert branch remains JS and precision is at least line/text.

#### Test D5: native fallback policy unchanged

When JS no-result/throw occurs, native fallback can still run.

When JS returns an invalid line, native fallback remains disallowed as previously decided.

## Layer E: selection endpoint pipeline

Files:

- `src/modules/pdfjs_viewer_mcp_service.ts`
- `src/modules/viewer_host_client.ts`
- `src/modules/synctex/forward_synctex.ts`
- related service tests

Selection endpoints currently map first/last selected PDF coordinates.

Update endpoint mapping to use robust pipeline.

#### Test E1: endpoint structural junk repaired by selected text/source context

Selection endpoint raw maps to `\end{document}` but selected text uniquely maps to a source line/range.

Assert:

```text
selection_start.line === repaired line
selection_start_precision === text/verified
raw endpoint diagnostics preserve \end{document}
```

#### Test E2: selected_text remains exact browser value

Even if repair expands/uses context, event field:

```text
selected_text
```

must equal input/browser string exactly.

#### Test E3: ambiguous selected text does not guess beyond threshold

If selected text matches too many source locations, endpoint should fall back to robust point candidates or expose endpoint error/low confidence.

## Layer F: hover UI and introspection

Files:

- `src/modules/viewer_host_server.ts`
- `src/modules/viewer_host_protocol.ts`
- `src/modules/viewer_host_client.ts`
- browser tests

Hover mode should show:

- raw winner;
- repaired winner;
- top candidates;
- forward verification boxes.

Protocol result should include compact top candidate data.

Possible result shape:

```ts
{
  type: 'reverse_synctex_hover_result'
  request_id: number
  page: number
  raw?: CandidateSummary
  repaired?: CandidateSummary
  candidates?: CandidateSummary[]
  forward?: ForwardVerificationSummary
  precision?: string
}
```

#### Test F1: hover result renders top candidates

Simulate result with top candidates.

Assert label includes:

```text
raw: line 78
repair: line 66
```

#### Test F2: hover winner differs from raw structural candidate

Server returns raw structural and repaired verified result.

Assert overlay uses repaired/forward box as primary while raw is visible in label/details.

#### Test F3: hover still does not append events

Move hover and inspect `get_pdf_events`.

Assert no hover entries in default unread events.

#### Test F4: stale hover/probe behavior remains correct

Existing stale request tests must continue passing with richer payload.

## Layer G: hover-mode plain click reverse→forward probe

Files:

- `src/modules/viewer_host_server.ts`
- `src/modules/synctex/forward_synctex.ts`
- browser tests

Plain click in hover mode should use robust result, not raw winner.

#### Test G1: probe uses repaired line for forward boxes

Given raw winner `\end{document}` and repaired line 66 verified by forward box.

Assert probe label/box says:

```text
reverse line 66 -> forward boxes
```

not:

```text
reverse line 78 -> forward boxes
```

#### Test G2: Ctrl+Click remains normal reverse event

With hover mode on, Ctrl+Click should not create debug probe-only behavior.

Assert `get_pdf_events` receives normal reverse event.

#### Test G3: selection drag suppresses probe

Drag selection should produce selection event and no plain-click probe.

## Layer H: event formatting and diagnostics

Files:

- `src/modules/pdf_events.ts`
- `src/modules/host_service_mcp.ts`

Reverse event text should be model-friendly.

Default output should include:

```text
line/source_line
precision
selected_text if present
selection_start/end if present
raw_mapped_line if different
repair summary
normalized_formula_span if present
```

Full details should include top candidates and scores.

#### Test H1: repaired event formatting

Input event has raw line 78, repaired line 66.

Assert text includes:

```text
line=66
precision=verified
raw_mapped_line=78
repair=text_context
```

#### Test H2: diagnostics hidden unless useful

Do not spam every candidate in default text. Candidate list remains in details or debug mode.

## Red-green implementation sequence

### Slice 1: candidate inspection only

1. Add tests A1-A5.
2. Implement candidate collection/scoring in `worker.ts` adapter.
3. Keep existing result unchanged.
4. Update hover to optionally display top candidates.

Expected verification:

```bash
npm run check
node --test test/modules/synctex/forward_synctex.test.ts
node --test test/modules/viewer_host_browser.test.ts
npm test
```

### Slice 2: text-context repair helpers

1. Add tests B1-B5.
2. Implement context preprocessing and source search.
3. Do not change primary reverse result yet.

### Slice 3: forward verification/filtering

1. Add tests C1-C5.
2. Implement forward box filtering.
3. Add diagnostics-only forward verification.

### Slice 4: enable robust result for hover/probe

1. Add tests F/G.
2. Use repaired result for hover-mode plain click.
3. Keep Ctrl+Click unchanged.
4. Manual HITL on complex 3-page fixture.

### Slice 5: enable robust result for Ctrl+Click reverse events

1. Add tests D/H.
2. Make robust result primary for events.
3. Preserve raw diagnostics.

### Slice 6: selection endpoint integration

1. Add tests E.
2. Replace endpoint point mapping with robust mapping.
3. Preserve exact selected text.

## Fixtures

Use or generate fixtures with:

### Complex minipage/display failure

Source contains:

```tex
\text{PAGETWODISPLAYINT}\quad J=\int_{-1}^{1}(1-u^2)\,du
```

Observed bad click context:

```text
before=PAGETWOD
after=ISPLAYINT
raw=\end{document}
```

### Figure text/caption failure

Tokens:

```text
FIGURETWOSMALLBOX
FIGURETWOCAPTION
FIGURETHREEBOX
FIGURETHREECAPTION
```

### Natural page-boundary fixture

Use `/tmp/agent-synctex-complex-3page-natural-smoke/main.tex` structure or a checked-in test fixture equivalent.

Must include:

- page 2 naturally overflowing to page 3 without explicit second `\newpage`;
- minipages near page boundary;
- display equations;
- figures/captions.

### Prose regression fixture

Known good prose tokens:

```text
PAGETWOPROSEALPHA
PAGETWOPROSEOMEGA
PAGETHREEPROSEALPHA
```

## Manual/HITL plan

After each enabling slice:

1. Restart MCP.
2. Open complex 3-page fixture.
3. Enable `SyncTeX hover`.
4. Hover over:
   - `PAGETWODISPLAYINT`
   - `FIGURETWOSMALLBOX`
   - `FIGURETWOCAPTION`
   - `PAGETHREEPROSEALPHA`
   - page-boundary minipage text.
5. Confirm hover label shows:
   - raw winner;
   - repaired winner if applicable;
   - top candidates.
6. Plain click in hover mode and verify forward boxes are for repaired line.
7. Ctrl+Click and fetch `get_pdf_events`.
8. Confirm default event output is concise and no hover/probe spam appears.

## Diagnostics to expose

For repaired results, include in details:

```ts
{
  rawWinner: { line, sourceLine, rect, score },
  topCandidates: [{ line, sourceLine, score, structural, distanceX, distanceY }],
  textRepair: {
    fragmentsTried: string[],
    matchCount: number,
    selectedFragment?: string,
    line?: number,
    column?: number
  },
  forwardVerification: {
    attempted: boolean,
    boxesConsidered: number,
    boxesFiltered: number,
    chosenBox?: object,
    containsClick: boolean
  },
  precision: 'verified' | 'text' | 'line' | 'raw'
}
```

Default model-facing text should summarize, not dump all candidates.

## Verification commands

Each implementation slice should run targeted tests first, then the full suite when behavior changes:

```bash
npm run check
node --test test/modules/synctex/forward_synctex.test.ts
node --test test/modules/viewer_host_browser.test.ts
node --test test/modules/viewer_host_protocol.test.ts
node --test test/modules/pdfjs_viewer_mcp_service.test.ts
node --test test/modules/host_service_mcp_pdf_events.test.ts
npm test
```

## Success definition

The feature is successful when:

- bad structural mappings are preserved as raw diagnostics but are no longer primary when a verified/text repair exists;
- hover makes the candidate/ranking decision inspectable;
- plain-click probe shows boxes for repaired lines;
- Ctrl+Click emits repaired line with confidence metadata;
- selected text remains exact;
- all tests pass;
- HITL confirms improved behavior on complex minipage/figure/page-boundary fixtures.

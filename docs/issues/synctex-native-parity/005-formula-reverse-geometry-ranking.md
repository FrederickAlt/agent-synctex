# Reverse SyncTeX formula closing-span normalization

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Keep reverse SyncTeX simple. Do not implement formula candidate ranking now.

When reverse SyncTeX maps a click to a formula-closing structural line, enrich/normalize the reported source context to the enclosing formula span so the agent/LLM sees useful formula source instead of only a closing delimiter.

Examples of closing structural lines:

- `\end{equation}`
- `\end{align}` / `\end{align*}`
- `\end{aligned}` and similar math environments
- `\]`
- other simple display-math closing delimiters if already easy to detect safely

For `\end{...}`, find the matching preceding `\begin{...}` using a small source scanner that handles same-environment nesting. For `\]`, find the matching preceding `\[`.

Expose both:

- the raw SyncTeX mapped location; and
- the normalized formula source span/excerpt.

Do not hide the raw result. The purpose is source-context quality for agents, not pretending reverse SyncTeX found an exact formula row.

## Parent PRD coverage

- User stories covered:
  - formula reverse sync should not leave the agent with only `\end{...}` / `\]` source text;
  - agent-facing reverse events should contain a useful formula excerpt when SyncTeX lands on a formula close.
- Implementation decisions covered:
  - keep this simple;
  - no formula geometry ranking for now;
  - no C scanner;
  - stick with the existing CLI/native-forward and JS/LW reverse infrastructure;
  - preserve raw SyncTeX output and add normalized span context.
- Parent invariants this slice must preserve:
  - server owns source-span normalization; client only supplies click coordinates/context;
  - no speculative formula ranking heuristics;
  - no PDF text extraction as primary formula signal;
  - no native C library.

## Acceptance criteria

- [ ] Reverse event for `\end{equation}` includes a normalized formula span covering the matching `\begin{equation}`...`\end{equation}` block.
- [ ] Reverse event for `\end{align}` / `\end{align*}` includes the matching environment span.
- [ ] Reverse event for `\]` includes the matching `\[`...`\]` display-math span.
- [ ] Raw mapped line/source text remains available in event details.
- [ ] Normalized excerpt is included in agent-facing `get_pdf_events` details.
- [ ] Non-formula reverse events are unchanged.
- [ ] Nested same-environment cases do not pair with the wrong `\begin`.
- [ ] `npm run check` and relevant reverse/event tests pass.

## Blocked by

- `004-reverse-selection-context-parity.md`

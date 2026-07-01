# LaTeX-Workshop reverse selection-context parity

## Parent

Local parent PRD/TDD: `docs/prd-tdd-synctex-native-parity-rectangles-reverse-quality.md`

## What to build

Port LaTeX-Workshop's reverse selection-context behavior end-to-end.

The viewer should send surrounding selected text/context with reverse SyncTeX clicks when available, and the backend should use the copied LaTeX-Workshop correction logic to improve row/column results. Without usable context, reverse sync should preserve the current LaTeX-Workshop-compatible fallback behavior.

Use the parent PRD's LaTeX-Workshop references for:

- reverse context payload;
- protocol shape;
- row/column correction helpers.

## Parent PRD coverage

- User stories covered:
  - user-click reverse sync can use nearby/selected text to improve source location;
  - no-context clicks still return a valid fallback location where possible.
- Implementation decisions covered:
  - copy/adapt LaTeX-Workshop `textBeforeSelection` / `textAfterSelection` behavior;
  - `column: 0` only when correction cannot improve it.
- Parent invariants this slice must preserve:
- viewer collects text context and page-local coordinates; server owns SyncTeX correction/selection;
  - page-local coordinate pipeline remains explicit;
  - no custom text-repair logic beyond LaTeX-Workshop in this slice;
  - failed inverse-clicks should not become noisy modal failures.

## Acceptance criteria

- [ ] Viewer reverse payload includes selection-context fields when available.
- [ ] Protocol validates and transports context fields.
- [ ] Reverse mapper uses copied LaTeX-Workshop correction logic with context.
- [ ] No-context reverse behavior remains compatible with current fallback behavior.
- [ ] Tests cover correction success, no-context fallback, and event output through `get_pdf_events`.
- [ ] `npm run check` and relevant reverse/event tests pass.

## Blocked by

None - can start immediately.

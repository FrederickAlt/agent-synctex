# PRD #87 root compile coordination audit

Date: 2026-06-10  
Audit issue: #93  
Parent PRD: #87 / [`docs/prd-latex-root-compile-coordination.md`](./prd-latex-root-compile-coordination.md)

## Verdict

Approved for PRD traceability. The implementation slices on `prd-87-issue-93` cover the parent PRD's root-scoped compile coordination behavior with implementation, tests, and user-facing documentation. No blocking implementation gaps were found during the audit.

The real-TeX smoke remains intentionally opt-in and environment-dependent; it is documented and skips clearly unless `AGENT_SYNCTEX_REAL_TEX_SMOKE=1` and real `latexmk`/`lualatex` are available.

## User-story traceability

| Parent user stories | Coverage |
| --- | --- |
| 1, 2, 4, 5, 6, 34, 35, 36, 37, 42, 50, 52, 55, 56, 57, 58, 64, 65 | #88 serializes same-root one-shots, keeps different roots independent, normalizes relative/absolute paths through caller workspace context, propagates request cancellation/shutdown, and includes the aux-read race reproduction. |
| 3, 11, 23, 24, 25, 26, 27, 28, 47, 48, 49, 56, 59, 66 | #89 adds per-root last-result reuse with compiler identity, preserved warnings/diagnostics/artifact paths, latexmk recorder-based freshness, stale invalidation, stale failure replacement, and conservative fallback when freshness is uncertain. |
| 10, 11, 12, 13, 14, 15, 31, 32, 33, 43, 44, 45, 46, 53, 56, 60, 61, 63 | #90 routes one-shots through compatible active continuous compilation, exposes continuous cycle state, uses latexmk lifecycle hooks, rejects compiler mismatches with guidance, keeps one continuous compiler per root, and configures responsive polling. |
| 16, 17, 18, 19, 20, 21, 22, 29, 30, 51, 52, 54, 62 | #91 coordinates `clean=true` with active continuous compilation by stop/clean/restart/wait, preserving subscribers and compiler identity, surfacing restart/post-clean failures, and keeping viewer open after coordination. |
| 2, 6, 7, 8, 9, 29, 30, 38, 39, 40, 41, 52, 55, 65, 67, 68, 69, 70 | #92 preserves Host Service/MCP/Pi response compatibility, public tool arguments, managed viewer separation, missing-latexmk guidance, stale-log avoidance, timeout guidance, and README/tool text for wait/reuse/clean-restart behavior. |
| 1, 2, 4, 5, 10-19, 22, 31, 33-36, 41, 43-46, 50-54, 57-65, 68-70 | #94 adds the opt-in real latexmk/lualatex Host Service MCP smoke covering same-root concurrency, cache reuse, different-root concurrency, continuous waits, mismatch, clean/restart, subscriber lifecycle, and headless/no-viewer behavior. |

No parent user story is intentionally out of scope beyond the explicit PRD out-of-scope list below.

## Implementation-decision audit

Verified implemented decisions:

- File compilation remains standardized on latexmk and `compiler` is an engine selector, not a bare engine backend. The latexmk argument builder maps engines and preserves `-norc`, `-view=none`, recorder, SyncTeX, and `-no-shell-escape` flags.
- Root coordination is in a dedicated Host Service coordinator with per-root queues, cancellation, shutdown release, last-result cache, and freshness checks.
- Coordination keys are normalized from caller workspace context; relative and absolute spellings of the same root coordinate together. Different roots are independent.
- Same-root one-shots enqueue and run one latexmk at a time; fresh queued/repeated results are reused only when compiler identity and freshness metadata match.
- Freshness uses latexmk `.fls` recorder inputs/outputs plus log/PDF/database artifact snapshots. Missing or changed dependencies/artifacts conservatively disable reuse.
- Continuous coordination prevents one-shots from spawning competing latexmk processes while a compatible same-root `latexmk -pvc` is active; idle fresh results return immediately and stale/in-progress states wait for a lifecycle result.
- Continuous compiler mismatch errors identify the active compiler and instruct callers to use it or stop continuous compilation first.
- Continuous cycle state is explicit and driven by latexmk lifecycle hook output for compiling/success/warning/failure; bounded stdout/stderr capture remains in place for diagnostics and pending notifications.
- Continuous latexmk uses responsive `$sleep_time = 0.1` while preserving no-viewer and hardened flags.
- `clean=true` without active continuous compilation goes through the normal queued one-shot path. With active continuous compilation it stops the process, deletes artifacts including the PDF, restarts subscribers with the same compiler identity, waits for the first post-clean result, and reports restart/post-clean failures clearly.
- Managed viewer behavior remains separate: `open_pdf=true` opens only after coordinated compile/clean/restart succeeds.
- Existing continuous lifecycle semantics remain: `continuous=true` subscribes/reuses, `continuous=false` unsubscribes/stops only when final subscriber, omission leaves continuous state unchanged.
- Host Service shutdown rejects queued same-root waiters and stops continuous compilers; runtime queues/caches/continuous state are in-memory only and are not persisted across daemon restart.
- MCP and Pi response schemas remain compatible while passing through coordination and continuous metadata.

## Testing-decision audit

The testing decisions are represented by committed tests:

- Real aux-race reproduction and one-shot serialization/cache/different-root/timeout/shutdown tests are in `test/modules/host_service.test.ts`.
- Fresh-cache warning/diagnostic/artifact preservation, stale dependency invalidation, stale failure replacement, and conservative fallback are covered in `test/modules/host_service.test.ts`.
- Continuous wait, idle fresh return, stale-input wait, compiler mismatch, lifecycle failure, clean/restart/wait, open-after-clean, timeout, restart/post-clean failure, missing latexmk, stale-log prevention, close-vs-continuous separation, and shutdown behavior are covered in `test/modules/host_service_continuous_compile.test.ts`.
- MCP/tool description and compile/open protocol compatibility are covered in `test/modules/host_service_mcp.test.ts`.
- Pi tool documentation, argument-schema stability, timeout pass-through, continuous rendering, and user-facing descriptions are covered in `test/modules/pi_extension/compile_latex_file.test.ts`.
- The selective real-TeX E2E smoke is `test/modules/host_service_real_latexmk_smoke.test.ts` and is documented in `docs/testing-preview-framework.md`.

## Out-of-scope and invariant audit

Verified respected:

- No custom recursive LaTeX project watcher was added; docs continue to state that latexmk owns LaTeX-aware dependency tracking.
- No non-latexmk file compile backend was added. One-shot and continuous file compiles spawn `latexmk`; engine choices are passed as latexmk configuration.
- No automatic compiler switching was added. Active continuous compiler mismatches return errors with retry/stop guidance.
- Managed viewer open/jump/close semantics remain separate from compile coordination; `close_pdf` does not stop continuous compilation, and compile coordination does not open viewers unless `open_pdf=true`.
- Runtime queues, last-result cache, and continuous compiler state are process memory only; they are cleared by shutdown/restart and are not persisted.
- Same-root artifact writers are serialized across one-shot/continuous/clean paths; different roots remain concurrent.
- When freshness cannot be proven, cached output is not reused.
- Data-loss prevention for `clean=true` is preserved: artifacts are not deleted until active continuous compilation is stopped, and aborts during stop preserve artifacts and recover subscribers where possible.

## Documentation audit

Reviewed docs:

- Historical continuous-compilation PRD now includes a status/follow-up note pointing to root coordination and explicitly superseding older wording that implied every compile call spawns a fresh immediate one-shot latexmk.
- README compiler-selection/tool guidance explains same-root waiting, compatible continuous waits, fresh cached reuse, mismatch guidance, `clean=true` continuous restart/wait behavior, `open_pdf` ordering, `continuous` lifecycle, latexmk-only backend, no recursive watcher, no viewer-owned continuous lifecycle, and pending notification behavior.
- Pi and MCP tool descriptions mention coordinated same-root wait/reuse and clean-triggered continuous restart behavior.
- HITL continuous smoke notes remain historical evidence; they do not instruct implementers to bypass the newer root coordination PRD.
- Testing docs document the selective headless real-TeX coordination smoke and how it skips when not configured.

## Remaining follow-ups / residual risk

- None blocking for PRD #87. The real-TeX smoke should be run in environments with TeX Live/MacTeX when practical because the default test suite uses fakes for determinism.

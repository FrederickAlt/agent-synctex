## Problem Statement

Agents use `compile_latex_file` for LaTeX PDF Production while editing existing `.tex` files. File compilation is already latexmk-backed, but the Host Service currently allows more than one compiler activity to touch the same normalized root source at the same time. When two `latexmk` invocations operate on the same root concurrently, they both read and write the same preview artifacts and generated LaTeX state, including `.aux`, `.log`, `.fdb_latexmk`, `.fls`, `.synctex`, and `.pdf` files.

This creates user-visible failures that look like source errors but are really artifact races. A one-shot request can fail with diagnostics such as `Runaway argument?`, `File ended while scanning use of \@newl@bel`, or `File ended while scanning use of \@writefile` near `\begin{document}`, while another overlapping compile later writes a valid PDF. The agent then sees a confusing failure report even though the project log and PDF appear successful after the fact.

The same class of race can occur when a one-shot compile is started while a continuous `latexmk -pvc` compiler is already active for the same root source. Users need the Host Service to coordinate LaTeX PDF Production per root source so that agents cannot accidentally corrupt shared LaTeX build artifacts or receive misleading compile results.

## Solution

Add root-scoped compile coordination to the Host Service.

For each normalized root LaTeX source file, the Host Service should ensure that only one artifact-writing compiler path is active at a time. One-shot compile requests for the same root are queued and worked off sequentially. If a queued one-shot reaches the front of the queue and the previous request already produced a fresh result for the same root and compatible compiler configuration, the Host Service returns the cached compile result immediately instead of spawning another latexmk process.

When a continuous compiler is already active for the same root with a compatible compiler configuration, a one-shot request must not spawn a second latexmk process. Instead, the one-shot request behaves as a wait-for-compile operation: it returns the fresh last continuous result immediately if current, or waits for the current or next continuous compile cycle to finish using the same request timeout budget. If the continuous compiler is running with a different compiler engine, the Host Service returns a clear error explaining that a continuous compile is already active with another compiler and that the agent should use that compiler or stop the existing continuous compiler first.

When `clean=true` is requested while continuous compilation is active, the Host Service stops the continuous process, cleans the configured artifacts including the PDF, restarts continuous compilation for the existing subscribers using the same compiler configuration, waits for the first post-clean result using the same request timeout budget, and returns that result. This preserves existing clean semantics while avoiding deletion races against an active compiler process.

Continuous latexmk should be configured with a lower polling interval, such as `$sleep_time=0.1`, so that waiting one-shot requests and post-clean rebuilds respond quickly. The Host Service should store the last compile result per root source, including enough freshness metadata to determine whether that result can be reused safely. When freshness cannot be proven, the system should conservatively run or wait for a new compile.

## User Stories

1. As an agent compiling a LaTeX root file, I want same-root compile requests to avoid running concurrently, so that generated LaTeX artifacts are not corrupted by competing compiler processes.
2. As an agent editing a multi-file LaTeX project, I want `compile_latex_file` to return trustworthy diagnostics, so that I do not waste time debugging fake source errors caused by artifact races.
3. As an agent, I want repeated one-shot compiles for the same unchanged root to reuse a fresh prior result, so that duplicate compile requests do not waste time.
4. As an agent, I want queued one-shot compiles for the same root to run sequentially when recompilation is needed, so that each compile has exclusive access to root-scoped LaTeX build artifacts.
5. As an agent, I want a one-shot compile request to wait for an already-running same-root one-shot compile, so that my request receives the output of a safe compile instead of starting a conflicting process.
6. As an agent, I want a one-shot compile request to respect the same overall timeout while waiting in a queue, so that long queues or hung compilers do not block indefinitely.
7. As an agent, I want timeout messages to distinguish waiting from compiling when possible, so that I understand whether a compile timed out in the queue, in latexmk, or while waiting for continuous output.
8. As an agent, I want one-shot compile requests to keep using latexmk as the only file compilation backend, so that one-shot and continuous behavior are consistent.
9. As an agent, I want the `compiler` option to remain an engine selection for latexmk rather than invoking bare TeX engines, so that the public tool interface remains stable.
10. As an agent, I want a one-shot request made while compatible continuous compilation is active to wait for the continuous compiler instead of spawning a second latexmk process, so that continuous mode remains the single owner of root artifacts.
11. As an agent, I want a one-shot request made while continuous compilation is idle and fresh to return immediately, so that I get fast confirmation without unnecessary work.
12. As an agent, I want a one-shot request made while continuous compilation is currently compiling to wait for that compile cycle, so that I receive the result that continuous mode is already producing.
13. As an agent, I want a one-shot request made after source or dependency changes to wait for the next continuous result, so that the returned PDF reflects the current project state.
14. As an agent, I want a clear error when I request a different compiler from the one used by an active continuous compiler, so that I know why the Host Service cannot safely run my requested compile.
15. As an agent, I want that compiler mismatch error to tell me which compiler to use, so that I can retry with the compatible compiler if appropriate.
16. As an agent, I want `clean=true` to preserve its existing meaning of deleting same-basename artifacts including the previous PDF, so that clean continues to be a reliable recovery option.
17. As an agent, I want `clean=true` with continuous compilation active to stop and restart the continuous compiler safely, so that artifacts are not deleted while latexmk is writing them.
18. As an agent, I want `clean=true` with continuous compilation active to wait for the restarted compiler's first result, so that the tool response reflects the post-clean build.
19. As an agent, I want existing continuous subscribers to remain subscribed after a clean-triggered restart, so that clean does not unexpectedly disable continuous compilation.
20. As an agent, I want post-clean rebuilds to use the same compiler configuration as the prior continuous process, so that clean does not change engine behavior.
21. As an agent, I want a clean-triggered continuous restart to report failure clearly if restart fails, so that I can diagnose Host Service or latexmk issues.
22. As an agent, I want a clean-triggered continuous restart to respect the same timeout budget, so that a broken project does not hang the tool indefinitely.
23. As an agent, I want cached compile results to include warnings and warning counts, so that returning a cached result preserves the same diagnostic information as a live compile.
24. As an agent, I want cached compile results to include fatal diagnostics when the last current compile failed, so that I receive actionable failure information without rerunning needlessly.
25. As an agent, I want stale failure results to be replaced by later successful compile results, so that I do not keep seeing errors that have already been fixed.
26. As an agent, I want stale success results to be invalidated when known dependencies change, so that I do not get an outdated PDF by mistake.
27. As an agent, I want the Host Service to be conservative when freshness is uncertain, so that it prefers recompiling or waiting over returning a potentially stale result.
28. As an agent, I want one-shot requests to return the existing PDF/log/artifact paths when reusing a cached result, so that downstream open, jump, and inspection workflows continue to work.
29. As an agent, I want managed viewer behavior to remain controlled by `open_pdf`, so that compile coordination does not create surprise viewer windows.
30. As an agent using `open_pdf=true` on a compile request, I want the compile portion to be coordinated before any managed viewer open occurs, so that the viewer opens a coherent PDF artifact.
31. As an agent, I want continuous compilation to keep using `latexmk -pvc -view=none`, so that latexmk owns LaTeX-aware dependency tracking while the Host Service owns process coordination and viewer state.
32. As an agent, I want `latexmk -pvc` polling to be responsive, so that waiting one-shot requests do not sit idle for the default polling delay when a rebuild is needed.
33. As an agent, I want no duplicate continuous compiler processes for the same normalized root, so that background compilation cannot self-race.
34. As an agent, I want no duplicate one-shot compiler processes for the same normalized root, so that foreground compile requests cannot race each other.
35. As an agent, I want one-shot compiles for different root files to remain independent, so that coordinating one project does not block unrelated LaTeX PDF Production.
36. As an agent, I want relative and absolute references to the same root file to coordinate through the same normalized key, so that path spelling differences do not bypass the guard.
37. As an agent, I want compile coordination to account for workspace context, so that relative paths still resolve against the caller's project context.
38. As an agent, I want missing latexmk errors to remain clear and actionable, so that dependency setup failures are not obscured by coordination logic.
39. As an agent, I want aborted or superseded internal waits to produce clear responses, so that I understand whether a compile did not run because another safe result was returned.
40. As a Pi Extension user, I want the user-facing compile tool API to stay stable, so that existing prompts and tool calls continue to work.
41. As a Pi Extension user, I want compile failure summaries to avoid surfacing stale project log tails from another compile, so that reported diagnostics correspond to the result being returned.
42. As a Host Service maintainer, I want root compile coordination to be a deep module with a small interface, so that queueing, caching, waiting, and timeout behavior can be tested independently.
43. As a Host Service maintainer, I want continuous compile state to expose whether a root is compiling, idle, failed, or stopped, so that one-shot requests can coordinate without inspecting process internals.
44. As a Host Service maintainer, I want continuous compile cycles to produce structured state transitions, so that waiters can resolve on success, warning, or failure.
45. As a Host Service maintainer, I want latexmk lifecycle hooks to update Host Service state for continuous cycles, so that the service does not need to infer all state from free-form output alone.
46. As a Host Service maintainer, I want bounded output capture to remain available for diagnostics, so that background failures stay explainable without unbounded memory growth.
47. As a Host Service maintainer, I want a per-root last-result cache to store compile status, compiler identity, artifact paths, diagnostics, warning summaries, and freshness metadata, so that repeated requests can be answered safely.
48. As a Host Service maintainer, I want freshness checks to use latexmk-produced dependency information where available, so that multi-file projects are handled without recursive workspace watching.
49. As a Host Service maintainer, I want freshness checks to fall back conservatively when dependency information is incomplete, so that safety is prioritized over speed.
50. As a Host Service maintainer, I want queue waiters to be released reliably when a compile process exits, fails, times out, or is killed, so that no request remains stuck.
51. As a Host Service maintainer, I want cleanup and continuous restart to be atomic from the perspective of same-root compile requests, so that no one-shot starts while artifacts are half-cleaned.
52. As a Host Service maintainer, I want the same request timeout budget to cover queueing, waiting on continuous state, cleaning, restarting continuous compilation, and compiling, so that behavior is predictable.
53. As a Host Service maintainer, I want compiler engine identity comparisons to be reused between one-shot and continuous code paths, so that mismatch behavior is consistent.
54. As a Host Service maintainer, I want active continuous subscribers to survive clean-triggered restart, so that session lifecycle semantics remain intact.
55. As a Host Service maintainer, I want Host Service shutdown to resolve or reject pending compile waiters, so that daemon shutdown does not leave clients hanging.
56. As a Host Service maintainer, I want process exit and error handling to invalidate or update cached state appropriately, so that future requests do not rely on a broken result.
57. As a developer, I want a real reproduction test demonstrating concurrent same-root compiles can produce `\@newl@bel`-style aux-read failures while a PDF is later produced, so that the bug remains understandable.
58. As a developer, I want integration tests proving same-root one-shot requests no longer overlap, so that the core race is fixed.
59. As a developer, I want integration tests proving queued one-shots can return the previous fresh result, so that redundant compiles are avoided.
60. As a developer, I want tests proving one-shot requests wait on compatible continuous compiles, so that no second latexmk process is spawned during continuous mode.
61. As a developer, I want tests proving one-shot requests reject incompatible continuous compiler engines clearly, so that the edge case has predictable behavior.
62. As a developer, I want tests proving `clean=true` stops, cleans, restarts, and waits for continuous compilation, so that artifact deletion is coordinated safely.
63. As a developer, I want tests proving continuous polling is configured responsively, so that wait-for-compile behavior does not regress to slow polling.
64. As a developer, I want tests proving different roots can compile independently, so that the coordination scope is not overly broad.
65. As a developer, I want tests proving timeout behavior includes queue and continuous wait time, so that timeout contracts are externally visible.
66. As a developer, I want tests proving cached warnings and diagnostics are preserved in returned results, so that caching does not lose user-facing information.
67. As a developer, I want protocol and MCP responses to remain valid after adding coordination metadata, so that external clients keep receiving schema-compatible compile responses.
68. As a developer, I want documentation to explain that one-shot compile requests may wait for an active same-root compile, so that agents interpret apparent delays correctly.
69. As a developer, I want documentation to explain that `clean=true` restarts continuous compilation when needed, so that users understand the lifecycle effect.
70. As a developer, I want documentation to clarify that the Host Service coordinates root-scoped LaTeX PDF Production rather than relying on agents to avoid duplicate calls, so that future maintainers preserve the invariant.

## Implementation Decisions

- Keep file-based LaTeX PDF Production standardized on latexmk. The public `compiler` option remains an engine selector passed through latexmk configuration.
- Introduce a Host Service-owned root compile coordinator as a deep module. It should own per-root queues, waiter registration, timeout budgeting, cached compile results, freshness checks, and coordination between one-shot and continuous compile paths.
- Key coordination by normalized root source path after resolving caller workspace context. Different spellings of the same source must coordinate through the same root key.
- Allow different root source files to compile independently. The coordination scope is per normalized root, not global.
- For one-shot requests with no active compatible continuous compiler, enqueue per root and run at most one latexmk process at a time for that root.
- When a queued one-shot reaches the front and the last cached result is fresh for the same compiler identity, return that result immediately instead of invoking latexmk again.
- Treat freshness as a safety decision. Use latexmk-produced dependency information from recorder/database artifacts where available, output/log stats, root source stats, compiler identity, and artifact existence. If freshness cannot be proven, do not reuse the cached result.
- Store a last compile result per root. The result should include compile status, compiler exit information, warning and fatal diagnostics, artifact paths, log path, PDF path, cleaned artifact metadata where relevant, dependency freshness metadata, and compiler identity.
- One-shot requests made while continuous compilation is active with the same compiler identity must not spawn a second latexmk process. They should either return the fresh continuous last result or wait for the active/next continuous cycle to finish.
- One-shot requests made while continuous compilation is active with a different compiler identity should fail clearly and instruct the caller to use the active compiler or stop continuous compilation first.
- Add explicit continuous compile cycle state that waiters can observe: compiling, idle with last success/warning, idle with last failure, stopping, and stopped.
- Use latexmk's documented continuous lifecycle command hooks to update Host Service state around continuous compile cycles. Hooks should signal compiling, success, warning, and failure transitions in a structured form that the Host Service can consume reliably.
- Continue capturing bounded continuous stdout/stderr for diagnostics and pending background failure notifications.
- Configure continuous latexmk with a lower polling interval, such as `$sleep_time=0.1`, while preserving `-view=none`, hardened engine flags, no shell escape, recorder/SyncTeX-friendly behavior, and project-rc isolation.
- `clean=true` without active continuous compilation should clean the configured same-basename artifacts and then participate in the normal per-root one-shot queue.
- `clean=true` with active continuous compilation should stop the continuous process, clean artifacts including the PDF, restart continuous compilation for the existing subscribers with the same compiler identity, wait for the first post-clean result, and return that result.
- Existing continuous subscribers must remain subscribed across a clean-triggered restart.
- A clean-triggered restart failure should be surfaced as a compile response error with enough context to diagnose whether stopping, cleaning, restarting, or the post-clean compile failed.
- The same total request timeout budget should cover queue waiting, continuous-state waiting, clean coordination, continuous restart, and actual latexmk execution.
- Open/viewer behavior remains separate. If a compile request also asks for a managed viewer open, coordination must complete first, and the existing managed viewer open path should operate on the coherent resulting PDF.
- Existing continuous subscription lifecycle semantics remain: `continuous=true` subscribes or reuses; `continuous=false` unsubscribes; omission does not alter subscription state. This PRD changes how one-shot compile work coordinates with active state, not the public flag contract.
- Host Service shutdown should reject or resolve pending compile waiters and stop active continuous processes using existing lifecycle guarantees.
- The Pi Extension should preserve the existing public tool schema and user-facing language while passing through the improved Host Service behavior.
- MCP clients should receive compile responses that remain compatible with current response validation while optionally gaining coordination/continuous wait metadata if useful.

## Testing Decisions

- Tests should focus on external behavior: whether duplicate latexmk processes are prevented, whether requests wait or return cached results, whether diagnostics and artifact paths are correct, and whether clean/restart behavior is observable. Tests should not assert private map names or implementation-specific queue internals.
- Add a real reproduction-style test or smoke fixture showing that concurrent same-root latexmk compiles can produce aux-read failures such as `\@newl@bel` while another compile can still produce a valid PDF. This test documents the bug and validates the hypothesis without depending on private code.
- Add Host Service integration tests with fake latexmk binaries to prove same-root one-shot compile requests are serialized and do not overlap.
- Add Host Service integration tests proving queued same-root one-shot requests can return a fresh cached result without spawning a second process.
- Add Host Service integration tests proving one-shot requests for different roots can proceed independently.
- Add tests proving one-shot requests wait on an active compatible continuous compile rather than spawning another latexmk process.
- Add tests proving one-shot requests return a fresh continuous result immediately when continuous mode is idle and no dependencies changed.
- Add tests proving one-shot requests reject active continuous compiler engine mismatches with a clear agent-facing error.
- Add tests proving `clean=true` with active continuous compilation stops the process, cleans artifacts including the PDF, restarts continuous compilation with the existing subscribers, and waits for the first post-clean result.
- Add tests proving `clean=true` without continuous still cleans and compiles through the per-root queue.
- Add tests proving queue wait time and continuous wait time count against the same request timeout budget.
- Add tests proving cached result reuse preserves warnings, warning counts, diagnostics, artifact paths, compile status, and compiler identity.
- Add tests proving stale cached results are invalidated when the root source or known dependencies change.
- Add tests proving uncertain freshness falls back to recompilation or waiting rather than returning stale output.
- Add tests proving continuous latexmk is spawned with the configured lower polling interval and existing hardened flags.
- Add tests proving Host Service shutdown releases pending waiters and stops continuous compilers cleanly.
- Add MCP/Host Service protocol tests to ensure compile responses remain valid and clear for coordinated one-shot, cached, continuous-wait, clean-restart, timeout, and compiler-mismatch outcomes.
- Existing Host Service compile tests, continuous compile manager tests, MCP tests, and Pi extension compile tool tests are prior art for fake compiler binaries, temporary Host Service instances, fake viewer backends, process lifecycle assertions, and user-facing response text.

## Out of Scope

- Supporting file compilation without latexmk.
- Implementing a custom recursive LaTeX project watcher.
- Running isolated same-root one-shot compiles in separate aux/output directories as the primary strategy.
- Automatically switching the compiler engine of an active continuous compiler to satisfy a one-shot request.
- Persisting compile queues, cached results, or continuous compiler state across Host Service restart.
- Changing the public `compile_latex_file` tool arguments beyond behavior and optional metadata.
- Changing managed viewer open, PDF ID, jump, or close semantics.
- Guaranteeing zero latency for continuous rebuild detection; the goal is responsive polling and safe waiting, not synchronous filesystem events.
- Pushing continuous compile failures into the middle of an active agent turn beyond existing pending notification behavior.
- Building a user-facing dashboard for compile queues or continuous state.

## Further Notes

- A real reproduction was performed by launching two `compile_latex_file` calls against the same temporary root. One request failed with `Runaway argument?` and `File ended while scanning use of \@newl@bel`, while the other request produced a valid PDF. A subsequent clean compile succeeded, confirming the failure was caused by concurrent artifact access rather than a persistent source error.
- `latexmk -pvc` does recompile when generated files disappear. In manual testing, deleting generated aux/output artifacts while `latexmk -pvc` was idle caused latexmk to report disappeared generated files and rebuild. The chosen `clean=true` behavior still stops and restarts continuous compilation because it is safer and avoids deleting artifacts while a compiler process may be writing them.
- `latexmk` exposes useful primitives including `-pvc`, recorder/database artifacts, cleanup modes, force modes, aux/output directory options, lifecycle command hooks, and polling interval configuration. It does not appear to expose a documented RPC interface for telling an already-running `-pvc` process to clean or rebuild on demand, so root coordination remains a Host Service responsibility.
- This PRD complements the existing continuous LaTeX compilation work by tightening the invariant that the Host Service is the sole coordinator of root-scoped LaTeX PDF Production and preview artifact ownership.

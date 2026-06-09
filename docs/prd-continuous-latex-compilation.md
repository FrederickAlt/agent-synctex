# PRD: Continuous LaTeX Compilation with Session Subscriptions

Source issue: [#73 Add continuous LaTeX compilation with session subscriptions](https://github.com/FrederickAlt/agent-synctex/issues/73) — implemented and closed.

## Status and Follow-up Coordination

This PRD is retained as historical context for the implemented continuous compilation feature. For same-root compile coordination, cache reuse, one-shot requests waiting on active continuous compilation, and `clean=true` interactions with continuous compilation, see [PRD: LaTeX root compile coordination](./prd-latex-root-compile-coordination.md).

The follow-up coordination PRD supersedes any wording below that implies every `compile_latex_file` call must always spawn a fresh immediate one-shot `latexmk` process. The intended follow-up behavior is that same-root one-shot requests are queued and may reuse a fresh cached result, one-shot requests should wait on a compatible active continuous compiler instead of spawning a competing `latexmk`, and `clean=true` should coordinate with continuous compilation by stopping, cleaning, restarting, and waiting for the post-clean result.

## Problem Statement

Agents can currently compile an existing LaTeX source file as a one-shot operation and optionally open the resulting PDF through the Host Service. File compilation should now be consistently driven by `latexmk`, with the selected compiler (`lualatex`, `pdflatex`, or `xelatex`) passed to `latexmk` as the engine configuration. One-shot latexmk-backed compilation works well for isolated compile requests, but it is inefficient for iterative editing of multi-file LaTeX projects. After each edit, the agent must explicitly re-run the compile tool, and the system has no durable way to keep the PDF fresh as included files, bibliography files, or other project dependencies change.

The hard user-facing problem is tracking file changes in a LaTeX project that may span many files. A naïve recursive watcher would either miss dynamic LaTeX dependencies or watch too much of the workspace, causing noisy recompiles and implementation complexity. Users need a simple tool flag that enables continuous compilation for the root document without creating orphan compiler processes or duplicate compiler workers for the same file.

Continuous compilation also creates a new feedback problem: later background compilation failures happen after the compile tool call has returned. The agent still needs to learn about unresolved background LaTeX failures with diagnostics similar to synchronous compile failures, but stale failures should be cleared automatically if a later background compile succeeds before the agent is notified.

## Solution

Add a `continuous` flag to the existing LaTeX file compile tool. The flag controls a Host Service-owned continuous compilation subscription for the normalized root LaTeX source file.

When an agent passes `continuous=true`, the Host Service first performs an immediate latexmk-backed compile using the selected compiler as latexmk engine configuration and then ensures a single `latexmk -pvc` process is active for that root file with the same engine mapping. If continuous compilation is already active for that file, the Host Service does not start another process; it reports that continuous compilation is already active and refreshes/adds the current agent session subscription.

When an agent passes `continuous=false`, the Host Service first performs an immediate latexmk-backed compile using the selected compiler as latexmk engine configuration and then removes the current agent session's subscription. If other live sessions are still subscribed to the same root file, the shared continuous compiler remains active. If the current session was the last subscriber, the Host Service stops the `latexmk` process.

When the `continuous` flag is omitted, the compile tool performs a one-shot latexmk-backed compile and does not alter continuous compilation state.

File compilation uses `latexmk` as the single backend. One-shot compilation runs latexmk once; continuous compilation uses `latexmk -pvc -view=none` so that latexmk performs LaTeX-aware dependency tracking for multi-file projects while the Host Service continues to own viewer state, PDF IDs, callback routing, and lifecycle management. The Host Service must not rely on recursive project-wide file watching for this feature.

To avoid orphan compiler processes after agent crashes, agents periodically send a heartbeat to the Host Service. Continuous compilation subscriptions are tied to `workspace_context.session_id`; if a session heartbeat expires, the Host Service removes that session from all continuous compile subscriptions and stops any continuous compiler process with no remaining live subscribers.

For later background compilation failures, the Host Service stores ephemeral pending system-info notifications per subscribed session and root source. A failure that does not produce or update a PDF creates or replaces the pending notification with diagnostics similar to synchronous compile failure output. A later successful background compile clears the pending notification before it is delivered. Pi and other wrappers pull pending notifications from the Host Service at agent boundaries, such as agent end or next agent start, and inject them as `[system info]` messages. Delivery clears the pending notification.

## User Stories

1. As an agent editing a LaTeX project, I want to enable continuous compilation with a compile tool flag, so that the PDF stays current while I make iterative edits.
2. As an agent editing a multi-file LaTeX project, I want dependency tracking to include files referenced by LaTeX commands, so that edits to included files trigger recompilation.
3. As an agent editing bibliography-backed documents, I want continuous compilation to respect bibliography-related dependencies, so that citation and bibliography edits are reflected in the compiled PDF.
4. As an agent compiling a root document, I want relative includes and graphics paths to keep resolving from the source file's directory, so that continuous mode behaves like existing file compilation.
5. As an agent, I want `continuous=true` to still perform an immediate compile, so that I get compile feedback right away instead of waiting for a later change.
6. As an agent, I want `continuous=true` to be idempotent for the same root file, so that repeated calls do not create duplicate background compilers.
7. As an agent, I want repeated `continuous=true` calls to tell me continuous compilation is already active, so that I understand no new compiler was started.
8. As an agent, I want `continuous=false` to stop my subscription, so that I can explicitly deactivate continuous compilation through the same tool.
9. As an agent, I want `continuous=false` to still compile the document once, so that changing the flag only affects continuous state and does not skip normal compile behavior.
10. As an agent, I want omitting `continuous` to perform a latexmk-backed one-shot compile without changing continuous state, so that existing tool usage remains compatible while using the same compile backend.
11. As an agent, I want omitting `continuous` not to accidentally stop an active continuous session, so that a normal compile does not disrupt background compilation.
12. As an agent, I want omitting `continuous` not to accidentally start continuous compilation, so that background processes are only created intentionally.
13. As a second agent working on the same root file, I want to subscribe to an existing continuous compiler instead of starting a second one, so that shared work does not duplicate compiler processes.
14. As one of multiple subscribed agents, I want `continuous=false` to remove only my subscription, so that I do not disrupt other live agents still using continuous compilation.
15. As the last subscribed agent, I want `continuous=false` to stop the background compiler, so that no unnecessary compiler remains running.
16. As an agent, I want continuous compilation to require a session identity, so that background work can be tied to a live client lifecycle.
17. As an agent wrapper maintainer, I want a clear error when continuous mode is requested without a session id, so that I can fix wrapper integration quickly.
18. As a raw MCP client user, I want normal one-shot compilation to keep working without a session id, so that legacy/debug workflows remain available.
19. As a raw MCP client user, I want continuous compilation to fail clearly without `workspace_context.session_id`, so that unowned background compilers are not started.
20. As a Host Service user, I want continuous compiler processes to stop when their owning sessions stop heartbeating, so that crashed agents do not leave orphan `latexmk` processes.
21. As a Host Service user, I want all continuous compiler processes to stop on Host Service shutdown, so that daemon lifecycle cleanup is reliable.
22. As an agent, I want the heartbeat mechanism to be automatic, so that I do not need to call a heartbeat tool manually during normal Pi or MCP-wrapper use.
23. As an agent, I want heartbeat expiry to be tolerant of brief delays, so that transient latency does not prematurely stop continuous compilation.
24. As an agent, I want the compile response to include whether continuous compilation was started, already active, deactivated, still active for other subscribers, or unavailable, so that I can report accurate state.
25. As an agent, I want the compile response to include the continuous compiler process id when available, so that diagnostics can identify the running background process.
26. As an agent, I want the compile response to include subscriber counts or equivalent state, so that I can tell whether other sessions still keep a compiler alive.
27. As an agent, I want continuous compile errors to preserve current diagnostic behavior for the immediate compile, so that LaTeX errors remain actionable.
28. As an agent, I want missing `latexmk` to produce a clear error for any file compile request, so that I know how to install the required dependency.
29. As an agent on macOS, I want the error for missing `latexmk` to make clear that it is supplied by MacTeX/TeX Live rather than the operating system, so that setup is understandable.
30. As an agent, I want ordinary compilation with `lualatex`, `pdflatex`, or `xelatex` to be routed through latexmk engine configuration, so that one-shot and continuous compiles use the same backend and behavior.
31. As an agent, I want continuous mode to use `latexmk` without opening its own viewer, so that the Host Service remains the owner of managed viewer opens and PDF IDs.
32. As an agent, I want external PDF viewing behavior to remain controlled by `open_pdf`, so that continuous compilation does not create surprise viewer windows.
33. As an agent, I want closing a PDF viewer to avoid stopping continuous compilation, so that viewer lifecycle and compiler subscription lifecycle are separate.
34. As an agent, I want to stop continuous compilation explicitly via `continuous=false`, so that the tool description teaches the correct lifecycle control.
35. As an agent, I want fast repeated file edits to be coalesced or serialized by the continuous compiler, so that I do not create overlapping LaTeX compiler runs.
36. As a Host Service maintainer, I want only one continuous compiler process per normalized root source file, so that multiple requests cannot fight over the same PDF and log artifacts.
37. As a Host Service maintainer, I want continuous sessions keyed by normalized root source paths, so that relative and absolute requests for the same document resolve to the same compiler session.
38. As a Host Service maintainer, I want continuous sessions to track subscribers separately from the process, so that N sessions can share one compiler.
39. As a Host Service maintainer, I want session expiry pruning to remove subscriptions and stop unreferenced compilers, so that memory and process state remain bounded.
40. As a Host Service maintainer, I want recent continuous compiler output retained in bounded form, so that failures can be diagnosed without unbounded logs.
41. As a Host Service maintainer, I want the continuous compile manager to be testable independently, so that process lifecycle and subscription behavior can be verified without full UI integration.
42. As a Host Service maintainer, I want heartbeat handling to be testable independently, so that expiry logic can be verified deterministically.
43. As a Pi extension user, I want session start to initialize heartbeats automatically, so that continuous compilation stays alive while the session is alive.
44. As a Pi extension user, I want session shutdown to stop heartbeats and unregister subscriptions through expiry or cleanup, so that session lifecycle is respected.
45. As an MCP-wrapper user, I want the wrapper to inject workspace context and heartbeat automatically, so that continuous compilation works without manual setup.
46. As a Codex relay user, I want heartbeat support to be part of the relay behavior, so that the Host Service can detect whether the agent process is still alive.
47. As a developer, I want one-shot compile tests updated to assert latexmk-backed behavior, so that file compilation has one consistent backend.
48. As a developer, I want MCP tool schemas to expose `continuous` accurately, so that clients can discover and use the flag.
49. As a developer, I want Host Service request validation to reject malformed continuous values, so that protocol safety is maintained.
50. As a developer, I want compile response validation to accept continuous metadata, so that clients can safely consume the new response shape.
51. As a developer, I want tests proving repeated `continuous=true` does not spawn duplicate processes, so that the singleton guarantee is enforced.
52. As a developer, I want tests proving two sessions can share one continuous compiler, so that the subscription model is covered.
53. As a developer, I want tests proving one session can unsubscribe without stopping another session's compiler, so that N-to-1 behavior is covered.
54. As a developer, I want tests proving heartbeat expiry removes subscriptions and stops orphan compilers, so that crash safety is covered.
55. As a developer, I want tests proving Host Service shutdown stops all continuous compilers, so that lifecycle cleanup is covered.
56. As a developer, I want tests proving missing `session_id` rejects continuous requests, so that unowned background processes cannot start.
57. As a developer, I want tests proving missing latexmk rejects file compilation clearly, so that dependency errors are user-friendly.
58. As a developer, I want docs describing `continuous=true`, `continuous=false`, and omitted semantics, so that tool users know how to control the feature.
59. As a developer, I want docs clarifying that `close_pdf` does not stop continuous compilation, so that users do not rely on viewer close for compiler lifecycle.
60. As a developer, I want docs clarifying that latexmk handles multi-file dependency tracking, so that future maintainers do not add a redundant recursive watcher.
61. As an agent, I want unresolved background continuous compile failures to be delivered as `[system info]`, so that I learn about failures that happen after the tool call returned.
62. As an agent, I want background failure notifications to include diagnostics similar to synchronous compile failures, so that I can fix LaTeX errors without manually inspecting logs first.
63. As an agent, I want background failure notifications to be delivered at the next agent boundary, so that asynchronous compiler output appears at a predictable time rather than interrupting an active turn.
64. As an agent, I want background failure notifications to be available at agent end or the next agent start, whichever boundary comes next, so that I still receive unresolved failures even if the failure happens near the end of a turn.
65. As an agent, I want a later successful background compile to clear a pending failure before it is shown, so that I am not distracted by stale errors that have already been fixed.
66. As an agent, I want only the latest unresolved background failure per session and root file, so that repeated failed rebuilds do not flood my context.
67. As a Pi extension user, I want Pi to pull pending continuous compile notifications from the Host Service at agent boundaries, so that the Host Service owns correctness while Pi owns message injection.
68. As an MCP-wrapper user, I want wrappers to pull pending continuous compile notifications at equivalent boundaries, so that non-Pi agents can receive the same system-info feedback.
69. As a Host Service maintainer, I want pending background notifications to be stored in the daemon and cleared on success or delivery, so that notification state follows compiler state and remains bounded.
70. As a Host Service maintainer, I want pending notification retrieval to be session-scoped, so that one agent does not receive another agent's background compile failure notification.
71. As a developer, I want tests proving pending background failures are cleared by later success before delivery, so that stale errors are not injected.
72. As a developer, I want tests proving delivered pending notifications are cleared, so that agents do not receive duplicate system-info messages.

## Implementation Decisions

- Add an optional `continuous` boolean to the existing file compile tool. The flag is tri-state by presence: `true` subscribes/starts, `false` unsubscribes/stops if last subscriber, and omission leaves continuous state unchanged.
- Continuous mode requires `workspace_context.session_id`. Requests that set `continuous` to either boolean value without a non-empty session id are rejected with a clear validation error. One-shot compile requests without the flag remain compatible with existing callers.
- Continuous compilation is a Host Service responsibility. The Host Service owns background compiler processes, session subscriptions, heartbeat state, pending background failure notifications, and cleanup behavior.
- Use `latexmk` as the only LaTeX file compilation backend. One-shot compilation runs latexmk once; continuous compilation uses `latexmk -pvc` rather than implementing recursive file watching. This delegates LaTeX-aware dependency discovery and rebuild scheduling to latexmk.
- Run latexmk with no viewer launch. Viewer behavior remains controlled by existing managed viewer operations and `open_pdf` semantics.
- Keep viewer lifecycle separate from continuous compiler lifecycle. Closing a PDF does not stop continuous compilation. Continuous compilation stops through `continuous=false`, heartbeat expiry, or Host Service shutdown.
- Implement a deep continuous compile manager module with a small interface for ensuring a session subscription, removing a session subscription, processing heartbeats/session expiry, querying state, collecting pending notifications, and stopping all processes. This module should encapsulate process spawning, singleton enforcement, subscriber bookkeeping, bounded output capture, notification state, and shutdown cleanup.
- Enforce one continuous compiler process per normalized root LaTeX source file. Multiple agents/sessions subscribe to the same process instead of starting duplicate latexmk processes.
- Model the relationship as N-to-1: many session subscriptions can keep one root-file continuous compiler alive.
- `continuous=true` is idempotent. If a continuous compiler is already active for the root file, the request refreshes/adds the current session subscription and reports that the compiler was already active rather than restarting it.
- `continuous=false` removes only the current session subscription. If other live subscribers remain, the compiler continues running and the response indicates it remains active for other subscribers.
- Heartbeat state is keyed by session id. The Host Service tracks last-seen time and prunes expired sessions on an interval and/or opportunistically during related requests.
- Agents/wrappers send automatic heartbeats while alive. The heartbeat is a Host Service protocol operation rather than a user-facing manual tool.
- Heartbeat expiry removes the expired session from all continuous compile subscriptions and pending notification state. Any continuous compiler with zero remaining subscribers is stopped.
- Host Service shutdown stops every continuous compiler process before completing shutdown.
- File compilation checks for latexmk availability. If unavailable, any `compile_latex_file` request fails with a clear dependency error and installation guidance.
- The immediate latexmk-backed compile remains part of every compile tool call regardless of continuous flag value. The flag changes only the continuous subscription state and result metadata.
- Compile responses gain continuous metadata describing whether the request started a process, found one already active, deactivated the current session, left a process active for other subscribers, stopped the process, or failed to change continuous state.
- Existing compile diagnostics and artifact reporting remain authoritative for the immediate compile portion of the request.
- The selected compiler option must be mapped into an appropriate latexmk engine configuration for both one-shot and continuous compile paths. `lualatex`, `pdflatex`, and `xelatex` select the corresponding latexmk engine behavior. If the selected compiler is `latexmk`, the Host Service uses its default hardened latexmk-backed behavior.
- The latexmk polling interval can be tuned with latexmk startup configuration if needed, but fast edits should primarily be controlled by the singleton process guarantee and latexmk's serialized rebuild behavior.
- Background `latexmk -pvc` output is monitored by the Host Service. When a background compile fails and does not produce or update the PDF, the Host Service records a pending system-info notification for each live subscribed session.
- Pending background failure notifications are ephemeral and replaceable. For each session and root source, there is at most one pending failure notification. A newer unresolved failure replaces the older one.
- A later successful background compile clears pending failure notifications for that root source before delivery. Agents should not see stale failure notifications after the document has successfully recompiled.
- Delivery of pending background failure notifications is pull-based. Pi and other wrappers ask the Host Service for pending notifications at agent boundaries, and the Host Service returns and clears the notifications for that session.
- Pending notification retrieval is session-scoped and must not expose another session's notifications.
- Pending notifications should be formatted for wrapper injection as `[system info]` content, including the root source, PDF path, log path, error summary, diagnostics when available, and enough context to resemble synchronous compile failure output.
- Pi owns injection into the agent conversation; the Host Service owns notification correctness, clearing, and session scoping. If equivalent wrapper boundary hooks exist for other clients, they should use the same pending-notification operation.
- Host Service protocol validation, MCP tool schema generation, direct Host Service client requests, and Pi tool registration all need to understand the new flag and response metadata.
- Add a Host Service operation for retrieving pending session-scoped continuous compile notifications. This operation is intended for wrappers, not as a manual user-facing tool.
- Pi extension lifecycle should start/stop automatic heartbeat behavior alongside existing session lifecycle behavior and should pull pending notifications at available agent boundaries.
- MCP relay behavior should inject workspace context as today and also maintain heartbeat behavior so daemon-side subscriptions can detect live clients. Where the relay has an agent boundary equivalent, it should retrieve and surface pending system-info notifications.
- Documentation should teach users to stop continuous compilation with `continuous=false`, not by closing a PDF viewer.

## Testing Decisions

- Tests should focus on externally observable behavior: protocol validation, process lifecycle effects, subscription counts/status metadata, heartbeat expiry outcomes, pending notification delivery/clearing, and tool/system-info response text/details. Tests should not assert private implementation details such as internal map names.
- The continuous compile manager should have focused unit tests with fake process spawning/time control where possible. Good tests cover singleton process creation, idempotent subscribe, unsubscribe with remaining subscribers, unsubscribe as last subscriber, heartbeat expiry pruning, process exit handling, bounded output capture, pending failure creation, success-based pending failure clearing, delivery-based clearing, and stop-all cleanup.
- Host Service integration tests should verify that compile requests with `continuous=true` and valid session ids start or reuse a continuous compiler after the immediate compile succeeds.
- Host Service integration tests should verify that compile requests with `continuous=false` remove only the current session subscription and stop the compiler only when no subscribers remain.
- Host Service integration tests should verify that continuous requests without a session id are rejected while ordinary one-shot compile requests remain allowed without a session id.
- Host Service integration tests should verify that missing latexmk produces a clear file-compilation dependency failure for both one-shot and continuous requests.
- Host Service lifecycle tests should verify that daemon shutdown terminates active continuous compiler processes.
- Heartbeat tests should verify that a live heartbeat keeps subscribed compilers alive and an expired heartbeat removes subscriptions and stops unreferenced compilers.
- Pending notification tests should verify that a background failure without a fresh PDF creates a session-scoped pending `[system info]` notification.
- Pending notification tests should verify that a later successful background compile clears pending failure notifications before a wrapper retrieves them.
- Pending notification tests should verify that retrieving pending notifications clears delivered notifications and does not redeliver duplicates.
- Pending notification tests should verify that one session cannot retrieve another session's pending notification.
- Pending notification tests should verify that repeated background failures for the same session/source replace the prior pending failure rather than accumulating unbounded notifications.
- MCP tests should verify the tool schema exposes `continuous`, request parsing accepts boolean values, malformed values are rejected, selected compilers are mapped through latexmk, and continuous metadata is passed through in successful responses.
- MCP or Host Service protocol tests should verify pending notification retrieval request/response validation and session-id requirements.
- Pi extension tests should verify the compile tool passes `continuous` through to the Host Service and renders user-facing status text for started, already-active, deactivated, and still-active-for-other-subscribers outcomes.
- Pi lifecycle/boundary tests should verify heartbeat startup/shutdown behavior and pending notification retrieval/injection at available agent boundaries without requiring real latexmk processes.
- MCP relay tests should verify workspace context/session id injection and heartbeat behavior for relay-managed clients. If boundary hooks exist, relay tests should also verify pending notification retrieval and surfacing.
- One-shot compile tests should use fake latexmk binaries, temporary Host Service instances, tool capture, managed viewer assertions, and request payload assertions.
- Existing Host Service tests are prior art for protocol validation, server lifecycle, fake viewer backends, fake compiler binaries, and shutdown cleanup.
- Existing MCP tests are prior art for tool schema validation, argument parsing, and daemon response formatting.

## Out of Scope

- Implementing a custom recursive filesystem watcher for LaTeX project files.
- Supporting continuous compilation without a session id.
- Adding a separate user-facing stop-continuous-compilation tool.
- Stopping continuous compilation when a PDF viewer is closed.
- Supporting LaTeX file compilation without latexmk.
- Persisting continuous compiler sessions across Host Service restarts.
- Supporting multiple simultaneous continuous compiler processes for the same normalized root source file.
- Exposing heartbeat as a manual user tool for agents to call directly.
- Exposing pending notification retrieval as a manual user-facing tool.
- Building a full process dashboard or UI for continuous compiler management.
- Guaranteeing that latexmk coalesces every burst of rapid edits into exactly one rebuild. The guarantee is that the Host Service starts only one latexmk monitor process per root file and latexmk serializes rebuilds.
- Delivering stale background failure notifications after a later successful background compile.
- Pushing asynchronous background compiler errors directly into the middle of an active agent turn.

## Further Notes

- `latexmk` is a required dependency for LaTeX file compilation. It is not provided by macOS itself, but is normally included with MacTeX or TeX Live. BasicTeX users may need to install it separately.
- All file compile requests should produce clear installation guidance when latexmk is missing.
- `latexmk -pvc` monitors source files and dependencies at intervals. The Host Service should rely on latexmk for LaTeX dependency tracking rather than attempting to infer project structure itself.
- The Host Service remains the primary owner of core logic, active runtime state, callback routing, viewer operations, continuous compiler lifecycle, and pending background notification state.
- Pi and other wrappers own presentation and agent-message injection. They should ask the Host Service for pending session-scoped notifications at agent boundaries and inject unresolved failures as `[system info]`.
- The design intentionally standardizes file compilation on latexmk. It preserves the compile tool interface while making continuous compilation an explicit opt-in lifecycle controlled by the compile tool flag.


# HITL #78 — Continuous LaTeX compilation smoke

Date: 2026-06-08
Branch: `issue-78-hitl-smoke`
Source issue: [#78](https://github.com/FrederickAlt/agent-synctex/issues/78)
Parent PRD: [`docs/prd-continuous-latex-compilation.md`](./prd-continuous-latex-compilation.md)

This note records a human-in-the-loop smoke pass for continuous LaTeX compilation against a real multi-file LaTeX project and a real `latexmk` installation. The smoke used an isolated Host Service socket and temporary project under `tmp/`.

## Environment

- Platform: `Linux frederick-B450M-S2H 6.17.0-35-generic #35-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 13:10:28 UTC 2026 x86_64 GNU/Linux`
- Node: `v22.22.2`
- npm: `10.9.7`
- `latexmk`: `/usr/bin/latexmk`, `Latexmk, John Collins, 15 June 2025. Version 4.87`
- Available TeX tools: `lualatex`, `pdflatex`, `bibtex`
- Viewer binary: `zathura` available at `/usr/bin/zathura`
- Session/display: `DISPLAY`, `WAYLAND_DISPLAY`, and `DBUS_SESSION_BUS_ADDRESS` were empty in this worktree shell, so visible desktop viewer behavior could not be confirmed here.

## Smoke harness and command

A temporary harness was used at `tmp/hitl-78-smoke.mjs` and left untracked/ignored. It started the daemon through:

```bash
node scripts/tex-actionsctl.ts daemon --socket tmp/hitl-78-smoke-*/host-service.sock
```

The harness then drove the real Host Service client APIs and Codex relay boundary path:

- `HostServiceClient.requestCompileLatexFile(... continuous: true/false ...)`
- `HostServiceClient.requestPendingNotifications(...)`
- `scripts/tex-actions-mcp.ts` with `TEX_ACTIONS_HOST_SERVICE_SOCKET_PATH` and `TEX_ACTIONS_AGENT_ID` set, to exercise wrapper-side pending `[system info]` injection before a client request boundary.

The temporary LaTeX project contained:

- `main.tex` root document
- `sections/intro.tex` included via `\input{sections/intro}`
- `refs.bib` bibliography, cited from the root document

Final harness command:

```bash
node tmp/hitl-78-smoke.mjs
```

The final run completed successfully and printed `HITL78 summary: {"ok":true,"observations":21}`.

## Results

| Acceptance criterion | Result | Evidence |
| --- | --- | --- |
| `continuous=true` starts continuous compilation | Pass | First compile returned `continuous.status="started"` with daemon-owned `latexmk` pid `26846`. |
| Editing included file triggers rebuild without manual compile tool re-run | Pass | Editing `sections/intro.tex` produced a newer `main.pdf` containing `Included rebuild token 1780949590050`. |
| Bibliography dependency is followed | Pass | Editing `refs.bib` produced a newer `main.pdf` containing `The TeXbook HITL 1780949592268`. |
| Repeated `continuous=true` does not duplicate compiler process | Pass | Repeat compile returned `continuous.status="already_active"` with the same pid `26846`; process table showed exactly one daemon-owned `latexmk -pvc` child. |
| `continuous=false` stops compiler when final subscriber | Pass | First two unsubscribe calls reported `still_active_for_other_subscribers`; final unsubscribe reported `continuous.status="stopped"`, `subscriber_count=0`, pid `26846`; process table then showed no daemon-owned `latexmk`. |
| Closing a PDF viewer does not stop continuous compilation | Pass in desktop HITL | The #78 headless smoke kept `open_pdf=false`; the #82 desktop viewer-close HITL below confirmed a visible Host Service-managed viewer could be manually closed while continuous rebuilds continued. |
| Unresolved LaTeX error creates pending `[system info]` at next boundary | Pass | Introducing `\undefinedhitlsmoke` queued one pending notification whose message started with `[system info] Background continuous LaTeX compilation failed...`. |
| Fixing error before boundary clears stale pending failure | Pass | A second subscribed session had a pending failure queued; after fixing the source and waiting for successful background rebuild, `requestPendingNotifications` returned `delivered_count=0` for that session. |
| Boundary path injects pending `[system info]` | Pass | With a fresh unresolved error, `scripts/tex-actions-mcp.ts` emitted a `notifications/message` containing `[system info] Background continuous LaTeX compilation failed` before returning the `tools/list` response. |

## Notable output

Continuous startup and singleton check:

```text
HITL78 continuous_true_started: {"requested":true,"status":"started",...,"subscriber_count":1,"pid":26846}
HITL78 continuous_true_repeated: {"requested":true,"status":"already_active",...,"subscriber_count":1,"pid":26846}
HITL78 latexmk_processes_after_repeat: [{"pid":26846,"ppid":26834,"comm":"latexmk","args":"/usr/bin/perl /usr/bin/latexmk -pvc -norc -view=none -recorder -synctex=1 -interaction=nonstopmode -halt-on-error -file-line-error -pdf -lualatex -pdflualatex=lualatex -no-shell-escape %O %S main.tex"}]
```

Failure notification summary:

```text
./sections/intro.tex:1: Undefined control sequence.
l.1 ...d failure before boundary.\undefinedhitlsmoke
./sections/intro.tex:1:  ==> Fatal error occurred, no output PDF file produced!
```

Stop behavior:

```text
HITL78 continuous_false_primary: {"requested":true,"status":"still_active_for_other_subscribers",...,"subscriber_count":2,"pid":26846}
HITL78 continuous_false_stale: {"requested":true,"status":"still_active_for_other_subscribers",...,"subscriber_count":1,"pid":26846}
HITL78 continuous_false_final: {"requested":true,"status":"stopped",...,"subscriber_count":0,"pid":26846}
HITL78 latexmk_processes_after_stop: []
```

## Desktop viewer-close HITL (#82)

Date: 2026-06-09
Runtime project: `/tmp/continuous-hitl-82-8170/main.tex`

This follow-up HITL used a real desktop session and visible PDF viewer through the Host Service. It specifically covered the manual viewer-close behavior that the #78 headless smoke could not exercise.

| Step | Result | Evidence |
| --- | --- | --- |
| Start continuous compilation with viewer opening | Pass | `compile_latex_file` was invoked with `compiler=latexmk`, `open_pdf=true`, and `continuous=true`. The tool returned `ok_with_warnings`, `pdf_id=55509044`, PDF `/tmp/continuous-hitl-82-8170/main.pdf`, and `continuous.status="started"` with `pid=18401` for root `/tmp/continuous-hitl-82-8170/main.tex`. |
| Confirm visible Host Service-managed viewer | Pass | Human confirmed the PDF viewer opened visibly from the Host Service-managed `open_pdf=true` compile result. |
| Human closes visible viewer | Pass | After manual close, `close_pdf(pdf_id=55509044)` returned `closed=false reason=not_running`, consistent with the viewer already having been manually closed. |
| Continuous compiler remains active after viewer close | Pass | Editing included `section.tex` triggered a rebuild without another compile call: `main.pdf` mtime changed from `1780987396` to `1780987411` after about 3 seconds. This verifies viewer close did not stop continuous compilation. |
| Explicit stop with `continuous=false` | Pass with noted tool discrepancy | `compile_latex_file(..., open_pdf=false, continuous=false)` was invoked. The tool returned `failed_stale_pdf_exists` even though its log excerpt said `Output written on main.pdf`; this was recorded as a discrepancy. The stop appeared effective because a later edit to `section.tex` did not change PDF mtime over 6 seconds (`1780987411` stayed unchanged). |
| Cleanup | Pass | No matching `latexmk` or viewer processes were observed after cleanup. |

This desktop HITL bases the continuous-after-close result on the observed rebuild after manually closing the viewer, and bases the stop result on the lack of rebuild after `continuous=false` plus the final process check.

## Discrepancies and limitations

- The original #78 headless smoke shell had no display/session bus, so that run could not open and visibly close a real `zathura` window. The #82 desktop HITL above covers this gap.
- In the #82 desktop stop path, `compile_latex_file(... continuous=false ...)` returned `failed_stale_pdf_exists` even though the log excerpt said `Output written on main.pdf`; the stop nevertheless appeared effective from the unchanged PDF mtime after a later edit and the final process check.
- The daemon printed `ENOENT: no such file or directory, chmod '.../host-service.sock'` on isolated socket startup, but then accepted status and all subsequent Host Service requests. The smoke did not investigate this startup diagnostic because it did not block the acceptance criteria exercised here.
- The closest available agent-boundary path in the #78 smoke was the Codex MCP relay (`scripts/tex-actions-mcp.ts`), not a live Pi UI session. The relay did verify pending system-info retrieval and wrapper emission at a request boundary.

## Cleanup

The harness explicitly unsubscribed all continuous sessions with `continuous=false`, then terminated the isolated Host Service. A post-run process-table check found no remaining `latexmk`, `tex-actionsctl`, `tex-actions-mcp`, or `hitl-78-smoke` processes.

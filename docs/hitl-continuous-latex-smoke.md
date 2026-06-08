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
| Closing a PDF viewer does not stop continuous compilation | Not fully exercised headlessly | No graphical session was available. The smoke kept `open_pdf=false`; compiler lifecycle was verified to be controlled by subscriptions, not viewer operations. Manual desktop confirmation is still needed for visible close behavior. |
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

## Discrepancies and limitations

- Viewer close behavior still needs manual desktop confirmation. The shell had no display/session bus, so opening and visibly closing a real `zathura` window was not feasible from this environment.
- The daemon printed `ENOENT: no such file or directory, chmod '.../host-service.sock'` on isolated socket startup, but then accepted status and all subsequent Host Service requests. The smoke did not investigate this startup diagnostic because it did not block the acceptance criteria exercised here.
- The closest available agent-boundary path was the Codex MCP relay (`scripts/tex-actions-mcp.ts`), not a live Pi UI session. The relay did verify pending system-info retrieval and wrapper emission at a request boundary.

## Cleanup

The harness explicitly unsubscribed all continuous sessions with `continuous=false`, then terminated the isolated Host Service. A post-run process-table check found no remaining `latexmk`, `tex-actionsctl`, `tex-actions-mcp`, or `hitl-78-smoke` processes.

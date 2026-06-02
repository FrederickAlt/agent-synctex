# HITL #71 — TeX Actions daemon service and MCP runtime validation

Date: 2026-06-02
Branch: `issue-71-docs-hitl`
Source issue: [#71](https://github.com/FrederickAlt/agent-synctex/issues/71)

This note captures human-in-the-loop desktop checks for the `tex-actions` daemon-first runtime after #66+#70 and records caveats for docs.

## 1) Service lifecycle and control plane

Validated through the user-installed service unit `show-latex.service` and socket at `${XDG_RUNTIME_DIR}/tex-actions/host-service.sock`:

- `systemctl --user restart show-latex.service` (runtime restart)
- `pdf-preview-servicectl sync`
- `pdf-preview-servicectl restart`
- `pdf-preview-servicectl status`
- `npm run tex-actionsctl -- doctor` (sandboxed run; desktop GUI checks remain unavailable in sandbox)
- `npm run tex-actionsctl -- setup` was not rerun in this pass because service ownership is already established as `show-latex.service`.

Observed:
- Host service status showed the active unit as `show-latex.service`.
- Reported service/runtime identity was `tex-actions-host-service` on socket `${XDG_RUNTIME_DIR}/tex-actions/host-service.sock`.
- The broker remains a narrow maintenance path and did not require any alternative service name.

## 2) Runtime CLI checks

Executed from the session sandbox:

```bash
npm run tex-actionsctl -- doctor
```

Observed status:

- `daemon`, `mcp`, and `viewer`/`syncTeX` checks: **OK**
- GUI/session availability: **not available in sandbox env** (expected in this mode)
- Optional compiler check: `xelatex` missing (documented as optional)

This aligns with current docs: GUI/session checks should be run from a real desktop context.

## 3) MCP tool path smoke checks

### Inline/External preview

Used `show_latex` via Pi with external preview:

- External (`inline=false`) `show_latex` smoke succeeded for content containing
  `TeX Actions HITL smoke for issue 71`.

### Compile + open

- Compiled and opened a test document at `tmp/hitl-71/main.pdf`.
- Service returned `pdf_id=19531440`.

### Re-open existing PDF path

- Invoking open on `tmp/hitl-71/main.pdf` reused the same daemon `pdf_id=19531440`.

### Forward SyncTeX

- `jump_pdf(..., line=?, source=...)` targeting **Forward SyncTeX Target B** succeeded by tool call.
- Human confirmed visible jump in viewer.

### Inverse SyncTeX

- User-visible click in viewer produced callback paste:

```text
PDF click: tmp/hitl-71/main.tex:13
The viewer should jump here for target B. Please click this text for inverse SyncTeX if requested.
```

### Close behavior

- Managed close request returned
  `ok: ... closed_pids=none`.
- Full close visual confirmation was still pending at time of note capture; this should be confirmed in a follow-up desktop session.

## 4) Caveats and residual risk

- Desktop GUI/session assertions from `tex-actionsctl doctor` are expectedly incomplete in the sandbox; they should be interpreted as service/daemon diagnostics only.
- `close_pdf` returned `closed_pids=none`, so viewer termination success was confirmed by protocol response but not independently visually.
- No regressions were observed for path handling, jump, or callback behavior in this pass.

## 5) Out-of-scope confirmation

As required for this phase, no Codex relay implementation was added or validated here. If/when added, it should target the same daemon MCP endpoint (`tex-actions-host-service`) rather than adding a parallel relay path.
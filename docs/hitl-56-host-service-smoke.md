# HITL #56 Host Service Pi frontend and Zathura backend smoke

Date: 2026-06-01
Branch: `mcp_centered_impl`
Commit: `c78e511` plus HITL runtime checks after #55/docs freshness merge.

## Preflight

- `npm run verify` passed: 299/299 tests.
- TypeScript Host Service started as foreground npm command in the background for HITL:
  - socket: `/run/user/1000/agent-synctex/host-service.sock`
  - backend: `zathura`
  - capabilities: open/close/forward_search/inverse_search/reuse all true

## Results

- Pi inline `show_latex` rendered correctly. Human confirmed visible inline formula; approximate runtime 3s after tool reload.
- Pi external `show_latex(inline=false)` opened a Zathura/PDF window through the Host Service. Human confirmed the window opened.
- `compile_latex_file(open_pdf=true)` opened through the Host Service and returned PDF ID `14411217`. Human confirmed the Zathura window opened.
- `jump_pdf` using Host-Service PDF ID `14411217` forward-searched to lines 7 and 8 of `hitl-host-service-smoke.tex`. Human confirmed Zathura registered the jump/marked the formula region; marking was imprecise but consistent with known Zathura SyncTeX behavior.
- Inverse SyncTeX click from Zathura routed through Host Service/Pi callback and inserted source information without auto-submitting:

  ```text
  PDF click: hitl-host-service-smoke.tex:11
  This is line content for SyncTeX jump validation.
  ```

- `close_pdf(14411217)` closed only the managed `hitl-host-service-smoke.pdf` window. Human confirmed the other external snippet window remained open.
- Host Service restart invalidated old IDs. After restart, `close_pdf(14411217)` failed as unknown/untracked.
- Multiple managed opens after restart returned distinct random Host-Service IDs:
  - `74004960` for `hitl-host-service-smoke.pdf`
  - `43759408` for `hitl-host-service-smoke-2.pdf`
  Human confirmed both windows opened; both were closed via `close_pdf`.

## Observations / follow-up

- `npm run host-service:start` is a foreground command that must be run in a separate terminal/background job for HITL. Documentation was updated before this smoke.
- Host-Service-launched Zathura did not use the user's usual theme. This suggests environment/config inheritance differs from a normal desktop launch. It did not block open/jump/inverse/close behavior, but may deserve a follow-up if theme/config parity is required.
- First inline render took a few seconds; no blocker recorded.

## Conclusion

HITL acceptance criteria for #56 passed. No blocking follow-up issues were identified.

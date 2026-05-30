# AGENTS

Before changing any preview rendering, refresh policy, or Kitty placeholder logic in this repo, read:

- docs/testing-preview-framework.md

Use this guide when touching:
- `inline_preview_renderer.ts`
- `kitty_placeholder_oracle.ts`
- `terminal_refresh_policy.ts`
- `kitty_placeholder_image.ts`
- preview-related tests in `index_rendering.test.ts`, `inline_preview_renderer.test.ts`, `kitty_placeholder_image.test.ts`, `kitty_placeholder_oracle.test.ts`

## Viewer service broker guardrail

This project may expose a project-local host broker via `pdf-preview-servicectl` and
`${HOME}/.cache/pdf-preview-servicectl/broker.sock` so agents in this repo can sync/restart/status/log
`codex-show-latex-viewer.service` without raw access to the user session D-Bus. Treat this as a narrow,
privileged escape hatch. Do not use it for anything except maintaining/testing the PDF preview viewer service
that supports PDF open, close, and SyncTeX/forward-search operations. Do not repurpose the broker, broaden its
permissions, or use it for arbitrary host commands.

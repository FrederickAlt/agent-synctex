# AGENTS

## Test environment setup

Fresh git worktrees do not include `node_modules`. Before treating test failures as environment/sandbox problems, install dependencies and rerun verification:

```bash
npm ci || npm install
npm run verify
```

If `npm run verify` fails with `tsc: not found` or `ERR_MODULE_NOT_FOUND: typescript`, the worktree dependencies are incomplete; run the install command above and retry.

Before changing any preview rendering, refresh policy, or Kitty placeholder logic in this repo, read:

- docs/testing-preview-framework.md

After the Pi adapter/module refactors (#25-36), keep index.ts as a composition root:
- `src/modules/pi_adapter/pi_adapter.ts` should remain the thin Pi dispatch adapter.
- viewer protocol orchestration for normal tool flows belongs in `src/modules/host_service.ts` with backend adapters in `src/modules/host_service_viewer_backends.ts`.
- avoid reintroducing direct viewer-command spawning in production TypeScript; use `viewer_guardrails.test.ts` as the regression check (host-service adapters may intentionally spawn GUI processes).

Use this guide when touching:
- `src/modules/preview/inline_preview_renderer.ts`
- `src/modules/preview/kitty_placeholder_oracle.ts`
- `src/modules/preview/terminal_refresh_policy.ts`
- `src/modules/preview/kitty_placeholder_image.ts`
- preview-related tests in `test/modules/preview/index_rendering.test.ts`, `test/modules/preview/inline_preview_renderer.test.ts`, `test/modules/preview/kitty_placeholder_image.test.ts`, `test/modules/preview/kitty_placeholder_oracle.test.ts`

## Viewer service broker guardrail

This project may expose a project-local host broker via `pdf-preview-servicectl` and
`${HOME}/.cache/pdf-preview-servicectl/broker.sock` so agents in this repo can sync/restart/status/log
the host-service helper artifacts without raw access to the user session D-Bus. Treat this as a narrow,
privileged escape hatch. Do not use it for anything except maintaining/testing the PDF host service that
supports PDF open, close, and SyncTeX/forward-search operations. Do not repurpose the broker, broaden its
permissions, or use it for arbitrary host commands.

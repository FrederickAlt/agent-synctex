# Host-Service broker migration audit notes (Issue #55)

This file captures the parts of the migration that remain outside this repo and the exact checks we can still run from this repo to keep it auditable.

## Scope and trust boundary

Issue #55 replaces callback-command/Python viewer tooling with the TypeScript Host Service.
This repository now assumes the following host broker and environment files are maintained by the user-side installation and are not tracked here:

- `~/.local/bin/pdf-preview-servicectl-broker`
- `~/.config/systemd/user/pdf-preview-servicectl-broker.service`
- `~/.config/firejail/pi-jail.profile`
- `~/.local/bin/pi-jail` (sets `MCP_TMPDIR`)

This repo can still verify that those externals target the expected service contract:
`show-latex.service` + TypeScript Host Service + `zathura` backend.

## Expected service contract

- **Unit/service name:** `show-latex.service`
- **Repo unit source:** `systemd/show-latex.service`
- **Host service executable contract:** TypeScript Host Service, service name `agent-synctex-host-service`
  - started from `scripts/agent-synctex-host-service.ts`
  - default viewer backend reported as `zathura`

## Expected runtime/socket directories

- Host service socket: `${XDG_RUNTIME_DIR}/agent-synctex/host-service.sock`
- Host service artifacts/logs: `${XDG_RUNTIME_DIR}/show-latex`
- Inline artifacts: `${XDG_RUNTIME_DIR}/show-latex/inline`
- External broker cache socket: `${HOME}/.cache/pdf-preview-servicectl/broker.sock`

## Concrete verification commands

### 1) `pdf-preview-servicectl status`

Expected to confirm the broker is managing the host daemon and not the legacy Python path. At minimum, the output should reference:

- `show-latex.service`
- "TypeScript Host Service" (or equivalent wording)
- `agent-synctex-host-service`

### 2) `systemctl` host unit checks

Use `status` for active/loaded state:

```bash
systemctl --user status show-latex.service
```

Expected host daemon status shape:

- `Loaded: loaded` for `show-latex.service`
- `Active: active (running)`
- no stale/legacy Python viewer-command process ownership in the host-service path

Use `show` or `cat` for the exact `ExecStart` assertion, because `status` output is not guaranteed to include it:

```bash
systemctl --user show -p ExecStart show-latex.service
systemctl --user cat show-latex.service
```

Expected unit definition includes `ExecStart=.../agent-synctex-host-service.ts start`.

### 3) `journalctl --user -u show-latex.service`

Expected logs should include currently emitted TypeScript host-service startup/status/error signals, such as `agent-synctex-host-service: started at ...` or `agent-synctex host service running on ...`, and should not be tied to the old Python viewer service. Do not require open/close/jump lifecycle lines unless host-service code is updated to emit them.

### 4) `npm run host-service:status` (executed in Firejail context)

Expected JSON payload includes at least:

```json
{
  "service_available": true,
  "service_name": "agent-synctex-host-service",
  "viewer_backend_name": "zathura"
}
```

`service_available: true` is the key signal that the in-sandbox request path can talk to the host daemon.

## Suggested closing comment for GitHub issue #55

> Issue #55 is ready for closure from a docs/audit standpoint: I have added explicit host-service broker verification notes for the externalized migration (`docs/host-service-broker.md`), including expected service names, expected external files, runtime directories, and concrete verification commands.
>
> Closure evidence is captured in `docs/hitl-56-host-service-smoke.md`: the external broker now targets `show-latex.service`; Firejail `npm run host-service:status` reaches the TypeScript Host Service and reports `service_available: true`, `service_name: agent-synctex-host-service`, and `viewer_backend_name: zathura`; external open, jump, inverse SyncTeX, and close HITL flows passed; and the old Python viewer service is no longer the normal runtime path.
>
> Verification status: `<fill in npm run verify / relevant check result before posting>`.
>
> No code changes were made here, as host-path and migration files are external by design; only repository-side documentation and auditability were updated.

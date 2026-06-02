# Host-Service broker migration notes (Issue #55, updated after #66)

This file captures the parts of the migration that remain outside this repo and the exact checks this repo can still run.

## Scope and trust boundary

Issue #55 replaced callback-command/Python viewer tooling with the TypeScript Host Service.
Issue #66 and post-#66 runtime now run the TeX Actions host service end-to-end from this repo's unit definition.

This repository assumes the following host broker and environment files are maintained by the user-side installation and are not tracked here:

- `~/.local/bin/pdf-preview-servicectl-broker`
- `~/.config/systemd/user/pdf-preview-servicectl-broker.service`
- `~/.config/firejail/pi-jail.profile`
- `~/.local/bin/pi-jail` (sets `MCP_TMPDIR`)

This repo can still verify that those externals target the expected service contract:
`show-latex.service` + TypeScript Host Service + `zathura` backend.

## Expected service contract

- **Unit/service name:** `show-latex.service`
- **Repo unit source:** `systemd/show-latex.service`
- **Host service executable contract:** TypeScript Host Service, service name `tex-actions-host-service`
  - started from `scripts/tex-actionsctl.ts daemon`
  - default viewer backend reported as `zathura`

## Expected runtime/socket directories

- Host service socket: `${XDG_RUNTIME_DIR}/tex-actions/host-service.sock`
- Host service artifacts/logs: `${XDG_RUNTIME_DIR}/tex-actions`
- Inline artifacts: `${XDG_RUNTIME_DIR}/tex-actions/inline`
- External broker cache socket: `${HOME}/.cache/pdf-preview-servicectl/broker.sock`

The runtime now has no legacy socket fallback path.

## Concrete verification commands

### 1) `pdf-preview-servicectl status`

Expected to confirm the broker is managing the host daemon and not a legacy Python path. At minimum, the output should reference:

- `show-latex.service`
- `tex-actions-host-service`
- `TypeScript Host Service` (or equivalent wording)
- no stale `agent-synctex` service name in normal output

Useful maintenance commands are:

```bash
pdf-preview-servicectl sync
pdf-preview-servicectl restart
pdf-preview-servicectl status
pdf-preview-servicectl logs
```

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

Expected unit definition includes `ExecStart=.../scripts/tex-actionsctl.ts daemon` (or equivalent wrapper path) and shows `NoNewPrivileges=true` behavior.

### 3) `journalctl --user -u show-latex.service -n 100 --no-pager`

Expected logs should include currently emitted TypeScript host-service startup/status/error signals, such as `tex-actions daemon: started at ...` or `TeX Actions host service running on ...`, and should not be tied to the old Python viewer service.

### 4) `npm run host-service:status` (executed in Firejail context)

Expected JSON payload includes at least:

```json
{
  "service_available": true,
  "service_name": "tex-actions-host-service",
  "viewer_backend_name": "zathura"
}
```

`service_available: true` is the key signal that the in-sandbox request path can talk to the host daemon.

## Historical evidence retained

Older legacy command/output examples from Issue #56 are still useful but may not reflect current runtime names. Keep them in `docs/hitl-56-host-service-smoke.md` as historical notes, especially around
legacy smoke traces and shim naming.

## Suggested closing comment for GitHub issue tracking

> Issue #55/#56 migration notes are current through #66 for runtime naming: the repository docs, service contract, and broker verification paths are now aligned with the `tex-actions` runtime identity and `tex-actions-host-service` service name. This file keeps stale legacy references only in clearly labeled historical notes.

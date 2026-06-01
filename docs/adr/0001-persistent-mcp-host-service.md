# ADR 0001: Persistent Host Service owns pdf-preview core state

## Status

Accepted

## Context

This ADR records the migration from a Pi-extension-first architecture to an agent-agnostic Host Service. The previous architecture kept most core behavior in the Pi extension and used a narrow viewer-service daemon as the unsandboxed GUI broker.

The architecture now serves multiple MCP-capable agents and multiple viewer backends while keeping viewer state, PDF IDs, callbacks, artifacts, and close behavior consistent.

## Decision

The Host Service is a long-running local daemon and the primary owner of pdf-preview core state.

It owns active PDF IDs, viewer backend adapters, viewer metadata, artifact/session state, callback routing, and backend operations for `show_latex`, `compile_latex_file`, `open_pdf`, `jump_pdf`, and `close_pdf`. It communicates over a local Unix socket.

Active PDF IDs and viewer metadata are runtime state kept in memory only. They do not survive daemon restart. Disk artifacts may remain available after restart, but active PDF IDs must be recreated by reopening PDFs.

Pi and other clients act as frontends to this service. Pi may preserve richer frontend behavior such as inline presentation and editor paste integration, but it does not own the core PDF/viewer state. Pi can register callback targets with the Host Service for inverse SyncTeX editor insertion.

## Consequences

- Normal host daemon execution is expected as a user-systemd unit `show-latex.service` (via `systemd/show-latex.service`), with `npm run host-service:start` reserved for foreground debug.
- PDF IDs can remain valid across individual tool calls and client interactions until service restart or close.
- Multiple agents can use the same host service while receiving distinct random active PDF IDs.
- Viewer open, jump, close, and callback routing are centralized.
- The previous narrow viewer-service role has been absorbed into the MCP host service; only legacy compatibility paths remain.
- The service needs lifecycle, restart, cleanup, state validation, and stale-handle handling.
- The service is a trusted local host integration process and must expose only narrow, validated operations.

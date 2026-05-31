# ADR 0001: Persistent Host Service owns pdf-preview core state

## Status

Accepted

## Context

pdf-preview is moving from a Pi-extension-first architecture toward an agent-agnostic host service. The previous architecture kept most core behavior in the Pi extension and used a narrow viewer-service daemon as the unsandboxed GUI broker.

The new target architecture needs to support multiple MCP-capable agents and multiple viewer backends while keeping viewer state, PDF IDs, callbacks, artifacts, and close behavior consistent.

## Decision

The Host Service will be a long-running local daemon and the primary owner of pdf-preview core state.

It will own active PDF IDs, viewer backend adapters, viewer metadata, artifact/session state, callback routing, and core LaTeX/PDF operations. It should communicate over a local Unix socket unless a future portability constraint requires another transport.

Active PDF IDs and viewer metadata are runtime state kept in memory only. They do not survive daemon restart. Disk artifacts may remain available after restart, but active PDF IDs must be recreated by reopening PDFs.

Pi and other clients will act as frontends to this service. Pi may preserve richer frontend behavior such as inline presentation and editor paste integration, but it should not own the core PDF/viewer state. Pi can register callback targets with the Host Service for inverse SyncTeX editor insertion.

## Consequences

- PDF IDs can remain valid across individual tool calls and client interactions until service restart or close.
- Multiple agents can use the same host service while receiving distinct random active PDF IDs.
- Viewer open, jump, close, and callback routing are centralized.
- The previous narrow viewer-service role is absorbed into the MCP host service unless a future security or deployment constraint requires a split.
- The service needs lifecycle, restart, cleanup, state validation, and stale-handle handling.
- The service is a trusted local host integration process and must expose only narrow, validated operations.

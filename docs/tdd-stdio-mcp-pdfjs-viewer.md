# TDD Plan: Stdio MCP PDF.js Viewer and SyncTeX Runtime

## Purpose

This document defines the test-first implementation sequence for `docs/prd-stdio-mcp-pdfjs-viewer.md`.

The refactor removes persistent host-service/Zathura/inline/continuous machinery and replaces it with a stdio MCP runtime that owns a browser-hosted PDF.js viewer server. Because the change cuts across runtime lifecycle, tool schemas, viewer communication, file-change polling, preamble behavior, and SyncTeX, implementation should proceed in small red-green-refactor slices.

## Test strategy

Use Node's built-in test runner and repository conventions:

```bash
npm run check
npm test
npm run verify
```

Prefer targeted tests while developing each slice, then run full verification after each architectural milestone.

Tests should use fakes for:

- LaTeX compiler / `latexmk`;
- browser launcher;
- viewer WebSocket clients;
- filesystem fixtures for PDFs, TeX files, preamble files, and SyncTeX sidecars;
- file-change polling timers where practical.

Manual browser smoke tests come after automated coverage exists.

## Core success criteria

- MCP server runs directly over stdio; no daemon/socket relay is required.
- Tool schemas expose no `inline` and no `continuous` fields.
- Relative tool paths resolve against the MCP process launch cwd.
- Snippet preamble behavior is seeded from launch-cwd `preamble.tex`/`praeamble.tex` and remains settable via tool.
- `show_latex` always creates a temporary document and opens/returns a viewer URL.
- `compile_latex_file` is one-shot only.
- PDF.js viewer communication is HTTP/WebSocket based.
- Tracked PDFs are polled for file changes and connected viewers receive `pdf_refresh`.
- Forward SyncTeX sends a viewer `synctex` message.
- Reverse SyncTeX clicks are stored and fetched with `get_pdf_events(max_events=N)`.
- HTTP PDF serving is restricted to registered `pdf_id`s.
- Guardrails prevent reintroducing Zathura, persistent host service, systemd, inline raster rendering, and continuous compilation.

## Existing implementation references

Reference repo root: `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop`.

- Phase 0-1 MCP entry/framing references in current repo: `scripts/tex-actions-mcp.ts`, `src/modules/codex_mcp/codex_mcp_server.ts`, `src/modules/host_service_mcp.ts`.
- Phase 2 workspace/preamble references in current repo: `src/modules/agent_runtime_context.ts`, `src/modules/runtime_preamble.ts`, `src/modules/latex/latex_preamble.ts`.
- Phase 4 compiler references in current repo: `src/modules/latex/latex_file_compiler.ts`, `src/modules/host_service_compile.ts`.
- Phase 5 SyncTeX references: `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/locate/synctex/synctexjs.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/locate/synctex/worker.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/locate/synctex.ts`.
- Phase 6 viewer references: `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/latexworkshop.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/connection.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/synctex.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/refresh.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/state.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/utils.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer/components/interface.ts`.
- Phase 7-8 HTTP/WS serving references: `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/preview/server.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/src/preview/viewer.ts`, `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/types/latex-workshop-protocol-types/index.d.ts`.
- Phase 12 guardrail references in current repo: `test/viewer_guardrails.test.ts`, `src/modules/host_service_viewer_backends.ts`, `src/modules/preview/inline_preview.ts`, `src/modules/host_service_continuous_compile.ts`.

## Phase 0: entrypoint, dependencies, and build scaffolding

### Red

Add an entrypoint smoke test, e.g. `test/scripts/tex-actions-mcp-entrypoint.test.ts`:

- launches `node scripts/tex-actions-mcp.ts` with stdio pipes;
- sends MCP `initialize` and receives a valid MCP response;
- confirms output does not include npm banners, daemon-unavailable guidance, or Unix-socket relay errors;
- confirms the process does not require the old host-service socket to exist.

Add package/build expectation tests if useful:

- package scripts expose the stdio MCP entrypoint;
- package dependencies include what the implementation uses for PDF.js/WebSocket/filename decoding;
- viewer build output or source-serving path is defined.

### Green

Replace the old relay entrypoint with the smallest direct stdio MCP process that can answer `initialize`.

Add dependencies as implementation requires, expected candidates:

- `pdfjs-dist`;
- `ws` or an equivalent WebSocket implementation;
- `iconv-lite` if preserving LaTeX-Workshop SyncTeX filename decoding.

### Refactor

Keep process startup separate from runtime services so tests can instantiate the runtime in-process later.

## Phase 1: MCP schema and stdio framing

### Red

Add tests for the new MCP server module, e.g. `test/modules/mcp/stdio_server.test.ts`:

- `initialize` returns server info for `tex-actions`.
- `tools/list` returns exactly the v1 tool set:
  - `show_latex`
  - `compile_latex_file`
  - `open_pdf`
  - `jump_pdf`
  - `get_pdf_events`
  - `close_pdf`
  - `set_latex_preamble`
- `show_latex` schema has no `inline`.
- `compile_latex_file` schema has no `continuous`.
- `get_pdf_events` requires `max_events` and optionally accepts `pdf_id`.
- unknown tool returns MCP tool error content, not a crash.
- partial Content-Length frames are parsed correctly.

These should fail against the existing daemon-relay architecture.

### Green

Implement the smallest direct stdio MCP server and tool registry needed to pass schema/framing tests. Tool handlers may initially return controlled “not implemented” tool errors.

### Refactor

Extract reusable MCP frame parsing and response helpers away from old host-service-specific modules.

## Phase 2: workspace context and runtime preamble

### Red

Add tests, e.g. `test/modules/runtime/workspace_and_preamble.test.ts`:

- relative paths resolve against the MCP launch cwd, not an arbitrary later cwd;
- absolute paths remain absolute after normalization;
- startup copies/loads `preamble.tex` from launch cwd when present;
- startup falls back to `praeamble.tex` when `preamble.tex` is absent;
- `preamble.tex` wins when both names exist;
- `set_latex_preamble` updates the active runtime preamble for subsequent snippets;
- file compilation does not inject the runtime preamble.

### Green

Implement a runtime context object that captures launch cwd and active preamble state.

### Refactor

Keep runtime context free of Pi session concepts and old workspace_context injection.

## Phase 3: PDF registry and event store

### Red

Add `test/modules/viewer/pdf_registry.test.ts`:

- registers a normalized PDF path and returns a positive `pdf_id`.
- rejects missing/non-PDF files.
- reuses or returns an existing active record for the same normalized PDF path.
- stores file snapshot and initial PDF revision.
- increments revision when explicitly updated.
- closes/untracks a record.
- fails clearly for unknown `pdf_id`.

Add `test/modules/viewer/pdf_event_store.test.ts`:

- appends events with monotonic `sequence` values.
- fetches last N events across all PDFs when only `max_events` is provided.
- fetches last N events for one `pdf_id` when `pdf_id` is provided.
- requires positive integer `max_events`.
- returns selected events in chronological order.
- reads are non-destructive.

### Green

Implement minimal in-memory registry and event store.

### Refactor

Keep registry independent from HTTP/WebSocket/server code so future standalone app integration can reuse the same model.

## Phase 4: one-shot compiler and snippet compiler

### Red

Add compiler orchestration tests with fake `latexmk`:

- `compile_latex_file` performs one-shot compile.
- `compile_latex_file` has no continuous mode and rejects unexpected `continuous` if strict validation is used.
- relative `latex_file_path` resolves against launch cwd.
- `clean=true` removes known same-basename artifacts before compile.
- `show_latex` writes a temporary `.tex` document.
- `show_latex` applies the active runtime preamble.
- `show_latex` has no `inline` behavior.
- generated snippets and file compiles request SyncTeX output where possible.

### Green

Reuse/adapt the existing one-shot LaTeX compiler core and add a small snippet compiler around it.

### Refactor

Do not bring back host-service response envelopes, managed viewer coupling, continuous compile manager, or session leases.

## Phase 5: SyncTeX parser and mapper

### Red

Add fixtures under `test/fixtures/synctex/` with small `.tex`, `.pdf`, and `.synctex`/`.synctex.gz` samples.

Add `test/modules/synctex_lw/synctex_mapper.test.ts`:

- parses `.synctex` sidecar.
- parses `.synctex.gz` sidecar.
- maps TeX line to PDF page/x/y.
- maps PDF page/x/y to TeX input/line/column.
- returns clear undefined/error for missing sidecar.
- resolves relative input records against PDF directory.
- handles realpath-equivalent source paths.
- decodes SyncTeX input filenames with the selected encoding support.

### Green

Port `synctexjs.ts` and adapt LaTeX-Workshop `worker.ts` logic to pure Node filesystem/path APIs.

### Refactor

Keep SyncTeX mapping free of MCP, viewer, and browser-launch concepts.

## Phase 6: minimal viewer client assets and protocol

### Red

Add lightweight static/TypeScript checks for `viewer/`:

- viewer TypeScript compiles with DOM libs.
- `connection.ts` handles `pdf_refresh`, `viewer_reload`, and `synctex`.
- `synctex.ts` sends `reverse_synctex` with `pdf_id`.
- viewer code can load PDF bytes by registered `pdf_id` URL.
- no VS Code APIs are imported into `viewer/`.
- no Node APIs are imported into browser viewer code.

### Green

Copy/adapt the minimal LaTeX-Workshop viewer files needed for v1:

- PDF.js loading shell;
- WebSocket connection;
- PDF refresh;
- forward/reverse SyncTeX;
- basic page/zoom/scroll state preservation;
- simple ping/reconnect.

Defer nonessential UI patches unless needed to make the basic viewer usable.

### Refactor

Keep compatibility shims local to viewer code; do not leak browser globals into server code.

## Phase 7: Viewer HTTP server

### Red

Add `test/modules/viewer/viewer_http_server.test.ts`:

- starts on `127.0.0.1` with an ephemeral port.
- serves `/viewer.html?pdf_id=<id>` for registered IDs.
- serves `/pdf/<pdf_id>` only for registered IDs.
- serves updated bytes after registry revision/snapshot update.
- rejects unknown `pdf_id` with 404.
- rejects path traversal attempts.
- serves `/config.json` with required viewer defaults.
- serves viewer/PDF.js static assets from allowlisted roots only.

### Green

Implement a loopback HTTP server with allowlisted static roots and registered-PDF serving.

### Refactor

Separate URL construction from server startup. Browser-launch code should depend only on returned viewer URLs.

## Phase 8: Viewer WebSocket protocol and PDF polling

### Red

Add `test/modules/viewer/viewer_ws_server.test.ts` using real loopback WebSocket clients or a protocol-level fake:

- viewer connects with `pdf_id` and is associated with that registry record.
- `open`/connection registration records the client.
- `loaded` updates record state or timestamp.
- server can send `synctex` to all connected clients for a `pdf_id`.
- server can send `pdf_refresh` with revision to all connected clients for a `pdf_id`.
- server can send `viewer_reload` to all connected clients for a `pdf_id`.
- disconnected sockets are removed.
- unknown `pdf_id` socket connections are rejected/closed.

Add `test/modules/viewer/pdf_change_poller.test.ts`:

- records an initial PDF stat snapshot.
- detects size or mtime changes.
- waits for a short stable/debounce window before refreshing.
- increments PDF revision.
- sends `pdf_refresh` to connected clients.
- ignores deleted/missing PDFs or records a clear error without crashing.

### Green

Implement WebSocket endpoint, client tracking, and file-change polling.

### Refactor

Define a narrow protocol module so browser viewer code and server tests share message types.

## Phase 9: Browser launcher boundary

### Red

Add `test/modules/viewer/browser_launcher.test.ts`:

- fake launcher records URL and returns success.
- failed launcher does not fail `open_pdf`; tool still returns `viewer_url` with a warning/detail.
- launcher is isolated behind an interface.
- guardrails allow browser URL launching through this one boundary while continuing to forbid direct PDF viewer launches.

### Green

Implement launcher abstraction and inject it into tool handlers/viewer service.

### Refactor

Keep all platform-specific browser URL launching in one file. Do not spread `xdg-open`/`open`/Windows handling through tools.

## Phase 10: Tool behavior with fakes

### Red

Add `test/modules/mcp/tool_handlers.test.ts` or split per tool:

#### `open_pdf`

- validates a PDF.
- resolves relative path against launch cwd.
- registers it.
- starts viewer server lazily.
- launches browser with viewer URL.
- returns `pdf_id`, `pdf`, `viewer_url`.
- reopens/reuses an existing active record for the same PDF where practical.

#### `show_latex`

- accepts `source` and optional `compiler`.
- rejects empty source.
- writes a temporary `.tex` document.
- applies active runtime preamble.
- invokes fake compiler.
- registers resulting PDF.
- opens viewer.
- returns `pdf_id`, `pdf`, `source`, `log`, `viewer_url`.
- schema and handler reject/ignore no `inline` support by not accepting the field.

#### `compile_latex_file`

- invokes one-shot compile.
- with `open_pdf=false`, returns compile result only.
- with `open_pdf=true`, opens/registers viewer.
- when compiling a PDF already registered, reuses the record and sends `pdf_refresh`.
- has no `continuous` in schema and rejects unexpected `continuous` if strict validation is used.

#### `jump_pdf`

- fails for unknown `pdf_id`.
- resolves relative `source_file` against launch cwd.
- uses mapped SyncTeX record.
- sends viewer `synctex` message.
- returns source line details.

#### `get_pdf_events`

- requires `max_events`.
- returns last N reverse SyncTeX events.
- supports optional `pdf_id` filtering.
- returns events in chronological order.

#### `close_pdf`

- untracks the PDF.
- best-effort notifies connected viewer(s).
- does not promise browser process termination.

#### `set_latex_preamble`

- updates active runtime preamble.
- subsequent `show_latex` uses updated preamble.

### Green

Implement minimal tool handlers and shared runtime object.

### Refactor

Reduce coupling between handlers. Tool handlers should orchestrate compile/registry/viewer/SyncTeX services rather than own their internals.

## Phase 11: Reverse SyncTeX event flow

### Red

Add integration-style test `test/modules/viewer/reverse_synctex_flow.test.ts`:

1. Register/open a PDF with SyncTeX fixture.
2. Connect a fake viewer WebSocket.
3. Send `reverse_synctex` with page and coordinates.
4. Assert event store contains:
   - `kind: "reverse_synctex"`
   - `pdf_id`
   - `source_file`
   - `line`
   - `column`
   - `source_line` when readable
5. Fetch it through `get_pdf_events({ max_events: N })` MCP tool.

### Green

Wire WebSocket `reverse_synctex` handling to SyncTeX mapper and event store.

### Refactor

Centralize event formatting and source-line reading.

## Phase 12: Deletion and guardrails

### Red

Update or add guardrail tests, e.g. `test/viewer_guardrails.test.ts`:

- no production TypeScript references direct Zathura command spawning.
- no persistent host-service socket/server entrypoint remains in the v1 path.
- no systemd unit assumptions remain.
- no inline raster/Kitty preview modules are imported by production entrypoints.
- no `continuous` option appears in MCP schemas, prompt guidance, or tool handlers.
- no `inline` option appears in `show_latex` MCP schema or prompt guidance.
- browser URL launcher is the only allowed place for platform browser-open commands.

### Green

Delete or isolate obsolete modules until guardrails pass.

### Refactor

Simplify package scripts and README to match the stdio MCP runtime.

## Phase 13: End-to-end smoke tests

Automated smoke with fake compiler/browser launcher:

- start MCP runtime in-process.
- call `initialize`.
- call `show_latex`.
- connect fake viewer.
- call `jump_pdf`.
- send reverse click.
- call `get_pdf_events({ max_events: 10 })`.
- simulate PDF file change and assert `pdf_refresh`.
- call `close_pdf`.

Manual smoke with real browser and TeX installation:

1. Configure agent to launch `node scripts/tex-actions-mcp.ts`.
2. Call `show_latex` and confirm browser PDF.js viewer opens.
3. Call `compile_latex_file(..., open_pdf=true)` and confirm compiled PDF opens.
4. Call `jump_pdf` and confirm viewer scroll/highlight.
5. Ctrl-click/double-click in viewer, then call `get_pdf_events({ max_events: 10 })` and confirm source location.
6. Modify a tracked PDF externally or via one-shot compile and confirm `pdf_refresh` updates the existing viewer.
7. Stop the MCP process and confirm no daemon/systemd process remains.

## Refactor checkpoints

After each phase:

```bash
npm run check
npm test
```

Before declaring v1 complete:

```bash
npm run verify
```

Manual browser smoke is required because automated tests cannot prove real browser focus/window behavior.

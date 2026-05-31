# Context

## Glossary

### Inline Preview
A frontend presentation mode where a rendered LaTeX/PDF preview is displayed inline to the user inside the agent UI or terminal experience.

`inline` is frontend-facing language. It describes whether the user should see a preview inline, not how preview artifacts are produced.

### Rasterization
The core/service operation of converting a PDF page or pages into image artifacts, such as PNG files.

`rasterize` is service-facing language. It requests image artifact production and does not imply that any frontend will display those artifacts inline.

### LaTeX PDF Production
The core operation of producing a PDF from LaTeX input.

LaTeX PDF Production has two input modes: snippet input and file input. Snippet input may apply a preamble and document wrapper automatically. File input compiles an existing `.tex` file. After PDF production, callers may request additional operations such as rasterization or a managed viewer open.

### Pi Extension
The Pi-specific frontend integration for pdf-preview. It owns Pi tool registration, Pi UI rendering behavior, Pi terminal refresh behavior, and Pi editor paste integration.

The Pi Extension should preserve its existing public tool API and user-facing language even if core logic moves into the MCP Service, except for `get_synctex_callback_command`, which is intentionally planned for removal. Manual inverse SyncTeX setup should move to documentation rather than remain a public tool.

Pi may continue to expose `inline` because that describes Pi presentation behavior. Internally, Pi can translate inline preview requests into service-facing artifact/rasterization requests.

### Host Service
The long-running local service intended to own pdf-preview core capabilities and expose them to MCP-capable agents.

The Host Service is planned to become the primary owner of core logic, active PDF IDs, artifact/session state, callback routing, and viewer backend adapters. It should use service-facing concepts such as rasterization and artifacts rather than frontend presentation concepts such as inline rendering.

The Host Service should communicate over a local Unix socket unless a future portability constraint requires another transport. Pi wraps the Host Service and may register a callback endpoint so the Host Service can actively deliver inverse SyncTeX events back to Pi for editor insertion.

Because the Host Service is long-running and may serve multiple agents/projects, requests that depend on relative paths or project defaults must include explicit workspace context. The service should not rely on its own process working directory as the caller's project context.

The stable integration surface is MCP, not a public CLI. Developer convenience commands may exist under a shared command namespace such as `agent-synctex show_latex ...`, but these are for debugging/smoke testing rather than the primary user workflow.

The previous separate viewer-service role should be absorbed into the Host Service unless a future security or deployment constraint requires splitting it again.

### Preview Artifact
A generated output of preview or compile work, such as a PDF file, rasterized image file, or log file. Frontends decide how to present preview artifacts to users.

### Managed Viewer Open
A PDF viewer open operation that creates a tracked service record for the opened PDF, including its PDF handle, backend handle, PDF path, ownership/reuse metadata, callback configuration, and enough metadata to later jump or close safely.

External snippet previews and compiled-file opens should both use managed viewer opens when they display a PDF externally. Their difference is input preparation: snippet previews may apply a preamble and document wrapper automatically, while compiled-file opens use an existing source file.

### PDF ID
A short, Host-Service-generated, random numeric identifier for an active PDF viewer record.

PDF IDs are globally unique among currently active records. They are intended to prevent accidental cross-agent interference without requiring long UUID-style tokens. The current planned range is 1 through 99,999,999.

PDF IDs are active runtime state and are kept in memory only. They do not survive Host Service restart. Artifacts may remain on disk, but active viewer records and PDF IDs must be re-established after restart.

The Host Service does not model agent ownership for PDF IDs. Any caller with an active PDF ID can use it to request jump or close behavior. Agent-specific behavior only appears in optional callback targets, such as Pi editor insertion for inverse SyncTeX.

PDF IDs may be exposed temporarily for debugging and tool use, but they are not meaningful domain objects for end users and may eventually be hidden behind higher-level UX.

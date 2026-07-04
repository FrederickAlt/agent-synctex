# TeX Actions

TeX Actions is a local stdio MCP server for LaTeX snippet rendering, file compilation, and PDF navigation through the Desktop Viewer Host boundary.

The active runtime launches a local loopback Viewer Host Server process on demand, registers PDFs with MCP-owned `pdf_id`s, serves the Host-loaded Viewer Client/PDF.js pages, forwards SyncTeX display requests, fetches user-marked PDF comments as source-cited context through `fetch_pdf_context` in pure MCP mode, and re-registers known PDFs after Host restart. Fake Viewer Host clients are used only by tests or explicit injection.

## Exposed MCP tools

- `show_latex`
  - Compile LaTeX source and route the generated PDF open request through the Viewer Host Client boundary.
  - Returns compile metadata and a runtime `pdf_id` when opening succeeds.
- `compile_latex_file`
  - Compile an existing `.tex` source file.
  - Optional `open_pdf=true` routes the generated PDF open request through the Viewer Host Client boundary and returns a runtime `pdf_id`.
- `open_pdf`
  - Register an existing PDF in MCP runtime state and send an `open_pdf` or `focus_pdf` message to the Viewer Host Client boundary.
- `jump_pdf`
  - Forward-search a tracked PDF by `pdf_id` and source line; MCP computes SyncTeX coordinates and sends `synctex_forward` to the Viewer Host Client boundary.
- `set_latex_preamble`
  - Set the runtime preamble used by snippet compilation.
- `fetch_pdf_context`
  - Fetch unread PDF viewer marks/comments as concise source-cited context and consume the pending marks. Hidden when the MCP is launched with `--with-hooks` because harness hooks inject this context automatically.

`close_pdf` is intentionally not a public MCP tool in this boundary slice. Viewer/tab close is a Viewer Client concern and does not delete MCP-owned `pdf_id` state.

## Runtime architecture

- Entry point: `scripts/tex-actions-mcp.ts` (alias: `scripts/pdf-preview-mcp.ts`).
- Runtime host: `src/modules/stdio_mcp_runtime.ts`.
- MCP tool handling: `src/modules/host_service_mcp.ts`.
- Viewer Host Client boundary: `src/modules/viewer_host_client.ts`.
- Typed Viewer Host protocol: `src/modules/viewer_host_protocol.ts`.
- Compile orchestration: `src/modules/host_service_compile.ts` with LaTeX primitives in `src/modules/latex/`.

Returned `viewer_url` values are reachable loopback Viewer Host pages while the MCP stdio process is alive. They do not expose raw filesystem PDF paths.

### Desktop Viewer Bundle launch status

The automated default MCP runtime currently launches the headless Host Server script (`scripts/viewer-host-server.ts`) and its Host-served web client. The Tauri Desktop Viewer Bundle wrapper is present under `apps/viewer-desktop-tauri/`, but native desktop-window launch and manual/HITL smoke are deferred to #116 or explicit configured packaging. This is the current v1 deviation from the full PRD wording that says MCP launches the Desktop Viewer Bundle directly.

## Start the runtime

For local development, run the MCP entrypoint directly so stdout remains reserved for MCP stdio frames:

```bash
node scripts/tex-actions-mcp.ts
```

For MCP client configuration after installation, use the package bin:

```bash
tex-actions-mcp
```

When harness post-user-message hooks are installed, launch the MCP with hook-aware mode so the manual context tool is hidden:

```bash
tex-actions-mcp --with-hooks
```

Pi's local MCP config supports `lifecycle` values `"lazy"`, `"eager"`, and `"keep-alive"`. Use `"keep-alive"` for `tex-actions` so process-local MCP state survives between calls while the MCP stdio process remains alive. Do not configure MCP clients with `npm run tex-actions:mcp`; npm output can corrupt stdio framing. Use the installed `tex-actions-mcp` bin or the direct `node scripts/tex-actions-mcp.ts` command for local development only.

```json
{
  "mcpServers": {
    "tex-actions": {
      "command": "tex-actions-mcp",
      "lifecycle": "keep-alive",
      "directTools": true
    }
  }
}
```

## Agent forward SyncTeX debug

For HITL/multiline alignment diagnosis, generate a raster + overlay for the same forward SyncTeX mapping `jump_pdf` uses:

```bash
npm run debug:forward-synctex -- --pdf /path/main.pdf --source /path/main.tex --line 123 --out /tmp/synctex-debug
```

`--pdf`, `--source`, `--line`, and `--out` are required. The `crop` PNG is always produced on successful runs.

The script:

- runs the production `mapForwardSynctex` path,
- rasterizes the target PDF page and draws the computed highlight box,
- writes a readable full-page overlay PNG,
- writes an always-generated marker crop PNG around the highlight (primary diagnostic artifact),
- writes a JSON metadata file with: input paths, line/page, resolved source/sidecar, mapping marker in PDF points and image pixels, scale (`dpi`, `px_per_point`), output file paths, and command warnings.

Paths are printed in a machine-readable block:

```text
forward Synctex diagnostic artifacts:
  metadata: /tmp/synctex-debug/forward-synctex-line-123-diagnostic.json
  full-page: /tmp/synctex-debug/forward-synctex-page-1.png
  overlay: /tmp/synctex-debug/forward-synctex-page-1-overlay.png
  crop: /tmp/synctex-debug/forward-synctex-page-1-crop.png
```

Optional knobs are available:

- `--dpi` for raster resolution (default 144)
- `--crop-margin-points` for crop padding (default 72)

Required external commands:

- `pdftoppm` (or `pdftocairo` fallback)
- ImageMagick `magick`

## Verification

```bash
npm run check
npm test
npm run smoke:stdio-viewer
```

`test/viewer_guardrails.test.ts` enforces that active package entrypoints remain stdio MCP plus Viewer Host boundary code and do not reintroduce removed callback schemas, direct viewer commands, daemon entrypoints, in-process PDF.js ownership, or inline/raster compatibility paths.

## Historical note

Some internal module names still contain `host_service` because they define current MCP DTOs or compile helpers. File names alone are not compatibility promises; active behavior is the stdio MCP + Viewer Host Client boundary path above.

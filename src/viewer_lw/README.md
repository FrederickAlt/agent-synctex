# Vendored LaTeX Workshop / PDF.js viewer assets

This directory contains the experimental side-by-side viewer served at `/viewer-lw/:pdf_id`.

## Provenance

- `viewer.html`, `viewer.mjs`, `viewer.css`, `latexworkshop.css`, `images/**`, and `locale/**` were copied/adapted from the LaTeX Workshop repository inspected at `/home/frederick/projects/AI/pi_extensions/LaTeX-Workshop/viewer` for issue #141.
- The upstream LaTeX Workshop viewer is based on Mozilla PDF.js and carries the PDF.js Apache-2.0 notices in the copied files.
- `host_lw_adapter.mjs` is local glue for this Host implementation. It loads `/config/:pdf_id.json` and points the vendored viewer at the current Host `/pdf/:pdf_id?revision=N` URL.

## Licenses

- PDF.js-derived files are licensed under Apache-2.0. See `LICENSE-PDF.js.txt` and the retained notices in `viewer.html` and `viewer.mjs`.
- LaTeX Workshop-derived CSS/assets are licensed under MIT. See `LICENSE-LaTeX-Workshop.txt`; `latexworkshop.css` has an added local attribution header.

## Version consistency

The copied `viewer.mjs` reports `pdfjsVersion = 5.7.284`. The matching PDF.js `5.7.284` runtime assets are vendored here as:

- `build/pdf.mjs`
- `build/pdf.worker.mjs`
- `build/pdf.sandbox.mjs`
- `cmaps/**`
- `standard_fonts/**`
- `wasm/**`

Keep these assets version-aligned with `viewer.mjs`; mixing a different installed `pdfjs-dist` version can fail at runtime with a PDF.js API/viewer version mismatch.

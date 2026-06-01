import { resolve } from "node:path";

export const MCP_TMPDIR = process.env.MCP_TMPDIR ?? resolve(process.env.XDG_RUNTIME_DIR || process.env.HOME || process.cwd(), "show-latex");

export const MCP_FIXED_PREVIEW_PDF_PATH = resolve(MCP_TMPDIR, "show-latex.pdf");

export const LATEX_PREAMBLE_FILE_NAMES = ["preamble.tex", "praeamble.tex"] as const;

export const LATEX_PREAMBLE_PATH = resolve(MCP_TMPDIR, "preamble.tex");

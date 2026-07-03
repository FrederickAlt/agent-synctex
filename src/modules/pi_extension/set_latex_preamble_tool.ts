import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { relative } from "node:path";
import { resolveAgentWorkspaceContext } from "../agent_runtime_context.ts";
import { buildLatexPreambleIndex } from "../latex/latex_preamble_index.ts";
import { getLatexPreambleFilePath, writeLatexPreambleToTmpdir as writeLatexPreambleToTmpdirShared } from "../runtime_preamble.ts";

const SetLatexPreambleParams = Type.Object(
	{
		latex_preamble: Type.Optional(Type.String({
			description:
				"Raw LaTeX preamble lines to write to the current agent’s TeX Actions runtime preamble and include before \\begin{document} for show_latex snippet compiles. This overwrites the active agent preamble; if a root preamble was auto-loaded or selected, this makes the active preview preamble diverge from that root. Use only for pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. Use an empty string to clear it only when intentionally clearing the active preview preamble.",
		})),
		root_file: Type.Optional(Type.String({
			description: "LaTeX root file whose discovered preamble should be activated instead of providing raw latex_preamble.",
		})),
	},
	{ additionalProperties: false },
);

export function registerSetLatexPreambleTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "set_latex_preamble",
		label: "Set LaTeX Preamble",
		description: "Set LaTeX preamble lines inserted before \\begin{document} in subsequent show_latex snippet compiles. Pass raw LaTeX preamble text, or pass root_file to use a discovered root preamble when auto-load skipped because multiple roots exist. This overwrites the current agent’s TeX Actions runtime preamble. compile_latex_file compiles complete files directly without preamble injection.",
		promptSnippet: "Set a LaTeX preamble for future PDF previews",
		promptGuidelines: [
			"Use set_latex_preamble only when the user explicitly wants to change packages/macros/options for every subsequent snippet preview, or when multiple LaTeX roots exist and a specific root_file must be selected.",
			"In an existing LaTeX project, remember that this overwrites the current agent’s active runtime preamble, not just an isolated one-off preview setting. Do not use it after a failed preview unless the user explicitly wants to replace the active session preamble.",
			"Do not install a minimal standalone preamble inside an existing LaTeX project as a workaround for a failed show_latex compile. Inspect the log and active root preamble first, and restore or select the intended root preamble if it diverged.",
			"Project ./preamble.tex and ./praeamble.tex files are not auto-loaded. Auto-load uses the discovered preamble from a single LaTeX root; if multiple roots are discovered, auto-load silently skips and root_file can select one.",
		],
		parameters: SetLatexPreambleParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workspaceContext = resolveAgentWorkspaceContext(ctx);
			const hasRawPreamble = Object.prototype.hasOwnProperty.call(params, "latex_preamble");
			const hasRootFile = Object.prototype.hasOwnProperty.call(params, "root_file");
			if (hasRawPreamble === hasRootFile) {
				throw new Error("set_latex_preamble requires exactly one of latex_preamble or root_file");
			}
			let preamble = String(params.latex_preamble ?? "");
			let sourceRoot: string | undefined;
			if (hasRootFile) {
				const rootFile = String(params.root_file ?? "");
				const timeoutMs = Number(process.env.LATEX_PREAMBLE_TIMEOUT_MS ?? "5000");
				const index = buildLatexPreambleIndex(workspaceContext.cwd, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000);
				if (index.timedOut) {
					throw new Error("set_latex_preamble could not scan root files before the timeout");
				}
				const root = index.getRoot(rootFile);
				preamble = root.preamble;
				sourceRoot = root.rootFile;
			}
			const preambleLength = writeLatexPreambleToTmpdirShared(preamble, {
				runtimeDirectory: workspaceContext.workspace_root,
			});
			const preamblePath = getLatexPreambleFilePath(workspaceContext.workspace_root);
			const sourceText = sourceRoot === undefined ? "" : ` from ${relative(workspaceContext.cwd, sourceRoot)}`;
			const text = preambleLength
				? `LaTeX preamble set${sourceText} (${preambleLength} characters) at ${preamblePath}. It will be included in subsequent show_latex snippet calls; compile_latex_file compiles complete files directly without preamble injection.`
				: `LaTeX preamble cleared at ${preamblePath}.`;
			return {
				content: [{ type: "text", text }],
				details: { preambleLength, preamblePath, ...(sourceRoot === undefined ? {} : { rootFile: sourceRoot }) },
			};
		},
	});
}

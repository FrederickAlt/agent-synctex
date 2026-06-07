import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgentWorkspaceContext } from "../agent_runtime_context.ts";
import { getLatexPreambleFilePath, writeLatexPreambleToTmpdir as writeLatexPreambleToTmpdirShared } from "../runtime_preamble.ts";

const SetLatexPreambleParams = Type.Object(
	{
		latex_preamble: Type.String({
			description:
				"LaTeX preamble lines to write to the current agent’s TeX Actions runtime preamble and include before \\begin{document} for show_latex snippet compiles. This overwrites the active agent preamble; if a project preamble was copied there at startup, this makes the active preview preamble diverge from the project's real ./preamble.tex. Use only for pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. Use an empty string to clear it only when intentionally clearing the active preview preamble.",
		}),
	},
	{ additionalProperties: false },
);

export function registerSetLatexPreambleTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "set_latex_preamble",
		label: "Set LaTeX Preamble",
		description: "Set LaTeX preamble lines inserted before \\begin{document} in subsequent show_latex snippet compiles. This overwrites the current agent’s TeX Actions runtime preamble. If a project preamble was copied there at startup, this changes the active preview preamble for the rest of the session and can make it diverge from the project's real ./preamble.tex or ./praeamble.tex. It should contain pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. compile_latex_file compiles complete files directly without preamble injection.",
		promptSnippet: "Set a LaTeX preamble for future PDF previews",
		promptGuidelines: [
			"Use set_latex_preamble only when the user explicitly wants to change packages/macros/options for every subsequent snippet preview.",
			"In an existing LaTeX project, remember that this overwrites the current agent’s already-copied runtime preamble, not just an isolated one-off preview setting. Do not use it after a failed preview unless the user explicitly wants to replace the active session preamble.",
			"Do not install a minimal standalone preamble inside an existing LaTeX project as a workaround for a failed show_latex compile. Inspect the log and project preamble first, and restore the current agent’s TeX Actions runtime preamble if it diverged.",
			"For reusable project defaults, write pre-\\begin{document} code to ./preamble.tex or ./praeamble.tex before starting the Pi session so it is copied into the current agent’s TeX Actions runtime preamble.",
		],
		parameters: SetLatexPreambleParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workspaceContext = resolveAgentWorkspaceContext(ctx);
			const preambleLength = writeLatexPreambleToTmpdirShared(String(params.latex_preamble ?? ""), {
				runtimeDirectory: workspaceContext.workspace_root,
			});
			const preamblePath = getLatexPreambleFilePath(workspaceContext.workspace_root);
			const text = preambleLength
				? `LaTeX preamble set (${preambleLength} characters) at ${preamblePath}. It will be included in subsequent show_latex snippet calls; compile_latex_file compiles complete files directly without preamble injection.`
				: `LaTeX preamble cleared at ${preamblePath}.`;
			return {
				content: [{ type: "text", text }],
				details: { preambleLength, preamblePath },
			};
		},
	});
}

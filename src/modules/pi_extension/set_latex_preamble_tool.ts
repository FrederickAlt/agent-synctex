import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { writeLatexPreambleToTmpdir, LATEX_PREAMBLE_PATH } from "./latex_preamble_manager.ts";

const SetLatexPreambleParams = Type.Object(
	{
		latex_preamble: Type.String({
			description:
				"LaTeX preamble lines to write to ${XDG_RUNTIME_DIR}/tex-actions/preamble.tex and include before \\begin{document} for show_latex snippet compiles. This overwrites the active temp preamble; if a project preamble was copied there at startup, this makes the active preview preamble diverge from the project's real ./preamble.tex. Use only for pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. Use an empty string to clear it only when intentionally clearing the active preview preamble.",
		}),
	},
	{ additionalProperties: false },
);

export function registerSetLatexPreambleTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "set_latex_preamble",
		label: "Set LaTeX Preamble",
		description: "Set LaTeX preamble lines inserted before \\begin{document} in subsequent show_latex snippet compiles. This overwrites the active temp preamble at ${XDG_RUNTIME_DIR}/tex-actions/preamble.tex. If a project preamble was copied there at startup, this changes the active preview preamble for the rest of the session and can make it diverge from the project's real ./preamble.tex or ./praeamble.tex. It should contain pre-document setup such as \\documentclass, \\usepackage, and macro definitions, not document body content. compile_latex_file compiles complete files directly without preamble injection.",
		promptSnippet: "Set a LaTeX preamble for future PDF previews",
		promptGuidelines: [
			"Use set_latex_preamble only when the user explicitly wants to change packages/macros/options for every subsequent snippet preview.",
			"In an existing LaTeX project, remember that this overwrites the already-copied active temp preamble, not just an isolated one-off preview setting. Do not use it after a failed preview unless the user explicitly wants to replace the active session preamble.",
			"Do not install a minimal standalone preamble inside an existing LaTeX project as a workaround for a failed show_latex compile. Inspect the log and project preamble first, and restore the project preamble into ${XDG_RUNTIME_DIR}/tex-actions/preamble.tex if it diverged.",
			"For reusable project defaults, write pre-\\begin{document} code to ./preamble.tex or ./praeamble.tex before starting the Pi session so it is copied into ${XDG_RUNTIME_DIR}/tex-actions/preamble.tex.",
		],
		parameters: SetLatexPreambleParams,
		async execute(_toolCallId, params) {
			const preambleLength = writeLatexPreambleToTmpdir(String(params.latex_preamble ?? ""));
			const text = preambleLength
				? `LaTeX preamble set (${preambleLength} characters) at ${LATEX_PREAMBLE_PATH}. It will be included in subsequent show_latex snippet calls; compile_latex_file compiles complete files directly without preamble injection.`
				: `LaTeX preamble cleared at ${LATEX_PREAMBLE_PATH}.`;
			return {
				content: [{ type: "text", text }],
				details: { preambleLength, preamblePath: LATEX_PREAMBLE_PATH },
			};
		},
	});
}

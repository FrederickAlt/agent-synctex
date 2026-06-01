import { initializeLatexPreambleFile, } from "./src/modules/pi_extension/latex_preamble_manager.ts";
import { createSynctexCallbackManager } from "./src/modules/pi_extension/synctex_callback_manager.ts";
import { registerCompileLatexFileTool } from "./src/modules/pi_extension/compile_latex_file_tool.ts";
import { registerPdfTools } from "./src/modules/pi_extension/pdf_tools.ts";
import { registerShowLatexTool } from "./src/modules/pi_extension/show_latex_tool.ts";
import { registerSetLatexPreambleTool } from "./src/modules/pi_extension/set_latex_preamble_tool.ts";
import { registerLifecycleHandlers } from "./src/modules/pi_extension/lifecycle.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	initializeLatexPreambleFile();
	const callbackManager = createSynctexCallbackManager();

	registerLifecycleHandlers(pi, callbackManager);
	registerShowLatexTool(pi, callbackManager);
	registerCompileLatexFileTool(pi, callbackManager);
	registerPdfTools(pi, callbackManager);
	registerSetLatexPreambleTool(pi);
}

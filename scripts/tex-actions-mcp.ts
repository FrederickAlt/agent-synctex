#!/usr/bin/env node
import { startTexActionsStdioMcpRuntime } from "../src/modules/stdio_mcp_runtime.ts";

const runtime = startTexActionsStdioMcpRuntime();
let sigtermCount = 0;
process.once("SIGINT", () => runtime.forceClose());
process.on("SIGTERM", () => {
	sigtermCount += 1;
	if (sigtermCount === 1) {
		runtime.close({ lingerViewerService: true });
		return;
	}
	runtime.forceClose();
});

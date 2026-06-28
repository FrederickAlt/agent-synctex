#!/usr/bin/env node
import { startTexActionsStdioMcpRuntime } from "../src/modules/stdio_mcp_runtime.ts";

const runtime = startTexActionsStdioMcpRuntime();
process.once("SIGINT", () => runtime.close());
process.once("SIGTERM", () => runtime.close());

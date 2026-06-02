#!/usr/bin/env node
import { startCodexMcpDaemonRelay } from "../src/modules/codex_mcp/codex_mcp_server.ts";

const relay = startCodexMcpDaemonRelay();
process.once("SIGINT", () => relay.close());
process.once("SIGTERM", () => relay.close());

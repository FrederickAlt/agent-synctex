import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { collectMcpFrames, encodeMcpFrame, parseMcpFrames } from "./mcp_frames.ts";

test("MCP frame helper parses Content-Length as bytes for multibyte JSON payloads", () => {
	const frame = encodeMcpFrame({ jsonrpc: "2.0", id: 1, result: { text: "é漢" } });
	const parsed = parseMcpFrames(Buffer.from(frame, "utf8"));
	assert.deepEqual(parsed, [{ jsonrpc: "2.0", id: 1, result: { text: "é漢" } }]);
});

test("MCP frame collector preserves multibyte payloads across byte-split chunks", async () => {
	const stream = new PassThrough();
	const frame = Buffer.from(encodeMcpFrame({ jsonrpc: "2.0", id: 2, result: { text: "é" } }), "utf8");
	const splitAt = frame.indexOf(Buffer.from("é", "utf8")) + 1;
	const collected = collectMcpFrames(stream, 1);
	stream.write(frame.subarray(0, splitAt));
	stream.write(frame.subarray(splitAt));
	assert.deepEqual(await collected, [{ jsonrpc: "2.0", id: 2, result: { text: "é" } }]);
});

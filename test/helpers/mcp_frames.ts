import type { Readable } from "node:stream";

export function encodeMcpFrame(payload: unknown): string {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

export function parseMcpFrames(raw: string | Buffer<ArrayBufferLike>): Array<Record<string, unknown>> {
	const buffer = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
	const frames: Array<Record<string, unknown>> = [];
	let cursor = 0;

	while (cursor < buffer.length) {
		const separator = buffer.indexOf("\r\n\r\n", cursor);
		if (separator < 0) break;
		const headerText = buffer.slice(cursor, separator).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(headerText);
		if (!match) break;
		const bodyLength = Number.parseInt(match[1]!, 10);
		const bodyStart = separator + 4;
		const body = buffer.slice(bodyStart, bodyStart + bodyLength);
		if (body.length < bodyLength) break;
		frames.push(JSON.parse(body.toString("utf8")));
		cursor = bodyStart + bodyLength;
	}

	return frames;
}

export function collectMcpFrames(stream: Readable, expectedFrames: number, timeoutMs = 1_000): Promise<Array<Record<string, unknown>>> {
	return new Promise((resolve, reject) => {
		let raw: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`timed out waiting for ${expectedFrames} frame(s); got ${parseMcpFrames(raw).length}: ${raw.toString("utf8")}`));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			stream.off("data", onData);
		};
		const onData = (chunk: string | Buffer) => {
			const next: Buffer<ArrayBufferLike> = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			raw = raw.length === 0 ? next : Buffer.concat([raw, next]);
			const frames = parseMcpFrames(raw);
			if (frames.length >= expectedFrames) {
				cleanup();
				resolve(frames);
			}
		};
		stream.on("data", onData);
	});
}

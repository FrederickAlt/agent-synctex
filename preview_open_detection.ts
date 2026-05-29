import { readFileSync, statSync } from "node:fs";

export interface FileSnapshot {
	exists: boolean;
	size: number;
	mtimeMs: number;
}

export interface PreviewOpenDetectionOptions {
	viewerLogPath?: string;
	viewerLogBefore?: FileSnapshot;
	isPdfOpen?: (path: string) => boolean;
	timeoutMs?: number;
	pollMs?: number;
}

export function fileSnapshot(path: string): FileSnapshot {
	try {
		const stat = statSync(path);
		return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return { exists: false, size: 0, mtimeMs: 0 };
	}
}

function readViewerLogSince(path: string, before: FileSnapshot): string {
	try {
		const current = fileSnapshot(path);
		if (!current.exists) return "";
		const data = readFileSync(path);
		const offset = before.exists && current.size >= before.size ? before.size : 0;
		return data.subarray(offset).toString("utf8");
	} catch {
		return "";
	}
}

export function viewerLogReportsPreviewHandled(text: string): boolean {
	return text.split(/\r?\n/).some((line) =>
		line.includes("] helper: launching ")
		|| line.includes("] helper: zathura already open")
		|| line.includes("] helper: zathura already tracked")
	);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(new Error("operation aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("operation aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function previewAlreadyOpen(
	paths: string[],
	signal?: AbortSignal,
	options: PreviewOpenDetectionOptions = {},
): Promise<boolean> {
	const isPdfOpen = options.isPdfOpen ?? (() => false);
	const timeoutMs = options.timeoutMs ?? 1_500;
	const pollMs = options.pollMs ?? 100;
	const deadline = Date.now() + timeoutMs;

	while (true) {
		if (paths.some((path) => path && isPdfOpen(path))) return true;
		if (options.viewerLogPath && options.viewerLogBefore) {
			const appendedLog = readViewerLogSince(options.viewerLogPath, options.viewerLogBefore);
			if (viewerLogReportsPreviewHandled(appendedLog)) return true;
		}
		if (Date.now() >= deadline) return false;
		await delay(pollMs, signal);
	}
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { gzipSync } from "node:zlib";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReadablePdfFile,
	closePdfInZathura,
	closeTrackedPdf,
	inferDefaultSourceFileForPdf,
	jumpToTrackedPdf,
	normalizePdfFilePath,
	openAndTrackPdf,
	openPdfInZathura,
	PdfTracker,
	processArgsMatchZathuraPdf,
} from "./pdf_tracking.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pdf-tracking-test-"));
}

function writeMinimalPdf(path: string): void {
	writeFileSync(path, "%PDF-1.7\n% test\n%%EOF\n");
}

function activeChildProcessHandles(): number {
	const getActiveHandles = (process as typeof process & { _getActiveHandles: () => Array<{ constructor?: { name?: string } }> })._getActiveHandles;
	return getActiveHandles().filter((handle: { constructor?: { name?: string } }) => handle.constructor?.name === "ChildProcess").length;
}

async function waitForProcessArgs(pid: number, needle: string, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle)) return;
		} catch {
			// Retry until the process exits or /proc catches up.
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`process ${pid} did not expose expected args`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
}

test("assertReadablePdfFile rejects missing, directory, and non-PDF paths clearly", () => {
	const dir = tempDir();
	assert.throws(() => assertReadablePdfFile(join(dir, "missing.pdf")), /Cannot stat PDF file/);
	assert.throws(() => assertReadablePdfFile(dir), /regular file/);

	const textFile = join(dir, "not-a-pdf.pdf");
	writeFileSync(textFile, "not a pdf");
	assert.throws(() => assertReadablePdfFile(textFile), /must point to a PDF file/);
});

test("normalizePdfFilePath resolves symlinks so equivalent paths share one identity", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
	symlinkSync(pdf, link);

	assert.equal(normalizePdfFilePath(link), normalizePdfFilePath(pdf));
});

test("PdfTracker assigns short session-local IDs and tracks repeated paths separately", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	const repeated = tracker.trackOpenedPdf("/tmp/one.pdf");
	const second = tracker.trackOpenedPdf("/tmp/two.pdf");

	assert.equal(first.id, 1);
	assert.equal(repeated.id, 2);
	assert.equal(second.id, 3);
	assert.equal(tracker.getById(first.id)?.path, "/tmp/one.pdf");
	assert.equal(tracker.getByPath("/tmp/one.pdf")?.id, repeated.id);
	assert.equal(tracker.getByPath("/tmp/two.pdf")?.id, second.id);
	assert.deepEqual(tracker.getAllByPath("/tmp/one.pdf").map((entry) => entry.id), [first.id, repeated.id]);
});

test("PdfTracker stores default source files and can update a reopened instance", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	assert.equal(first.sourceFile, undefined);
	assert.equal(first.pid, undefined);

	const reopened = tracker.markReopened(first.id, 1234, "/tmp/main.tex");
	assert.equal(reopened?.id, first.id);
	assert.equal(first.sourceFile, "/tmp/main.tex");
	assert.equal(first.pid, 1234);
});

test("PdfTracker clear drops session state and resets IDs", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	tracker.trackOpenedPdf("/tmp/two.pdf");

	tracker.clear();

	assert.equal(tracker.getById(first.id), undefined);
	assert.equal(tracker.getByPath("/tmp/one.pdf"), undefined);
	assert.equal(tracker.getByPath("/tmp/two.pdf"), undefined);

	const nextSessionPdf = tracker.trackOpenedPdf("/tmp/one.pdf");
	assert.equal(nextSessionPdf.id, 1);
	assert.notEqual(nextSessionPdf, first);
});

test("PdfTracker can untrack a single PDF", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/one.pdf");
	const second = tracker.trackOpenedPdf("/tmp/two.pdf");

	assert.equal(tracker.untrackById(first.id), first);
	assert.equal(tracker.getById(first.id), undefined);
	assert.equal(tracker.getByPath("/tmp/one.pdf"), undefined);
	assert.equal(tracker.getById(second.id), second);
	assert.equal(tracker.untrackById(999), undefined);
});

test("processArgsMatchZathuraPdf recognizes zathura processes for a PDF", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const otherPdf = join(dir, "other.pdf");
	writeMinimalPdf(pdf);
	writeMinimalPdf(otherPdf);
	const normalizedPdf = realpathSync(pdf);

	assert.equal(processArgsMatchZathuraPdf(["/usr/bin/zathura", "--fork", pdf], normalizedPdf), true);
	assert.equal(processArgsMatchZathuraPdf(["/usr/bin/zathura", otherPdf], normalizedPdf), false);
	assert.equal(processArgsMatchZathuraPdf(["/usr/bin/evince", pdf], normalizedPdf), false);
});

test("inferDefaultSourceFileForPdf prefers a readable same-basename source", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");

	assert.equal(inferDefaultSourceFileForPdf(pdf), source);
});

test("inferDefaultSourceFileForPdf uses unique SyncTeX input records when basename source is absent", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "main.tex");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(join(dir, "paper.synctex"), `SyncTeX Version:1\nInput:1:${source}\n`);

	assert.equal(inferDefaultSourceFileForPdf(pdf), source);
});

test("inferDefaultSourceFileForPdf reads gzip SyncTeX sidecars and avoids ambiguous inputs", () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const main = join(dir, "main.tex");
	const chapter = join(dir, "chapter.tex");
	writeMinimalPdf(pdf);
	writeFileSync(main, "\\documentclass{article}\n");
	writeFileSync(chapter, "chapter\n");
	writeFileSync(join(dir, "paper.synctex.gz"), gzipSync(`Input:1:${main}\nInput:2:${chapter}\n`));

	assert.equal(inferDefaultSourceFileForPdf(pdf), undefined);
});

test("openAndTrackPdf normalizes, opens, infers default source, and tracks a PDF", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	symlinkSync(pdf, link);

	const tracker = new PdfTracker();
	const openedPaths: string[] = [];
	const trackedPdf = await openAndTrackPdf(link, tracker, undefined, async (pdfPath) => {
		openedPaths.push(pdfPath);
	});

	const realPdfPath = realpathSync(pdf);
	assert.deepEqual(openedPaths, [realPdfPath]);
	assert.equal(trackedPdf.id, 1);
	assert.equal(trackedPdf.path, realPdfPath);
	assert.equal(trackedPdf.sourceFile, source);
	assert.equal(tracker.getByPath(realPdfPath), trackedPdf);
});

test("openAndTrackPdf stores an exact default source from the caller", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "requested-main.tex");
	writeMinimalPdf(pdf);
	writeFileSync(join(dir, "paper.tex"), "inferred basename source\n");
	writeFileSync(source, "\\documentclass{article}\n");

	const tracker = new PdfTracker();
	const trackedPdf = await openAndTrackPdf(pdf, tracker, undefined, async () => {}, source);

	assert.equal(trackedPdf.sourceFile, source);
});

test("openAndTrackPdf stores a zathura PID returned by the opener", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	const trackedPdf = await openAndTrackPdf(pdf, tracker, undefined, async () => 4321);

	assert.equal(trackedPdf.pid, 4321);
});

test("openAndTrackPdf reuses an existing tracked PDF for the same normalized path", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const link = join(dir, "paper-link.pdf");
	writeMinimalPdf(pdf);
	symlinkSync(pdf, link);

	const tracker = new PdfTracker();
	const openedPaths: string[] = [];
	const opener = async (pdfPath: string) => {
		openedPaths.push(pdfPath);
	};
	const first = await openAndTrackPdf(pdf, tracker, undefined, opener);
	const second = await openAndTrackPdf(link, tracker, undefined, opener);

	assert.equal(second, first);
	assert.equal(second.id, first.id);
	assert.deepEqual(openedPaths, [realpathSync(pdf)]);
	assert.deepEqual(tracker.getAllByPath(realpathSync(pdf)).map((entry) => entry.id), [first.id]);
});

test("openAndTrackPdf shares concurrent opens for the same PDF", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	let openCalls = 0;
	const opener = async () => {
		openCalls += 1;
		await new Promise((resolve) => setTimeout(resolve, 20));
	};
	const [first, second] = await Promise.all([
		openAndTrackPdf(pdf, tracker, undefined, opener),
		openAndTrackPdf(pdf, tracker, undefined, opener),
	]);

	assert.equal(second, first);
	assert.equal(openCalls, 1);
	assert.deepEqual(tracker.getAllByPath(realpathSync(pdf)).map((entry) => entry.id), [first.id]);
});

test("openAndTrackPdf reopens a stale tracked PDF using the existing ID", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	const stale = tracker.trackOpenedPdf(realpathSync(pdf), undefined, 987654321);
	let openCalls = 0;
	const reopened = await openAndTrackPdf(pdf, tracker, undefined, async () => {
		openCalls += 1;
		return 1234;
	});

	assert.equal(reopened.id, stale.id);
	assert.equal(reopened.pid, 1234);
	assert.equal(openCalls, 1);
	assert.deepEqual(tracker.getAllByPath(realpathSync(pdf)).map((entry) => entry.id), [stale.id]);
});

test("openAndTrackPdf does not track when opening fails", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	writeMinimalPdf(pdf);

	const tracker = new PdfTracker();
	await assert.rejects(
		() => openAndTrackPdf(pdf, tracker, undefined, async () => {
			throw new Error("no display");
		}),
		/no display/,
	);

	assert.equal(tracker.getByPath(realpathSync(pdf)), undefined);
});

test("jumpToTrackedPdf performs a line-based SyncTeX jump using the tracked default source", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);
	const result = await jumpToTrackedPdf(trackedPdf.id, 42, undefined, tracker, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--synctex-forward", `42:1:${source}`, pdf]);
	assert.deepEqual(result, { pdf, sourceFile: source, line: 42, reopened: false });
});

test("jumpToTrackedPdf targets the tracked zathura PID when known", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, 4242);
	await jumpToTrackedPdf(trackedPdf.id, 12, undefined, tracker, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--synctex-forward", `12:1:${source}`, "--synctex-pid=4242", pdf]);
});

test("jumpToTrackedPdf asks for source_file when no default source is known", async () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");

	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 1, undefined, tracker),
		/No default source_file is known.*Pass source_file explicitly/,
	);
});

test("jumpToTrackedPdf reopens a tracked PDF and retries when the first jump fails", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const callsFile = join(dir, "calls.txt");
	const markerFile = join(dir, "failed-once");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(callsFile)}\nprintf '\\n' >> ${JSON.stringify(callsFile)}\nif [ "$1" = "--synctex-forward" ] && [ ! -e ${JSON.stringify(markerFile)} ]; then\n  touch ${JSON.stringify(markerFile)}\n  echo 'no window' >&2\n  exit 9\nfi\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);
	const result = await jumpToTrackedPdf(trackedPdf.id, 7, undefined, tracker, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.equal(result.reopened, true);
	assert.deepEqual(readFileSync(callsFile, "utf8").trim().split("\n"), [
		`--synctex-forward|7:1:${source}|${pdf}|`,
		`--fork|${pdf}|`,
		`--synctex-forward|7:1:${source}|${pdf}|`,
	]);
});

test("jumpToTrackedPdf does not launch an unpinned fallback when the reopened PID already exited", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const callsFile = join(dir, "calls.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(callsFile)}\nprintf '\\n' >> ${JSON.stringify(callsFile)}\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, undefined, "current callback command");
	let reopenCalls = 0;
	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 15, undefined, tracker, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			synctexEditorCommand: "current callback command",
			opener: async () => {
				reopenCalls += 1;
				return 987654321;
			},
		}),
		/reopened as pid=987654321, but that process exited before the SyncTeX jump/,
	);

	assert.equal(reopenCalls, 1);
	assert.equal(existsSync(callsFile), false);
});

test("jumpToTrackedPdf falls back to an unpinned jump when callback PID cannot be identified after reopen", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const callsFile = join(dir, "calls.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(callsFile)}\nprintf '\\n' >> ${JSON.stringify(callsFile)}\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source, undefined, "old callback command");
	let reopenCalls = 0;
	const result = await jumpToTrackedPdf(trackedPdf.id, 15, undefined, tracker, undefined, {
		command: fakeZathura,
		timeoutMs: 1000,
		synctexEditorCommand: "current callback command",
		opener: async () => {
			reopenCalls += 1;
			return undefined;
		},
	});

	assert.equal(reopenCalls, 1);
	assert.deepEqual(readFileSync(callsFile, "utf8").trim().split("\n"), [
		`--synctex-forward|15:1:${source}|${pdf}|`,
	]);
	assert.deepEqual(result, { pdf, sourceFile: source, line: 15, reopened: true });
	assert.equal(tracker.getById(trackedPdf.id)?.synctexEditorCommand, "current callback command");
});

test("jumpToTrackedPdf reports a clear error when reopening fails", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const source = join(dir, "paper.tex");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(source, "\\documentclass{article}\n");
	writeFileSync(fakeZathura, "#!/bin/sh\necho 'jump failed' >&2\nexit 8\n");
	chmodSync(fakeZathura, 0o700);

	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf(pdf, source);
	await assert.rejects(
		() => jumpToTrackedPdf(trackedPdf.id, 9, undefined, tracker, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			opener: async () => {
				throw new Error("cannot reopen");
			},
		}),
		/appears closed or unavailable.*could not be reopened.*cannot reopen/,
	);
});

test("openPdfInZathura launches zathura with --fork and the PDF path", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--fork", pdf]);
});

test("openPdfInZathura can reuse an existing zathura when requested", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, {
		command: fakeZathura,
		timeoutMs: 1000,
		isAlreadyOpen: () => true,
		reuseExisting: true,
	});

	assert.equal(existsSync(argsFile), false);
});

test("openPdfInZathura returns after zathura --fork parent exits even if viewer keeps stdio open", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n(sleep 0.25) &\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 50 });

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["--fork", pdf]);
});

test("openPdfInZathura returns after detecting a persistent viewer even if zathura stays foreground", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/bash\nexec -a zathura bash -c 'while true; do sleep 30; done' dummy "$@"\n`);
	chmodSync(fakeZathura, 0o700);

	const pid = await openPdfInZathura(pdf, undefined, {
		command: fakeZathura,
		timeoutMs: 1500,
		requirePersistentViewer: true,
	});
	try {
		assert.equal(typeof pid, "number");
		assert.ok(pid! > 0);
	} finally {
		process.kill(pid!, "SIGTERM");
	}
});

test("openPdfInZathura prefers the forked zathura child over the --fork launcher pid", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const launcherPidFile = join(dir, "launcher.pid");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/bash\necho "$$" > ${JSON.stringify(launcherPidFile)}\nnohup bash -c 'exec -a zathura bash -c "while true; do sleep 30; done" dummy --fork "$2"' _ "$1" "$2" >/dev/null 2>&1 < /dev/null &\nsleep 0.05\n`);
	chmodSync(fakeZathura, 0o700);

	let pid: number | undefined;
	try {
		pid = await openPdfInZathura(pdf, undefined, {
			command: fakeZathura,
			timeoutMs: 1500,
			requirePersistentViewer: true,
		});
		assert.equal(typeof pid, "number");
		assert.ok(pid! > 0);

		let launcherPidText = "";
		for (let i = 0; i < 50; i += 1) {
			try {
				launcherPidText = readFileSync(launcherPidFile, "utf8").trim();
				if (launcherPidText) break;
			} catch {
				// Retry until the launcher writes the file.
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(launcherPidText, "did not capture fake launcher PID");
		const launcherPid = Number(launcherPidText);
		assert.ok(Number.isFinite(launcherPid));
		assert.notEqual(pid, launcherPid);
		await waitForProcessArgs(pid!, pdf);
	} finally {
		if (pid !== undefined) {
			process.kill(pid, "SIGTERM");
		}
		try {
			const launcherPid = Number(readFileSync(launcherPidFile, "utf8").trim());
			if (Number.isFinite(launcherPid) && launcherPid !== pid) {
				process.kill(launcherPid, "SIGKILL");
			}
		} catch {
			// Ignore cleanup failures.
		}
	}
});

test("openPdfInZathura wires an inverse SyncTeX editor command when provided", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	const synctexCommand = "node callback.mjs --file '%{input}' --line '%{line}'";
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	await openPdfInZathura(pdf, undefined, {
		command: fakeZathura,
		timeoutMs: 1000,
		synctexEditorCommand: synctexCommand,
	});

	assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
		`--synctex-editor-command=${synctexCommand}`,
		"--fork",
		pdf,
	]);
});

test("openPdfInZathura does not reuse an existing viewer that lacks the current SyncTeX command", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	const synctexCommand = "node callback.mjs --file '%{input}' --line '%{line}'";
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const staleViewer = spawn("bash", ["-c", "exec -a zathura bash -c 'while true; do sleep 30; done' dummy --fork \"$1\"", "bash", pdf], {
		stdio: "ignore",
	});
	try {
		await waitForProcessArgs(staleViewer.pid!, pdf);

		await openPdfInZathura(pdf, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			synctexEditorCommand: synctexCommand,
			reuseExisting: true,
		});

		assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
			`--synctex-editor-command=${synctexCommand}`,
			"--fork",
			pdf,
		]);
	} finally {
		await stopProcess(staleViewer);
	}
});

test("openPdfInZathura reuses an existing viewer that already has the current SyncTeX command", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const argsFile = join(dir, "args.txt");
	const fakeZathura = join(dir, "zathura");
	const synctexCommand = "node callback.mjs --file '%{input}' --line '%{line}'";
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
	chmodSync(fakeZathura, 0o700);

	const currentViewer = spawn("bash", [
		"-c",
		"exec -a zathura bash -c 'while true; do sleep 30; done' dummy \"--synctex-editor-command=$2\" --fork \"$1\"",
		"bash",
		pdf,
		synctexCommand,
	], { stdio: "ignore" });
	try {
		await waitForProcessArgs(currentViewer.pid!, synctexCommand);

		const reusedPid = await openPdfInZathura(pdf, undefined, {
			command: fakeZathura,
			timeoutMs: 1000,
			synctexEditorCommand: synctexCommand,
			reuseExisting: true,
		});

		assert.equal(reusedPid, currentViewer.pid);
		assert.equal(existsSync(argsFile), false);
	} finally {
		await stopProcess(currentViewer);
	}
});

test("openPdfInZathura reports when a required persistent viewer exits immediately", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, "#!/bin/sh\nexit 0\n");
	chmodSync(fakeZathura, 0o700);

	await assert.rejects(
		() => openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000, requirePersistentViewer: true }),
		/zathura exited before a persistent viewer was available/,
	);
});

test("openPdfInZathura surfaces zathura launch failures", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, "#!/bin/sh\necho 'no display' >&2\nexit 7\n");
	chmodSync(fakeZathura, 0o700);

	await assert.rejects(
		() => openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000 }),
		/zathura failed to open .*exited 7[\s\S]*no display/,
	);
});

test("openPdfInZathura does not leave a live child handle after the launch settles", async () => {
	const dir = tempDir();
	const pdf = join(dir, "paper.pdf");
	const fakeZathura = join(dir, "zathura");
	writeMinimalPdf(pdf);
	writeFileSync(fakeZathura, `#!/bin/sh\n(sleep 30) &\nexit 0\n`);
	chmodSync(fakeZathura, 0o700);

	const before = activeChildProcessHandles();
	await openPdfInZathura(pdf, undefined, { command: fakeZathura, timeoutMs: 1000 });
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(activeChildProcessHandles(), before);
});

test("closePdfInZathura sends SIGTERM to matching zathura processes", () => {
	const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const closedPids = closePdfInZathura("/tmp/paper.pdf", {
		findPids: () => [101, 202],
		killProcess: (pid, signal) => killed.push({ pid, signal }),
	});

	assert.deepEqual(closedPids, [101, 202]);
	assert.deepEqual(killed, [
		{ pid: 101, signal: "SIGTERM" },
		{ pid: 202, signal: "SIGTERM" },
	]);
});

test("closeTrackedPdf closes and removes a tracked PDF", () => {
	const tracker = new PdfTracker();
	const trackedPdf = tracker.trackOpenedPdf("/tmp/paper.pdf");
	const result = closeTrackedPdf(trackedPdf.id, tracker, {
		findPids: () => [303],
		killProcess: () => {},
	});

	assert.deepEqual(result, { pdf: "/tmp/paper.pdf", pdfId: trackedPdf.id, closedPids: [303], wasTracked: true });
	assert.equal(tracker.getById(trackedPdf.id), undefined);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), undefined);
});

test("closeTrackedPdf closes only the tracked PID when multiple windows share a PDF path", () => {
	const tracker = new PdfTracker();
	const first = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 101);
	const second = tracker.trackOpenedPdf("/tmp/paper.pdf", undefined, 202);
	const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const result = closeTrackedPdf(first.id, tracker, {
		findPids: () => [101, 202],
		killProcess: (pid, signal) => killed.push({ pid, signal }),
	});

	assert.deepEqual(result, { pdf: "/tmp/paper.pdf", pdfId: first.id, closedPids: [101], wasTracked: true });
	assert.deepEqual(killed, [{ pid: 101, signal: "SIGTERM" }]);
	assert.equal(tracker.getById(first.id), undefined);
	assert.equal(tracker.getById(second.id), second);
	assert.equal(tracker.getByPath("/tmp/paper.pdf"), second);
});

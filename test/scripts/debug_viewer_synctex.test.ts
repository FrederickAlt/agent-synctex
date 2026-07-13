import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const DEBUG_SCRIPT_PATH = resolve("scripts/debug-viewer-synctex.ts");

function compileFixture(baseDir: string, options: { rotatedAndCropped?: boolean; longPageText?: boolean } = {}): string {
	const sourcePath = join(baseDir, "main.tex");
	writeFileSync(sourcePath, String.raw`\documentclass{article}
${options.rotatedAndCropped ? "\\pdfpageattr{/CropBox [10 20 500 700] /Rotate 90}" : ""}
${options.longPageText ? "\\pdfpageheight=60cm\n\\pdfpagewidth=21cm\n\\textheight=55cm" : ""}
\begin{document}
${options.longPageText ? "\\vspace*{45cm}\nOff-screen long-page diagnostic target." : "Viewer diagnostic fixture text for the real PDF.js text layer."}
\end{document}
`);
	const compile = spawnSync("latexmk", ["-norc", "-pdf", "-view=none", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
		cwd: baseDir,
		encoding: "utf8",
	});
	assert.equal(compile.status, 0, `latexmk fixture failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`);
	const pdfPath = join(baseDir, "main.pdf");
	assert.equal(existsSync(pdfPath), true, "compiled fixture PDF should exist");
	return pdfPath;
}

function runDebugViewer(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("node", [DEBUG_SCRIPT_PATH, ...args], {
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

test("development Viewer Host SyncTeX runner validates its required target mode", () => {
	const missingPdf = runDebugViewer(["--out", "/tmp/ignored", "--page", "1", "--x", "1", "--y", "1"]);
	assert.notEqual(missingPdf.status, 0);
	assert.match(`${missingPdf.stdout}${missingPdf.stderr}`, /--pdf/i);

	const incompleteCoordinates = runDebugViewer(["--pdf", "paper.pdf", "--out", "/tmp/ignored", "--page", "1", "--x", "1"]);
	assert.notEqual(incompleteCoordinates.status, 0);
	assert.match(`${incompleteCoordinates.stdout}${incompleteCoordinates.stderr}`, /--page, --x, and --y/i);

	const excessiveInteractiveCapture = runDebugViewer(["--pdf", "paper.pdf", "--out", "/tmp/ignored", "--interactive", "--clicks", "26"]);
	assert.notEqual(excessiveInteractiveCapture.status, 0);
	assert.match(`${excessiveInteractiveCapture.stdout}${excessiveInteractiveCapture.stderr}`, /--clicks.*25/i);
});

test("development Viewer Host SyncTeX runner records an unmocked real viewer probe and deterministic artifacts", { timeout: 60_000 }, () => {
	const baseDir = mkdtempSync(join(tmpdir(), "debug-viewer-synctex-"));
	const outDir = join(baseDir, "artifacts");
	try {
		const pdfPath = compileFixture(baseDir);
		const result = runDebugViewer(["--pdf", pdfPath, "--out", outDir, "--page", "1", "--x", "280", "--y", "180"]);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const jsonPath = join(outDir, "viewer-synctex-diagnostic.json");
		const summaryPath = join(outDir, "summary.txt");
		assert.equal(existsSync(jsonPath), true);
		assert.equal(existsSync(summaryPath), true);
		assert.equal(existsSync(join(outDir, "before.png")), true);
		assert.equal(existsSync(join(outDir, "after.png")), true);
		assert.equal(statSync(outDir).mode & 0o777, 0o700, "artifact directory should be private");
		for (const artifactPath of [jsonPath, summaryPath, join(outDir, "before.png"), join(outDir, "after.png")]) {
			assert.equal(statSync(artifactPath).mode & 0o777, 0o600, `${artifactPath} should be private`);
		}
		const artifact = JSON.parse(readFileSync(jsonPath, "utf8")) as {
			input: { pdf: string; out: string; mode: string };
			clicks: Array<{ target: { page: number; pdf: { x: number; y: number } }; forced: boolean; dispatch_target?: { tag?: string; page?: number }; elements_from_point: unknown[]; client_rects: unknown; pdf_rects: unknown }>;
			probes: Array<{
				request: { headers: Record<string, string>; body: { type?: string; pdf_id?: number; x?: number; y?: number } }; 
				proposal_provenance?: string[];
				response?: { body?: { ok?: boolean; result?: { type?: string; debug_forward_groups?: unknown[] } } };
			}>;
			browser: { console: unknown[]; page_errors: unknown[]; request_failures: unknown[] };
		};
		assert.deepEqual(artifact.input, { pdf: pdfPath, out: outDir, mode: "coordinates", page: 1, x: 280, y: 180 });
		assert.equal(artifact.clicks.length, 1);
		assert.equal(artifact.clicks[0]?.target.page, 1);
		assert.equal(artifact.clicks[0]?.forced, true, "automated coordinate mode should force the real viewer handler path");
		assert.equal(artifact.clicks[0]?.dispatch_target?.tag, "div");
		assert.equal(artifact.clicks[0]?.dispatch_target?.page, 1);
		assert.ok(Math.abs(Number(artifact.clicks[0]?.target.pdf.x) - 280) < 1, "runner should convert through the live PDF.js viewport");
		assert.ok(Array.isArray(artifact.clicks[0]?.elements_from_point));
		assert.equal(typeof artifact.clicks[0]?.client_rects, "object");
		assert.equal(typeof artifact.clicks[0]?.pdf_rects, "object");
		assert.equal(artifact.probes.length, 1, "runner should capture one real browser probe");
		assert.equal(artifact.probes[0]?.request.body.type, "reverse_synctex_forward_probe");
		assert.equal(artifact.probes[0]?.request.body.pdf_id, 1);
		assert.ok(Math.abs(Number(artifact.probes[0]?.request.body.x) - 280) < 1, "probe x should round-trip the CLI coordinate");
		assert.ok(Math.abs(Number(artifact.probes[0]?.request.body.y) - 180) < 1, "probe y should round-trip the CLI coordinate");
		assert.equal(artifact.probes[0]?.request.headers["x-agent-synctex-viewer-token"], "[redacted]");
		assert.equal(artifact.probes[0]?.response?.body?.ok, true);
		assert.equal(artifact.probes[0]?.response?.body?.result?.type, "reverse_synctex_forward_probe_result");
		assert.ok(Array.isArray(artifact.probes[0]?.response?.body?.result?.debug_forward_groups), "runner enables hidden diagnostics through the Host control channel");
			assert.deepEqual(artifact.probes[0]?.proposal_provenance, ["synctex_reverse"], "artifacts should distinguish source proposal provenance from box-group flavor");
		const summary = readFileSync(summaryPath, "utf8");
		assert.match(summary, /selected source:/);
		assert.match(summary, /selected group:.*semantic penalty.*score/);
		assert.ok(Array.isArray(artifact.browser.console));
		assert.ok(Array.isArray(artifact.browser.page_errors));
		assert.ok(Array.isArray(artifact.browser.request_failures));

		const textOutDir = join(baseDir, "text-artifacts");
		const textResult = runDebugViewer(["--pdf", pdfPath, "--out", textOutDir, "--text", "Viewer diagnostic fixture text", "--page", "1"]);
		assert.equal(textResult.status, 0, textResult.stderr || textResult.stdout);
		const textArtifact = JSON.parse(readFileSync(join(textOutDir, "viewer-synctex-diagnostic.json"), "utf8")) as { input: { mode: string; text?: string }; clicks: Array<{ matched_text?: string; forced?: boolean }>; probes: unknown[] };
		assert.equal(textArtifact.input.mode, "text");
		assert.equal(textArtifact.input.text, "Viewer diagnostic fixture text");
		assert.match(textArtifact.clicks[0]?.matched_text ?? "", /Viewer diagnostic fixture text/);
		assert.equal(textArtifact.clicks[0]?.forced, true, "text mode should also force the page-target viewer click");
		assert.equal(textArtifact.probes.length, 1);

		const offscreenOutDir = join(baseDir, "offscreen-artifacts");
		const offscreenResult = runDebugViewer(["--pdf", pdfPath, "--out", offscreenOutDir, "--page", "1", "--x", "280", "--y", "720"]);
		assert.equal(offscreenResult.status, 0, offscreenResult.stderr || offscreenResult.stdout);
		const offscreenArtifact = JSON.parse(readFileSync(join(offscreenOutDir, "viewer-synctex-diagnostic.json"), "utf8")) as {
			clicks: Array<{ target: { pdf: { x: number; y: number } } }>;
			probes: Array<{ request: { body: { x?: number; y?: number } } }>;
		};
		assert.ok(Math.abs(Number(offscreenArtifact.clicks[0]?.target.pdf.x) - 280) < 1, "off-screen x should survive viewport conversion");
		assert.ok(Math.abs(Number(offscreenArtifact.clicks[0]?.target.pdf.y) - 720) < 1, "off-screen y should survive viewport conversion");
		assert.ok(Math.abs(Number(offscreenArtifact.probes[0]?.request.body.x) - 280) < 1);
		assert.ok(Math.abs(Number(offscreenArtifact.probes[0]?.request.body.y) - 720) < 1);

		const rotatedDir = join(baseDir, "rotated");
		mkdirSync(rotatedDir);
		const rotatedPdfPath = compileFixture(rotatedDir, { rotatedAndCropped: true });
		const rotatedOutDir = join(rotatedDir, "artifacts");
		const rotatedResult = runDebugViewer(["--pdf", rotatedPdfPath, "--out", rotatedOutDir, "--page", "1", "--x", "280", "--y", "180"]);
		assert.equal(rotatedResult.status, 0, rotatedResult.stderr || rotatedResult.stdout);
		const rotatedArtifact = JSON.parse(readFileSync(join(rotatedOutDir, "viewer-synctex-diagnostic.json"), "utf8")) as {
			clicks: Array<{ target: { pdf: { x: number; y: number } }; pdf_rects: { view_box: number[]; viewport: { rotation?: number } } }>;
			probes: Array<{ request: { body: { x?: number; y?: number } } }>;
		};
		assert.deepEqual(rotatedArtifact.clicks[0]?.pdf_rects.view_box.slice(0, 2), [10, 20], "fixture should exercise a non-zero PDF.js viewBox");
		assert.equal(rotatedArtifact.clicks[0]?.pdf_rects.viewport.rotation, 90, "fixture should exercise a rotated viewport");
		assert.ok(Math.abs(Number(rotatedArtifact.clicks[0]?.target.pdf.x) - 280) < 1, "rotated x should round-trip through the production inverse");
		assert.ok(Math.abs(Number(rotatedArtifact.clicks[0]?.target.pdf.y) - 180) < 1, "rotated y should round-trip through the production inverse");
		assert.ok(Math.abs(Number(rotatedArtifact.probes[0]?.request.body.x) - 280) < 1);
		assert.ok(Math.abs(Number(rotatedArtifact.probes[0]?.request.body.y) - 180) < 1);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("text mode scrolls an off-screen matching span into the real viewer viewport before capture", { timeout: 60_000 }, () => {
	const baseDir = mkdtempSync(join(tmpdir(), "debug-viewer-synctex-long-page-"));
	try {
		const pdfPath = compileFixture(baseDir, { longPageText: true });
		const outDir = join(baseDir, "artifacts");
		const result = runDebugViewer(["--pdf", pdfPath, "--out", outDir, "--text", "Off-screen long-page diagnostic target", "--page", "1"]);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const artifact = JSON.parse(readFileSync(join(outDir, "viewer-synctex-diagnostic.json"), "utf8")) as {
			clicks: Array<{ matched_text?: string; forced?: boolean; target: { client: { x: number; y: number } } }>;
			probes: unknown[];
		};
		assert.match(artifact.clicks[0]?.matched_text ?? "", /Off-screen long-page diagnostic target/);
		assert.equal(artifact.clicks[0]?.forced, true);
		assert.ok(Number.isFinite(artifact.clicks[0]?.target.client.x));
		assert.ok(Number.isFinite(artifact.clicks[0]?.target.client.y));
		assert.equal(artifact.probes.length, 1, "off-screen text should be scrolled into the live viewer before capture and dispatch");
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("package build excludes the development Viewer Host SyncTeX runner", { timeout: 30_000 }, () => {
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
	assert.equal(packageJson.scripts?.["debug:viewer-synctex"], undefined, "published package metadata must not advertise the source-tree diagnostic runner");
	const build = spawnSync("node", ["scripts/build-package.ts"], { encoding: "utf8" });
	assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
	assert.equal(existsSync(resolve("dist/scripts/debug-viewer-synctex.js")), false, "development diagnostic runner must not be emitted into dist");
	assert.equal(existsSync(resolve("dist/scripts/agent-synctex.js")), true, "production CLI should still be packaged");
});

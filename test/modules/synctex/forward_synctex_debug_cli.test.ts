import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { mapForwardSynctex } from "../../../src/modules/synctex/forward_synctex.ts";

const DEBUG_SCRIPT_PATH = resolve("scripts/debug-forward-synctex.ts");

interface DiagnosticMetadata {
	readonly input: {
		readonly pdf: string;
		readonly source: string;
		readonly line: number;
		readonly out: string;
	};
	readonly mapping: {
		readonly page: number;
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
		readonly sourceFile: string;
		readonly sidecarPath: string;
	};
	readonly artifacts: {
		readonly fullPagePng: string;
		readonly overlayPng: string;
		readonly cropPng: string;
		readonly metadataJson: string;
	};
}

function commandExists(command: string): boolean {
	const probe = spawnSync("which", [command], { stdio: "ignore" });
	return !probe.error && probe.status === 0;
}

function runDebugCli(args: string[], cwd = process.cwd()): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("node", [DEBUG_SCRIPT_PATH, ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 5 * 1024 * 1024,
	});
	return {
		status: result.status,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	};
}

function compileFixture(): { dir: string; pdfPath: string; sourcePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "forward-synctex-debug-cli-"));
	const sourcePath = join(dir, "main.tex");
	const pdfPath = join(dir, "main.pdf");
	const source = [
		"\\documentclass{article}",
		"\\begin{document}",
		"First forward-diagnostic line for line-based mapping.",
		"Second line should compile to the same page.",
		"\\end{document}",
		"",
	].join("\n");
	writeFileSync(sourcePath, source);
	const compile = spawnSync("latexmk", ["-norc", "-pdf", "-view=none", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "main.tex"], {
		cwd: dir,
		encoding: "utf8",
	});
	assert.equal(compile.status, 0, `latexmk compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`);
	assert.equal(existsSync(pdfPath), true, "compiled PDF should exist");
	assert.equal(existsSync(join(dir, "main.synctex.gz")) || existsSync(join(dir, "main.synctex")), true, "compiled syncTeX sidecar should exist");
	return { dir, pdfPath, sourcePath };
}

function debugSkipReason(): string | undefined {
	for (const command of ["latexmk", "pdflatex", "magick"] as const) {
		if (!commandExists(command)) return `requires ${command} on PATH`;
	}
	if (!(commandExists("pdftoppm") || commandExists("pdftocairo"))) {
		return "requires pdftoppm or pdftocairo on PATH";
	}
	return undefined;
}

test("debug forward SyncTeX CLI validates required arguments", () => {
	const noPdf = runDebugCli(["--source", "paper.tex", "--line", "3", "--out", "/tmp/ignored"]);
	assert.notEqual(noPdf.status, 0);
	const output = `${noPdf.stdout}${noPdf.stderr}`;
	assert.match(output, /--pdf/i);

	const nonNumericLine = runDebugCli(["--pdf", "paper.pdf", "--source", "paper.tex", "--line", "abc", "--out", "/tmp/ignored"]);
	assert.notEqual(nonNumericLine.status, 0);
	const output2 = `${nonNumericLine.stdout}${nonNumericLine.stderr}`;
	assert.match(output2, /line.*must be.*integer/i);

	const badDpi = runDebugCli(["--pdf", "paper.pdf", "--source", "paper.tex", "--line", "3", "--dpi", "11", "--out", "/tmp/ignored"]);
	assert.notEqual(badDpi.status, 0);
	const output3 = `${badDpi.stdout}${badDpi.stderr}`;
	assert.match(output3, /dpi.*must be/i);
});

test("debug forward SyncTeX CLI writes JSON and PNG artifacts for a compiled fixture", debugSkipReason() ? { skip: debugSkipReason() } : {}, () => {
	const fixture = compileFixture();
	const outDir = join(fixture.dir, "diagnostic");
	const line = 3;
	const jump = mapForwardSynctex({ pdfPath: fixture.pdfPath, sourceFile: fixture.sourcePath, line, cwd: fixture.dir });
	const expectedLine = `forward-synctex-line-${line}`;
	try {
		const result = runDebugCli(["--pdf", fixture.pdfPath, "--source", fixture.sourcePath, "--line", String(line), "--out", outDir]);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const metadataPath = join(outDir, `${expectedLine}-diagnostic.json`);
		assert.equal(existsSync(metadataPath), true, `metadata artifact should exist at ${metadataPath}`);

		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as DiagnosticMetadata;
		assert.equal(metadata.input.pdf, resolve(fixture.pdfPath));
		assert.equal(metadata.input.source, resolve(fixture.sourcePath));
		assert.equal(metadata.input.line, line);
		assert.equal(metadata.mapping.page, jump.page);
		assert.equal(metadata.mapping.sourceFile, jump.sourceFile);
		assert.equal(metadata.mapping.sidecarPath, jump.sidecarPath);
		assert.equal(metadata.mapping.x, jump.x);
		assert.equal(metadata.mapping.y, jump.y);
		assert.equal(metadata.mapping.width, jump.width);
		assert.equal(metadata.mapping.height, jump.height);

		assert.equal(existsSync(metadata.artifacts.fullPagePng), true, "full-page PNG should exist");
		assert.equal(existsSync(metadata.artifacts.overlayPng), true, "overlay PNG should exist");
		assert.equal(existsSync(metadata.artifacts.cropPng), true, "crop PNG should exist");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

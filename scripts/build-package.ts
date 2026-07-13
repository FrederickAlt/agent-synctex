#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const outDir = join(repoRoot, "dist");
const tsRoots = [
	"scripts/agent-synctex.ts",
	"scripts/viewer-host-server.ts",
	"scripts/debug-forward-synctex.ts",
	"src",
];
const developmentOnlyOutputs = ["scripts/debug-viewer-synctex.js"];
const copyRoots = ["src"];
const ignoredDirectoryNames = new Set(["node_modules", ".git", "__pycache__", "dist"]);
const ignoredExtensions = new Set([".pyc"]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const root of tsRoots) {
	const absoluteRoot = join(repoRoot, root);
	if (statSync(absoluteRoot).isDirectory()) {
		for (const file of walk(absoluteRoot)) {
			if (file.endsWith(".ts")) compileTypeScriptFile(file);
		}
	} else {
		compileTypeScriptFile(absoluteRoot);
	}
}

for (const root of copyRoots) {
	const absoluteRoot = join(repoRoot, root);
	for (const file of walk(absoluteRoot)) {
		if (file.endsWith(".ts")) continue;
		if (ignoredExtensions.has(extname(file))) continue;
		copyAsset(file);
	}
}

for (const developmentOnlyOutput of developmentOnlyOutputs) {
	if (existsInDist(developmentOnlyOutput)) {
		throw new Error(`Development-only diagnostic runner must not be packaged: ${developmentOnlyOutput}`);
	}
}

for (const bin of ["scripts/agent-synctex.js"]) {
	const path = join(outDir, bin);
	chmodSync(path, 0o755);
}

function existsInDist(relativePath: string): boolean {
	try {
		return statSync(join(outDir, relativePath)).isFile();
	} catch {
		return false;
	}
}

function compileTypeScriptFile(path: string): void {
	const relativePath = relative(repoRoot, path);
	const outPath = join(outDir, relativePath.replace(/\.ts$/, ".js"));
	const source = readFileSync(path, "utf8");
	const result = ts.transpileModule(source, {
		fileName: path,
		compilerOptions: {
			target: ts.ScriptTarget.ES2024,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			sourceMap: false,
			inlineSources: false,
			importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
		},
	});
	const output = rewriteTsSpecifiers(result.outputText);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, output);
}

function copyAsset(path: string): void {
	const relativePath = relative(repoRoot, path);
	const outPath = join(outDir, relativePath);
	mkdirSync(dirname(outPath), { recursive: true });
	copyFileSync(path, outPath);
}

function* walk(directory: string): Generator<string> {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (ignoredDirectoryNames.has(entry.name)) continue;
			yield* walk(path);
		} else if (!ignoredExtensions.has(extname(entry.name))) {
			yield path;
		}
	}
}

function rewriteTsSpecifiers(output: string): string {
	return output
		.replace(/(["'](?:\.\.?\/)[^"']+)\.ts(["'])/g, "$1.js$2")
		.replace(/(import\s*\(\s*["'][^"']+)\.ts(["']\s*\))/g, "$1.js$2");
}

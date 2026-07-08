import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface RootPreamble {
	rootFile: string;
	preamble: string;
	files: string[];
	missing: Array<{ fromFile: string; requested: string }>;
	facts: LatexFacts;
}

export interface LatexFacts {
	documentClass: { name: string; options?: string } | null;
	packages: Array<{ name: string; options?: string }>;
	commands: string[];
	theoremEnvs: string[];
	environments: string[];
}

class TimeoutError extends Error {}

class Deadline {
	private readonly end: number;

	constructor(timeoutMs: number) {
		this.end = Date.now() + timeoutMs;
	}

	check(): void {
		if (Date.now() > this.end) throw new TimeoutError("scan timed out");
	}
}

export class LatexPreambleIndex {
	readonly cwd: string;
	readonly roots: RootPreamble[];
	readonly timedOut: boolean;
	readonly errors: string[];

	constructor(cwd: string, roots: RootPreamble[], timedOut: boolean, errors: string[]) {
		this.cwd = cwd;
		this.roots = roots;
		this.timedOut = timedOut;
		this.errors = errors;
	}

	listRoots(): string[] {
		return this.roots.map((root) => root.rootFile);
	}

	getRoot(rootFile: string): RootPreamble {
		const abs = path.resolve(this.cwd, rootFile);
		const exact = this.roots.find((root) => root.rootFile === abs);
		if (exact) return exact;

		const relMatches = this.roots.filter((root) => path.relative(this.cwd, root.rootFile) === rootFile);
		if (relMatches.length === 1) return relMatches[0];

		const baseMatches = this.roots.filter((root) => path.basename(root.rootFile) === rootFile);
		if (baseMatches.length === 1) return baseMatches[0];
		if (baseMatches.length > 1) {
			throw new Error(
				`Ambiguous root basename ${rootFile}. Use one of: ${baseMatches.map((root) => path.relative(this.cwd, root.rootFile)).join(", ")}`,
			);
		}

		throw new Error(
			`Unknown root ${rootFile}. Available: ${this.roots.map((root) => path.relative(this.cwd, root.rootFile)).join(", ")}`,
		);
	}

	getPreamble(rootFile: string): string {
		return this.getRoot(rootFile).preamble;
	}
}

export function buildLatexPreambleIndex(cwd = process.cwd(), timeoutMs = 5_000): LatexPreambleIndex {
	const absCwd = path.resolve(cwd);
	const deadline = new Deadline(timeoutMs);
	const roots: RootPreamble[] = [];
	const errors: string[] = [];
	let timedOut = false;

	try {
		const texFiles = discoverTexFiles(absCwd, deadline);
		const rootFiles = texFiles.filter((file) => {
			try {
				return isLikelyRootFile(file, absCwd, deadline);
			} catch (error) {
				if (error instanceof TimeoutError) throw error;
				errors.push(`${path.relative(absCwd, file)}: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
		});

		for (const rootFile of rootFiles) {
			deadline.check();
			roots.push(collectPreambleForRoot(rootFile, absCwd, deadline));
		}
	} catch (error) {
		if (error instanceof TimeoutError) timedOut = true;
		else errors.push(error instanceof Error ? error.message : String(error));
	}

	return new LatexPreambleIndex(absCwd, roots, timedOut, errors);
}

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
]);

function discoverTexFiles(dir: string, deadline: Deadline): string[] {
	const out: string[] = [];

	function walk(current: string): void {
		deadline.check();
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			deadline.check();
			if (entry.name.startsWith(".")) continue;
			if (entry.isSymbolicLink()) continue;

			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".tex")) {
				out.push(full);
			}
		}
	}

	walk(dir);
	return out.sort();
}

function isLikelyRootFile(file: string, cwd: string, deadline: Deadline): boolean {
	deadline.check();
	const rootText = readTexFile(file).split("\n").map(stripTexComment).join("\n");
	if (!/\\begin\s*\{\s*document\s*\}/.test(rootText)) {
		return false;
	}
	return collectPreambleForRoot(file, cwd, deadline).facts.documentClass !== null;
}

function collectPreambleForRoot(rootFile: string, cwd: string, deadline: Deadline): RootPreamble {
	const ctx = {
		cwd,
		done: false,
		braceDepth: 0,
		parts: [] as string[],
		files: [] as string[],
		missing: [] as Array<{ fromFile: string; requested: string }>,
		visiting: new Set<string>(),
	};

	processFile(path.resolve(rootFile), ctx, deadline);
	const preamble = ctx.parts.join("");
	return {
		rootFile: path.resolve(rootFile),
		preamble,
		files: ctx.files,
		missing: ctx.missing,
		facts: extractLatexFacts(preamble),
	};
}

function processFile(
	file: string,
	ctx: {
		cwd: string;
		done: boolean;
		braceDepth: number;
		parts: string[];
		files: string[];
		missing: Array<{ fromFile: string; requested: string }>;
		visiting: Set<string>;
	},
	deadline: Deadline,
): void {
	if (ctx.done) return;
	deadline.check();
	const abs = path.resolve(file);
	if (ctx.visiting.has(abs)) return;

	ctx.visiting.add(abs);
	ctx.files.push(abs);
	const text = readTexFile(abs);
	const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];

	for (const rawLine of lines) {
		if (ctx.done) break;
		deadline.check();
		const detectionLine = stripTexComment(rawLine);
		if (/^\s*\\endinput\b/.test(detectionLine)) break;
		processLine(rawLine, abs, ctx, deadline);
	}

	ctx.visiting.delete(abs);
}

function processLine(
	rawLine: string,
	currentFile: string,
	ctx: {
		cwd: string;
		done: boolean;
		braceDepth: number;
		parts: string[];
		files: string[];
		missing: Array<{ fromFile: string; requested: string }>;
		visiting: Set<string>;
	},
	deadline: Deadline,
): void {
	const detectionLine = stripTexComment(rawLine);
	let segmentStart = 0;

	for (let i = 0; i < detectionLine.length && !ctx.done;) {
		const ch = detectionLine[i];
		if (ch === "\\") {
			const cmd = readCommand(detectionLine, i);
			if (!cmd) {
				i++;
				continue;
			}

			if (ctx.braceDepth === 0 && cmd.name === "begin") {
				const arg = readBraced(detectionLine, cmd.end);
				if (arg?.value.trim() === "document") {
					ctx.parts.push(rawLine.slice(segmentStart, i));
					ctx.done = true;
					return;
				}
			}

			if (ctx.braceDepth === 0 && (cmd.name === "input" || cmd.name === "include")) {
				const arg = readInputArg(detectionLine, cmd.end);
				if (arg) {
					const resolved = resolveTexFile(arg.value, path.dirname(currentFile), ctx.cwd, cmd.name === "include");
					if (resolved) {
						ctx.parts.push(rawLine.slice(segmentStart, i));
						processFile(resolved, ctx, deadline);
						i = arg.end;
						segmentStart = arg.end;
						continue;
					}
					ctx.missing.push({ fromFile: currentFile, requested: arg.value });
					i = arg.end;
					continue;
				}
			}

			if (ctx.braceDepth === 0 && (isImportLikeInput(cmd.name) || isImportLikeInclude(cmd.name))) {
				const dirArg = readInputArg(detectionLine, cmd.end);
				const fileArg = dirArg ? readInputArg(detectionLine, dirArg.end) : null;
				if (dirArg && fileArg) {
					const base = path.resolve(path.dirname(currentFile), unquoteLatexFilename(dirArg.value));
					const resolved = resolveTexFile(fileArg.value, base, ctx.cwd, isImportLikeInclude(cmd.name));
					if (resolved) {
						ctx.parts.push(rawLine.slice(segmentStart, i));
						processFile(resolved, ctx, deadline);
						i = fileArg.end;
						segmentStart = fileArg.end;
						continue;
					}
					ctx.missing.push({ fromFile: currentFile, requested: `${dirArg.value}${fileArg.value}` });
					i = fileArg.end;
					continue;
				}
			}

			i = cmd.end;
			continue;
		}

		if (ch === "{") ctx.braceDepth++;
		else if (ch === "}" && ctx.braceDepth > 0) ctx.braceDepth--;
		i++;
	}

	if (!ctx.done && segmentStart < rawLine.length) {
		ctx.parts.push(rawLine.slice(segmentStart));
	}
}

function isImportLikeInput(name: string): boolean {
	return ["import", "subimport", "inputfrom", "subinputfrom"].includes(name);
}

function isImportLikeInclude(name: string): boolean {
	return ["includefrom", "subincludefrom"].includes(name);
}

function readTexFile(file: string): string {
	const st = fs.statSync(file);
	if (!st.isFile()) throw new Error("not a file");
	if (st.size > 10 * 1024 * 1024) throw new Error("file too large");
	return fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

function stripTexComment(line: string): string {
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "%") continue;
		let backslashes = 0;
		for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
		if (backslashes % 2 === 0) return line.slice(0, i);
	}
	return line;
}

function skipWs(s: string, i: number): number {
	while (i < s.length && /\s/.test(s[i])) i++;
	return i;
}

function readCommand(s: string, i: number): { name: string; end: number } | null {
	if (s[i] !== "\\") return null;
	const start = i + 1;
	if (/[A-Za-z@]/.test(s[start] ?? "")) {
		let j = start;
		while (j < s.length && /[A-Za-z@]/.test(s[j])) j++;
		return { name: s.slice(start, j), end: j };
	}
	return { name: s[start] ?? "", end: Math.min(start + 1, s.length) };
}

function readBraced(s: string, i: number): { value: string; end: number } | null {
	i = skipWs(s, i);
	if (s[i] !== "{") return null;
	let depth = 0;
	const start = i + 1;
	for (let j = i; j < s.length; j++) {
		if (s[j] === "\\") {
			j++;
			continue;
		}
		if (s[j] === "{") depth++;
		else if (s[j] === "}") depth--;
		if (depth === 0) return { value: s.slice(start, j).trim(), end: j + 1 };
	}
	return null;
}

function readInputArg(s: string, i: number): { value: string; end: number } | null {
	i = skipWs(s, i);
	if (s[i] === "{") return readBraced(s, i);
	if (s[i] === '"') {
		let j = i + 1;
		while (j < s.length && s[j] !== '"') j++;
		if (j >= s.length) return null;
		return { value: s.slice(i, j + 1), end: j + 1 };
	}
	const start = i;
	while (i < s.length && !/\s/.test(s[i]) && s[i] !== "%") i++;
	if (i === start) return null;
	return { value: s.slice(start, i).trim(), end: i };
}

function unquoteLatexFilename(name: string): string {
	name = name.trim();
	if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
		name = name.slice(1, -1);
	}
	return name.replaceAll("\\space ", " ");
}

function resolveTexFile(requested: string, baseDir: string, cwd: string, includeStyle: boolean): string | null {
	const name = unquoteLatexFilename(requested);
	const variants = includeStyle
		? [path.extname(name) ? name : `${name}.tex`]
		: path.extname(name) ? [name] : [name, `${name}.tex`];
	const dirs = buildSearchDirs(baseDir, cwd);

	for (const variant of variants) {
		if (path.isAbsolute(variant) && isFile(variant)) return path.resolve(variant);
		for (const dir of dirs) {
			const candidate = path.resolve(dir, variant);
			if (isFile(candidate)) return candidate;
		}
	}

	if (process.env.LATEX_PREAMBLE_USE_KPSEWHICH === "1") {
		for (const variant of variants) {
			const hit = spawnSync("kpsewhich", [variant], {
				encoding: "utf8",
				timeout: 150,
				stdio: ["ignore", "pipe", "ignore"],
			}).stdout?.trim();
			if (hit && isFile(hit)) return path.resolve(hit);
		}
	}

	return null;
}

function buildSearchDirs(baseDir: string, cwd: string): string[] {
	const dirs = [baseDir, cwd];
	for (const part of (process.env.TEXINPUTS ?? "").split(path.delimiter)) {
		if (part) dirs.push(path.resolve(cwd, part));
	}
	return [...new Set(dirs)];
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export function extractLatexFacts(preamble: string): LatexFacts {
	const text = preamble.split("\n").map(stripTexComment).join("\n");
	const documentClassMatch = /\\documentclass(?:\s*\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(text);
	const packages: LatexFacts["packages"] = [];
	const commands = new Set<string>();
	const theoremEnvs = new Set<string>();
	const environments = new Set<string>();

	for (const match of text.matchAll(/\\(?:usepackage|RequirePackage)(?:\s*\[([^\]]*)\])?\s*\{([^}]*)\}/g)) {
		const options = match[1]?.trim() || undefined;
		for (const name of match[2].split(",").map((x) => x.trim()).filter(Boolean)) {
			packages.push({ name, options });
		}
	}

	const commandPatterns = [
		/\\(?:re)?newcommand\*?\s*(?:\{\\([A-Za-z@]+)\}|\\([A-Za-z@]+))/g,
		/\\(?:providecommand|renewcommand)\*?\s*(?:\{\\([A-Za-z@]+)\}|\\([A-Za-z@]+))/g,
		/\\DeclareRobustCommand\*?\s*(?:\{\\([A-Za-z@]+)\}|\\([A-Za-z@]+))/g,
		/\\(?:NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand)\s*\{\\([A-Za-z@]+)\}/g,
		/\\DeclareMathOperator\*?\s*\{\\([A-Za-z@]+)\}/g,
		/\\DeclarePairedDelimiter\s*\{\\([A-Za-z@]+)\}/g,
	];

	for (const re of commandPatterns) {
		for (const match of text.matchAll(re)) {
			const name = match[1] ?? match[2];
			if (name) commands.add(`\\${name}`);
		}
	}

	for (const match of text.matchAll(/\\newtheorem\*?\s*\{([^}]*)\}/g)) {
		theoremEnvs.add(match[1].trim());
	}

	const envPatterns = [
		/\\(?:newenvironment|renewenvironment)\*?\s*\{([^}]*)\}/g,
		/\\(?:NewDocumentEnvironment|RenewDocumentEnvironment|DeclareDocumentEnvironment)\s*\{([^}]*)\}/g,
	];
	for (const re of envPatterns) {
		for (const match of text.matchAll(re)) environments.add(match[1].trim());
	}

	return {
		documentClass: documentClassMatch
			? { name: documentClassMatch[2].trim(), options: documentClassMatch[1]?.trim() || undefined }
			: null,
		packages,
		commands: [...commands].sort(),
		theoremEnvs: [...theoremEnvs].sort(),
		environments: [...environments].sort(),
	};
}

function usage(): void {
	console.error(`Usage:
  tsx latex-preamble-index.ts list
  tsx latex-preamble-index.ts get <root.tex>
  tsx latex-preamble-index.ts facts <root.tex>

Env:
  LATEX_PREAMBLE_TIMEOUT_MS=5000
  LATEX_PREAMBLE_USE_KPSEWHICH=1
`);
}

function main(): void {
	const timeoutMs = Number(process.env.LATEX_PREAMBLE_TIMEOUT_MS ?? "5000");
	const index = buildLatexPreambleIndex(process.cwd(), timeoutMs);
	const cmd = process.argv[2] ?? "list";
	const root = process.argv[3];

	if (cmd === "list") {
		for (const rootPreamble of index.roots) {
			console.log([
				path.relative(index.cwd, rootPreamble.rootFile),
				`packages=${rootPreamble.facts.packages.length}`,
				`commands=${rootPreamble.facts.commands.length}`,
				`files=${rootPreamble.files.length}`,
			].join("\t"));
		}
		if (index.timedOut) console.error("warning: scan timed out; result is partial");
		for (const error of index.errors) console.error(`error: ${error}`);
		return;
	}

	if (cmd === "get") {
		if (!root) {
			usage();
			process.exit(2);
		}
		process.stdout.write(index.getPreamble(root));
		return;
	}

	if (cmd === "facts") {
		if (!root) {
			usage();
			process.exit(2);
		}
		console.log(JSON.stringify(index.getRoot(root).facts, null, 2));
		return;
	}

	usage();
	process.exit(2);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}

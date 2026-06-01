import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

interface GuardrailViolation {
	file: string;
	line: number;
	column: number;
	detail: string;
}

const REPO_ROOT = process.cwd();
const EXCLUDED_DIRS = new Set([
	".git",
	"node_modules",
	"tmp",
	"docs",
	"types",
	"scripts",
	"systemd",
]);

const FORBIDDEN_LEGACY_IDENTIFIERS = new Map<string, string>([
	["PDF_PREVIEW_ZATHURA_LEGACY", "legacy zathura constant"],
	["openPdfInZathura", "legacy direct viewer-open helper"],
	["closePdfInZathura", "legacy direct viewer-close helper"],
	["zathuraPidsForPdf", "legacy direct viewer PID discovery helper"],
]);

const FORBIDDEN_VIEWER_COMMAND = /\b(?:zathura|evince|okular|mupdf|sioyek|xreader|xdg-open|xpdf|atril)\b/i;
const FORBIDDEN_ENV_PROBES = new Set(["DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "XAUTHORITY", "DISPLAY"]);

function collectProductionTypeScriptFiles(directory = REPO_ROOT): string[] {
	const collected: string[] = [];
	const entries = readdirSync(directory, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry.name)) continue;
			collected.push(...collectProductionTypeScriptFiles(absolutePath));
			continue;
		}

		if (!entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
		collected.push(absolutePath);
	}

	return collected;
}

function toLineColumn(source: string, pos: number): { line: number; column: number } {
	const lines = source.slice(0, pos).split(/\r?\n/);
	const line = lines.length;
	const column = lines[lines.length - 1]!.length + 1;
	return { line, column };
}

function addViolation(
	violations: GuardrailViolation[],
	source: string,
	file: string,
	pos: number,
	detail: string,
): void {
	const { line, column } = toLineColumn(source, pos);
	violations.push({ file, line, column, detail });
}

function collectForbiddenIdentifierViolations(file: string, source: string): GuardrailViolation[] {
	const violations: GuardrailViolation[] = [];

	for (const [identifier, detail] of FORBIDDEN_LEGACY_IDENTIFIERS) {
		const re = new RegExp(`\\b${identifier}\\b`, "g");
		for (const match of source.matchAll(re)) {
			if (match.index === undefined) continue;
			addViolation(violations, source, file, match.index, `${detail}: ${identifier}`);
		}
	}

	const procMatch = /\/proc(?:\/|\b)/g;
	for (const match of source.matchAll(procMatch)) {
		if (match.index === undefined) continue;
		addViolation(violations, source, file, match.index, "process discovery from /proc");
	}

	return violations;
}

function isProcessEnvAccess(node: ts.Node): string | undefined {
	if (ts.isPropertyAccessExpression(node)) {
		if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(node.expression)) {
			const envAccess = node.expression;
			if (ts.isIdentifier(envAccess.expression) && envAccess.expression.text === "process" && ts.isIdentifier(envAccess.name) && envAccess.name.text === "env") {
				return node.name.text;
			}
		}
	}

	if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
		const envAccess = node.expression;
		if (ts.isIdentifier(envAccess.expression) && envAccess.expression.text === "process" && ts.isIdentifier(envAccess.name) && envAccess.name.text === "env") {
			if (ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
			if (ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) return node.argumentExpression.text;
		}
	}

	return undefined;
}

function collectForbiddenSpawnViolations(file: string, source: string): GuardrailViolation[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
	const violations: GuardrailViolation[] = [];
	const importedSpawnAliases = new Map<string, "spawn" | "spawnSync">();
	const childProcessNamespaceAliases = new Set<string>();
	const literalCommandAliases = new Map<string, string>();

	function isChildProcessModuleSpecifier(moduleSpecifier: string): boolean {
		return moduleSpecifier === "node:child_process" || moduleSpecifier === "child_process";
	}

	function commandText(expression: ts.Expression): string | undefined {
		if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
			return expression.text;
		}
		if (ts.isTemplateExpression(expression)) {
			return [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)].join("");
		}
		if (ts.isIdentifier(expression)) {
			return literalCommandAliases.get(expression.text);
		}
		return undefined;
	}

	function maybeImportFrom(node: ts.ImportDeclaration): void {
		if (!ts.isStringLiteral(node.moduleSpecifier)) return;
		if (!isChildProcessModuleSpecifier(node.moduleSpecifier.text)) return;
		const clause = node.importClause;
		if (!clause) return;
		if (clause.name) childProcessNamespaceAliases.add(clause.name.text);
		if (!clause.namedBindings) return;

		if (ts.isNamespaceImport(clause.namedBindings)) {
			childProcessNamespaceAliases.add(clause.namedBindings.name.text);
			return;
		}

		for (const binding of clause.namedBindings.elements) {
			const imported = binding.propertyName?.text ?? binding.name.text;
			if (imported === "spawn" || imported === "spawnSync") {
				importedSpawnAliases.set(binding.name.text, imported);
			}
		}
	}

	function collectAliasDeclarations(node: ts.VariableStatement): void {
		if (!(node.declarationList.flags & ts.NodeFlags.Const)) return;

		for (const declaration of node.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			if (!declaration.initializer) continue;
			const command = commandText(declaration.initializer);
			if (!command || !FORBIDDEN_VIEWER_COMMAND.test(command)) continue;
			literalCommandAliases.set(declaration.name.text, command);
		}
	}

	function visit(node: ts.Node): void {
		if (ts.isImportDeclaration(node)) {
			maybeImportFrom(node);
		}

		if (ts.isVariableStatement(node)) {
			collectAliasDeclarations(node);
		}

		if (ts.isCallExpression(node)) {
			let callKind: "spawn" | "spawnSync" | undefined;
			const callee = node.expression;
			if (ts.isIdentifier(callee)) {
				callKind = importedSpawnAliases.get(callee.text);
			}
			if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
				if (childProcessNamespaceAliases.has(callee.expression.text) && (callee.name.text === "spawn" || callee.name.text === "spawnSync")) {
					callKind = callee.name.text;
				}
			}

			if (callKind) {
				const firstArg = node.arguments[0];
				if (firstArg) {
					const command = commandText(firstArg);
					if (command && FORBIDDEN_VIEWER_COMMAND.test(command)) {
						addViolation(
							violations,
							source,
							file,
							node.getStart(sourceFile),
							`${callKind} for direct viewer command: ${JSON.stringify(command)}`,
						);
					}
				}
			}
		}

		const envName = isProcessEnvAccess(node);
		if (envName && FORBIDDEN_ENV_PROBES.has(envName)) {
			addViolation(violations, source, file, node.getStart(sourceFile), `environment probe for ${envName}`);
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return violations;
}

function collectForbiddenViolations(file: string, source: string): GuardrailViolation[] {
	return [
		...collectForbiddenIdentifierViolations(file, source),
		...collectForbiddenSpawnViolations(file, source),
	];
}

function formatViolations(violations: GuardrailViolation[]): string {
	if (violations.length === 0) return "";
	return violations
		.map((violation) => {
			const file = relative(REPO_ROOT, violation.file);
			return `- ${file}:${violation.line}:${violation.column} ${violation.detail}`;
		})
		.join("\n");
}

test("guardrail fixtures catch forbidden direct viewer patterns", () => {
	const source = `
		import { spawn as run, spawnSync } from "node:child_process";
		import * as childProcess from "node:child_process";
		import childProcessDefault from "node:child_process";
		const viewer = "zathura";
		run(viewer, []);
		spawnSync("okular", []);
		childProcess.spawn("evince", []);
		childProcessDefault.spawnSync("sioyek", []);
		process.env.DISPLAY;
		process.env["WAYLAND_DISPLAY"];
		const procPath = "/proc";
		openPdfInZathura();
		const legacy = "PDF_PREVIEW_ZATHURA_LEGACY";
	`;
	const violations = collectForbiddenViolations(join(REPO_ROOT, "guardrail-fixture.ts"), source);
	const details = violations.map((violation) => violation.detail).join("\n");

	assert.match(details, /spawn for direct viewer command: "zathura"/);
	assert.match(details, /spawnSync for direct viewer command: "okular"/);
	assert.match(details, /spawn for direct viewer command: "evince"/);
	assert.match(details, /spawnSync for direct viewer command: "sioyek"/);
	assert.match(details, /environment probe for DISPLAY/);
	assert.match(details, /environment probe for WAYLAND_DISPLAY/);
	assert.match(details, /process discovery from \/proc/);
	assert.match(details, /legacy direct viewer-open helper: openPdfInZathura/);
	assert.match(details, /legacy zathura constant: PDF_PREVIEW_ZATHURA_LEGACY/);
});

test("Production extension TypeScript rejects direct viewer-control regressions", () => {
	const files = collectProductionTypeScriptFiles();
	const violations: GuardrailViolation[] = [];

	for (const file of files) {
		const source = readFileSync(file, "utf8");
		violations.push(...collectForbiddenViolations(file, source));
	}

	assert.equal(violations.length, 0, `Forbidden production GUI-regression patterns were found:\n${formatViolations(violations)}`);
});

test("Systemd host service unit is named and configured for show-latex", () => {
	const unitPath = join(REPO_ROOT, "systemd", "show-latex.service");
	const legacyUnitPath = join(REPO_ROOT, "systemd", "codex-show-latex-viewer.service");
	const unitSource = readFileSync(unitPath, "utf8");

	assert.equal(existsSync(legacyUnitPath), false, "Legacy systemd unit filename should be removed");
	assert.match(unitSource, /WorkingDirectory=.*%h\/projects\/AI\/pi_extensions\/pdf-preview/);
	assert.match(unitSource, /ExecStart=.*agent-synctex-host-service\.ts start/);
	assert.match(unitSource, /Restart=on-failure/);
	assert.match(unitSource, /DBUS_SESSION_BUS_ADDRESS=/);
	assert.match(unitSource, /PartOf=graphical-session\.target/);
	assert.match(unitSource, /WantedBy=graphical-session\.target/);
});

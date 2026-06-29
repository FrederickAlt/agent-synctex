import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
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

const EXPECTED_ACTIVE_RUNTIME_ENTRYPOINTS = new Set<string>([
	"scripts/tex-actions-mcp.ts",
	"scripts/pdf-preview-mcp.ts",
	"scripts/viewer-host-server.ts",
]);

const FORBIDDEN_RUNTIME_IMPORT_SYMBOLS = new Map<string, string>([
	["HostServiceClient", "legacy HostService client API should not be imported"],
	["HostServiceServer", "legacy HostService server API should not be imported"],
	["ZathuraViewerBackend", "legacy zathura backend should not be imported"],
	["requestRasterizePdf", "legacy rasterize request API should not be imported"],
	["rasterizePdfPage", "inline raster preview API should not be imported by active MCP runtime"],
	["rasterizePdfPages", "inline raster preview API should not be imported by active MCP runtime"],
	["createInlinePreviewRenderer", "inline renderer should not be imported by active MCP runtime"],
	["KittyPreviewInvalidationRegistry", "Kitty inline preview runtime should not be imported by active MCP runtime"],
	["buildKittyPlaceholderImageRender", "Kitty inline preview runtime should not be imported by active MCP runtime"],
	["PdfJsViewerMcpService", "active MCP runtime must route viewer operations through ViewerHostClient, not own the PDF.js server"],
	["PdfJsViewerServer", "active MCP runtime must not own the PDF.js HTTP/WebSocket server"],
	["DefaultBrowserLauncher", "active MCP runtime must not launch browser/PDF.js viewer windows directly"],
]);

const FORBIDDEN_RUNTIME_LITERAL_MARKERS = new Map<string, string>([
	["agent-synctex-host-service.ts", "legacy daemon shim should not be imported/referenced"],
	["tex-actionsctl.ts", "legacy tex-actionsctl command path should not be referenced"],
	["pi_synctex_callback.mjs", "legacy callback script path should not be referenced"],
	["show-latex.service", "legacy systemd unit should not be referenced"],
	["codex-show-latex-viewer.service", "legacy systemd unit should not be referenced"],
	["pi-synctex-callback-v1", "legacy callback transport marker should not be in active MCP runtime graph"],
	["session_heartbeat", "legacy session heartbeat protocol field should not be in MCP runtime graph"],
	["get_pending_notifications", "legacy pending-notification protocol field should not be in MCP runtime graph"],
	["register_callback_target", "legacy callback registration operation should not be in active MCP runtime graph"],
	["resolve_callback_target", "legacy callback resolution operation should not be in active MCP runtime graph"],
	["unregister_callback_target", "legacy callback unregister operation should not be in active MCP runtime graph"],
	["tex-actions-host-service", "legacy host-service runtime metadata should not be in active graph"],
]);

const FORBIDDEN_RUNTIME_SCHEMA_FIELDS = new Set(["inline", "continuous", "callback_target_id"]);

const FORBIDDEN_ACTIVE_HANDLER_STRING_FIELDS_BY_FILE = new Map<string, Map<string, string>>([
	["host_service_mcp.ts", new Map([
		["callback", "v1 MCP handler must not accept or expose callback arguments"],
		["callback_target_id", "v1 MCP handler must not accept or expose callback_target_id arguments"],
	])],
	["stdio_mcp_runtime.ts", new Map([
		["inline", "stdio MCP runtime must not strip or accept legacy inline compatibility arguments"],
	])],
]);

const FORBIDDEN_ACTIVE_RUNTIME_IDENTIFIERS = new Map<string, string>([
	["parseCallbackTargetArg", "v1 MCP handler must not parse legacy callback targets"],
	["requestRasterizePdf", "active MCP runtime must not call legacy rasterization API"],
	["rasterizePdfPage", "active MCP runtime must not call inline raster preview API"],
	["rasterizePdfPages", "active MCP runtime must not call inline raster preview API"],
	["KittyPreviewInvalidationRegistry", "active MCP runtime must not use Kitty inline preview state"],
]);

const FORBIDDEN_VIEWER_COMMAND = /\b(?:zathura|evince|okular|mupdf|sioyek|xreader|xdg-open|xpdf|atril)\b/i;
const FORBIDDEN_ENV_PROBES = new Set(["DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "XAUTHORITY", "DISPLAY"]);
const PACKAGE_STALE_METADATA_TOKENS = [
	"agent-synctex-host-service.ts",
	"tex-actionsctl.ts",
	"pi_synctex_callback.mjs",
	"show-latex.service",
	"codex-show-latex-viewer.service",
];
const ACTIVE_DOC_PATHS = [
	"README.md",
	"CONTEXT.md",
	"docs/prd-desktop-viewer-host-v1.md",
	"docs/tdd-desktop-viewer-host-v1.md",
	"docs/prd-viewer-client-ux-followups.md",
	"docs/tdd-viewer-client-ux-followups.md",
] as const;
const STALE_PI_EXTENSION_BRANDING_PATTERNS: Array<[RegExp, string]> = [
	[/\bPi extension\b/gi, "stale Pi extension branding"],
	[/\bpi-extension\b/gi, "stale pi-extension keyword branding"],
];
const NPM_MCP_SCRIPT = "npm run tex-actions:mcp";

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
	return [...collectForbiddenIdentifierViolations(file, source), ...collectForbiddenSpawnViolations(file, source)];
}

function collectProductionEntrypointPathsFromCommand(command: string): string[] {
	const normalized = command.replace(/\n+/g, " ");
	const matches = normalized.matchAll(/(?:^|[\s'"`(;|&])(?:\.\/)?(scripts\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.ts)(?=\b|$)/g);
	const paths = new Set<string>();
	for (const match of matches) {
		const candidate = (match[1] ?? "").replace(/^\.\//, "");
		if (!candidate) continue;
		paths.add(candidate);
	}
	return Array.from(paths);
}

function collectPackageMetadataEntrypoints(pkg: unknown): Set<string> {
	const result = new Set<string>();
	if (typeof pkg !== "object" || pkg === null) return result;

	const metadata = pkg as Record<string, unknown>;
	if (typeof metadata.bin === "string") {
		for (const candidate of collectProductionEntrypointPathsFromCommand(metadata.bin)) {
			result.add(candidate);
		}
	} else if (typeof metadata.bin === "object" && metadata.bin !== null) {
		for (const binValue of Object.values(metadata.bin as Record<string, string>)) {
			if (typeof binValue !== "string") continue;
			for (const candidate of collectProductionEntrypointPathsFromCommand(binValue)) {
				result.add(candidate);
			}
		}
	}

	if (typeof metadata.scripts === "object" && metadata.scripts !== null) {
		for (const scriptValue of Object.values(metadata.scripts as Record<string, unknown>)) {
			if (typeof scriptValue !== "string") continue;
			for (const candidate of collectProductionEntrypointPathsFromCommand(scriptValue)) {
				result.add(candidate);
			}
		}
	}

	return result;
}

function collectStalePiExtensionBrandingViolations(file: string, source: string): GuardrailViolation[] {
	const violations: GuardrailViolation[] = [];

	for (const [pattern, detail] of STALE_PI_EXTENSION_BRANDING_PATTERNS) {
		const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const match of source.matchAll(re)) {
			if (match.index === undefined) continue;
			addViolation(violations, source, file, match.index, detail);
		}
	}

	return violations;
}

function collectUnsafeNpmMcpStartupGuidanceViolations(file: string, source: string): GuardrailViolation[] {
	const violations: GuardrailViolation[] = [];
	const escapedScript = NPM_MCP_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const lines = source.split(/\r?\n/);
	const scriptPattern = new RegExp(escapedScript, "g");

	for (const match of source.matchAll(scriptPattern)) {
		if (match.index === undefined) continue;
		const lineIndex = source.slice(0, match.index).split(/\r?\n/).length - 1;
		const context = lines.slice(Math.max(0, lineIndex - 3), Math.min(lines.length, lineIndex + 4)).join("\n").toLowerCase();
		const isManualConvenience = /manual|convenience|developer|development|dev/.test(context);
		if (isManualConvenience) continue;
		addViolation(
			violations,
			source,
			file,
			match.index,
			`${NPM_MCP_SCRIPT} must not be recommended for MCP client startup because npm output can corrupt stdio framing`,
		);
	}

	return violations;
}

function collectActiveDocRuntimeGuidanceViolations(file: string, source: string): GuardrailViolation[] {
	return [
		...collectStalePiExtensionBrandingViolations(file, source),
		...collectUnsafeNpmMcpStartupGuidanceViolations(file, source),
	];
}

function collectMetadataReferenceViolations(metadataSource: string, file: string, pkg: unknown): GuardrailViolation[] {
	const violations: GuardrailViolation[] = [];
	violations.push(...collectStalePiExtensionBrandingViolations(file, metadataSource));
	if (typeof pkg !== "object" || pkg === null) return violations;

	const metadata = pkg as Record<string, unknown>;
	const checkStringValue = (value: unknown, source: string): void => {
		if (typeof value !== "string") return;
		for (const token of PACKAGE_STALE_METADATA_TOKENS) {
			const pattern = new RegExp(`${token.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`);
			if (pattern.test(value)) {
				addViolation(
					violations,
					source,
					file,
					source.indexOf(token),
					`pi runtime metadata references stale path/daemon entry: ${token}`,
				);
			}
		}
	};

	if (typeof metadata.scripts === "object" && metadata.scripts !== null) {
		for (const script of Object.values(metadata.scripts as Record<string, unknown>)) {
			checkStringValue(script, metadataSource);
		}
	}
	if (typeof metadata.bin === "string") {
		checkStringValue(metadata.bin, metadataSource);
	}
	if (typeof metadata.bin === "object" && metadata.bin !== null) {
		for (const bin of Object.values(metadata.bin as Record<string, unknown>)) {
			checkStringValue(bin, metadataSource);
		}
	}
	if (typeof metadata.description === "string") {
		for (const token of PACKAGE_STALE_METADATA_TOKENS) {
			if (metadata.description.includes(token)) {
				addViolation(
					violations,
					metadataSource,
					file,
					metadataSource.indexOf(token),
					`package.json text references stale path token: ${token}`,
				);
			}
		}
	}

	const pi = metadata.pi as Record<string, unknown> | undefined;
	if (pi && typeof pi === "object" && Object.hasOwn(pi, "extensions")) {
		const marker = "\"extensions\"";
		const token = marker;
		addViolation(
			violations,
			metadataSource,
			file,
			Math.max(metadataSource.indexOf(token), 0),
			"package.json must not declare pi.extensions for active production",
		);
	}

	return violations;
}

function collectActiveProductionRuntimeFiles(entrypoints: string[]): string[] {
	const queue = [...entrypoints.map((entry) => resolve(REPO_ROOT, entry))];
	const seen = new Set<string>();

	const resolveImportTarget = (moduleSpecifier: string, sourcePath: string): string | undefined => {
		if (!moduleSpecifier.startsWith(".")) return;
		const base = resolve(dirname(sourcePath), moduleSpecifier);
		if (extname(base) === ".ts" && existsSync(base)) {
			return base;
		}
		const tsTarget = `${base}.ts`;
		if (existsSync(tsTarget)) {
			return tsTarget;
		}
		const indexTarget = resolve(base, "index.ts");
		if (existsSync(indexTarget)) {
			return indexTarget;
		}
		return undefined;
	};

	for (let index = 0; index < queue.length; index += 1) {
		const file = queue[index];
		if (seen.has(file)) continue;
		if (!existsSync(file) || !file.endsWith(".ts")) continue;
		seen.add(file);

		const source = readFileSync(file, "utf8");
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);

		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node)) {
				if (node.importClause?.isTypeOnly) {
					return;
				}
				if (ts.isStringLiteral(node.moduleSpecifier)) {
					const resolved = resolveImportTarget(node.moduleSpecifier.text, file);
					if (resolved) queue.push(resolved);
				}
				return;
			}
			if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
				if (ts.isStringLiteral(node.moduleSpecifier)) {
					const resolved = resolveImportTarget(node.moduleSpecifier.text, file);
					if (resolved) queue.push(resolved);
				}
			}
			ts.forEachChild(node, visit);
		};

		visit(sourceFile);
	}

	return Array.from(seen);
}

function collectRuntimeActiveGraphViolations(file: string, source: string): GuardrailViolation[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
	const violations: GuardrailViolation[] = [];
	const fileName = file.split(/[\\/]/).at(-1) ?? file;
	const forbiddenHandlerStrings = FORBIDDEN_ACTIVE_HANDLER_STRING_FIELDS_BY_FILE.get(fileName);

	const propertyNameText = (name: ts.PropertyName): string | undefined => {
		if (ts.isIdentifier(name)) return name.text;
		if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
		return undefined;
	};

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			if (node.importClause?.isTypeOnly) {
				return;
			}
			if (node.importClause?.name && FORBIDDEN_RUNTIME_IMPORT_SYMBOLS.has(node.importClause.name.text)) {
				addViolation(
					violations,
					source,
					file,
					node.importClause.name.getStart(sourceFile),
					FORBIDDEN_RUNTIME_IMPORT_SYMBOLS.get(node.importClause.name.text)!,
				);
			}
			const namedBindings = node.importClause?.namedBindings;
			if (namedBindings && ts.isNamedImports(namedBindings)) {
				for (const binding of namedBindings.elements) {
					const importedName = binding.propertyName?.text ?? binding.name.text;
					if (FORBIDDEN_RUNTIME_IMPORT_SYMBOLS.has(importedName)) {
						addViolation(
							violations,
							source,
							file,
							binding.name.getStart(sourceFile),
							FORBIDDEN_RUNTIME_IMPORT_SYMBOLS.get(importedName)!,
						);
					}
				}
			}
		}

		if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
			if (node.moduleSpecifier) {
				for (const exportSpecifier of node.exportClause.elements) {
					const exportedName = exportSpecifier.propertyName?.text ?? exportSpecifier.name.text;
					if (FORBIDDEN_RUNTIME_IMPORT_SYMBOLS.has(exportedName)) {
						addViolation(
							violations,
							source,
							file,
							exportSpecifier.name.getStart(sourceFile),
							FORBIDDEN_RUNTIME_IMPORT_SYMBOLS.get(exportedName)!,
						);
					}
				}
			}
		}

		if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isShorthandPropertyAssignment(node)) && node.name) {
			const nameText = propertyNameText(node.name);
			if (nameText && FORBIDDEN_RUNTIME_SCHEMA_FIELDS.has(nameText)) {
				addViolation(
					violations,
					source,
					file,
					node.name.getStart(sourceFile),
					`active runtime source exports forbidden schema/request field: ${nameText}`,
				);
			}
		}

		if (ts.isIdentifier(node)) {
			const detail = FORBIDDEN_ACTIVE_RUNTIME_IDENTIFIERS.get(node.text);
			if (detail) {
				addViolation(violations, source, file, node.getStart(sourceFile), `${detail}: ${node.text}`);
			}
		}

		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			for (const [marker, detail] of FORBIDDEN_RUNTIME_LITERAL_MARKERS) {
				if (!node.text.includes(marker)) continue;
				addViolation(violations, source, file, node.getStart(sourceFile), `${detail}: ${marker}`);
			}
			const handlerDetail = forbiddenHandlerStrings?.get(node.text);
			if (handlerDetail) {
				addViolation(violations, source, file, node.getStart(sourceFile), handlerDetail);
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return violations;
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

function sortAndStringifyViolations(violations: GuardrailViolation[]): string {
	const sorted = [...violations].sort((left, right) => {
		if (left.file !== right.file) return left.file.localeCompare(right.file);
		if (left.line !== right.line) return left.line - right.line;
		return left.column - right.column;
	});
	return formatViolations(sorted);
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


test("Package metadata keeps approved production entrypoints", () => {
	const packagePath = join(REPO_ROOT, "package.json");
	const packageSource = readFileSync(packagePath, "utf8");
	const packageJson = JSON.parse(packageSource) as Record<string, unknown>;
	const metadataViolations = collectMetadataReferenceViolations(packageSource, packagePath, packageJson);

	assert.equal(typeof packageJson.description, "string", "package.json must describe the active runtime");
	assert.match(packageJson.description as string, /stdio MCP/i, "package.json description must identify stdio MCP runtime");
	assert.match(packageJson.description as string, /Viewer Host/i, "package.json description must identify the Viewer Host boundary");
	assert.deepEqual(
		(packageJson.keywords as unknown[] | undefined)?.filter((keyword): keyword is string => typeof keyword === "string").sort(),
		["latex", "mcp", "tex-actions", "viewer-host"],
		"package.json keywords must use active MCP/Viewer Host boundary terms",
	);

	const declaredEntrypoints = collectPackageMetadataEntrypoints(packageJson);
	for (const entrypoint of EXPECTED_ACTIVE_RUNTIME_ENTRYPOINTS) {
		assert.equal(
			declaredEntrypoints.has(entrypoint),
			true,
			`package.json must declare ${entrypoint} in active runtime entrypoints`,
		);
	}
	for (const entrypoint of declaredEntrypoints) {
		assert.equal(
			EXPECTED_ACTIVE_RUNTIME_ENTRYPOINTS.has(entrypoint),
			true,
			`package.json declares unexpected active runtime entrypoint ${entrypoint}`,
		);
	}

	assert.equal(metadataViolations.length, 0, `Package metadata contains stale legacy runtime references:\n${formatViolations(metadataViolations)}`);
});


test("Active docs describe the MCP/Viewer Host boundary and safe MCP startup commands", () => {
	const violations: GuardrailViolation[] = [];
	let combinedDocs = "";

	for (const docPath of ACTIVE_DOC_PATHS) {
		const file = join(REPO_ROOT, docPath);
		const source = readFileSync(file, "utf8");
		combinedDocs += `\n${source}`;
		violations.push(...collectActiveDocRuntimeGuidanceViolations(file, source));
	}

	assert.match(combinedDocs, /stdio MCP/i, "active docs must identify the stdio MCP runtime");
	assert.match(combinedDocs, /Viewer Host/i, "active docs must identify the Viewer Host boundary");
	assert.doesNotMatch(readFileSync(join(REPO_ROOT, "README.md"), "utf8"), /reachable browser\/PDF\.js|browser-hosted PDF\.js|process-local PDF\.js HTTP serving/i, "README must not promise old reachable in-process PDF.js behavior");
	assert.equal(
		violations.length,
		0,
		`Active docs contain stale Pi-extension branding or unsafe MCP startup guidance:\n${formatViolations(violations)}`,
	);

	const readmeSource = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
	assert.match(readmeSource, /^node scripts\/tex-actions-mcp\.ts$/m, "README local-dev startup must use direct node entrypoint");
	assert.match(readmeSource, /^tex-actions-mcp$/m, "README MCP client startup must use installed tex-actions-mcp bin");
});


test("Active MCP runtime import graph excludes legacy host-service/runtime protocol paths", () => {
	const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as unknown;
	const entrypoints = collectPackageMetadataEntrypoints(packageJson);
	const productionFiles = collectActiveProductionRuntimeFiles(Array.from(entrypoints));
	const violations: GuardrailViolation[] = [];

	for (const file of productionFiles) {
		const source = readFileSync(file, "utf8");
		violations.push(...collectRuntimeActiveGraphViolations(file, source));
	}

	assert.equal(productionFiles.length > 0, true, "active runtime graph should include production MCP entrypoints");
	assert.equal(
		violations.length,
		0,
		`Active MCP runtime files expose forbidden legacy symbols or paths:\n${sortAndStringifyViolations(violations)}`,
	);
});


test("Legacy daemon entrypoints are removed", () => {
	const hostServicePath = join(REPO_ROOT, "systemd", "show-latex.service");
	const legacyHostServicePath = join(REPO_ROOT, "systemd", "codex-show-latex-viewer.service");
	const texActionsCtlPath = join(REPO_ROOT, "scripts", "tex-actionsctl.ts");
	const hostServiceShimPath = join(REPO_ROOT, "scripts", "agent-synctex-host-service.ts");
	const callbackScriptPath = join(REPO_ROOT, "scripts", "pi_synctex_callback.mjs");
	const pdfjsViewerBrokerScriptPath = join(REPO_ROOT, "scripts", "pdfjs-viewer-broker.ts");
	const pdfjsViewerBrokerModulePath = join(REPO_ROOT, "src", "modules", "pdfjs_viewer_broker.ts");

	assert.equal(existsSync(hostServicePath), false, "systemd unit should be absent for stdio-hosted runtime");
	assert.equal(existsSync(legacyHostServicePath), false, "legacy daemon unit filename should be removed");
	assert.equal(existsSync(texActionsCtlPath), false, "tex-actionsctl entrypoint should be removed");
	assert.equal(existsSync(hostServiceShimPath), false, "agent-synctex-host-service shim should be removed");
	assert.equal(existsSync(callbackScriptPath), false, "legacy callback script should be removed");
	assert.equal(existsSync(pdfjsViewerBrokerScriptPath), false, "detached PDF.js viewer broker entrypoint should be removed");
	assert.equal(existsSync(pdfjsViewerBrokerModulePath), false, "detached PDF.js viewer broker module should be removed");
});


test("Firejail profile keeps runtime paths macro-compatible", () => {
	const firejailPath = join(REPO_ROOT, ".pi.firejail");
	const firejailSource = readFileSync(firejailPath, "utf8");

	assert.match(firejailSource, /mkdir\s+\$\{RUNUSER\}\/tex-actions/);
	assert.match(firejailSource, /whitelist\s+\$\{RUNUSER\}\/tex-actions/);
	assert.match(firejailSource, /read-write\s+\$\{RUNUSER\}\/tex-actions/);
	assert.equal(firejailSource.includes("${XDG_RUNTIME_DIR}"), false, ".pi.firejail should avoid unsupported XDG_RUNTIME_DIR variable");
});

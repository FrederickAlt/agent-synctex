#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mapForwardSynctex } from "../src/modules/synctex/forward_synctex.ts";

const DEFAULT_DPI = 144;
const DEFAULT_CROP_MARGIN_POINTS = 72;
const OVERLAY_COLOR = "rgba(255,0,0,0.30)";
const OVERLAY_STROKE = "#d11";
const OVERLAY_STROKE_WIDTH = "3";

interface CliParseResult {
	pdf?: string;
	source?: string;
	line?: number;
	out?: string;
	dpi: number;
	cropMarginPoints: number;
	help: boolean;
}

interface WarningEntry {
	readonly message: string;
}

interface MarkerPoints {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface MarkerImage {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface RasterMetadata {
	readonly generatedAt: string;
	readonly command: {
		readonly script: string;
		readonly command: string;
		readonly options: {
			readonly pdf: string;
			readonly source: string;
			readonly line: number;
			readonly out: string;
			readonly dpi: number;
			readonly cropMarginPoints: number;
		};
	};
	readonly input: {
		readonly pdf: string;
		readonly source: string;
		readonly line: number;
		readonly out: string;
	};
	readonly mapping: {
		readonly page: number;
		readonly sourceFile: string;
		readonly sourceLine: string;
		readonly sidecarPath: string;
	} & MarkerPoints;
	readonly scale: {
		readonly pdfUnit: "pt";
		readonly pxPerPoint: number;
		readonly dpi: number;
		readonly viewportScale: {
			readonly x: number;
			readonly y: number;
		};
	};
	readonly marker: {
		readonly pdfPoints: MarkerPoints;
		readonly imagePx: MarkerImage;
	};
	readonly artifacts: {
		readonly fullPagePng: string;
		readonly overlayPng: string;
		readonly cropPng: string;
		readonly metadataJson: string;
	};
	readonly warnings: WarningEntry[];
}

function usage(): string {
	return [
		"Usage:",
		"  node scripts/debug-forward-synctex.ts --pdf /path/file.pdf --source /path/file.tex --line 123 --out /tmp/synctex-debug [options]",
		"",
		"Required:",
		"  --pdf     Path to compiled PDF",
		"  --source  Source file associated with the syncTeX mapping",
		"  --line    Source line number to jump",
		"  --out     Output directory for diagnostics",
		"",
		"Optional:",
		`  --dpi    Raster DPI (default: ${DEFAULT_DPI})`,
		`  --crop-margin-points    Crop margin around marker in PDF points (default: ${DEFAULT_CROP_MARGIN_POINTS})`,
		"  --help   Show this message",
		"",
		"Example:",
		"  node scripts/debug-forward-synctex.ts --pdf /path/main.pdf --source /path/main.tex --line 123 --out /tmp/synctex-debug",
	].join("\n");
}

function commandExists(command: string): boolean {
	const probe = spawnSync("which", [command], { stdio: "ignore" });
	return !probe.error && probe.status === 0;
}

function requireCommand(command: string, hint: string): void {
	if (!commandExists(command)) {
		raiseError(`Missing required command: ${command}. Please install ${hint} and ensure ${command} is on PATH.`);
	}
}

function raiseError(message: string): never {
	throw new Error(message);
}

function parseStrictPositiveInteger(value: string, options: { name: string; min: number }): number {
	if (!/^-?\d+$/.test(value)) {
		raiseError(`${options.name} must be an integer, got ${JSON.stringify(value)}`);
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < options.min) {
		raiseError(`${options.name} must be >= ${options.min}, got ${JSON.stringify(value)}`);
	}
	return parsed;
}

function parseArguments(argv: string[]): CliParseResult {
	const result: CliParseResult = {
		dpi: DEFAULT_DPI,
		cropMarginPoints: DEFAULT_CROP_MARGIN_POINTS,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--help":
			case "-h":
				result.help = true;
				break;
			case "--pdf": {
				const value = argv[index + 1];
				if (!value) raiseError("Missing value for --pdf");
				result.pdf = value;
				index += 1;
				break;
			}
			case "--source": {
				const value = argv[index + 1];
				if (!value) raiseError("Missing value for --source");
				result.source = value;
				index += 1;
				break;
			}
			case "--line": {
				const value = argv[index + 1];
				if (!value) raiseError("Missing value for --line");
				const parsed = parseStrictPositiveInteger(value, { name: "line", min: 1 });
				result.line = parsed;
				index += 1;
				break;
			}
			case "--out": {
				const value = argv[index + 1];
				if (!value) raiseError("Missing value for --out");
				result.out = value;
				index += 1;
				break;
			}
			case "--dpi": {
				const value = argv[index + 1];
				if (!value) raiseError("Missing value for --dpi");
				const parsed = parseStrictPositiveInteger(value, { name: "dpi", min: 24 });
				result.dpi = parsed;
				index += 1;
				break;
			}
			case "--crop-margin-points": {
				const value = argv[index + 1];
				if (!value) raiseError("Missing value for --crop-margin-points");
				const parsed = Number.parseFloat(value);
				if (!Number.isFinite(parsed) || parsed < 0) {
					raiseError(`--crop-margin-points must be a non-negative number, got ${JSON.stringify(value)}`);
				}
				result.cropMarginPoints = parsed;
				index += 1;
				break;
			}
			default:
				raiseError(`Unknown argument: ${arg}`);
		}
	}
	if (result.help) return result;
	if (result.pdf === undefined) raiseError("Missing required argument: --pdf");
	if (result.source === undefined) raiseError("Missing required argument: --source");
	if (result.line === undefined) raiseError("Missing required argument: --line");
	if (result.out === undefined) raiseError("Missing required argument: --out");
	return {
		pdf: result.pdf,
		source: result.source,
		line: result.line,
		out: result.out,
		dpi: result.dpi,
		cropMarginPoints: result.cropMarginPoints,
		help: result.help,
	};
}

function renderPdfPageWithPdftoppm(input: { pdfPath: string; page: number; dpi: number; outBasePath: string }): string {
	requireCommand("pdftoppm", "poppler-utils");
	const fullPageBase = join(input.outBasePath, "forward-synctex-page");
	const renderResult = spawnSync(
		"pdftoppm",
		[
			"-f",
			String(input.page),
			"-l",
			String(input.page),
			"-png",
			"-r",
			String(input.dpi),
			input.pdfPath,
			fullPageBase,
		],
		{ encoding: "utf8" },
	);
	if (renderResult.status !== 0) {
		const stderr = String(renderResult.stderr ?? "");
		const stdout = String(renderResult.stdout ?? "");
		raiseError(`pdftoppm failed for page ${input.page} (exit=${renderResult.status || "unknown"}):\n${stdout}${stderr}`);
	}
	const renderedPath = `${fullPageBase}-${input.page}.png`;
	if (!existsSync(renderedPath)) {
		raiseError(`pdftoppm did not produce expected output image ${renderedPath}`);
	}
	return renderedPath;
}

function renderPdfPageWithPdftocairo(input: { pdfPath: string; page: number; dpi: number; outBasePath: string }): string {
	requireCommand("pdftocairo", "poppler-utils");
	const fullPageBase = join(input.outBasePath, "forward-synctex-page");
	const renderResult = spawnSync(
		"pdftocairo",
		[
			"-f",
			String(input.page),
			"-l",
			String(input.page),
			"-png",
			"-r",
			String(input.dpi),
			input.pdfPath,
			fullPageBase,
		],
		{ encoding: "utf8" },
	);
	if (renderResult.status !== 0) {
		const stderr = String(renderResult.stderr ?? "");
		const stdout = String(renderResult.stdout ?? "");
		raiseError(`pdftocairo failed for page ${input.page} (exit=${renderResult.status || "unknown"}):\n${stdout}${stderr}`);
	}
	const renderedPath = `${fullPageBase}-${input.page}.png`;
	if (!existsSync(renderedPath)) {
		raiseError(`pdftocairo did not produce expected output image ${renderedPath}`);
	}
	return renderedPath;
}

function renderPdfPage(input: { pdfPath: string; page: number; dpi: number; outBasePath: string }): string {
	if (commandExists("pdftoppm")) {
		return renderPdfPageWithPdftoppm(input);
	}
	if (!commandExists("pdftocairo")) {
		raiseError("Missing required command: pdftoppm or pdftocairo. Please install poppler-utils and ensure one of pdftoppm/pdftocairo is on PATH.");
	}
	return renderPdfPageWithPdftocairo(input);
}

function drawOverlay(input: {
	fullPagePng: string;
	overlayPng: string;
	markerPx: MarkerImage;
}): void {
	requireCommand("magick", "ImageMagick");
	const [x0, y0] = [Math.round(input.markerPx.x), Math.round(input.markerPx.y)];
	const [x1, y1] = [
		Math.round(input.markerPx.x + Math.max(1, input.markerPx.width)),
		Math.round(input.markerPx.y + Math.max(1, input.markerPx.height)),
	];
	const draw = `rectangle ${x0},${y0} ${x1},${y1}`;
	const drawResult = spawnSync(
		"magick",
		[
			input.fullPagePng,
			"-fill",
			OVERLAY_COLOR,
			"-stroke",
			OVERLAY_STROKE,
			"-strokewidth",
			OVERLAY_STROKE_WIDTH,
			"-draw",
			draw,
			input.overlayPng,
		],
		{ encoding: "utf8" },
	);
	if (drawResult.status !== 0) {
		const stderr = String(drawResult.stderr ?? "");
		const stdout = String(drawResult.stdout ?? "");
		raiseError(`ImageMagick draw failed:\n${stdout}${stderr}`);
	}
	if (!existsSync(input.overlayPng)) {
		raiseError(`ImageMagick did not write overlay image ${input.overlayPng}`);
	}
}

function identifyImageSize(imagePath: string): { width: number; height: number } {
	requireCommand("magick", "ImageMagick");
	const result = spawnSync("magick", ["identify", "-format", "%w %h", imagePath], { encoding: "utf8" });
	if (result.status !== 0) {
		raiseError(
			`ImageMagick identify failed for ${imagePath}:\n${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.trim(),
		);
	}
	const output = String(result.stdout ?? "").trim();
	const [widthText, heightText] = output.split(" ");
	const width = Number.parseInt(widthText ?? "", 10);
	const height = Number.parseInt(heightText ?? "", 10);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		raiseError(`ImageMagick identify returned an invalid size for ${imagePath}: ${JSON.stringify(output)}`);
	}
	return { width, height };
}

function cropAroundMarker(input: {
	overlayPng: string;
	cropPng: string;
	markerPx: MarkerImage;
	imageSize: { width: number; height: number };
	cropMarginPx: number;
}): void {
	const left = Math.max(0, Math.round(input.markerPx.x - input.cropMarginPx));
	const top = Math.max(0, Math.round(input.markerPx.y - input.cropMarginPx));
	const right = Math.min(input.imageSize.width, Math.round(input.markerPx.x + input.markerPx.width + input.cropMarginPx));
	const bottom = Math.min(input.imageSize.height, Math.round(input.markerPx.y + input.markerPx.height + input.cropMarginPx));
	const width = Math.max(1, right - left);
	const height = Math.max(1, bottom - top);
	const cropResult = spawnSync("magick", [input.overlayPng, "-crop", `${width}x${height}+${left}+${top}`, "+repage", input.cropPng], { encoding: "utf8" });
	if (cropResult.status !== 0) {
		const stderr = String(cropResult.stderr ?? "");
		const stdout = String(cropResult.stdout ?? "");
		raiseError(`ImageMagick crop failed for ${input.cropPng}:\n${stdout}${stderr}`.trim());
	}
	if (!existsSync(input.cropPng)) {
		raiseError(`ImageMagick crop command reported success, but no file was written: ${input.cropPng}`);
	}
}

function printResultPaths(metadata: RasterMetadata): void {
	console.log("forward SyncTeX diagnostic artifacts:");
	for (const line of [
		`  metadata: ${metadata.artifacts.metadataJson}`,
		`  full-page: ${metadata.artifacts.fullPagePng}`,
		`  overlay: ${metadata.artifacts.overlayPng}`,
		`  crop: ${metadata.artifacts.cropPng}`,
	]) {
		console.log(line);
	}
	if (metadata.warnings.length > 0) {
		for (const warning of metadata.warnings) {
			console.log(`  warning: ${warning.message}`);
		}
	}
}

function buildMetadata(args: {
	jump: ReturnType<typeof mapForwardSynctex>;
	pdf: string;
	source: string;
	dpi: number;
	cropMarginPoints: number;
	linePx: MarkerImage;
	fullPagePng: string;
	overlayPng: string;
	cropPng: string;
	metadataPath: string;
	warnings: WarningEntry[];
	outDir: string;
}): RasterMetadata {
	return {
		generatedAt: new Date().toISOString(),
		command: {
			script: "debug-forward-synctex.ts",
			command: "node scripts/debug-forward-synctex.ts",
			options: {
				pdf: args.pdf,
				source: args.source,
				line: args.jump.line,
				out: args.outDir,
				dpi: args.dpi,
				cropMarginPoints: args.cropMarginPoints,
			},
		},
		input: {
			pdf: args.pdf,
			source: args.source,
			line: args.jump.line,
			out: args.outDir,
		},
		mapping: {
			page: args.jump.page,
			sourceFile: args.jump.sourceFile,
			sourceLine: args.jump.sourceLine,
			sidecarPath: args.jump.sidecarPath,
			x: args.jump.x,
			y: args.jump.y,
			width: args.jump.width,
			height: args.jump.height,
		},
		scale: {
			pdfUnit: "pt" as const,
			pxPerPoint: args.dpi / 72,
			dpi: args.dpi,
			viewportScale: { x: 1, y: 1 },
		},
		marker: {
			pdfPoints: {
				x: args.jump.x,
				y: args.jump.y,
				width: args.jump.width,
				height: args.jump.height,
			},
			imagePx: args.linePx,
		},
		artifacts: {
			fullPagePng: args.fullPagePng,
			overlayPng: args.overlayPng,
			cropPng: args.cropPng,
			metadataJson: args.metadataPath,
		},
		warnings: args.warnings,
	} satisfies RasterMetadata;
}

function run(): void {
	let args: CliParseResult;
	try {
		args = parseArguments(process.argv.slice(2));
		if (args.help) {
			console.log(usage());
			return;
		}
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		console.error(`\n${usage()}`);
		process.exit(1);
	}

	const pdf = isAbsolute(args.pdf) ? args.pdf : resolve(process.cwd(), args.pdf);
	const source = isAbsolute(args.source) ? args.source : resolve(process.cwd(), args.source);
	const out = resolve(args.out);
	if (!existsSync(pdf)) {
		console.error(`error: PDF path does not exist: ${pdf}`);
		process.exit(1);
	}
	if (!existsSync(source)) {
		console.error(`error: source path does not exist: ${source}`);
		process.exit(1);
	}
	mkdirSync(out, { recursive: true });

	const warnings: WarningEntry[] = [];
	const outBase = out;
	try {
		const jump = mapForwardSynctex({ pdfPath: pdf, sourceFile: source, line: args.line, cwd: process.cwd() });
		const fullPagePng = renderPdfPage({ pdfPath: pdf, page: jump.page, dpi: args.dpi, outBasePath: outBase });
		const markerPx: MarkerImage = {
			x: jump.x * (args.dpi / 72),
			y: jump.y * (args.dpi / 72),
			width: jump.width * (args.dpi / 72),
			height: jump.height * (args.dpi / 72),
		};
		const overlayPng = join(out, `forward-synctex-page-${jump.page}-overlay.png`);
		drawOverlay({ fullPagePng, overlayPng, markerPx });

		const imageSize = identifyImageSize(overlayPng);
		const cropPng = join(out, `forward-synctex-page-${jump.page}-crop.png`);
		cropAroundMarker({
			overlayPng,
			cropPng,
			markerPx,
			imageSize,
			cropMarginPx: args.cropMarginPoints * (args.dpi / 72),
		});
		if (!existsSync(cropPng)) {
			raiseError(`Crop artifact missing after creation attempt: ${cropPng}`);
		}

		const metadataPath = join(out, `forward-synctex-line-${jump.line}-diagnostic.json`);
		const metadata: RasterMetadata = buildMetadata({
			jump,
			pdf,
			source,
			dpi: args.dpi,
			cropMarginPoints: args.cropMarginPoints,
			linePx: markerPx,
			fullPagePng,
			overlayPng,
			cropPng,
			metadataPath,
			warnings,
			outDir: out,
		});
		writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
		printResultPaths(metadata);
		console.log(`marker PDF points: x=${jump.x}, y=${jump.y}, width=${jump.width}, height=${jump.height}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

run();

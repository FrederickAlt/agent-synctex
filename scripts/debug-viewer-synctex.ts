#!/usr/bin/env node
/** Development-only real Viewer Host/PDF.js SyncTeX probe diagnostic runner. */
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Request, type Response } from "playwright";
import { ViewerHostControlClient } from "../src/modules/viewer_host_control_client.ts";
import { ViewerHostPdfRegistry } from "../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../src/modules/viewer_host_server.ts";

const PDF_ID = 1;
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const PROBE_CAPTURE_SETTLE_MS = 5_500;
const MAX_INTERACTIVE_CLICKS = 25;
const MAX_BROWSER_DIAGNOSTICS = 200;

interface CliOptions {
	pdf?: string;
	out?: string;
	page?: number;
	x?: number;
	y?: number;
	text?: string;
	interactive: boolean;
	clicks?: number;
	help: boolean;
}

interface CapturedProbe {
	request: {
		url: string;
		method: string;
		headers: Record<string, string>;
		body: unknown;
	};
	/** Selection fields actually sent by the probe, copied out of request.body for easy comparison. */
	selection_context?: {
		textBeforeSelection?: string;
		textAfterSelection?: string;
	};
	/** Distinct source-proposal provenance values returned in the debug trace. */
	proposal_provenance?: string[];
	response?: {
		url: string;
		status: number;
		headers: Record<string, string>;
		body: unknown;
	};
}

export interface ClickCapture {
	target: {
		page: number;
		client: { x: number; y: number };
		pdf: { x: number; y: number };
	};
	client_rects: Record<string, unknown>;
	pdf_rects: Record<string, unknown>;
	elements_from_point: Array<Record<string, unknown>>;
	text_spans: Array<Record<string, unknown>>;
	matched_text?: string;
}

export interface DispatchTarget {
	tag: string;
	page: number;
	id?: string;
	class_name?: string;
}

interface ClickDiagnostic extends ClickCapture {
	forced: boolean;
	dispatch_target?: DispatchTarget;
}

export interface InteractiveForcedClick {
	capture: ClickCapture;
	dispatch_target: DispatchTarget;
}

interface DiagnosticArtifact {
	input: {
		pdf: string;
		out: string;
		mode: "coordinates" | "text" | "interactive";
		page?: number;
		x?: number;
		y?: number;
		text?: string;
		clicks?: number;
	};
	viewer: {
		origin: string;
		url: string;
		pdf_id: number;
		workspace_cwd: string;
	};
	clicks: ClickDiagnostic[];
	probes: CapturedProbe[];
	capture: {
		click_limit: number;
		clicks_truncated: boolean;
		probe_limit: number;
		probes_truncated: boolean;
	};
	browser: {
		console: string[];
		page_errors: string[];
		request_failures: string[];
		truncated: { console: boolean; page_errors: boolean; request_failures: boolean };
	};
	artifacts: {
		before_screenshot: string;
		after_screenshot: string;
		summary: string;
		json: string;
	};
}

function usage(): string {
	return [
		"Usage:",
		"  node scripts/debug-viewer-synctex.ts --pdf /path/paper.pdf --out /tmp/viewer-synctex --page 1 --x 144 --y 155",
		"  node scripts/debug-viewer-synctex.ts --pdf /path/paper.pdf --out /tmp/viewer-synctex --text 'Visible PDF text' [--page 1]",
		"  node scripts/debug-viewer-synctex.ts --pdf /path/paper.pdf --out /tmp/viewer-synctex --interactive [--clicks 3]",
		"",
		"Required:",
		"  --pdf PATH          Registered PDF to load in the real Viewer Host/PDF.js viewer",
		"  --out DIR           Directory for viewer-synctex-diagnostic.json, summary.txt, and screenshots",
		"",
		"Target modes (choose exactly one):",
		"  --page N --x X --y Y  Click a PDF-space SyncTeX coordinate through the real PDF.js viewport",
		"  --text TEXT          Click the first visible PDF.js text span containing TEXT (optionally constrain with --page)",
		"  --interactive        Open a headed browser and record real document clicks; press Escape to finish",
		"",
		"Optional:",
		`  --clicks N           In interactive mode, exit automatically after N document clicks (maximum ${MAX_INTERACTIVE_CLICKS})`,
		"  --help, -h           Show this help",
		"",
		"Artifacts include document text, source locations, and probe payloads; keep --out private.",
	].join("\n");
}

function fail(message: string): never {
	throw new Error(message);
}

function parsePositiveInteger(value: string, name: string): number {
	if (!/^\d+$/.test(value)) fail(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
	return parsed;
}

function parseCoordinate(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) fail(`${name} must be a non-negative finite PDF coordinate, got ${JSON.stringify(value)}`);
	return parsed;
}

function requireValue(argv: string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value) fail(`Missing value for ${option}`);
	return value;
}

function parseArguments(argv: string[]): CliOptions {
	const result: CliOptions = { interactive: false, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const option = argv[index];
		switch (option) {
			case "--help":
			case "-h":
				result.help = true;
				break;
			case "--pdf":
				result.pdf = requireValue(argv, index, option);
				index += 1;
				break;
			case "--out":
				result.out = requireValue(argv, index, option);
				index += 1;
				break;
			case "--page":
				result.page = parsePositiveInteger(requireValue(argv, index, option), option);
				index += 1;
				break;
			case "--x":
				result.x = parseCoordinate(requireValue(argv, index, option), option);
				index += 1;
				break;
			case "--y":
				result.y = parseCoordinate(requireValue(argv, index, option), option);
				index += 1;
				break;
			case "--text":
				result.text = requireValue(argv, index, option);
				if (!result.text.trim()) fail("--text must not be empty");
				index += 1;
				break;
			case "--interactive":
				result.interactive = true;
				break;
			case "--clicks":
				result.clicks = parsePositiveInteger(requireValue(argv, index, option), option);
				index += 1;
				break;
			default:
				fail(`Unknown argument: ${option}`);
		}
	}
	if (result.help) return result;
	if (result.pdf === undefined) fail("Missing required argument: --pdf");
	if (result.out === undefined) fail("Missing required argument: --out");
	const coordinateMode = result.x !== undefined || result.y !== undefined;
	if (coordinateMode && (result.page === undefined || result.x === undefined || result.y === undefined)) {
		fail("Coordinate mode requires --page, --x, and --y together");
	}
	const modes = Number(coordinateMode) + Number(result.text !== undefined) + Number(result.interactive);
	if (modes !== 1) fail("Choose exactly one target mode: --page/--x/--y, --text, or --interactive");
	if (result.interactive && result.page !== undefined) fail("--page is only valid with coordinate or text mode");
	if (result.clicks !== undefined && !result.interactive) fail("--clicks is only valid with --interactive");
	if (result.clicks !== undefined && result.clicks > MAX_INTERACTIVE_CLICKS) fail(`--clicks must be at most ${MAX_INTERACTIVE_CLICKS}`);
	return result;
}

function resolvedPath(path: string): string {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function jsonValue(value: string | null): unknown {
	if (value === null || value === "") return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function isProbeRequest(request: Request): boolean {
	return request.method() === "POST" && new URL(request.url()).pathname === "/synctex/probe";
}

function pageIsClosed(page: Page): boolean {
	return page.isClosed();
}

async function waitForRenderedPage(page: Page, pageNumber: number): Promise<void> {
	await page.evaluate((targetPage) => {
		const application = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { scrollPageIntoView(input: { pageNumber: number }): void } } }).PDFViewerApplication;
		application?.pdfViewer?.scrollPageIntoView({ pageNumber: Number(targetPage) });
	}, pageNumber);
	await page.waitForSelector(`#viewer .page[data-page-number='${pageNumber}'][data-loaded='true'] canvas`, { state: "attached", timeout: 15_000 });
	await page.waitForFunction((targetPage) => {
		const application = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { _pages?: Array<{ viewport?: unknown }> } } }).PDFViewerApplication;
		return application?.pdfViewer?._pages?.[Number(targetPage) - 1]?.viewport !== undefined;
	}, pageNumber, { timeout: 10_000 });
}

export async function installCaptureHelper(page: Page): Promise<void> {
	await page.evaluate(() => {
		type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
		const rect = (value: DOMRect | ClientRect): Rect => ({ left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height });
		const briefElement = (element: Element): Record<string, unknown> => ({
			tag: element.tagName.toLowerCase(),
			...(element.id ? { id: element.id } : {}),
			...(typeof element.className === "string" && element.className ? { class_name: element.className } : {}),
			...(element.textContent?.trim() ? { text: element.textContent.trim().slice(0, 500) } : {}),
			rect: rect(element.getBoundingClientRect()),
			data: Object.fromEntries(Array.from(element.attributes)
				.filter((attribute) => attribute.name.startsWith("data-"))
				.slice(0, 12)
				.map((attribute) => [attribute.name, attribute.value])),
		});
		const capture = (clientX: number, clientY: number): ClickCapture | undefined => {
			const targets = document.elementsFromPoint(clientX, clientY);
			const pageElement = targets.map((target) => target.closest(".page")).find((target): target is HTMLElement => target instanceof HTMLElement);
			const pageNumber = Number(pageElement?.dataset.pageNumber);
			const application = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { _pages?: Array<{ viewport?: { convertToPdfPoint(x: number, y: number): [number, number]; viewBox?: number[]; width?: number; height?: number; rotation?: number } }> } } }).PDFViewerApplication;
			const viewport = application?.pdfViewer?._pages?.[pageNumber - 1]?.viewport;
			const canvasWrapper = pageElement?.querySelector(".canvasWrapper") as HTMLElement | null;
			if (!pageElement || !Number.isInteger(pageNumber) || pageNumber < 1 || !viewport || !canvasWrapper) return undefined;
			const canvasRect = canvasWrapper.getBoundingClientRect();
			const point = viewport.convertToPdfPoint(clientX - canvasRect.left, canvasRect.height - (clientY - canvasRect.top));
			const pdfRange = (clientRect: DOMRect | ClientRect) => {
				const first = viewport.convertToPdfPoint(clientRect.left - canvasRect.left, canvasRect.height - (clientRect.top - canvasRect.top));
				const second = viewport.convertToPdfPoint(clientRect.right - canvasRect.left, canvasRect.height - (clientRect.bottom - canvasRect.top));
				const h = Math.min(first[0], second[0]);
				const v = Math.max(first[1], second[1]);
				const W = Math.abs(first[0] - second[0]);
				const H = Math.abs(first[1] - second[1]);
				return Number.isFinite(h) && Number.isFinite(v) && W > 0 && H > 0 ? { page: pageNumber, h, v, W, H } : undefined;
			};
			const textLayer = pageElement.querySelector(".textLayer");
			const spans = targets
				.map((target) => textLayer?.contains(target) ? target.closest("span") : undefined)
				.filter((target): target is HTMLSpanElement => target instanceof HTMLSpanElement)
				.filter((target, index, all) => all.indexOf(target) === index)
				.slice(0, 8)
				.map((span) => {
					const range = document.createRange();
					range.selectNodeContents(span);
					const clientRects = Array.from(range.getClientRects()).map(rect);
					const pdfRects = Array.from(range.getClientRects()).map(pdfRange).filter((value): value is NonNullable<typeof value> => value !== undefined);
					range.detach?.();
					return { text: span.textContent?.trim().slice(0, 500) ?? "", client_rects: clientRects, pdf_rects: pdfRects };
				});
			return {
				target: { page: pageNumber, client: { x: clientX, y: clientY }, pdf: { x: point[0], y: point[1] } },
				client_rects: { page: rect(pageElement.getBoundingClientRect()), canvas_wrapper: rect(canvasRect) },
				pdf_rects: { view_box: viewport.viewBox ?? [], viewport: { width: viewport.width, height: viewport.height, rotation: viewport.rotation } },
				elements_from_point: targets.slice(0, 12).map(briefElement),
				text_spans: spans,
			};
		};
		(window as unknown as { __viewerSynctexDiagnosticCapture?: (clientX: number, clientY: number) => ClickCapture | undefined }).__viewerSynctexDiagnosticCapture = capture;
	});
}

async function captureClick(page: Page, clientX: number, clientY: number): Promise<ClickCapture> {
	const capture = await page.evaluate(({ x, y }) => {
		const helper = (window as unknown as { __viewerSynctexDiagnosticCapture?: (clientX: number, clientY: number) => ClickCapture | undefined }).__viewerSynctexDiagnosticCapture;
		return helper?.(x, y);
	}, { x: clientX, y: clientY });
	if (capture === undefined) fail(`Point ${clientX},${clientY} is not on a rendered PDF.js page`);
	return capture;
}

export async function forceViewerProbeClick(page: Page, input: { page: number; clientX: number; clientY: number }): Promise<DispatchTarget> {
	await page.mouse.move(input.clientX, input.clientY);
	return await page.evaluate(({ pageNumber, clientX, clientY }) => {
		const pageElement = document.querySelector(`#viewer .page[data-page-number='${pageNumber}']`) as HTMLElement | null;
		if (!pageElement) throw new Error(`rendered PDF.js page ${pageNumber} is unavailable for forced click dispatch`);
		const accepted = pageElement.dispatchEvent(new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			composed: true,
			button: 0,
			buttons: 0,
			clientX,
			clientY,
			view: window,
		}));
		if (!accepted) throw new Error("forced viewer click was cancelled before the probe handler completed");
		return {
			tag: pageElement.tagName.toLowerCase(),
			page: Number(pageElement.dataset.pageNumber),
			...(pageElement.id ? { id: pageElement.id } : {}),
			...(pageElement.className ? { class_name: pageElement.className } : {}),
		};
	}, { pageNumber: input.page, clientX: input.clientX, clientY: input.clientY });
}

export async function installInteractiveForcedClickCapture(page: Page, handlers: { onClick: (value: InteractiveForcedClick) => void; onExit: () => void }): Promise<void> {
	await page.exposeBinding("__viewerSynctexDiagnosticClick", (_source, value: InteractiveForcedClick) => handlers.onClick(value));
	await page.exposeBinding("__viewerSynctexDiagnosticExit", () => handlers.onExit());
	await page.evaluate(() => {
		const forwardedEvents = new WeakSet<Event>();
		const isPdfPageClick = (event: MouseEvent | PointerEvent): boolean => {
			const helper = (window as unknown as { __viewerSynctexDiagnosticCapture?: (clientX: number, clientY: number) => ClickCapture | undefined }).__viewerSynctexDiagnosticCapture;
			return helper?.(event.clientX, event.clientY) !== undefined;
		};
		for (const eventName of ["pointerdown", "mousedown"] as const) {
			document.addEventListener(eventName, (event) => {
				const selection = window.getSelection();
				if (selection?.isCollapsed === true && selection.rangeCount > 0 && isPdfPageClick(event)) event.preventDefault();
			}, true);
		}
		document.addEventListener("click", (event) => {
			if (forwardedEvents.has(event)) return;
			const helper = (window as unknown as { __viewerSynctexDiagnosticCapture?: (clientX: number, clientY: number) => ClickCapture | undefined }).__viewerSynctexDiagnosticCapture;
			const capture = helper?.(event.clientX, event.clientY);
			if (capture === undefined) return;
			const pageElement = document.querySelector(`#viewer .page[data-page-number='${capture.target.page}']`) as HTMLElement | null;
			if (!pageElement) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const forwarded = new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				composed: true,
				button: 0,
				buttons: 0,
				clientX: event.clientX,
				clientY: event.clientY,
				view: window,
			});
			forwardedEvents.add(forwarded);
			pageElement.dispatchEvent(forwarded);
			const dispatchTarget = {
				tag: pageElement.tagName.toLowerCase(),
				page: Number(pageElement.dataset.pageNumber),
				...(pageElement.id ? { id: pageElement.id } : {}),
				...(pageElement.className ? { class_name: pageElement.className } : {}),
			};
			void (window as unknown as { __viewerSynctexDiagnosticClick: (value: InteractiveForcedClick) => Promise<void> }).__viewerSynctexDiagnosticClick({ capture, dispatch_target: dispatchTarget });
		}, true);
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape") void (window as unknown as { __viewerSynctexDiagnosticExit: () => Promise<void> }).__viewerSynctexDiagnosticExit();
		}, true);
	});
}

async function coordinateTarget(page: Page, input: { page: number; x: number; y: number }): Promise<{ clientX: number; clientY: number }> {
	await waitForRenderedPage(page, input.page);
	await page.evaluate(({ pageNumber, x, y }) => {
		const pageElement = document.querySelector(`#viewer .page[data-page-number='${pageNumber}']`) as HTMLElement | null;
		const canvasWrapper = pageElement?.querySelector(".canvasWrapper") as HTMLElement | null;
		const viewerContainer = document.getElementById("viewerContainer");
		const application = (window as { PDFViewerApplication?: { pdfViewer?: { _pages?: Array<{ viewport?: unknown }> } } }).PDFViewerApplication;
		const viewport = application?.pdfViewer?._pages?.[pageNumber - 1]?.viewport as { convertToViewportPoint(x: number, y: number): [number, number] } | undefined;
		if (!canvasWrapper || !viewerContainer || !viewport) throw new Error(`PDF.js viewport unavailable for page ${pageNumber}`);
		const viewportPoint = viewport.convertToViewportPoint(x, y);
		const canvasRect = canvasWrapper.getBoundingClientRect();
		const clientX = canvasRect.left + viewportPoint[0];
		const clientY = canvasRect.top + canvasRect.height - viewportPoint[1];
		const containerRect = viewerContainer.getBoundingClientRect();
		viewerContainer.scrollBy({
			left: clientX - (containerRect.left + viewerContainer.clientWidth / 2),
			top: clientY - (containerRect.top + viewerContainer.clientHeight / 2),
		});
	}, { pageNumber: input.page, x: input.x, y: input.y });
	await page.waitForFunction(({ pageNumber, x, y }) => {
		const pageElement = document.querySelector(`#viewer .page[data-page-number='${pageNumber}']`) as HTMLElement | null;
		const canvasWrapper = pageElement?.querySelector(".canvasWrapper") as HTMLElement | null;
		const viewerContainer = document.getElementById("viewerContainer");
		const application = (window as { PDFViewerApplication?: { pdfViewer?: { _pages?: Array<{ viewport?: unknown }> } } }).PDFViewerApplication;
		const viewport = application?.pdfViewer?._pages?.[pageNumber - 1]?.viewport as { convertToViewportPoint(x: number, y: number): [number, number] } | undefined;
		if (!canvasWrapper || !viewerContainer || !viewport) return false;
		const viewportPoint = viewport.convertToViewportPoint(x, y);
		const canvasRect = canvasWrapper.getBoundingClientRect();
		const clientX = canvasRect.left + viewportPoint[0];
		const clientY = canvasRect.top + canvasRect.height - viewportPoint[1];
		const containerRect = viewerContainer.getBoundingClientRect();
		return clientX >= containerRect.left && clientX <= containerRect.right && clientY >= containerRect.top && clientY <= containerRect.bottom;
	}, { pageNumber: input.page, x: input.x, y: input.y }, { timeout: 5_000 });
	return await page.evaluate(({ pageNumber, x, y }) => {
		const pageElement = document.querySelector(`#viewer .page[data-page-number='${pageNumber}']`) as HTMLElement | null;
		const canvasWrapper = pageElement?.querySelector(".canvasWrapper") as HTMLElement | null;
		const application = (window as { PDFViewerApplication?: { pdfViewer?: { _pages?: Array<{ viewport?: unknown }> } } }).PDFViewerApplication;
		const viewport = application?.pdfViewer?._pages?.[pageNumber - 1]?.viewport as { convertToViewportPoint(x: number, y: number): [number, number] } | undefined;
		if (!canvasWrapper || !viewport) throw new Error(`PDF.js viewport unavailable for page ${pageNumber}`);
		const viewportPoint = viewport.convertToViewportPoint(x, y);
		const canvasRect = canvasWrapper.getBoundingClientRect();
		return { clientX: canvasRect.left + viewportPoint[0], clientY: canvasRect.top + canvasRect.height - viewportPoint[1] };
	}, { pageNumber: input.page, x: input.x, y: input.y });
}

async function textTarget(page: Page, text: string, preferredPage?: number): Promise<{ clientX: number; clientY: number; matchedText: string }> {
	const pageCount = await page.evaluate(() => {
		const application = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { pagesCount?: number } } }).PDFViewerApplication;
		return application?.pdfViewer?.pagesCount ?? 0;
	});
	const pages = preferredPage === undefined ? Array.from({ length: pageCount }, (_value, index) => index + 1) : [preferredPage];
	for (const pageNumber of pages) {
		await waitForRenderedPage(page, pageNumber);
		const matched = await page.evaluate(({ targetPage, needle }) => {
			const pageElement = document.querySelector(`#viewer .page[data-page-number='${targetPage}']`) as HTMLElement | null;
			const viewerContainer = document.getElementById("viewerContainer");
			if (!pageElement || !viewerContainer) return undefined;
			const span = Array.from(pageElement.querySelectorAll(".textLayer span")).find((candidate) => {
				const value = candidate.textContent?.trim() ?? "";
				const bounds = candidate.getBoundingClientRect();
				return bounds.width > 0 && bounds.height > 0 && (value === needle || value.includes(needle));
			});
			if (!span) return undefined;
			const range = document.createRange();
			range.selectNodeContents(span);
			const bounds = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 && candidate.height > 0) ?? span.getBoundingClientRect();
			range.detach?.();
			const containerRect = viewerContainer.getBoundingClientRect();
			viewerContainer.scrollBy({
				left: bounds.left + bounds.width / 2 - (containerRect.left + viewerContainer.clientWidth / 2),
				top: bounds.top + bounds.height / 2 - (containerRect.top + viewerContainer.clientHeight / 2),
			});
			return true;
		}, { targetPage: pageNumber, needle: text });
		if (matched === undefined) continue;
		await page.waitForFunction(({ targetPage, needle }) => {
			const pageElement = document.querySelector(`#viewer .page[data-page-number='${targetPage}']`) as HTMLElement | null;
			const viewerContainer = document.getElementById("viewerContainer");
			if (!pageElement || !viewerContainer) return false;
			const span = Array.from(pageElement.querySelectorAll(".textLayer span")).find((candidate) => {
				const value = candidate.textContent?.trim() ?? "";
				const bounds = candidate.getBoundingClientRect();
				return bounds.width > 0 && bounds.height > 0 && (value === needle || value.includes(needle));
			});
			if (!span) return false;
			const range = document.createRange();
			range.selectNodeContents(span);
			const bounds = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 && candidate.height > 0) ?? span.getBoundingClientRect();
			range.detach?.();
			const containerRect = viewerContainer.getBoundingClientRect();
			const centerX = bounds.left + bounds.width / 2;
			const centerY = bounds.top + bounds.height / 2;
			return centerX >= containerRect.left && centerX <= containerRect.right && centerY >= containerRect.top && centerY <= containerRect.bottom;
		}, { targetPage: pageNumber, needle: text }, { timeout: 5_000 });
		return await page.evaluate(({ targetPage, needle }) => {
			const pageElement = document.querySelector(`#viewer .page[data-page-number='${targetPage}']`) as HTMLElement | null;
			if (!pageElement) throw new Error(`rendered PDF.js page ${targetPage} is unavailable`);
			const span = Array.from(pageElement.querySelectorAll(".textLayer span")).find((candidate) => {
				const value = candidate.textContent?.trim() ?? "";
				const bounds = candidate.getBoundingClientRect();
				return bounds.width > 0 && bounds.height > 0 && (value === needle || value.includes(needle));
			});
			if (!span) throw new Error(`visible PDF.js text span containing ${JSON.stringify(needle)} is unavailable`);
			const range = document.createRange();
			range.selectNodeContents(span);
			const bounds = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 && candidate.height > 0) ?? span.getBoundingClientRect();
			range.detach?.();
			return { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2, matchedText: span.textContent?.trim() ?? "" };
		}, { targetPage: pageNumber, needle: text });
	}
	fail(`No visible PDF.js text span contains ${JSON.stringify(text)}${preferredPage === undefined ? "" : ` on page ${preferredPage}`}`);
}

function writeSummary(path: string, artifact: DiagnosticArtifact): void {
	const selected = artifact.clicks[0]?.target;
	const result = probeResult(artifact);
	const sourceFile = stringField(result, "source_file");
	const sourceLine = numberField(result, "line");
	const sourceText = stringField(result, "source_line");
	const groups = Array.isArray(result?.debug_forward_groups) ? result.debug_forward_groups.map(asRecord).filter((group): group is Record<string, unknown> => group !== undefined) : [];
	const selectedGroup = groups.find((group) => group.selected === true);
	const proposal = asRecord(selectedGroup?.proposal);
	const proposalSource = stringField(proposal, "source_file");
	const proposalLine = numberField(proposal, "line");
	const proposalKind = stringField(proposal, "kind");
	const proposalProvenance = stringField(proposal, "provenance");
	const lines = [
		`mode: ${artifact.input.mode}`,
		`pdf: ${artifact.input.pdf}`,
		`viewer: ${artifact.viewer.url}`,
		`clicks: ${artifact.clicks.length}`,
		...(selected === undefined ? [] : [`target: page ${selected.page}, client ${selected.client.x.toFixed(2)},${selected.client.y.toFixed(2)}, PDF ${selected.pdf.x.toFixed(2)},${selected.pdf.y.toFixed(2)}`]),
		`probes: ${artifact.probes.length}`,
		...(sourceFile === undefined || sourceLine === undefined ? [] : [`selected source: ${sourceFile}:${sourceLine}${sourceText === undefined ? "" : ` ${sourceText.slice(0, 200)}`}`]),
		...(proposalSource === undefined || proposalLine === undefined ? [] : [`selected proposal: ${proposalSource}:${proposalLine}${proposalProvenance === undefined ? "" : ` provenance ${proposalProvenance}`}${proposalKind === undefined ? "" : ` (${proposalKind})`}`]),
		...(selectedGroup === undefined ? [] : [`selected group: ${stringField(selectedGroup, "origin") ?? "unknown"}; semantic penalty ${numberField(selectedGroup, "semantic_penalty") ?? "unknown"}; score ${numberField(selectedGroup, "score") ?? "unknown"}`]),
		...(stringField(result, "error") === undefined ? [] : [`probe error: ${stringField(result, "error")}`]),
		`console messages: ${artifact.browser.console.length}`,
		`page errors: ${artifact.browser.page_errors.length}`,
		`request failures: ${artifact.browser.request_failures.length}`,
	].join("\n");
	writePrivateText(path, `${lines}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
	const candidate = value?.[field];
	return typeof candidate === "string" ? candidate : undefined;
}

function numberField(value: Record<string, unknown> | undefined, field: string): number | undefined {
	const candidate = value?.[field];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function probeResult(artifact: DiagnosticArtifact): Record<string, unknown> | undefined {
	return asRecord(asRecord(artifact.probes.at(-1)?.response?.body)?.result);
}

function probeSelectionContext(value: unknown): CapturedProbe["selection_context"] | undefined {
	const body = asRecord(value);
	if (body === undefined) return undefined;
	const textBeforeSelection = stringField(body, "textBeforeSelection");
	const textAfterSelection = stringField(body, "textAfterSelection");
	return textBeforeSelection === undefined && textAfterSelection === undefined
		? undefined
		: { ...(textBeforeSelection === undefined ? {} : { textBeforeSelection }), ...(textAfterSelection === undefined ? {} : { textAfterSelection }) };
}

function probeProposalProvenance(value: unknown): string[] | undefined {
	const result = asRecord(asRecord(value)?.result);
	const values = Array.isArray(result?.debug_forward_groups)
		? result.debug_forward_groups.map((group) => stringField(asRecord(asRecord(group)?.proposal), "provenance")).filter((provenance): provenance is string => provenance !== undefined)
		: [];
	return values.length === 0 ? undefined : [...new Set(values)];
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const captured: Record<string, string> = {};
	for (const name of ["content-type", "content-length", "cache-control"] as const) {
		const value = headers[name];
		if (typeof value === "string") captured[name] = value;
	}
	if (headers["x-agent-synctex-viewer-token"] !== undefined) captured["x-agent-synctex-viewer-token"] = "[redacted]";
	return captured;
}

function writePrivateText(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
}

function restrictOutputFile(path: string): void {
	chmodSync(path, 0o600);
}

function appendBounded(values: string[], value: string): boolean {
	if (values.length >= MAX_BROWSER_DIAGNOSTICS) return false;
	values.push(value);
	return true;
}

async function run(options: CliOptions): Promise<void> {
	const pdfPath = resolvedPath(options.pdf!);
	const outDir = resolvedPath(options.out!);
	if (!existsSync(pdfPath)) fail(`PDF path does not exist: ${pdfPath}`);
	const stat = statSync(pdfPath);
	if (!stat.isFile()) fail(`PDF path is not a file: ${pdfPath}`);
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	chmodSync(outDir, 0o700);
	const beforeScreenshot = join(outDir, "before.png");
	const afterScreenshot = join(outDir, "after.png");
	const summaryPath = join(outDir, "summary.txt");
	const jsonPath = join(outDir, "viewer-synctex-diagnostic.json");
	const mode = options.interactive ? "interactive" : options.text === undefined ? "coordinates" : "text";
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	const captureLimit = options.interactive ? options.clicks ?? MAX_INTERACTIVE_CLICKS : 1;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const requestFailures: string[] = [];
	const browserTruncated = { console: false, page_errors: false, request_failures: false };
	const probes: CapturedProbe[] = [];
	let probesTruncated = false;
	const probesByRequest = new Map<Request, CapturedProbe>();
	const pendingResponseCaptures = new Set<Promise<void>>();
	const clicks: ClickDiagnostic[] = [];
	let clicksTruncated = false;
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let page: Page | undefined;
	try {
		registry.registerPdf({
			pdfId: PDF_ID,
			pdfPath,
			title: basename(pdfPath),
			revision: 1,
			fileSnapshot: { size: stat.size, mtimeMs: stat.mtimeMs },
			workspaceCwd: dirname(pdfPath),
		});
		await server.start();
		const control = new ViewerHostControlClient({ origin: server.origin });
		const debugResponse = await control.send({ type: "set_debug_synctex", pdf_id: PDF_ID, enabled: true });
		if (!debugResponse.ok) fail(`Could not enable debug_synctex: ${debugResponse.error.message}`);

		browser = await chromium.launch({ headless: !options.interactive });
		page = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
		page.on("console", (message) => {
			if (!appendBounded(consoleMessages, `${message.type()}: ${message.text()}`)) browserTruncated.console = true;
		});
		page.on("pageerror", (error) => {
			if (!appendBounded(pageErrors, `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`)) browserTruncated.page_errors = true;
		});
		page.on("requestfailed", (request) => {
			if (!appendBounded(requestFailures, `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`)) browserTruncated.request_failures = true;
			if (!isProbeRequest(request)) return;
			const record = probesByRequest.get(request);
			if (record !== undefined) {
				record.response = { url: canonicalUrl(request.url()), status: 0, headers: {}, body: { error: request.failure()?.errorText ?? "request failed" } };
				probesByRequest.delete(request);
			}
		});
		page.on("response", (response) => {
			if (response.status() >= 400 && !appendBounded(requestFailures, `${response.status()} ${response.request().method()} ${response.url()}`)) browserTruncated.request_failures = true;
			const request = response.request();
			if (!isProbeRequest(request)) return;
			const record = probesByRequest.get(request);
			if (record === undefined) return;
			const pending = captureProbeResponse(response, record);
			pendingResponseCaptures.add(pending);
			void pending.finally(() => {
				pendingResponseCaptures.delete(pending);
				probesByRequest.delete(request);
			});
		});
		page.on("request", (request) => {
			if (!isProbeRequest(request)) return;
			if (probes.length >= captureLimit) {
				probesTruncated = true;
				return;
			}
			const body = jsonValue(request.postData());
			const selectionContext = probeSelectionContext(body);
			const record: CapturedProbe = {
				request: {
					url: canonicalUrl(request.url()),
					method: request.method(),
					headers: redactHeaders(request.headers()),
					body,
				},
				...(selectionContext === undefined ? {} : { selection_context: selectionContext }),
			};
			probes.push(record);
			probesByRequest.set(request, record);
		});

		await page.goto(`${server.origin}/viewer-lw/${PDF_ID}`, { waitUntil: "domcontentloaded" });
		await waitForRenderedPage(page, 1);
		await installCaptureHelper(page);
		await page.screenshot({ path: beforeScreenshot, fullPage: true });
		restrictOutputFile(beforeScreenshot);

		if (options.interactive) {
			let finish: (() => void) | undefined;
			const complete = new Promise<void>((resolveComplete) => { finish = resolveComplete; });
			await installInteractiveForcedClickCapture(page, {
				onClick(value) {
					if (clicks.length >= captureLimit) {
						clicksTruncated = true;
						finish?.();
						return;
					}
					clicks.push({ ...value.capture, forced: true, dispatch_target: value.dispatch_target });
					console.log(`recorded click ${clicks.length}: page ${value.capture.target.page}, PDF ${value.capture.target.pdf.x.toFixed(2)},${value.capture.target.pdf.y.toFixed(2)}`);
					if (clicks.length >= captureLimit) finish?.();
				},
				onExit() {
					finish?.();
				},
			});
			console.log(options.clicks === undefined
				? `Interactive viewer ready. Record up to ${captureLimit} PDF document clicks; press Escape to finish sooner.`
				: `Interactive viewer ready. Click ${captureLimit} PDF document location(s); the runner exits after the last click. Press Escape to exit sooner.`);
			await complete;
			await page.waitForTimeout(300);
		} else {
			const target = options.text === undefined
				? await coordinateTarget(page, { page: options.page!, x: options.x!, y: options.y! })
				: await textTarget(page, options.text, options.page);
			const captured = await captureClick(page, target.clientX, target.clientY);
			if ("matchedText" in target && typeof target.matchedText === "string") captured.matched_text = target.matchedText;
			const responsePromise = page.waitForResponse((response) => isProbeRequest(response.request()), { timeout: 10_000 });
			const dispatchTarget = await forceViewerProbeClick(page, { page: captured.target.page, clientX: target.clientX, clientY: target.clientY });
			clicks.push({ ...captured, forced: true, dispatch_target: dispatchTarget });
			await responsePromise;
			await page.waitForTimeout(100);
		}
		await settleProbeCaptures(probes, pendingResponseCaptures);
		if (!pageIsClosed(page)) {
			await page.screenshot({ path: afterScreenshot, fullPage: true });
			restrictOutputFile(afterScreenshot);
		}

		const artifact: DiagnosticArtifact = {
			input: {
				pdf: pdfPath,
				out: outDir,
				mode,
				...(options.page === undefined ? {} : { page: options.page }),
				...(options.x === undefined ? {} : { x: options.x }),
				...(options.y === undefined ? {} : { y: options.y }),
				...(options.text === undefined ? {} : { text: options.text }),
				...(options.clicks === undefined ? {} : { clicks: options.clicks }),
			},
			viewer: { origin: server.origin, url: `${server.origin}/viewer-lw/${PDF_ID}`, pdf_id: PDF_ID, workspace_cwd: dirname(pdfPath) },
			clicks,
			probes,
			capture: { click_limit: captureLimit, clicks_truncated: clicksTruncated, probe_limit: captureLimit, probes_truncated: probesTruncated },
			browser: { console: consoleMessages, page_errors: pageErrors, request_failures: requestFailures, truncated: browserTruncated },
			artifacts: { before_screenshot: beforeScreenshot, after_screenshot: afterScreenshot, summary: summaryPath, json: jsonPath },
		};
		writeSummary(summaryPath, artifact);
		writePrivateText(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
		console.log(`Viewer SyncTeX diagnostic artifacts written to ${outDir}`);
		console.log(`  JSON: ${jsonPath}`);
		console.log(`  summary: ${summaryPath}`);
		console.log(`  screenshots: ${beforeScreenshot}, ${afterScreenshot}`);
	} finally {
		await browser?.close();
		await server.stop();
	}
}

function canonicalUrl(value: string): string {
	const parsed = new URL(value);
	return `${parsed.pathname}${parsed.search}`;
}

async function settleProbeCaptures(probes: readonly CapturedProbe[], pending: ReadonlySet<Promise<void>>): Promise<void> {
	const deadline = Date.now() + PROBE_CAPTURE_SETTLE_MS;
	while (Date.now() < deadline) {
		await Promise.all([...pending]);
		if (probes.every((probe) => probe.response !== undefined)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	await Promise.all([...pending]);
}

async function captureProbeResponse(response: Response, record: CapturedProbe | undefined): Promise<void> {
	const body = jsonValue(await response.text());
	const captured = {
		url: canonicalUrl(response.url()),
		status: response.status(),
		headers: redactHeaders(await response.allHeaders()),
		body,
	};
	if (record !== undefined) {
		record.response = captured;
		const provenance = probeProposalProvenance(body);
		if (provenance !== undefined) record.proposal_provenance = provenance;
	}
}

async function main(): Promise<void> {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
			return;
		}
		await run(options);
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		console.error(`\n${usage()}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page, type Request, type Response } from "playwright";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostMcpService, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import type { McpToViewerHostMessage, ViewerHostControlResponse } from "../../src/modules/viewer_host_protocol.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

function makeOnePagePdf(): Buffer {
	const chunks: string[] = ["%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n"];
	const offsets: number[] = [0];
	let length = Buffer.byteLength(chunks[0], "binary");
	function addObject(id: number, body: string): void {
		offsets[id] = length;
		const object = `${id} 0 obj\n${body}\nendobj\n`;
		chunks.push(object);
		length += Buffer.byteLength(object, "binary");
	}
	const content = [
		"BT",
		"/F1 18 Tf",
		"36 150 Td",
		"(First paragraph text that should wrap a little and create boxes.) Tj",
		"ET",
		"BT",
		"/F1 5 Tf",
		"36 105 Td",
		"(This prose line contains DRAGTOKENALPHA before the formulas so selection can be checked.) Tj",
		"ET",
		"",
	].join("\n");
	addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
	addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
	addObject(4, `<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}endstream`);
	addObject(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const xrefOffset = length;
	const xref = [
		"xref",
		"0 6",
		"0000000000 65535 f ",
		...Array.from({ length: 5 }, (_, index) => `${String(offsets[index + 1]).padStart(10, "0")} 00000 n `),
		"trailer",
		"<< /Size 6 /Root 1 0 R >>",
		"startxref",
		String(xrefOffset),
		"%%EOF",
		"",
	].join("\n");
	chunks.push(xref);
	return Buffer.from(chunks.join(""), "binary");
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

function writeBrowserSynctexFixture(baseDir: string): { pdfPath: string; sourcePath: string } {
	const pdfPath = join(baseDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFileSync(pdfPath, makeOnePagePdf());
	const fixtureDir = resolve("test/fixtures/synctex-forward");
	copyFileSync(join(fixtureDir, "main.tex"), sourcePath);
	copyFileSync(join(fixtureDir, "paper.synctex"), join(baseDir, "paper.synctex"));
	return { pdfPath, sourcePath };
}

class HttpViewerHostClient implements ViewerHostClient {
	readonly origin: string;
	private readonly client: ViewerHostControlClient;

	constructor(origin: string) {
		this.origin = origin;
		this.client = new ViewerHostControlClient({ origin });
	}

	async send(message: McpToViewerHostMessage): Promise<void> {
		const response: ViewerHostControlResponse = await this.client.send(message);
		if (!response.ok) throw new Error(response.error.message);
	}
}

function callTool(id: number, name: string, args: Record<string, unknown>, service: ViewerHostMcpService) {
	return handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), service.pdfOperations);
}

function assertApproximatelyEqual(actual: number, expected: number, tolerance: number, label: string): void {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${actual} to be within ${tolerance} of ${expected}`);
}

function projectLocalChromiumExecutable(): string | undefined {
	const browsersDir = resolve(process.cwd(), ".ms-playwright");
	if (!existsSync(browsersDir)) return undefined;
	for (const entry of readdirSync(browsersDir)) {
		if (!entry.startsWith("chromium_headless_shell-")) continue;
		const executable = join(browsersDir, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
		if (existsSync(executable)) return executable;
	}
	for (const entry of readdirSync(browsersDir)) {
		if (!entry.startsWith("chromium-")) continue;
		const executable = join(browsersDir, entry, "chrome-linux64", "chrome");
		if (existsSync(executable)) return executable;
	}
	return undefined;
}

function summarizeFailures(consoleMessages: string[], pageErrors: string[], failedRequests: string[]): string {
	return [
		...pageErrors.map((message) => `pageerror: ${message}`),
		...consoleMessages.map((message) => `console: ${message}`),
		...failedRequests.map((message) => `requestfailed: ${message}`),
	].join("\n");
}

async function waitForViewerOutcome(page: Page): Promise<{ rendered: boolean; status: string; timedOut: boolean }> {
	const deadline = Date.now() + 10_000;
	let status = "";
	while (Date.now() < deadline) {
		const state = await page.evaluate(() => {
			const status = document.getElementById("status")?.textContent ?? "";
			const canvas = document.querySelector("#pages canvas[data-page-number='1']") as HTMLCanvasElement | null;
			const rendered = !!canvas && canvas.dataset.rendered === "true" && canvas.width > 0 && canvas.height > 0 && !/^Loading PDF\.js viewer/.test(status) && !/^Loading PDF /.test(status);
			const failed = /unable|failed|error/i.test(status);
			return { rendered, failed, status };
		});
		status = state.status;
		if (state.rendered || state.failed) return { rendered: state.rendered, status, timedOut: false };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return { rendered: false, status, timedOut: true };
}

async function selectRenderedPageTextLayerCaret(page: Page, textBeforeCaret: string): Promise<void> {
	await page.waitForSelector("#pages div[data-page-number='1'] .textLayer[data-rendered='true'] span", { state: "attached", timeout: 2_000 });
	await page.evaluate((before) => {
		const textLayer = document.querySelector("#pages div[data-page-number='1'] .textLayer") as HTMLElement | null;
		if (!textLayer) throw new Error("missing rendered text layer");
		const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const text = node.textContent ?? "";
			const offset = text.indexOf(before) + before.length;
			if (offset >= before.length) {
				const selection = window.getSelection();
				if (!selection) throw new Error("missing window selection");
				const range = document.createRange();
				range.setStart(node, offset);
				range.setEnd(node, offset);
				selection.removeAllRanges();
				selection.addRange(range);
				return;
			}
			node = walker.nextNode();
		}
		throw new Error(`text layer did not contain ${before}`);
	}, textBeforeCaret);
}

async function selectDetachedText(page: Page, selectedText: string): Promise<void> {
	await page.evaluate((text) => {
		let element = document.getElementById("outside-selection-fixture");
		if (!element) {
			element = document.createElement("div");
			element.id = "outside-selection-fixture";
			document.body.appendChild(element);
		}
		element.textContent = text;
		const node = element.firstChild;
		if (!node) throw new Error("missing outside text node");
		const selection = window.getSelection();
		if (!selection) throw new Error("missing window selection");
		const range = document.createRange();
		range.setStart(node, 0);
		range.setEnd(node, text.length);
		selection.removeAllRanges();
		selection.addRange(range);
	}, selectedText);
}

async function selectAdjacentTextLayerBoundary(page: Page, mode: "start-at-previous-end" | "end-at-next-start" | "element-offsets-between-spans"): Promise<string> {
	await page.waitForSelector("#pages div[data-page-number='1'] .textLayer[data-rendered='true'] span", { state: "attached", timeout: 2_000 });
	return await page.evaluate((selectionMode) => {
		const textLayer = document.querySelector("#pages div[data-page-number='1'] .textLayer") as HTMLElement | null;
		if (!textLayer) throw new Error("missing rendered text layer");
		let firstFixture = document.getElementById("boundary-span-a")?.firstChild as Text | null;
		let secondFixture = document.getElementById("boundary-span-b")?.firstChild as Text | null;
		let thirdFixture = document.getElementById("boundary-span-c")?.firstChild as Text | null;
		if (!firstFixture || !secondFixture || !thirdFixture) {
			const firstSpan = document.createElement("span");
			firstSpan.id = "boundary-span-a";
			firstSpan.textContent = "Alpha";
			firstSpan.style.position = "absolute";
			firstSpan.style.left = "20px";
			firstSpan.style.top = "20px";
			const secondSpan = document.createElement("span");
			secondSpan.id = "boundary-span-b";
			secondSpan.textContent = "Beta";
			secondSpan.style.position = "absolute";
			secondSpan.style.left = "70px";
			secondSpan.style.top = "20px";
			const thirdSpan = document.createElement("span");
			thirdSpan.id = "boundary-span-c";
			thirdSpan.textContent = "Gamma";
			thirdSpan.style.position = "absolute";
			thirdSpan.style.left = "110px";
			thirdSpan.style.top = "20px";
			textLayer.append(firstSpan, secondSpan, thirdSpan);
			firstFixture = firstSpan.firstChild as Text;
			secondFixture = secondSpan.firstChild as Text;
			thirdFixture = thirdSpan.firstChild as Text;
		}
		if (selectionMode === "element-offsets-between-spans") {
			const firstSpan = document.getElementById("boundary-span-a");
			const thirdSpan = document.getElementById("boundary-span-c");
			if (!firstSpan || !thirdSpan) throw new Error("missing element boundary spans");
			const selection = window.getSelection();
			if (!selection) throw new Error("missing window selection");
			const range = document.createRange();
			range.setStart(firstSpan, 1);
			range.setEnd(thirdSpan, 0);
			selection.removeAllRanges();
			selection.addRange(range);
			return selection.toString();
		}
		const nodes: Text[] = [firstFixture, secondFixture];
		for (let index = 0; index + 1 < nodes.length; index += 1) {
			const first = nodes[index];
			const second = nodes[index + 1];
			if (first.parentElement === second.parentElement) continue;
			const selection = window.getSelection();
			if (!selection) throw new Error("missing window selection");
			const range = document.createRange();
			if (selectionMode === "start-at-previous-end") {
				range.setStart(first, first.length);
				range.setEnd(second, 1);
			} else {
				range.setStart(first, first.length - 1);
				range.setEnd(second, 0);
			}
			selection.removeAllRanges();
			selection.addRange(range);
			return selection.toString();
		}
		throw new Error("could not find adjacent text-layer spans");
	}, mode);
}

async function selectRenderedPageText(page: Page, selectedText: string): Promise<void> {
	await page.waitForSelector("#pages div[data-page-number='1'] .textLayer[data-rendered='true'] span", { state: "attached", timeout: 2_000 });
	await page.evaluate((needle) => {
		const textLayer = document.querySelector("#pages div[data-page-number='1'] .textLayer") as HTMLElement | null;
		if (!textLayer) throw new Error("missing rendered text layer");
		const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const text = node.textContent ?? "";
			const start = text.indexOf(needle);
			if (start >= 0) {
				const selection = window.getSelection();
				if (!selection) throw new Error("missing window selection");
				const range = document.createRange();
				range.setStart(node, start);
				range.setEnd(node, start + needle.length);
				selection.removeAllRanges();
				selection.addRange(range);
				return;
			}
			node = walker.nextNode();
		}
		throw new Error(`text layer did not contain ${needle}`);
	}, selectedText);
}

async function clickRenderedPagePoint(page: Page, x: number, y: number, options: { ctrl?: boolean } = {}): Promise<void> {
	const box = await page.locator("#pages canvas[data-page-number='1']").boundingBox();
	if (!box) throw new Error("missing rendered canvas box");
	if (options.ctrl) await page.keyboard.down("Control");
	try {
		await page.mouse.click(box.x + x, box.y + y);
	} finally {
		if (options.ctrl) await page.keyboard.up("Control");
	}
}

async function moveRenderedPagePoint(page: Page, x: number, y: number): Promise<void> {
	const box = await page.locator("#pages canvas[data-page-number='1']").boundingBox();
	if (!box) throw new Error("missing rendered canvas box");
	await page.mouse.move(box.x + x, box.y + y);
}

async function dispatchRenderedPageMouseup(page: Page, x: number, y: number): Promise<void> {
	await page.evaluate(({ x, y }) => {
		const pageElement = document.querySelector("#pages div[data-page-number='1']") as HTMLElement | null;
		const canvas = document.querySelector("#pages canvas[data-page-number='1']") as HTMLCanvasElement | null;
		if (!pageElement || !canvas) throw new Error("missing rendered page");
		const rect = canvas.getBoundingClientRect();
		pageElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + x, clientY: rect.top + y }));
	}, { x, y });
}

async function latestReverseSynctexEvent(service: ViewerHostMcpService, id: number): Promise<Record<string, unknown> | undefined> {
	const response = await callTool(id, "get_pdf_events", { pdf_id: 209, max_events: 30 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
	return (response.result?.details?.events ?? []).filter((candidate) => candidate.type === "reverse_synctex").at(-1);
}

async function waitForLatestReverseSynctexEvent(service: ViewerHostMcpService, id: number, predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
	let event: Record<string, unknown> | undefined;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		event = await latestReverseSynctexEvent(service, id);
		if (event && predicate(event)) return event;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return event;
}

async function dispatchMouseupThenFinalizeSelection(page: Page, prefixText: string, finalText: string, x: number, y: number): Promise<void> {
	await page.waitForSelector("#pages div[data-page-number='1'] .textLayer[data-rendered='true'] span", { state: "attached", timeout: 2_000 });
	await page.evaluate(({ prefixText, finalText, x, y }) => {
		const pageElement = document.querySelector("#pages div[data-page-number='1']") as HTMLElement | null;
		const canvas = document.querySelector("#pages canvas[data-page-number='1']") as HTMLCanvasElement | null;
		const textLayer = document.querySelector("#pages div[data-page-number='1'] .textLayer") as HTMLElement | null;
		if (!pageElement || !canvas || !textLayer) throw new Error("missing rendered page");
		const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const text = node.textContent ?? "";
			const start = text.indexOf(finalText);
			if (start >= 0) {
				const textNode = node;
				const selection = window.getSelection();
				if (!selection) throw new Error("missing window selection");
				const selectText = (length: number) => {
					const range = document.createRange();
					range.setStart(textNode, start);
					range.setEnd(textNode, start + length);
					selection.removeAllRanges();
					selection.addRange(range);
				};
				selectText(prefixText.length);
				const rect = canvas.getBoundingClientRect();
				pageElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + x, clientY: rect.top + y }));
				setTimeout(() => selectText(finalText.length), 80);
				return;
			}
			node = walker.nextNode();
		}
		throw new Error(`text layer did not contain ${finalText}`);
	}, { prefixText, finalText, x, y });
}

async function dragSelectRenderedPageText(page: Page, selectedText: string, direction: "forward" | "backward" = "forward"): Promise<string> {
	await page.waitForSelector("#pages div[data-page-number='1'] .textLayer[data-rendered='true'] span", { state: "attached", timeout: 2_000 });
	const points = await page.evaluate((needle) => {
		const textLayer = document.querySelector("#pages div[data-page-number='1'] .textLayer") as HTMLElement | null;
		if (!textLayer) throw new Error("missing rendered text layer");
		window.getSelection()?.removeAllRanges();
		const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const text = node.textContent ?? "";
			const start = text.indexOf(needle);
			if (start >= 0) {
				const startProbe = document.createRange();
				startProbe.setStart(node, start);
				startProbe.setEnd(node, start + 1);
				const startRect = startProbe.getBoundingClientRect();
				startProbe.detach?.();
				const endProbe = document.createRange();
				endProbe.setStart(node, start + needle.length - 1);
				endProbe.setEnd(node, start + needle.length);
				const endRect = endProbe.getBoundingClientRect();
				endProbe.detach?.();
				return {
					startX: startRect.left + 1,
					startY: startRect.top + startRect.height / 2,
					endX: endRect.right - 1,
					endY: endRect.top + endRect.height / 2,
				};
			}
			node = walker.nextNode();
		}
		throw new Error(`text layer did not contain ${needle}`);
	}, selectedText);
	const from = direction === "forward" ? { x: points.startX, y: points.startY } : { x: points.endX, y: points.endY };
	const to = direction === "forward" ? { x: points.endX, y: points.endY } : { x: points.startX, y: points.startY };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 12 });
	await page.mouse.up();
	return await page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function waitForSynctexCircleStyle(page: Page, expected: { left: number; top: number }, tolerance = 1): Promise<void> {
	await page.waitForFunction(({ left, top, tolerance }) => {
		const marker = document.querySelector("[data-synctex-marker][data-synctex-marker-kind='circle']") as HTMLElement | null;
		if (!marker) return false;
		const actualLeft = Number.parseFloat(marker.style.left);
		const actualTop = Number.parseFloat(marker.style.top);
		return Math.abs(actualLeft - left) <= tolerance && Math.abs(actualTop - top) <= tolerance;
	}, { left: expected.left, top: expected.top, tolerance }, { timeout: 2_000 });
}

async function synctexMarkerGeometry(page: Page): Promise<{
	marker: { left: number; right: number; top: number; bottom: number; width: number; height: number; centerX: number; centerY: number };
	canvas: { left: number; right: number; top: number; bottom: number; width: number; height: number };
	style: { left: number; top: number };
}> {
	return await page.locator("[data-synctex-marker]").evaluate((element) => {
		const markerRect = element.getBoundingClientRect();
		const canvas = document.querySelector("#pages canvas[data-page-number='1']") as HTMLCanvasElement | null;
		if (!canvas) throw new Error("missing rendered canvas");
		const canvasRect = canvas.getBoundingClientRect();
		return {
			marker: {
				left: markerRect.left,
				right: markerRect.right,
				top: markerRect.top,
				bottom: markerRect.bottom,
				width: markerRect.width,
				height: markerRect.height,
				centerX: markerRect.left + markerRect.width / 2,
				centerY: markerRect.top + markerRect.height / 2,
			},
			canvas: {
				left: canvasRect.left,
				right: canvasRect.right,
				top: canvasRect.top,
				bottom: canvasRect.bottom,
				width: canvasRect.width,
				height: canvasRect.height,
			},
			style: {
				left: Number.parseFloat((element as HTMLElement).style.left),
				top: Number.parseFloat((element as HTMLElement).style.top),
			},
		};
	});
}

test("Viewer Host-served Viewer Client connects viewer socket, sends reverse SyncTeX clicks, and renders forward markers", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-socket-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({
		registry,
		mcpEventSink: (message) => service?.handleHostMessage(message),
	});
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 209 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer/209`, { waitUntil: "domcontentloaded" });
		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		await assert.doesNotReject(async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (server.getConnectedViewerCount(209) === 1) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(server.getConnectedViewerCount(209), 1);
		});

		await clickRenderedPagePoint(page, 180, 194);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const emptyResponse = await callTool(2, "get_pdf_events", { pdf_id: 209, max_events: 5 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
		assert.equal(emptyResponse.result?.details?.events?.length ?? 0, 0, "plain click must not send reverse SyncTeX events");

		await clickRenderedPagePoint(page, 180, 194, { ctrl: true });

		let event: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(2, "get_pdf_events", { pdf_id: 209, max_events: 5 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			event = response.result?.details?.events?.[0];
			if (event) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(event, `reverse SyncTeX event was not stored\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		assert.equal(event.pdf_id, 209);
		assert.equal(event.source_file, sourcePath);
		assert.equal(event.line, 3);
		assert.equal(event.source_line, "First paragraph text that should wrap a little and create boxes.");
		assert.equal(event.page, 1);
		assertApproximatelyEqual(Number(event.x), 144, 1, "reverse x PDF coordinate");
		assertApproximatelyEqual(Number(event.y), 155, 1, "reverse y PDF coordinate");

		await selectRenderedPageText(page, "paragraph text");
		await dispatchRenderedPageMouseup(page, 190, 194);
		let selectionEvent: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(3, "get_pdf_events", { pdf_id: 209, max_events: 20 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			const events = response.result?.details?.events ?? [];
			selectionEvent = events.filter((candidate) => candidate.type === "reverse_synctex").at(-1);
			if (selectionEvent?.selected_text === "paragraph text") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(selectionEvent?.selected_text, "paragraph text");
		assert.ok(selectionEvent?.selection_start, "selected range start should be mapped to source");
		assert.ok(selectionEvent?.selection_end, "selected range end should be mapped to source");
		assert.equal((selectionEvent.selection_start as Record<string, unknown>).source_file, sourcePath);
		assert.equal((selectionEvent.selection_end as Record<string, unknown>).source_file, sourcePath);
		assert.equal((selectionEvent.selection_start as Record<string, unknown>).page, 1);
		assert.equal((selectionEvent.selection_end as Record<string, unknown>).page, 1);
		assertApproximatelyEqual(Number((selectionEvent.selection_start as Record<string, unknown>).x), Number(selectionEvent.x), 0.001, "selection event primary x should be first endpoint x");
		assertApproximatelyEqual(Number((selectionEvent.selection_start as Record<string, unknown>).y), Number(selectionEvent.y), 0.001, "selection event primary y should be first endpoint y");
		assert.equal(typeof (selectionEvent.selection_start as Record<string, unknown>).x, "number");
		assert.equal(typeof (selectionEvent.selection_end as Record<string, unknown>).y, "number");

		let selectionDebugEvents: Array<Record<string, unknown>> = [];
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(3, "get_pdf_events", { pdf_id: 209, max_events: 80, stale: true, debug: true }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			selectionDebugEvents = (response.result?.details?.events ?? []).filter((candidate) => candidate.type === "selection_debug");
			const phases = new Set(selectionDebugEvents.map((candidate) => candidate.phase));
			if (["selectionchange", "mouseup", "scheduler_tick", "send", "post_send_audit"].every((phase) => phases.has(phase))) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const selectionDebugPhases = new Set(selectionDebugEvents.map((candidate) => candidate.phase));
		for (const phase of ["selectionchange", "mouseup", "scheduler_tick", "send", "post_send_audit"]) {
			assert.ok(selectionDebugPhases.has(phase), `selection diagnostics should include ${phase}`);
		}
		const sendDebug = selectionDebugEvents.find((candidate) => candidate.phase === "send" && (candidate.details as Record<string, unknown> | undefined)?.selectedPayloadText === "paragraph text");
		assert.ok(sendDebug, "selection diagnostics should include send payload details");
		assert.equal((sendDebug.details as Record<string, unknown>).selectedPayloadTextLength, "paragraph text".length);
		assert.equal((sendDebug.details as Record<string, unknown>).selectionTextLength, "paragraph text".length);

		await clickRenderedPagePoint(page, 190, 194, { ctrl: true });
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const duplicateResponse = await callTool(4, "get_pdf_events", { pdf_id: 209, max_events: 20 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
		const duplicateReverseEvents = (duplicateResponse.result?.details?.events ?? []).filter((candidate) => candidate.type === "reverse_synctex");
		assert.equal(duplicateReverseEvents.length, 0, "selection auto-send and delayed follow-up Ctrl+Click must not duplicate the same selected range");

		const finalSelectionBaselineSequence = Number(selectionEvent.sequence);
		assert.ok(Number.isFinite(finalSelectionBaselineSequence), "previous selection event should have a sequence");
		const earlySelectionPrefix = "First";
		const disallowedFinalSelectionTexts = new Set(["First", earlySelectionPrefix]);
		const finalSelectionText = "First paragraph";
		await dispatchMouseupThenFinalizeSelection(page, earlySelectionPrefix, finalSelectionText, 180, 194);
		let finalizedSelectionEvent: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(5, "get_pdf_events", { pdf_id: 209, max_events: 20 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			finalizedSelectionEvent = (response.result?.details?.events ?? []).filter((candidate) => candidate.type === "reverse_synctex").at(-1);
			if (finalizedSelectionEvent?.selected_text === finalSelectionText) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(finalizedSelectionEvent?.selected_text, finalSelectionText, "auto-send should wait for final browser selection, not the mouseup prefix");
		const finalizedSelectionSequence = Number(finalizedSelectionEvent.sequence);
		assert.ok(Number.isFinite(finalizedSelectionSequence), "finalized selection event should have a sequence");
		const finalizedSelectionStaleResponse = await callTool(5, "get_pdf_events", { pdf_id: 209, max_events: 50, stale: true }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
		const finalizedInteractionEvents = (finalizedSelectionStaleResponse.result?.details?.events ?? []).filter((candidate) => {
			const sequence = Number(candidate.sequence);
			return sequence > finalSelectionBaselineSequence && sequence <= finalizedSelectionSequence;
		});
		assert.ok(finalizedInteractionEvents.length > 0, "stale event read should retain the finalized-selection interaction events");
		assert.deepEqual(
			finalizedInteractionEvents.filter((candidate) => disallowedFinalSelectionTexts.has(candidate.selected_text as string)),
			[],
			"finalized-selection interaction must not emit the mouseup prefix before the final browser selection",
		);

		await selectDetachedText(page, "stale outside page selection");
		await clickRenderedPagePoint(page, 180, 194, { ctrl: true });
		let staleSelectionEvent: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(5, "get_pdf_events", { pdf_id: 209, max_events: 20 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			staleSelectionEvent = (response.result?.details?.events ?? []).filter((candidate) => candidate.type === "reverse_synctex").at(-1);
			if (Number(staleSelectionEvent?.sequence) > Number(finalizedSelectionEvent?.sequence)) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(staleSelectionEvent?.selected_text, undefined, "selection outside clicked page should be ignored");
		assert.equal(staleSelectionEvent?.selection_start, undefined, "selection outside clicked page should not attach range start");

		await dragSelectRenderedPageText(page, "paragraph text that should");
		let dragSelectionEvent: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(6, "get_pdf_events", { pdf_id: 209, max_events: 20 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			dragSelectionEvent = (response.result?.details?.events ?? []).filter((candidate) => candidate.type === "reverse_synctex").at(-1);
			if (typeof dragSelectionEvent?.selected_text === "string" && dragSelectionEvent.selected_text.includes("paragraph") && dragSelectionEvent.selected_text.includes("text that")) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const dragSelectedText = dragSelectionEvent?.selected_text;
		assert.equal(typeof dragSelectedText, "string", "real-ish text-layer drag should emit selected text without an extra click");
		assert.match(dragSelectedText as string, /paragraph/);
		assert.match(dragSelectedText as string, /text that/, "drag selection should include suffix after the selected token");
		const dragDebugResponse = await callTool(6, "get_pdf_events", { pdf_id: 209, max_events: 80, stale: true, debug: true }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
		const dragDebugPhases = new Set((dragDebugResponse.result?.details?.events ?? []).filter((candidate) => candidate.type === "selection_debug").map((candidate) => candidate.phase));
		assert.ok(dragDebugPhases.has("mousedown"), "drag selection diagnostics should include mousedown");

		const exactDragText = "This prose line contains DRAGTOKENALPHA";
		for (const direction of ["forward", "backward"] as const) {
			const previousSequence = Number((await latestReverseSynctexEvent(service, 6))?.sequence ?? 0);
			const rawSelectionText = await dragSelectRenderedPageText(page, exactDragText, direction);
			assert.ok(rawSelectionText.includes(exactDragText), `${direction} real browser drag raw selection should include the exact intended phrase; selected ${JSON.stringify(rawSelectionText)}`);
			const exactDragEvent = await waitForLatestReverseSynctexEvent(service, 6, (candidate) => Number(candidate.sequence) > previousSequence && typeof candidate.selected_text === "string");
			assert.ok(
				(exactDragEvent?.selected_text as string | undefined)?.includes(exactDragText),
				`${direction} real browser drag reverse event should include the exact intended phrase; event text ${JSON.stringify(exactDragEvent?.selected_text)}`,
			);
		}

		for (const mode of ["start-at-previous-end", "end-at-next-start", "element-offsets-between-spans"] as const) {
			const boundaryText = await selectAdjacentTextLayerBoundary(page, mode);
			await dispatchRenderedPageMouseup(page, 190, 194);
			let boundaryEvent: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				const response = await callTool(6, "get_pdf_events", { pdf_id: 209, max_events: 20 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
				boundaryEvent = (response.result?.details?.events ?? []).filter((candidate) => candidate.type === "reverse_synctex").at(-1);
				if (boundaryEvent?.selected_text === boundaryText) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(boundaryEvent?.selected_text, boundaryText, `${mode} selected text should survive boundary endpoint extraction`);
			assert.ok(boundaryEvent?.selection_start, `${mode} should map selection start`);
			assert.ok(boundaryEvent?.selection_end, `${mode} should map selection end`);
		}

		const auditSentText = "paragraph text";
		await selectRenderedPageText(page, auditSentText);
		await dispatchRenderedPageMouseup(page, 190, 194);
		let auditReverseEvent: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(7, "get_pdf_events", { pdf_id: 209, max_events: 20 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			auditReverseEvent = (response.result?.details?.events ?? []).filter((candidate) => candidate.type === "reverse_synctex").at(-1);
			if (auditReverseEvent?.selected_text === auditSentText) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(auditReverseEvent?.selected_text, auditSentText, "audit setup should send the selected text");
		await selectRenderedPageText(page, "First");
		let changedAudit: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(7, "get_pdf_events", { pdf_id: 209, max_events: 120, stale: true, debug: true }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			changedAudit = (response.result?.details?.events ?? []).find((candidate) => {
				const details = candidate.details as Record<string, unknown> | undefined;
				return candidate.type === "selection_debug" && candidate.phase === "post_send_audit" && details?.sentText === auditSentText && details.changed === true && details.currentText === "First";
			});
			if (changedAudit) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(changedAudit, "post-send audit should detect when current selection changes after send");

		const control = new ViewerHostControlClient({ origin: server.origin });
		assert.deepEqual(await control.send({ type: "synctex_forward", pdf_id: 209, page: 1, x: 100, y: 40, indicator: true, source_file: sourcePath, line: 3 }), { ok: true, result: { type: "synctex_forward", pdf_id: 209 } });
		await page.waitForSelector("[data-synctex-marker][data-synctex-marker-kind='circle']", { state: "attached", timeout: 2_000 });
		const marker = await page.locator("[data-synctex-marker]").evaluate((element) => ({
			left: Number.parseFloat((element as HTMLElement).style.left),
			top: Number.parseFloat((element as HTMLElement).style.top),
			width: (element as HTMLElement).style.width,
			height: (element as HTMLElement).style.height,
			focused: element === document.activeElement,
		}));
		assertApproximatelyEqual(marker.left, 125, 1, "forward marker left viewport coordinate");
		assertApproximatelyEqual(marker.top, 50, 1, "forward marker top-origin viewport coordinate");
		assert.equal(marker.width, "0.5em", "LW circle marker should not invent rectangle width from missing SyncTeX width");
		assert.equal(marker.height, "0.5em", "LW circle marker should not invent rectangle height from missing SyncTeX height");
		assert.equal(marker.focused, true, "forward marker should be focusable and focused after jump");

		assert.deepEqual(await control.send({ type: "synctex_forward", pdf_id: 209, page: 1, x: 100, y: 40, width: 10, height: 8, source_file: sourcePath, line: 3 }), { ok: true, result: { type: "synctex_forward", pdf_id: 209 } });
		await page.waitForSelector("[data-synctex-marker][data-synctex-marker-kind='rect']", { state: "attached", timeout: 2_000 });
		const scalarRect = await page.locator("[data-synctex-marker]").evaluate((element) => ({
			left: Number.parseFloat((element as HTMLElement).style.left),
			top: Number.parseFloat((element as HTMLElement).style.top),
			width: Number.parseFloat((element as HTMLElement).style.width),
			height: Number.parseFloat((element as HTMLElement).style.height),
			kind: (element as HTMLElement).dataset.synctexMarkerKind,
			border: (element as HTMLElement).style.border,
			background: (element as HTMLElement).style.background,
		}));
		assert.equal(scalarRect.kind, "rect");
		assertApproximatelyEqual(scalarRect.left, 125, 1, "scalar rectangle marker left viewport coordinate");
		assertApproximatelyEqual(scalarRect.top, 50, 1, "scalar rectangle marker top-origin viewport coordinate");
		assertApproximatelyEqual(scalarRect.width, 12.5, 0.5, "scalar rectangle marker width");
		assertApproximatelyEqual(scalarRect.height, 10, 0.5, "scalar rectangle marker height");
		assert.equal(scalarRect.border, "0px", "rectangle highlight should not draw a red border");
		assert.notEqual(scalarRect.background, "", "rectangle highlight should keep background highlight");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host-served Viewer Client places circle markers at left, center, and right PDF points", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-circles-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({
		registry,
		mcpEventSink: (message) => service?.handleHostMessage(message),
	});
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 229 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 240, height: 160 } });
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer/229`, { waitUntil: "domcontentloaded" });
		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		await assert.doesNotReject(async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (server.getConnectedViewerCount(229) === 1) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(server.getConnectedViewerCount(229), 1);
		});

		const control = new ViewerHostControlClient({ origin: server.origin });
		const points = [
			{ label: "left", x: 20, y: 40, expectedX: 25, expectedY: 50 },
			{ label: "center", x: 150, y: 40, expectedX: 187.5, expectedY: 50 },
			{ label: "right", x: 280, y: 40, expectedX: 350, expectedY: 50 },
		];
		for (const point of points) {
			assert.deepEqual(await control.send({ type: "synctex_forward", pdf_id: 229, page: 1, x: point.x, y: point.y, indicator: true, source_file: sourcePath, line: 3 }), { ok: true, result: { type: "synctex_forward", pdf_id: 229 } });
			await waitForSynctexCircleStyle(page, { left: point.expectedX, top: point.expectedY });
			const geometry = await synctexMarkerGeometry(page);
			assertApproximatelyEqual(geometry.style.left, point.expectedX, 1, `${point.label} circle style left`);
			assertApproximatelyEqual(geometry.style.top, point.expectedY, 1, `${point.label} circle style top`);
			assertApproximatelyEqual(geometry.marker.centerX - geometry.canvas.left, point.expectedX, 1, `${point.label} circle bounding-box center x within canvas`);
			assertApproximatelyEqual(geometry.marker.centerY - geometry.canvas.top, point.expectedY, 1, `${point.label} circle bounding-box center y within canvas`);
			assert.ok(geometry.marker.left >= geometry.canvas.left - 0.5, `${point.label} circle should be inside rendered canvas left edge`);
			assert.ok(geometry.marker.right <= geometry.canvas.right + 0.5, `${point.label} circle should be inside rendered canvas right edge`);
			assert.ok(geometry.marker.top >= geometry.canvas.top - 0.5, `${point.label} circle should be inside rendered canvas top edge`);
			assert.ok(geometry.marker.bottom <= geometry.canvas.bottom + 0.5, `${point.label} circle should be inside rendered canvas bottom edge`);
			if (point.label !== "left") {
				assert.ok(geometry.marker.centerX > 20, `${point.label} circle should not be pinned to the viewport left edge`);
				assert.ok(geometry.style.left > 20, `${point.label} circle should not be pinned to the page left edge`);
			}
		}
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host-served Viewer Client renders multiple native rectangle markers and keeps all primary-page rectangles visible", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-rectangles-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({
		registry,
		mcpEventSink: (message) => service?.handleHostMessage(message),
	});
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 219 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 240, height: 160 } });
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer/219`, { waitUntil: "domcontentloaded" });
		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		await assert.doesNotReject(async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (server.getConnectedViewerCount(219) === 1) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(server.getConnectedViewerCount(219), 1);
		});

		const control = new ViewerHostControlClient({ origin: server.origin });
		assert.deepEqual(await control.send({
			type: "synctex_forward",
			pdf_id: 219,
			page: 1,
			x: 50,
			y: 100,
			ranges: [
				{ page: 1, h: 20, v: 30, W: 10, H: 4 },
				{ page: 1, h: 80, v: 190, W: 20, H: 10 },
			],
			source_file: sourcePath,
			line: 3,
		}), { ok: true, result: { type: "synctex_forward", pdf_id: 219 } });
		await page.waitForSelector("[data-synctex-marker][data-synctex-marker-kind='rect']", { state: "attached", timeout: 2_000 });
		const markers = page.locator("[data-synctex-marker]");
		const markerKinds = await markers.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.synctexMarkerKind));
		const markerStyles = await markers.evaluateAll((elements) => elements.map((element) => {
			const marker = element as HTMLElement;
			return {
				left: Number.parseFloat(marker.style.left),
				top: Number.parseFloat(marker.style.top),
				width: Number.parseFloat(marker.style.width),
				height: Number.parseFloat(marker.style.height),
			};
		}));
		assert.equal(markerKinds.length, 2);
		assert.equal(markerKinds.every((kind) => kind === "rect"), true);
		assert.equal(markerStyles.length, 2);
		const expected = [
			{ left: 25, top: 32.5, width: 12.5, height: 5 },
			{ left: 100, top: 225, width: 25, height: 12.5 },
		];
		for (let index = 0; index < expected.length; index += 1) {
			const actual = markerStyles[index];
			const target = expected[index];
			if (!actual) continue;
			assertApproximatelyEqual(actual.left, target.left, 0.5, `rectangle marker ${index} left`);
			assertApproximatelyEqual(actual.top, target.top, 0.5, `rectangle marker ${index} top`);
			assertApproximatelyEqual(actual.width, target.width, 0.5, `rectangle marker ${index} width`);
			assertApproximatelyEqual(actual.height, target.height, 0.5, `rectangle marker ${index} height`);
		}
		const activeKind = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.synctexMarkerKind);
		assert.equal(activeKind, "rect", "rectangle marker should remain the focused marker kind");
		const scrolled = await page.evaluate(() => window.scrollY);
		assert.ok(scrolled > 0, `expected viewer to scroll to rectangle union, saw scrollY=${scrolled}`);

		assert.deepEqual(await control.send({
			type: "synctex_forward",
			pdf_id: 219,
			page: 1,
			x: 20,
			y: 30,
			ranges: [{ page: 1, h: 20, v: 30, W: 140, H: 0 }],
			source_file: sourcePath,
			line: 17,
		}), { ok: true, result: { type: "synctex_forward", pdf_id: 219 } });
		await page.waitForFunction(() => {
			const markers = Array.from(document.querySelectorAll("[data-synctex-marker][data-synctex-marker-kind='rect']")) as HTMLElement[];
			if (markers.length !== 1) return false;
			const marker = markers[0];
			return Math.abs(Number.parseFloat(marker.style.width) - 175) <= 0.5 && Math.abs(Number.parseFloat(marker.style.height) - 2) <= 0.5;
		}, undefined, { timeout: 2_000 });
		const zeroHeightMarkers = await page.locator("[data-synctex-marker]").evaluateAll((elements) => elements.map((element) => {
			const marker = element as HTMLElement;
			return {
				width: Number.parseFloat(marker.style.width),
				height: Number.parseFloat(marker.style.height),
				border: marker.style.border,
				background: marker.style.background,
			};
		}));
		assert.equal(zeroHeightMarkers.length, 1, "zero-height native rectangle jump should replace previous markers with one row marker");
		const zeroHeightMarker = zeroHeightMarkers[0];
		assert.ok(zeroHeightMarker, "zero-height native rectangle marker should exist");
		assertApproximatelyEqual(zeroHeightMarker.width, 175, 0.5, "zero-height native rectangle should keep its scaled row width");
		assertApproximatelyEqual(zeroHeightMarker.height, 2, 0.5, "zero-height native rectangle should use the minimum visible fallback height");
		assert.equal(zeroHeightMarker.border, "0px", "zero-height native rectangle highlight should not draw a red border");
		assert.notEqual(zeroHeightMarker.background, "", "zero-height native rectangle should keep a background highlight");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host-served Viewer Client toggles reverse SyncTeX hover overlay without storing hover events", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-hover-"));
	const outDir = join(baseDir, "out");
	mkdirSync(outDir);
	const pdfPath = join(outDir, "paper.pdf");
	const sourcePath = join(baseDir, "main.tex");
	writeFileSync(pdfPath, makeOnePagePdf());
	const fixtureDir = resolve("test/fixtures/synctex-forward");
	copyFileSync(join(fixtureDir, "main.tex"), sourcePath);
	copyFileSync(join(fixtureDir, "paper.synctex"), join(outDir, "paper.synctex"));
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	const sentViewerMessages: Array<Record<string, unknown>> = [];
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 239 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});
		page.on("websocket", (socket) => {
			socket.on("framesent", (frame: { payload: string | Buffer }) => {
				try {
					const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
					const parsed = JSON.parse(payload) as Record<string, unknown>;
					sentViewerMessages.push(parsed);
				} catch { }
			});
		});

		await page.goto(`${server.origin}/viewer/239`, { waitUntil: "domcontentloaded" });
		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		for (let attempt = 0; attempt < 20 && server.getConnectedViewerCount(239) !== 1; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(server.getConnectedViewerCount(239), 1);

		const toggle = page.locator("#synctex-hover-toggle");
		await assert.doesNotReject(() => toggle.waitFor({ state: "visible", timeout: 2_000 }));
		assert.equal(await toggle.textContent(), "SyncTeX hover: off");
		assert.equal(await toggle.getAttribute("aria-pressed"), "false");

		await moveRenderedPagePoint(page, 160, 80);
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(sentViewerMessages.some((message) => message.type === "reverse_synctex_hover"), false, "mousemove while disabled should not send hover requests");
		await clickRenderedPagePoint(page, 180, 100);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(sentViewerMessages.some((message) => message.type === "reverse_synctex_forward_probe"), false, "plain click while disabled should not send probe requests");
		assert.equal(await page.locator("[data-reverse-synctex-hover]").count(), 0, "disabled hover should not draw overlay");
		assert.equal(await page.locator("[data-reverse-synctex-forward-probe]").count(), 0, "disabled probe should not draw overlay");

		await toggle.click();
		assert.equal(await toggle.getAttribute("aria-pressed"), "true");
		await moveRenderedPagePoint(page, 180, 100);
		let hoverRequest: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			hoverRequest = sentViewerMessages.find((message) => message.type === "reverse_synctex_hover");
			if (hoverRequest) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(hoverRequest, `enabled hover did not send request\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		assert.equal(hoverRequest.page, 1);
		assert.equal(typeof hoverRequest.request_id, "number");

		await page.waitForSelector("[data-reverse-synctex-hover='rect']", { state: "attached", timeout: 2_000 });
		await page.waitForSelector("[data-reverse-synctex-hover='label']", { state: "attached", timeout: 2_000 });
		assert.match(await page.locator("[data-reverse-synctex-hover='label']").textContent() ?? "", /main\.tex:3 First paragraph/);
		const control = new ViewerHostControlClient({ origin: server.origin });
		await control.send({ type: "reverse_synctex_hover_result", pdf_id: 239, request_id: Number(hoverRequest.request_id), page: 1, x: Number(hoverRequest.x), y: Number(hoverRequest.y), source_file: sourcePath, line: 4, column: 0, source_line: "Second paragraph text", rect: { left: 20, top: 30, right: 80, bottom: 50 }, precision: "verified", raw: { source_file: sourcePath, line: 99, column: 0, source_line: "\\end{document}", score: 1000, structural: true, distance: 0 }, repaired: { source_file: sourcePath, line: 4, column: 0, source_line: "Second paragraph text", precision: "verified" }, candidates: [{ source_file: sourcePath, line: 99, column: 0, source_line: "\\end{document}", score: 1000, structural: true, distance: 0 }, { source_file: sourcePath, line: 4, column: 0, source_line: "Second paragraph text", score: 4, structural: false, distance: 4 }], forward: { attempted: true, contains_click: true, boxes_considered: 2, boxes_filtered: 1, chosen_box: { page: 1, h: 20, v: 30, W: 60, H: 20 } } });
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const labelText = await page.locator("[data-reverse-synctex-hover='label']").textContent() ?? "";
			if (/raw: line 99/.test(labelText)) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.match(await page.locator("[data-reverse-synctex-hover='label']").textContent() ?? "", /raw: line 99/);
		assert.match(await page.locator("[data-reverse-synctex-hover='label']").textContent() ?? "", /repair: line 4 .*\[verified\]/);

		await clickRenderedPagePoint(page, 180, 100);
		let probeRequest: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			probeRequest = sentViewerMessages.find((message) => message.type === "reverse_synctex_forward_probe");
			if (probeRequest) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(probeRequest, `enabled plain click did not send probe\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		assert.equal(probeRequest.page, 1);
		assert.equal(typeof probeRequest.request_id, "number");
		await page.waitForSelector("[data-reverse-synctex-forward-probe='marker']", { state: "attached", timeout: 2_000 });
		await page.waitForSelector("[data-reverse-synctex-forward-probe='label']", { state: "attached", timeout: 2_000 });
		assert.match(await page.locator("[data-reverse-synctex-forward-probe='label']").textContent() ?? "", /reverse line 3 -> forward boxes/);

		const oldProbeMarkerCount = await page.locator("[data-reverse-synctex-forward-probe='marker']").count();
		const previousProbeRequestCount = sentViewerMessages.filter((message) => message.type === "reverse_synctex_forward_probe").length;
		await clickRenderedPagePoint(page, 181, 101);
		let latestProbeRequest = probeRequest;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const probeRequests = sentViewerMessages.filter((message) => message.type === "reverse_synctex_forward_probe");
			if (probeRequests.length > previousProbeRequestCount) {
				latestProbeRequest = probeRequests.at(-1) ?? probeRequest;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.notEqual(latestProbeRequest.request_id, probeRequest.request_id, "second plain click should send a fresh probe request");
		await control.send({ type: "reverse_synctex_forward_probe_result", pdf_id: 239, request_id: Number(probeRequest.request_id), click_page: 1, click_x: Number(probeRequest.x), click_y: Number(probeRequest.y), reverse_source_file: sourcePath, reverse_line: 99, reverse_column: 0, page: 1, x: 10, y: 10, source_file: sourcePath, line: 99 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(await page.locator("[data-reverse-synctex-forward-probe='marker']").count(), oldProbeMarkerCount, "stale probe result should be ignored");
		await control.send({ type: "reverse_synctex_forward_probe_result", pdf_id: 239, request_id: Number(latestProbeRequest.request_id), click_page: 1, click_x: Number(latestProbeRequest.x), click_y: Number(latestProbeRequest.y), reverse_source_file: sourcePath, reverse_line: 4, reverse_column: 0, page: 1, x: 143.73, y: 154.69, ranges: [{ page: 1, h: 120, v: 160, W: 20, H: 8 }], source_file: sourcePath, line: 4 });
		await page.waitForSelector("[data-reverse-synctex-forward-probe='label']", { state: "attached", timeout: 2_000 });
		assert.match(await page.locator("[data-reverse-synctex-forward-probe='label']").textContent() ?? "", /reverse line 4 -> forward boxes/);

		const probeCountBeforeCtrl = sentViewerMessages.filter((message) => message.type === "reverse_synctex_forward_probe").length;
		await clickRenderedPagePoint(page, 180, 100, { ctrl: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(sentViewerMessages.some((message) => message.type === "reverse_synctex"), "Ctrl+Click should still send a normal reverse event");
		assert.equal(sentViewerMessages.filter((message) => message.type === "reverse_synctex_forward_probe").length, probeCountBeforeCtrl, "Ctrl+Click must not send a debug probe");

		const probeCountBeforeDrag = sentViewerMessages.filter((message) => message.type === "reverse_synctex_forward_probe").length;
		const selected = await dragSelectRenderedPageText(page, "paragraph text");
		assert.equal(selected, "paragraph text");
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(sentViewerMessages.filter((message) => message.type === "reverse_synctex_forward_probe").length, probeCountBeforeDrag, "selection drag should not send a debug probe");
		await page.evaluate(() => window.getSelection()?.removeAllRanges());

		const activeHoverRequest = sentViewerMessages.filter((message) => message.type === "reverse_synctex_hover").at(-1) ?? hoverRequest;
		await control.send({ type: "reverse_synctex_hover_result", pdf_id: 239, request_id: Number(activeHoverRequest.request_id), page: 1, x: Number(activeHoverRequest.x), y: Number(activeHoverRequest.y), error: "hover lookup failed" });
		await page.waitForFunction(() => document.querySelectorAll("[data-reverse-synctex-hover]").length === 0, undefined, { timeout: 2_000 });

		await moveRenderedPagePoint(page, 185, 105);
		await control.send({ type: "reverse_synctex_hover_result", pdf_id: 239, request_id: Number(hoverRequest.request_id), page: 1, x: Number(hoverRequest.x), y: Number(hoverRequest.y), source_file: sourcePath, line: 3, column: 0, source_line: "STALE HOVER LABEL", rect: { left: 20, top: 30, right: 80, bottom: 50 } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(await page.locator("[data-reverse-synctex-hover='label']", { hasText: "STALE HOVER LABEL" }).count(), 0, "stale hover result after pointer move should be ignored");

		const latestHoverRequest = sentViewerMessages.filter((message) => message.type === "reverse_synctex_hover").at(-1) ?? hoverRequest;
		await page.evaluate(() => {
			const pageElement = document.querySelector("#pages div[data-page-number='1']") as HTMLElement | null;
			if (!pageElement) throw new Error("missing rendered page");
			pageElement.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
		});
		await control.send({ type: "reverse_synctex_hover_result", pdf_id: 239, request_id: Number(latestHoverRequest.request_id), page: 1, x: Number(latestHoverRequest.x), y: Number(latestHoverRequest.y), source_file: sourcePath, line: 3, column: 0, source_line: "LEFT PAGE HOVER LABEL", rect: { left: 20, top: 30, right: 80, bottom: 50 } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(await page.locator("[data-reverse-synctex-hover='label']", { hasText: "LEFT PAGE HOVER LABEL" }).count(), 0, "stale hover result after mouseleave should be ignored");
		assert.equal(await page.locator("[data-reverse-synctex-hover]").count(), 0, "mouseleave should remove hover overlay");

		const response = await callTool(2, "get_pdf_events", { pdf_id: 239, max_events: 20, stale: true, debug: true }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
		const events = response.result?.details?.events ?? [];
		assert.equal(events.some((event) => event.type === "reverse_synctex_hover" || event.type === "reverse_synctex_forward_probe"), false, "hover/probe requests/results should not be stored as PDF events");

		await toggle.click();
		assert.equal(await toggle.getAttribute("aria-pressed"), "false");
		await control.send({ type: "reverse_synctex_hover_result", pdf_id: 239, request_id: Number(latestHoverRequest.request_id), page: 1, x: Number(latestHoverRequest.x), y: Number(latestHoverRequest.y), source_file: sourcePath, line: 3, column: 0, source_line: "TOGGLE OFF HOVER LABEL", rect: { left: 20, top: 30, right: 80, bottom: 50 } });
		await page.waitForFunction(() => document.querySelectorAll("[data-reverse-synctex-hover]").length === 0, undefined, { timeout: 2_000 });
		await page.waitForFunction(() => document.querySelectorAll("[data-reverse-synctex-forward-probe]").length === 0, undefined, { timeout: 2_000 });
		assert.equal(await page.locator("[data-reverse-synctex-hover='label']", { hasText: "TOGGLE OFF HOVER LABEL" }).count(), 0, "stale hover result after toggle off should be ignored");
		assert.equal(await page.locator("[data-reverse-synctex-forward-probe]").count(), 0, "toggle off should clear probe overlay");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host-served Viewer Client hover falls back to PDF directory when workspace_context is omitted", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-hover-dir-fallback-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 249 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath }, service);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer/249`, { waitUntil: "domcontentloaded" });
		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		for (let attempt = 0; attempt < 20 && server.getConnectedViewerCount(249) !== 1; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(server.getConnectedViewerCount(249), 1);

		await page.locator("#synctex-hover-toggle").click();
		await moveRenderedPagePoint(page, 180, 100);
		await page.waitForSelector("[data-reverse-synctex-hover='rect']", { state: "attached", timeout: 2_000 });
		await page.waitForSelector("[data-reverse-synctex-hover='label']", { state: "attached", timeout: 2_000 });
		const labelText = await page.locator("[data-reverse-synctex-hover='label']").textContent() ?? "";
		assert.match(labelText, /main\.tex:\d+/, "hover should map using the PDF directory fallback");
		assert.match(labelText, /raw: line 3/, "fallback hover should retain raw diagnostics when robust ranking chooses another line");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host-served Viewer Client maps reverse SyncTeX clicks with page-local text-layer context", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-context-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	let service: ViewerHostMcpService | undefined;
	const server = new ViewerHostServer({
		registry,
		mcpEventSink: (message) => service?.handleHostMessage(message),
	});
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		await server.start();
		service = new ViewerHostMcpService({ client: new HttpViewerHostClient(server.origin), makePdfId: () => 219 });
		await callTool(1, "open_pdf", { pdf_file_path: pdfPath, workspace_context: { cwd: baseDir } }, service);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer/219`, { waitUntil: "domcontentloaded" });
		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		await assert.doesNotReject(async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (server.getConnectedViewerCount(219) === 1) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(server.getConnectedViewerCount(219), 1);
		});

		await page.evaluate(() => {
			const outside = document.createElement("div");
			outside.textContent = "First paragraph stale outside-page selection";
			document.body.appendChild(outside);
			const textNode = outside.firstChild;
			if (!textNode) throw new Error("missing stale selection text node");
			const selection = window.getSelection();
			if (!selection) throw new Error("missing window selection");
			const range = document.createRange();
			range.setStart(textNode, "First paragraph".length);
			range.setEnd(textNode, "First paragraph".length);
			selection.removeAllRanges();
			selection.addRange(range);
		});
		await page.evaluate(() => {
			const pageElement = document.querySelector("#pages div[data-page-number='1']") as HTMLElement | null;
			const canvas = document.querySelector("#pages canvas[data-page-number='1']") as HTMLCanvasElement | null;
			if (!pageElement || !canvas) throw new Error("missing rendered page for stale-selection click");
			const rect = canvas.getBoundingClientRect();
			pageElement.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, clientX: rect.left + 180, clientY: rect.top + 194 }));
		});

		let staleEvent: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(2, "get_pdf_events", { pdf_id: 219, max_events: 5 }, service) as { result?: { details?: { events?: Array<Record<string, unknown>> } } };
			staleEvent = response.result?.details?.events?.[0];
			if (staleEvent) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(staleEvent, `reverse SyncTeX stale-selection event was not stored\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		assert.equal(staleEvent.column, 0, "selection outside the clicked page must not correct the mapped column");
		assert.equal(((staleEvent.synctex_diagnostics as { context?: { hasSelectionContext?: boolean } } | undefined)?.context?.hasSelectionContext), false);

		await selectRenderedPageTextLayerCaret(page, "First paragraph");
		await clickRenderedPagePoint(page, 180, 194, { ctrl: true });

		let event: Record<string, unknown> | undefined;
		let toolText = "";
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(3, "get_pdf_events", { pdf_id: 219, max_events: 5 }, service) as { result?: { content?: Array<{ text?: string }>; details?: { events?: Array<Record<string, unknown>> } } };
			const events = response.result?.details?.events ?? [];
			event = events[events.length - 1];
			toolText = response.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
			if (event?.column === 15) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(event, `reverse SyncTeX event was not stored after context click\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		assert.equal(event.pdf_id, 219);
		assert.equal(event.source_file, sourcePath);
		assert.equal(event.line, 3);
		assert.equal(event.page, 1);
		assert.equal(event.column, 15);
		assert.equal(event.source_line, "First paragraph text that should wrap a little and create boxes.");
		assert.equal(((event.synctex_diagnostics as { context?: { hasSelectionContext?: boolean } } | undefined)?.context?.hasSelectionContext), true);
		assert.match(toolText, /context=selection=true/);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host-served Viewer Client renders a registered PDF canvas as normal web code", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-browser-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeOnePagePdf());
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		registry.registerPdf({ pdfId: 109, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		const viewerUrl = `${server.origin}/viewer/109`;

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
		const browserGlobals = await page.evaluate(() => ({
			hasTauri: "__TAURI__" in window,
			hasCommonJsRequire: "require" in window,
			hasProcess: "process" in window,
		}));
		assert.deepEqual(browserGlobals, { hasTauri: false, hasCommonJsRequire: false, hasProcess: false });

		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		assert.equal(failedRequests.some((request) => request.includes("file://") || /src\/modules|mcp/i.test(request)), false, summarizeFailures(consoleMessages, pageErrors, failedRequests));
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

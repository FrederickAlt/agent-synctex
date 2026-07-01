import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	const content = "BT\n/F1 18 Tf\n36 150 Td\n(First paragraph text that should wrap a little and create boxes.) Tj\nET\n";
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

async function clickRenderedPagePoint(page: Page, x: number, y: number): Promise<void> {
	const box = await page.locator("#pages canvas[data-page-number='1']").boundingBox();
	if (!box) throw new Error("missing rendered canvas box");
	await page.mouse.click(box.x + x, box.y + y);
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
		}));
		assert.equal(scalarRect.kind, "rect");
		assertApproximatelyEqual(scalarRect.left, 125, 1, "scalar rectangle marker left viewport coordinate");
		assertApproximatelyEqual(scalarRect.top, 50, 1, "scalar rectangle marker top-origin viewport coordinate");
		assertApproximatelyEqual(scalarRect.width, 12.5, 0.5, "scalar rectangle marker width");
		assertApproximatelyEqual(scalarRect.height, 10, 0.5, "scalar rectangle marker height");
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
			pageElement.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + 180, clientY: rect.top + 194 }));
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
		await clickRenderedPagePoint(page, 180, 194);

		let event: Record<string, unknown> | undefined;
		let toolText = "";
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const response = await callTool(3, "get_pdf_events", { pdf_id: 219, max_events: 5 }, service) as { result?: { content?: Array<{ text?: string }>; details?: { events?: Array<Record<string, unknown>> } } };
			const events = response.result?.details?.events ?? [];
			event = events[events.length - 1];
			toolText = response.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
			if (events.length >= 2 && event?.column === 15) break;
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

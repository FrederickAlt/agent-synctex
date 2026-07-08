import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function makeTwoPagePdfWithToken(token: string): Buffer {
	const chunks: string[] = ["%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n"];
	const offsets: number[] = [0];
	let length = Buffer.byteLength(chunks[0], "binary");
	function addObject(id: number, body: string): void {
		offsets[id] = length;
		const object = `${id} 0 obj\n${body}\nendobj\n`;
		chunks.push(object);
		length += Buffer.byteLength(object, "binary");
	}
	const firstContent = `BT\n/F1 18 Tf\n36 150 Td\n(Page one ${token} refresh state.) Tj\nET\n`;
	const secondContent = `BT\n/F1 18 Tf\n36 150 Td\n(Page two ${token} refresh state.) Tj\nET\n`;
	addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
	addObject(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
	addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>");
	addObject(4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>");
	addObject(5, `<< /Length ${Buffer.byteLength(firstContent, "binary")} >>\nstream\n${firstContent}endstream`);
	addObject(6, `<< /Length ${Buffer.byteLength(secondContent, "binary")} >>\nstream\n${secondContent}endstream`);
	addObject(7, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const xrefOffset = length;
	const xref = [
		"xref",
		"0 8",
		"0000000000 65535 f ",
		...Array.from({ length: 7 }, (_, index) => `${String(offsets[index + 1]).padStart(10, "0")} 00000 n `),
		"trailer",
		"<< /Size 8 /Root 1 0 R >>",
		"startxref",
		String(xrefOffset),
		"%%EOF",
		"",
	].join("\n");
	chunks.push(xref);
	return Buffer.from(chunks.join(""), "binary");
}

function makeTwoPagePdf(): Buffer {
	return makeTwoPagePdfWithToken("original");
}

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

function compileLatexFixture(baseDir: string, fileName: string): void {
	const compile = spawnSync("latexmk", ["-norc", "-pdf", "-view=none", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", fileName], {
		cwd: baseDir,
		encoding: "utf8",
	});
	assert.equal(compile.status, 0, `latexmk fixture failed for ${fileName}\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`);
}

function writeBrowserLinkFixture(baseDir: string): { pdfPath: string } {
	const texPath = join(baseDir, "links.tex");
	const pdfPath = join(baseDir, "links.pdf");
	writeFileSync(texPath, String.raw`\documentclass{article}
\usepackage[pdfborder={0 0 0}]{hyperref}
\begin{document}
\section*{Page A}
\Large Click \hyperlink{target-b}{internal reference to B}.\\[2em]
\href{https://example.com/}{External URL that must not become viewer history.}
\newpage
\hypertarget{target-b}{}\section*{Page B}
Destination page B.
\end{document}
`);
	compileLatexFixture(baseDir, "links.tex");
	assert.equal(existsSync(pdfPath), true, "compiled hyperref PDF fixture should exist");
	return { pdfPath };
}

function writeBrowserOutlineFixture(baseDir: string): { pdfPath: string } {
	const texPath = join(baseDir, "outline.tex");
	const pdfPath = join(baseDir, "outline.pdf");
	writeFileSync(texPath, String.raw`\documentclass{article}
\usepackage[pdfborder={0 0 0}]{hyperref}
\begin{document}
\section{Start A}
This is the first outline destination.
\newpage
\section{Destination B}
This is the second outline destination.
\newpage
\subsection{Nested C}
This nested bookmark verifies outline children do not require the stock PDF.js sidebar.
\end{document}
`);
	compileLatexFixture(baseDir, "outline.tex");
	assert.equal(existsSync(pdfPath), true, "compiled outline PDF fixture should exist");
	return { pdfPath };
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

function disconnectViewerSocketsForTest(server: ViewerHostServer, pdfId: number): number {
	const internals = server as unknown as {
		viewerSocketClientsByPdfId: Map<number, Set<unknown>>;
		closeViewerSocket(connection: unknown): void;
	};
	const connections = Array.from(internals.viewerSocketClientsByPdfId.get(pdfId) ?? []);
	for (const connection of connections) internals.closeViewerSocket(connection);
	return connections.length;
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

test("LaTeX Workshop viewer Tools button is clickable across its hitbox", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-tools-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 260, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 420, height: 220 } });
		await page.goto(`${server.origin}/viewer-lw/260`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
			const loaded = (window as unknown as { __hostLwLoadedState?: () => { renderedCanvasCount?: number } }).__hostLwLoadedState?.();
			return (loaded?.renderedCanvasCount ?? 0) > 0;
		}, undefined, { timeout: 10_000 });
		await page.evaluate(() => {
			const app = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { currentScaleValue: string } } }).PDFViewerApplication;
			if (app?.pdfViewer) app.pdfViewer.currentScaleValue = "2";
		});
		await page.waitForFunction(() => {
			const container = document.getElementById("viewerContainer");
			return !!container && container.scrollHeight > container.clientHeight;
		});

		const layout = await page.evaluate(() => {
			const html = document.documentElement;
			const body = document.body;
			const outer = document.getElementById("outerContainer");
			const main = document.getElementById("mainContainer");
			const viewer = document.getElementById("viewerContainer");
			const toolbarRight = document.getElementById("toolbarViewerRight");
			return {
				bodyOverflow: getComputedStyle(body).overflow,
				documentOverflow: getComputedStyle(html).overflow,
				outerOverflow: outer ? getComputedStyle(outer).overflow : "missing",
				mainOverflow: main ? getComputedStyle(main).overflow : "missing",
				viewerOverflowY: viewer ? getComputedStyle(viewer).overflowY : "missing",
				windowScrollable: html.scrollHeight > html.clientHeight || html.scrollWidth > html.clientWidth || body.scrollHeight > body.clientHeight || body.scrollWidth > body.clientWidth,
				viewerOwnsVerticalScroll: (viewer?.scrollHeight ?? 0) > (viewer?.clientHeight ?? 0),
				viewerTop: viewer?.getBoundingClientRect().top,
				toolbarBottom: document.querySelector(".toolbar")?.getBoundingClientRect().bottom,
				toolbarRightGap: toolbarRight ? innerWidth - toolbarRight.getBoundingClientRect().right : 0,
				viewerScrollbarGutter: viewer ? viewer.offsetWidth - viewer.clientWidth : 0,
			};
		});
		assert.equal(layout.bodyOverflow, "hidden");
		assert.equal(layout.documentOverflow, "hidden");
		assert.equal(layout.outerOverflow, "hidden");
		assert.equal(layout.mainOverflow, "hidden");
		assert.equal(layout.viewerOverflowY, "auto");
		assert.equal(layout.windowScrollable, false, "the page/window must not expose scrollbars over the toolbar");
		assert.equal(layout.viewerOwnsVerticalScroll, true, "PDF.js viewerContainer should own scrolling");
		assert.ok(Number(layout.viewerTop) >= Number(layout.toolbarBottom) - 1, "viewerContainer should start below the toolbar");
		assert.ok(layout.toolbarRightGap <= 8, `right toolbar group should remain flush with the stock toolbar edge: ${JSON.stringify(layout)}`);

		const diagnostics = await page.evaluate(() => (window as unknown as { __hostLwToolsHitTargetDebug?: () => { scrollbarGutter?: { overlapsToolsRect?: boolean; toolsGapToViewport?: number }; points: Array<{ name: string; expectedHit?: boolean; closestToolsButton?: string; closestToolsContainer?: string; interceptingElement?: unknown }> } }).__hostLwToolsHitTargetDebug?.());
		assert.ok(diagnostics, "Tools hit-target diagnostics should be exposed to browser debug hooks");
		assert.equal(diagnostics.scrollbarGutter?.overlapsToolsRect, false, `viewer scrollbar gutter should not overlap Tools vertically: ${JSON.stringify(diagnostics.scrollbarGutter)}`);
		assert.ok((diagnostics.scrollbarGutter?.toolsGapToViewport ?? 999) <= 8, `Tools should remain right-aligned, not shifted left for a reserved gutter: ${JSON.stringify(diagnostics.scrollbarGutter)}`);
		for (const hit of diagnostics.points) {
			assert.equal(hit.expectedHit, true, `Tools hit target at ${hit.name} should not be intercepted by scrollbar/body/viewer: ${JSON.stringify(hit)}`);
			assert.equal(hit.interceptingElement, undefined, `Tools hit target at ${hit.name} should not report an intercepting element: ${JSON.stringify(hit)}`);
		}
		await page.waitForFunction(() => (window as unknown as { __hostLwLoadedState?: () => { socketStatus?: string } }).__hostLwLoadedState?.().socketStatus === "connected");
		const drained = await (await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" })).json() as { events: Array<{ type: string; phase?: string; details?: { points?: unknown[]; elements?: unknown; scrollbarGutter?: unknown; appShell?: unknown } }> };
		const hitTargetEvent = drained.events.find((event) => event.type === "selection_debug" && event.phase === "lw_tools_hit_target");
		assert.ok(hitTargetEvent, `Tools hit-target diagnostics should be retrievable through MCP events: ${JSON.stringify(drained.events.map((event) => event.phase))}`);
		assert.ok(Array.isArray(hitTargetEvent.details?.points) && hitTargetEvent.details.points.length >= 3, "event diagnostics should include left/center/right elementFromPoint results");
		assert.ok(hitTargetEvent.details?.elements, "event diagnostics should include relevant element rect/style details");
		assert.ok(hitTargetEvent.details?.scrollbarGutter, "event diagnostics should include scrollbar/gutter details");
		assert.ok(hitTargetEvent.details?.appShell, "event diagnostics should include parent app-shell details");

		const clickAndAssertOpen = async (xFraction: number) => {
			await page.locator("#secondaryToolbarToggleButton").evaluate((button) => {
				if ((button as HTMLButtonElement).getAttribute("aria-expanded") === "true") (button as HTMLButtonElement).click();
			});
			await page.waitForFunction(() => document.getElementById("secondaryToolbar")?.classList.contains("hidden") === true);
			const box = await page.locator("#secondaryToolbarToggleButton").boundingBox();
			assert.ok(box, "Tools button should have a hitbox");
			await page.mouse.click(box.x + box.width * xFraction, box.y + box.height / 2);
			await page.waitForFunction(() => document.getElementById("secondaryToolbarToggleButton")?.getAttribute("aria-expanded") === "true" && document.getElementById("secondaryToolbar")?.classList.contains("hidden") === false);
		};
		await clickAndAssertOpen(0.15);
		await clickAndAssertOpen(0.5);
		await clickAndAssertOpen(0.85);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop viewer keeps local history for normal scroll navigation", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-normal-history-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 262, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 360, height: 180 } });
		await page.goto(`${server.origin}/viewer-lw/262`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
			const loaded = (window as unknown as { __hostLwLoadedState?: () => { renderedCanvasCount?: number } }).__hostLwLoadedState?.();
			return (loaded?.renderedCanvasCount ?? 0) > 0;
		}, undefined, { timeout: 10_000 });
		await page.evaluate(() => {
			const app = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { currentScaleValue: string } } }).PDFViewerApplication;
			if (app?.pdfViewer) app.pdfViewer.currentScaleValue = "2";
		});
		await page.waitForFunction(() => {
			const container = document.getElementById("viewerContainer");
			return !!container && container.scrollHeight - container.clientHeight > 100;
		});
		const state = async () => page.evaluate(() => {
			const debug = (window as unknown as { __hostLwNavigationHistoryDebug: { state(): { back: unknown[]; forward: unknown[] }; capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug;
			return { ...debug.state(), current: debug.capture(), backDisabled: (document.getElementById("historyBack") as HTMLButtonElement).disabled, forwardDisabled: (document.getElementById("historyForward") as HTMLButtonElement).disabled };
		});
		await page.evaluate(() => {
			const container = document.getElementById("viewerContainer");
			if (!container) throw new Error("missing viewerContainer");
			container.focus({ preventScroll: true });
			container.scrollTop = 90;
		});
		await page.waitForFunction(() => {
			const debug = (window as unknown as { __hostLwNavigationHistoryDebug: { state(): { back: unknown[] }; capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug;
			return debug.state().back.length === 1 && debug.capture().scrollTop > 50 && !(document.getElementById("historyBack") as HTMLButtonElement).disabled;
		});
		const scrolled = await state();
		assert.equal(scrolled.forwardDisabled, true);
		await page.locator("#historyBack").click();
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop < 2);
		assert.equal((await state()).forwardDisabled, false);
		await page.locator("#viewerContainer").focus();
		await page.keyboard.press("Control+I");
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop > 50);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop viewer keeps toolbar-integrated navigation history", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-history-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 261, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 360, height: 180 } });
		await page.goto(`${server.origin}/viewer-lw/261`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
			const loaded = (window as unknown as { __hostLwLoadedState?: () => { renderedCanvasCount?: number } }).__hostLwLoadedState?.();
			return (loaded?.renderedCanvasCount ?? 0) > 0;
		}, undefined, { timeout: 10_000 });
		await page.waitForFunction(() => document.getElementById("historyBack") instanceof HTMLButtonElement && (document.getElementById("historyBack") as HTMLButtonElement).disabled);
		for (let attempt = 0; attempt < 20 && server.getConnectedViewerCount(261) !== 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(server.getConnectedViewerCount(261), 1);

		const control = new ViewerHostControlClient({ origin: server.origin });
		const state = async () => page.evaluate(() => {
			const debug = (window as unknown as { __hostLwNavigationHistoryDebug: { state(): { back: unknown[]; forward: unknown[] }; capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug;
			return { ...debug.state(), current: debug.capture(), backDisabled: (document.getElementById("historyBack") as HTMLButtonElement).disabled, forwardDisabled: (document.getElementById("historyForward") as HTMLButtonElement).disabled };
		});
		const sendJump = async (y: number, line: number) => {
			assert.deepEqual(await control.send({ type: "synctex_forward", pdf_id: 261, page: 1, x: 100, y, indicator: true, source_file: sourcePath, line }), { ok: true, result: { type: "synctex_forward", pdf_id: 261 } });
		};
		await page.evaluate(() => {
			const app = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { currentScaleValue: string } } }).PDFViewerApplication;
			if (app?.pdfViewer) app.pdfViewer.currentScaleValue = "2";
		});
		await page.waitForFunction(() => {
			const container = document.getElementById("viewerContainer");
			return !!container && container.scrollHeight - container.clientHeight > 100;
		});

		await sendJump(250, 3);
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { state(): { back: unknown[] }; capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.state().back.length === 1 && (window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop > 20);
		const firstJumpScroll = (await state()).current.scrollTop;
		await sendJump(40, 4);
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { state(): { back: unknown[] } } }).__hostLwNavigationHistoryDebug.state().back.length === 2);
		let history = await state();
		assert.equal(history.backDisabled, false);
		assert.equal(history.forwardDisabled, true);

		await page.locator("#historyBack").click();
		await page.waitForFunction((target) => Math.abs((window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop - Number(target)) < 2, firstJumpScroll);
		history = await state();
		assert.equal(history.forward.length, 1, "toolbar Back should populate forward stack");
		assert.equal(history.forwardDisabled, false);

		await page.locator("#viewerContainer").focus();
		await page.keyboard.press("Control+O");
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop < 2);
		await page.locator("#viewerContainer").focus();
		await page.keyboard.press("Control+I");
		await page.waitForFunction((target) => Math.abs((window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop - Number(target)) < 2, firstJumpScroll);

		await page.evaluate(() => {
			const input = document.createElement("input");
			input.id = "lw-history-key-guard";
			document.body.append(input);
			input.focus({ preventScroll: true });
		});
		const inputKeySuppressed = await page.evaluate(() => {
			const input = document.getElementById("lw-history-key-guard");
			if (!input) throw new Error("missing input guard");
			const event = new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true });
			return !input.dispatchEvent(event);
		});
		assert.equal(inputKeySuppressed, true, "Ctrl+O in editable input should be suppressed without navigating history");
		assertApproximatelyEqual((await state()).current.scrollTop, firstJumpScroll, 2, "Ctrl+O in editable input should not navigate LW history");
		await page.evaluate(() => document.getElementById("lw-history-key-guard")?.remove());
		const backDefaults = await page.evaluate(() => {
			const target = document.getElementById("viewerContainer") ?? document.body;
			return ["mousedown", "mouseup", "auxclick"].map((type) => target.dispatchEvent(new MouseEvent(type, { button: 3, bubbles: true, cancelable: true })));
		});
		assert.deepEqual(backDefaults, [false, false, false], "MSB4 sequence should suppress browser default navigation");
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop < 2);
		const forwardDefaults = await page.evaluate(() => {
			const target = document.getElementById("viewerContainer") ?? document.body;
			return ["mousedown", "mouseup", "auxclick"].map((type) => target.dispatchEvent(new MouseEvent(type, { button: 4, bubbles: true, cancelable: true })));
		});
		assert.deepEqual(forwardDefaults, [false, false, false], "MSB5 sequence should suppress browser default navigation");
		await page.waitForFunction((target) => Math.abs((window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop - Number(target)) < 2, firstJumpScroll);
		const middleDefaults = await page.evaluate(() => {
			const target = document.getElementById("viewerContainer") ?? document.body;
			return ["mousedown", "mouseup", "auxclick"].map((type) => target.dispatchEvent(new MouseEvent(type, { button: 1, buttons: 4, bubbles: true, cancelable: true })));
		});
		assert.deepEqual(middleDefaults, [true, true, true], "middle-click button/buttons must not be treated as history side buttons");
		const alternativeBackDefaults = await page.evaluate(() => {
			const target = document.getElementById("viewerContainer") ?? document.body;
			return ["mousedown", "mouseup", "auxclick"].map((type) => target.dispatchEvent(new MouseEvent(type, { button: 0, buttons: 8, bubbles: true, cancelable: true })));
		});
		assert.deepEqual(alternativeBackDefaults, [false, false, false], "alternative MSB4 buttons=8 sequence should suppress browser default navigation");
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop < 2);
		const alternativeForwardDefaults = await page.evaluate(() => {
			const target = document.getElementById("viewerContainer") ?? document.body;
			return ["mousedown", "mouseup", "auxclick"].map((type) => target.dispatchEvent(new MouseEvent(type, { button: 0, buttons: 16, bubbles: true, cancelable: true })));
		});
		assert.deepEqual(alternativeForwardDefaults, [false, false, false], "alternative MSB5 buttons=16 sequence should suppress browser default navigation");
		await page.waitForFunction((target) => Math.abs((window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop - Number(target)) < 2, firstJumpScroll);
		const webkitWhichBackDefaults = await page.evaluate(() => {
			const target = document.getElementById("viewerContainer") ?? document.body;
			return ["mousedown", "mouseup", "auxclick"].map((type) => {
				const event = new MouseEvent(type, { button: 0, buttons: 0, bubbles: true, cancelable: true });
				Object.defineProperty(event, "which", { value: 4 });
				return target.dispatchEvent(event);
			});
		});
		assert.deepEqual(webkitWhichBackDefaults, [false, false, false], "WebKit MSB4 which=4 sequence should suppress browser default navigation");
		await page.waitForFunction(() => (window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop < 2);
		const webkitWhichForwardDefaults = await page.evaluate(() => {
			const target = document.getElementById("viewerContainer") ?? document.body;
			return ["mousedown", "mouseup", "auxclick"].map((type) => {
				const event = new MouseEvent(type, { button: 0, buttons: 0, bubbles: true, cancelable: true });
				Object.defineProperty(event, "which", { value: 5 });
				return target.dispatchEvent(event);
			});
		});
		assert.deepEqual(webkitWhichForwardDefaults, [false, false, false], "WebKit MSB5 which=5 sequence should suppress browser default navigation");
		await page.waitForFunction((target) => Math.abs((window as unknown as { __hostLwNavigationHistoryDebug: { capture(): { scrollTop: number } } }).__hostLwNavigationHistoryDebug.capture().scrollTop - Number(target)) < 2, firstJumpScroll);
		const rawMouseDrain = await (await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" })).json() as { events: Array<{ type: string; phase?: string; details?: { type?: string; button?: number; buttons?: number; which?: number; target?: unknown; defaultPrevented?: boolean; handledDirection?: string } }> };
		const rawMouseEvents = rawMouseDrain.events.filter((event) => event.type === "selection_debug" && event.phase === "lw_raw_mouse_event");
		assert.ok(rawMouseEvents.some((event) => event.details?.which === 4 && event.details.handledDirection === "back"), "MCP debug events should expose raw iframe MSB4 which=4 diagnostics");
		assert.ok(rawMouseEvents.some((event) => event.details?.which === 5 && event.details.handledDirection === "forward"), "MCP debug events should expose raw iframe MSB5 which=5 diagnostics");
		assert.ok(rawMouseEvents.every((event) => typeof event.details?.type === "string" && typeof event.details.defaultPrevented === "boolean" && event.details.target), "raw iframe mouse diagnostics should include event type, target and defaultPrevented");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop app shell forwards parent-level history shortcuts to the active iframe", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-app-shortcuts-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 263, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		const control = new ViewerHostControlClient({ origin: server.origin });
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 420, height: 220 } });
		await page.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });
		assert.equal((await control.send({ type: "open_pdf", pdf_id: 263, pdf_path: pdfPath, title: "paper.pdf" })).ok, true);
		await page.waitForSelector("iframe[data-pdf-id='263']");
		const frame = page.frameLocator("iframe[data-pdf-id='263']");
		await frame.locator("#viewerContainer").waitFor({ state: "attached", timeout: 10_000 });
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const loaded = (iframe?.contentWindow as unknown as { __hostLwLoadedState?: () => { renderedCanvasCount?: number } } | undefined)?.__hostLwLoadedState?.();
			return (loaded?.renderedCanvasCount ?? 0) > 0;
		}, undefined, { timeout: 10_000 });
		await page.evaluate(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const app = (iframe?.contentWindow as unknown as { PDFViewerApplication?: { pdfViewer?: { currentScaleValue: string } } } | undefined)?.PDFViewerApplication;
			if (app?.pdfViewer) app.pdfViewer.currentScaleValue = "2";
		});
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const container = iframe?.contentDocument?.getElementById("viewerContainer");
			return !!container && container.scrollHeight - container.clientHeight > 100;
		});
		await frame.locator("#secondaryToolbarToggleButton").waitFor({ state: "attached", timeout: 10_000 });
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const tools = iframe?.contentDocument?.getElementById("secondaryToolbarToggleButton") as HTMLElement | null;
			const rect = tools?.getBoundingClientRect();
			const hit = rect ? iframe?.contentDocument?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : undefined;
			return hit === tools;
		}, undefined, { timeout: 10_000 });
		const appLayout = await page.evaluate(() => {
			const scrolling = document.scrollingElement ?? document.documentElement;
			const app = document.getElementById("viewer-client-app") as HTMLElement | null;
			const panels = document.getElementById("viewer-panels") as HTMLElement | null;
			const panel = document.querySelector("[role='tabpanel'][data-pdf-id='263']") as HTMLElement | null;
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const iframeRect = iframe?.getBoundingClientRect();
			const tools = iframe?.contentDocument?.getElementById("secondaryToolbarToggleButton") as HTMLElement | null;
			const toolsRect = tools?.getBoundingClientRect();
			const parentToolsPoint = iframeRect && toolsRect ? { x: iframeRect.left + toolsRect.left + toolsRect.width / 2, y: iframeRect.top + toolsRect.top + toolsRect.height / 2 } : undefined;
			const parentHit = parentToolsPoint ? document.elementFromPoint(parentToolsPoint.x, parentToolsPoint.y) : undefined;
			const iframeHit = toolsRect ? iframe?.contentDocument?.elementsFromPoint(toolsRect.left + toolsRect.width / 2, toolsRect.top + toolsRect.height / 2)?.[0] : undefined;
			return {
				viewport: { width: innerWidth, height: innerHeight },
				scrollHeight: scrolling.scrollHeight,
				clientHeight: scrolling.clientHeight,
				scrollWidth: scrolling.scrollWidth,
				clientWidth: scrolling.clientWidth,
				bodyOverflow: getComputedStyle(document.body).overflow,
				documentOverflow: getComputedStyle(document.documentElement).overflow,
				appOverflow: app ? getComputedStyle(app).overflow : "missing",
				panelsOverflow: panels ? getComputedStyle(panels).overflow : "missing",
				panelOverflow: panel ? getComputedStyle(panel).overflow : "missing",
				iframeDisplay: iframe ? getComputedStyle(iframe).display : "missing",
				iframeRect: iframeRect ? { left: iframeRect.left, top: iframeRect.top, right: iframeRect.right, bottom: iframeRect.bottom, width: iframeRect.width, height: iframeRect.height } : undefined,
				toolsExists: !!tools,
				toolsRect: toolsRect ? { left: toolsRect.left, top: toolsRect.top, right: toolsRect.right, bottom: toolsRect.bottom, width: toolsRect.width, height: toolsRect.height } : undefined,
				parentHitTag: parentHit instanceof Element ? parentHit.tagName : undefined,
				parentHitPdfId: parentHit instanceof HTMLElement ? parentHit.dataset.pdfId : undefined,
				iframeHitId: iframeHit instanceof Element ? iframeHit.id : undefined,
				iframeHitTag: iframeHit instanceof Element ? iframeHit.tagName : undefined,
				iframeHitClass: iframeHit instanceof Element ? String(iframeHit.className) : undefined,
			};
		});
		assert.ok(appLayout.scrollHeight <= appLayout.clientHeight, `app shell should not have an outer vertical scrollbar: ${JSON.stringify(appLayout)}`);
		assert.ok(appLayout.scrollWidth <= appLayout.clientWidth, `app shell should not have an outer horizontal scrollbar: ${JSON.stringify(appLayout)}`);
		assert.equal(appLayout.bodyOverflow, "hidden");
		assert.equal(appLayout.documentOverflow, "hidden");
		assert.equal(appLayout.appOverflow, "hidden");
		assert.equal(appLayout.panelsOverflow, "hidden");
		assert.equal(appLayout.panelOverflow, "hidden");
		assert.equal(appLayout.iframeDisplay, "block");
		assert.ok(appLayout.iframeRect, "active iframe should have a parent-frame rect");
		assert.ok((appLayout.iframeRect?.bottom ?? Infinity) <= appLayout.viewport.height, `iframe should fit inside the app viewport: ${JSON.stringify(appLayout)}`);
		assert.equal(appLayout.parentHitTag, "IFRAME", `parent hit test at Tools center should hit the active iframe, not an outer scrollbar/overlay: ${JSON.stringify(appLayout)}`);
		assert.equal(appLayout.parentHitPdfId, "263");
		const iframeToolsHit = await frame.locator("#secondaryToolbarToggleButton").evaluate((button) => {
			const rect = button.getBoundingClientRect();
			return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button;
		});
		assert.equal(iframeToolsHit, true, `iframe hit test at Tools center should hit Tools: ${JSON.stringify(appLayout)}`);
		await page.evaluate(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const container = iframe?.contentDocument?.getElementById("viewerContainer");
			if (!container) throw new Error("missing viewerContainer");
			container.scrollTop = 90;
		});
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { state(): { back: unknown[] }; capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.state().back.length ?? 0) === 1 && (debug?.capture().scrollTop ?? 0) > 50;
		});
		const dispatchParentKey = async (key: "o" | "i") => page.evaluate((eventKey) => {
			const event = new KeyboardEvent("keydown", { key: eventKey, ctrlKey: true, bubbles: true, cancelable: true });
			return !document.dispatchEvent(event);
		}, key);
		const dispatchParentSideButton = async (init: { button: number; buttons?: number; which?: number }) => page.evaluate((mouseInit) => ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick"].map((type) => {
			const event = type.startsWith("pointer") && typeof PointerEvent !== "undefined"
				? new PointerEvent(type, { button: mouseInit.button, buttons: mouseInit.buttons, bubbles: true, cancelable: true, pointerType: "mouse" })
				: new MouseEvent(type, { button: mouseInit.button, buttons: mouseInit.buttons, bubbles: true, cancelable: true });
			if (mouseInit.which !== undefined) Object.defineProperty(event, "which", { value: mouseInit.which });
			return !document.dispatchEvent(event);
		}), init);
		assert.equal(await dispatchParentKey("o"), true, "parent Ctrl+O should suppress browser file-open default");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 999) < 2;
		});
		assert.equal(await dispatchParentKey("i"), true, "parent Ctrl+I should suppress browser default");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 0) > 50;
		});
		assert.deepEqual(await dispatchParentSideButton({ button: 3 }), [true, true, true, true, true], "parent MSB4 sequence should suppress browser navigation");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 999) < 2;
		});
		assert.deepEqual(await dispatchParentSideButton({ button: 4 }), [true, true, true, true, true], "parent MSB5 sequence should suppress browser navigation");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 0) > 50;
		});
		assert.deepEqual(await dispatchParentSideButton({ button: 0, buttons: 8 }), [true, true, true, true, true], "parent alternative MSB4 buttons=8 sequence should suppress browser navigation");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 999) < 2;
		});
		assert.deepEqual(await dispatchParentSideButton({ button: 0, buttons: 16 }), [true, true, true, true, true], "parent alternative MSB5 buttons=16 sequence should suppress browser navigation");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 0) > 50;
		});
		assert.deepEqual(await dispatchParentSideButton({ button: 0, buttons: 0, which: 4 }), [true, true, true, true, true], "parent WebKit MSB4 which=4 sequence should suppress browser navigation");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 999) < 2;
		});
		assert.deepEqual(await dispatchParentSideButton({ button: 0, buttons: 0, which: 5 }), [true, true, true, true, true], "parent WebKit MSB5 which=5 sequence should suppress browser navigation");
		await page.waitForFunction(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='263']") as HTMLIFrameElement | null;
			const debug = (iframe?.contentWindow as unknown as { __hostLwNavigationHistoryDebug?: { capture(): { scrollTop: number } } } | undefined)?.__hostLwNavigationHistoryDebug;
			return (debug?.capture().scrollTop ?? 0) > 50;
		});
		const parentRawMouseDrain = await (await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" })).json() as { events: Array<{ type: string; phase?: string; text?: string; details?: { type?: string; button?: number; buttons?: number; which?: number; target?: unknown; defaultPrevented?: boolean; handledDirection?: string } }> };
		const appShellRawMouseEvents = parentRawMouseDrain.events.filter((event) => event.type === "selection_debug" && event.phase === "lw_app_shell_raw_mouse_event");
		assert.ok(appShellRawMouseEvents.some((event) => event.details?.which === 4 && event.details.handledDirection === "back"), "MCP debug events should expose raw app-shell MSB4 which=4 diagnostics");
		assert.ok(appShellRawMouseEvents.some((event) => event.details?.which === 5 && event.details.handledDirection === "forward"), "MCP debug events should expose raw app-shell MSB5 which=5 diagnostics");
		assert.ok(appShellRawMouseEvents.every((event) => typeof event.details?.type === "string" && typeof event.details.defaultPrevented === "boolean" && event.details.target), "raw app-shell mouse diagnostics should include event type, target and defaultPrevented");
		assert.ok(appShellRawMouseEvents.some((event) => /type=.*button=.*buttons=.*which=.*handled=back/.test(event.text ?? "")), "raw app-shell mouse diagnostics should expose a concise MCP-visible text summary");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("side-by-side LaTeX Workshop viewer route renders PDF with stock toolbar UI", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-browser-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeOnePagePdf());
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		registry.registerPdf({ pdfId: 141, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer-lw/141`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#viewer .page[data-loaded='true'] canvas", { state: "attached", timeout: 15_000 });

		for (const selector of ["#toolbarViewer", "#viewsManagerToggleButton", "#viewFindButton", "#pageNumber", "#scaleSelect", "#zoomInButton", "#zoomOutButton"]) {
			assert.equal(await page.locator(selector).count(), 1, `${selector} should exist\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
			await assert.doesNotReject(() => page.locator(selector).waitFor({ state: "visible", timeout: 2_000 }), `${selector} should be visible\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		}
		const toolbarChrome = await page.evaluate(() => {
			const toolbar = document.querySelector(".toolbar") as HTMLElement | null;
			const viewerContainer = document.getElementById("viewerContainer") as HTMLElement | null;
			return {
				toolbarTop: toolbar ? getComputedStyle(toolbar).top : undefined,
				toolbarHiddenClass: toolbar?.classList.contains("hide") ?? false,
				viewerContainerTop: viewerContainer ? getComputedStyle(viewerContainer).top : undefined,
			};
		});
		assert.equal(toolbarChrome.toolbarHiddenClass, false);
		assertApproximatelyEqual(Number.parseFloat(toolbarChrome.toolbarTop ?? "NaN"), 0, 0.5, "LW toolbar should stay pinned to top");
		assertApproximatelyEqual(Number.parseFloat(toolbarChrome.viewerContainerTop ?? "NaN"), 32, 0.5, "LW viewer container should stay below toolbar");

		await page.locator("#viewFindButton").click();
		await page.locator("#findInput").waitFor({ state: "visible", timeout: 2_000 });
		await page.locator("#viewsManagerToggleButton").click();
		await page.locator("#viewsManager").waitFor({ state: "visible", timeout: 2_000 });
		assert.equal(await page.locator("#thumbnailsView").count(), 1, "sidebar thumbnails view should exist");
		assert.equal(await page.locator("#status").count(), 0, "custom Host status UI must not be present");
		assert.equal(await page.locator("#synctex-hover-toggle").count(), 0, "custom Host SyncTeX toolbar must not be present");
		assert.equal(await page.getByText("Open registered PDF bytes directly").count(), 0, "custom Host fallback link must not be present");
		await page.waitForTimeout(250);
		const failedViewerAssetRequests = failedRequests.filter((request) => request.includes("/viewer-lw/") || /^[45]\d\d /.test(request));
		assert.deepEqual(failedViewerAssetRequests, [], summarizeFailures(consoleMessages, pageErrors, failedRequests));
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Client app iframe loads LaTeX Workshop PDF pages and emits loaded-state diagnostics", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-app-iframe-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeOnePagePdf());
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 144, pdf_path: pdfPath, title: "App iframe PDF" })).ok, true);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => document.querySelector("iframe[data-pdf-id='144']")?.getAttribute("src") === "/viewer-lw/144?revision=1", undefined, { timeout: 5_000 });
		const frame = await page.waitForEvent("framenavigated", { predicate: (candidate) => candidate.url().includes("/viewer-lw/144"), timeout: 10_000 }).catch(() => page.frames().find((candidate) => candidate.url().includes("/viewer-lw/144")));
		assert.ok(frame, `LW iframe should navigate\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		await frame.waitForFunction(() => {
			const diagnostic = (window as unknown as { __hostLwLoadedState?: () => { pdfDocumentLoaded?: boolean; numPages?: number; pagesCount?: number; renderedPageCount?: number; canvasCount?: number; currentPageInput?: string; currentPageLabel?: string } }).__hostLwLoadedState?.();
			return diagnostic?.pdfDocumentLoaded === true
				&& diagnostic.numPages === 1
				&& diagnostic.pagesCount === 1
				&& (diagnostic.renderedPageCount ?? 0) >= 1
				&& (diagnostic.canvasCount ?? 0) >= 1
				&& diagnostic.currentPageInput !== "0"
				&& diagnostic.currentPageLabel !== "0";
		}, undefined, { timeout: 15_000 });

		let diagnosticEvent: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 20 && diagnosticEvent === undefined; attempt += 1) {
			const response = await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" });
			assert.equal(response.status, 200);
			const body = await response.json() as { events?: Array<Record<string, unknown>> };
			diagnosticEvent = body.events?.find((event) => event.type === "selection_debug" && event.pdf_id === 144 && event.phase === "lw_loaded_state" && (event.details as Record<string, unknown> | undefined)?.pdfDocumentLoaded === true);
			if (diagnosticEvent === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(diagnosticEvent, `loaded-state diagnostic should be exposed through Host event drain\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		const details = diagnosticEvent.details as Record<string, unknown>;
		assert.equal(details.numPages, 1);
		assert.equal(details.pagesCount, 1);
		assert.equal(details.renderedPageCount, 1);
		assert.equal(details.canvasCount, 1);
		assert.deepEqual(failedRequests.filter((request) => request.includes("/viewer-lw/") || /^[45]\d\d /.test(request)), [], summarizeFailures(consoleMessages, pageErrors, failedRequests));
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("LaTeX Workshop viewer route renders inside older WebKit-like runtimes without modern Promise helpers", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-webkit-compat-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeOnePagePdf());
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		registry.registerPdf({ pdfId: 143, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.addInitScript(() => {
			// Some WebKitGTK environments can lag Chromium's newer Promise APIs.
			Reflect.deleteProperty(Promise, "withResolvers");
			Reflect.deleteProperty(Promise, "try");
		});
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer-lw/143`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#viewer .page[data-loaded='true'] canvas", { state: "attached", timeout: 15_000 });
		assert.equal(await page.evaluate(() => typeof Promise.withResolvers), "function");
		assert.equal(await page.evaluate(() => typeof (Promise as typeof Promise & { try?: unknown }).try), "function");
		assert.equal(failedRequests.filter((request) => request.includes("/viewer-lw/") || /^[45]\d\d /.test(request)).length, 0, summarizeFailures(consoleMessages, pageErrors, failedRequests));
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop viewer refreshes from Host socket while preserving page and scale", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-refresh-state-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVONE"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const pdfRequests: string[] = [];
	try {
		registry.registerPdf({ pdfId: 142, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
		page.on("request", (request) => {
			if (request.url().includes("/pdf/142")) pdfRequests.push(request.url());
		});
		await page.goto(`${server.origin}/viewer-lw/142`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#viewer .page[data-loaded='true'] canvas", { state: "attached", timeout: 15_000 });
		await page.waitForFunction(() => {
			const application = (window as unknown as { PDFViewerApplication?: { pdfDocument?: { numPages: number }; pdfViewer?: { pagesCount: number } } }).PDFViewerApplication;
			return application?.pdfDocument?.numPages === 2 && application.pdfViewer?.pagesCount === 2;
		}, undefined, { timeout: 10_000 });

		await page.evaluate(() => {
			const app = (window as unknown as { PDFViewerApplication: { page: number; pdfViewer: { currentPageNumber: number; currentScaleValue: string; scrollPageIntoView(input: { pageNumber: number }): void } } }).PDFViewerApplication;
			app.pdfViewer.currentScaleValue = "150";
			app.pdfViewer.currentPageNumber = 2;
			app.page = 2;
			app.pdfViewer.scrollPageIntoView({ pageNumber: 2 });
		});
		await page.waitForFunction(() => (window as unknown as { PDFViewerApplication: { page: number; pdfViewer: { currentPageNumber: number } } }).PDFViewerApplication.page === 2 || (window as unknown as { PDFViewerApplication: { pdfViewer: { currentPageNumber: number } } }).PDFViewerApplication.pdfViewer.currentPageNumber === 2, undefined, { timeout: 5_000 });
		await page.evaluate(() => document.getElementById("viewerContainer")?.scrollBy(0, 40));
		writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVTWO"));
		registry.registerPdf({ pdfId: 142, pdfPath, title: "paper.pdf", revision: 2, fileSnapshot: snapshotPdf(pdfPath) });
		assert.equal(server.sendPdfRefresh(142), 1);

		await page.waitForFunction(() => document.body.dataset.hostLwVisibleRevision === "2", undefined, { timeout: 10_000 });
		assert.deepEqual(pdfRequests.filter((url) => url.includes("revision=2")), [`${server.origin}/pdf/142?revision=2`]);
		const state = await page.evaluate(() => {
			const app = (window as unknown as { PDFViewerApplication: { page: number; pdfDocument?: { numPages: number }; pdfViewer: { currentScaleValue: string } } }).PDFViewerApplication;
			const container = document.getElementById("viewerContainer");
			return { page: app.page, scale: app.pdfViewer.currentScaleValue, numPages: app.pdfDocument?.numPages, scrollTop: container?.scrollTop ?? 0 };
		});
		assert.equal(state.numPages, 2);
		assert.equal(state.page, 2);
		assert.equal(state.scale, "150");
		assert.ok(state.scrollTop >= 0, "scroll position should remain readable after refresh");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("LaTeX Workshop viewer reconnects Host socket and receives later refreshes", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-reconnect-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVONE"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 145, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/145`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#viewer .page[data-loaded='true'] canvas", { state: "attached", timeout: 15_000 });
		for (let attempt = 0; attempt < 20 && server.getConnectedViewerCount(145) !== 1; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(server.getConnectedViewerCount(145), 1);

		assert.equal(disconnectViewerSocketsForTest(server, 145), 1);
		await page.waitForFunction(() => document.body.dataset.hostLwSocket === "connected", undefined, { timeout: 5_000 });
		assert.equal(server.getConnectedViewerCount(145), 1);

		writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVTWO"));
		registry.registerPdf({ pdfId: 145, pdfPath, title: "paper.pdf", revision: 2, fileSnapshot: snapshotPdf(pdfPath) });
		assert.equal(server.sendPdfRefresh(145), 1);
		await page.waitForFunction(() => document.body.dataset.hostLwVisibleRevision === "2", undefined, { timeout: 10_000 });
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

async function waitForLwPageReady(page: Page, pageNumber = 1): Promise<void> {
	await page.waitForSelector(`#viewer .page[data-page-number='${pageNumber}'][data-loaded='true'] canvas`, { state: "attached", timeout: 15_000 });
	await page.waitForFunction((targetPage) => {
		const application = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { _pages?: Array<{ viewport?: unknown }> } } }).PDFViewerApplication;
		return !!application?.pdfViewer?._pages?.[Number(targetPage) - 1]?.viewport;
	}, pageNumber, { timeout: 10_000 });
}

async function lwCanvasPoint(page: Page, pageNumber: number, x: number, y: number): Promise<{ clientX: number; clientY: number; pdfX: number; pdfY: number }> {
	return await page.evaluate(({ pageNumber: targetPage, x: localX, y: localY }) => {
		const pageElement = document.querySelector(`#viewer .page[data-page-number='${targetPage}']`) as HTMLElement | null;
		const wrapper = pageElement?.querySelector(".canvasWrapper") as HTMLElement | null;
		const application = (window as unknown as { PDFViewerApplication: { pdfViewer: { _pages: Array<{ viewport: { convertToPdfPoint(x: number, y: number): [number, number] } }> } } }).PDFViewerApplication;
		if (!pageElement || !wrapper) throw new Error("missing LW page canvas wrapper");
		const rect = wrapper.getBoundingClientRect();
		const point = application.pdfViewer._pages[targetPage - 1].viewport.convertToPdfPoint(localX, rect.height - localY);
		return { clientX: rect.left + localX, clientY: rect.top + localY, pdfX: point[0], pdfY: point[1] };
	}, { pageNumber, x, y });
}

async function lwExpectedForwardGeometry(page: Page, input: { page: number; x?: number; y?: number; width?: number; height?: number; range?: { h: number; v: number; W: number; H: number } }): Promise<{ left: number; top: number; width?: number; height?: number; pageHeight: number; scaleX: number; scaleY: number; mirroredTop?: number }> {
	return await page.evaluate((payload) => {
		const application = (window as unknown as { PDFViewerApplication: { pdfViewer: { _pages: Array<{ viewport: { width: number; height: number; viewBox?: number[]; convertToViewportPoint(x: number, y: number): [number, number] } }> } } }).PDFViewerApplication;
		const viewport = application.pdfViewer._pages[payload.page - 1].viewport;
		const viewBox = Array.isArray(viewport.viewBox) ? viewport.viewBox.map(Number) : [0, 0, viewport.width, viewport.height];
		const pageLeft = Math.min(viewBox[0], viewBox[2]);
		const pageTop = Math.max(viewBox[1], viewBox[3]);
		const pageHeight = Math.abs(viewBox[3] - viewBox[1]);
		const origin = viewport.convertToViewportPoint(pageLeft, pageTop);
		const xUnit = viewport.convertToViewportPoint(pageLeft + 1, pageTop);
		const yUnit = viewport.convertToViewportPoint(pageLeft, pageTop - 1);
		const scale = { x: Math.abs(xUnit[0] - origin[0]) || 1, y: Math.abs(yUnit[1] - origin[1]) || 1 };
		const topOriginPoint = (x: number, y: number) => viewport.convertToViewportPoint(pageLeft + x, pageTop - y);
		if (payload.range) {
			const topLeft = topOriginPoint(payload.range.h, payload.range.v - payload.range.H);
			const bottomRight = topOriginPoint(payload.range.h + payload.range.W, payload.range.v);
			return { left: Math.min(topLeft[0], bottomRight[0]), top: Math.min(topLeft[1], bottomRight[1]), width: Math.abs(bottomRight[0] - topLeft[0]), height: Math.abs(bottomRight[1] - topLeft[1]), pageHeight, scaleX: scale.x, scaleY: scale.y };
		}
		const point = topOriginPoint(Number(payload.x), Number(payload.y));
		const mirrored = viewport.convertToViewportPoint(Number(payload.x), Number(payload.y));
		return { left: point[0], top: point[1], width: payload.width === undefined ? undefined : payload.width * scale.x, height: payload.height === undefined ? undefined : payload.height * scale.y, pageHeight, scaleX: scale.x, scaleY: scale.y, mirroredTop: mirrored[1] };
	}, input);
}

async function lwSelectionDragProbe(page: Page, token: string): Promise<{ startClientX: number; startClientY: number; endClientX: number; endClientY: number; selectedText: string; textBeforeSelection: string; textAfterSelection: string; selectionStartX: number; selectionStartY: number; selectionEndX: number; selectionEndY: number }> {
	return await page.evaluate((needle) => {
		const pageElement = document.querySelector("#viewer .page[data-page-number='1']") as HTMLElement | null;
		const textLayer = pageElement?.querySelector(".textLayer") as HTMLElement | null;
		const wrapper = pageElement?.querySelector(".canvasWrapper") as HTMLElement | null;
		const application = (window as unknown as { PDFViewerApplication: { pdfViewer: { _pages: Array<{ viewport: { convertToPdfPoint(x: number, y: number): [number, number] } }> } } }).PDFViewerApplication;
		if (!pageElement || !textLayer || !wrapper) throw new Error("missing LW text layer");
		const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const text = node.textContent ?? "";
			const start = text.indexOf(needle);
			if (start >= 0) {
				const startRange = document.createRange();
				startRange.setStart(node, start);
				startRange.setEnd(node, start + 1);
				const endRange = document.createRange();
				endRange.setStart(node, start + needle.length - 1);
				endRange.setEnd(node, start + needle.length);
				const fullRange = document.createRange();
				fullRange.setStart(node, start);
				fullRange.setEnd(node, start + needle.length);
				const startRect = startRange.getBoundingClientRect();
				const endRect = endRange.getBoundingClientRect();
				const fullStartRect = startRange.getBoundingClientRect();
				const fullEndRect = endRange.getBoundingClientRect();
				const wrapperRect = wrapper.getBoundingClientRect();
				const viewport = application.pdfViewer._pages[0].viewport;
				const startPoint = viewport.convertToPdfPoint(fullStartRect.left + fullStartRect.width / 2 - wrapperRect.left, wrapperRect.height - (fullStartRect.top + fullStartRect.height / 2 - wrapperRect.top));
				const endPoint = viewport.convertToPdfPoint(fullEndRect.left + fullEndRect.width / 2 - wrapperRect.left, wrapperRect.height - (fullEndRect.top + fullEndRect.height / 2 - wrapperRect.top));
				return {
					startClientX: startRect.left + 1,
					startClientY: startRect.top + startRect.height / 2,
					endClientX: endRect.right - 1,
					endClientY: endRect.top + endRect.height / 2,
					selectedText: fullRange.toString(),
					textBeforeSelection: text.substring(0, start),
					textAfterSelection: text.substring(start + needle.length),
					selectionStartX: startPoint[0],
					selectionStartY: startPoint[1],
					selectionEndX: endPoint[0],
					selectionEndY: endPoint[1],
				};
			}
			node = walker.nextNode();
		}
		throw new Error(`selection token not found: ${needle}`);
	}, token);
}

async function drainHostMcpEvents(origin: string): Promise<Array<Record<string, unknown>>> {
	const response = await fetch(`${origin}/mcp-events/drain`, { method: "POST" });
	assert.equal(response.status, 200);
	const body = await response.json() as { events?: Array<Record<string, unknown>>; result?: { details?: { events?: Array<Record<string, unknown>> } } };
	return body.events ?? body.result?.details?.events ?? [];
}

async function waitForHostMcpEvent(origin: string, predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const event = (await drainHostMcpEvents(origin)).find(predicate);
		if (event) return event;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

async function collectHostMcpEventsUntil(origin: string, predicate: (event: Record<string, unknown>) => boolean): Promise<Array<Record<string, unknown>>> {
	const events: Array<Record<string, unknown>> = [];
	for (let attempt = 0; attempt < 50; attempt += 1) {
		events.push(...await drainHostMcpEvents(origin));
		if (events.some(predicate)) return events;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return events;
}

test("LaTeX Workshop viewer renders Host forward SyncTeX marker and range overlays", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-forward-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 146, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
		await page.goto(`${server.origin}/viewer-lw/146`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);

		const control = new ViewerHostControlClient({ origin: server.origin });
		const scalar = { page: 1, x: 100, y: 53, width: 10, height: 8 };
		assert.deepEqual(await control.send({ type: "synctex_forward", pdf_id: 146, ...scalar, source_file: sourcePath, line: 3 }), { ok: true, result: { type: "synctex_forward", pdf_id: 146 } });
		await page.waitForSelector("[data-synctex-marker='rect']", { state: "attached", timeout: 2_000 });
		let marker = await page.locator("[data-synctex-marker='rect']").first().evaluate((element) => ({
			left: Number.parseFloat((element as HTMLElement).style.left),
			top: Number.parseFloat((element as HTMLElement).style.top),
			width: Number.parseFloat((element as HTMLElement).style.width),
			height: Number.parseFloat((element as HTMLElement).style.height),
		}));
		let expected = await lwExpectedForwardGeometry(page, scalar);
		assertApproximatelyEqual(marker.left, expected.left, 0.75, "scalar forward marker left follows PDF.js viewport");
		assertApproximatelyEqual(marker.top, expected.top, 0.75, "scalar forward marker top uses top-origin SyncTeX y");
		assert.ok(Math.abs(marker.top - Number(expected.mirroredTop)) > 20, "asymmetric scalar y would fail if mirrored as bottom-origin PDF y");
		assertApproximatelyEqual(marker.width, expected.width ?? 0, 0.75, "scalar forward marker width follows PDF.js viewport scale");
		assertApproximatelyEqual(marker.height, expected.height ?? 0, 0.75, "scalar forward marker height follows PDF.js viewport scale");
		assertApproximatelyEqual(marker.top, scalar.y * expected.scaleY, 0.75, "known 300x200 fixture scalar top is y * viewport scale");

		const range = { page: 1, h: 72, v: 147, W: 36, H: 19 };
		assert.deepEqual(await control.send({ type: "synctex_forward", pdf_id: 146, page: 1, x: 1, y: 1, ranges: [range], source_file: sourcePath, line: 4 }), { ok: true, result: { type: "synctex_forward", pdf_id: 146 } });
		await page.waitForSelector("[data-synctex-marker='rect']", { state: "attached", timeout: 2_000 });
		marker = await page.locator("[data-synctex-marker='rect']").first().evaluate((element) => ({
			left: Number.parseFloat((element as HTMLElement).style.left),
			top: Number.parseFloat((element as HTMLElement).style.top),
			width: Number.parseFloat((element as HTMLElement).style.width),
			height: Number.parseFloat((element as HTMLElement).style.height),
		}));
		expected = await lwExpectedForwardGeometry(page, { page: 1, range });
		assertApproximatelyEqual(marker.left, expected.left, 0.75, "range forward marker left uses h");
		assertApproximatelyEqual(marker.top, expected.top, 0.75, "range forward marker top uses v-H in top-origin SyncTeX coordinates");
		assertApproximatelyEqual(marker.width, expected.width ?? 0, 0.75, "range forward marker width uses W");
		assertApproximatelyEqual(marker.height, expected.height ?? 0, 0.75, "range forward marker height uses H");
		assertApproximatelyEqual(marker.top, (range.v - range.H) * expected.scaleY, 0.75, "known 300x200 fixture range top is (v-H) * viewport scale");
		assertApproximatelyEqual(marker.height, range.H * expected.scaleY, 0.75, "known 300x200 fixture range height is H * viewport scale");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop viewer Ctrl-click and Cmd-click send Host reverse SyncTeX PDF coordinates", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-reverse-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 147, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/147`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await drainHostMcpEvents(server.origin);

		for (const modifier of ["Control", "Meta"] as const) {
			await drainHostMcpEvents(server.origin);
			const point = await lwCanvasPoint(page, 1, modifier === "Control" ? 120 : 140, modifier === "Control" ? 70 : 80);
			await page.keyboard.down(modifier);
			try {
				await page.mouse.click(point.clientX, point.clientY);
			} finally {
				await page.keyboard.up(modifier);
			}
			const event = await waitForHostMcpEvent(server.origin, (candidate) => candidate.type === "reverse_synctex" && candidate.pdf_id === 147);
			assert.ok(event, `${modifier}-click reverse SyncTeX event should reach Host MCP event path`);
			assert.equal(event.page, 1);
			assertApproximatelyEqual(Number(event.x), point.pdfX, 1, `${modifier}-click reverse x should use PDF.js PDF-space conversion`);
			assertApproximatelyEqual(Number(event.y), point.pdfY, 1, `${modifier}-click reverse y should use PDF.js PDF-space conversion`);
		}
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop viewer selection reverse SyncTeX payload preserves selected text and endpoints", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-selection-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 148, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/148`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await drainHostMcpEvents(server.origin);

		const expected = await lwSelectionDragProbe(page, "DRAGTOKENALPHA");
		await page.mouse.move(expected.startClientX, expected.startClientY);
		await page.mouse.down();
		await page.mouse.move(expected.endClientX, expected.endClientY, { steps: 8 });
		await page.mouse.up();
		await page.waitForFunction(() => window.getSelection()?.toString() === "DRAGTOKENALPHA", undefined, { timeout: 2_000 });
		const events = await collectHostMcpEventsUntil(server.origin, (candidate) => candidate.type === "selection_debug" && candidate.phase === "post_send_audit");
		const event = events.find((candidate) => candidate.type === "reverse_synctex" && candidate.pdf_id === 148 && candidate.selectedText === expected.selectedText);
		assert.ok(event, "selection reverse SyncTeX event should preserve selected text");
		assert.equal(event.selectedText, "DRAGTOKENALPHA");
		assert.equal(event.textBeforeSelection, expected.textBeforeSelection);
		assert.equal(event.textAfterSelection, expected.textAfterSelection);
		assertApproximatelyEqual(Number(event.selectionStartX), expected.selectionStartX, 2, "selection start x follows PDF.js endpoint conversion");
		assertApproximatelyEqual(Number(event.selectionStartY), expected.selectionStartY, 2, "selection start y follows PDF.js endpoint conversion");
		assertApproximatelyEqual(Number(event.selectionEndX), expected.selectionEndX, 2, "selection end x follows PDF.js endpoint conversion");
		assertApproximatelyEqual(Number(event.selectionEndY), expected.selectionEndY, 2, "selection end y follows PDF.js endpoint conversion");
		const debugPhases = new Set(events.filter((candidate) => candidate.type === "selection_debug").map((candidate) => candidate.phase));
		for (const phase of ["mousedown", "selectionchange", "mouseup", "send", "post_send_audit"]) {
			assert.equal(debugPhases.has(phase), true, `selection_debug should include ${phase}`);
		}
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop viewer annotation is active by default and hidden debug switch gates hover overlay", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-hover-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 149, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/149`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);

		await page.waitForFunction(() => document.body.dataset.hostLwHoverEnabled === "true" && document.body.dataset.hostLwDebugSynctexEnabled === "false", undefined, { timeout: 2_000 });
		const activeAnnotationButton = await page.locator("#hostSynctexHoverButton").evaluate((element) => ({
			pressed: element.getAttribute("aria-pressed"),
			backgroundColor: getComputedStyle(element).backgroundColor,
			borderRadius: getComputedStyle(element).borderRadius,
		}));
		assert.equal(activeAnnotationButton.pressed, "true", "annotation mode should be enabled by default");
		assert.notEqual(activeAnnotationButton.backgroundColor, "rgba(0, 0, 0, 0)", "active annotation button should show a persistent background");
		assert.notEqual(activeAnnotationButton.borderRadius, "0px", "active annotation button should be rounded");
		await page.locator("#hostSynctexHoverButton").click();
		await page.waitForFunction(() => document.body.dataset.hostLwHoverEnabled === "false", undefined, { timeout: 2_000 });
		await page.locator("#hostSynctexHoverButton").click();
		await page.waitForFunction(() => document.body.dataset.hostLwHoverEnabled === "true", undefined, { timeout: 2_000 });
		const point = await lwCanvasPoint(page, 1, 120, 70);
		await page.mouse.move(point.clientX, point.clientY);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await page.locator("[data-reverse-synctex-hover='rect']").count(), 0, "hover debug overlay should be hidden by default");
		assert.equal(await page.locator("#hostSynctexDebugButton").count(), 0, "debug overlay control should not be visible in viewer UI");
		await new ViewerHostControlClient({ origin: server.origin }).send({ type: "set_debug_synctex", pdf_id: 149, enabled: true });
		await page.waitForFunction(() => document.body.dataset.hostLwDebugSynctexEnabled === "true", undefined, { timeout: 2_000 });
		await page.mouse.move(point.clientX + 1, point.clientY + 1);
		await page.waitForSelector("[data-reverse-synctex-hover='rect']", { state: "attached", timeout: 5_000 });
		const overlay = await page.locator("[data-reverse-synctex-hover='rect']").evaluate((element) => ({
			width: Number.parseFloat((element as HTMLElement).style.width),
			height: Number.parseFloat((element as HTMLElement).style.height),
			pressed: document.getElementById("hostSynctexHoverButton")?.getAttribute("aria-pressed"),
			debugEnabled: document.body.dataset.hostLwDebugSynctexEnabled,
		}));
		assert.equal(overlay.pressed, "true");
		assert.equal(overlay.debugEnabled, "true");
		assert.ok(overlay.width > 0 && overlay.height > 0, "hover result should render a visible overlay");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("direct LaTeX Workshop viewer reloads after the last toolbar tab is closed and focused again", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-direct-reopen-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 151, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/151`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await page.waitForFunction(() => document.body.dataset.hostLwSocket === "connected", undefined, { timeout: 5_000 });
		assert.equal(server.getConnectedViewerCount(151), 1);

		await page.locator("button.hostPdfTabClose[data-close-pdf-id='151']").click();
		await page.waitForFunction(() => document.body.dataset.hostLwSocket === "disconnected", undefined, { timeout: 5_000 });
		for (let attempt = 0; attempt < 20 && server.getConnectedViewerCount(151) !== 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(server.getConnectedViewerCount(151), 0);

		assert.equal((await new ViewerHostControlClient({ origin: server.origin }).send({ type: "focus_pdf", pdf_id: 151 })).ok, true);
		await page.waitForFunction(() => {
			const loaded = (window as unknown as { __hostLwRefreshDebug?: { loadedState: () => { activePdfId?: number; pdfDocumentLoaded?: boolean; renderedCanvasCount?: number; socketStatus?: string } } }).__hostLwRefreshDebug?.loadedState?.();
			return loaded?.activePdfId === 151 && loaded.pdfDocumentLoaded === true && (loaded.renderedCanvasCount ?? 0) > 0 && loaded.socketStatus === "connected";
		}, undefined, { timeout: 5_000 });
		assert.equal(server.getConnectedViewerCount(151), 1);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("LaTeX Workshop annotation comment bubble can extend outside the PDF page and accept typing", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-annotation-bubble-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 150, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/150`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);

		await page.evaluate((source) => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { showSynctexMarker: (message: unknown, options?: unknown) => boolean } }).__hostLwSynctexDebug?.showSynctexMarker({
				type: "synctex_forward",
				pdf_id: 150,
				page: 1,
				x: 560,
				y: 120,
				ranges: [
					{ page: 1, h: 560, v: 120, W: 28, H: 16 },
					{ page: 1, h: 560, v: 145, W: 46, H: 16 },
				],
				source_file: source,
				line: 3,
				source_line: "First paragraph text that should wrap a little and create boxes.",
			}, { scroll: false });
		}, sourcePath);
		await page.locator("[data-synctex-marker]").first().click();
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1);
		assert.equal(await page.locator("[data-pdf-annotation-box]").count(), 2);

		await page.evaluate((source) => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { showSynctexMarker: (message: unknown, options?: unknown) => boolean } }).__hostLwSynctexDebug?.showSynctexMarker({
				type: "synctex_forward",
				pdf_id: 150,
				page: 1,
				x: 560,
				y: 120,
				ranges: [
					{ page: 1, h: 560, v: 120, W: 28, H: 16 },
					{ page: 1, h: 560, v: 145, W: 46, H: 16 },
				],
				source_file: source,
				line: 3,
				source_line: "First paragraph text that should wrap a little and create boxes.",
			}, { scroll: false });
		}, sourcePath);
		await page.locator("[data-synctex-marker]").first().evaluate((element) => (element as HTMLElement).click());
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1, "same source line should reuse the existing annotation");
		assert.equal(await page.locator("[data-pdf-annotation-box]").count(), 2);

		await page.evaluate((source) => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { showSynctexMarker: (message: unknown, options?: unknown) => boolean } }).__hostLwSynctexDebug?.showSynctexMarker({
				type: "synctex_forward",
				pdf_id: 150,
				page: 1,
				x: 560,
				y: 120,
				ranges: [{ page: 1, h: 560, v: 120, W: 28, H: 16 }],
				source_file: source,
				line: 4,
				source_line: "Overlapping candidate.",
			}, { scroll: false });
		}, sourcePath);
		await page.locator("[data-synctex-marker]").first().evaluate((element) => (element as HTMLElement).click());
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1, "overlapping boxes should reuse the existing annotation");
		assert.equal(await page.locator("[data-pdf-annotation-box]").count(), 2);

		await page.locator("[data-pdf-annotation-box]").first().click();
		await page.locator("button[title='Add comment']").click();
		assert.equal(await page.locator("[data-pdf-annotation-bubble]").count(), 1);
		await page.locator("[data-pdf-annotation-bubble] textarea").fill("This comment should be editable outside the page edge.");

		const state = await page.locator("[data-pdf-annotation-bubble]").evaluate((bubble) => {
			const bubbleRect = bubble.getBoundingClientRect();
			const pageElement = bubble.closest(".page") as HTMLElement;
			const pageRect = pageElement.getBoundingClientRect();
			const textarea = bubble.querySelector("textarea") as HTMLTextAreaElement;
			return {
				bubbleParentIsPage: bubble.parentElement?.parentElement === pageElement,
				bubbleRight: bubbleRect.right,
				bubbleWidth: bubbleRect.width,
				pageRight: pageRect.right,
				viewportRight: window.innerWidth,
				value: textarea.value,
			};
		});
		assert.equal(state.bubbleParentIsPage, true);
		assert.ok(state.bubbleRight > state.pageRight, "comment bubble should extend beyond the PDF page boundary");
		assert.ok(state.bubbleRight <= state.viewportRight, "comment bubble should fit within the window when above its minimum width");
		assert.ok(state.bubbleWidth > 300, "comment bubble should default wider than the minimum width");
		assert.equal(state.value, "This comment should be editable outside the page edge.");

		const beforeDrag = await page.locator("[data-pdf-annotation-connector] line").evaluate((line) => ({
			x2: Number(line.getAttribute("x2")),
			y2: Number(line.getAttribute("y2")),
		}));
		const handle = await page.locator("[title='Drag comment bubble']").boundingBox();
		assert.ok(handle, "drag handle should be visible");
		await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
		await page.mouse.down();
		await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2 + 30);
		await page.mouse.up();
		const afterDrag = await page.locator("[data-pdf-annotation-connector] line").evaluate((line) => ({
			x2: Number(line.getAttribute("x2")),
			y2: Number(line.getAttribute("y2")),
		}));
		assert.ok(afterDrag.x2 > beforeDrag.x2 + 30, "connector should follow the dragged bubble horizontally");
		assert.ok(afterDrag.y2 > beforeDrag.y2 + 20, "connector should follow the dragged bubble vertically");

		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1, "annotation should still exist after dragging the comment bubble");
		await drainHostMcpEvents(server.origin);
		await page.evaluate(() => {
			const pageElement = document.querySelector("#viewer .page[data-page-number='1']") as HTMLElement | null;
			const wrapper = pageElement?.querySelector(".canvasWrapper") as HTMLElement | null;
			if (!pageElement || !wrapper) throw new Error("missing LW page wrapper");
			const pageRect = pageElement.getBoundingClientRect();
			const wrapperRect = wrapper.getBoundingClientRect();
			const textarea = document.createElement("textarea");
			textarea.dataset.hostEditableProbe = "true";
			textarea.value = "focus target";
			textarea.style.position = "absolute";
			textarea.style.left = `${wrapperRect.left - pageRect.left + 100}px`;
			textarea.style.top = `${wrapperRect.top - pageRect.top + 85}px`;
			textarea.style.width = "120px";
			textarea.style.height = "28px";
			textarea.style.zIndex = "100050";
			pageElement.appendChild(textarea);
		});
		await page.locator("[data-host-editable-probe]").click();
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(await page.locator("[data-host-editable-probe]").evaluate((element) => document.activeElement === element), true, "editable target inside the viewer should receive focus");
		assert.ok(await page.locator("[data-pdf-annotation]").count() <= 1, "clicking an editable target inside the viewer should not create another annotation");
		const eventsAfterEditableClick = await drainHostMcpEvents(server.origin);
		assert.equal(eventsAfterEditableClick.some((event) => event.type === "pdf_annotation"), false, "editable click should not emit a PDF annotation update");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("LaTeX Workshop viewer renders newer refresh when an older refresh never resolves", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-refresh-race-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVONE"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const pdfRequests: string[] = [];
	try {
		registry.registerPdf({ pdfId: 144, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const context = await browser.newContext();
		await context.route("**/pdf/144?revision=*", async (route) => {
			const url = route.request().url();
			pdfRequests.push(url);
			if (url.includes("revision=2")) {
				await new Promise(() => undefined);
				return;
			}
			const body = url.includes("revision=3") ? makeTwoPagePdfWithToken("REVTHREE") : makeTwoPagePdfWithToken("REVONE");
			await route.fulfill({ status: 200, contentType: "application/pdf", body });
		});
		const page = await context.newPage();
		await page.goto(`${server.origin}/viewer-lw/144`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector("#viewer .page[data-loaded='true'] canvas", { state: "attached", timeout: 15_000 });

		writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVTWO"));
		registry.registerPdf({ pdfId: 144, pdfPath, title: "paper.pdf", revision: 2, fileSnapshot: snapshotPdf(pdfPath) });
		assert.equal(server.sendPdfRefresh(144), 1);
		for (let attempt = 0; attempt < 50 && !pdfRequests.some((url) => url.includes("revision=2")); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(pdfRequests.some((url) => url.includes("revision=2")), true, "rev2 request should start before rev3 arrives");
		writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVTHREE"));
		registry.registerPdf({ pdfId: 144, pdfPath, title: "paper.pdf", revision: 3, fileSnapshot: snapshotPdf(pdfPath) });
		assert.equal(server.sendPdfRefresh(144), 1);

		await page.waitForFunction(() => document.body.dataset.hostLwVisibleRevision === "3", undefined, { timeout: 15_000 });
		assert.deepEqual(pdfRequests.filter((url) => /revision=[23]/.test(url)), [`${server.origin}/pdf/144?revision=2`, `${server.origin}/pdf/144?revision=3`]);
		assert.equal(await page.evaluate(() => document.body.dataset.hostLwLatestRevision), "3");
		assert.equal(await page.evaluate(() => document.body.dataset.hostLwVisibleRevision), "3");
		assert.equal(await page.evaluate(() => document.body.dataset.hostLwLastError), "", "hung rev2 must not overwrite rev3 status");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

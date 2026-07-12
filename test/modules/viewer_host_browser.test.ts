import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page, type Request, type Response, type Route } from "playwright";
import { handleMcpRequest } from "../../src/modules/host_service_mcp.ts";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostMcpService, type ViewerHostClient } from "../../src/modules/viewer_host_client.ts";
import type { McpToViewerHostMessage, ViewerHostControlResponse } from "../../src/modules/viewer_host_protocol.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";
import { forceViewerProbeClick, installCaptureHelper, installInteractiveForcedClickCapture, type InteractiveForcedClick } from "../../scripts/debug-viewer-synctex.ts";

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
\Large Click \hyperlink{Mean-field coupled system}{mean-field decoupled measurement system}.\\[2em]
\href{https://example.com/}{External URL that must not become viewer history.}
\newpage
\section{Mean-field coupled system}\label{Mean-field coupled system}
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
		await new ViewerHostControlClient({ origin: server.origin }).send({ type: "set_debug_synctex", pdf_id: 260, enabled: true });
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
		const drained = await (await fetch(`${server.origin}/mcp-events/drain`, { method: "POST" })).json() as { events: Array<{ type: string; phase?: string; details?: { points?: unknown[]; elements?: unknown; scrollbarGutter?: unknown } }> };
		const hitTargetEvent = drained.events.find((event) => event.type === "selection_debug" && event.phase === "lw_tools_hit_target");
		assert.ok(hitTargetEvent, `Tools hit-target diagnostics should be retrievable through MCP events: ${JSON.stringify(drained.events.map((event) => event.phase))}`);
		assert.ok(Array.isArray(hitTargetEvent.details?.points) && hitTargetEvent.details.points.length >= 3, "event diagnostics should include left/center/right elementFromPoint results");
		assert.ok(hitTargetEvent.details?.elements, "event diagnostics should include relevant element rect/style details");
		assert.ok(hitTargetEvent.details?.scrollbarGutter, "event diagnostics should include scrollbar/gutter details");

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
		await new ViewerHostControlClient({ origin: server.origin }).send({ type: "set_debug_synctex", pdf_id: 261, enabled: true });
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

test("LaTeX Workshop viewer applies initial named destination hash for label-backed hyperlinks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-label-hash-"));
	const { pdfPath } = writeBrowserLinkFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 153, pdfPath, title: "links.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 520, height: 260 } });
		await page.goto(`${server.origin}/viewer-lw/153?revision=1#Mean-field%20coupled%20system`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
			const application = (window as unknown as { PDFViewerApplication?: { page?: number; pdfViewer?: { currentPageNumber?: number } } }).PDFViewerApplication;
			return application?.page === 2 || application?.pdfViewer?.currentPageNumber === 2;
		}, undefined, { timeout: 10_000 });
		assert.equal(await page.evaluate(() => location.hash), "#Mean-field%20coupled%20system");

		await page.goto(`${server.origin}/viewer-lw/153?revision=1`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page, 1);
		await page.locator("a[href$='#Mean-field%20coupled%20system']").click({ force: true });
		await page.waitForFunction(() => {
			const application = (window as unknown as { PDFViewerApplication?: { page?: number; pdfViewer?: { currentPageNumber?: number } } }).PDFViewerApplication;
			return application?.page === 2 || application?.pdfViewer?.currentPageNumber === 2;
		}, undefined, { timeout: 10_000 });
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("direct LaTeX Workshop viewer loads PDF pages and emits loaded-state diagnostics", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-direct-diagnostics-"));
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
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 144, pdf_path: pdfPath, title: "Direct viewer PDF", debug_synctex: true })).ok, true);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`${server.origin}/viewer-lw/144`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
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


test("direct viewer restores each tab position after tab switches and browser reload", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-tab-view-state-"));
	const firstPdfPath = join(baseDir, "first.pdf");
	const secondPdfPath = join(baseDir, "second.pdf");
	writeFileSync(firstPdfPath, makeTwoPagePdfWithToken("FIRST"));
	writeFileSync(secondPdfPath, makeTwoPagePdfWithToken("SECOND"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 240, pdf_path: firstPdfPath, title: "First" })).ok, true);
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 241, pdf_path: secondPdfPath, title: "Second" })).ok, true);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
		await page.goto(`${server.origin}/viewer-lw`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
			const loaded = (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number; renderedCanvasCount?: number } }).__hostLwLoadedState?.();
			return loaded?.activePdfId === 241 && (loaded.renderedCanvasCount ?? 0) > 0
				&& document.querySelectorAll("#hostPdfTabsContainer .hostPdfTab").length === 2;
		}, undefined, { timeout: 15_000 });

		const readView = async () => await page.evaluate(() => {
			const application = (window as unknown as { PDFViewerApplication: { pdfViewer: { currentPageNumber: number; currentScaleValue: string } } }).PDFViewerApplication;
			const container = document.getElementById("viewerContainer");
			return { page: application.pdfViewer.currentPageNumber, scale: application.pdfViewer.currentScaleValue, scrollTop: container?.scrollTop ?? 0, scrollLeft: container?.scrollLeft ?? 0 };
		});
		const waitForView = async (pdfId: number, expected: { page: number; scale: string; scrollTop: number; scrollLeft: number }) => {
			await page.waitForFunction(({ pdfId: expectedPdfId, expectedState }) => {
				const loaded = (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number; renderedCanvasCount?: number } }).__hostLwLoadedState?.();
				const application = (window as unknown as { PDFViewerApplication?: { pdfViewer?: { currentPageNumber: number; currentScaleValue: string } } }).PDFViewerApplication;
				const container = document.getElementById("viewerContainer");
				return loaded?.activePdfId === expectedPdfId && (loaded.renderedCanvasCount ?? 0) > 0
					&& application?.pdfViewer?.currentPageNumber === expectedState.page && application.pdfViewer.currentScaleValue === expectedState.scale
					&& Math.abs((container?.scrollTop ?? 0) - expectedState.scrollTop) <= 2
					&& Math.abs((container?.scrollLeft ?? 0) - expectedState.scrollLeft) <= 2;
			}, { pdfId, expectedState: expected }, { timeout: 10_000 });
		};
		const setSecondPageView = async (scale: string, extraScroll: number) => {
			await page.evaluate(({ scale: nextScale, extraScroll: nextExtraScroll }) => {
				const application = (window as unknown as { PDFViewerApplication: { page: number; pdfViewer: { currentPageNumber: number; currentScaleValue: string; scrollPageIntoView(input: { pageNumber: number }): void } } }).PDFViewerApplication;
				application.pdfViewer.currentScaleValue = nextScale;
				application.pdfViewer.currentPageNumber = 2;
				application.page = 2;
				application.pdfViewer.scrollPageIntoView({ pageNumber: 2 });
				document.getElementById("viewerContainer")?.scrollBy(0, nextExtraScroll);
			}, { scale, extraScroll });
			await page.waitForFunction(() => (document.getElementById("viewerContainer")?.scrollTop ?? 0) > 0);
		};

		await setSecondPageView("150", 40);
		const secondView = await readView();
		await page.locator("#hostPdfTabsContainer .hostPdfTabButton[data-pdf-id='240']").click();
		await page.waitForFunction(() => document.querySelector("#viewer .textLayer")?.textContent?.includes("FIRST") === true, undefined, { timeout: 10_000 });
		await setSecondPageView("125", 25);
		const firstView = await readView();

		await page.locator("#hostPdfTabsContainer .hostPdfTabButton[data-pdf-id='241']").click();
		await waitForView(241, secondView);
		await page.locator("#hostPdfTabsContainer .hostPdfTabButton[data-pdf-id='240']").click();
		await waitForView(240, firstView);

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForView(240, firstView);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("reopening the active PDF never rolls back when an older prefetch finishes late", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-active-reopen-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVONE"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	let releaseRevisionTwo = () => {};
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		const firstOpen = await client.send({ type: "open_pdf", pdf_id: 146, pdf_path: pdfPath, title: "paper.pdf" });
		assert.deepEqual(firstOpen, { ok: true, result: { type: "open_pdf", pdf_id: 146, revision: 1 } });

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/146`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		assert.equal((await drainHostMcpEvents(server.origin)).some((event) => event.type === "selection_debug"), false, "normal viewer mode must not enqueue hidden diagnostics");
		let markRevisionTwoRequested: (() => void) | undefined;
		const revisionTwoRequested = new Promise<void>((resolveRequest) => { markRevisionTwoRequested = resolveRequest; });
		const revisionTwoGate = new Promise<void>((resolveGate) => { releaseRevisionTwo = resolveGate; });
		await page.route(`${server.origin}/pdf/146?revision=2`, async (route) => {
			markRevisionTwoRequested?.();
			await revisionTwoGate;
			await route.continue();
		});

		writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVTWO"));
		const secondOpen = await client.send({ type: "open_pdf", pdf_id: 146, pdf_path: pdfPath, title: "paper.pdf" });
		assert.deepEqual(secondOpen, { ok: true, result: { type: "open_pdf", pdf_id: 146, revision: 2 } });
		await revisionTwoRequested;

		writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVTHREE"));
		const thirdOpen = await client.send({ type: "open_pdf", pdf_id: 146, pdf_path: pdfPath, title: "paper.pdf" });
		assert.deepEqual(thirdOpen, { ok: true, result: { type: "open_pdf", pdf_id: 146, revision: 3 } });
		await page.waitForFunction(() => document.body.dataset.hostLwVisibleRevision === "3", undefined, { timeout: 10_000 });
		releaseRevisionTwo();
		await page.waitForTimeout(150);
		assert.deepEqual(await page.evaluate(() => ({ visible: document.body.dataset.hostLwVisibleRevision, latest: document.body.dataset.hostLwLatestRevision })), { visible: "3", latest: "3" });
	} finally {
		releaseRevisionTwo();
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("direct viewer honors active replay and the latest rapid tab selection", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-tab-switch-race-"));
	const slowPdfPath = join(baseDir, "slow.pdf");
	const latestPdfPath = join(baseDir, "latest.pdf");
	const activePdfPath = join(baseDir, "active.pdf");
	writeFileSync(slowPdfPath, makeTwoPagePdfWithToken("SLOW"));
	writeFileSync(latestPdfPath, makeTwoPagePdfWithToken("LATEST"));
	writeFileSync(activePdfPath, makeTwoPagePdfWithToken("ACTIVE"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const releaseOutstandingGates = new Set<() => void>();
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 270, pdf_path: slowPdfPath, title: "Slow" })).ok, true);
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 271, pdf_path: latestPdfPath, title: "Latest" })).ok, true);
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 272, pdf_path: activePdfPath, title: "Active" })).ok, true);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		const slowConfigUrl = `${server.origin}/config/270.json`;
		const gateSlowConfig = async () => {
			let release = () => {};
			const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
			releaseOutstandingGates.add(release);
			const handler = async (route: Route) => {
				await gate;
				await route.continue();
			};
			await page.route(slowConfigUrl, handler);
			return async () => {
				release();
				releaseOutstandingGates.delete(release);
				await page.waitForTimeout(100);
				await page.unroute(slowConfigUrl, handler);
			};
		};
		const releaseInitialReplay = await gateSlowConfig();
		await page.goto(`${server.origin}/viewer-lw`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
			const loaded = (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number; renderedCanvasCount?: number } }).__hostLwLoadedState?.();
			return loaded?.activePdfId === 272 && (loaded.renderedCanvasCount ?? 0) > 0
				&& document.querySelectorAll("#hostPdfTabsContainer .hostPdfTab").length === 3;
		}, undefined, { timeout: 15_000 });
		await releaseInitialReplay();
		assert.equal(await page.evaluate(() => (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number } }).__hostLwLoadedState?.().activePdfId), 272, "active replay must supersede an earlier slow inactive tab");

		const releaseFocusedAway = await gateSlowConfig();
		await page.locator("#hostPdfTabsContainer .hostPdfTabButton[data-pdf-id='270']").click();
		await page.waitForFunction(() => (window as unknown as { __hostLwLoadedState?: () => { pendingDirectViewerPdfId?: number } }).__hostLwLoadedState?.().pendingDirectViewerPdfId === 270);
		assert.equal((await client.send({ type: "focus_pdf", pdf_id: 272 })).ok, true);
		await page.waitForFunction(() => (window as unknown as { __hostLwLoadedState?: () => { pendingDirectViewerPdfId?: number } }).__hostLwLoadedState?.().pendingDirectViewerPdfId === undefined);
		await releaseFocusedAway();
		assert.equal(await page.evaluate(() => (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number } }).__hostLwLoadedState?.().activePdfId), 272, "newer Host focus must cancel a pending user switch");

		const releaseRapidSwitch = await gateSlowConfig();
		await page.locator("#hostPdfTabsContainer .hostPdfTabButton[data-pdf-id='270']").click();
		await page.waitForFunction(() => (window as unknown as { __hostLwLoadedState?: () => { pendingDirectViewerPdfId?: number } }).__hostLwLoadedState?.().pendingDirectViewerPdfId === 270);
		await page.locator("#hostPdfTabsContainer .hostPdfTabButton[data-pdf-id='271']").click();
		await page.waitForFunction(() => {
			const loaded = (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number; renderedCanvasCount?: number; socketStatus?: string } }).__hostLwLoadedState?.();
			return loaded?.activePdfId === 271 && loaded.socketStatus === "connected" && (loaded.renderedCanvasCount ?? 0) > 0;
		}, undefined, { timeout: 15_000 });
		await releaseRapidSwitch();
		assert.equal(await page.evaluate(() => (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number } }).__hostLwLoadedState?.().activePdfId), 271);
		assert.equal(server.getConnectedViewerCount(271), 1);
		assert.equal(server.getConnectedViewerCount(270), 0);

		const releaseClosedSwitch = await gateSlowConfig();
		await page.locator("#hostPdfTabsContainer .hostPdfTabButton[data-pdf-id='270']").click();
		await page.waitForFunction(() => (window as unknown as { __hostLwLoadedState?: () => { pendingDirectViewerPdfId?: number } }).__hostLwLoadedState?.().pendingDirectViewerPdfId === 270);
		await page.locator("#hostPdfTabsContainer .hostPdfTabClose[data-close-pdf-id='270']").click();
		await page.waitForFunction(() => (window as unknown as { __hostLwLoadedState?: () => { pendingDirectViewerPdfId?: number } }).__hostLwLoadedState?.().pendingDirectViewerPdfId === undefined
			&& document.querySelector("#hostPdfTabsContainer .hostPdfTab[data-pdf-id='270']") === null);
		await releaseClosedSwitch();
		assert.equal(await page.evaluate(() => (window as unknown as { __hostLwLoadedState?: () => { activePdfId?: number } }).__hostLwLoadedState?.().activePdfId), 271, "a closed pending tab must never become active");
	} finally {
		for (const release of releaseOutstandingGates) release();
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("LaTeX Workshop viewer reconciles a PDF refresh missed while its Host socket was disconnected", async () => {
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
		writeFileSync(pdfPath, makeTwoPagePdfWithToken("REVTWO"));
		registry.registerPdf({ pdfId: 145, pdfPath, title: "paper.pdf", revision: 2, fileSnapshot: snapshotPdf(pdfPath) });
		assert.equal(server.sendPdfRefresh(145), 0, "the revision notification is intentionally missed while disconnected");

		await page.waitForFunction(() => document.body.dataset.hostLwSocket === "connected", undefined, { timeout: 5_000 });
		assert.equal(server.getConnectedViewerCount(145), 1);
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

async function lwSetCollapsedSelection(page: Page, token: string): Promise<{ textBeforeSelection: string; textAfterSelection: string }> {
	return await page.evaluate((needle) => {
		const textLayer = document.querySelector("#viewer .page[data-page-number='1'] .textLayer") as HTMLElement | null;
		if (!textLayer) throw new Error("missing LW text layer");
		const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const text = node.textContent ?? "";
			const offset = text.indexOf(needle);
			if (offset >= 0) {
				const collapsedOffset = offset + Math.floor(needle.length / 2);
				const range = document.createRange();
				range.setStart(node, collapsedOffset);
				range.collapse(true);
				const selection = window.getSelection();
				if (!selection) throw new Error("browser selection is unavailable");
				selection.removeAllRanges();
				selection.addRange(range);
				return { textBeforeSelection: text.substring(0, collapsedOffset), textAfterSelection: text.substring(collapsedOffset) };
			}
			node = walker.nextNode();
		}
		throw new Error(`collapsed selection token not found: ${needle}`);
	}, token);
}

async function lwCollapsedSelectionContext(page: Page): Promise<{ isCollapsed: boolean; textBeforeSelection?: string; textAfterSelection?: string }> {
	return await page.evaluate(() => {
		const pageElement = document.querySelector("#viewer .page[data-page-number='1']") as HTMLElement | null;
		const textLayer = pageElement?.querySelector(".textLayer");
		const selection = window.getSelection();
		if (!textLayer || !selection || selection.rangeCount === 0) return { isCollapsed: false };
		const range = selection.getRangeAt(0);
		if (!selection.isCollapsed || !textLayer.contains(range.commonAncestorContainer) || selection.anchorNode?.nodeType !== Node.TEXT_NODE || typeof selection.anchorNode.textContent !== "string") return { isCollapsed: false };
		return {
			isCollapsed: true,
			textBeforeSelection: selection.anchorNode.textContent.substring(0, selection.anchorOffset),
			textAfterSelection: selection.anchorNode.textContent.substring(selection.anchorOffset),
		};
	});
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

test("LaTeX Workshop viewer shows pending mark feedback and clears it on a reported SyncTeX failure", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-probe-failure-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeTwoPagePdfWithToken("NO-SYNCTEX"));
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 147, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
		await page.goto(`${server.origin}/viewer-lw/147`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);

		const pendingState = await page.locator(".page[data-page-number='1'] canvas").evaluate((canvas) => {
			const rect = canvas.getBoundingClientRect();
			canvas.dispatchEvent(new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				button: 0,
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + rect.height / 2,
			}));
			return {
				visible: document.querySelector("[data-reverse-synctex-forward-probe]") !== null,
				status: document.querySelector("[data-pdf-mark-status]")?.textContent,
			};
		});
		assert.deepEqual(pendingState, { visible: true, status: "Resolving PDF mark…" }, "a click must explain its pending state synchronously");
		await page.waitForFunction(() => document.querySelector("#hostSynctexCapabilityBanner")?.getAttribute("data-issue-code") === "synctex_missing");
		assert.equal(await page.locator("[data-reverse-synctex-forward-probe]").count(), 0, "a real mapping failure must clear provisional feedback");
		assert.equal(await page.locator("[data-pdf-mark-status]").count(), 0, "a real mapping failure must clear pending status text");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop viewer reports unexpected failures in the general popup and can forward them to the agent", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-reported-failure-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeOnePagePdf());
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 154, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/154`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);

		const control = new ViewerHostControlClient({ origin: server.origin });
		assert.deepEqual(await control.send({
			type: "report_error",
			pdf_id: 154,
			code: "mark_fetch_failed",
			title: "Could not fetch PDF marks",
			detail: "The Viewer Host rejected the mark claim.",
			inject_text: "PDF mark delivery failed: claim rejected",
		}), { ok: true, result: { type: "report_error", pdf_id: 154 } });

		await page.waitForSelector("#hostViewerNotificationBox[data-severity='error']", { state: "attached", timeout: 2_000 });
		const popup = await page.locator("#hostViewerNotificationBox").evaluate((element) => ({
			role: element.getAttribute("role"),
			text: element.querySelector(".hostViewerNotificationText")?.textContent,
		}));
		assert.deepEqual(popup, {
			role: "alert",
			text: "Could not fetch PDF marks\nThe Viewer Host rejected the mark claim.",
		});
		assert.equal(await page.locator("#hostSynctexCapabilityBanner").count(), 0, "unexpected failures must use the prominent general popup");

		await page.getByRole("button", { name: "Forward to agent" }).click();
		await page.waitForTimeout(50);
		const claimResponse = await fetch(`${server.origin}/marks/claim`, { method: "POST" });
		assert.equal(claimResponse.status, 200);
		const claim = await claimResponse.json() as { marks?: Array<{ comment?: string }> };
		assert.equal(claim.marks?.[0]?.comment, "PDF mark delivery failed: claim rejected");
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
		await new ViewerHostControlClient({ origin: server.origin }).send({ type: "set_debug_synctex", pdf_id: 148, enabled: true });
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/148`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await drainHostMcpEvents(server.origin);
		await page.locator("#hostSynctexHoverButton").click(); // Text selection remains available outside annotation mode.

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

test("LaTeX Workshop viewer sends an unmocked marking probe for arbitrary blank PDF coordinates", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-unmocked-probe-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const requests: Array<Record<string, unknown>> = [];
	try {
		registry.registerPdf({ pdfId: 258, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
		page.on("request", (request) => {
			if (new URL(request.url()).pathname !== "/synctex/probe") return;
			requests.push(request.postDataJSON() as Record<string, unknown>);
		});
		await page.goto(`${server.origin}/viewer-lw/258`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		const point = await lwCanvasPoint(page, 1, 280, 180);
		const hitsTextLayer = await page.evaluate(({ clientX, clientY }) => document.elementsFromPoint(clientX, clientY).some((element) => element.closest(".textLayer span")), point);
		assert.equal(hitsTextLayer, false, "fixture point must be blank PDF space rather than a text span");
		const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/synctex/probe" && response.request().method() === "POST");
		await page.mouse.click(point.clientX, point.clientY);
		const response = await responsePromise;
		assert.equal(response.status(), 200);
		const body = await response.json() as { ok: boolean; result: Record<string, unknown> };
		assert.equal(body.ok, true);
		assert.equal(body.result.error, undefined, `real probe should resolve: ${JSON.stringify(body.result)}`);
		assert.equal(requests.length, 1, "blank-space click must issue one real marking probe");
		assert.equal(requests[0]?.pdf_id, 258);
		assert.equal(requests[0]?.page, 1);
		assertApproximatelyEqual(Number(requests[0]?.x), point.pdfX, 1, "request x should use the real PDF.js viewport conversion");
		assertApproximatelyEqual(Number(requests[0]?.y), point.pdfY, 1, "request y should use the real PDF.js viewport conversion");
		assert.equal(Object.hasOwn(body.result, "debug_forward_groups"), false, "debug trace must remain absent outside explicit debug mode");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("LaTeX Workshop forced page-target click bypasses an annotation overlay and uses the real probe endpoint", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-forced-probe-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const requests: Array<Record<string, unknown>> = [];
	try {
		registry.registerPdf({ pdfId: 257, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
		page.on("request", (request) => {
			if (new URL(request.url()).pathname !== "/synctex/probe") return;
			requests.push(request.postDataJSON() as Record<string, unknown>);
		});
		await page.goto(`${server.origin}/viewer-lw/257`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		const point = await lwCanvasPoint(page, 1, 280, 180);
		const overlayTarget = await page.evaluate(({ clientX, clientY }) => {
			const pageElement = document.querySelector("#viewer .page[data-page-number='1']") as HTMLElement | null;
			if (!pageElement) throw new Error("missing page");
			const rect = pageElement.getBoundingClientRect();
			const overlay = document.createElement("div");
			overlay.dataset.pdfAnnotation = "forced-probe-test";
			overlay.dataset.forcedProbeOverlay = "true";
			overlay.style.cssText = `position:absolute;left:${clientX - rect.left - 12}px;top:${clientY - rect.top - 12}px;width:24px;height:24px;z-index:100100;`;
			pageElement.append(overlay);
			return document.elementsFromPoint(clientX, clientY).some((element) => element.getAttribute("data-forced-probe-overlay") === "true");
		}, point);
		assert.equal(overlayTarget, true, "the physical point should be policy-blocked by an annotation overlay");
		const expectedSelection = await lwSetCollapsedSelection(page, "DRAGTOKENALPHA");
		const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/synctex/probe" && response.request().method() === "POST");
		const dispatched = await forceViewerProbeClick(page, { page: 1, clientX: point.clientX, clientY: point.clientY });
		assert.equal(dispatched.tag, "div");
		assert.equal(dispatched.page, 1);
		const response = await responsePromise;
		assert.equal(response.status(), 200);
		const body = await response.json() as { ok: boolean; result: Record<string, unknown> };
		assert.equal(body.ok, true);
		assert.equal(body.result.error, undefined, `forced page-target probe should resolve: ${JSON.stringify(body.result)}`);
		assert.equal(requests.length, 1, "forced click must use the viewer's unmocked /synctex/probe path");
		assertApproximatelyEqual(Number(requests[0]?.x), point.pdfX, 1, "forced dispatch should retain PDF.js x conversion");
		assertApproximatelyEqual(Number(requests[0]?.y), point.pdfY, 1, "forced dispatch should retain PDF.js y conversion");
		assert.equal(requests[0]?.textBeforeSelection, expectedSelection.textBeforeSelection);
		assert.equal(requests[0]?.textAfterSelection, expectedSelection.textAfterSelection);
		assert.deepEqual(await lwCollapsedSelectionContext(page), { isCollapsed: true, ...expectedSelection }, "forced diagnostic clicks must retain collapsed selection context");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("interactive diagnostic capture forces PDF clicks past annotations without touching toolbar clicks", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-interactive-forced-probe-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const requests: Array<Record<string, unknown>> = [];
	try {
		registry.registerPdf({ pdfId: 256, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
		page.on("request", (request) => {
			if (new URL(request.url()).pathname !== "/synctex/probe") return;
			requests.push(request.postDataJSON() as Record<string, unknown>);
		});
		await page.goto(`${server.origin}/viewer-lw/256`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await installCaptureHelper(page);
		const recorded: InteractiveForcedClick[] = [];
		let resolveRecorded: (() => void) | undefined;
		const recordedPromise = new Promise<void>((resolveRecordedClick) => { resolveRecorded = resolveRecordedClick; });
		await installInteractiveForcedClickCapture(page, {
			onClick(value) {
				recorded.push(value);
				resolveRecorded?.();
			},
			onExit() {},
		});
		const point = await lwCanvasPoint(page, 1, 280, 180);
		const toolbarPoint = await page.evaluate(({ clientX, clientY }) => {
			const pageElement = document.querySelector("#viewer .page[data-page-number='1']") as HTMLElement | null;
			if (!pageElement) throw new Error("missing page");
			const rect = pageElement.getBoundingClientRect();
			const overlay = document.createElement("div");
			overlay.dataset.interactiveForcedProbeOverlay = "true";
			overlay.style.cssText = `position:absolute;left:${clientX - rect.left - 12}px;top:${clientY - rect.top - 12}px;width:24px;height:24px;z-index:100100;`;
			overlay.addEventListener("click", () => { document.body.dataset.interactiveOverlayClicked = "true"; });
			pageElement.append(overlay);
			const toolbar = document.createElement("button");
			toolbar.textContent = "Unrelated toolbar control";
			toolbar.style.cssText = "position:fixed;left:4px;top:4px;z-index:100101;";
			toolbar.addEventListener("click", () => { document.body.dataset.interactiveToolbarClicked = "true"; });
			document.body.append(toolbar);
			const toolbarRect = toolbar.getBoundingClientRect();
			return { x: toolbarRect.left + toolbarRect.width / 2, y: toolbarRect.top + toolbarRect.height / 2 };
		}, point);
		const expectedSelection = await lwSetCollapsedSelection(page, "DRAGTOKENALPHA");
		const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/synctex/probe" && response.request().method() === "POST");
		await page.mouse.click(point.clientX, point.clientY);
		const response = await responsePromise;
		await recordedPromise;
		assert.equal(response.status(), 200);
		assert.equal(requests.length, 1, "the guarded redispatch must issue exactly one real probe");
		assertApproximatelyEqual(Number(requests[0]?.x), point.pdfX, 1, "forced interactive click should retain PDF.js x conversion");
		assertApproximatelyEqual(Number(requests[0]?.y), point.pdfY, 1, "forced interactive click should retain PDF.js y conversion");
		assert.equal(requests[0]?.textBeforeSelection, expectedSelection.textBeforeSelection);
		assert.equal(requests[0]?.textAfterSelection, expectedSelection.textAfterSelection);
		assert.deepEqual(await lwCollapsedSelectionContext(page), { isCollapsed: true, ...expectedSelection }, "interactive diagnostic capture must retain collapsed selection context");
		assert.equal(recorded.length, 1, "the guarded synthetic click must not recurse into another capture");
		assert.equal(recorded[0]?.dispatch_target.tag, "div");
		assert.equal(recorded[0]?.dispatch_target.page, 1);
		assert.equal(await page.evaluate(() => document.body.dataset.interactiveOverlayClicked), undefined, "physical annotation click should be suppressed");
		await page.mouse.click(toolbarPoint.x, toolbarPoint.y);
		assert.equal(await page.evaluate(() => document.body.dataset.interactiveToolbarClicked), "true", "non-page clicks must remain untouched");
		assert.equal(recorded.length, 1);
		assert.equal(requests.length, 1);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("SyncTeX debug probe shows one selected forward-group box and Escape clears it", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-debug-forward-group-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 259, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		await new ViewerHostControlClient({ origin: server.origin }).send({ type: "set_debug_synctex", pdf_id: 259, enabled: true });
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.route("**/synctex/probe", async (route) => {
			const body = route.request().postDataJSON() as { request_id: number };
			await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: {
				type: "reverse_synctex_forward_probe_result", pdf_id: 259, request_id: body.request_id,
				click_page: 1, click_x: 100, click_y: 100, page: 1, x: 40, y: 150, width: 20, height: 10,
				ranges: [{ page: 1, h: 40, v: 150, W: 20, H: 10 }], source_file: sourcePath, line: 3, source_line: "fixture source",
				debug_forward_groups: [
					{ origin: "synctex_exact", lookup_line: 3, semantic_penalty: 0, geometry_tier: 0, score: 12, selected: true, chosen_box: { page: 1, h: 40, v: 150, W: 20, H: 10 } },
					{ origin: "pdf_text_span", lookup_line: 3, semantic_penalty: 0, geometry_tier: 0, score: 12, selected: false, chosen_box: { page: 1, h: 90, v: 150, W: 30, H: 10 } },
				],
			} }) });
		});
		await page.goto(`${server.origin}/viewer-lw/259`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		const point = await lwCanvasPoint(page, 1, 120, 70);
		await page.mouse.click(point.clientX, point.clientY);
		const debugBoxes = page.locator("[data-synctex-probe-debug-box]");
		await debugBoxes.waitFor({ state: "attached" });
		assert.equal(await debugBoxes.count(), 1);
		const summary = page.locator("[data-synctex-probe-debug-summary]");
		assert.match(await summary.textContent() ?? "", /pdf_text_span line 3 tier 0 penalty 0 score 12/);
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => document.querySelectorAll("[data-synctex-probe-debug-box], [data-synctex-probe-debug-summary]").length === 0);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("LaTeX Workshop viewer shows a SyncTeX capability banner when annotations cannot resolve", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-synctex-banner-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeOnePagePdf());
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 152, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/152`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		const point = await lwCanvasPoint(page, 1, 120, 70);
		await page.mouse.click(point.clientX, point.clientY);

		await page.waitForSelector("#hostSynctexCapabilityBanner[data-issue-code='synctex_missing']", { state: "attached", timeout: 5_000 });
		const banner = await page.locator("#hostSynctexCapabilityBanner").evaluate((element) => ({
			top: element.getBoundingClientRect().top,
			title: element.querySelector(".hostSynctexCapabilityBannerTitle")?.textContent,
			detail: element.querySelector(".hostSynctexCapabilityBannerDetail")?.textContent,
			toolbarBottom: document.getElementById("toolbarContainer")?.getBoundingClientRect().bottom,
		}));
		assert.equal(banner.title, "SyncTeX artifacts are missing");
		assert.match(banner.detail ?? "", /missing SyncTeX sidecar/i);
		assert.ok(banner.top >= (banner.toolbarBottom ?? 0), "capability banner should appear under the toolbar");
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


test("LaTeX Workshop clear annotations button removes marks and comments", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-clear-annotations-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 154, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/154`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await page.waitForFunction(() => document.body.dataset.hostLwSocket === "connected", undefined, { timeout: 5_000 });
		await page.locator("#hostClearAnnotationsButton").waitFor({ state: "visible", timeout: 2_000 });
		assert.equal(await page.locator("#hostClearAnnotationsButton").getAttribute("aria-label"), "Clear all marks and comments");

		await page.evaluate((source) => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { showSynctexMarker: (message: unknown, options?: unknown) => boolean } }).__hostLwSynctexDebug?.showSynctexMarker({
				type: "synctex_forward",
				pdf_id: 154,
				page: 1,
				x: 120,
				y: 70,
				width: 24,
				height: 14,
				source_file: source,
				line: 3,
				source_line: "First paragraph text that should wrap a little and create boxes.",
			}, { scroll: false });
		}, sourcePath);
		await page.locator("[data-synctex-marker]").first().click();
		await page.locator("[data-pdf-annotation-box]").first().click();
		await page.locator("button[title='Add comment']").click();
		await page.locator("[data-pdf-annotation-bubble] textarea").fill("Clear this comment.");
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1);
		assert.equal(await page.locator("[data-pdf-annotation-bubble]").count(), 1);

		await page.locator("#hostClearAnnotationsButton").click();
		await page.waitForFunction(() => document.querySelectorAll("[data-pdf-annotation]").length === 0, undefined, { timeout: 2_000 });
		assert.equal(await page.locator("[data-pdf-annotation-bubble]").count(), 0);
		const storage = await page.evaluate(() => JSON.parse(localStorage.getItem("agent-synctex.pdfAnnotations") || "{}") as Record<string, unknown[]>);
		assert.deepEqual(storage["154"], []);
		await page.waitForTimeout(100);
		const events = await drainHostMcpEvents(server.origin);
		assert.equal(events.some((event) => event.type === "pdf_annotation" && event.pdf_id === 154), false, "cleared annotations should not remain queued for MCP context");

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 0, "cleared annotations should not restore from local storage");
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
				source_span: { source_file: "/nested/path/this-is-a-very-long-source-name.tex", start_line: 12, end_line: 15 },
			}, { scroll: false });
		}, sourcePath);
		const sourceMarkerBounds = await page.locator("[data-synctex-marker]").evaluateAll((elements) => {
			const rects = elements.map((element) => element.getBoundingClientRect());
			return {
				left: Math.min(...rects.map((rect) => rect.left)),
				top: Math.min(...rects.map((rect) => rect.top)),
				right: Math.max(...rects.map((rect) => rect.right)),
				bottom: Math.max(...rects.map((rect) => rect.bottom)),
			};
		});
		await page.locator("[data-synctex-marker]").first().click();
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1);
		assert.equal(await page.locator("[data-pdf-annotation-box]").count(), 1, "boxes for one source line should fuse into one marking");
		const fusedBoxBounds = await page.locator("[data-pdf-annotation-box]").evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
		});
		for (const edge of ["left", "top", "right", "bottom"] as const) {
			assert.ok(Math.abs(fusedBoxBounds[edge] - sourceMarkerBounds[edge]) < 1, `fused box should preserve the ${edge} extreme`);
		}
		const sourceBadges = page.locator("[data-pdf-annotation-source-badge]");
		assert.equal(await sourceBadges.count(), 1, "a multi-box marking should have one source badge");
		const badge = await sourceBadges.first().evaluate((element) => {
			const badgeRect = element.getBoundingClientRect();
			const boxRect = element.parentElement?.getBoundingClientRect();
			const boxes = Array.from(element.closest("[data-pdf-annotation]")?.querySelectorAll("[data-pdf-annotation-box]") ?? []);
			return {
				text: element.textContent,
				title: element.getAttribute("title"),
				display: getComputedStyle(element).display,
				boxIndex: element.parentElement === null ? -1 : boxes.indexOf(element.parentElement),
				leftOffset: boxRect === undefined ? Number.NaN : badgeRect.left - boxRect.left,
				bottomGap: boxRect === undefined ? Number.NaN : boxRect.top - badgeRect.bottom,
			};
		});
		assert.equal(badge.text, "this-is-a-very-long-source-name.tex:12–15");
		assert.equal(badge.title, "this-is-a-very-long-source-name.tex:12–15");
		assert.notEqual(badge.display, "none", "the selected marking should show its source badge");
		assert.equal(badge.boxIndex, 0, "the badge should attach to the top-left annotation box");
		assert.ok(Math.abs(badge.leftOffset) < 1 && badge.bottomGap >= 1, "source badge should sit above the annotation box without covering it");

		await page.locator("#viewer .page[data-page-number='1']").evaluate((element) => {
			element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
		});
		assert.equal(await sourceBadges.first().evaluate((element) => getComputedStyle(element).display), "none", "an unselected marking should hide its source badge");
		await page.locator("[data-pdf-annotation-box]").first().click();
		assert.notEqual(await sourceBadges.first().evaluate((element) => getComputedStyle(element).display), "none", "selecting a marking should reveal its source badge");

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
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1, "identical geometry should reuse the existing annotation");
		assert.equal(await page.locator("[data-pdf-annotation-box]").count(), 1);

		await page.evaluate((source) => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { showSynctexMarker: (message: unknown, options?: unknown) => boolean } }).__hostLwSynctexDebug?.showSynctexMarker({
				type: "synctex_forward",
				pdf_id: 150,
				page: 1,
				x: 360,
				y: 120,
				ranges: [{ page: 1, h: 360, v: 120, W: 28, H: 16 }],
				source_file: source,
				line: 3,
				source_line: "First paragraph text that should wrap a little and create boxes.",
			}, { scroll: false });
		}, sourcePath);
		await page.locator("[data-synctex-marker]").first().evaluate((element) => (element as HTMLElement).click());
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 2, "non-overlapping geometry on the same source line should remain separate annotations");
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
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 2, "overlapping boxes should reuse the existing annotation");
		assert.equal(await page.locator("[data-pdf-annotation-box]").count(), 2);

		await page.locator("[data-pdf-annotation-box]").first().click();
		await page.locator("[data-pdf-annotation][data-pdf-annotation-selected='true'] button[title='Add comment']").click();
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

		assert.equal(await page.locator("[data-pdf-annotation]").count(), 2, "annotations should be visible before a transient page render gap");
		await page.evaluate(() => {
			const application = (window as unknown as { PDFViewerApplication?: { eventBus?: { dispatch: (name: string, payload: unknown) => void }; pdfViewer?: { _pages?: Array<{ viewport?: unknown; __hostSavedViewport?: unknown }> } } }).PDFViewerApplication;
			const pageView = application?.pdfViewer?._pages?.[0];
			if (!application?.eventBus || !pageView?.viewport) throw new Error("missing PDF.js page view");
			pageView.__hostSavedViewport = pageView.viewport;
			pageView.viewport = undefined;
			application.eventBus.dispatch("pagerendered", { source: pageView, pageNumber: 1 });
		});
		await page.waitForTimeout(200);
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 2, "transient PDF.js loading/rendering gaps must not clear visible annotations");
		await page.evaluate(() => {
			const application = (window as unknown as { PDFViewerApplication?: { eventBus?: { dispatch: (name: string, payload: unknown) => void }; pdfViewer?: { _pages?: Array<{ viewport?: unknown; __hostSavedViewport?: unknown }> } } }).PDFViewerApplication;
			const pageView = application?.pdfViewer?._pages?.[0];
			if (!application?.eventBus || !pageView?.__hostSavedViewport) throw new Error("missing saved PDF.js page viewport");
			pageView.viewport = pageView.__hostSavedViewport;
			delete pageView.__hostSavedViewport;
			application.eventBus.dispatch("pagerendered", { source: pageView, pageNumber: 1 });
		});
		await page.waitForTimeout(200);
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 2, "annotations should redraw once PDF.js page geometry is available again");
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
		assert.ok(await page.locator("[data-pdf-annotation]").count() <= 2, "clicking an editable target inside the viewer should not create another annotation");
		const eventsAfterEditableClick = await drainHostMcpEvents(server.origin);
		assert.equal(eventsAfterEditableClick.some((event) => event.type === "pdf_annotation"), false, "editable click should not emit a PDF annotation update");

	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("LaTeX Workshop annotation-mode drag resolves a page-local multi-span box", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-annotation-box-drag-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	let boxRequest: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
	try {
		registry.registerPdf({ pdfId: 157, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 720, height: 500 } });
		await page.route("**/synctex/box", async (route) => {
			boxRequest = { headers: route.request().headers(), body: route.request().postDataJSON() as Record<string, unknown> };
			await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: {
				type: "reverse_synctex_box_result", request_id: boxRequest.body.request_id, pdf_id: 157, page: 1, h: 40, v: 150, W: 100, H: 30,
				source_spans: [{ source_file: sourcePath, start_line: 3, end_line: 3 }, { source_file: sourcePath, start_line: 8, end_line: 10 }],
				ranges: [{ page: 1, h: 40, v: 150, W: 45, H: 30 }, { page: 1, h: 90, v: 150, W: 50, H: 30 }], source_file: sourcePath, line: 3,
			} }) });
		});
		await page.goto(`${server.origin}/viewer-lw/157`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await page.waitForFunction(() => document.body.dataset.hostLwSocket === "connected");
		await page.evaluate(() => {
			type TestWindow = Window & { __hostLwSentSocketMessages?: unknown[] };
			const testWindow = window as TestWindow;
			testWindow.__hostLwSentSocketMessages = [];
			const nativeSend = WebSocket.prototype.send;
			WebSocket.prototype.send = function(data: unknown): void {
				if (typeof data === "string") try { testWindow.__hostLwSentSocketMessages?.push(JSON.parse(data)); } catch {}
				nativeSend.call(this, data as string);
			};
		});
		const pageBox = await page.locator("#viewer .page[data-page-number='1']").boundingBox();
		assert.ok(pageBox, "source page should be visible");
		await page.mouse.move(pageBox.x + 60, pageBox.y + 60);
		await page.mouse.down();
		await page.mouse.move(pageBox.x + 180, pageBox.y + 100, { steps: 4 });
		await page.waitForSelector("[data-pdf-annotation-provisional]", { state: "attached" });
		await page.mouse.up();
		await page.waitForSelector("[data-pdf-annotation-box]", { state: "attached" });
		assert.ok(boxRequest, "drag should request the browser box endpoint");
		assert.equal(boxRequest.headers["x-agent-synctex-viewer-token"]?.length > 0, true);
		assert.deepEqual(Object.keys(boxRequest.body).sort(), ["H", "W", "h", "page", "pdf_id", "pdf_text_spans", "request_id", "type", "v"]);
		assert.ok(Array.isArray(boxRequest.body.pdf_text_spans) && boxRequest.body.pdf_text_spans.length > 0, "drag should include overlapping PDF text spans");
		assert.equal(boxRequest.body.type, "reverse_synctex_box");
		assert.equal(boxRequest.body.page, 1);
		assert.equal(boxRequest.body.pdf_id, 157);
		assert.ok(Number(boxRequest.body.W) > 0 && Number(boxRequest.body.H) > 0);
		assert.equal(await page.locator("[data-pdf-annotation-box]").count(), 1, "returned ranges should fuse into one annotation box");
		const badge = await page.locator("[data-pdf-annotation-source-badge]").evaluate((element) => {
			const badgeRect = element.getBoundingClientRect();
			return { text: element.textContent, width: badgeRect.width, boxWidth: element.parentElement?.getBoundingClientRect().width };
		});
		assert.equal(badge.text, "main.tex:3, main.tex:8–10");
		assert.ok(badge.width <= Number(badge.boxWidth) + 1, "multi-span badge must wrap within its fused annotation box");
		const annotationPayload = await page.evaluate(() => {
			const messages = (window as Window & { __hostLwSentSocketMessages?: Array<{ type?: string }> }).__hostLwSentSocketMessages ?? [];
			return messages.find((message) => message.type === "pdf_annotation");
		}) as { source_spans?: unknown; x?: unknown; y?: unknown } | undefined;
		assert.deepEqual(annotationPayload?.source_spans, [{ source_file: sourcePath, start_line: 3, end_line: 3 }, { source_file: sourcePath, start_line: 8, end_line: 10 }]);
		assert.equal(annotationPayload?.x, 40, "box annotations must send a valid x coordinate");
		assert.equal(annotationPayload?.y, 150, "box annotations must send a valid y coordinate");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("annotation box with no matching source uses the standard SyncTeX warning banner", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-annotation-box-no-match-"));
	const { pdfPath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 158, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage({ viewport: { width: 720, height: 500 } });
		await page.route("**/synctex/box", async (route) => {
			const body = route.request().postDataJSON() as Record<string, unknown>;
			await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: {
				type: "reverse_synctex_box_result", pdf_id: 158, request_id: body.request_id,
				error: "No SyncTeX source boxes in this drag area met the 50% forward-coverage requirement",
			} }) });
		});
		await page.goto(`${server.origin}/viewer-lw/158`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		const pageBox = await page.locator("#viewer .page[data-page-number='1']").boundingBox();
		assert.ok(pageBox);
		await page.mouse.move(pageBox.x + 50, pageBox.y + 50);
		await page.mouse.down();
		await page.mouse.move(pageBox.x + 160, pageBox.y + 95, { steps: 3 });
		await page.mouse.up();
		const banner = page.locator("#hostSynctexCapabilityBanner");
		await banner.waitFor({ state: "visible" });
		assert.match(await banner.textContent() ?? "", /No SyncTeX mapping for this PDF selection/);
		assert.match(await banner.textContent() ?? "", /No SyncTeX source boxes in this drag area/);
		assert.equal(await page.locator("[data-pdf-annotation-no-match-notice]").count(), 0);
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 0);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("deselecting then editing a comment bubble preserves its DOM and never probes the PDF", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-lw-deselected-comment-"));
	const { pdfPath, sourcePath } = writeBrowserSynctexFixture(baseDir);
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		registry.registerPdf({ pdfId: 156, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath), workspaceCwd: baseDir });
		await server.start();
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/viewer-lw/156`, { waitUntil: "domcontentloaded" });
		await waitForLwPageReady(page);
		await page.waitForFunction(() => document.body.dataset.hostLwSocket === "connected", undefined, { timeout: 5_000 });

		await page.evaluate((source) => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { showSynctexMarker: (message: unknown, options?: unknown) => boolean } }).__hostLwSynctexDebug?.showSynctexMarker({
				type: "synctex_forward",
				pdf_id: 156,
				page: 1,
				x: 120,
				y: 70,
				width: 24,
				height: 14,
				source_file: source,
				line: 3,
				source_line: "First paragraph text that should wrap a little and create boxes.",
			}, { scroll: false });
		}, sourcePath);
		await page.locator("[data-synctex-marker]").first().click();
		await page.locator("[data-pdf-annotation-box]").first().click();
		await page.locator("button[title='Add comment']").click();
		const textarea = page.locator("[data-pdf-annotation-bubble] textarea");
		await textarea.fill("Existing comment.");

		await page.evaluate(() => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { setHoverEnabled: (enabled: boolean) => void } }).__hostLwSynctexDebug?.setHoverEnabled(false);
		});
		await page.locator("#viewer .page[data-page-number='1']").click({ position: { x: 4, y: 4 } });
		await page.waitForFunction(() => document.querySelector("[data-pdf-annotation]")?.getAttribute("data-pdf-annotation-selected") === "false");
		await page.evaluate(() => {
			(globalThis as typeof globalThis & { __hostLwSynctexDebug?: { setHoverEnabled: (enabled: boolean) => void } }).__hostLwSynctexDebug?.setHoverEnabled(true);
			type TestWindow = Window & { __hostLwCommentTextarea?: HTMLTextAreaElement; __hostLwSentSocketMessages?: unknown[] };
			const testWindow = window as TestWindow;
			const originalTextarea = document.querySelector("[data-pdf-annotation-bubble] textarea");
			if (!(originalTextarea instanceof HTMLTextAreaElement)) throw new Error("missing comment textarea");
			testWindow.__hostLwCommentTextarea = originalTextarea;
			testWindow.__hostLwSentSocketMessages = [];
			const websocketPrototype = WebSocket.prototype as unknown as { send: (this: WebSocket, data: unknown) => void };
			const nativeSend = websocketPrototype.send;
			websocketPrototype.send = function(this: WebSocket, data: unknown): void {
				if (typeof data === "string") {
					try { testWindow.__hostLwSentSocketMessages?.push(JSON.parse(data)); } catch {}
				}
				nativeSend.call(this, data);
			};
		});

		await textarea.click();
		await page.waitForTimeout(150);
		const outcome = await page.evaluate(() => {
			type TestWindow = Window & { __hostLwCommentTextarea?: HTMLTextAreaElement; __hostLwSentSocketMessages?: Array<{ type?: string }> };
			const testWindow = window as TestWindow;
			const currentTextarea = document.querySelector("[data-pdf-annotation-bubble] textarea");
			return {
				sameTextarea: currentTextarea === testWindow.__hostLwCommentTextarea,
				focused: document.activeElement === testWindow.__hostLwCommentTextarea,
				selected: document.querySelector("[data-pdf-annotation]")?.getAttribute("data-pdf-annotation-selected"),
				annotationCount: document.querySelectorAll("[data-pdf-annotation]").length,
				probeTypes: (testWindow.__hostLwSentSocketMessages ?? []).map((message) => message.type).filter((type) => type === "reverse_synctex" || type === "reverse_synctex_forward_probe"),
			};
		});
		assert.deepEqual(outcome, {
			sameTextarea: true,
			focused: true,
			selected: "true",
			annotationCount: 1,
			probeTypes: [],
		});
		await textarea.fill("Edited after deselection.");
		assert.equal(await page.locator("[data-pdf-annotation]").count(), 1);
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

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page, type Request, type Response } from "playwright";
import { PdfJsViewerMcpService, type BrowserLauncher } from "../../src/modules/pdfjs_viewer_mcp_service.ts";
import { PdfJsViewerRegistry } from "../../src/modules/pdfjs_viewer_registry.ts";

class CapturingBrowserLauncher implements BrowserLauncher {
	readonly urls: string[] = [];
	async open(url: string): ReturnType<BrowserLauncher["open"]> {
		this.urls.push(url);
		return { ok: true, command: "captured-browser" };
	}
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
	const content = "BT\n/F1 18 Tf\n36 150 Td\n(Headless PDF.js render test) Tj\nET\n";
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
			const status = document.body.dataset.hostLastError ?? document.getElementById("loadingBar")?.textContent ?? "";
			const canvas = document.querySelector("#viewer .page[data-page-number='1'] canvas") as HTMLCanvasElement | null;
			const rendered = !!canvas && canvas.width > 0 && canvas.height > 0;
			const failed = /unable|failed|error/i.test(status);
			return { rendered, failed, status };
		});
		status = state.status;
		if (state.rendered || state.failed) return { rendered: state.rendered, status, timedOut: false };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return { rendered: false, status, timedOut: true };
}

test("PDF.js MCP viewer renders a registered PDF in a real browser", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pdfjs-browser-viewer-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFileSync(pdfPath, makeOnePagePdf());
	const launcher = new CapturingBrowserLauncher();
	const registry = new PdfJsViewerRegistry({ makePdfId: () => 101 });
	const service = new PdfJsViewerMcpService({
		browserLauncher: launcher,
		registry,
		pdfRefresh: { autoStart: false },
	});
	let browser: Browser | undefined;
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];
	const failedRequests: string[] = [];
	try {
		const open = await service.openPdf({
			protocol_version: 1,
			request_id: "browser-render-open",
			operation: "open_pdf",
			created_at_ns: 1,
			workspace_context: { cwd: baseDir },
			details: { pdf_path: pdfPath },
		});
		assert.equal(open.status, "ok");
		const viewerUrl = open.status_details.viewer_url;
		assert.equal(viewerUrl, launcher.urls[0]);
		assert.match(viewerUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/viewer-lw\/101$/);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
		page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`));
		page.on("requestfailed", (request: Request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "request failed"}`));
		page.on("response", (response: Response) => {
			if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(viewerUrl!, { waitUntil: "domcontentloaded" });
		const outcome = await waitForViewerOutcome(page);
		assert.equal(outcome.rendered, true, `viewer did not render first page; timedOut=${outcome.timedOut}; status=${JSON.stringify(outcome.status)}\n${summarizeFailures(consoleMessages, pageErrors, failedRequests)}`);
		await assert.doesNotReject(async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (registry.clientCount(101) === 1) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(registry.clientCount(101), 1);
		});

		assert.equal(registry.sendToClients(101, JSON.stringify({
			type: "synctex_forward",
			pdf_id: 101,
			page: 1,
			x: 20,
			y: 30,
			ranges: [{ page: 1, h: 20, v: 30, W: 140, H: 0 }],
			source_file: join(baseDir, "main.tex"),
			line: 17,
		})), 1);
		await page.waitForFunction(() => document.querySelectorAll("[data-synctex-marker='rect']").length === 1, undefined, { timeout: 2_000 });
		const markers = await page.locator("[data-synctex-marker]").evaluateAll((elements) => elements.map((element) => {
			const marker = element as HTMLElement;
			return {
				width: Number.parseFloat(marker.style.width),
				height: Number.parseFloat(marker.style.height),
				border: marker.style.border,
				background: marker.style.background,
			};
		}));
		assert.equal(markers.length, 1, "PDF.js viewer zero-height native rectangle should render exactly one marker");
		const marker = markers[0];
		assert.ok(marker, "PDF.js viewer zero-height native rectangle marker should exist");
		assert.ok(marker.width > 0, "PDF.js viewer zero-height native rectangle should keep a visible row width");
		assert.ok(marker.height >= 1, "PDF.js viewer zero-height native rectangle should use a minimum visible fallback height");
		assert.equal(marker.border, "", "PDF.js viewer zero-height native rectangle should not draw a red border");
		assert.notEqual(marker.background, "", "PDF.js viewer zero-height native rectangle should keep a background highlight");
	} finally {
		await browser?.close();
		await service.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

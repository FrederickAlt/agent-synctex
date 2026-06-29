import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page, type Request, type Response } from "playwright";
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
	const content = "BT\n/F1 18 Tf\n36 150 Td\n(Host-served Viewer Client render test) Tj\nET\n";
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

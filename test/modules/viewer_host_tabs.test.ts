import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page, type Request, type Response } from "playwright";
import { ViewerHostControlClient } from "../../src/modules/viewer_host_control_client.ts";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { ViewerHostServer } from "../../src/modules/viewer_host_server.ts";

function writeFakePdf(path: string, body = "body"): void {
	writeFileSync(path, `%PDF-1.4\n${body}\n%%EOF\n`);
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

async function waitForActivePdf(page: Page, pdfId: number): Promise<void> {
	await page.waitForFunction((expectedPdfId) => {
		const active = document.querySelector("[data-active-pdf-id]")?.getAttribute("data-active-pdf-id");
		const tab = document.querySelector(`[role='tab'][data-pdf-id='${expectedPdfId}'][aria-selected='true']`);
		const iframe = document.querySelector(`iframe[data-pdf-id='${expectedPdfId}']`);
		return active === String(expectedPdfId) && !!tab && !!iframe;
	}, pdfId);
}

async function tabState(page: Page): Promise<{ tabs: string[]; iframes: string[]; active: string | null; emptyVisible: boolean }> {
	return await page.evaluate(() => ({
		tabs: Array.from(document.querySelectorAll("[role='tab'][data-pdf-id]"), (element) => element.getAttribute("data-pdf-id") ?? ""),
		iframes: Array.from(document.querySelectorAll("iframe[data-pdf-id]"), (element) => element.getAttribute("data-pdf-id") ?? ""),
		active: document.querySelector("[data-active-pdf-id]")?.getAttribute("data-active-pdf-id") ?? null,
		emptyVisible: !document.getElementById("empty-state")?.hasAttribute("hidden"),
	}));
}

async function iframeSrc(page: Page, pdfId: number): Promise<string | null> {
	return await page.evaluate((expectedPdfId) => (document.querySelector(`iframe[data-pdf-id='${expectedPdfId}']`) as HTMLIFrameElement | null)?.getAttribute("src") ?? null, pdfId);
}

async function waitForAppEvents(page: Page): Promise<void> {
	await page.waitForFunction(() => document.body.getAttribute("data-app-events") === "connected");
}

type AppEventMessage = Record<string, unknown>;

async function readAppEventSnapshot(origin: string, count = 2): Promise<AppEventMessage[]> {
	const controller = new AbortController();
	const response = await fetch(`${origin}/app-events`, { signal: controller.signal });
	assert.equal(response.status, 200);
	assert.ok(response.body);
	const reader = response.body.getReader();
	let buffer = "";
	const messages: AppEventMessage[] = [];
	try {
		while (messages.length < count) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += Buffer.from(value).toString("utf8");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data: "));
				if (dataLine) messages.push(JSON.parse(dataLine.slice("data: ".length)) as AppEventMessage);
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		controller.abort();
		reader.releaseLock();
	}
	return messages;
}

test("Viewer Client opens a tab for a PDF that was opened before the app event stream connected", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tabs-late-connect-"));
	const pdfPath = join(baseDir, "first.pdf");
	writeFakePdf(pdfPath, "first");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 7, pdf_path: pdfPath, title: "Already open" })).ok, true);

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });

		await waitForActivePdf(page, 7);
		assert.deepEqual(await tabState(page), { tabs: ["7"], iframes: ["7"], active: "7", emptyVisible: false });
		assert.equal(await iframeSrc(page, 7), "/viewer-lw/7?revision=1");
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Client reloads an existing tab when re-opening the same visible pdf_id with a bumped revision", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tabs-revision-"));
	const pdfPath = join(baseDir, "first.pdf");
	writeFakePdf(pdfPath, "first");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });
		await waitForAppEvents(page);

		assert.equal((await client.send({ type: "open_pdf", pdf_id: 9, pdf_path: pdfPath, title: "First" })).ok, true);
		await waitForActivePdf(page, 9);
		assert.equal(await iframeSrc(page, 9), "/viewer-lw/9?revision=1");
		const firstIframeToken = await page.evaluate(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='9']") as HTMLIFrameElement & { testToken?: string };
			iframe.testToken = "same-visible-iframe";
			return iframe.testToken;
		});

		writeFakePdf(pdfPath, "changed body with different size");
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 9, pdf_path: pdfPath, title: "First v2" })).ok, true);
		await page.waitForFunction(() => (document.querySelector("iframe[data-pdf-id='9']") as HTMLIFrameElement | null)?.getAttribute("src") === "/viewer-lw/9?revision=2");

		assert.deepEqual(await tabState(page), { tabs: ["9"], iframes: ["9"], active: "9", emptyVisible: false });
		assert.equal(await page.evaluate(() => (document.querySelector("iframe[data-pdf-id='9']") as HTMLIFrameElement & { testToken?: string })?.testToken), firstIframeToken);
		assert.match(await page.locator("[role='tab'][data-pdf-id='9']").innerText(), /First v2/);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host ignores stale tab-close notifications from an older revision", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tabs-stale-close-"));
	const pdfPath = join(baseDir, "first.pdf");
	writeFakePdf(pdfPath, "first");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 11, pdf_path: pdfPath, title: "First" })).ok, true);
		writeFakePdf(pdfPath, "changed body with different size");
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 11, pdf_path: pdfPath, title: "First v2" })).ok, true);
		assert.equal(registry.getPdf(11).revision, 2);

		const staleClose = await fetch(`${server.origin}/app-tab-closed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pdf_id: 11, revision: 1, viewer_url: "/viewer-lw/11?revision=1", visible_tab_token: "old-revision-token" }),
		});
		assert.equal(staleClose.status, 200);
		assert.deepEqual(await staleClose.json(), { ok: true });

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });

		await waitForActivePdf(page, 11);
		assert.deepEqual(await tabState(page), { tabs: ["11"], iframes: ["11"], active: "11", emptyVisible: false });
		assert.equal(await iframeSrc(page, 11), "/viewer-lw/11?revision=2");
		assert.equal(registry.getPdf(11).revision, 2);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Viewer Host ignores stale same-revision tab-close notifications from an older visible tab token", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tabs-stale-token-"));
	const pdfPath = join(baseDir, "first.pdf");
	writeFakePdf(pdfPath, "first");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 1, pdf_path: pdfPath, title: "First" })).ok, true);
		const firstSnapshot = await readAppEventSnapshot(server.origin);
		const firstTab = firstSnapshot.find((message) => message.type === "open_pdf");
		assert.ok(firstTab);
		const staleToken = typeof firstTab.visible_tab_token === "string" ? firstTab.visible_tab_token : "legacy-token-a";

		assert.equal((await client.send({ type: "focus_pdf", pdf_id: 1 })).ok, true);
		const secondSnapshot = await readAppEventSnapshot(server.origin);
		const currentTab = secondSnapshot.find((message) => message.type === "focus_pdf" || message.type === "open_pdf");
		assert.ok(currentTab);
		assert.equal(typeof currentTab.visible_tab_token, "string");
		assert.notEqual(currentTab.visible_tab_token, staleToken);

		const staleClose = await fetch(`${server.origin}/app-tab-closed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pdf_id: 1, revision: 1, viewer_url: "/viewer-lw/1?revision=1", visible_tab_token: staleToken }),
		});
		assert.equal(staleClose.status, 200);
		assert.deepEqual(await staleClose.json(), { ok: true });

		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		await page.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });

		await waitForActivePdf(page, 1);
		assert.deepEqual(await tabState(page), { tabs: ["1"], iframes: ["1"], active: "1", emptyVisible: false });
		assert.equal(await iframeSrc(page, 1), "/viewer-lw/1?revision=1");
		assert.equal(registry.getPdf(1).revision, 1);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("/viewer-lw redirects to the last selected Host PDF tab and serves empty shell with no tabs", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-active-direct-route-"));
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	writeFakePdf(firstPdf, "first");
	writeFakePdf(secondPdf, "second");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		const empty = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(empty.status, 200);
		assert.match(empty.headers.get("content-type") ?? "", /text\/html/);
		assert.doesNotMatch(await empty.text(), /data-config-url=/);
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 1, pdf_path: firstPdf, title: "First" })).ok, true);
		assert.equal((await client.send({ type: "open_pdf", pdf_id: 2, pdf_path: secondPdf, title: "Second" })).ok, true);
		let response = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "/viewer-lw/2");
		const select = await fetch(`${server.origin}/app-tab-selected`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pdf_id: 1 }),
		});
		assert.equal(select.status, 200);
		response = await fetch(`${server.origin}/viewer-lw`, { redirect: "manual" });
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "/viewer-lw/1");
		const replay = await readAppEventSnapshot(server.origin, 3);
		assert.deepEqual(replay.filter((event) => event.type === "open_pdf").map((event) => event.pdf_id), [1, 2]);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});


test("Viewer Client tab shell opens, focuses, closes, and reopens Host-registered PDFs without unregistering them", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "viewer-host-tabs-"));
	const firstPdf = join(baseDir, "first.pdf");
	const secondPdf = join(baseDir, "second.pdf");
	writeFakePdf(firstPdf, "first");
	writeFakePdf(secondPdf, "second");
	const registry = new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry });
	let browser: Browser | undefined;
	const failedRequests: string[] = [];
	try {
		await server.start();
		const client = new ViewerHostControlClient({ origin: server.origin });
		browser = await chromium.launch({ headless: true, executablePath: projectLocalChromiumExecutable() });
		const page = await browser.newPage();
		page.on("request", (request: Request) => {
			assert.doesNotMatch(request.url(), /close_pdf|unregister/i, `tab UI must not call close/unregister routes: ${request.method()} ${request.url()}`);
		});
		page.on("response", (response: Response) => {
			if (response.status() >= 400 && !/\/assets\/viewer\.js|\/viewer-lw\/|\/config\/|\/pdf\//.test(response.url())) failedRequests.push(`${response.status()} ${response.url()}`);
		});
		await page.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });
		await waitForAppEvents(page);
		assert.deepEqual(await tabState(page), { tabs: [], iframes: [], active: null, emptyVisible: true });

		assert.equal((await client.send({ type: "open_pdf", pdf_id: 1, pdf_path: firstPdf, title: "First" })).ok, true);
		await waitForActivePdf(page, 1);
		assert.deepEqual(await tabState(page), { tabs: ["1"], iframes: ["1"], active: "1", emptyVisible: false });
		const firstIframeToken = await page.evaluate(() => {
			const iframe = document.querySelector("iframe[data-pdf-id='1']") as HTMLIFrameElement & { testToken?: string };
			iframe.testToken = "first-viewer-instance";
			return iframe.testToken;
		});

		assert.equal((await client.send({ type: "open_pdf", pdf_id: 2, pdf_path: secondPdf, title: "Second" })).ok, true);
		await waitForActivePdf(page, 2);
		assert.deepEqual(await tabState(page), { tabs: ["1", "2"], iframes: ["1", "2"], active: "2", emptyVisible: false });
		const activeSecondFrame = page.frameLocator("iframe[data-pdf-id='2']");
		await activeSecondFrame.locator("button.hostPdfTabButton[data-pdf-id='2']").click();
		await activeSecondFrame.locator("input.hostPdfTabRenameInput").fill("Second custom title");
		await activeSecondFrame.locator("input.hostPdfTabRenameInput").press("Enter");
		await page.waitForFunction(() => localStorage.getItem("agent-synctex.pdfTabTitles")?.includes("Second custom title"));

		assert.equal((await client.send({ type: "open_pdf", pdf_id: 1, pdf_path: firstPdf, title: "First renamed" })).ok, true);
		await waitForActivePdf(page, 1);
		assert.deepEqual(await tabState(page), { tabs: ["1", "2"], iframes: ["1", "2"], active: "1", emptyVisible: false });
		assert.equal(await page.evaluate(() => (document.querySelector("iframe[data-pdf-id='1']") as HTMLIFrameElement & { testToken?: string })?.testToken), firstIframeToken);
		assert.match(await page.locator("[role='tab'][data-pdf-id='1']").innerText(), /First renamed/);

		await page.evaluate(() => localStorage.setItem("agent-synctex.pdfAnnotations", JSON.stringify({ "1": [{ id: "a1" }], "2": [{ id: "a2" }] })));
		const firstClose = page.waitForResponse((response) => response.url() === `${server.origin}/app-tab-closed` && response.status() === 200);
		await page.frameLocator("iframe[data-pdf-id='1']").locator("button[data-close-pdf-id='1']").click();
		await firstClose;
		await page.waitForFunction(() => !document.querySelector("[role='tab'][data-pdf-id='1']") && !document.querySelector("iframe[data-pdf-id='1']"));
		assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("agent-synctex.pdfAnnotations") ?? "{}")), { "2": [{ id: "a2" }] });
		assert.deepEqual(await tabState(page), { tabs: ["2"], iframes: ["2"], active: "2", emptyVisible: false });
		assert.equal(registry.getPdf(1).pdfPath, firstPdf);
		assert.equal(registry.getPdf(2).pdfPath, secondPdf);

		const secondClose = page.waitForResponse((response) => response.url() === `${server.origin}/app-tab-closed` && response.status() === 200);
		await page.frameLocator("iframe[data-pdf-id='2']").locator("button[data-close-pdf-id='2']").click();
		await secondClose;
		await page.waitForFunction(() => document.querySelectorAll("[role='tab'][data-pdf-id]").length === 0 && !document.getElementById("empty-state")?.hasAttribute("hidden"));
		assert.deepEqual(await tabState(page), { tabs: [], iframes: [], active: null, emptyVisible: true });
		assert.equal(registry.listPdfs().length, 2);

		const freshPage = await browser.newPage();
		try {
			await freshPage.goto(`${server.origin}/app`, { waitUntil: "domcontentloaded" });
			await waitForAppEvents(freshPage);
			assert.deepEqual(await tabState(freshPage), { tabs: [], iframes: [], active: null, emptyVisible: true });
			await freshPage.goto(`${server.origin}/viewer-lw`, { waitUntil: "domcontentloaded" });
			await freshPage.waitForSelector("#viewerContainer");
			assert.equal(await freshPage.evaluate(() => document.body.dataset.configUrl ?? ""), "");
			assert.equal(await freshPage.locator("text=no active PDF").count(), 0);
		} finally {
			await freshPage.close();
		}

		assert.equal((await client.send({ type: "focus_pdf", pdf_id: 1 })).ok, true);
		await waitForActivePdf(page, 1);
		assert.deepEqual(await tabState(page), { tabs: ["1"], iframes: ["1"], active: "1", emptyVisible: false });
		assert.deepEqual(failedRequests, []);
	} finally {
		await browser?.close();
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
});

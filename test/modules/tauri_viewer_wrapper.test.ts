import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ViewerHostPdfRegistry } from "../../src/modules/viewer_host_registry.ts";
import { startDesktopViewerHostForDesktopWrapper } from "../../src/modules/tauri_viewer_wrapper.ts";

function writeFakePdf(path: string): void {
	writeFileSync(path, Buffer.from("%PDF-1.4\nwrapper render fixture\n%%EOF\n", "utf8"));
}

function snapshotPdf(path: string): { size: number; mtimeMs: number } {
	const status = statSync(path);
	return { size: status.size, mtimeMs: status.mtimeMs };
}

async function readHttp(url: string): Promise<{ status: number; body: string }> {
	const response = await fetch(url);
	return { status: response.status, body: await response.text() };
}

async function assertPortCanBeRebound(port: number): Promise<void> {
	const server = createServer((_request, response) => response.end("ok"));
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port }, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

test("desktop wrapper launcher starts the Viewer Host Server without Tauri APIs and releases its port on shutdown", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "tauri-wrapper-host-"));
	const pdfPath = join(baseDir, "paper.pdf");
	writeFakePdf(pdfPath);
	const registry = new ViewerHostPdfRegistry();
	const launched = await startDesktopViewerHostForDesktopWrapper({ registry });
	try {
		assert.equal(launched.origin.startsWith("http://127.0.0.1:"), true);
		assert.equal(launched.appUrl, `${launched.origin}/app`);
		registry.registerPdf({ pdfId: 114, pdfPath, title: "paper.pdf", revision: 1, fileSnapshot: snapshotPdf(pdfPath) });

		const app = await readHttp(launched.appUrl);
		assert.equal(app.status, 200);
		assert.match(app.body, /Viewer Client/i);

		const viewer = await readHttp(`${launched.origin}/viewer/114`);
		assert.equal(viewer.status, 200);
		assert.match(viewer.body, /PDF\.js viewer/i);
	} finally {
		await launched.shutdown();
		rmSync(baseDir, { recursive: true, force: true });
	}
	await assertPortCanBeRebound(launched.address.port);
});

test("Tauri desktop bundle is a thin wrapper that loads Host-served /app and documents platform scope", () => {
	const root = "apps/viewer-desktop-tauri";
	const configPath = join(root, "src-tauri", "tauri.conf.json");
	const cargoPath = join(root, "src-tauri", "Cargo.toml");
	const mainPath = join(root, "src-tauri", "src", "main.rs");
	const readmePath = join(root, "README.md");

	for (const path of [configPath, cargoPath, mainPath, readmePath]) {
		assert.equal(existsSync(path), true, `${path} should exist`);
	}

	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		bundle?: { targets?: string[] };
		app?: { windows?: unknown[] };
	};
	assert.deepEqual(config.app?.windows, [], "Tauri must not load a direct bundled UI window before the Host Server origin is known");
	assert.ok(config.bundle?.targets?.includes("app"), "macOS .app build target should exist");
	assert.ok(config.bundle?.targets?.includes("dmg"), "macOS dmg build target should exist");
	assert.ok(config.bundle?.targets?.includes("deb"), "Linux deb build target should exist");
	assert.ok(config.bundle?.targets?.includes("appimage"), "Linux AppImage build target should exist");

	const cargo = readFileSync(cargoPath, "utf8");
	const libRsPath = join(root, "src-tauri", "src", "lib.rs");
	assert.ok(existsSync(join(root, "src-tauri", "src", "main.rs")), "binary main.rs should exist");
	assert.ok(!/^\[lib\]$/m.test(cargo) || existsSync(libRsPath), "Cargo.toml must not declare a missing lib target");

	const main = readFileSync(mainPath, "utf8");
	assert.match(main, /PDF_PREVIEW_VIEWER_HOST_COMMAND/);
	assert.match(main, /PDF_PREVIEW_VIEWER_HOST_ARGS/);
	assert.match(main, /\/app/);
	assert.match(main, /shutdown/);
	assert.match(main, /debug_assertions/, "repo-relative node script fallback must be limited to development/debug builds");
	assert.match(main, /PDF_PREVIEW_VIEWER_HOST_COMMAND is required for packaged builds/, "packaged builds must fail clearly without an external host command");
	assert.match(main, /fn validate_host_app_url\(/, "host-reported app_url must be validated before loading the Tauri window");
	assert.match(main, /url\.scheme\(\) != "http"/, "host app_url validation must reject https and other schemes");
	assert.match(main, /url\.host_str\(\) != Some\("127\.0\.0\.1"\)/, "host app_url validation must reject non-loopback hosts");
	assert.match(main, /url\.port\(\)\.is_none\(\)/, "host app_url validation must reject missing ports");
	assert.match(main, /url\.path\(\) != "\/app"/, "host app_url validation must reject non-/app paths");
	assert.match(main, /url\.username\(\)\.is_empty\(\)/, "host app_url validation must reject userinfo usernames");
	assert.match(main, /url\.password\(\)\.is_some\(\)/, "host app_url validation must reject userinfo passwords");
	for (const testCase of [
		"http://127.0.0.1:1234/app",
		"https://127.0.0.1:1234/app",
		"http://example.com:1234/app",
		"http://localhost:1234/app",
		"http://[::1]:1234/app",
		"http://127.0.0.1/app",
		"http://127.0.0.1:0/app",
		"http://127.0.0.1:1234/viewer",
		"http://127.0.0.1:1234/app?x=1",
		"http://127.0.0.1:1234/app#fragment",
		"http://user@127.0.0.1:1234/app",
		"http://user:pass@127.0.0.1:1234/app",
		"http://:pass@127.0.0.1:1234/app",
	]) {
		assert.match(main, new RegExp(testCase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Rust validate_host_app_url tests should include ${testCase}`);
	}
	assert.doesNotMatch(main, /fn host_command\(\)[\s\S]*unwrap_or_else\(\|_\|\s*"node"/, "packaged builds must not silently default to node");
	assert.doesNotMatch(main, /register_pdf|pdf_bytes|synctex_forward|pdf_refresh/i, "Tauri wrapper must not implement Host Server business logic");

	const readme = readFileSync(readmePath, "utf8");
	assert.match(readme, /macOS/i);
	assert.match(readme, /Linux/i);
	assert.match(readme, /Windows best-effort/i);
	assert.match(readme, /PDF_PREVIEW_VIEWER_HOST_COMMAND.*required.*packaged/i, "README must document packaged external-host contract");
	assert.match(readme, /http:\/\/127\.0\.0\.1:<non-zero-port>\/app/, "README must document the strict loopback app_url contract");
	assert.match(readme, /PDF_PREVIEW_VIEWER_HOST_ARGS.*split on .*whitespace/i, "README must document the v1 host args splitting limitation");
});

test("Viewer Host Server modules stay separable from Tauri APIs", () => {
	for (const path of [
		"src/modules/viewer_host_server.ts",
		"src/modules/viewer_host_client.ts",
		"src/modules/viewer_host_control_client.ts",
		"src/modules/viewer_host_registry.ts",
		"src/modules/viewer_host_protocol.ts",
	]) {
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(source, /@tauri-apps|__TAURI__|tauri::/i, `${path} must not import or reference Tauri APIs`);
	}
});

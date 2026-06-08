import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLogger } from "../../src/modules/logging.ts";
import { loadPdfPreviewRuntimeConfig } from "../../src/modules/runtime_config.ts";

function temporaryDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(updates)) {
		previous.set(key, process.env[key]);
		const value = updates[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function readJsonlRecords(dir: string): Record<string, unknown>[] {
	const files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
	return files.flatMap((file) => readFileSync(join(dir, file), "utf8")
		.trim()
		.split(/\n+/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>));
}

test("runtime config reads shared home config and supports env overrides", () => {
	const base = temporaryDir("pdf-preview-config-test-");
	try {
		const configPath = join(base, "config.json");
		const configLogDir = join(base, "configured-logs");
		writeFileSync(configPath, JSON.stringify({ logging: { level: "debug", dir: configLogDir } }));

		const fromConfig = loadPdfPreviewRuntimeConfig({
			PDF_PREVIEW_CONFIG: configPath,
		} as NodeJS.ProcessEnv);
		assert.equal(fromConfig.configPath, configPath);
		assert.equal(fromConfig.logging.level, "debug");
		assert.equal(fromConfig.logging.dir, configLogDir);

		const fromEnv = loadPdfPreviewRuntimeConfig({
			PDF_PREVIEW_CONFIG: configPath,
			PDF_PREVIEW_LOG_LEVEL: "error",
			PDF_PREVIEW_LOG_DIR: join(base, "env-logs"),
		} as NodeJS.ProcessEnv);
		assert.equal(fromEnv.logging.level, "error");
		assert.equal(fromEnv.logging.dir, join(base, "env-logs"));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("logger writes JSONL using shared config and redacts sensitive fields", () => {
	const base = temporaryDir("pdf-preview-logging-test-");
	try {
		const configPath = join(base, "config.json");
		const logDir = join(base, "logs");
		writeFileSync(configPath, JSON.stringify({ logging: { level: "debug", dir: logDir } }));

		withEnv({ PDF_PREVIEW_CONFIG: configPath, PDF_PREVIEW_LOG_LEVEL: undefined, PDF_PREVIEW_LOG_DIR: undefined }, () => {
			const logger = createLogger("test.logger");
			logger.debug("event.name", {
				visible: "value",
				latex_source: "secret latex",
				callback: { token: "secret-token", socket_path: "/tmp/callback.sock" },
				nested: { source_line: "secret source line" },
			});
		});

		const records = readJsonlRecords(logDir);
		assert.equal(records.length, 1);
		const record = records[0];
		assert.equal(record.level, "debug");
		assert.equal(record.component, "test.logger");
		assert.equal(record.event, "event.name");
		assert.equal(record.visible, "value");
		assert.equal(record.latex_source, "[redacted]");
		assert.equal(record.callback, "[redacted]");
		assert.deepEqual(record.nested, { source_line: "[redacted]" });
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("logger defaults to off without shared config or env overrides", () => {
	const base = temporaryDir("pdf-preview-logging-default-test-");
	try {
		const configHome = join(base, "config");
		const stateHome = join(base, "state");
		withEnv({
			XDG_CONFIG_HOME: configHome,
			XDG_STATE_HOME: stateHome,
			PDF_PREVIEW_CONFIG: undefined,
			PDF_PREVIEW_LOG_LEVEL: undefined,
			PDF_PREVIEW_LOG_DIR: undefined,
		}, () => {
			const logger = createLogger("test.default");
			logger.error("error.skipped");
		});

		const logDir = join(stateHome, "pi-pdf-preview", "logs");
		assert.equal(existsSync(logDir), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

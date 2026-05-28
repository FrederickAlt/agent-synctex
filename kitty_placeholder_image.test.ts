import test from "node:test";
import assert from "node:assert/strict";
import {
	buildKittyPlaceholderImageRender,
	KittyPreviewInvalidationRegistry,
	kittyPlaceholderCell,
	kittyPlaceholderLine,
	kittyTransmitVirtualPlacementCommand,
	renderKittyPlaceholderImageLines,
	wrapKittySequenceForTmux,
} from "./kitty_placeholder_image.ts";
import { KittyPlaceholderOracle } from "./kitty_placeholder_oracle.ts";

const PNG_BASE64 = "iVBORw0KGgo=";

test("kitty placeholder cells encode image id color plus row and column diacritics", () => {
	assert.equal(kittyPlaceholderCell(0x123456, 1, 2), "\x1b[38;2;18;52;86m\u{10EEEE}\u030d\u030e\x1b[39m");
});

test("kitty placeholder lines encode every column coordinate", () => {
	const line = kittyPlaceholderLine(7, 0, 3);

	assert.match(line, /\u{10EEEE}\u0305\u0305/u);
	assert.match(line, /\u{10EEEE}\u0305\u030d/u);
	assert.match(line, /\u{10EEEE}\u0305\u030e/u);
});

test("renderKittyPlaceholderImageLines creates a valid oracle-checkable placeholder stream", () => {
	const lines = renderKittyPlaceholderImageLines({
		title: "preview",
		base64Data: PNG_BASE64,
		imageId: 42,
		width: 12,
		maxWidthCells: 100,
		imageDimensions: { widthPx: 100, heightPx: 20 },
		cellDimensions: { widthPx: 10, heightPx: 10 },
	});

	const oracle = new KittyPlaceholderOracle(lines.join("\n"), { expectedImageIds: [42] });
	assert.equal(oracle.isValid, true, oracle.summary);
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "preview");
	assert.equal(oracle.commandCount, 1);
	assert.deepEqual(oracle.getCommandImageIds(), [42]);
	assert.equal(oracle.diagnostics.placements.length, 1);
	assert.equal(oracle.diagnostics.placements[0].columns, 10);
	assert.equal(oracle.diagnostics.placements[0].rows, 2);
	assert.equal(oracle.diagnostics.placeholders.length, 20);
	assert.equal(oracle.diagnostics.placements[0].command.wrappedInTmux, true);
	assert.doesNotMatch(lines.join("\n"), /a=p/);
	assert.doesNotMatch(lines.join("\n"), /\x1b\[\d+A/);
});

test("kitty transmit virtual placement command chunks large payloads", () => {
	const command = kittyTransmitVirtualPlacementCommand("a".repeat(5000), 9, 80, 4);

	assert.match(command, /a=T,U=1,f=100,q=2,i=9,c=80,r=4,m=1/);
	assert.match(command, /\x1b_Gm=0;/);

	const oracle = new KittyPlaceholderOracle(command, { requirePlaceholders: false, includeRawOutput: true });
	assert.equal(oracle.isValid, true, oracle.summary);
	assert.equal(oracle.commandCount, 2);
	assert.deepEqual(oracle.getCommandImageIds(), [9]);
});

test("kitty placeholder render does not expose setup commands as focus-refresh payloads", () => {
	const rendered = buildKittyPlaceholderImageRender({
		title: "preview",
		base64Data: PNG_BASE64,
		imageId: 42,
		width: 12,
		maxWidthCells: 100,
		imageDimensions: { widthPx: 100, heightPx: 20 },
		cellDimensions: { widthPx: 10, heightPx: 10 },
	});

	assert.deepEqual(Object.keys(rendered).sort(), ["columns", "lines", "rows"]);
});

test("wrapKittySequenceForTmux escapes nested escape bytes", () => {
	const wrapped = wrapKittySequenceForTmux("\x1b_Ga=t;data\x1b\\");

	assert.equal(wrapped, "\x1bPtmux;\x1b\x1b_Ga=t;data\x1b\x1b\\\x1b\\");
});

test("KittyPlaceholderInvalidationRegistry refreshes recent tool row invalidators", () => {
	const registry = new KittyPreviewInvalidationRegistry(2);
	const calls: string[] = [];

	registry.remember("a", () => calls.push("a"));
	registry.remember("b", () => calls.push("b"));
	registry.remember("a", () => calls.push("a-again"));
	registry.remember("c", () => calls.push("c"));
	registry.refresh();

	assert.equal(registry.size, 2);
	assert.deepEqual(calls, ["a-again", "c"]);

	registry.clear();
	registry.refresh();
	assert.deepEqual(calls, ["a-again", "c"]);
});

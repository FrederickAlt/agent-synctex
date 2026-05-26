import test from "node:test";
import assert from "node:assert/strict";
import {
	KittyImageRefreshRegistry,
	kittyPlaceholderCell,
	kittyPlaceholderLine,
	kittyTransmitVirtualPlacementCommand,
	renderKittyPlaceholderImageLines,
	wrapKittySequenceForTmux,
} from "./kitty_placeholder_image.ts";

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

test("renderKittyPlaceholderImageLines creates the virtual placement while transmitting the image", () => {
	const lines = renderKittyPlaceholderImageLines({
		title: "preview",
		base64Data: PNG_BASE64,
		imageId: 42,
		width: 12,
		maxWidthCells: 100,
		imageDimensions: { widthPx: 100, heightPx: 20 },
		cellDimensions: { widthPx: 10, heightPx: 10 },
	});

	assert.equal(lines.length, 3);
	assert.equal(lines[0], "preview");
	assert.match(lines[1], /a=T,U=1,f=100,q=2,i=42,c=10,r=2/);
	assert.match(lines[1], /\u{10EEEE}\u0305\u0305/u);
	assert.match(lines[2], /\u{10EEEE}\u030d\u0305/u);
	assert.doesNotMatch(lines.join("\n"), /a=p/);
	assert.doesNotMatch(lines.join("\n"), /\x1b\[\d+A/);
});

test("kitty transmit virtual placement command chunks large payloads", () => {
	const command = kittyTransmitVirtualPlacementCommand("a".repeat(5000), 9, 80, 4);

	assert.match(command, /a=T,U=1,f=100,q=2,i=9,c=80,r=4,m=1/);
	assert.match(command, /\x1b_Gm=0;/);
});

test("wrapKittySequenceForTmux escapes nested escape bytes", () => {
	const wrapped = wrapKittySequenceForTmux("\x1b_Ga=t;data\x1b\\");

	assert.equal(wrapped, "\x1bPtmux;\x1b\x1b_Ga=t;data\x1b\x1b\\\x1b\\");
});

test("KittyImageRefreshRegistry refreshes recent image setup sequences without timers", () => {
	const registry = new KittyImageRefreshRegistry(2);
	const writes: string[] = [];

	registry.remember(1, "one");
	registry.remember(2, "two");
	registry.remember(1, "one-again");
	registry.remember(3, "three");
	registry.refresh((sequence) => writes.push(sequence));

	assert.equal(registry.size, 2);
	assert.deepEqual(writes, ["one-againthree"]);

	registry.clear();
	registry.refresh((sequence) => writes.push(sequence));
	assert.deepEqual(writes, ["one-againthree"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
	kittyPlaceholderLine,
	kittyTransmitVirtualPlacementCommand,
	KITTY_PLACEHOLDER,
	wrapKittySequenceForTmux,
} from "./kitty_placeholder_image.ts";
import { KittyPlaceholderOracle } from "./kitty_placeholder_oracle.ts";

const PNG_BASE64 = "iVBORw0KGgo=";

test("kitty placeholder oracle parses tmux passthrough-wrapped Kitty commands", () => {
	const setup = kittyTransmitVirtualPlacementCommand(PNG_BASE64, 7, 4, 1);
	const output = `${wrapKittySequenceForTmux(setup)}${kittyPlaceholderLine(7, 0, 4)}`;

	const oracle = new KittyPlaceholderOracle(output, { includeRawOutput: true });
	assert.equal(oracle.isValid, true, oracle.summary);
	assert.deepEqual(oracle.getCommandImageIds(), [7]);
	assert.equal(oracle.diagnostics.placements.length, 1);
	assert.equal(oracle.diagnostics.placements[0].command.wrappedInTmux, true);
});

test("kitty placeholder oracle flags orphan placeholders", () => {
	const setup = kittyTransmitVirtualPlacementCommand(PNG_BASE64, 10, 2, 1);
	const output = `${setup}${kittyPlaceholderLine(11, 0, 2)}`;
	const oracle = new KittyPlaceholderOracle(output, { includeRawOutput: true });

	assert.equal(oracle.isValid, false);
	assert.deepEqual(oracle.getCommandImageIds(), [10]);
	assert.deepEqual(oracle.getPlaceholderImageIds(), [11]);
	assert.equal(oracle.diagnostics.orphanPlaceholders.length, 2);
	assert.match(oracle.summary, /Orphan placeholder cell references image id 11/);
});

test("kitty placeholder oracle flags coordinates outside declared placement dimensions", () => {
	const setup = kittyTransmitVirtualPlacementCommand(PNG_BASE64, 12, 1, 1);
	const output = `${setup}${kittyPlaceholderLine(12, 0, 2)}`;
	const oracle = new KittyPlaceholderOracle(output);

	assert.equal(oracle.isValid, false);
	assert.match(oracle.summary, /outside declared placement dimensions/);
	assert.match(oracle.summary, /decoded setup image ids: 12/);
});

test("kitty placeholder oracle flags non-decorated coordinates", () => {
	const setup = kittyTransmitVirtualPlacementCommand(PNG_BASE64, 13, 2, 2);
	const invalidPlaceholder = `\x1b[38;2;0;0;13m${KITTY_PLACEHOLDER}ab\x1b[39m`;
	const output = `${setup}${invalidPlaceholder}`;
	const oracle = new KittyPlaceholderOracle(output);

	assert.equal(oracle.isValid, false);
	assert.equal(oracle.diagnostics.invalidCoordinatePlaceholders.length, 1);
	assert.match(oracle.summary, /Invalid placeholder/);
	assert.match(oracle.summary, /outside declared placement dimensions/);
});

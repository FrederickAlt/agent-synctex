import assert from "node:assert/strict";
import { test } from "node:test";

import { extractLatexWarnings } from "../../src/modules/latex/latex_file_compiler.ts";

test("extractLatexWarnings suppresses ignored inputenc warning but preserves useful warnings", () => {
	const result = extractLatexWarnings([
		"Package inputenc Warning: inputenc package ignored with utf8 based engines.",
		"",
		"LaTeX Warning: Reference `foo' on page 1 undefined on input line 12.",
	].join("\n"));

	assert.equal(result.total, 1);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0]?.message ?? "", /Reference `foo'/);
});

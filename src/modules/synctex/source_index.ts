export function lineColumnForSourceIndex(source: string, index: number): { line: number; column: number } {
	let line = 1;
	let column = 0;
	for (let pos = 0; pos < index; pos += 1) {
		const char = source[pos];
		if (char === "\r") {
			if (source[pos + 1] === "\n") pos += 1;
			line += 1;
			column = 0;
		} else if (char === "\n") {
			line += 1;
			column = 0;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

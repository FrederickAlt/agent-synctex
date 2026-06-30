/*
The MIT License (MIT)

Copyright (c) 2016 James Yu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Adapted from LaTeX-Workshop synctex_impl/src/utils/pathnormalize.ts.
*/

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function normalize(filePath: string): string {
	let normPath = path.normalize(filePath);
	if (os.platform() === "win32") {
		// Normalize drive letters on Windows.
		normPath = normPath.replace(/^([a-zA-Z]):/, (_m, p1: string) => p1.toLowerCase() + ":");
	}
	return normPath;
}

export function isSameRealPath(filePathA: string, filePathB: string): boolean {
	const a = normalize(fs.realpathSync(path.normalize(filePathA)));
	const b = normalize(fs.realpathSync(path.normalize(filePathB)));
	return a === b;
}

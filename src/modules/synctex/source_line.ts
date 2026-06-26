import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function resolveSourceFilePath(filePath: string, cwd: string): string {
	return isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
}

export function readSourceLine(filePath: string, line: number, cwd: string): string | undefined {
	if (!Number.isInteger(line) || line < 1) return undefined;
	try {
		const source = readFileSync(resolveSourceFilePath(filePath, cwd), "utf8");
		return source.split(/\r?\n/)[line - 1];
	} catch {
		return undefined;
	}
}

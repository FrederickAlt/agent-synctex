import { constants, accessSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const MACTEX_BIN_DIR = "/Library/TeX/texbin";

export interface ExecutableResolutionOptions {
	platform?: NodeJS.Platform;
	path?: string;
	isExecutable?: (path: string) => boolean;
}

function executableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Find commands on PATH, plus platform installation locations omitted from GUI-app environments. */
export function findExecutable(command: string, options: ExecutableResolutionOptions = {}): string | undefined {
	if (isAbsolute(command) || command.includes("/")) return command;
	const platform = options.platform ?? process.platform;
	const path = options.path ?? process.env.PATH ?? "";
	const isExecutable = options.isExecutable ?? executableFile;
	const directories = path.split(delimiter).filter(Boolean);
	if (platform === "darwin" && !directories.includes(MACTEX_BIN_DIR)) directories.push(MACTEX_BIN_DIR);
	for (const directory of directories) {
		const candidate = join(directory, command);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export function resolveExecutable(command: string, options: ExecutableResolutionOptions = {}): string {
	const resolved = findExecutable(command, options);
	if (resolved === undefined) return command;
	const platform = options.platform ?? process.platform;
	return platform === "darwin" && resolved.startsWith(`${MACTEX_BIN_DIR}/`) ? resolved : command;
}

export function executableSearchPath(options: Pick<ExecutableResolutionOptions, "platform" | "path"> = {}): string {
	const platform = options.platform ?? process.platform;
	const directories = (options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter).filter(Boolean);
	if (platform === "darwin" && !directories.includes(MACTEX_BIN_DIR)) directories.push(MACTEX_BIN_DIR);
	return directories.join(delimiter);
}

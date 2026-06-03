import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getMcpTmpDir } from "./runtime_paths.ts";

export function resolveFixedPreviewPdfPath(rawPath: string): string {
	const resolvedTmpDir = getMcpTmpDir();
	const normalizedCandidate = isAbsolute(rawPath)
		? resolve(rawPath)
		: resolve(resolvedTmpDir, rawPath);
	const normalizedRoot = resolve(resolvedTmpDir);
	const candidateRelative = relative(normalizedRoot, normalizedCandidate);
	if (
		isAbsolute(candidateRelative)
		|| candidateRelative === ""
		|| candidateRelative === ".."
		|| candidateRelative.startsWith("../")
		|| candidateRelative.startsWith(".." + sep)
	) {
		throw new Error("fixed_preview_pdf_path must be inside the host service artifact directory");
	}
	if (normalizedCandidate.includes("\u0000")) {
		throw new Error("fixed_preview_pdf_path contains invalid characters");
	}
	ensureDirectory(dirname(normalizedCandidate));
	if (existsSync(normalizedCandidate)) {
		const stat = lstatSync(normalizedCandidate);
		if (stat.isSymbolicLink()) {
			throw new Error(`fixed_preview_pdf_path must not be a symlink: ${normalizedCandidate}`);
		}
		if (!stat.isFile()) {
			throw new Error(`fixed_preview_pdf_path is not a file: ${normalizedCandidate}`);
		}
	}
	return normalizedCandidate;
}

function ensureDirectory(path: string): void {
	try {
		lstatSync(path);
		assertDirectorySafe(path);
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			mkdirSync(path, { recursive: true, mode: 0o700 });
			chmodSync(path, 0o700);
			assertDirectorySafe(path);
			return;
		}
		throw error;
	}
}

function assertDirectorySafe(path: string): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) {
		throw new Error(`host service path is a symlink: ${path}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`host service path is not a directory: ${path}`);
	}
	if (process.getuid?.() !== undefined && st.uid !== process.getuid()) {
		throw new Error(`host service path is not owned by current user: ${path}`);
	}
	if ((st.mode & 0o777) !== 0o700) {
		throw new Error(`host service path has unsafe mode: ${path}`);
	}
}

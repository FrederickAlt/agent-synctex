import { gunzipSync } from "node:zlib";
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const PDF_HEADER = "%PDF-";

export function assertReadablePdfFile(pdfFilePath: string): void {
	let fileStatus;
	try {
		fileStatus = statSync(pdfFilePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot stat PDF file ${pdfFilePath}: ${message}`);
	}

	if (!fileStatus.isFile()) {
		throw new Error(`pdf_file_path must point to a regular file: ${pdfFilePath}`);
	}

	try {
		accessSync(pdfFilePath, constants.R_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read PDF file ${pdfFilePath}: ${message}`);
	}

	const header = Buffer.alloc(PDF_HEADER.length);
	let fd: number | null = null;
	try {
		fd = openSync(pdfFilePath, "r");
		const bytesRead = readSync(fd, header, 0, header.length, 0);
		if (bytesRead < header.length || header.toString("ascii") !== PDF_HEADER) {
			throw new Error(`pdf_file_path must point to a PDF file: ${pdfFilePath}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("pdf_file_path must point")) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read PDF header ${pdfFilePath}: ${message}`);
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

export function assertReadableSourceFile(sourceFile: string): void {
	let fileStatus;
	try {
		fileStatus = lstatSync(sourceFile);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot stat source_file ${sourceFile}: ${message}`);
	}

	if (fileStatus.isSymbolicLink()) {
		throw new Error(`source_file must not be a symlink: ${sourceFile}`);
	}
	if (!fileStatus.isFile()) {
		throw new Error(`source_file must point to a regular file: ${sourceFile}`);
	}
	const uid = process.getuid?.();
	if (uid === undefined || fileStatus.uid !== uid) {
		throw new Error(`source_file must be owned by current user: ${sourceFile}`);
	}

	try {
		accessSync(sourceFile, constants.R_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read source_file ${sourceFile}: ${message}`);
	}
}

function readableSourceFileOrUndefined(sourceFile: string): string | undefined {
	try {
		const resolvedSourceFile = resolve(sourceFile);
		assertReadableSourceFile(resolvedSourceFile);
		return resolvedSourceFile;
	} catch {
		return undefined;
	}
}

function synctexSidecarPaths(pdfFilePath: string): string[] {
	const parsedPdfPath = pdfFilePath.toLowerCase().endsWith(".pdf")
		? pdfFilePath.slice(0, -4)
		: pdfFilePath;
	return [`${parsedPdfPath}.synctex.gz`, `${parsedPdfPath}.synctex`];
}

function readSynctexSidecar(path: string): string | undefined {
	if (!existsSync(path)) return undefined;

	try {
		const contents = readFileSync(path);
		return path.endsWith(".gz") ? gunzipSync(contents).toString("utf8") : contents.toString("utf8");
	} catch {
		return undefined;
	}
}

function parseSynctexInputRecords(synctexText: string, pdfDirectory: string): string[] {
	const sourceFiles: string[] = [];
	const seen = new Set<string>();
	for (const line of synctexText.split(/\r?\n/)) {
		const inputMatch = /^Input:\d+:(.+)$/.exec(line.trim());
		if (!inputMatch) continue;

		const inputPath = inputMatch[1].trim();
		if (!inputPath || extname(inputPath).toLowerCase() !== ".tex") continue;

		const candidate = readableSourceFileOrUndefined(isAbsolute(inputPath) ? inputPath : resolve(pdfDirectory, inputPath));
		if (!candidate || seen.has(candidate)) continue;

		seen.add(candidate);
		sourceFiles.push(candidate);
	}

	return sourceFiles;
}

function inferSourceFileFromSynctex(pdfFilePath: string): string | undefined {
	const pdfDirectory = dirname(pdfFilePath);
	const pdfBaseName = basename(pdfFilePath, extname(pdfFilePath));
	const inputRecords: string[] = [];
	const seen = new Set<string>();

	for (const sidecarPath of synctexSidecarPaths(pdfFilePath)) {
		const synctexText = readSynctexSidecar(sidecarPath);
		if (!synctexText) continue;

		for (const inputRecord of parseSynctexInputRecords(synctexText, pdfDirectory)) {
			if (seen.has(inputRecord)) continue;
			seen.add(inputRecord);
			inputRecords.push(inputRecord);
		}
	}

	const matchingBasenameRecords = inputRecords.filter((inputRecord) => basename(inputRecord, extname(inputRecord)) === pdfBaseName);
	if (matchingBasenameRecords.length === 1) return matchingBasenameRecords[0];
	if (inputRecords.length === 1) return inputRecords[0];
	return undefined;
}

export function inferDefaultSourceFileForPdf(pdfFilePath: string): string | undefined {
	const sameBasenameSource = readableSourceFileOrUndefined(join(dirname(pdfFilePath), `${basename(pdfFilePath, extname(pdfFilePath))}.tex`));
	if (sameBasenameSource) return sameBasenameSource;

	return inferSourceFileFromSynctex(pdfFilePath);
}

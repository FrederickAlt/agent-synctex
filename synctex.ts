import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface SynctexPasteTarget {
	cwd: string;
	hasUI: boolean;
	ui?: {
		pasteToEditor(text: string): void;
	};
}

export interface SynctexClick {
	file: string;
	line: number;
}

interface SynctexCallbackMessage extends SynctexClick {
	token: string;
}

interface SynctexCallbackServerOptions {
	tmpDir?: string;
	callbackScriptPath: string;
	nodePath?: string;
}

interface SynctexCallbackResponse {
	ok: boolean;
	pasted?: boolean;
	error?: string;
}

const DEFAULT_SYNCTEX_TMPDIR = resolve(tmpdir(), "codex-show-latex");
const SOCKET_NAME_PREFIX = "pi-synctex-";
const ZATHURA_INPUT_PLACEHOLDER = "%{input}";
const ZATHURA_LINE_PLACEHOLDER = "%{line}";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createSynctexCallbackArgv(options: {
	nodePath: string;
	callbackScriptPath: string;
	socketPath: string;
	token: string;
}): string[] {
	return [
		options.nodePath,
		options.callbackScriptPath,
		"--socket",
		options.socketPath,
		"--token",
		options.token,
		"--file",
		ZATHURA_INPUT_PLACEHOLDER,
		"--line",
		ZATHURA_LINE_PLACEHOLDER,
	];
}

function resolveClickedFile(filePath: string, cwd: string): string {
	const trimmed = filePath.trim();
	return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function relativeClickedFilePath(filePath: string, cwd: string): string {
	const absoluteFilePath = resolveClickedFile(filePath, cwd);
	return relative(cwd, absoluteFilePath) || basename(absoluteFilePath);
}

export function readSourceLine(filePath: string, line: number, cwd: string): string | undefined {
	if (!Number.isInteger(line) || line < 1) return undefined;
	try {
		const source = readFileSync(resolveClickedFile(filePath, cwd), "utf8");
		return source.split(/\r?\n/)[line - 1];
	} catch {
		return undefined;
	}
}

export function formatSynctexPasteBlock(click: SynctexClick, cwd: string): string {
	const relativePath = relativeClickedFilePath(click.file, cwd);
	const location = `PDF click: ${relativePath}:${click.line}`;
	const sourceLine = readSourceLine(click.file, click.line, cwd);
	return sourceLine === undefined ? `${location}\n\n` : `${location}\n${sourceLine}\n\n`;
}

export function createSynctexCallbackCommand(options: {
	nodePath: string;
	callbackScriptPath: string;
	socketPath: string;
	token: string;
}): string {
	// Zathura parses this command into argv before replacing placeholders, then spawns argv directly.
	return createSynctexCallbackArgv(options).map(shellQuote).join(" ");
}

export class SynctexCallbackServer {
	private server: Server | undefined;
	private target: SynctexPasteTarget | undefined;
	private startPromise: Promise<void> | undefined;
	private closed = false;
	readonly socketPath: string;
	readonly token: string;
	private readonly callbackScriptPath: string;
	private readonly nodePath: string;

	constructor(options: SynctexCallbackServerOptions) {
		const tmpDir = options.tmpDir ?? DEFAULT_SYNCTEX_TMPDIR;
		this.socketPath = resolve(tmpDir, `${SOCKET_NAME_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}.sock`);
		this.token = randomBytes(24).toString("hex");
		this.callbackScriptPath = options.callbackScriptPath;
		this.nodePath = options.nodePath ?? process.execPath;
	}

	get command(): string {
		return createSynctexCallbackCommand({
			nodePath: this.nodePath,
			callbackScriptPath: this.callbackScriptPath,
			socketPath: this.socketPath,
			token: this.token,
		});
	}

	async ensureStarted(target: SynctexPasteTarget): Promise<string> {
		if (this.closed) throw new Error("SyncTeX callback server has been closed");
		this.target = target;
		if (!this.server) {
			this.server = this.createServer();
		}
		if (!this.startPromise) {
			this.startPromise = this.listen();
		}
		await this.startPromise;
		return this.command;
	}

	updateTarget(target: SynctexPasteTarget): void {
		this.target = target;
	}

	async close(): Promise<void> {
		this.closed = true;
		const server = this.server;
		this.server = undefined;
		this.target = undefined;
		this.startPromise = undefined;
		if (server) {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
		try {
			unlinkSync(this.socketPath);
		} catch {
			// Socket cleanup is best-effort; it may already be gone after server.close().
		}
	}

	private createServer(): Server {
		return createServer((socket) => {
			let body = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				body += chunk;
			});
			socket.on("end", () => {
				const response = this.handleRawMessage(body);
				socket.end(`${JSON.stringify(response)}\n`);
			});
			socket.on("error", () => undefined);
		});
	}

	private listen(): Promise<void> {
		mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		return new Promise((resolveListen, rejectListen) => {
			const server = this.server;
			if (!server) {
				rejectListen(new Error("SyncTeX callback server is not initialized"));
				return;
			}

			const onError = (error: Error) => {
				server.off("listening", onListening);
				rejectListen(error);
			};
			const onListening = () => {
				server.off("error", onError);
				try {
					chmodSync(this.socketPath, 0o600);
				} catch {
					// Some platforms do not support chmod on Unix-domain sockets.
				}
				resolveListen();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.socketPath);
		});
	}

	private handleRawMessage(rawMessage: string): SynctexCallbackResponse {
		let message: SynctexCallbackMessage;
		try {
			message = JSON.parse(rawMessage) as SynctexCallbackMessage;
		} catch {
			return { ok: false, error: "invalid JSON" };
		}

		if (message.token !== this.token) {
			return { ok: false, error: "invalid token" };
		}
		if (typeof message.file !== "string" || !message.file.trim()) {
			return { ok: false, error: "missing file" };
		}
		if (!Number.isInteger(message.line) || message.line < 1) {
			return { ok: false, error: "invalid line" };
		}

		const target = this.target;
		if (!target?.hasUI || !target.ui) {
			return { ok: true, pasted: false };
		}

		target.ui.pasteToEditor(formatSynctexPasteBlock(message, target.cwd));
		return { ok: true, pasted: true };
	}
}

import { validateViewerHostControlResponse, VIEWER_HOST_CONTROL_TOKEN_HEADER, type ViewerHostControlResponse } from "./viewer_host_protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export interface ViewerHostControlClientOptions {
	origin: string;
	fetchImpl?: typeof fetch;
	controlToken?: string;
	requestTimeoutMs?: number;
}

export class ViewerHostControlClient {
	readonly origin: string;
	private readonly fetchImpl: typeof fetch;
	private readonly controlToken: string | undefined;
	private readonly requestTimeoutMs: number;

	constructor(options: ViewerHostControlClientOptions) {
		this.origin = options.origin.replace(/\/$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.controlToken = options.controlToken;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	async send(message: unknown): Promise<ViewerHostControlResponse> {
		const response = await this.fetchImpl(`${this.origin}/control`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(message),
			signal: AbortSignal.timeout(Math.max(1, this.requestTimeoutMs)),
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error(`Viewer Host control returned malformed JSON (HTTP ${response.status})`);
		}
		return validateViewerHostControlResponse(payload);
	}

	private headers(): Record<string, string> {
		return {
			"content-type": "application/json",
			...(this.controlToken === undefined ? {} : { [VIEWER_HOST_CONTROL_TOKEN_HEADER]: this.controlToken }),
		};
	}
}

import { VIEWER_HOST_CONTROL_TOKEN_HEADER, type ViewerHostControlResponse } from "./viewer_host_protocol.ts";

export interface ViewerHostControlClientOptions {
	origin: string;
	fetchImpl?: typeof fetch;
	controlToken?: string;
}

export class ViewerHostControlClient {
	readonly origin: string;
	private readonly fetchImpl: typeof fetch;
	private readonly controlToken: string | undefined;

	constructor(options: ViewerHostControlClientOptions) {
		this.origin = options.origin.replace(/\/$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.controlToken = options.controlToken;
	}

	async send(message: unknown): Promise<ViewerHostControlResponse> {
		const response = await this.fetchImpl(`${this.origin}/control`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(message),
		});
		return await response.json() as ViewerHostControlResponse;
	}

	private headers(): Record<string, string> {
		return {
			"content-type": "application/json",
			...(this.controlToken === undefined ? {} : { [VIEWER_HOST_CONTROL_TOKEN_HEADER]: this.controlToken }),
		};
	}
}

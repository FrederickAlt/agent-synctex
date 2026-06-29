import type { ViewerHostControlResponse } from "./viewer_host_protocol.ts";

export interface ViewerHostControlClientOptions {
	origin: string;
	fetchImpl?: typeof fetch;
}

export class ViewerHostControlClient {
	readonly origin: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: ViewerHostControlClientOptions) {
		this.origin = options.origin.replace(/\/$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async send(message: unknown): Promise<ViewerHostControlResponse> {
		const response = await this.fetchImpl(`${this.origin}/control`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
		});
		return await response.json() as ViewerHostControlResponse;
	}
}

export interface ViewerHostServerAddress {
	host: string;
	port: number;
}

	export interface ViewerHostAccessPolicy {
	readonly bindHost: string;
	originForAddress(address: ViewerHostServerAddress): string;
	viewerRootUrl(origin: string): string;
	viewerUrl(pdfId: number, revision?: number): string;
	pdfUrl(origin: string, pdfId: number, revision: number): string;
	viewerSocketUrl(origin: string, pdfId: number, token: string): string;
	isAllowedViewerSocketOrigin(origin: string | undefined, expectedOrigin: string): boolean;
}

export class LocalLoopbackViewerHostAccessPolicy implements ViewerHostAccessPolicy {
	readonly bindHost = "127.0.0.1";

	originForAddress(address: ViewerHostServerAddress): string {
		return `http://${this.bindHost}:${address.port}`;
	}

	viewerRootUrl(origin: string): string {
		return `${origin}/viewer-lw`;
	}

	viewerUrl(pdfId: number, revision?: number): string {
		const base = `/viewer-lw/${pdfId}`;
		return revision === undefined ? base : `${base}?revision=${revision}`;
	}

	pdfUrl(origin: string, pdfId: number, revision: number): string {
		return `${origin}/pdf/${pdfId}?revision=${revision}`;
	}

	viewerSocketUrl(origin: string, pdfId: number, token: string): string {
		return `${origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${pdfId}&token=${encodeURIComponent(token)}`;
	}

	isAllowedViewerSocketOrigin(origin: string | undefined, expectedOrigin: string): boolean {
		return origin === undefined || origin === expectedOrigin;
	}
}

export const DEFAULT_VIEWER_HOST_ACCESS_POLICY = new LocalLoopbackViewerHostAccessPolicy();

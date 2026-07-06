function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export interface ViewerUrlAgentNoticeDetails {
	viewer_url?: unknown;
	browser_launch?: unknown;
}

export function viewerUrlForAgentWhenNoLiveViewer(details: ViewerUrlAgentNoticeDetails): string | undefined {
	if (typeof details.viewer_url !== "string" || details.viewer_url.length === 0) return undefined;
	const browserLaunch = details.browser_launch;
	if (!isRecord(browserLaunch)) return undefined;
	if (browserLaunch.confirmed === true) return undefined;
	if (browserLaunch.confirmed === false) return details.viewer_url;
	if (typeof browserLaunch.active_viewer_clients === "number") {
		return browserLaunch.active_viewer_clients <= 0 ? details.viewer_url : undefined;
	}
	return undefined;
}

export function viewerUrlAgentNotice(details: ViewerUrlAgentNoticeDetails): string | undefined {
	const url = viewerUrlForAgentWhenNoLiveViewer(details);
	if (url === undefined) return undefined;
	const browserLaunch = isRecord(details.browser_launch) ? details.browser_launch : undefined;
	const openerError = typeof browserLaunch?.error === "string" && browserLaunch.error.trim()
		? ` (browser opener failed: ${compactOneLine(browserLaunch.error)})`
		: "";
	return `No browser viewer was detected after launch${openerError}; pass this Viewer URL to the user: ${url}`;
}

function compactOneLine(value: string): string {
	const compacted = value.replace(/\s+/g, " ").trim();
	return compacted.length > 240 ? `${compacted.slice(0, 239)}…` : compacted;
}

export function appendViewerUrlAgentNotice(text: string, details: ViewerUrlAgentNoticeDetails): string {
	const notice = viewerUrlAgentNotice(details);
	return notice === undefined ? text : `${text}\n${notice}`;
}

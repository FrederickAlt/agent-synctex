const state = {
	tabs: [],
	activePdfId: undefined,
};

const app = document.getElementById("viewer-client-app");
const tabList = document.getElementById("tab-list");
const panels = document.getElementById("viewer-panels");
const emptyState = document.getElementById("empty-state");
const tabScrollLeftButton = document.getElementById("tab-scroll-left");
const tabScrollRightButton = document.getElementById("tab-scroll-right");
const PDF_ANNOTATIONS_STORAGE_KEY = "agent-synctex.pdfAnnotations";

function updateTabScrollButtons() {
	const maxScrollLeft = Math.max(0, tabList.scrollWidth - tabList.clientWidth);
	const canScroll = maxScrollLeft > 1;
	if (tabScrollLeftButton) tabScrollLeftButton.disabled = !canScroll || tabList.scrollLeft <= 1;
	if (tabScrollRightButton) tabScrollRightButton.disabled = !canScroll || tabList.scrollLeft >= maxScrollLeft - 1;
}

function scheduleTabScrollButtonUpdate() {
	requestAnimationFrame(updateTabScrollButtons);
}

function scrollTabs(direction) {
	tabList.scrollLeft += direction * Math.max(120, Math.floor(tabList.clientWidth * 0.75));
	scheduleTabScrollButtonUpdate();
}

function bindTabOverflowControls() {
	tabScrollLeftButton?.addEventListener("click", () => scrollTabs(-1));
	tabScrollRightButton?.addEventListener("click", () => scrollTabs(1));
	tabList.addEventListener("scroll", updateTabScrollButtons, { passive: true });
	window.addEventListener("resize", scheduleTabScrollButtonUpdate);
}

function pdfIdKey(pdfId) {
	return String(pdfId);
}

function titleFor(message) {
	return message.title || "PDF " + message.pdf_id;
}

function viewerUrlFor(message) {
	return message.viewer_url || "/viewer-lw/" + encodeURIComponent(String(message.pdf_id));
}

function isEditableAppShellTarget(target) {
	if (!(target instanceof Element)) return false;
	if (target.isContentEditable) return true;
	return Boolean(target.closest("input, textarea, select, button, a[href], [contenteditable], [role='button'], [role='textbox'], [role='combobox'], [role='listbox'], [role='slider'], [role='spinbutton']"));
}

function activeViewerIframe() {
	if (state.activePdfId === undefined) return undefined;
	return document.querySelector("iframe[data-pdf-id='" + pdfIdKey(state.activePdfId) + "']");
}

function postNavigationToActiveViewer(direction) {
	const iframe = activeViewerIframe();
	if (!iframe || !iframe.contentWindow) return false;
	iframe.contentWindow.postMessage({ type: "host_lw_navigation", direction }, location.origin);
	return true;
}

function tabsStatePayload() {
	return {
		type: "host_lw_tabs_state",
		activePdfId: state.activePdfId,
		tabs: state.tabs.map((tab) => ({
			pdfId: tab.pdfId,
			title: tab.title,
			revision: tab.revision,
			viewerUrl: tab.viewerUrl,
			visibleTabToken: tab.visibleTabToken,
		})),
	};
}

function postTabsStateToViewer(iframe = activeViewerIframe()) {
	if (!iframe || !iframe.contentWindow) return false;
	iframe.contentWindow.postMessage(tabsStatePayload(), location.origin);
	return true;
}

function postTabsStateToAllViewers() {
	for (const iframe of document.querySelectorAll("iframe[data-pdf-id]")) postTabsStateToViewer(iframe);
}

const recentAppShellRawMouseEvents = [];
const MAX_APP_SHELL_RAW_MOUSE_EVENTS = 20;

function describeAppShellEventTarget(target) {
	if (target instanceof Element) return { tag: target.tagName, id: target.id || undefined, className: typeof target.className === "string" ? target.className : undefined };
	if (target === document) return { tag: "#document" };
	if (target === window) return { tag: "#window" };
	return undefined;
}

function appShellHistoryDirectionFromMouseEvent(event) {
	if (event.button === 3) return "back";
	if (event.button === 4) return "forward";
	if (event.button === 8) return "back";
	if (event.button === 16) return "forward";
	if (event.button === 1 || event.button === 2 || event.which === 2 || event.which === 3) return undefined;
	if ((event.buttons & 8) === 8) return "back";
	if ((event.buttons & 16) === 16) return "forward";
	if (event.button === 0 && event.buttons === 0 && event.which === 4) return "back";
	if (event.button === 0 && event.buttons === 0 && event.which === 5) return "forward";
	return undefined;
}

function rememberAppShellRawMouseEvent(event, handledDirection) {
	const diagnostic = {
		type: event.type,
		button: event.button,
		buttons: event.buttons,
		which: event.which,
		detail: event.detail,
		pointerType: event.pointerType,
		target: describeAppShellEventTarget(event.target),
		defaultPrevented: event.defaultPrevented,
		altKey: event.altKey,
		ctrlKey: event.ctrlKey,
		metaKey: event.metaKey,
		shiftKey: event.shiftKey,
		handledDirection,
	};
	recentAppShellRawMouseEvents.push(diagnostic);
	while (recentAppShellRawMouseEvents.length > MAX_APP_SHELL_RAW_MOUSE_EVENTS) recentAppShellRawMouseEvents.shift();
	return diagnostic;
}

function appShellSideButtonDedupeKey(event, direction) {
	return direction + ":" + event.button + ":" + event.buttons + ":" + event.which;
}

function postNavigationDiagnosticToActiveViewer(diagnostic) {
	const iframe = activeViewerIframe();
	if (!iframe || !iframe.contentWindow) return false;
	iframe.contentWindow.postMessage({ type: "host_lw_app_shell_mouse_diagnostic", diagnostic }, location.origin);
	return true;
}

function handleAppShellHistoryKeydown(event) {
	if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
	const key = event.key.toLowerCase();
	if (key !== "o" && key !== "i") return;
	if (isEditableAppShellTarget(event.target) || isEditableAppShellTarget(document.activeElement)) return;
	event.preventDefault();
	event.stopImmediatePropagation?.();
	event.stopPropagation();
	postNavigationToActiveViewer(key === "o" ? "back" : "forward");
}

let lastAppShellSideButtonNavigation;
function handleAppShellHistoryMouseButton(event) {
	const direction = appShellHistoryDirectionFromMouseEvent(event);
	const rawDiagnostic = rememberAppShellRawMouseEvent(event, direction);
	if (!direction) {
		postNavigationDiagnosticToActiveViewer(rawDiagnostic);
		return;
	}
	if (isEditableAppShellTarget(event.target) || isEditableAppShellTarget(document.activeElement)) return;
	event.preventDefault();
	event.stopImmediatePropagation?.();
	event.stopPropagation();
	rawDiagnostic.defaultPrevented = event.defaultPrevented;
	postNavigationDiagnosticToActiveViewer(rawDiagnostic);
	const now = performance.now();
	const recent = lastAppShellSideButtonNavigation;
	const key = appShellSideButtonDedupeKey(event, direction);
	if (recent && recent.key === key && recent.type !== event.type && now - recent.time < 250) return;
	lastAppShellSideButtonNavigation = { key, type: event.type, time: now };
	postNavigationToActiveViewer(direction);
}

function bindAppShellViewerShortcuts() {
	for (const target of [window, document]) {
		target.addEventListener("keydown", handleAppShellHistoryKeydown, true);
	}
	for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick"]) {
		for (const target of [window, document]) target.addEventListener(eventName, handleAppShellHistoryMouseButton, true);
	}
}

function bindViewerToolbarTabMessages() {
	window.addEventListener("message", (event) => {
		if (event.origin !== location.origin) return;
		const message = event.data;
		if (!message || typeof message !== "object") return;
		if (message.type === "host_lw_tabs_ready") {
			postTabsStateToAllViewers();
		} else if (message.type === "host_lw_select_tab") {
			const pdfId = Number(message.pdfId);
			if (!state.tabs.some((tab) => tab.pdfId === pdfId)) return;
			state.activePdfId = pdfId;
			renderTabs();
		} else if (message.type === "host_lw_close_tab") {
			const pdfId = Number(message.pdfId);
			closeTab(pdfId);
		}
	});
}

function openOrFocusTab(message) {
	const pdfId = Number(message.pdf_id);
	const existing = state.tabs.find((tab) => tab.pdfId === pdfId);
	if (existing) {
		existing.title = titleFor(message);
		existing.revision = message.revision;
		existing.viewerUrl = viewerUrlFor(message);
		existing.visibleTabToken = message.visible_tab_token;
	} else {
		state.tabs.push({ pdfId, title: titleFor(message), revision: message.revision, viewerUrl: viewerUrlFor(message), visibleTabToken: message.visible_tab_token });
	}
	state.activePdfId = pdfId;
	renderTabs();
}

function clearPersistedAnnotationsForPdfId(pdfId) {
	try {
		const all = JSON.parse(localStorage.getItem(PDF_ANNOTATIONS_STORAGE_KEY) || "{}");
		if (!all || typeof all !== "object") return;
		delete all[String(Number(pdfId))];
		localStorage.setItem(PDF_ANNOTATIONS_STORAGE_KEY, JSON.stringify(all));
	} catch {}
}

function closeTab(pdfId) {
	const index = state.tabs.findIndex((tab) => tab.pdfId === pdfId);
	if (index === -1) return;
	const closedTab = state.tabs[index];
	clearPersistedAnnotationsForPdfId(pdfId);
	state.tabs.splice(index, 1);
	void fetch("/app-tab-closed", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pdf_id: pdfId, revision: closedTab.revision, viewer_url: closedTab.viewerUrl, visible_tab_token: closedTab.visibleTabToken }),
	}).catch(() => undefined);
	if (state.activePdfId === pdfId) {
		const next = state.tabs[Math.min(index, state.tabs.length - 1)];
		state.activePdfId = next ? next.pdfId : undefined;
	}
	renderTabs();
}

function renderTabs() {
	const existingPanels = new Map(Array.from(panels.querySelectorAll("[role='tabpanel'][data-pdf-id]"), (panel) => [panel.dataset.pdfId, panel]));
	const visiblePdfIds = new Set(state.tabs.map((tab) => pdfIdKey(tab.pdfId)));
	tabList.replaceChildren();
	for (const [pdfId, panel] of existingPanels) {
		if (!visiblePdfIds.has(pdfId)) panel.remove();
	}
	if (state.activePdfId === undefined || !state.tabs.some((tab) => tab.pdfId === state.activePdfId)) {
		state.activePdfId = state.tabs[0] ? state.tabs[0].pdfId : undefined;
	}
	if (state.activePdfId === undefined) {
		app.removeAttribute("data-active-pdf-id");
		emptyState.hidden = false;
	} else {
		app.setAttribute("data-active-pdf-id", pdfIdKey(state.activePdfId));
		emptyState.hidden = true;
	}
	for (const tab of state.tabs) {
		const selected = tab.pdfId === state.activePdfId;
		const tabItem = document.createElement("div");
		tabItem.className = selected ? "tab-item is-active" : "tab-item";
		const tabButton = document.createElement("button");
		tabButton.type = "button";
		tabButton.role = "tab";
		tabButton.dataset.pdfId = pdfIdKey(tab.pdfId);
		tabButton.setAttribute("aria-selected", selected ? "true" : "false");
		tabButton.textContent = tab.title;
		tabButton.addEventListener("click", () => {
			if (state.activePdfId === tab.pdfId) return;
			state.activePdfId = tab.pdfId;
			renderTabs();
		});
		const closeButton = document.createElement("button");
		closeButton.type = "button";
		closeButton.setAttribute("data-close-pdf-id", pdfIdKey(tab.pdfId));
		closeButton.setAttribute("aria-label", "Close " + tab.title);
		closeButton.textContent = "×";
		closeButton.addEventListener("click", (event) => {
			event.stopPropagation();
			closeTab(tab.pdfId);
		});
		tabItem.append(tabButton, closeButton);
		tabList.appendChild(tabItem);

		let panel = existingPanels.get(pdfIdKey(tab.pdfId));
		let iframe;
		if (panel) {
			iframe = panel.querySelector("iframe[data-pdf-id]");
		} else {
			panel = document.createElement("section");
			panel.role = "tabpanel";
			panel.dataset.pdfId = pdfIdKey(tab.pdfId);
			iframe = document.createElement("iframe");
			iframe.dataset.pdfId = pdfIdKey(tab.pdfId);
			iframe.addEventListener("load", () => postTabsStateToViewer(iframe));
			panel.appendChild(iframe);
		}
		panel.hidden = !selected;
		iframe.title = tab.title;
		if (iframe.getAttribute("src") !== tab.viewerUrl) iframe.src = tab.viewerUrl;
		if (!panel.isConnected) panels.appendChild(panel);
	}
	if (tabList.scrollLeft > tabList.scrollWidth - tabList.clientWidth) tabList.scrollLeft = Math.max(0, tabList.scrollWidth - tabList.clientWidth);
	scheduleTabScrollButtonUpdate();
	postTabsStateToAllViewers();
}

function connectAppEvents() {
	const events = new EventSource("/app-events");
	events.addEventListener("open", () => document.body.setAttribute("data-app-events", "connected"));
	events.addEventListener("error", () => document.body.setAttribute("data-app-events", "disconnected"));
	events.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.type === "open_pdf" || message.type === "focus_pdf") openOrFocusTab(message);
	});
}

window.__hostAppShellRawMouseDebug = () => recentAppShellRawMouseEvents.slice();
bindTabOverflowControls();
bindAppShellViewerShortcuts();
bindViewerToolbarTabMessages();
renderTabs();
connectAppEvents();

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { basename, dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import { validateMcpToViewerHostMessage, validateViewerHostToMcpMessage, VIEWER_HOST_PROTOCOL_VERSION, type ViewerHostControlResponse, type ViewerHostSynctexForwardMessage, type ViewerHostToMcpMessage } from "./viewer_host_protocol.ts";
import { inspectReverseSynctexHover, mapReverseForwardSynctexProbe } from "./synctex/forward_synctex.ts";
import type { ViewerHostFileSnapshot, ViewerHostPdfRecord, ViewerHostPdfRegistry } from "./viewer_host_registry.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const MAX_VIEWER_SOCKET_MESSAGE_BYTES = 64 * 1024;
const require = createRequire(import.meta.url);
const LOCAL_PDFJS_ASSETS = new Map<string, string>([
	["/assets/pdf.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.mjs")],
	["/assets/pdf.worker.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")],
]);

const VIEWER_CLIENT_TABS_SCRIPT = `
const state = {
	tabs: [],
	activePdfId: undefined,
};

const app = document.getElementById("viewer-client-app");
const tabList = document.getElementById("tab-list");
const panels = document.getElementById("viewer-panels");
const emptyState = document.getElementById("empty-state");

function pdfIdKey(pdfId) {
	return String(pdfId);
}

function titleFor(message) {
	return message.title || "PDF " + message.pdf_id;
}

function viewerUrlFor(message) {
	return message.viewer_url || "/viewer/" + encodeURIComponent(String(message.pdf_id));
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

function closeTab(pdfId) {
	const index = state.tabs.findIndex((tab) => tab.pdfId === pdfId);
	if (index === -1) return;
	const closedTab = state.tabs[index];
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
	tabList.replaceChildren();
	panels.replaceChildren();
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
		tabItem.className = "tab-item";
		const tabButton = document.createElement("button");
		tabButton.type = "button";
		tabButton.role = "tab";
		tabButton.dataset.pdfId = pdfIdKey(tab.pdfId);
		tabButton.setAttribute("aria-selected", selected ? "true" : "false");
		tabButton.textContent = tab.title;
		tabButton.addEventListener("click", () => {
			state.activePdfId = tab.pdfId;
			renderTabs();
		});
		const closeButton = document.createElement("button");
		closeButton.type = "button";
		closeButton.setAttribute("data-close-pdf-id", pdfIdKey(tab.pdfId));
		closeButton.setAttribute("aria-label", "Close " + tab.title);
		closeButton.textContent = "×";
		closeButton.addEventListener("click", () => closeTab(tab.pdfId));
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
			panel.appendChild(iframe);
		}
		panel.hidden = !selected;
		iframe.title = tab.title;
		if (iframe.getAttribute("src") !== tab.viewerUrl) iframe.src = tab.viewerUrl;
		panels.appendChild(panel);
	}
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

renderTabs();
connectAppEvents();
`;

const VIEWER_SCRIPT = `
const status = document.getElementById("status");
const pages = document.getElementById("pages");
const fallback = document.getElementById("fallback-link");
const configUrl = document.body.dataset.configUrl;

function setStatus(message) {
	if (status) status.textContent = message;
}

function reportViewerError(error) {
	const message = error && error.message ? error.message : String(error || "unknown viewer error");
	setStatus("Unable to render via PDF.js: " + message + ". Use the direct PDF link below.");
}

window.addEventListener("error", (event) => {
	reportViewerError(event.error || event.message || "viewer script failed to load");
});
window.addEventListener("unhandledrejection", (event) => {
	reportViewerError(event.reason || "unhandled viewer promise rejection");
});

let activeConfig;
let viewerSocket;
const pageViewports = new Map();
const pendingReverseSynctexContexts = new WeakMap();
let lastObservedSelectionSignature;
let selectionGeneration = 0;
let lastSentSelectionSignature;
let lastSentSelectionGeneration;
let pendingReverseSynctexSelectionSend;
let pendingSelectionMouseDownDebug;
let selectionDebugCount = 0;
let reverseSynctexHoverEnabled = false;
let reverseSynctexHoverRequestId = 0;
let reverseSynctexHoverLatestRequestId = 0;
let reverseSynctexHoverTimer;
let reverseSynctexHoverPending;
let reverseSynctexForwardProbeRequestId = 0;
let reverseSynctexForwardProbeLatestRequestId = 0;
const REVERSE_SYNCTEX_HOVER_THROTTLE_MS = 150;
const MAX_SELECTION_DEBUG_EVENTS = 200;
const MAX_SELECTION_DEBUG_TEXT = 500;

function boundedSelectionDebugText(value) {
	const text = typeof value === "string" ? value : "";
	return text.length > MAX_SELECTION_DEBUG_TEXT ? text.slice(0, MAX_SELECTION_DEBUG_TEXT) : text;
}

function describeSelectionDebugNode(node) {
	if (!node) return undefined;
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.textContent ?? "";
		return { type: "text", length: text.length, text: boundedSelectionDebugText(text) };
	}
	if (node instanceof Element) {
		return { type: "element", tag: node.tagName.toLowerCase(), id: node.id || undefined, className: typeof node.className === "string" ? node.className.slice(0, 80) : undefined, childNodes: node.childNodes.length };
	}
	return { type: String(node.nodeType) };
}

function selectionDebugSnapshot(phase, pageNumber, extra = {}) {
	const selection = window.getSelection();
	const text = selection ? selection.toString() : "";
	const snapshot = {
		phase,
		time: Date.now(),
		performanceNow: typeof performance !== "undefined" && performance.now ? performance.now() : undefined,
		page: pageNumber,
		selectionGeneration,
		currentSignature: currentReverseSynctexSelectionSignature(),
		selectionText: boundedSelectionDebugText(text),
		selectionTextLength: text.length,
		isCollapsed: selection?.isCollapsed,
		rangeCount: selection?.rangeCount ?? 0,
		anchorOffset: selection?.anchorOffset,
		focusOffset: selection?.focusOffset,
		anchorNode: describeSelectionDebugNode(selection?.anchorNode),
		focusNode: describeSelectionDebugNode(selection?.focusNode),
		...extra,
	};
	if (selection && selection.rangeCount > 0) {
		const range = selection.getRangeAt(0);
		snapshot.rangeStartOffset = range.startOffset;
		snapshot.rangeEndOffset = range.endOffset;
		snapshot.rangeStartNode = describeSelectionDebugNode(range.startContainer);
		snapshot.rangeEndNode = describeSelectionDebugNode(range.endContainer);
	}
	return snapshot;
}

function sendSelectionDebugDetails(phase, pageNumber, details) {
	if (selectionDebugCount >= MAX_SELECTION_DEBUG_EVENTS) return;
	if (!viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return;
	selectionDebugCount += 1;
	viewerSocket.send(JSON.stringify({
		type: "selection_debug",
		phase,
		...(pageNumber === undefined ? {} : { page: pageNumber }),
		text: details.selectionText,
		details,
	}));
}

function sendSelectionDebug(phase, pageNumber, extra = {}) {
	const details = selectionDebugSnapshot(phase, pageNumber, extra);
	if (details.selectionTextLength === 0 && extra.selectedPayloadText === undefined && extra.suppressionReason === undefined && extra.sentText === undefined) return;
	sendSelectionDebugDetails(phase, pageNumber, details);
}

function reverseSynctexPayloadFromViewportPoint(input) {
	const point = input.viewport.convertToPdfPoint(input.viewportX, input.viewportHeight - input.viewportY);
	return {
		type: "reverse_synctex",
		page: input.page,
		x: point[0],
		y: point[1],
		...(input.textBeforeSelection === undefined ? {} : { textBeforeSelection: input.textBeforeSelection }),
		...(input.textAfterSelection === undefined ? {} : { textAfterSelection: input.textAfterSelection }),
		...(input.selectedText === undefined ? {} : { selectedText: input.selectedText }),
		...(input.selectionStartX === undefined ? {} : { selectionStartX: input.selectionStartX }),
		...(input.selectionStartY === undefined ? {} : { selectionStartY: input.selectionStartY }),
		...(input.selectionEndX === undefined ? {} : { selectionEndX: input.selectionEndX }),
		...(input.selectionEndY === undefined ? {} : { selectionEndY: input.selectionEndY }),
	};
}

function firstTextNode(node) {
	if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").length > 0) return node;
	const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	let current = walker.nextNode();
	while (current) {
		if ((current.textContent ?? "").length > 0) return current;
		current = walker.nextNode();
	}
	return undefined;
}

function lastTextNode(node) {
	if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").length > 0) return node;
	const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	let last;
	let current = walker.nextNode();
	while (current) {
		if ((current.textContent ?? "").length > 0) last = current;
		current = walker.nextNode();
	}
	return last;
}

function adjacentTextNodeAtBoundary(root, node, offset, preferPrevious) {
	const boundary = document.createRange();
	boundary.setStart(node, offset);
	boundary.collapse(true);
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let previous;
	let current = walker.nextNode();
	while (current) {
		const length = (current.textContent ?? "").length;
		if (length > 0) {
			const probe = document.createRange();
			probe.setStart(current, preferPrevious ? length : 0);
			probe.collapse(true);
			const comparison = probe.compareBoundaryPoints(Range.START_TO_START, boundary);
			probe.detach?.();
			if (preferPrevious) {
				if (comparison <= 0) previous = current;
				else break;
			} else if (comparison >= 0) {
				boundary.detach?.();
				return current;
			}
		}
		current = walker.nextNode();
	}
	boundary.detach?.();
	return preferPrevious ? previous : undefined;
}

function textNodeAtBoundary(root, node, offset, preferPrevious) {
	if (node.nodeType === Node.TEXT_NODE) {
		const length = (node.textContent ?? "").length;
		if (length === 0) {
			const adjacent = adjacentTextNodeAtBoundary(root, node, offset, preferPrevious);
			return adjacent ? { node: adjacent, offset: preferPrevious ? (adjacent.textContent ?? "").length : 0 } : undefined;
		}
		if (preferPrevious) {
			if (offset > 0) return { node, offset };
			const previous = adjacentTextNodeAtBoundary(root, node, offset, true);
			return previous ? { node: previous, offset: (previous.textContent ?? "").length } : undefined;
		}
		if (offset < length) return { node, offset };
		const next = adjacentTextNodeAtBoundary(root, node, offset, false);
		return next ? { node: next, offset: 0 } : undefined;
	}
	const children = Array.from(node.childNodes ?? []);
	if (preferPrevious) {
		for (let index = Math.min(offset, children.length) - 1; index >= 0; index -= 1) {
			const candidate = lastTextNode(children[index]);
			if (candidate) return { node: candidate, offset: (candidate.textContent ?? "").length };
		}
		const previous = adjacentTextNodeAtBoundary(root, node, offset, true);
		return previous ? { node: previous, offset: (previous.textContent ?? "").length } : undefined;
	}
	for (let index = Math.max(0, offset); index < children.length; index += 1) {
		const candidate = firstTextNode(children[index]);
		if (candidate) return { node: candidate, offset: 0 };
	}
	const next = adjacentTextNodeAtBoundary(root, node, offset, false);
	return next ? { node: next, offset: 0 } : undefined;
}

function boundaryClientRect(root, boundary) {
	const text = textNodeAtBoundary(root, boundary.node, boundary.offset, boundary.preferPrevious);
	if (!text || !text.node || !text.node.textContent) return undefined;
	const length = text.node.textContent.length;
	const start = boundary.preferPrevious ? text.offset - 1 : text.offset;
	const end = boundary.preferPrevious ? text.offset : text.offset + 1;
	if (start < 0 || end > length || start >= end) return undefined;
	const probe = document.createRange();
	probe.setStart(text.node, start);
	probe.setEnd(text.node, end);
	const rect = probe.getBoundingClientRect();
	probe.detach?.();
	return rect.width || rect.height ? rect : undefined;
}

function pdfPointFromClientRect(rect, canvas, viewport) {
	const canvasRect = canvas.getBoundingClientRect();
	return viewport.convertToPdfPoint(rect.left + rect.width / 2 - canvasRect.left, canvas.offsetHeight - (rect.top + rect.height / 2 - canvasRect.top));
}

function reverseSynctexContextForPage(pageElement, canvas, viewport) {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return {};
	const textLayer = pageElement.querySelector(".textLayer");
	if (!textLayer) return {};
	const range = selection.getRangeAt(0);
	if (!textLayer.contains(range.commonAncestorContainer)) return {};
	if (selection.isCollapsed) {
		const anchorNode = selection.anchorNode;
		if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE || !anchorNode.textContent || !textLayer.contains(anchorNode)) return {};
		return {
			textBeforeSelection: anchorNode.textContent.substring(0, selection.anchorOffset),
			textAfterSelection: anchorNode.textContent.substring(selection.anchorOffset),
		};
	}
	const selectedText = selection.toString();
	if (!selectedText) return {};
	const startRect = boundaryClientRect(textLayer, { node: range.startContainer, offset: range.startOffset, preferPrevious: false });
	const endRect = boundaryClientRect(textLayer, { node: range.endContainer, offset: range.endOffset, preferPrevious: true });
	if (!startRect || !endRect) return {};
	const start = pdfPointFromClientRect(startRect, canvas, viewport);
	const end = pdfPointFromClientRect(endRect, canvas, viewport);
	return { selectedText, selectionStartX: start[0], selectionStartY: start[1], selectionEndX: end[0], selectionEndY: end[1] };
}

async function renderTextLayer(pdfjsLib, page, viewport, pageContainer) {
	const textLayer = document.createElement("div");
	textLayer.className = "textLayer";
	textLayer.style.position = "absolute";
	textLayer.style.inset = "0";
	textLayer.style.overflow = "hidden";
	textLayer.style.lineHeight = "1";
	textLayer.style.textAlign = "initial";
	textLayer.style.transformOrigin = "0 0";
	pageContainer.appendChild(textLayer);
	try {
		if (typeof pdfjsLib.TextLayer === "function") {
			const textContentSource = typeof page.streamTextContent === "function"
				? page.streamTextContent({ includeMarkedContent: true })
				: await page.getTextContent({ includeMarkedContent: true });
			const layer = new pdfjsLib.TextLayer({ textContentSource, container: textLayer, viewport });
			await layer.render();
			textLayer.dataset.rendered = "true";
		}
	} catch (error) {
		textLayer.remove();
		console.warn("Unable to render PDF.js text layer", error);
	}
}

function hasReverseSynctexContext(context) {
	return context.textBeforeSelection !== undefined || context.textAfterSelection !== undefined || context.selectedText !== undefined;
}

function reverseSynctexSelectionSignature(pageNumber, selection) {
	if (selection.selectedText === undefined) return undefined;
	return [pageNumber, selection.selectedText, selection.selectionStartX, selection.selectionStartY, selection.selectionEndX, selection.selectionEndY].join("|");
}

function reverseSynctexSelectionPayload(pageNumber, selection) {
	return {
		type: "reverse_synctex",
		page: pageNumber,
		x: selection.selectionStartX,
		y: selection.selectionStartY,
		selectedText: selection.selectedText,
		selectionStartX: selection.selectionStartX,
		selectionStartY: selection.selectionStartY,
		selectionEndX: selection.selectionEndX,
		selectionEndY: selection.selectionEndY,
	};
}

function wasSelectionAlreadySent(signature, generation) {
	return signature !== undefined && signature === lastSentSelectionSignature && generation === lastSentSelectionGeneration;
}

function rememberSentSelection(signature, generation) {
	lastSentSelectionSignature = signature;
	lastSentSelectionGeneration = generation;
}

function currentReverseSynctexSelectionSignature() {
	if (!pages) return undefined;
	for (const pageElement of pages.querySelectorAll("div[data-page-number]")) {
		const pageNumber = Number(pageElement.dataset.pageNumber);
		const viewport = pageViewports.get(pageNumber);
		const canvas = pageElement.querySelector("canvas[data-page-number]");
		if (!viewport || !canvas) continue;
		const selection = reverseSynctexContextForPage(pageElement, canvas, viewport);
		const signature = reverseSynctexSelectionSignature(pageNumber, selection);
		if (signature !== undefined) return signature;
	}
	return undefined;
}

document.addEventListener("selectionchange", () => {
	const signature = currentReverseSynctexSelectionSignature();
	if (signature !== lastObservedSelectionSignature) selectionGeneration += 1;
	lastObservedSelectionSignature = signature;
	sendSelectionDebug("selectionchange", undefined, { observedSignature: signature });
});

function sendReverseSynctexSelection(pageNumber, pageElement, canvas, viewport) {
	if (!viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return false;
	const selection = reverseSynctexContextForPage(pageElement, canvas, viewport);
	if (selection.selectedText === undefined || selection.selectionStartX === undefined || selection.selectionStartY === undefined || selection.selectionEndX === undefined || selection.selectionEndY === undefined) return false;
	const signature = reverseSynctexSelectionSignature(pageNumber, selection);
	if (wasSelectionAlreadySent(signature, selectionGeneration)) {
		sendSelectionDebug("suppress", pageNumber, { suppressionReason: "already_sent", signature, generation: selectionGeneration, selectedPayloadText: boundedSelectionDebugText(selection.selectedText), selectedPayloadTextLength: selection.selectedText.length });
		return true;
	}
	rememberSentSelection(signature, selectionGeneration);
	const payload = reverseSynctexSelectionPayload(pageNumber, selection);
	sendSelectionDebug("send", pageNumber, { signature, generation: selectionGeneration, selectedPayloadText: boundedSelectionDebugText(payload.selectedText), selectedPayloadTextLength: payload.selectedText.length, selectionStartX: payload.selectionStartX, selectionStartY: payload.selectionStartY, selectionEndX: payload.selectionEndX, selectionEndY: payload.selectionEndY });
	viewerSocket.send(JSON.stringify(payload));
	setTimeout(() => {
		const currentText = window.getSelection()?.toString() ?? "";
		sendSelectionDebug("post_send_audit", pageNumber, { sentText: boundedSelectionDebugText(payload.selectedText), sentTextLength: payload.selectedText.length, currentText: boundedSelectionDebugText(currentText), currentTextLength: currentText.length, changed: currentText !== payload.selectedText });
	}, 300);
	return true;
}

function scheduleReverseSynctexSelectionSend(pageNumber, pageElement, canvas, viewport) {
	const request = { pageNumber, pageElement, canvas, viewport };
	pendingReverseSynctexSelectionSend = request;
	let observedGeneration = selectionGeneration;
	let observedSignature = currentReverseSynctexSelectionSignature();
	let stableSamples = 0;
	const scheduleTick = (delay) => {
		setTimeout(() => requestAnimationFrame(tick), delay);
	};
	function tick() {
		if (pendingReverseSynctexSelectionSend !== request) return;
		const signature = currentReverseSynctexSelectionSignature();
		sendSelectionDebug("scheduler_tick", pageNumber, { observedGeneration, observedSignature, signature, stableSamples });
		if (selectionGeneration !== observedGeneration || signature !== observedSignature) {
			observedGeneration = selectionGeneration;
			observedSignature = signature;
			stableSamples = 0;
			scheduleTick(100);
			return;
		}
		stableSamples += 1;
		if (stableSamples < 2) {
			scheduleTick(25);
			return;
		}
		pendingReverseSynctexSelectionSend = undefined;
		sendReverseSynctexSelection(pageNumber, pageElement, canvas, viewport);
	}
	scheduleTick(100);
}

function viewportScale(input) {
	const origin = input.viewport.convertToViewportPoint(0, 0);
	const xUnit = input.viewport.convertToViewportPoint(1, 0);
	const yUnit = input.viewport.convertToViewportPoint(0, 1);
	return { x: Math.abs(xUnit[0] - origin[0]) || 1, y: Math.abs(yUnit[1] - origin[1]) || 1 };
}

function forwardSynctexMarkerFromPdfPoint(input) {
	const scale = viewportScale(input);
	const point = input.viewport.convertToViewportPoint(input.pdfX, input.pdfY);
	const pageHeight = input.pageHeight ?? input.viewport.convertToViewportPoint(0, 0)[1];
	const position = { left: point[0], top: pageHeight - point[1] };
	if (input.width === undefined || input.height === undefined) return position;
	return { ...position, width: input.width * scale.x, height: input.height * scale.y };
}

function removeReverseSynctexHoverOverlay() {
	for (const marker of document.querySelectorAll("[data-reverse-synctex-hover]")) marker.remove();
}

function removeReverseSynctexForwardProbeOverlay() {
	for (const marker of document.querySelectorAll("[data-reverse-synctex-forward-probe]")) marker.remove();
}

function setReverseSynctexHoverEnabled(enabled) {
	reverseSynctexHoverEnabled = enabled;
	const button = document.getElementById("synctex-hover-toggle");
	if (button) {
		button.setAttribute("aria-pressed", enabled ? "true" : "false");
		button.textContent = enabled ? "SyncTeX hover: on" : "SyncTeX hover: off";
	}
	if (!enabled) {
		reverseSynctexHoverLatestRequestId += 1;
		reverseSynctexHoverPending = undefined;
		if (reverseSynctexHoverTimer !== undefined) clearTimeout(reverseSynctexHoverTimer);
		reverseSynctexHoverTimer = undefined;
		reverseSynctexForwardProbeLatestRequestId += 1;
		removeReverseSynctexHoverOverlay();
		removeReverseSynctexForwardProbeOverlay();
	}
}

function reverseSynctexHoverRectPosition(rect, page, viewport) {
	const leftTop = viewport.convertToViewportPoint(Number(rect.left), Number(rect.top));
	const rightBottom = viewport.convertToViewportPoint(Number(rect.right), Number(rect.bottom));
	const pageHeight = page.getBoundingClientRect().height;
	return {
		left: Math.min(leftTop[0], rightBottom[0]),
		top: pageHeight - Math.max(leftTop[1], rightBottom[1]),
		width: visibleSynctexRectDimension(Math.abs(rightBottom[0] - leftTop[0])),
		height: visibleSynctexRectDimension(Math.abs(leftTop[1] - rightBottom[1])),
	};
}

function truncateHoverLabel(value) {
	const text = String(value ?? "").trim();
	return text.length > 100 ? text.slice(0, 97) + "…" : text;
}

function hoverCandidateLine(prefix, candidate) {
	if (!candidate) return "";
	const source = candidate.source_line ? " " + truncateHoverLabel(String(candidate.source_line)) : "";
	const precision = candidate.precision ? " [" + String(candidate.precision) + "]" : "";
	const score = candidate.score === undefined ? "" : " score " + String(candidate.score);
	const distance = candidate.score === undefined && candidate.distance !== undefined ? " distance " + String(candidate.distance) : "";
	return prefix + ": line " + String(candidate.line || "?") + score + distance + source + precision;
}

function hoverDiagnosticsLabel(message) {
	const file = String(message.source_file || "").split(/[\\/]/).pop() || "source";
	const simple = file + ":" + message.line + " " + truncateHoverLabel(message.source_line);
	const nearestCandidate = message.nearest_candidate || message.raw;
	if (nearestCandidate || message.repaired || message.precision || Array.isArray(message.candidates) || message.forward) {
		const parts = [simple];
		if (nearestCandidate) parts.push(hoverCandidateLine("nearest candidate", nearestCandidate));
		if (message.repaired) parts.push(hoverCandidateLine("repair", message.repaired));
		else parts.push(hoverCandidateLine("result", { line: message.line, source_line: message.source_line, precision: message.precision, score: message.selected_score }));
		if (message.forward && message.forward.contains_click) parts.push("forward: verified");
		if (Array.isArray(message.candidates) && message.candidates.length > 0) parts.push("top: " + message.candidates.slice(0, 3).map((candidate) => "line " + String(candidate.line || "?") + (candidate.score === undefined ? "" : " score " + String(candidate.score))).join("; "));
		return parts.filter(Boolean).join("\\n");
	}
	return simple;
}

function showReverseSynctexHoverResult(message) {
	if (!reverseSynctexHoverEnabled || Number(message.request_id) !== reverseSynctexHoverLatestRequestId) return;
	if (message.error || !message.rect) {
		removeReverseSynctexHoverOverlay();
		return;
	}
	const pageNumber = Number(message.page);
	const page = pages.querySelector("[data-page-number='" + String(pageNumber) + "']");
	const viewport = pageViewports.get(pageNumber);
	if (!page || !viewport) return;
	removeReverseSynctexHoverOverlay();
	const position = reverseSynctexHoverRectPosition(message.rect, page, viewport);
	const marker = document.createElement("div");
	marker.dataset.reverseSynctexHover = "rect";
	marker.style.position = "absolute";
	marker.style.pointerEvents = "none";
	marker.style.zIndex = "100001";
	marker.style.left = String(position.left) + "px";
	marker.style.top = String(position.top) + "px";
	marker.style.width = String(position.width) + "px";
	marker.style.height = String(position.height) + "px";
	marker.style.outline = "2px solid rgba(14,165,233,.9)";
	marker.style.background = "rgba(14,165,233,.18)";
	const label = document.createElement("div");
	label.dataset.reverseSynctexHover = "label";
	label.style.position = "absolute";
	label.style.pointerEvents = "none";
	label.style.zIndex = "100002";
	label.style.left = String(Math.max(0, position.left)) + "px";
	label.style.top = String(Math.max(0, position.top - 28)) + "px";
	label.style.maxWidth = "min(60ch, 80vw)";
	label.style.padding = "3px 6px";
	label.style.borderRadius = "4px";
	label.style.background = "rgba(15,23,42,.9)";
	label.style.color = "white";
	label.style.font = "12px/1.3 sans-serif";
	label.style.whiteSpace = "pre-line";
	label.textContent = hoverDiagnosticsLabel(message);
	page.append(marker, label);
}

function sendReverseSynctexForwardProbe(event, pageNumber, pageElement, canvas, viewport) {
	if (!reverseSynctexHoverEnabled || !viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return;
	if ((window.getSelection()?.toString() ?? "").length > 0) return;
	const rect = canvas.getBoundingClientRect();
	const point = viewport.convertToPdfPoint(event.clientX - rect.left, canvas.offsetHeight - (event.clientY - rect.top));
	const requestId = reverseSynctexForwardProbeRequestId + 1;
	reverseSynctexForwardProbeRequestId = requestId;
	reverseSynctexForwardProbeLatestRequestId = requestId;
	removeReverseSynctexForwardProbeOverlay();
	viewerSocket.send(JSON.stringify({ type: "reverse_synctex_forward_probe", request_id: requestId, page: pageNumber, x: point[0], y: point[1], ...reverseSynctexContextForPage(pageElement, canvas, viewport) }));
}

function scheduleReverseSynctexHover(event, pageNumber, pageElement, canvas, viewport) {
	if (!reverseSynctexHoverEnabled || !viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return;
	const rect = canvas.getBoundingClientRect();
	const point = viewport.convertToPdfPoint(event.clientX - rect.left, canvas.offsetHeight - (event.clientY - rect.top));
	const requestId = reverseSynctexHoverRequestId + 1;
	reverseSynctexHoverRequestId = requestId;
	reverseSynctexHoverLatestRequestId = requestId;
	reverseSynctexHoverPending = { request_id: requestId, page: pageNumber, x: point[0], y: point[1], ...reverseSynctexContextForPage(pageElement, canvas, viewport) };
	if (reverseSynctexHoverTimer !== undefined) return;
	reverseSynctexHoverTimer = setTimeout(() => {
		reverseSynctexHoverTimer = undefined;
		const pending = reverseSynctexHoverPending;
		reverseSynctexHoverPending = undefined;
		if (!reverseSynctexHoverEnabled || !pending || !viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return;
		viewerSocket.send(JSON.stringify({ type: "reverse_synctex_hover", request_id: pending.request_id, page: pending.page, x: pending.x, y: pending.y, ...(pending.textBeforeSelection ? { textBeforeSelection: pending.textBeforeSelection } : {}), ...(pending.textAfterSelection ? { textAfterSelection: pending.textAfterSelection } : {}) }));
	}, REVERSE_SYNCTEX_HOVER_THROTTLE_MS);
}

async function renderPdf(config) {
	activeConfig = config;
	if (fallback) fallback.href = config.pdf_url;
	pageViewports.clear();
	pages.replaceChildren();
	setStatus("Loading PDF " + config.pdf_id + " revision " + config.revision + " through PDF.js…");
	const pdfjsLib = await import("/assets/pdf.mjs");
	pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";
	const pdf = await pdfjsLib.getDocument({ url: config.pdf_url }).promise;
	for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
		const page = await pdf.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 1.25 });
		pageViewports.set(pageNumber, viewport);
		const canvas = document.createElement("canvas");
		canvas.width = viewport.width;
		canvas.height = viewport.height;
		canvas.dataset.pageNumber = String(pageNumber);
		const pageContainer = document.createElement("div");
		pageContainer.style.position = "relative";
		pageContainer.style.width = String(viewport.width) + "px";
		pageContainer.style.margin = "1rem auto";
		pageContainer.dataset.pageNumber = String(pageNumber);
		pageContainer.appendChild(canvas);
		await renderTextLayer(pdfjsLib, page, viewport, pageContainer);
		pageContainer.addEventListener("mousedown", () => {
			pendingSelectionMouseDownDebug = selectionDebugSnapshot("mousedown", pageNumber);
			pendingReverseSynctexContexts.set(pageContainer, { ...reverseSynctexContextForPage(pageContainer, canvas, viewport), selectionGeneration });
		}, true);
		pageContainer.addEventListener("mouseup", () => {
			if ((window.getSelection()?.toString() ?? "").length > 0 && pendingSelectionMouseDownDebug !== undefined) {
				sendSelectionDebugDetails("mousedown", pageNumber, pendingSelectionMouseDownDebug);
			}
			pendingSelectionMouseDownDebug = undefined;
			sendSelectionDebug("mouseup", pageNumber);
			scheduleReverseSynctexSelectionSend(pageNumber, pageContainer, canvas, viewport);
		}, true);
		pageContainer.addEventListener("mousemove", (event) => scheduleReverseSynctexHover(event, pageNumber, pageContainer, canvas, viewport));
		pageContainer.addEventListener("mouseleave", () => {
			reverseSynctexHoverLatestRequestId += 1;
			reverseSynctexHoverPending = undefined;
			removeReverseSynctexHoverOverlay();
		});
		pageContainer.addEventListener("click", (event) => {
			if (!event.ctrlKey) {
				sendReverseSynctexForwardProbe(event, pageNumber, pageContainer, canvas, viewport);
				return;
			}
			removeReverseSynctexHoverOverlay();
			removeReverseSynctexForwardProbeOverlay();
			if (!viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return;
			const rect = canvas.getBoundingClientRect();
			const pendingTextSelection = pendingReverseSynctexContexts.get(pageContainer) || {};
			pendingReverseSynctexContexts.delete(pageContainer);
			const currentTextSelection = { ...reverseSynctexContextForPage(pageContainer, canvas, viewport), selectionGeneration };
			const textSelection = hasReverseSynctexContext(pendingTextSelection) ? pendingTextSelection : currentTextSelection;
			const selectionSignature = reverseSynctexSelectionSignature(pageNumber, textSelection);
			if (wasSelectionAlreadySent(selectionSignature, textSelection.selectionGeneration)) {
				sendSelectionDebug("suppress", pageNumber, { suppressionReason: "already_sent_click", signature: selectionSignature, generation: textSelection.selectionGeneration, selectedPayloadText: boundedSelectionDebugText(textSelection.selectedText), selectedPayloadTextLength: textSelection.selectedText?.length });
				return;
			}
			if (textSelection.selectedText !== undefined && textSelection.selectionStartX !== undefined && textSelection.selectionStartY !== undefined && textSelection.selectionEndX !== undefined && textSelection.selectionEndY !== undefined) {
				rememberSentSelection(selectionSignature, textSelection.selectionGeneration);
				const payload = reverseSynctexSelectionPayload(pageNumber, textSelection);
				sendSelectionDebug("send", pageNumber, { signature: selectionSignature, generation: textSelection.selectionGeneration, selectedPayloadText: boundedSelectionDebugText(payload.selectedText), selectedPayloadTextLength: payload.selectedText.length, selectionStartX: payload.selectionStartX, selectionStartY: payload.selectionStartY, selectionEndX: payload.selectionEndX, selectionEndY: payload.selectionEndY });
				viewerSocket.send(JSON.stringify(payload));
				setTimeout(() => {
					const currentText = window.getSelection()?.toString() ?? "";
					sendSelectionDebug("post_send_audit", pageNumber, { sentText: boundedSelectionDebugText(payload.selectedText), sentTextLength: payload.selectedText.length, currentText: boundedSelectionDebugText(currentText), currentTextLength: currentText.length, changed: currentText !== payload.selectedText });
				}, 300);
				return;
			}
			const payload = reverseSynctexPayloadFromViewportPoint({
				page: pageNumber,
				viewportX: event.clientX - rect.left,
				viewportY: event.clientY - rect.top,
				viewportHeight: canvas.offsetHeight,
				viewport,
				...textSelection,
			});
			viewerSocket.send(JSON.stringify(payload));
		});
		pages.appendChild(pageContainer);
		await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
		canvas.dataset.rendered = "true";
	}
	setStatus("Loaded PDF " + config.pdf_id + " revision " + config.revision + ": " + pdf.numPages + " page(s)");
}

function visibleSynctexRectDimension(value) {
	return Math.max(value, 2);
}

function forwardSynctexMarkerFromPdfRange(input) {
	const leftTop = input.viewport.convertToViewportPoint(input.h, input.v - input.H);
	const rightBottom = input.viewport.convertToViewportPoint(input.h + input.W, input.v);
	return {
		left: leftTop[0],
		top: input.pageHeight - leftTop[1],
		width: visibleSynctexRectDimension(rightBottom[0] - leftTop[0]),
		height: visibleSynctexRectDimension(leftTop[1] - rightBottom[1]),
	};
}

function scrollToUnionInViewport(markers) {
	const page = markers[0]?.parentNode;
	if (!page || !(page instanceof HTMLElement)) return;
	let left = Infinity;
	let right = -Infinity;
	let top = Infinity;
	let bottom = -Infinity;
	for (const marker of markers) {
		const bounds = marker.getBoundingClientRect();
		left = Math.min(left, bounds.left);
		right = Math.max(right, bounds.right);
		top = Math.min(top, bounds.top);
		bottom = Math.max(bottom, bounds.bottom);
	}
	if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) return;
	window.scrollTo({
		left: window.scrollX + (left + right) / 2 - window.innerWidth / 2,
		top: window.scrollY + (top + bottom) / 2 - window.innerHeight * 0.4,
	});
}

function showReverseSynctexForwardProbeResult(message) {
	if (!reverseSynctexHoverEnabled || Number(message.request_id) !== reverseSynctexForwardProbeLatestRequestId) return;
	removeReverseSynctexForwardProbeOverlay();
	if (message.error || message.page === undefined || message.x === undefined || message.y === undefined) return;
	const pageNumber = Number(message.page);
	const page = pages.querySelector("[data-page-number='" + String(pageNumber) + "']");
	const viewport = pageViewports.get(pageNumber);
	if (!page || !viewport) return;
	const ranges = Array.isArray(message.ranges) ? message.ranges : [];
	const rectRanges = ranges.filter((entry) => Number(entry.page) === pageNumber);
	const scalarRectPosition = rectRanges.length === 0 && message.width !== undefined && message.height !== undefined
		? forwardSynctexMarkerFromPdfPoint({ pdfX: message.x, pdfY: message.y, width: message.width, height: message.height, pageHeight: page.getBoundingClientRect().height, viewport })
		: undefined;
	const positions = scalarRectPosition === undefined ? rectRanges.map((range) => forwardSynctexMarkerFromPdfRange({
		h: Number(range.h),
		v: Number(range.v),
		W: Number(range.W),
		H: Number(range.H),
		pageHeight: page.getBoundingClientRect().height,
		viewport,
	})) : [scalarRectPosition];
	if (positions.length === 0) positions.push(forwardSynctexMarkerFromPdfPoint({ pdfX: message.x, pdfY: message.y, pageHeight: page.getBoundingClientRect().height, viewport }));
	const markers = [];
	for (const position of positions) {
		const marker = document.createElement("div");
		marker.dataset.reverseSynctexForwardProbe = "marker";
		marker.style.position = "absolute";
		marker.style.pointerEvents = "none";
		marker.style.zIndex = "100003";
		marker.style.left = String(position.left) + "px";
		marker.style.top = String(position.top) + "px";
		if (position.width === undefined || position.height === undefined) {
			marker.dataset.synctexMarkerKind = "circle";
			marker.style.border = "0.2em solid red";
			marker.style.borderRadius = "50%";
			marker.style.background = "rgba(255,0,0,0.4)";
			marker.style.transform = "translate(-50%, -50%)";
			marker.style.width = "0.5em";
			marker.style.height = "0.5em";
		} else {
			marker.dataset.synctexMarkerKind = "rect";
			marker.style.width = String(position.width) + "px";
			marker.style.height = String(position.height) + "px";
			marker.style.background = "rgba(239,68,68,.18)";
		}
		markers.push(marker);
		page.appendChild(marker);
	}
	const label = document.createElement("div");
	label.dataset.reverseSynctexForwardProbe = "label";
	label.style.position = "absolute";
	label.style.pointerEvents = "none";
	label.style.zIndex = "100004";
	label.style.left = String(Math.max(0, positions[0].left)) + "px";
	label.style.top = String(Math.max(0, positions[0].top - 28)) + "px";
	label.style.padding = "3px 6px";
	label.style.borderRadius = "4px";
	label.style.background = "rgba(127,29,29,.92)";
	label.style.color = "white";
	label.style.font = "12px/1.3 sans-serif";
	label.textContent = "reverse line " + String(message.reverse_line || message.line || "?") + " -> forward boxes";
	page.appendChild(label);
	scrollToUnionInViewport(markers);
}

function showSynctexMarker(message) {
	const pageNumber = Number(message.page);
	const page = pages.querySelector("[data-page-number='" + String(pageNumber) + "']");
	const viewport = pageViewports.get(pageNumber);
	if (!page || !viewport) return;
	const existing = document.querySelectorAll("[data-synctex-marker]");
	for (const marker of existing) marker.remove();

	const ranges = Array.isArray(message.ranges) ? message.ranges : [];
	const rectRanges = ranges.filter((entry) => Number(entry.page) === pageNumber);
	const scalarRectPosition = rectRanges.length === 0 && message.width !== undefined && message.height !== undefined
		? forwardSynctexMarkerFromPdfPoint({ pdfX: message.x, pdfY: message.y, width: message.width, height: message.height, pageHeight: page.getBoundingClientRect().height, viewport })
		: undefined;
	const isCircle = rectRanges.length === 0 && scalarRectPosition === undefined;
	if (isCircle) {
		const marker = document.createElement("div");
		marker.dataset.synctexMarker = "true";
		marker.tabIndex = -1;
		marker.style.position = "absolute";
		marker.style.pointerEvents = "none";
		marker.style.zIndex = "100000";
		const position = forwardSynctexMarkerFromPdfPoint({ pdfX: message.x, pdfY: message.y, pageHeight: page.getBoundingClientRect().height, viewport });
		marker.dataset.synctexMarkerKind = "circle";
		marker.style.left = String(position.left) + "px";
		marker.style.top = String(position.top) + "px";
		marker.style.border = "0.2em solid red";
		marker.style.borderRadius = "50%";
		marker.style.background = "rgba(255,0,0,0.4)";
		marker.style.transform = "translate(-50%, -50%)";
		marker.style.opacity = "0.8";
		marker.style.width = "0.5em";
		marker.style.height = "0.5em";
		page.appendChild(marker);
		scrollToUnionInViewport([marker]);
		marker.focus({ preventScroll: true });
		return;
	}

	const markers = [];
	const positions = scalarRectPosition === undefined ? rectRanges.map((range) => forwardSynctexMarkerFromPdfRange({
		h: Number(range.h),
		v: Number(range.v),
		W: Number(range.W),
		H: Number(range.H),
		pageHeight: page.getBoundingClientRect().height,
		viewport,
	})) : [scalarRectPosition];
	for (const position of positions) {
		const marker = document.createElement("div");
		marker.dataset.synctexMarker = "true";
		marker.tabIndex = -1;
		marker.style.position = "absolute";
		marker.style.pointerEvents = "none";
		marker.style.zIndex = "100000";
		marker.dataset.synctexMarkerKind = "rect";
		marker.style.left = String(position.left) + "px";
		marker.style.top = String(position.top) + "px";
		marker.style.width = String(position.width) + "px";
		marker.style.height = String(position.height) + "px";
		marker.style.border = "0";
		marker.style.borderRadius = "0";
		marker.style.background = "rgba(239,68,68,.18)";
		markers.push(marker);
		page.appendChild(marker);
	}
	if (markers.length === 0) return;
	scrollToUnionInViewport(markers);
	markers[0].focus({ preventScroll: true });
}

function connectViewerSocket(config) {
	if (!config.viewer_socket_url || !("WebSocket" in window)) return;
	viewerSocket = new WebSocket(config.viewer_socket_url);
	viewerSocket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.type === "pdf_refresh") {
			const nextConfig = { ...activeConfig, revision: message.revision, pdf_url: message.pdf_url };
			void renderPdf(nextConfig).catch(reportViewerError);
		} else if (message.type === "synctex_forward") {
			showSynctexMarker(message);
		} else if (message.type === "reverse_synctex_hover_result") {
			showReverseSynctexHoverResult(message);
		} else if (message.type === "reverse_synctex_forward_probe_result") {
			showReverseSynctexForwardProbeResult(message);
		}
	});
}

const hoverToggle = document.getElementById("synctex-hover-toggle");
if (hoverToggle) hoverToggle.addEventListener("click", () => setReverseSynctexHoverEnabled(!reverseSynctexHoverEnabled));
setReverseSynctexHoverEnabled(false);

fetch(configUrl)
	.then((response) => {
		if (!response.ok) throw new Error("config request failed: " + response.status);
		return response.json();
	})
	.then((config) => {
		connectViewerSocket(config);
		return renderPdf(config);
	})
	.catch((error) => {
		reportViewerError(error);
	});
`;

export interface ViewerHostFileSystem {
	stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
	createReadStream(path: string): Readable;
}

export interface ViewerHostViewerDispatch {
	openPdf(record: ViewerHostPdfRecord): Promise<void> | void;
	focusPdf(record: ViewerHostPdfRecord): Promise<void> | void;
	synctexForward(message: ViewerHostSynctexForwardMessage, record: ViewerHostPdfRecord): Promise<void> | void;
}

export interface ViewerHostControlStatus {
	ready: boolean;
	protocolVersion?: number;
}

export interface ViewerHostPdfChangeDetectionOptions {
	debounceMs?: number;
	pollIntervalMs?: number;
	nowMs?: () => number;
}

export interface ViewerHostPdfRefreshDiagnostic {
	pdf_id: number;
	status: "error";
	code: "pdf_not_readable" | "pdf_not_regular_file";
	message: string;
}

interface ViewerClientTabEvent {
	type: "open_pdf" | "focus_pdf";
	pdf_id: number;
	title: string;
	revision: number;
	viewer_url: string;
	visible_tab_token: string;
}

interface ViewerSocketConnection {
	pdfId: number;
	socket: Socket;
	buffer: Buffer;
	closed: boolean;
}

interface PendingPdfRefreshSnapshot {
	snapshot: ViewerHostFileSnapshot;
	observedAtMs: number;
}

export interface ViewerHostServerOptions {
	registry: ViewerHostPdfRegistry;
	port?: number;
	fileSystem?: ViewerHostFileSystem;
	viewerDispatch?: ViewerHostViewerDispatch;
	verifyPdfMaybeUpdated?: (record: ViewerHostPdfRecord) => Promise<void> | void;
	mcpEventSink?: (message: ViewerHostToMcpMessage) => Promise<void> | void;
	pdfChangeDetection?: ViewerHostPdfChangeDetectionOptions;
}

export interface ViewerHostServerAddress {
	host: "127.0.0.1";
	port: number;
}

export class ViewerHostServer {
	private readonly registry: ViewerHostPdfRegistry;
	private readonly port: number;
	private readonly fileSystem: ViewerHostFileSystem;
	private readonly viewerDispatch: ViewerHostViewerDispatch;
	private readonly verifyPdfMaybeUpdated: (record: ViewerHostPdfRecord) => Promise<void> | void;
	private readonly mcpEventSink: (message: ViewerHostToMcpMessage) => Promise<void> | void;
	private readonly pdfChangeDebounceMs: number;
	private readonly pdfChangePollIntervalMs: number;
	private readonly nowMs: () => number;
	private controlReady = false;
	private controlProtocolVersion: number | undefined;
	private server: Server | undefined;
	private activeSockets = new Set<Socket>();
	private appEventClients = new Set<ServerResponse>();
	private readonly mcpEventBacklog: ViewerHostToMcpMessage[] = [];
	private viewerSocketClientsByPdfId = new Map<number, Set<ViewerSocketConnection>>();
	private viewerSocketTokensByPdfId = new Map<number, string>();
	private visibleViewerClientTabs = new Map<number, ViewerClientTabEvent>();
	private pendingPdfRefreshSnapshots = new Map<number, PendingPdfRefreshSnapshot>();
	private pdfRefreshDiagnostics = new Map<number, ViewerHostPdfRefreshDiagnostic>();
	private pdfChangePollTimer: ReturnType<typeof setInterval> | undefined;
	private pdfChangePollInFlight = false;
	private nextVisibleTabToken = 1;
	private originValue: string | undefined;
	private addressValue: ViewerHostServerAddress | undefined;

	constructor(options: ViewerHostServerOptions) {
		this.registry = options.registry;
		this.port = options.port ?? DEFAULT_PORT;
		this.fileSystem = options.fileSystem ?? { stat: statFile, createReadStream };
		this.viewerDispatch = options.viewerDispatch ?? NOOP_VIEWER_DISPATCH;
		this.verifyPdfMaybeUpdated = options.verifyPdfMaybeUpdated ?? (() => undefined);
		this.mcpEventSink = options.mcpEventSink ?? (() => undefined);
		this.pdfChangeDebounceMs = nonNegativeNumber(options.pdfChangeDetection?.debounceMs, 250);
		this.pdfChangePollIntervalMs = nonNegativeNumber(options.pdfChangeDetection?.pollIntervalMs, 1_000);
		this.nowMs = options.pdfChangeDetection?.nowMs ?? (() => Date.now());
	}

	get origin(): string {
		if (!this.originValue) throw new Error("Viewer Host Server is not started");
		return this.originValue;
	}

	get address(): ViewerHostServerAddress {
		if (!this.addressValue) throw new Error("Viewer Host Server is not started");
		return this.addressValue;
	}

	get controlStatus(): ViewerHostControlStatus {
		return {
			ready: this.controlReady,
			...(this.controlProtocolVersion === undefined ? {} : { protocolVersion: this.controlProtocolVersion }),
		};
	}

	pdfUrl(pdfId: number, revision: number): string {
		return `${this.origin}/pdf/${pdfId}?revision=${revision}`;
	}

	getConnectedViewerCount(pdfId: number): number {
		this.registry.getPdf(pdfId);
		return this.viewerSocketClientsByPdfId.get(pdfId)?.size ?? 0;
	}

	sendPdfRefresh(pdfId: number): number {
		const record = this.registry.getPdf(pdfId);
		return this.broadcastViewerSocketMessage(record.pdfId, { type: "pdf_refresh", pdf_id: record.pdfId, revision: record.revision, pdf_url: this.pdfUrl(record.pdfId, record.revision) });
	}

	getPdfRefreshDiagnostic(pdfId: number): ViewerHostPdfRefreshDiagnostic | undefined {
		this.registry.getPdf(pdfId);
		const diagnostic = this.pdfRefreshDiagnostics.get(pdfId);
		return diagnostic ? { ...diagnostic } : undefined;
	}

	async verifyPdfChangesNow(pdfId?: number): Promise<void> {
		const records = pdfId === undefined ? this.registry.listPdfs() : [this.registry.getPdf(pdfId)];
		for (const record of records) {
			await this.verifyPdfRecordSnapshot(record);
		}
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((request, response) => {
			void this.handleHttpRequest(request, response).catch(() => {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				textResponse(response, 500, "text/plain; charset=utf-8", "viewer host request failed", request.method === "HEAD");
			});
		});
		server.on("connection", (socket) => {
			this.activeSockets.add(socket);
			socket.once("close", () => this.activeSockets.delete(socket));
		});
		server.on("upgrade", (request, socket, head) => {
			this.handleViewerSocketUpgrade(request, socket as Socket, head);
		});
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ host: LOCAL_HOST, port: this.port }, () => {
					server.off("error", reject);
					resolve();
				});
			});
		} catch (error) {
			this.server = undefined;
			this.originValue = undefined;
			this.addressValue = undefined;
			for (const socket of this.activeSockets) socket.destroy();
			throw error;
		}
		const address = server.address() as AddressInfo | null;
		if (!address || typeof address === "string") {
			throw new Error("Viewer Host Server did not expose a TCP address");
		}
		this.addressValue = { host: LOCAL_HOST, port: address.port };
		this.originValue = `http://${LOCAL_HOST}:${address.port}`;
		this.startPdfChangePolling();
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.originValue = undefined;
		this.addressValue = undefined;
		this.controlReady = false;
		this.controlProtocolVersion = undefined;
		this.visibleViewerClientTabs.clear();
		this.mcpEventBacklog.splice(0);
		this.pendingPdfRefreshSnapshots.clear();
		this.pdfRefreshDiagnostics.clear();
		this.stopPdfChangePolling();
		this.viewerSocketClientsByPdfId.clear();
		this.viewerSocketTokensByPdfId.clear();
		for (const socket of this.activeSockets) {
			socket.destroy();
		}
		this.appEventClients.clear();
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${LOCAL_HOST}`);
		if (requestUrl.pathname === "/control") {
			await this.handleControlRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/app-events") {
			this.handleAppEventsRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/app-tab-closed") {
			await this.handleAppTabClosedRequest(request, response);
			return;
		}
		if (requestUrl.pathname === "/mcp-events/drain") {
			this.handleMcpEventsDrainRequest(request, response);
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			textResponse(response, 405, "text/plain; charset=utf-8", "method not allowed", false);
			return;
		}

		if (requestUrl.pathname === "/app") {
			this.serveAppShell(response, request.method === "HEAD");
			return;
		}

		const viewerMatch = /^\/viewer\/(\d+)$/.exec(requestUrl.pathname);
		if (viewerMatch) {
			const pdfId = parsePositiveInteger(viewerMatch[1]);
			if (pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id", request.method === "HEAD");
				return;
			}
			this.serveViewerShell(response, pdfId, request.method === "HEAD");
			return;
		}

		const configMatch = /^\/config\/(\d+)\.json$/.exec(requestUrl.pathname);
		if (configMatch) {
			const pdfId = parsePositiveInteger(configMatch[1]);
			if (pdfId === undefined) {
				textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }), request.method === "HEAD");
				return;
			}
			this.serveViewerConfig(response, pdfId, request.method === "HEAD");
			return;
		}

		if (requestUrl.pathname === "/assets/viewer-client-tabs.js") {
			textResponse(response, 200, "text/javascript; charset=utf-8", VIEWER_CLIENT_TABS_SCRIPT, request.method === "HEAD");
			return;
		}

		if (requestUrl.pathname === "/assets/viewer.js") {
			textResponse(response, 200, "text/javascript; charset=utf-8", VIEWER_SCRIPT, request.method === "HEAD");
			return;
		}

		const pdfJsAssetPath = LOCAL_PDFJS_ASSETS.get(requestUrl.pathname);
		if (pdfJsAssetPath !== undefined) {
			this.serveLocalPdfJsAsset(response, pdfJsAssetPath, request.method === "HEAD");
			return;
		}

		const pdfMatch = /^\/pdf\/(\d+)$/.exec(requestUrl.pathname);
		if (pdfMatch) {
			const pdfId = parsePositiveInteger(pdfMatch[1]);
			const revision = parsePositiveInteger(requestUrl.searchParams.get("revision") ?? undefined);
			if (pdfId === undefined || revision === undefined) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id or revision", request.method === "HEAD");
				return;
			}
			await this.servePdf(response, pdfId, revision, request.method === "HEAD");
			return;
		}

		textResponse(response, 404, "text/plain; charset=utf-8", "not found", request.method === "HEAD");
	}

	private handleAppEventsRequest(request: IncomingMessage, response: ServerResponse): void {
		if (request.method !== "GET") {
			textResponse(response, 405, "text/plain; charset=utf-8", "app event stream requires GET", false);
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		this.appEventClients.add(response);
		writeAppEvent(response, { type: "ready" });
		for (const event of this.visibleViewerClientTabs.values()) {
			writeAppEvent(response, event);
		}
		request.once("close", () => this.appEventClients.delete(response));
	}

	private async handleAppTabClosedRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			textResponse(response, 405, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "method_not_allowed" }), false);
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "malformed_json" }), false);
			return;
		}
		if (!isAppTabClosedPayload(payload)) {
			textResponse(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "invalid_close_payload" }), false);
			return;
		}
		const current = this.visibleViewerClientTabs.get(payload.pdf_id);
		if (current?.revision === payload.revision && current.viewer_url === payload.viewer_url && current.visible_tab_token === payload.visible_tab_token) {
			this.visibleViewerClientTabs.delete(payload.pdf_id);
		}
		textResponse(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }), false);
	}

	private handleMcpEventsDrainRequest(request: IncomingMessage, response: ServerResponse): void {
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "MCP event drain requires POST" } });
			return;
		}
		const events = this.mcpEventBacklog.splice(0);
		jsonResponse(response, 200, { ok: true, events });
	}

	private serveAppShell(response: ServerResponse, headOnly: boolean): void {
		const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viewer Client</title>
<style>
body{font-family:sans-serif;margin:0;background:#f7f7f7;color:#222}
#viewer-client-app{display:flex;flex-direction:column;height:100vh}
header{display:flex;align-items:center;gap:1rem;padding:.5rem .75rem;background:#1f2937;color:white}
h1{font-size:1rem;margin:0;white-space:nowrap}
[role=tablist]{display:flex;gap:.25rem;overflow:auto}
.tab-item{display:flex;background:#374151;border-radius:.25rem;overflow:hidden}
button{font:inherit}
[role=tab],button[data-close-pdf-id]{border:0;color:white;background:transparent;padding:.35rem .55rem;cursor:pointer}
[role=tab][aria-selected=true]{background:#f7f7f7;color:#111827}
button[data-close-pdf-id]{border-left:1px solid #4b5563}
#empty-state{margin:2rem;text-align:center;color:#555}
#viewer-panels{flex:1;min-height:0}
[role=tabpanel]{height:100%}
iframe{width:100%;height:100%;border:0;background:white}
</style>
</head>
<body>
<main id="viewer-client-app">
<header>
<h1>Viewer Client</h1>
<nav id="tab-list" role="tablist" aria-label="Open PDFs"></nav>
</header>
<p id="empty-state">No PDF is open.</p>
<div id="viewer-panels"></div>
</main>
<script type="module" src="/assets/viewer-client-tabs.js"></script>
</body>
</html>`;
		textResponse(response, 200, "text/html; charset=utf-8", body, headOnly);
	}

	private serveViewerShell(response: ServerResponse, pdfId: number, headOnly: boolean): void {
		const record = this.registry.getPdf(pdfId);
		const fallbackUrl = `/pdf/${record.pdfId}?revision=${record.revision}`;
		const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF.js viewer ${pdfId}</title>
<style>body{font-family:sans-serif;margin:1rem;background:#f7f7f7}canvas{display:block;background:white;box-shadow:0 1px 8px #999}#status{margin-bottom:1rem}.textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;text-align:initial;transform-origin:0 0}.textLayer span,.textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}.textLayer ::selection{background:rgba(0,0,255,.25)}</style>
</head>
<body data-config-url="/config/${pdfId}.json">
<h1>PDF.js viewer</h1>
<p id="status">Loading PDF.js viewer for pdf_id=${pdfId}…</p>
<p><button id="synctex-hover-toggle" type="button" aria-pressed="false">SyncTeX hover: off</button> <a id="fallback-link" href="${fallbackUrl}">Open registered PDF bytes directly</a></p>
<div id="pages"></div>
<script>
(function () {
	function setFailure(message) {
		var status = document.getElementById("status");
		if (status) status.textContent = message + " Use the direct PDF link below.";
	}
	window.addEventListener("error", function (event) {
		if (event.target && event.target.tagName === "SCRIPT") {
			setFailure("Unable to load PDF.js viewer script: viewer script failed to load.");
		}
	});
	window.addEventListener("unhandledrejection", function (event) {
		var reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || "unhandled viewer promise rejection");
		setFailure("Unable to load PDF.js viewer script: " + reason + ".");
	});
}());
</script>
<script type="module" src="/assets/viewer.js" onerror="document.getElementById('status').textContent='Unable to load PDF.js viewer script: viewer script failed to load. Use the direct PDF link below.'"></script>
<script nomodule>document.getElementById("status").textContent = "Unable to load PDF.js viewer script: this browser does not support JavaScript modules. Use the direct PDF link below.";</script>
</body>
</html>`;
		textResponse(response, 200, "text/html; charset=utf-8", body, headOnly);
	}

	private serveViewerConfig(response: ServerResponse, pdfId: number, headOnly: boolean): void {
		let record: ViewerHostPdfRecord;
		try {
			record = this.registry.getPdf(pdfId);
		} catch {
			textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }), headOnly);
			return;
		}
		const token = this.viewerSocketTokenForPdf(record.pdfId);
		const viewerSocketUrl = `${this.origin.replace(/^http:/, "ws:")}/viewer-socket?pdf_id=${record.pdfId}&token=${encodeURIComponent(token)}`;
		const body = JSON.stringify({
			pdf_id: record.pdfId,
			revision: record.revision,
			pdf_url: this.pdfUrl(record.pdfId, record.revision),
			viewer_socket_url: viewerSocketUrl,
			ws_url: viewerSocketUrl,
			viewer_socket_token: token,
		});
		textResponse(response, 200, "application/json; charset=utf-8", body, headOnly);
	}

	private serveLocalPdfJsAsset(response: ServerResponse, path: string, headOnly: boolean): void {
		try {
			binaryResponse(response, 200, "text/javascript; charset=utf-8", readFileSync(path), headOnly);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "PDF.js asset is not readable", headOnly);
		}
	}

	private hasRegisteredPdf(pdfId: number): boolean {
		try {
			this.registry.getPdf(pdfId);
			return true;
		} catch {
			return false;
		}
	}

	private async handleControlRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			jsonResponse(response, 405, { ok: false, error: { code: "method_not_allowed", message: "control channel requires POST" } });
			return;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(await readRequestBody(request));
		} catch {
			jsonResponse(response, 400, { ok: false, error: { code: "malformed_json", message: "control request body must be valid JSON" } });
			return;
		}

		let message: ReturnType<typeof validateMcpToViewerHostMessage>;
		try {
			message = validateMcpToViewerHostMessage(payload);
		} catch (error) {
			jsonResponse(response, 400, { ok: false, error: { code: "invalid_message", message: errorMessage(error) } });
			return;
		}

		try {
			jsonResponse(response, 200, await this.dispatchControlMessage(message));
		} catch (error) {
			const message = errorMessage(error);
			const unknownPdf = /^Unknown pdf_id=/.test(message);
			jsonResponse(response, unknownPdf ? 404 : 400, { ok: false, error: { code: unknownPdf ? "unknown_pdf" : "control_dispatch_failed", message } });
		}
	}

	private async dispatchControlMessage(message: ReturnType<typeof validateMcpToViewerHostMessage>): Promise<ViewerHostControlResponse> {
		switch (message.type) {
			case "hello":
				if (message.protocol_version !== VIEWER_HOST_PROTOCOL_VERSION) {
					return { ok: false, error: { code: "unsupported_protocol_version", message: `unsupported protocol_version=${message.protocol_version}` } };
				}
				this.controlReady = true;
				this.controlProtocolVersion = message.protocol_version;
				return { ok: true, message: { type: "ready", protocol_version: VIEWER_HOST_PROTOCOL_VERSION, origin: this.origin } };
			case "open_pdf": {
				const snapshot = await snapshotRegisteredPdf(this.fileSystem, message.pdf_path);
				const revision = this.nextRegistrationRevision(message.pdf_id, message.pdf_path, snapshot);
				const record = this.registry.registerPdf({
					pdfId: message.pdf_id,
					pdfPath: message.pdf_path,
					title: message.title ?? basename(message.pdf_path),
					revision,
					fileSnapshot: snapshot,
					...(message.workspace_cwd === undefined ? {} : { workspaceCwd: message.workspace_cwd }),
				});
				this.pendingPdfRefreshSnapshots.delete(record.pdfId);
				this.pdfRefreshDiagnostics.delete(record.pdfId);
				await this.viewerDispatch.openPdf(record);
				this.broadcastViewerClientTabEvent("open_pdf", record);
				return { ok: true, result: { type: "open_pdf", pdf_id: record.pdfId, revision: record.revision } };
			}
			case "focus_pdf": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.viewerDispatch.focusPdf(record);
				this.broadcastViewerClientTabEvent("focus_pdf", record);
				return { ok: true, result: { type: "focus_pdf", pdf_id: record.pdfId } };
			}
			case "synctex_forward": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.viewerDispatch.synctexForward(message, record);
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "synctex_forward", pdf_id: record.pdfId } };
			}
			case "pdf_maybe_updated": {
				const record = this.registry.getPdf(message.pdf_id);
				await this.verifyPdfChangesNow(record.pdfId);
				await this.verifyPdfMaybeUpdated(record);
				return { ok: true, result: { type: "pdf_maybe_updated", pdf_id: record.pdfId } };
			}
			case "reverse_synctex_hover_result": {
				const record = this.registry.getPdf(message.pdf_id);
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "reverse_synctex_hover_result", pdf_id: record.pdfId } };
			}
			case "reverse_synctex_forward_probe_result": {
				const record = this.registry.getPdf(message.pdf_id);
				this.broadcastViewerSocketMessage(record.pdfId, message);
				return { ok: true, result: { type: "reverse_synctex_forward_probe_result", pdf_id: record.pdfId } };
			}
		}
	}

	private handleViewerSocketUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${LOCAL_HOST}`);
		const pdfId = parsePositiveInteger(requestUrl.searchParams.get("pdf_id") ?? undefined);
		if (requestUrl.pathname !== "/viewer-socket" || pdfId === undefined || !this.hasRegisteredPdf(pdfId)) {
			rejectWebSocketUpgrade(socket, 404, "unknown pdf_id");
			return;
		}
		if (!isAllowedViewerSocketOrigin(request.headers.origin, this.origin)) {
			rejectWebSocketUpgrade(socket, 403, "forbidden origin");
			return;
		}
		const token = requestUrl.searchParams.get("token") ?? "";
		if (token !== this.viewerSocketTokenForPdf(pdfId)) {
			rejectWebSocketUpgrade(socket, 403, "invalid viewer socket token");
			return;
		}
		const headerError = validateWebSocketUpgradeHeaders(request);
		if (headerError) {
			rejectWebSocketUpgrade(socket, 400, headerError);
			return;
		}
		const key = request.headers["sec-websocket-key"] as string;
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"",
			"",
		].join("\r\n"));
		const connection: ViewerSocketConnection = { pdfId, socket, buffer: Buffer.alloc(0), closed: false };
		let clients = this.viewerSocketClientsByPdfId.get(pdfId);
		if (!clients) {
			clients = new Set<ViewerSocketConnection>();
			this.viewerSocketClientsByPdfId.set(pdfId, clients);
		}
		clients.add(connection);
		const cleanup = () => this.cleanupViewerSocket(connection);
		socket.once("close", cleanup);
		socket.once("end", cleanup);
		socket.once("error", cleanup);
		socket.on("data", (chunk) => this.handleViewerSocketData(connection, chunk));
		if (head.length > 0) this.handleViewerSocketData(connection, head);
	}

	private handleViewerSocketData(connection: ViewerSocketConnection, chunk: Buffer): void {
		if (connection.closed) return;
		connection.buffer = Buffer.concat([connection.buffer, chunk]);
		if (connection.buffer.length > MAX_VIEWER_SOCKET_MESSAGE_BYTES + 14) {
			this.closeViewerSocket(connection);
			return;
		}
		while (connection.buffer.length > 0) {
			let frame: { fin: boolean; opcode: number; masked: boolean; payload: Buffer; bytesRead: number } | undefined;
			try {
				frame = readWebSocketFrame(connection.buffer);
			} catch {
				this.closeViewerSocket(connection);
				return;
			}
			if (!frame) return;
			connection.buffer = connection.buffer.subarray(frame.bytesRead);
			if (!frame.fin || !frame.masked) {
				this.closeViewerSocket(connection);
				return;
			}
			if (frame.opcode === 0x8) {
				this.closeViewerSocket(connection);
				return;
			}
			if (frame.opcode === 0x9) {
				sendWebSocketFrame(connection.socket, 0xA, frame.payload);
				continue;
			}
			if (frame.opcode !== 0x1) continue;
			this.handleViewerSocketText(connection, frame.payload.toString("utf8"));
		}
	}

	private handleViewerSocketText(connection: ViewerSocketConnection, text: string): void {
		let payload: unknown;
		try {
			payload = JSON.parse(text);
			if (!isRecord(payload) || (payload.type !== "reverse_synctex" && payload.type !== "selection_debug" && payload.type !== "reverse_synctex_hover" && payload.type !== "reverse_synctex_forward_probe")) return;
			if (payload.pdf_id !== undefined && payload.pdf_id !== connection.pdfId) {
				throw new Error(`${String(payload.type)} pdf_id=${String(payload.pdf_id)} does not match viewer socket pdf_id=${connection.pdfId}`);
			}
			const message = validateViewerHostToMcpMessage({ ...payload, pdf_id: connection.pdfId });
			if (message.type === "reverse_synctex_hover") {
				this.handleReverseSynctexHoverMessage(connection, message);
				return;
			}
			if (message.type === "reverse_synctex_forward_probe") {
				this.handleReverseSynctexForwardProbeMessage(connection, message);
				return;
			}
			this.mcpEventBacklog.push(message);
			void Promise.resolve(this.mcpEventSink(message)).catch((error: unknown) => {
				if (!connection.closed && message.type === "reverse_synctex") sendViewerSocketJson(connection, { type: "error", code: "reverse_synctex_failed", message: errorMessage(error) });
			});
		} catch (error) {
			sendViewerSocketJson(connection, { type: "error", code: "invalid_viewer_message", message: errorMessage(error) });
		}
	}

	private hoverCandidateSummary(candidate: unknown): { source_file?: string; line: number; column?: number; source_line?: string; score?: number; structural?: boolean; distance?: number; distance_x?: number; distance_y?: number } | undefined {
		if (typeof candidate !== "object" || candidate === null) return undefined;
		const record = candidate as Record<string, unknown>;
		if (typeof record.line !== "number") return undefined;
		return {
			...(typeof record.sourceFile === "string" ? { source_file: record.sourceFile } : typeof record.input === "string" ? { source_file: record.input } : {}),
			line: record.line,
			...(typeof record.column === "number" ? { column: record.column } : {}),
			...(typeof record.sourceLine === "string" ? { source_line: record.sourceLine } : {}),
			...(typeof record.score === "number" ? { score: record.score } : {}),
			...(typeof record.structural === "boolean" ? { structural: record.structural } : {}),
			...(typeof record.distance === "number" ? { distance: record.distance } : {}),
			...(typeof record.distanceX === "number" ? { distance_x: record.distanceX } : {}),
			...(typeof record.distanceY === "number" ? { distance_y: record.distanceY } : {}),
		};
	}

	private hoverResultDiagnostics(hover: ReturnType<typeof inspectReverseSynctexHover>): Record<string, unknown> {
		const nearestCandidate = this.hoverCandidateSummary(hover.rawWinner);
		const candidates = hover.topCandidates?.map((candidate) => this.hoverCandidateSummary(candidate)).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
		return {
			...(hover.precision === undefined ? {} : { precision: hover.precision }),
			...(hover.repairedWinner?.score === undefined ? {} : { selected_score: hover.repairedWinner.score }),
			...(nearestCandidate === undefined ? {} : { nearest_candidate: nearestCandidate }),
			...(hover.repairedWinner === undefined ? {} : { repaired: { source_file: hover.repairedWinner.sourceFile, line: hover.repairedWinner.line, column: hover.repairedWinner.column, ...(hover.repairedWinner.sourceLine === undefined ? {} : { source_line: hover.repairedWinner.sourceLine }), precision: hover.repairedWinner.precision, ...(hover.repairedWinner.score === undefined ? {} : { score: hover.repairedWinner.score }) } }),
			...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
			...(hover.forwardVerification === undefined ? {} : { forward: { attempted: hover.forwardVerification.attempted, contains_click: hover.forwardVerification.containsClick, boxes_considered: hover.forwardVerification.boxesConsidered, boxes_filtered: hover.forwardVerification.boxesFiltered, ...(hover.forwardVerification.chosenBox === undefined ? {} : { chosen_box: hover.forwardVerification.chosenBox }) } }),
		};
	}

	private handleReverseSynctexForwardProbeMessage(connection: ViewerSocketConnection, message: Extract<ViewerHostToMcpMessage, { type: "reverse_synctex_forward_probe" }>): void {
		try {
			const record = this.registry.getPdf(connection.pdfId);
			const probeInput = { pdfPath: record.pdfPath, page: message.page, x: message.x, y: message.y, ...(message.textBeforeSelection === undefined ? {} : { textBeforeSelection: message.textBeforeSelection }), ...(message.textAfterSelection === undefined ? {} : { textAfterSelection: message.textAfterSelection }) };
			let probe;
			try {
				probe = mapReverseForwardSynctexProbe({ ...probeInput, cwd: record.workspaceCwd ?? dirname(record.pdfPath) });
			} catch (error) {
				if (record.workspaceCwd === undefined || record.workspaceCwd === dirname(record.pdfPath)) throw error;
				probe = mapReverseForwardSynctexProbe({ ...probeInput, cwd: dirname(record.pdfPath) });
			}
			sendViewerSocketJson(connection, {
				type: "reverse_synctex_forward_probe_result",
				pdf_id: connection.pdfId,
				request_id: message.request_id,
				click_page: message.page,
				click_x: message.x,
				click_y: message.y,
				reverse_source_file: probe.reverse.sourceFile,
				reverse_line: probe.reverse.line,
				reverse_column: probe.reverse.column,
				...(probe.reverse.sourceLine === undefined ? {} : { reverse_source_line: probe.reverse.sourceLine }),
				page: probe.forward.page,
				x: probe.forward.x,
				y: probe.forward.y,
				...(probe.forward.width === undefined ? {} : { width: probe.forward.width }),
				...(probe.forward.height === undefined ? {} : { height: probe.forward.height }),
				...(probe.forward.ranges === undefined ? {} : { ranges: probe.forward.ranges }),
				...(probe.forward.indicator === undefined ? {} : { indicator: probe.forward.indicator }),
				source_file: probe.forward.sourceFile,
				line: probe.forward.line,
			});
		} catch (error) {
			sendViewerSocketJson(connection, { type: "reverse_synctex_forward_probe_result", pdf_id: connection.pdfId, request_id: message.request_id, click_page: message.page, click_x: message.x, click_y: message.y, error: errorMessage(error) });
		}
	}

	private handleReverseSynctexHoverMessage(connection: ViewerSocketConnection, message: Extract<ViewerHostToMcpMessage, { type: "reverse_synctex_hover" }>): void {
		try {
			const record = this.registry.getPdf(connection.pdfId);
			const hoverInput = { pdfPath: record.pdfPath, page: message.page, x: message.x, y: message.y, ...(message.textBeforeSelection === undefined ? {} : { textBeforeSelection: message.textBeforeSelection }), ...(message.textAfterSelection === undefined ? {} : { textAfterSelection: message.textAfterSelection }) };
			let hover;
			try {
				hover = inspectReverseSynctexHover({ ...hoverInput, cwd: record.workspaceCwd ?? dirname(record.pdfPath) });
			} catch (error) {
				if (record.workspaceCwd === undefined || record.workspaceCwd === dirname(record.pdfPath)) throw error;
				hover = inspectReverseSynctexHover({ ...hoverInput, cwd: dirname(record.pdfPath) });
			}
			sendViewerSocketJson(connection, {
				type: "reverse_synctex_hover_result",
				pdf_id: connection.pdfId,
				request_id: message.request_id,
				page: message.page,
				x: message.x,
				y: message.y,
				source_file: hover.sourceFile,
				line: hover.line,
				column: hover.column,
				...(hover.sourceLine === undefined ? {} : { source_line: hover.sourceLine }),
				rect: hover.rect,
				...this.hoverResultDiagnostics(hover),
			});
		} catch (error) {
			sendViewerSocketJson(connection, { type: "reverse_synctex_hover_result", pdf_id: connection.pdfId, request_id: message.request_id, page: message.page, x: message.x, y: message.y, error: errorMessage(error) });
		}
	}

	private closeViewerSocket(connection: ViewerSocketConnection): void {
		if (!connection.closed) sendWebSocketFrame(connection.socket, 0x8, Buffer.alloc(0));
		connection.socket.end();
		this.cleanupViewerSocket(connection);
	}

	private cleanupViewerSocket(connection: ViewerSocketConnection): void {
		if (connection.closed) return;
		connection.closed = true;
		const clients = this.viewerSocketClientsByPdfId.get(connection.pdfId);
		clients?.delete(connection);
		if (clients?.size === 0) this.viewerSocketClientsByPdfId.delete(connection.pdfId);
	}

	private broadcastViewerSocketMessage(pdfId: number, message: object): number {
		const clients = this.viewerSocketClientsByPdfId.get(pdfId);
		if (!clients) return 0;
		let delivered = 0;
		for (const connection of clients) {
			if (connection.closed) continue;
			sendViewerSocketJson(connection, message);
			delivered += 1;
		}
		return delivered;
	}

	private viewerSocketTokenForPdf(pdfId: number): string {
		this.registry.getPdf(pdfId);
		let token = this.viewerSocketTokensByPdfId.get(pdfId);
		if (!token) {
			token = randomBytes(32).toString("base64url");
			this.viewerSocketTokensByPdfId.set(pdfId, token);
		}
		return token;
	}

	private broadcastViewerClientTabEvent(type: ViewerClientTabEvent["type"], record: ViewerHostPdfRecord): void {
		const event: ViewerClientTabEvent = {
			type,
			pdf_id: record.pdfId,
			title: record.title,
			revision: record.revision,
			viewer_url: `/viewer/${record.pdfId}?revision=${record.revision}`,
			visible_tab_token: this.createVisibleTabToken(),
		};
		this.visibleViewerClientTabs.delete(record.pdfId);
		this.visibleViewerClientTabs.set(record.pdfId, event);
		this.broadcastAppEvent(event);
	}

	private createVisibleTabToken(): string {
		const token = `visible-tab-${this.nextVisibleTabToken}`;
		this.nextVisibleTabToken += 1;
		return token;
	}

	private broadcastAppEvent(event: ViewerClientTabEvent | { type: "ready" }): void {
		for (const client of this.appEventClients) {
			writeAppEvent(client, event);
		}
	}

	private nextRegistrationRevision(pdfId: number, pdfPath: string, snapshot: { size: number; mtimeMs: number }): number {
		try {
			const existing = this.registry.getPdf(pdfId);
			return existing.pdfPath === resolve(pdfPath) && isSnapshotMatch(existing.fileSnapshot, snapshot) ? existing.revision : existing.revision + 1;
		} catch {
			return 1;
		}
	}

	private startPdfChangePolling(): void {
		if (this.pdfChangePollIntervalMs <= 0 || this.pdfChangePollTimer) return;
		this.pdfChangePollTimer = setInterval(() => {
			if (this.pdfChangePollInFlight) return;
			this.pdfChangePollInFlight = true;
			void this.verifyPdfChangesNow()
				.catch(() => undefined)
				.finally(() => { this.pdfChangePollInFlight = false; });
		}, this.pdfChangePollIntervalMs);
		this.pdfChangePollTimer.unref?.();
	}

	private stopPdfChangePolling(): void {
		if (!this.pdfChangePollTimer) return;
		clearInterval(this.pdfChangePollTimer);
		this.pdfChangePollTimer = undefined;
		this.pdfChangePollInFlight = false;
	}

	private async verifyPdfRecordSnapshot(record: ViewerHostPdfRecord): Promise<void> {
		let snapshot: ViewerHostFileSnapshot;
		try {
			snapshot = await snapshotRegisteredPdf(this.fileSystem, record.pdfPath);
			await assertRegisteredPdfReadable(this.fileSystem, record.pdfPath);
		} catch (error) {
			this.pendingPdfRefreshSnapshots.delete(record.pdfId);
			this.pdfRefreshDiagnostics.set(record.pdfId, diagnosticForSnapshotError(record.pdfId, error));
			return;
		}

		this.pdfRefreshDiagnostics.delete(record.pdfId);
		if (isSnapshotMatch(record.fileSnapshot, snapshot)) {
			this.pendingPdfRefreshSnapshots.delete(record.pdfId);
			return;
		}

		const pending = this.pendingPdfRefreshSnapshots.get(record.pdfId);
		const now = this.nowMs();
		if (!pending || !isSnapshotMatch(pending.snapshot, snapshot)) {
			this.pendingPdfRefreshSnapshots.set(record.pdfId, { snapshot, observedAtMs: now });
			return;
		}
		if (now - pending.observedAtMs < this.pdfChangeDebounceMs) return;

		this.pendingPdfRefreshSnapshots.delete(record.pdfId);
		this.registry.registerPdf({
			pdfId: record.pdfId,
			pdfPath: record.pdfPath,
			title: record.title,
			revision: record.revision + 1,
			fileSnapshot: snapshot,
		});
		this.sendPdfRefresh(record.pdfId);
	}

	private async servePdf(response: ServerResponse, pdfId: number, revision: number, headOnly: boolean): Promise<void> {
		let record: ViewerHostPdfRecord;
		try {
			record = this.registry.getPdf(pdfId);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id", headOnly);
			return;
		}
		if (revision !== record.revision) {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown revision", headOnly);
			return;
		}

		let fileStatus: Awaited<ReturnType<ViewerHostFileSystem["stat"]>>;
		try {
			fileStatus = await this.fileSystem.stat(record.pdfPath);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not readable", headOnly);
			return;
		}
		if (!fileStatus.isFile()) {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not a regular file", headOnly);
			return;
		}
		if (!isSnapshotMatch(record.fileSnapshot, fileStatus)) {
			textResponse(response, 409, "text/plain; charset=utf-8", "stale PDF snapshot mismatch", headOnly, { "x-viewer-host-error": "stale_pdf_snapshot" });
			return;
		}

		response.writeHead(200, {
			"content-type": "application/pdf",
			"content-length": fileStatus.size,
			"cache-control": "no-store",
			"content-disposition": contentDispositionForPdf(record.title || basename(record.pdfPath)),
		});
		if (headOnly) {
			response.end();
			return;
		}
		const stream = this.fileSystem.createReadStream(record.pdfPath);
		stream.once("error", () => response.destroy());
		response.once("close", () => stream.destroy());
		stream.pipe(response);
	}
}

const NOOP_VIEWER_DISPATCH: ViewerHostViewerDispatch = {
	openPdf() {},
	focusPdf() {},
	synctexForward() {},
};

function rejectWebSocketUpgrade(socket: Socket, status: number, message: string): void {
	const body = `${message}\n`;
	socket.write([
		`HTTP/1.1 ${status} ${webSocketRejectReason(status)}`,
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${Buffer.byteLength(body, "utf8")}`,
		"",
		body,
	].join("\r\n"));
	socket.destroy();
}

function sendViewerSocketJson(connection: ViewerSocketConnection, message: object): void {
	sendWebSocketFrame(connection.socket, 0x1, Buffer.from(JSON.stringify(message), "utf8"));
}

function sendWebSocketFrame(socket: Socket, opcode: number, payload: Buffer): void {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	socket.write(Buffer.concat([header, payload]));
}

function readWebSocketFrame(buffer: Buffer): { fin: boolean; opcode: number; masked: boolean; payload: Buffer; bytesRead: number } | undefined {
	if (buffer.length < 2) return undefined;
	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	const masked = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < offset + 2) return undefined;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined;
		const bigLength = buffer.readBigUInt64BE(offset);
		if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
		length = Number(bigLength);
		offset += 8;
	}
	if (length > MAX_VIEWER_SOCKET_MESSAGE_BYTES) throw new Error("WebSocket frame is too large");
	const maskLength = masked ? 4 : 0;
	if (buffer.length < offset + maskLength + length) return undefined;
	let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
	if (masked) {
		const mask = buffer.subarray(offset, offset + 4);
		const unmasked = Buffer.alloc(payload.length);
		for (let index = 0; index < payload.length; index += 1) {
			unmasked[index] = payload[index] ^ mask[index % 4];
		}
		payload = unmasked;
	}
	return { fin, opcode, masked, payload, bytesRead: offset + maskLength + length };
}

function validateWebSocketUpgradeHeaders(request: IncomingMessage): string | undefined {
	if (String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") return "invalid websocket upgrade";
	const connection = String(request.headers.connection ?? "").toLowerCase().split(",").map((part) => part.trim());
	if (!connection.includes("upgrade")) return "invalid websocket connection header";
	if (request.headers["sec-websocket-version"] !== "13") return "unsupported websocket version";
	const key = request.headers["sec-websocket-key"];
	if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) return "invalid sec-websocket-key";
	return undefined;
}

function isAllowedViewerSocketOrigin(origin: string | undefined, expectedOrigin: string): boolean {
	return origin === undefined || origin === expectedOrigin;
}

function webSocketRejectReason(status: number): string {
	if (status === 400) return "Bad Request";
	if (status === 403) return "Forbidden";
	if (status === 404) return "Not Found";
	return "Rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function snapshotRegisteredPdf(fileSystem: ViewerHostFileSystem, pdfPath: string): Promise<{ size: number; mtimeMs: number }> {
	let fileStatus: Awaited<ReturnType<ViewerHostFileSystem["stat"]>>;
	try {
		fileStatus = await fileSystem.stat(pdfPath);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
	if (!fileStatus.isFile()) {
		throw new ViewerHostSnapshotError("pdf_not_regular_file", "registered PDF is not a regular file");
	}
	return { size: fileStatus.size, mtimeMs: fileStatus.mtimeMs };
}

async function assertRegisteredPdfReadable(fileSystem: ViewerHostFileSystem, pdfPath: string): Promise<void> {
	let stream: Readable;
	try {
		stream = fileSystem.createReadStream(pdfPath);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
	try {
		await waitForReadablePdfOpen(stream);
	} catch (error) {
		throw new ViewerHostSnapshotError("pdf_not_readable", "registered PDF is not readable", error);
	}
}

async function waitForReadablePdfOpen(stream: Readable): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			stream.off("open", succeed);
			stream.off("readable", succeed);
			stream.off("data", succeed);
			stream.off("end", succeed);
			stream.off("error", fail);
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const succeed = () => settle(() => {
			stream.destroy();
			resolve();
		});
		const fail = (error: Error) => settle(() => {
			stream.destroy();
			reject(error);
		});
		stream.once("open", succeed);
		stream.once("readable", succeed);
		stream.once("data", succeed);
		stream.once("end", succeed);
		stream.once("error", fail);
		stream.resume();
	});
}

function writeAppEvent(response: ServerResponse, event: ViewerClientTabEvent | { type: "ready" }): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isAppTabClosedPayload(payload: unknown): payload is { pdf_id: number; revision: number; viewer_url: string; visible_tab_token: string } {
	return typeof payload === "object"
		&& payload !== null
		&& Number.isInteger((payload as { pdf_id?: unknown }).pdf_id)
		&& (payload as { pdf_id: number }).pdf_id > 0
		&& Number.isInteger((payload as { revision?: unknown }).revision)
		&& (payload as { revision: number }).revision > 0
		&& typeof (payload as { viewer_url?: unknown }).viewer_url === "string"
		&& !!(payload as { viewer_url: string }).viewer_url
		&& typeof (payload as { visible_tab_token?: unknown }).visible_tab_token === "string"
		&& !!(payload as { visible_tab_token: string }).visible_tab_token;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > 1_000_000) {
			throw new Error("control request body is too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(json, "utf8"),
		"cache-control": "no-store",
	});
	response.end(json);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class ViewerHostSnapshotError extends Error {
	readonly diagnosticCode: ViewerHostPdfRefreshDiagnostic["code"];

	constructor(diagnosticCode: ViewerHostPdfRefreshDiagnostic["code"], message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ViewerHostSnapshotError";
		this.diagnosticCode = diagnosticCode;
	}
}

function diagnosticForSnapshotError(pdfId: number, error: unknown): ViewerHostPdfRefreshDiagnostic {
	return {
		pdf_id: pdfId,
		status: "error",
		code: error instanceof ViewerHostSnapshotError ? error.diagnosticCode : "pdf_not_readable",
		message: errorMessage(error),
	};
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new Error("PDF change detection timing values must be finite non-negative numbers");
	return value;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function textResponse(response: ServerResponse, status: number, contentType: string, body: string, headOnly: boolean, headers: Record<string, string> = {}): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(body, "utf8"),
		"cache-control": "no-store",
		...headers,
	});
	response.end(headOnly ? undefined : body);
}

function binaryResponse(response: ServerResponse, status: number, contentType: string, body: Buffer, headOnly: boolean): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": body.length,
		"cache-control": "no-store",
	});
	response.end(headOnly ? undefined : body);
}

function isSnapshotMatch(expected: { size: number; mtimeMs: number }, actual: { size: number; mtimeMs: number }): boolean {
	return expected.size === actual.size && expected.mtimeMs === actual.mtimeMs;
}

function contentDispositionForPdf(title: string): string {
	const filename = safePdfFilename(title.endsWith(".pdf") ? title : `${title}.pdf`);
	return `inline; filename="${asciiFallbackFilename(filename)}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

function safePdfFilename(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim() || "document.pdf";
}

function asciiFallbackFilename(value: string): string {
	return safePdfFilename(value).replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "_").trim() || "document.pdf";
}

function rfc5987Encode(value: string): string {
	return encodeURIComponent(value)
		.replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(/\*/g, "%2A");
}

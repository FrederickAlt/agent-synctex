import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import type { PdfJsViewerClient, PdfJsViewerRegistry } from "./pdfjs_viewer_registry.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const require = createRequire(import.meta.url);
const LOCAL_PDFJS_ASSETS = new Map<string, string>([
	["/assets/pdf.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.mjs")],
	["/assets/pdf.worker.mjs", require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")],
]);

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

function wsUrlFromConfig(config) {
	return config.ws_url;
}

let activeConfig;
let activeViewerSocket;
let renderSequence = 0;
const pageViewports = new Map();
const pendingReverseSynctexContexts = new WeakMap();

function pdfUrlForRevision(config) {
	return config.pdf_url;
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

function captureViewerState() {
	return { scrollX: window.scrollX, scrollY: window.scrollY };
}

function restoreViewerState(state) {
	window.scrollTo(state.scrollX, state.scrollY);
}

async function renderPdf(config, options = {}) {
	const sequence = ++renderSequence;
	activeConfig = config;
	const state = options.preserveState ? captureViewerState() : undefined;
	fallback.href = pdfUrlForRevision(config);
	pages.replaceChildren();
	pageViewports.clear();
	setStatus("Loading PDF " + config.pdf_id + " revision " + config.revision + " through PDF.js…");
	const pdfjsLib = await import("/assets/pdf.mjs");
	pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";
	const pdf = await pdfjsLib.getDocument({ url: pdfUrlForRevision(config) }).promise;
	if (sequence !== renderSequence) return;
	setStatus(\`Loaded PDF \${config.pdf_id} revision \${config.revision}: \${pdf.numPages} page(s)\`);
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
			pendingReverseSynctexContexts.set(pageContainer, reverseSynctexContextForPage(pageContainer, canvas, viewport));
		}, true);
		pageContainer.addEventListener("click", (event) => {
			if (!event.ctrlKey) return;
			if (!activeViewerSocket || activeViewerSocket.readyState !== WebSocket.OPEN) return;
			const rect = canvas.getBoundingClientRect();
			const point = viewport.convertToPdfPoint(event.clientX - rect.left, canvas.offsetHeight - (event.clientY - rect.top));
			const pendingTextSelection = pendingReverseSynctexContexts.get(pageContainer) || {};
			pendingReverseSynctexContexts.delete(pageContainer);
			const currentTextSelection = reverseSynctexContextForPage(pageContainer, canvas, viewport);
			const textSelection = hasReverseSynctexContext(pendingTextSelection) ? pendingTextSelection : currentTextSelection;
			activeViewerSocket.send(JSON.stringify({
				type: "reverse_synctex",
				page: pageNumber,
				x: point[0],
				y: point[1],
				...(textSelection.textBeforeSelection === undefined ? {} : { textBeforeSelection: textSelection.textBeforeSelection }),
				...(textSelection.textAfterSelection === undefined ? {} : { textAfterSelection: textSelection.textAfterSelection }),
				...(textSelection.selectedText === undefined ? {} : { selectedText: textSelection.selectedText }),
				...(textSelection.selectionStartX === undefined ? {} : { selectionStartX: textSelection.selectionStartX }),
				...(textSelection.selectionStartY === undefined ? {} : { selectionStartY: textSelection.selectionStartY }),
				...(textSelection.selectionEndX === undefined ? {} : { selectionEndX: textSelection.selectionEndX }),
				...(textSelection.selectionEndY === undefined ? {} : { selectionEndY: textSelection.selectionEndY }),
			}));
		});
		pages.appendChild(pageContainer);
		await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
	}
	if (state) restoreViewerState(state);
}

function viewportScale(viewport) {
	const origin = viewport.convertToViewportPoint(0, 0);
	const xUnit = viewport.convertToViewportPoint(1, 0);
	const yUnit = viewport.convertToViewportPoint(0, 1);
	return { x: Math.abs(xUnit[0] - origin[0]) || 1, y: Math.abs(yUnit[1] - origin[1]) || 1 };
}

function forwardSynctexMarkerFromPdfPoint(input) {
	const point = input.viewport.convertToViewportPoint(input.pdfX, input.pdfY);
	const pageHeight = input.pageHeight ?? input.page.getBoundingClientRect().height;
	const position = { left: point[0], top: pageHeight - point[1] };
	if (input.width === undefined || input.height === undefined) return position;
	const scale = viewportScale(input.viewport);
	return { ...position, width: Number(input.width) * scale.x, height: Number(input.height) * scale.y };
}

function forwardSynctexMarkerFromPdfRange(input) {
	const leftTop = input.viewport.convertToViewportPoint(input.h, input.v - input.H);
	const rightBottom = input.viewport.convertToViewportPoint(input.h + input.W, input.v);
	const pageHeight = input.page.getBoundingClientRect().height;
	return {
		left: leftTop[0],
		top: pageHeight - leftTop[1],
		width: rightBottom[0] - leftTop[0],
		height: leftTop[1] - rightBottom[1],
	};
}

function focusMarkersInUnion(page, markers) {
	let minLeft = Infinity;
	let maxRight = -Infinity;
	let minTop = Infinity;
	let maxBottom = -Infinity;
	for (const marker of markers) {
		const bounds = marker.getBoundingClientRect();
		minLeft = Math.min(minLeft, bounds.left);
		maxRight = Math.max(maxRight, bounds.right);
		minTop = Math.min(minTop, bounds.top);
		maxBottom = Math.max(maxBottom, bounds.bottom);
	}
	if (!Number.isFinite(minLeft) || !Number.isFinite(maxRight) || !Number.isFinite(minTop) || !Number.isFinite(maxBottom)) return;
	const unionCenterX = (minLeft + maxRight) / 2;
	const unionCenterY = (minTop + maxBottom) / 2;
	window.scrollTo({
		left: window.scrollX + unionCenterX - window.innerWidth / 2,
		top: window.scrollY + unionCenterY - window.innerHeight * 0.4,
	});
}

function handleSynctexMessage(message) {
	const pageNumber = Number(message.page);
	const page = document.querySelector("[data-page-number='" + pageNumber + "']");
	const viewport = pageViewports.get(pageNumber);
	if (!page || !viewport) return;
	for (const marker of document.querySelectorAll("[data-synctex-marker]")) {
		marker.remove();
	}
	const ranges = Array.isArray(message.ranges) ? message.ranges : [];
	const rectRanges = ranges.filter((record) => Number(record.page) === pageNumber);
	const scalarRectPosition = rectRanges.length === 0 && message.width !== undefined && message.height !== undefined
		? forwardSynctexMarkerFromPdfPoint({ pdfX: Number(message.x) || 0, pdfY: Number(message.y) || 0, width: message.width, height: message.height, page, viewport })
		: undefined;
	const isCircle = rectRanges.length === 0 && scalarRectPosition === undefined;
	if (isCircle) {
		const marker = document.createElement("div");
		marker.dataset.synctexMarker = "true";
		marker.dataset.synctexMarkerKind = "circle";
		marker.tabIndex = -1;
		marker.style.position = "absolute";
		marker.style.pointerEvents = "none";
		marker.style.zIndex = "100000";
		const position = forwardSynctexMarkerFromPdfPoint({ pdfX: Number(message.x) || 0, pdfY: Number(message.y) || 0, page, viewport });
		marker.style.left = String(position.left) + "px";
		marker.style.top = String(position.top) + "px";
		marker.style.width = "0.5em";
		marker.style.height = "0.5em";
		marker.style.border = "0.2em solid red";
		marker.style.borderRadius = "50%";
		marker.style.background = "rgba(255,0,0,0.4)";
		marker.style.transform = "translate(-50%, -50%)";
		marker.style.opacity = "0.8";
		page.appendChild(marker);
		focusMarkersInUnion(page, [marker]);
		marker.focus({ preventScroll: true });
		setStatus("SyncTeX jump: page " + message.page);
		return;
	}
	const markers = [];
	const positions = scalarRectPosition === undefined ? rectRanges.map((range) => forwardSynctexMarkerFromPdfRange({ h: Number(range.h), v: Number(range.v), W: Number(range.W), H: Number(range.H), page, viewport })) : [scalarRectPosition];
	for (const position of positions) {
		const marker = document.createElement("div");
		marker.dataset.synctexMarker = "true";
		marker.dataset.synctexMarkerKind = "rect";
		marker.tabIndex = -1;
		marker.style.position = "absolute";
		marker.style.pointerEvents = "none";
		marker.style.zIndex = "100000";
		marker.style.left = String(position.left) + "px";
		marker.style.top = String(position.top) + "px";
		marker.style.width = String(position.width) + "px";
		marker.style.height = String(position.height) + "px";
		marker.style.border = "0";
		marker.style.borderRadius = "0";
		marker.style.background = "rgba(255,255,0,0.35)";
		markers.push(marker);
		page.appendChild(marker);
	}
	if (markers.length === 0) return;
	focusMarkersInUnion(page, markers);
	markers[0].focus({ preventScroll: true });
	setStatus("SyncTeX jump: page " + message.page);
}

function connectViewerSocket(config) {
	const ws = new WebSocket(wsUrlFromConfig(config));
	activeViewerSocket = ws;
	ws.addEventListener("message", (event) => {
		try {
			const message = JSON.parse(event.data);
			if (message.type === "pdf_closed") {
				setStatus("This PDF was closed/untracked by the MCP runtime. The browser tab remains open.");
				return;
			}
			if (message.type === "pdf_refresh" && activeConfig && message.pdf_id === activeConfig.pdf_id) {
				const refreshedConfig = Object.assign({}, activeConfig, { revision: message.revision, pdf_url: message.pdf_url });
				setStatus(\`Refreshing PDF \${message.pdf_id} revision \${message.revision}…\`);
				void renderPdf(refreshedConfig, { preserveState: true }).catch((error) => {
					setStatus(\`Unable to refresh PDF \${message.pdf_id}: \${error.message}\`);
				});
				return;
			}
			if (message.type === "synctex") {
				handleSynctexMessage(message);
				return;
			}
			if (message.type === "reverse_synctex_error") {
				setStatus("Reverse SyncTeX failed: " + message.error);
			}
		} catch {
			// Ignore protocol messages this minimal viewer does not understand yet.
		}
	});
}

fetch(configUrl)
	.then((response) => {
		if (!response.ok) throw new Error(\`config request failed: \${response.status}\`);
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

function parsePositivePdfId(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const pdfId = Number(value);
	return Number.isSafeInteger(pdfId) && pdfId > 0 ? pdfId : undefined;
}

function textResponse(response: ServerResponse, status: number, contentType: string, body: string): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": Buffer.byteLength(body, "utf8"),
		"cache-control": "no-store",
	});
	response.end(body);
}

function binaryResponse(response: ServerResponse, status: number, contentType: string, body: Buffer, headOnly: boolean): void {
	response.writeHead(status, {
		"content-type": contentType,
		"content-length": body.length,
		"cache-control": "no-store",
	});
	response.end(headOnly ? undefined : body);
}

function websocketAccept(key: string): string {
	return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function rfc5987Encode(value: string): string {
	return encodeURIComponent(value)
		.replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(/\*/g, "%2A");
}

function safePdfFilename(value: string): string {
	const sanitized = value
		.replace(/[\u0000-\u001f\u007f/\\]/g, "_")
		.trim();
	return sanitized || "document.pdf";
}

function asciiFallbackFilename(value: string): string {
	const sanitized = safePdfFilename(value)
		.replace(/[^\x20-\x7e]/g, "_")
		.replace(/[";\\]/g, "_")
		.trim();
	return sanitized || "document.pdf";
}

function contentDispositionForPdfPath(pdfPath: string): string {
	const filename = safePdfFilename(basename(pdfPath));
	const fallback = asciiFallbackFilename(filename);
	return `inline; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

function encodeWebSocketTextFrame(message: string): Buffer {
	const payload = Buffer.from(message, "utf8");
	if (payload.length < 126) {
		return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
	}
	if (payload.length <= 0xffff) {
		const header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
		return Buffer.concat([header, payload]);
	}
	const header = Buffer.alloc(10);
	header[0] = 0x81;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}

function decodeWebSocketTextFrames(frameBuffer: Buffer): { messages: string[]; remaining: Buffer } {
	const messages: string[] = [];
	let cursor = 0;
	while (cursor + 2 <= frameBuffer.length) {
		const firstByte = frameBuffer[cursor];
		const opcode = firstByte & 0x0f;
		const masked = (frameBuffer[cursor + 1] & 0x80) !== 0;
		let payloadLength = frameBuffer[cursor + 1] & 0x7f;
		let offset = cursor + 2;
		if (payloadLength === 126) {
			if (frameBuffer.length < offset + 2) break;
			payloadLength = frameBuffer.readUInt16BE(offset);
			offset += 2;
		} else if (payloadLength === 127) {
			if (frameBuffer.length < offset + 8) break;
			const bigLength = frameBuffer.readBigUInt64BE(offset);
			if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) break;
			payloadLength = Number(bigLength);
			offset += 8;
		}
		let mask: Buffer | undefined;
		if (masked) {
			if (frameBuffer.length < offset + 4) break;
			mask = frameBuffer.subarray(offset, offset + 4);
			offset += 4;
		}
		const nextCursor = offset + payloadLength;
		if (frameBuffer.length < nextCursor) break;
		if (opcode === 0x01) {
			const payload = Buffer.from(frameBuffer.subarray(offset, nextCursor));
			if (mask) {
				for (let index = 0; index < payload.length; index += 1) {
					payload[index] ^= mask[index % 4];
				}
			}
			messages.push(payload.toString("utf8"));
		}
		cursor = nextCursor;
	}
	return { messages, remaining: frameBuffer.subarray(cursor) };
}

function parseReverseSynctexClick(pdfId: number, rawMessage: string): ReverseSynctexClick | undefined {
	let message: unknown;
	try {
		message = JSON.parse(rawMessage);
	} catch {
		return undefined;
	}
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (record.type !== "reverse_synctex") return undefined;
	const { page, x, y } = record;
	if (!Number.isInteger(page) || (page as number) < 1) return undefined;
	if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return undefined;
	if (typeof y !== "number" || !Number.isFinite(y) || y < 0) return undefined;
	if (record.textBeforeSelection !== undefined && typeof record.textBeforeSelection !== "string") return undefined;
	if (record.textAfterSelection !== undefined && typeof record.textAfterSelection !== "string") return undefined;
	if (record.selectedText !== undefined && typeof record.selectedText !== "string") return undefined;
	for (const field of ["selectionStartX", "selectionStartY", "selectionEndX", "selectionEndY"] as const) {
		if (record[field] !== undefined && (typeof record[field] !== "number" || !Number.isFinite(record[field]) || record[field] < 0)) return undefined;
	}
	return {
		pdfId,
		page: page as number,
		x,
		y,
		...(record.textBeforeSelection === undefined ? {} : { textBeforeSelection: record.textBeforeSelection }),
		...(record.textAfterSelection === undefined ? {} : { textAfterSelection: record.textAfterSelection }),
		...(record.selectedText === undefined ? {} : { selectedText: record.selectedText }),
		...(record.selectionStartX === undefined ? {} : { selectionStartX: record.selectionStartX as number }),
		...(record.selectionStartY === undefined ? {} : { selectionStartY: record.selectionStartY as number }),
		...(record.selectionEndX === undefined ? {} : { selectionEndX: record.selectionEndX as number }),
		...(record.selectionEndY === undefined ? {} : { selectionEndY: record.selectionEndY as number }),
	};
}

class SocketViewerClient implements PdfJsViewerClient {
	private readonly socket: Socket;
	constructor(socket: Socket) {
		this.socket = socket;
	}
	send(message: string): void {
		if (!this.socket.writable) return;
		this.socket.write(encodeWebSocketTextFrame(message));
	}
}

export interface PdfJsViewerFileSystem {
	stat(path: string): Promise<{ size: number; isFile(): boolean }>;
	createReadStream(path: string): Readable;
}

export interface ReverseSynctexClick {
	pdfId: number;
	page: number;
	x: number;
	y: number;
	textBeforeSelection?: string;
	textAfterSelection?: string;
	selectedText?: string;
	selectionStartX?: number;
	selectionStartY?: number;
	selectionEndX?: number;
	selectionEndY?: number;
}

export interface PdfJsViewerServerOptions {
	registry: PdfJsViewerRegistry;
	host?: string;
	port?: number;
	fileSystem?: PdfJsViewerFileSystem;
	onReverseSynctex?: (click: ReverseSynctexClick) => void | Promise<void>;
}

export class PdfJsViewerServer {
	private readonly registry: PdfJsViewerRegistry;
	private readonly host: string;
	private readonly port: number;
	private readonly fileSystem: PdfJsViewerFileSystem;
	private readonly onReverseSynctex: ((click: ReverseSynctexClick) => void | Promise<void>) | undefined;
	private server: Server | null = null;
	private activeSockets = new Set<Socket>();
	private activeWebSockets = new Set<Socket>();
	private originValue: string | undefined;

	constructor(options: PdfJsViewerServerOptions) {
		this.registry = options.registry;
		this.host = options.host ?? DEFAULT_HOST;
		this.port = options.port ?? DEFAULT_PORT;
		this.fileSystem = options.fileSystem ?? {
			stat: statFile,
			createReadStream,
		};
		this.onReverseSynctex = options.onReverseSynctex;
	}

	get origin(): string {
		if (!this.originValue) {
			throw new Error("PDF.js viewer server is not started");
		}
		return this.originValue;
	}

	viewerUrl(pdfId: number): string {
		return `${this.origin}/viewer/${pdfId}`;
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((request, response) => {
			void this.handleHttpRequest(request, response).catch(() => {
				if (!response.headersSent) {
					textResponse(response, 500, "text/plain; charset=utf-8", "viewer server request failed");
				} else {
					response.destroy();
				}
			});
		});
		server.on("connection", (socket) => {
			this.activeSockets.add(socket);
			socket.once("close", () => this.activeSockets.delete(socket));
		});
		server.on("upgrade", (request, socket) => this.handleUpgrade(request, socket as Socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: this.host, port: this.port }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address() as AddressInfo | null;
		if (!address || typeof address === "string") {
			throw new Error("PDF.js viewer server did not expose a TCP address");
		}
		this.originValue = `http://${this.host}:${address.port}`;
	}

	async stop(): Promise<void> {
		for (const socket of this.activeWebSockets) {
			socket.destroy();
		}
		for (const socket of this.activeSockets) {
			socket.destroy();
		}
		const server = this.server;
		this.server = null;
		this.originValue = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
	}

	notifyPdfClosed(pdfId: number): number {
		return this.registry.sendToClients(pdfId, JSON.stringify({ type: "pdf_closed", pdf_id: pdfId }));
	}

	notifyPdfRefresh(pdfId: number, revision: number): number {
		return this.registry.sendToClients(pdfId, JSON.stringify({
			type: "pdf_refresh",
			pdf_id: pdfId,
			revision,
			pdf_url: this.pdfUrl(pdfId, revision),
		}));
	}

	notifySynctex(pdfId: number, target: { page: number; x: number; y: number; width?: number; height?: number; ranges?: Array<{ page: number; h: number; v: number; W: number; H: number }>; source_file: string; line: number }): number {
		return this.registry.sendToClients(pdfId, JSON.stringify({ type: "synctex", pdf_id: pdfId, ...target }));
	}

	pdfUrl(pdfId: number, revision: number): string {
		return `${this.origin}/pdf/${pdfId}?revision=${revision}`;
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${this.host}`);
		if (request.method !== "GET" && request.method !== "HEAD") {
			textResponse(response, 405, "text/plain; charset=utf-8", "method not allowed");
			return;
		}

		const viewerMatch = /^\/viewer\/(\d+)$/.exec(requestUrl.pathname);
		if (viewerMatch) {
			const pdfId = parsePositivePdfId(viewerMatch[1]);
			if (pdfId === undefined || !this.hasActiveRecord(pdfId)) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id");
				return;
			}
			this.serveViewerShell(response, pdfId, request.method === "HEAD");
			return;
		}

		const configMatch = /^\/config\/(\d+)\.json$/.exec(requestUrl.pathname);
		if (configMatch) {
			const pdfId = parsePositivePdfId(configMatch[1]);
			if (pdfId === undefined || !this.hasActiveRecord(pdfId)) {
				textResponse(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pdf_id" }));
				return;
			}
			const record = this.registry.getActiveRecord(pdfId);
			const config = JSON.stringify({
				pdf_id: pdfId,
				revision: record.revision,
				pdf_url: this.pdfUrl(pdfId, record.revision),
				ws_url: `${this.origin.replace(/^http:/, "ws:")}/ws?pdf_id=${pdfId}`,
			});
			textResponse(response, 200, "application/json; charset=utf-8", request.method === "HEAD" ? "" : config);
			return;
		}

		if (requestUrl.pathname === "/assets/viewer.js") {
			textResponse(response, 200, "text/javascript; charset=utf-8", request.method === "HEAD" ? "" : VIEWER_SCRIPT);
			return;
		}

		const pdfJsAssetPath = LOCAL_PDFJS_ASSETS.get(requestUrl.pathname);
		if (pdfJsAssetPath !== undefined) {
			this.serveLocalPdfJsAsset(response, pdfJsAssetPath, request.method === "HEAD");
			return;
		}

		const pdfMatch = /^\/pdf\/(\d+)$/.exec(requestUrl.pathname);
		if (pdfMatch) {
			const pdfId = parsePositivePdfId(pdfMatch[1]);
			if (pdfId === undefined) {
				textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id");
				return;
			}
			await this.servePdf(response, pdfId, request.method === "HEAD");
			return;
		}

		textResponse(response, 404, "text/plain; charset=utf-8", "not found");
	}

	private serveViewerShell(response: ServerResponse, pdfId: number, headOnly: boolean): void {
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
<p><a id="fallback-link" href="/pdf/${pdfId}">Open registered PDF bytes directly</a></p>
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
		textResponse(response, 200, "text/html; charset=utf-8", headOnly ? "" : body);
	}

	private serveLocalPdfJsAsset(response: ServerResponse, path: string, headOnly: boolean): void {
		try {
			binaryResponse(response, 200, "text/javascript; charset=utf-8", readFileSync(path), headOnly);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "PDF.js asset is not readable");
		}
	}

	private async servePdf(response: ServerResponse, pdfId: number, headOnly: boolean): Promise<void> {
		let record;
		try {
			record = this.registry.getActiveRecord(pdfId);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "unknown pdf_id");
			return;
		}
		let fileStatus: Awaited<ReturnType<PdfJsViewerFileSystem["stat"]>>;
		try {
			fileStatus = await this.fileSystem.stat(record.pdfPath);
		} catch {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not readable");
			return;
		}
		if (!fileStatus.isFile()) {
			textResponse(response, 404, "text/plain; charset=utf-8", "registered PDF is not a regular file");
			return;
		}
		response.writeHead(200, {
			"content-type": "application/pdf",
			"content-length": fileStatus.size,
			"cache-control": "no-store",
			"content-disposition": contentDispositionForPdfPath(record.pdfPath),
		});
		if (headOnly) {
			response.end();
			return;
		}
		const stream = this.fileSystem.createReadStream(record.pdfPath);
		stream.once("error", () => {
			response.destroy();
		});
		response.once("close", () => {
			stream.destroy();
		});
		stream.pipe(response);
	}

	private handleUpgrade(request: IncomingMessage, socket: Socket): void {
		const requestUrl = new URL(request.url ?? "/", this.originValue ?? `http://${this.host}`);
		if (requestUrl.pathname !== "/ws") {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		const pdfId = parsePositivePdfId(requestUrl.searchParams.get("pdf_id") ?? undefined);
		if (pdfId === undefined || !this.hasActiveRecord(pdfId)) {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string" || !key.trim()) {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${websocketAccept(key)}`,
			"",
			"",
		].join("\r\n"));
		this.activeWebSockets.add(socket);
		const clientId = this.registry.addClient(pdfId, new SocketViewerClient(socket));
		let cleanedUp = false;
		let webSocketInputBuffer: Buffer = Buffer.alloc(0);
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			webSocketInputBuffer = Buffer.alloc(0);
			this.activeWebSockets.delete(socket);
			this.registry.removeClient(clientId);
		};
		socket.on("data", (chunk) => {
			const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			webSocketInputBuffer = webSocketInputBuffer.length === 0 ? frame : Buffer.concat([webSocketInputBuffer, frame]);
			const firstByte = webSocketInputBuffer.length > 0 ? webSocketInputBuffer[0] : 0;
			const opcode = firstByte & 0x0f;
			if (opcode === 0x08) {
				cleanup();
				socket.end();
				return;
			}
			const decoded = decodeWebSocketTextFrames(webSocketInputBuffer);
			webSocketInputBuffer = decoded.remaining;
			for (const rawMessage of decoded.messages) {
				const click = parseReverseSynctexClick(pdfId, rawMessage);
				if (click === undefined || this.onReverseSynctex === undefined) continue;
				void Promise.resolve()
					.then(() => this.onReverseSynctex!(click))
					.catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						if (socket.writable) {
							socket.write(encodeWebSocketTextFrame(JSON.stringify({ type: "reverse_synctex_error", pdf_id: pdfId, error: message })));
						}
					});
			}
		});
		socket.once("end", cleanup);
		socket.once("close", cleanup);
		socket.once("error", () => {
			cleanup();
			socket.destroy();
		});
	}

	private hasActiveRecord(pdfId: number): boolean {
		try {
			this.registry.getActiveRecord(pdfId);
			return true;
		} catch {
			return false;
		}
	}
}

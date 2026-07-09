/*
 * Host adapter for the vendored LaTeX Workshop/PDF.js viewer route.
 * This file is original glue for agent-synctex. The surrounding viewer UI files
 * retain their upstream Apache-2.0 (PDF.js) and MIT (LaTeX Workshop) notices.
 */

const configUrl = document.body.dataset.configUrl;

const failedAssetRequests = [];
const MAX_FAILED_ASSET_REQUESTS = 20;

function rememberFailedAssetRequest(value) {
  if (!value || failedAssetRequests.length >= MAX_FAILED_ASSET_REQUESTS) return;
  failedAssetRequests.push(String(value));
}

window.addEventListener("error", (event) => {
  const target = event.target;
  if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement || target instanceof HTMLImageElement) {
    rememberFailedAssetRequest(target.src || target.href || target.currentSrc);
  }
}, true);

globalThis.viewerTrim = 0;

function emptyViewerConfig() {
  return { empty: true, revision: 0, title: "PDF Viewer", pdf_url: "", debug_synctex: false };
}

async function loadInitialConfig() {
  if (!configUrl) {
    return emptyViewerConfig();
  }
  const response = await fetch(configUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Host viewer config request failed: ${response.status}`);
  }
  return await response.json();
}

const initialConfig = await loadInitialConfig();
const initialViewerHash = location.hash.startsWith("#") ? location.hash.slice(1) : "";

const HOVER_THROTTLE_MS = 60;
const NAVIGATION_SETTLE_MS = 200;
const MIN_HISTORY_SCROLL_DELTA = 24;
const THEME_STORAGE_KEY = "agent-synctex.pdfViewerTheme";
const TAB_TITLE_STORAGE_KEY = "agent-synctex.pdfTabTitles";
const TAB_ORDER_STORAGE_KEY = "agent-synctex.pdfTabOrder";
const PDF_ANNOTATIONS_STORAGE_KEY = "agent-synctex.pdfAnnotations";
const PDF_VIEWER_THEMES = {
  light: { background: "#ffffff", foreground: "#000000", icon: "☀", label: "Light PDF theme" },
  dark: { background: "#1f2328", foreground: "#f0f3f6", icon: "🌘", label: "Dark PDF theme" },
};
const ANNOTATION_BUBBLE_MAX_HEIGHT_PX = 140;
const ANNOTATION_BUBBLE_MIN_WIDTH_PX = 220;
const ANNOTATION_BUBBLE_DEFAULT_WIDTH_PX = 360;
const ANNOTATION_BUBBLE_VIEWPORT_MARGIN_PX = 12;
const SELECTION_DEBUG_TEXT_MAX_LENGTH = 2000;

const hostState = {
  config: initialConfig,
  visibleRevision: Number(initialConfig.revision),
  latestRevision: Number(initialConfig.revision),
  refreshSerial: 0,
  socketStatus: "disconnected",
  lastError: undefined,
  synctexCapabilityIssue: undefined,
  hoverEnabled: true,
  debugSynctexEnabled: false,
  lastPdfLoadSource: "url",
  compileRunning: false,
  continuousCompile: false,
  compileDiagnostic: undefined,
};
const compileStateByPdfId = new Map();
let activeRefreshLoadingTask;
let activeSocket;
let reconnectTimer;
let selectionGeneration = 0;
let lastSentSelectionSignature;
let lastSentSelectionGeneration = -1;
let pendingSelectionSend;
let hoverTimer;
let pendingHover;
let hoverRequestId = 0;
let latestHoverRequestId = 0;
let probeRequestId = 0;
let latestProbeRequestId = 0;
let pendingProbe;
let outlinePromise;

const synctexOverlayState = {
  forwardMessage: undefined,
  hoverResult: undefined,
  probeResult: undefined,
  redrawTimer: undefined,
};
const annotations = new Map();
let nextAnnotationNumber = 1;
let selectedAnnotationId;
const directViewerTabs = new Map();
const pdfByteCache = new Map();
const MAX_PDF_BYTE_CACHE_ENTRIES = 20;
let directViewerTabsConnected = false;

const navigationHistory = {
  back: [],
  forward: [],
  restoring: false,
  lastSideButton: undefined,
  lastSettledState: undefined,
  pendingSettledTimer: undefined,
  pendingStartState: undefined,
};
const recentRawMouseEvents = [];
const MAX_RAW_MOUSE_EVENTS = 20;
const MAX_NAVIGATION_HISTORY = 50;

function forceShowLaTeXWorkshopChrome() {
  document.querySelector(".toolbar")?.classList.remove("hide");
  document.body.classList.add("host-lw-toolbar-visible");
}

function app() {
  return globalThis.PDFViewerApplication;
}

function pdfViewer() {
  return app()?.pdfViewer;
}

function viewerContainer() {
  return document.getElementById("viewerContainer");
}

function activePdfId() {
  const pdfId = Number((hostState.config ?? initialConfig)?.pdf_id);
  return Number.isInteger(pdfId) && pdfId > 0 ? pdfId : undefined;
}

function hasActiveConfig(config = hostState.config) {
  const pdfId = Number(config?.pdf_id);
  return Number.isInteger(pdfId) && pdfId > 0 && typeof config?.pdf_url === "string" && config.pdf_url.length > 0;
}

function viewerSocketOpen() {
  return activeSocket && activeSocket.readyState === WebSocket.OPEN;
}

function sendViewerSocketPayload(payload) {
  if (!viewerSocketOpen()) return false;
  activeSocket.send(JSON.stringify(payload));
  return true;
}

function viewerLoadedState(extra = {}) {
  const application = app();
  const viewer = application?.pdfViewer;
  const pageInput = document.getElementById("pageNumber");
  const numPages = application?.pdfDocument?.numPages;
  const pagesCount = viewer?.pagesCount;
  const renderedPages = Array.from(document.querySelectorAll("#viewer .page[data-page-number]"));
  const loadedPages = renderedPages.filter((page) => page.getAttribute("data-loaded") === "true").length;
  const canvases = Array.from(document.querySelectorAll("#viewer .page[data-page-number] canvas"));
  const renderedCanvases = canvases.filter((canvas) => canvas.width > 0 && canvas.height > 0).length;
  return {
    initialized: application?.initialized === true,
    pdfDocumentLoaded: !!application?.pdfDocument,
    numPages: typeof numPages === "number" ? numPages : undefined,
    pagesCount: typeof pagesCount === "number" ? pagesCount : undefined,
    renderedPageCount: loadedPages,
    pageElementCount: renderedPages.length,
    canvasCount: canvases.length,
    renderedCanvasCount: renderedCanvases,
    currentPage: application?.page ?? viewer?.currentPageNumber,
    currentPageInput: pageInput?.value,
    currentPageLabel: document.getElementById("numPages")?.textContent ?? document.getElementById("pageNumber")?.getAttribute("max"),
    socketStatus: hostState.socketStatus,
    visibleRevision: hostState.visibleRevision,
    latestRevision: hostState.latestRevision,
    lastError: hostState.lastError,
    activePdfId: activePdfId(),
    lastPdfLoadSource: hostState.lastPdfLoadSource,
    pdfByteCacheEntries: pdfByteCache.size,
    failedAssetRequests: failedAssetRequests.slice(),
    toolsHitTarget: typeof collectToolsHitTargetDiagnostics === "function" ? collectToolsHitTargetDiagnostics() : undefined,
    ...extra,
  };
}

function sendLoadedStateDiagnostic(phase, extra = {}) {
  sendViewerSocketPayload({
    type: "selection_debug",
    phase,
    text: "",
    details: viewerLoadedState(extra),
  });
}

function roundedRect(rect) {
  if (!rect) return undefined;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function describeElementForDiagnostics(element) {
  if (!(element instanceof Element)) return undefined;
  const style = getComputedStyle(element);
  const htmlElement = element instanceof HTMLElement ? element : undefined;
  return {
    tag: element.tagName,
    id: element.id || undefined,
    className: typeof element.className === "string" ? element.className : undefined,
    role: element.getAttribute("role") ?? undefined,
    ariaLabel: element.getAttribute("aria-label") ?? undefined,
    zIndex: style.zIndex,
    pointerEvents: style.pointerEvents,
    position: style.position,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    overflow: style.overflow,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    rect: roundedRect(element.getBoundingClientRect()),
    tabIndex: htmlElement?.tabIndex,
    clientWidth: htmlElement?.clientWidth,
    clientHeight: htmlElement?.clientHeight,
    scrollWidth: htmlElement?.scrollWidth,
    scrollHeight: htmlElement?.scrollHeight,
    scrollLeft: htmlElement?.scrollLeft,
    scrollTop: htmlElement?.scrollTop,
  };
}

function scrollabilityDiagnostics(element) {
  const style = element ? getComputedStyle(element) : undefined;
  return {
    overflow: style?.overflow,
    overflowX: style?.overflowX,
    overflowY: style?.overflowY,
    clientWidth: element?.clientWidth,
    clientHeight: element?.clientHeight,
    scrollWidth: element?.scrollWidth,
    scrollHeight: element?.scrollHeight,
    scrollLeft: element?.scrollLeft,
    scrollTop: element?.scrollTop,
    scrollableX: !!element && element.scrollWidth > element.clientWidth,
    scrollableY: !!element && element.scrollHeight > element.clientHeight,
  };
}

function describeMouseEventForDiagnostics(event, handledDirection) {
  const target = event.target instanceof Element ? event.target : undefined;
  return {
    type: event.type,
    button: event.button,
    buttons: event.buttons,
    which: event.which,
    detail: event.detail,
    target: describeElementForDiagnostics(target),
    defaultPrevented: event.defaultPrevented,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    handledDirection,
  };
}

function rememberRawMouseEvent(event, handledDirection) {
  const diagnostic = describeMouseEventForDiagnostics(event, handledDirection);
  recentRawMouseEvents.push(diagnostic);
  while (recentRawMouseEvents.length > MAX_RAW_MOUSE_EVENTS) recentRawMouseEvents.shift();
  return diagnostic;
}

function collectToolsHitTargetDiagnostics() {
  const container = document.getElementById("secondaryToolbarToggle");
  const button = document.getElementById("secondaryToolbarToggleButton");
  const targetElement = button ?? container;
  const rect = targetElement?.getBoundingClientRect();
  const points = rect ? [
    { name: "left", x: rect.left + rect.width * 0.15, y: rect.top + rect.height / 2 },
    { name: "center", x: rect.left + rect.width * 0.5, y: rect.top + rect.height / 2 },
    { name: "right", x: rect.left + rect.width * 0.9, y: rect.top + rect.height / 2 },
  ] : [];
  let parentInfo;
  try {
    const sameOrigin = !!parent.document;
    const frameRect = frameElement instanceof Element ? frameElement.getBoundingClientRect() : undefined;
    parentInfo = parent && parent !== window ? {
      sameOrigin,
      frameElement: describeElementForDiagnostics(frameElement),
      viewport: { width: parent.innerWidth, height: parent.innerHeight, devicePixelRatio: parent.devicePixelRatio },
      windowScroll: { scrollX: parent.scrollX, scrollY: parent.scrollY, scrollableX: parent.document.documentElement.scrollWidth > parent.innerWidth, scrollableY: parent.document.documentElement.scrollHeight > parent.innerHeight },
      documentElement: scrollabilityDiagnostics(parent.document.documentElement),
      body: scrollabilityDiagnostics(parent.document.body),
      recentRawMouseEvents: typeof parent.__hostAppShellRawMouseDebug === "function" ? parent.__hostAppShellRawMouseDebug() : undefined,
      points: frameRect ? points.map((point) => {
        const parentX = frameRect.left + point.x;
        const parentY = frameRect.top + point.y;
        const hit = parent.document.elementFromPoint(parentX, parentY);
        return { name: point.name, x: parentX, y: parentY, hit: describeElementForDiagnostics(hit) };
      }) : [],
    } : { sameOrigin: false };
  } catch {
    parentInfo = { sameOrigin: false };
  }
  const toolbarRight = document.getElementById("toolbarViewerRight");
  const viewer = viewerContainer();
  const viewerRect = viewer?.getBoundingClientRect();
  const toolsRect = targetElement?.getBoundingClientRect();
  const verticalScrollbarGutter = viewer ? Math.max(0, viewer.offsetWidth - viewer.clientWidth) : 0;
  const viewerScrollbarLeft = viewerRect ? viewerRect.right - verticalScrollbarGutter : undefined;
  return {
    route: location.pathname,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    windowScroll: { scrollX, scrollY, scrollableX: document.documentElement.scrollWidth > innerWidth, scrollableY: document.documentElement.scrollHeight > innerHeight },
    documentElement: scrollabilityDiagnostics(document.documentElement),
    body: scrollabilityDiagnostics(document.body),
    activeElement: describeElementForDiagnostics(document.activeElement),
    focusedElement: describeElementForDiagnostics(document.hasFocus() ? document.activeElement : undefined),
    appShell: parentInfo,
    scrollbarGutter: {
      viewerVerticalWidth: verticalScrollbarGutter,
      viewerScrollbarLeft,
      overlapsToolsRect: !!(toolsRect && viewerRect && verticalScrollbarGutter > 0 && toolsRect.right > (viewerScrollbarLeft ?? viewerRect.right) && toolsRect.left < viewerRect.right && toolsRect.bottom > viewerRect.top && toolsRect.top < viewerRect.bottom),
      toolbarRightGapToViewport: toolbarRight ? innerWidth - toolbarRight.getBoundingClientRect().right : undefined,
      toolsGapToViewport: toolsRect ? innerWidth - toolsRect.right : undefined,
    },
    elements: {
      outerContainer: describeElementForDiagnostics(document.getElementById("outerContainer")),
      mainContainer: describeElementForDiagnostics(document.getElementById("mainContainer")),
      viewerContainer: describeElementForDiagnostics(viewer),
      secondaryToolbarToggle: describeElementForDiagnostics(container),
      secondaryToolbarToggleButton: describeElementForDiagnostics(button),
      secondaryToolbar: describeElementForDiagnostics(document.getElementById("secondaryToolbar")),
      toolbarViewerRight: describeElementForDiagnostics(toolbarRight),
      toolbarContainer: describeElementForDiagnostics(document.getElementById("toolbarContainer")),
      hostSynctexHoverButton: describeElementForDiagnostics(document.getElementById("hostSynctexHoverButton")),
      historyBack: describeElementForDiagnostics(document.getElementById("historyBack")),
      historyForward: describeElementForDiagnostics(document.getElementById("historyForward")),
    },
    recentRawMouseEvents: recentRawMouseEvents.slice(),
    points: points.map((point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      const closestToolsButton = hit instanceof Element ? hit.closest("#secondaryToolbarToggleButton")?.id : undefined;
      const closestToolsContainer = hit instanceof Element ? hit.closest("#secondaryToolbarToggle")?.id : undefined;
      const expectedHit = closestToolsButton === "secondaryToolbarToggleButton" || closestToolsContainer === "secondaryToolbarToggle";
      return {
        ...point,
        hit: describeElementForDiagnostics(hit),
        closestToolsButton,
        closestToolsContainer,
        expectedHit,
        interceptingElement: expectedHit ? undefined : describeElementForDiagnostics(hit),
      };
    }),
  };
}

function sendToolsHitTargetDiagnostic(trigger) {
  sendViewerSocketPayload({
    type: "selection_debug",
    phase: "lw_tools_hit_target",
    text: "",
    details: { trigger, ...collectToolsHitTargetDiagnostics() },
  });
}

globalThis.__hostLwLoadedState = viewerLoadedState;

function conciseRawMouseDiagnosticText(phase, details) {
  if (phase !== "lw_app_shell_raw_mouse_event" && phase !== "lw_raw_mouse_event") return undefined;
  const parts = [];
  if (details.type !== undefined) parts.push(`type=${String(details.type)}`);
  if (details.button !== undefined) parts.push(`button=${String(details.button)}`);
  if (details.buttons !== undefined) parts.push(`buttons=${String(details.buttons)}`);
  if (details.which !== undefined) parts.push(`which=${String(details.which)}`);
  if (details.handledDirection !== undefined) parts.push(`handled=${String(details.handledDirection)}`);
  else parts.push("handled=false");
  return parts.join(" ");
}

function truncateSelectionDebugText(value) {
  const text = String(value ?? "");
  return text.length <= SELECTION_DEBUG_TEXT_MAX_LENGTH
    ? text
    : `${text.slice(0, SELECTION_DEBUG_TEXT_MAX_LENGTH)}… [truncated ${text.length - SELECTION_DEBUG_TEXT_MAX_LENGTH} chars]`;
}

function sanitizeSelectionDebugDetails(details = {}) {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === "string" ? truncateSelectionDebugText(value) : value]));
}

function sendSelectionDebug(phase, page, details = {}) {
  const safeDetails = sanitizeSelectionDebugDetails(details);
  const selectedText = window.getSelection()?.toString() ?? "";
  const text = truncateSelectionDebugText(conciseRawMouseDiagnosticText(phase, safeDetails) ?? selectedText);
  sendViewerSocketPayload({
    type: "selection_debug",
    phase,
    ...(page === undefined ? {} : { page }),
    text,
    details: safeDetails,
  });
}

function pageView(pageNumber) {
  return pdfViewer()?._pages?.[pageNumber - 1];
}

function pageElement(pageNumber) {
  return pageView(pageNumber)?.div ?? document.querySelector(`.page[data-page-number='${String(pageNumber)}']`);
}

function pageNumberFromElement(element) {
  const target = element?.nodeType === Node.ELEMENT_NODE ? element : element?.parentElement;
  const page = target?.closest?.(".page[data-page-number]");
  const pageNumber = Number(page?.dataset.pageNumber);
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : undefined;
}

function pageCanvasElement(page) {
  return page.querySelector("canvas");
}

function pageOverlayParent(page) {
  return page.querySelector(".canvasWrapper") ?? page;
}

function pageViewport(pageNumber) {
  return pageView(pageNumber)?.viewport;
}

function pageViewportHeight(page, viewport) {
  return pageOverlayParent(page).getBoundingClientRect().height || pageCanvasElement(page)?.offsetHeight || viewport?.height || 1;
}

function updateHostDataset() {
  document.body.dataset.hostLwSocket = hostState.socketStatus;
  document.body.dataset.hostLwVisibleRevision = String(hostState.visibleRevision ?? "");
  document.body.dataset.hostLwLatestRevision = String(hostState.latestRevision ?? "");
  document.body.dataset.hostLwLastError = hostState.lastError ?? "";
  document.body.dataset.hostLwSynctexIssue = hostState.synctexCapabilityIssue?.code ?? "";
  document.body.dataset.hostLwHoverEnabled = hostState.hoverEnabled ? "true" : "false";
  document.body.dataset.hostLwDebugSynctexEnabled = hostState.debugSynctexEnabled ? "true" : "false";
  document.body.dataset.hostLwCompileRunning = hostState.compileRunning ? "true" : "false";
  document.body.dataset.hostLwContinuousCompile = hostState.continuousCompile ? "true" : "false";
}

function sendCompileAction(action, extra = {}) {
  const pdfId = activePdfId();
  if (!pdfId) return false;
  return sendViewerSocketPayload({ type: "compile_action", pdf_id: pdfId, action, ...extra });
}

function compileStateForPdfId(pdfId) {
  return compileStateByPdfId.get(Number(pdfId)) ?? { running: false, continuous: false, diagnostic: undefined };
}

function setCompileStateForPdfId(pdfId, nextState) {
  const key = Number(pdfId);
  if (!Number.isInteger(key) || key <= 0) return;
  const current = compileStateForPdfId(key);
  compileStateByPdfId.set(key, { ...current, ...nextState });
  if (key === activePdfId()) {
    const state = compileStateByPdfId.get(key);
    hostState.compileRunning = state.running === true;
    hostState.continuousCompile = state.continuous === true;
    hostState.compileDiagnostic = state.diagnostic;
  }
}

function applyCompileStateForActivePdf() {
  const state = compileStateForPdfId(activePdfId());
  hostState.compileRunning = state.running === true;
  hostState.continuousCompile = state.continuous === true;
  hostState.compileDiagnostic = state.diagnostic;
  updateHostDataset();
  updateCompileToolbarButtons();
  renderCompileDiagnostic();
}

function updateCompileToolbarButtons() {
  const compileButton = document.getElementById("hostCompileButton");
  const continuousButton = document.getElementById("hostContinuousCompileButton");
  if (compileButton) {
    const disabledByContinuous = hostState.continuousCompile && !hostState.compileRunning;
    compileButton.classList.toggle("hostCompileRunning", hostState.compileRunning);
    compileButton.disabled = disabledByContinuous;
    compileButton.title = hostState.compileRunning ? "Stop compilation" : disabledByContinuous ? "Compile once is disabled while continuous compilation is enabled" : "Compile once";
    compileButton.setAttribute("aria-label", compileButton.title);
    const icon = compileButton.querySelector("span");
    icon.textContent = "";
    icon.className = hostState.compileRunning ? "hostCompileStopIcon" : "hostCompileOnceIcon";
  }
  if (continuousButton) {
    continuousButton.classList.toggle("hostContinuousCompileActive", hostState.continuousCompile);
    continuousButton.title = hostState.continuousCompile ? "Disable continuous compilation" : "Enable continuous compilation";
    continuousButton.setAttribute("aria-label", continuousButton.title);
  }
}

function renderCompileDiagnostic() {
  let box = document.getElementById("hostCompileDiagnosticBox");
  const diagnostic = hostState.compileDiagnostic;
  if (!diagnostic) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "hostCompileDiagnosticBox";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    const text = document.createElement("div");
    text.className = "hostCompileDiagnosticText";
    const actions = document.createElement("div");
    actions.className = "hostCompileDiagnosticActions";
    const inject = document.createElement("button");
    inject.type = "button";
    inject.textContent = "Inject on next prompt";
    inject.addEventListener("click", () => sendCompileAction("inject_diagnostic", { inject_text: hostState.compileDiagnostic?.injectText ?? hostState.compileDiagnostic?.message ?? "" }));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      setCompileStateForPdfId(activePdfId(), { diagnostic: undefined });
      hostState.compileDiagnostic = undefined;
      renderCompileDiagnostic();
    });
    actions.append(inject, dismiss);
    box.append(text, actions);
    document.body.appendChild(box);
  }
  box.dataset.severity = diagnostic.severity || "info";
  box.querySelector(".hostCompileDiagnosticText").textContent = diagnostic.message;
}

function setCompileStatus(message) {
  const diagnostic = typeof message.message === "string" && message.message.length > 0
    ? { severity: message.severity || "info", message: message.message, injectText: message.inject_text }
    : undefined;
  setCompileStateForPdfId(message.pdf_id, { running: message.running === true, continuous: message.continuous === true, diagnostic });
  if (Number(message.pdf_id) === activePdfId()) {
    updateHostDataset();
    updateCompileToolbarButtons();
    renderCompileDiagnostic();
  }
}

function installCompileToolbarButtons() {
  if (document.getElementById("hostCompileButton")) return;
  const compileButton = document.createElement("button");
  compileButton.id = "hostCompileButton";
  compileButton.className = "toolbarButton hostCompileButton";
  compileButton.type = "button";
  compileButton.tabIndex = 0;
  const compileLabel = document.createElement("span");
  compileLabel.setAttribute("aria-hidden", "true");
  compileButton.appendChild(compileLabel);
  compileButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (hostState.compileRunning) {
      setCompileStateForPdfId(activePdfId(), { running: false, continuous: false });
      updateHostDataset();
      updateCompileToolbarButtons();
      sendCompileAction("stop");
      return;
    }
    if (hostState.continuousCompile) return;
    sendCompileAction("compile");
  });
  const continuousButton = document.createElement("button");
  continuousButton.id = "hostContinuousCompileButton";
  continuousButton.className = "toolbarButton hostCompileButton";
  continuousButton.type = "button";
  continuousButton.tabIndex = 0;
  const continuousLabel = document.createElement("span");
  continuousLabel.className = "hostCompileLoopIcon";
  continuousLabel.setAttribute("aria-hidden", "true");
  continuousButton.appendChild(continuousLabel);
  continuousButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const enabling = !hostState.continuousCompile;
    setCompileStateForPdfId(activePdfId(), { continuous: enabling, running: false, diagnostic: undefined });
    updateHostDataset();
    updateCompileToolbarButtons();
    renderCompileDiagnostic();
    if (!sendCompileAction(enabling ? "continuous_on" : "continuous_off")) {
      setCompileStateForPdfId(activePdfId(), { continuous: false, running: false, diagnostic: { severity: "error", message: "Could not contact the server to change continuous compilation." } });
      updateHostDataset();
      updateCompileToolbarButtons();
      renderCompileDiagnostic();
    }
  });
  const anchor = document.getElementById("hostSynctexHoverButton") ?? document.getElementById("toolbarViewerRight")?.firstElementChild ?? document.getElementById("toolbarViewerRight");
  anchor?.parentNode?.insertBefore(compileButton, anchor);
  anchor?.parentNode?.insertBefore(continuousButton, anchor);
  updateCompileToolbarButtons();
}

function renderSynctexCapabilityIssue() {
  let banner = document.getElementById("hostSynctexCapabilityBanner");
  const issue = hostState.synctexCapabilityIssue;
  if (!issue) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "hostSynctexCapabilityBanner";
    banner.setAttribute("role", "alert");
    banner.setAttribute("aria-live", "polite");
    const body = document.createElement("div");
    body.className = "hostSynctexCapabilityBannerBody";
    const title = document.createElement("strong");
    title.className = "hostSynctexCapabilityBannerTitle";
    const detail = document.createElement("span");
    detail.className = "hostSynctexCapabilityBannerDetail";
    body.append(title, detail);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "hostSynctexCapabilityBannerClose";
    close.setAttribute("aria-label", "Dismiss SyncTeX capability warning");
    close.textContent = "×";
    close.addEventListener("click", () => clearSynctexCapabilityIssue());
    banner.append(body, close);
    document.body.appendChild(banner);
  }
  banner.dataset.issueCode = issue.code;
  banner.querySelector(".hostSynctexCapabilityBannerTitle").textContent = issue.title;
  banner.querySelector(".hostSynctexCapabilityBannerDetail").textContent = issue.detail;
}

function setSynctexCapabilityIssue(issue) {
  hostState.synctexCapabilityIssue = issue;
  updateHostDataset();
  renderSynctexCapabilityIssue();
}

function clearSynctexCapabilityIssue(code) {
  if (code !== undefined && hostState.synctexCapabilityIssue?.code !== code) return;
  hostState.synctexCapabilityIssue = undefined;
  updateHostDataset();
  renderSynctexCapabilityIssue();
}

function synctexCapabilityIssueFromError(rawError, fallbackCode = "synctex_failed") {
  const raw = String(rawError || "Unknown SyncTeX error");
  if (/missing SyncTeX sidecar/i.test(raw)) {
    return {
      code: "synctex_missing",
      title: "SyncTeX artifacts are missing",
      detail: `${raw} Compile with SyncTeX enabled, then refresh or reopen the PDF.`,
    };
  }
  if (/incorrect header|gzip|gunzip|zlib|unexpected end|invalid.+synctex|parse/i.test(raw)) {
    return {
      code: "synctex_parse_failed",
      title: "Could not parse SyncTeX artifacts",
      detail: `${raw} Recompile the document with SyncTeX enabled to regenerate the .synctex/.synctex.gz file.`,
    };
  }
  if (/No usable SyncTeX mapping|No SyncTeX mapping/i.test(raw)) {
    return {
      code: "synctex_unmapped",
      title: "No SyncTeX mapping for this PDF position",
      detail: raw,
    };
  }
  if (/viewer host|websocket|socket|server|network|connection/i.test(raw) || fallbackCode === "server_unreachable") {
    return {
      code: "server_unreachable",
      title: "Viewer Host connection is unavailable",
      detail: raw,
    };
  }
  return {
    code: fallbackCode,
    title: "SyncTeX capability problem",
    detail: raw,
  };
}

function captureRefreshState() {
  const application = app();
  const viewer = application?.pdfViewer;
  const container = viewerContainer();
  return {
    page: viewer?.currentPageNumber,
    scale: viewer?.currentScaleValue,
    scrollTop: container?.scrollTop,
    scrollLeft: container?.scrollLeft,
  };
}

async function waitForPagesReady(application) {
  await application.pdfViewer?.pagesPromise?.catch(() => undefined);
  await application.pdfViewer?.onePageRendered?.catch(() => undefined);
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function restoreRefreshState(state) {
  restoreNavigationState(state);
}

function captureNavigationState() {
  const viewer = pdfViewer();
  const container = viewerContainer();
  return {
    page: viewer?.currentPageNumber,
    scale: viewer?.currentScaleValue,
    scrollTop: container?.scrollTop ?? 0,
    scrollLeft: container?.scrollLeft ?? 0,
  };
}

function sameNavigationState(left, right) {
  if (!left || !right) return false;
  return left.page === right.page
    && left.scale === right.scale
    && Math.abs(Number(left.scrollTop ?? 0) - Number(right.scrollTop ?? 0)) < 1
    && Math.abs(Number(left.scrollLeft ?? 0) - Number(right.scrollLeft ?? 0)) < 1;
}

function meaningfulNavigationChange(left, right) {
  if (!left || !right) return false;
  return left.page !== right.page
    || left.scale !== right.scale
    || Math.abs(Number(left.scrollTop ?? 0) - Number(right.scrollTop ?? 0)) >= MIN_HISTORY_SCROLL_DELTA
    || Math.abs(Number(left.scrollLeft ?? 0) - Number(right.scrollLeft ?? 0)) >= MIN_HISTORY_SCROLL_DELTA;
}

function restoreNavigationState(state) {
  if (!state) return;
  const viewer = pdfViewer();
  const container = viewerContainer();
  navigationHistory.restoring = true;
  if (state.scale !== undefined && viewer) viewer.currentScaleValue = state.scale;
  if (typeof state.page === "number" && viewer) viewer.currentPageNumber = Math.max(1, Math.min(state.page, viewer.pagesCount || state.page));
  requestAnimationFrame(() => {
    if (container) {
      if (typeof state.scrollTop === "number") container.scrollTop = state.scrollTop;
      if (typeof state.scrollLeft === "number") container.scrollLeft = state.scrollLeft;
    }
    requestAnimationFrame(() => {
      navigationHistory.restoring = false;
      navigationHistory.lastSettledState = captureNavigationState();
      updateNavigationButtons();
    });
  });
}

function pushNavigationHistory(state = captureNavigationState()) {
  if (navigationHistory.restoring || !state) return;
  const last = navigationHistory.back.at(-1);
  if (sameNavigationState(last, state)) return;
  navigationHistory.back.push(state);
  if (navigationHistory.back.length > MAX_NAVIGATION_HISTORY) navigationHistory.back.splice(0, navigationHistory.back.length - MAX_NAVIGATION_HISTORY);
  navigationHistory.forward.splice(0);
  updateNavigationButtons();
}

function recordSettledNavigationChange() {
  if (navigationHistory.restoring) return;
  const current = captureNavigationState();
  const start = navigationHistory.pendingStartState ?? navigationHistory.lastSettledState;
  navigationHistory.pendingStartState = undefined;
  if (meaningfulNavigationChange(start, current)) pushNavigationHistory(start);
  navigationHistory.lastSettledState = current;
}

function scheduleSettledNavigationCapture() {
  if (navigationHistory.restoring) return;
  if (!navigationHistory.pendingStartState) navigationHistory.pendingStartState = navigationHistory.lastSettledState ?? captureNavigationState();
  if (navigationHistory.pendingSettledTimer !== undefined) clearTimeout(navigationHistory.pendingSettledTimer);
  navigationHistory.pendingSettledTimer = setTimeout(() => {
    navigationHistory.pendingSettledTimer = undefined;
    recordSettledNavigationChange();
  }, NAVIGATION_SETTLE_MS);
}

function navigateHistory(direction) {
  const source = direction === "back" ? navigationHistory.back : navigationHistory.forward;
  const target = source.pop();
  if (!target) {
    updateNavigationButtons();
    return false;
  }
  const destination = direction === "back" ? navigationHistory.forward : navigationHistory.back;
  destination.push(captureNavigationState());
  if (destination.length > MAX_NAVIGATION_HISTORY) destination.splice(0, destination.length - MAX_NAVIGATION_HISTORY);
  restoreNavigationState(target);
  updateNavigationButtons();
  return true;
}

function updateNavigationButtons() {
  const backButton = document.getElementById("historyBack");
  const forwardButton = document.getElementById("historyForward");
  if (backButton instanceof HTMLButtonElement) {
    backButton.disabled = navigationHistory.back.length === 0;
    backButton.setAttribute("aria-disabled", String(backButton.disabled));
  }
  if (forwardButton instanceof HTMLButtonElement) {
    forwardButton.disabled = navigationHistory.forward.length === 0;
    forwardButton.setAttribute("aria-disabled", String(forwardButton.disabled));
  }
}

function destroyLoadingTask(task) {
  try {
    const destroyed = task?.destroy?.();
    if (destroyed && typeof destroyed.catch === "function") destroyed.catch(() => undefined);
  } catch {
    // A stale loading task may already be torn down by PDF.js; ignore it.
  }
}

function systemPdfTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function storedPdfTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "dark" || value === "light" ? value : undefined;
  } catch {
    return undefined;
  }
}

function activePdfTheme() {
  return storedPdfTheme() ?? systemPdfTheme();
}

function pdfThemeColors(theme = activePdfTheme()) {
  return PDF_VIEWER_THEMES[theme] ?? PDF_VIEWER_THEMES.light;
}

function setStoredPdfTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable in constrained browser contexts; the in-memory theme still applies.
  }
}

function cachedPdfBytesForConfig(config) {
  const pdfId = Number(config?.pdf_id);
  const revision = Number(config?.revision);
  const cached = pdfByteCache.get(pdfId);
  return cached && cached.revision === revision ? cached.bytes : undefined;
}

function rememberPdfBytes(config, bytes) {
  const pdfId = Number(config?.pdf_id);
  const revision = Number(config?.revision);
  if (!Number.isInteger(pdfId) || pdfId <= 0 || !Number.isFinite(revision) || !(bytes instanceof ArrayBuffer)) return;
  pdfByteCache.delete(pdfId);
  pdfByteCache.set(pdfId, { revision, config, bytes });
  while (pdfByteCache.size > MAX_PDF_BYTE_CACHE_ENTRIES) {
    const oldest = pdfByteCache.keys().next().value;
    if (oldest === undefined) break;
    pdfByteCache.delete(oldest);
  }
}

async function fetchConfigForPdfId(pdfId) {
  const response = await fetch(`/config/${encodeURIComponent(String(pdfId))}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`tab config request failed: ${response.status}`);
  return await response.json();
}

async function prefetchPdfBytes(config) {
  if (!hasActiveConfig(config)) return undefined;
  const pdfId = Number(config?.pdf_id);
  const revision = Number(config?.revision);
  const existing = pdfByteCache.get(pdfId);
  if (existing?.revision === revision && (existing.bytes || existing.inFlight)) return existing.inFlight;
  const inFlight = (async () => {
    const response = await fetch(config.pdf_url, { cache: "no-store" });
    if (!response.ok) throw new Error(`PDF prefetch failed: ${response.status}`);
    rememberPdfBytes(config, await response.arrayBuffer());
  })().catch((error) => {
    const current = pdfByteCache.get(pdfId);
    if (current?.revision === revision) pdfByteCache.delete(pdfId);
    throw error;
  });
  pdfByteCache.delete(pdfId);
  pdfByteCache.set(pdfId, { revision, config, inFlight });
  return inFlight;
}

function configurePdfViewerApplicationOptions() {
  const theme = activePdfTheme();
  const colors = pdfThemeColors(theme);
  globalThis.PDFViewerApplicationOptions.setAll({
    defaultUrl: hasActiveConfig(initialConfig) ? initialConfig.pdf_url : "",
    annotationEditorMode: -1,
    disablePreferences: true,
    enableScripting: false,
    cMapUrl: "/viewer-lw/cmaps/",
    standardFontDataUrl: "/viewer-lw/standard_fonts/",
    wasmUrl: "/viewer-lw/wasm/",
    sidebarViewOnLoad: 0,
    workerSrc: "/viewer-lw/build/pdf.worker.mjs",
    forcePageColors: true,
    pageColorsBackground: colors.background,
    pageColorsForeground: colors.foreground,
    viewerCssTheme: 2,
    maxCanvasPixels: -1,
    maxCanvasDim: -1,
    enableDetailCanvas: false,
    showPreviousViewOnLoad: false,
  });
}

function installWebViewerLoadedConfigListener() {
  const listener = (event) => {
    if (event?.detail?.source && event.detail.source !== window) return;
    forceShowLaTeXWorkshopChrome();
    configurePdfViewerApplicationOptions();
  };
  document.addEventListener("webviewerloaded", listener);
  try {
    if (parent?.document && parent.document !== document) {
      parent.document.addEventListener("webviewerloaded", listener);
    }
  } catch {
    // Cross-origin parents are not expected in the Host app, but direct route loading must still work.
  }
}

async function refreshToConfig(config, options = {}) {
  const revision = Number(config.revision);
  const serial = ++hostState.refreshSerial;
  const snapshot = options.preserveView === false ? undefined : captureRefreshState();
  hostState.lastError = undefined;
  updateHostDataset();

  destroyLoadingTask(activeRefreshLoadingTask);
  const pdfjsLib = await import("/viewer-lw/build/pdf.mjs");
  if (serial !== hostState.refreshSerial) return;
  const cachedBytes = cachedPdfBytesForConfig(config);
  hostState.lastPdfLoadSource = cachedBytes ? "cache" : "url";
  const loadingTask = pdfjsLib.getDocument({
    ...(cachedBytes ? { data: cachedBytes.slice(0) } : { url: config.pdf_url }),
    cMapUrl: "/viewer-lw/cmaps/",
    standardFontDataUrl: "/viewer-lw/standard_fonts/",
    wasmUrl: "/viewer-lw/wasm/",
  });
  activeRefreshLoadingTask = loadingTask;

  try {
    const pdfDocument = await loadingTask.promise;
    if (serial !== hostState.refreshSerial) {
      pdfDocument.destroy?.();
      return;
    }
    app().setTitleUsingUrl?.(config.pdf_url, config.pdf_url);
    outlinePromise = undefined;
    app().load(pdfDocument);
    await waitForPagesReady(app());
    if (serial !== hostState.refreshSerial) return;
    if (snapshot) restoreRefreshState(snapshot);
    hostState.config = config;
    hostState.visibleRevision = revision;
    sendLoadedStateDiagnostic("lw_refresh_loaded", { revision });
  } catch (error) {
    if (serial === hostState.refreshSerial) hostState.lastError = `refresh failed: ${error?.message ?? String(error)}`;
  } finally {
    if (serial === hostState.refreshSerial && activeRefreshLoadingTask === loadingTask) activeRefreshLoadingTask = undefined;
    updateHostDataset();
  }
}

function viewportScale(viewport) {
  const origin = viewport.convertToViewportPoint(0, 0);
  const xUnit = viewport.convertToViewportPoint(1, 0);
  const yUnit = viewport.convertToViewportPoint(0, 1);
  return { x: Math.abs(xUnit[0] - origin[0]) || 1, y: Math.abs(yUnit[1] - origin[1]) || 1 };
}

function viewportPageBox(viewport) {
  const box = Array.isArray(viewport.viewBox) ? viewport.viewBox.map(Number) : [0, 0, Number(viewport.width) || 0, Number(viewport.height) || 0];
  const left = Math.min(box[0], box[2]);
  const top = Math.max(box[1], box[3]);
  const height = Math.abs(box[3] - box[1]) || 1;
  return { left, top, height };
}

function topOriginPdfPointToViewport(viewport, x, y) {
  const box = viewportPageBox(viewport);
  return viewport.convertToViewportPoint(box.left + Number(x), box.top - Number(y));
}

function forwardMarkerFromPdfPoint({ viewport, pdfX, pdfY, width, height }) {
  const point = topOriginPdfPointToViewport(viewport, pdfX, pdfY);
  const scale = viewportScale(viewport);
  const position = { left: point[0], top: point[1] };
  if (width === undefined || height === undefined) return position;
  return { ...position, width: Number(width) * scale.x, height: Number(height) * scale.y };
}

function forwardMarkerFromPdfRange({ viewport, h, v, W, H }) {
  const topLeft = topOriginPdfPointToViewport(viewport, Number(h), Number(v) - Number(H));
  const bottomRight = topOriginPdfPointToViewport(viewport, Number(h) + Number(W), Number(v));
  return {
    left: Math.min(topLeft[0], bottomRight[0]),
    top: Math.min(topLeft[1], bottomRight[1]),
    width: Math.max(1, Math.abs(bottomRight[0] - topLeft[0])),
    height: Math.max(1, Math.abs(bottomRight[1] - topLeft[1])),
  };
}

function synctexOverlayPositions(message) {
  const pageNumber = Number(message.page);
  const page = pageElement(pageNumber);
  const viewport = pageViewport(pageNumber);
  if (!page || !viewport) return undefined;
  const ranges = Array.isArray(message.ranges) ? message.ranges.filter((range) => Number(range.page) === pageNumber) : [];
  const scalarPosition = ranges.length === 0 && message.width !== undefined && message.height !== undefined
    ? forwardMarkerFromPdfPoint({ viewport, pdfX: message.x, pdfY: message.y, width: message.width, height: message.height })
    : undefined;
  const positions = scalarPosition ? [scalarPosition] : ranges.map((range) => forwardMarkerFromPdfRange({ viewport, ...range }));
  if (positions.length === 0) positions.push(forwardMarkerFromPdfPoint({ viewport, pdfX: message.x, pdfY: message.y }));
  return { pageNumber, page, overlayParent: pageOverlayParent(page), positions };
}

function removeOverlays(selector) {
  for (const marker of document.querySelectorAll(selector)) marker.remove();
}

function scrollOverlayIntoView(markers) {
  const first = markers.find(Boolean);
  const container = viewerContainer();
  if (!first || !container) return;
  const markerRect = first.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  container.scrollTop += markerRect.top - containerRect.top - container.clientHeight * 0.4;
  if (pdfViewer()?.scrollMode === 1) container.scrollLeft += markerRect.left - containerRect.left - container.clientWidth * 0.2;
}

function renderSynctexOverlay(message, { selector, datasetName, label, scroll = true } = {}) {
  const overlay = synctexOverlayPositions(message);
  if (!overlay) return false;
  if (selector) removeOverlays(selector);
  const markers = overlay.positions.map((position) => {
    const marker = document.createElement("div");
    if (datasetName) marker.dataset[datasetName] = position.width === undefined ? "circle" : "rect";
    marker.style.position = "absolute";
    marker.style.pointerEvents = datasetName === "synctexMarker" ? "auto" : "none";
    marker.style.zIndex = "100000";
    marker.style.left = `${position.left}px`;
    marker.style.top = `${position.top}px`;
    if (position.width === undefined || position.height === undefined) {
      marker.style.width = "0.5em";
      marker.style.height = "0.5em";
      marker.style.border = datasetName === "synctexMarker" ? "0" : "0.2em solid red";
      marker.style.borderRadius = "50%";
      marker.style.background = datasetName === "synctexMarker" ? "rgba(34,197,94,.32)" : "transparent";
      marker.style.opacity = "0.8";
      marker.style.transform = "translate(-50%, -50%)";
      marker.className = "show";
    } else {
      marker.style.width = `${position.width}px`;
      marker.style.height = `${position.height}px`;
      if (datasetName === "synctexMarker") {
        marker.style.background = "rgba(34,197,94,.28)";
        marker.style.outline = "0";
      } else {
        marker.style.background = "rgba(239,68,68,.18)";
        marker.style.outline = "2px solid rgba(239,68,68,.9)";
      }
    }
    overlay.overlayParent.appendChild(marker);
    return marker;
  });
  if (label) overlay.overlayParent.appendChild(label);
  if (scroll) scrollOverlayIntoView(markers);
  return true;
}

function redrawSynctexOverlays() {
  synctexOverlayState.redrawTimer = undefined;
  if (synctexOverlayState.forwardMessage) renderSynctexOverlay(synctexOverlayState.forwardMessage, { selector: "[data-synctex-marker]", datasetName: "synctexMarker", scroll: false });
  if (synctexOverlayState.hoverResult) showHoverResult(synctexOverlayState.hoverResult, { scroll: false, remember: false });
  renderAnnotations(false);
}

function scheduleSynctexOverlayRedraw() {
  if (synctexOverlayState.redrawTimer !== undefined) return;
  synctexOverlayState.redrawTimer = setTimeout(() => requestAnimationFrame(redrawSynctexOverlays), 50);
}

function installSynctexOverlayRedrawHandlers() {
  window.addEventListener("resize", scheduleSynctexOverlayRedraw, { passive: true });
  app()?.eventBus?.on?.("scalechanging", scheduleSynctexOverlayRedraw);
  app()?.eventBus?.on?.("pagerendered", scheduleSynctexOverlayRedraw);
  app()?.eventBus?.on?.("pagesloaded", scheduleSynctexOverlayRedraw);
}

function showSynctexMarker(message, options = {}) {
  if (options.remember !== false) synctexOverlayState.forwardMessage = message;
  return renderSynctexOverlay(message, { selector: "[data-synctex-marker]", datasetName: "synctexMarker", scroll: options.scroll !== false });
}

function annotationSourceLine(message) {
  return message.source_line ?? message.reverse_source_line;
}

function annotationPayload(annotation) {
  const message = annotation.message;
  const sourceFile = message.source_file ?? message.reverse_source_file;
  const line = Number(message.line ?? message.reverse_line);
  if (!sourceFile || !Number.isInteger(line) || line <= 0) return undefined;
  return {
    type: "pdf_annotation",
    annotation_id: annotation.id,
    page: Number(message.page ?? message.click_page),
    x: Number(message.x ?? message.click_x),
    y: Number(message.y ?? message.click_y),
    source_file: sourceFile,
    line,
    ...(annotationSourceLine(message) === undefined ? {} : { source_line: annotationSourceLine(message) }),
    ...(message.source_span === undefined ? {} : { source_span: message.source_span }),
    ...(annotation.comment ? { comment: annotation.comment } : {}),
  };
}

function sendAnnotationUpdate(annotation) {
  const payload = annotationPayload(annotation);
  if (payload) sendViewerSocketPayload(payload);
}

function annotationStorageKey(pdfId = activePdfId()) {
  return Number.isInteger(Number(pdfId)) && Number(pdfId) > 0 ? String(Number(pdfId)) : undefined;
}

function storedPdfAnnotations() {
  return readLocalStorageJson(PDF_ANNOTATIONS_STORAGE_KEY, {});
}

function persistAnnotations() {
  const key = annotationStorageKey();
  if (!key) return;
  const all = storedPdfAnnotations();
  all[key] = Array.from(annotations.values()).map((annotation) => ({
    id: annotation.id,
    message: annotation.message,
    comment: annotation.comment || "",
    hasBubble: annotation.hasBubble === true,
    ...(typeof annotation.bubbleLeft === "number" ? { bubbleLeft: annotation.bubbleLeft } : {}),
    ...(typeof annotation.bubbleTop === "number" ? { bubbleTop: annotation.bubbleTop } : {}),
    ...(typeof annotation.bubbleWidth === "number" ? { bubbleWidth: annotation.bubbleWidth } : {}),
  }));
  localStorage.setItem(PDF_ANNOTATIONS_STORAGE_KEY, JSON.stringify(all));
}

function restoreAnnotationsForActivePdf() {
  annotations.clear();
  selectedAnnotationId = undefined;
  const key = annotationStorageKey();
  const stored = key ? storedPdfAnnotations()[key] : undefined;
  if (Array.isArray(stored)) {
    for (const annotation of stored) {
      if (!annotation || typeof annotation.id !== "string" || !annotation.message) continue;
      annotations.set(annotation.id, {
        id: annotation.id,
        message: annotation.message,
        comment: typeof annotation.comment === "string" ? annotation.comment : "",
        hasBubble: annotation.hasBubble === true,
        ...(typeof annotation.bubbleLeft === "number" ? { bubbleLeft: annotation.bubbleLeft } : {}),
        ...(typeof annotation.bubbleTop === "number" ? { bubbleTop: annotation.bubbleTop } : {}),
        ...(typeof annotation.bubbleWidth === "number" ? { bubbleWidth: annotation.bubbleWidth } : {}),
      });
    }
  }
  renderAnnotations(false);
}

async function restoreAnnotationsForActivePdfWhenReady() {
  if (!hasActiveConfig(hostState.config)) return;
  const expectedPdfId = activePdfId();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && activePdfId() === expectedPdfId) {
    await waitForPagesReady(app()).catch(() => undefined);
    if (document.querySelector(".page[data-page-number]")) {
      restoreAnnotationsForActivePdf();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (activePdfId() === expectedPdfId) restoreAnnotationsForActivePdf();
}

function clearPersistedAnnotationsForPdfIds(pdfIds) {
  const numericPdfIds = Array.from(new Set((Array.isArray(pdfIds) ? pdfIds : [pdfIds])
    .map((pdfId) => Number(pdfId))
    .filter((pdfId) => Number.isInteger(pdfId) && pdfId > 0)));
  if (numericPdfIds.length === 0) return [];
  const all = storedPdfAnnotations();
  for (const pdfId of numericPdfIds) delete all[String(pdfId)];
  localStorage.setItem(PDF_ANNOTATIONS_STORAGE_KEY, JSON.stringify(all));
  return numericPdfIds;
}

function clearAnnotations(options = {}) {
  annotations.clear();
  selectedAnnotationId = undefined;
  removeOverlays("[data-pdf-annotation]");
  if (options.persist !== false) persistAnnotations();
}

function clearUserAnnotations() {
  const annotationIds = Array.from(annotations.keys());
  clearForwardSynctexMarker();
  clearAnnotations();
  for (const annotationId of annotationIds) sendViewerSocketPayload({ type: "pdf_annotation_deleted", annotation_id: annotationId });
}

function clearAnnotationsFromHostMessage(message) {
  const pdfIds = Array.isArray(message.pdf_ids) ? message.pdf_ids : [message.pdf_id];
  const clearedPdfIds = clearPersistedAnnotationsForPdfIds(pdfIds);
  if (clearedPdfIds.includes(activePdfId())) {
    clearForwardSynctexMarker();
    clearAnnotations({ persist: false });
  }
}

function selectAnnotation(annotationId, redraw = true) {
  const alreadySelected = selectedAnnotationId === annotationId;
  selectedAnnotationId = annotationId;
  if (redraw && !alreadySelected) renderAnnotations(false);
}

function focusAnnotationTextarea(annotationId) {
  const textarea = document.querySelector(`[data-pdf-annotation-bubble='${annotationId}'] textarea`);
  if (textarea instanceof HTMLTextAreaElement) textarea.focus();
}

function selectAnnotationFromBubble(annotationId, preserveTextareaFocus) {
  const changed = selectedAnnotationId !== annotationId;
  selectedAnnotationId = annotationId;
  if (!changed) return;
  renderAnnotations(false);
  if (preserveTextareaFocus) requestAnimationFrame(() => focusAnnotationTextarea(annotationId));
}

function removeAnnotation(annotationId) {
  if (!annotations.has(annotationId)) return;
  annotations.delete(annotationId);
  persistAnnotations();
  sendViewerSocketPayload({ type: "pdf_annotation_deleted", annotation_id: annotationId });
  if (selectedAnnotationId === annotationId) selectedAnnotationId = undefined;
  renderAnnotations(false);
}

function pageRelativeOverlayOffset(overlay) {
  const pageRect = overlay.page.getBoundingClientRect();
  const parentRect = overlay.overlayParent.getBoundingClientRect();
  return { left: parentRect.left - pageRect.left, top: parentRect.top - pageRect.top };
}

function annotationAnchorPosition(positions) {
  const first = positions[0];
  if (!first) return undefined;
  let left = first.left;
  let top = first.top;
  let right = first.left + (first.width ?? 0);
  let bottom = first.top + (first.height ?? 0);
  for (const position of positions.slice(1)) {
    left = Math.min(left, position.left);
    top = Math.min(top, position.top);
    right = Math.max(right, position.left + (position.width ?? 0));
    bottom = Math.max(bottom, position.top + (position.height ?? 0));
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function bubbleLayout(annotation, anchor, page) {
  if (typeof annotation.bubbleLeft === "number" && typeof annotation.bubbleTop === "number") {
    return {
      left: annotation.bubbleLeft,
      top: annotation.bubbleTop,
      width: annotation.bubbleWidth ?? ANNOTATION_BUBBLE_DEFAULT_WIDTH_PX,
    };
  }
  const pageRect = page.getBoundingClientRect();
  const preferredLeft = anchor.left + (anchor.width ?? 0) + 8;
  const desiredWidth = annotation.bubbleWidth ?? ANNOTATION_BUBBLE_DEFAULT_WIDTH_PX;
  const availableWindowWidth = window.innerWidth - ANNOTATION_BUBBLE_VIEWPORT_MARGIN_PX * 2;
  const width = Math.max(ANNOTATION_BUBBLE_MIN_WIDTH_PX, Math.min(desiredWidth, Math.max(0, availableWindowWidth)));
  let left = preferredLeft;
  const maxLeft = window.innerWidth - pageRect.left - width - ANNOTATION_BUBBLE_VIEWPORT_MARGIN_PX;
  if (pageRect.left + left + width > window.innerWidth - ANNOTATION_BUBBLE_VIEWPORT_MARGIN_PX) {
    left = Math.max(ANNOTATION_BUBBLE_VIEWPORT_MARGIN_PX - pageRect.left, maxLeft);
  }
  return { left, top: anchor.top, width };
}

function startBubbleDrag(event, annotation, bubble) {
  if (!(event instanceof PointerEvent) || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  selectAnnotation(annotation.id, false);
  const startX = event.clientX;
  const startY = event.clientY;
  const startLeft = Number.parseFloat(bubble.style.left) || 0;
  const startTop = Number.parseFloat(bubble.style.top) || 0;
  const connectorLine = bubble.parentElement?.querySelector(`[data-pdf-annotation-connector='${annotation.id}'] line`);
  const onMove = (moveEvent) => {
    annotation.bubbleLeft = startLeft + moveEvent.clientX - startX;
    annotation.bubbleTop = startTop + moveEvent.clientY - startY;
    bubble.style.left = `${annotation.bubbleLeft}px`;
    bubble.style.top = `${annotation.bubbleTop}px`;
    connectorLine?.setAttribute("x2", String(annotation.bubbleLeft));
    connectorLine?.setAttribute("y2", String(annotation.bubbleTop + 22));
  };
  const onUp = () => {
    annotation.bubbleWidth = bubble.offsetWidth;
    persistAnnotations();
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
}

function renderAnnotationConnector(annotation, root, anchor, bubbleLayoutValue) {
  const selected = selectedAnnotationId === annotation.id;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.dataset.pdfAnnotationConnector = annotation.id;
  svg.style.position = "absolute";
  svg.style.left = "0px";
  svg.style.top = "0px";
  svg.style.width = "1px";
  svg.style.height = "1px";
  svg.style.overflow = "visible";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = selected ? "100020" : "100008";
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  const anchorX = anchor.left + (anchor.width ?? 0);
  const anchorY = anchor.top + Math.max(6, (anchor.height ?? 12) / 2);
  line.setAttribute("x1", String(anchorX));
  line.setAttribute("y1", String(anchorY));
  line.setAttribute("x2", String(bubbleLayoutValue.left));
  line.setAttribute("y2", String(bubbleLayoutValue.top + 22));
  line.setAttribute("stroke", selected ? "rgba(239,68,68,.85)" : "rgba(239,68,68,.38)");
  line.setAttribute("stroke-width", selected ? "2" : "1.25");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-dasharray", selected ? "" : "3 3");
  svg.appendChild(line);
  root.appendChild(svg);
}

function renderAnnotationBubble(annotation, root, anchor, page) {
  const selected = selectedAnnotationId === annotation.id;
  const layout = bubbleLayout(annotation, anchor, page);
  renderAnnotationConnector(annotation, root, anchor, layout);
  const bubble = document.createElement("div");
  bubble.dataset.pdfAnnotationBubble = annotation.id;
  bubble.style.position = "absolute";
  bubble.style.left = `${layout.left}px`;
  bubble.style.top = `${layout.top}px`;
  bubble.style.width = `${layout.width}px`;
  bubble.style.minWidth = `${ANNOTATION_BUBBLE_MIN_WIDTH_PX}px`;
  bubble.style.boxSizing = "border-box";
  bubble.style.maxHeight = selected ? "none" : `${ANNOTATION_BUBBLE_MAX_HEIGHT_PX}px`;
  bubble.style.overflow = selected ? "auto" : "hidden";
  bubble.style.resize = selected ? "horizontal" : "none";
  bubble.style.background = "rgba(255,255,255,.96)";
  bubble.style.border = selected ? "1px solid rgba(239,68,68,.65)" : "1px solid rgba(31,41,55,.28)";
  bubble.style.borderRadius = "8px";
  bubble.style.boxShadow = selected ? "0 12px 28px rgba(0,0,0,.26), 0 0 0 3px rgba(239,68,68,.12)" : "0 8px 18px rgba(0,0,0,.16)";
  bubble.style.padding = "22px 8px 8px";
  bubble.style.zIndex = selected ? "100030" : "100010";
  bubble.style.pointerEvents = "auto";
  bubble.addEventListener("mouseup", () => { annotation.bubbleWidth = bubble.offsetWidth; });
  for (const eventName of ["pointerdown", "mousedown", "mouseup", "click"]) {
    bubble.addEventListener(eventName, (event) => {
      event.stopPropagation();
      if (event.target instanceof Element && event.target.closest("[data-pdf-annotation-bubble-close]")) return;
      selectAnnotationFromBubble(annotation.id, event.target instanceof HTMLTextAreaElement);
    });
  }

  const dragHandle = document.createElement("div");
  dragHandle.textContent = "Comment";
  dragHandle.title = "Drag comment bubble";
  dragHandle.style.position = "absolute";
  dragHandle.style.left = "8px";
  dragHandle.style.right = "24px";
  dragHandle.style.top = "2px";
  dragHandle.style.height = "18px";
  dragHandle.style.font = "11px sans-serif";
  dragHandle.style.color = selected ? "rgba(153,27,27,.95)" : "rgba(31,41,55,.62)";
  dragHandle.style.cursor = "move";
  dragHandle.style.userSelect = "none";
  dragHandle.addEventListener("pointerdown", (event) => startBubbleDrag(event, annotation, bubble));

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "Remove comment bubble";
  close.dataset.pdfAnnotationBubbleClose = annotation.id;
  close.style.position = "absolute";
  close.style.right = "4px";
  close.style.top = "2px";
  close.style.border = "0";
  close.style.background = "transparent";
  close.style.cursor = "pointer";
  close.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    annotation.hasBubble = false;
    annotation.comment = "";
    persistAnnotations();
    sendAnnotationUpdate(annotation);
    renderAnnotations(false);
  });
  const textarea = document.createElement("textarea");
  textarea.value = annotation.comment;
  textarea.placeholder = "Comment…";
  textarea.rows = selected ? 5 : 3;
  textarea.style.width = "100%";
  textarea.style.minHeight = "64px";
  textarea.style.resize = "vertical";
  textarea.style.boxSizing = "border-box";
  textarea.addEventListener("focus", () => selectAnnotationFromBubble(annotation.id, true));
  textarea.addEventListener("keydown", (event) => event.stopPropagation());
  textarea.addEventListener("keyup", (event) => event.stopPropagation());
  textarea.addEventListener("input", () => {
    annotation.comment = textarea.value;
    persistAnnotations();
    sendAnnotationUpdate(annotation);
  });
  bubble.append(dragHandle, close, textarea);
  root.appendChild(bubble);
}

function renderAnnotationControls(annotation, root, anchor) {
  const controls = document.createElement("div");
  controls.style.position = "absolute";
  controls.style.left = `${anchor.left + (anchor.width ?? 0) + 4}px`;
  controls.style.top = `${Math.max(0, anchor.top - 24)}px`;
  controls.style.display = "flex";
  controls.style.gap = "4px";
  controls.style.pointerEvents = "auto";
  for (const [label, title, handler] of [["×", "Remove annotation", () => removeAnnotation(annotation.id)], ["💬", "Add comment", () => { annotation.hasBubble = true; persistAnnotations(); renderAnnotations(false); }]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.style.border = "1px solid rgba(31,41,55,.25)";
    button.style.borderRadius = "999px";
    button.style.background = "white";
    button.style.cursor = "pointer";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler();
    });
    controls.appendChild(button);
  }
  root.appendChild(controls);
}

function renderAnnotation(annotation, scroll = false, overlay = synctexOverlayPositions(annotation.message)) {
  if (!overlay) return false;
  const selected = selectedAnnotationId === annotation.id;
  const pageOffset = pageRelativeOverlayOffset(overlay);
  const pagePositions = overlay.positions.map((position) => ({ ...position, left: position.left + pageOffset.left, top: position.top + pageOffset.top }));
  const anchor = annotationAnchorPosition(pagePositions);
  if (!anchor) return false;
  const root = document.createElement("div");
  root.dataset.pdfAnnotation = annotation.id;
  root.style.position = "absolute";
  root.style.left = "0px";
  root.style.top = "0px";
  root.style.zIndex = selected ? "100025" : "100005";
  root.style.pointerEvents = "none";
  const markers = pagePositions.map((pagePosition) => {
    const marker = document.createElement("div");
    marker.dataset.pdfAnnotationBox = annotation.id;
    marker.style.position = "absolute";
    marker.style.left = `${pagePosition.left}px`;
    marker.style.top = `${pagePosition.top}px`;
    marker.style.width = pagePosition.width === undefined ? "0.75em" : `${pagePosition.width}px`;
    marker.style.height = pagePosition.height === undefined ? "0.75em" : `${pagePosition.height}px`;
    marker.style.transform = pagePosition.width === undefined ? "translate(-50%, -50%)" : "";
    marker.style.background = selected ? "rgba(239,68,68,.20)" : "rgba(239,68,68,.07)";
    marker.style.outline = selected ? "2px solid rgba(239,68,68,.95)" : "1px solid rgba(239,68,68,.42)";
    marker.style.boxShadow = selected ? "0 0 0 3px rgba(239,68,68,.16), 0 6px 18px rgba(0,0,0,.16)" : "none";
    marker.style.borderRadius = pagePosition.width === undefined ? "50%" : "2px";
    marker.style.pointerEvents = "auto";
    marker.style.cursor = "pointer";
    marker.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectAnnotation(annotation.id);
    });
    root.appendChild(marker);
    return marker;
  });
  if (selected) renderAnnotationControls(annotation, root, anchor);
  if (annotation.hasBubble) renderAnnotationBubble(annotation, root, anchor, overlay.page);
  overlay.page.style.overflow = "visible";
  overlay.page.appendChild(root);
  if (scroll) scrollOverlayIntoView(markers);
  return true;
}

function removeAnnotationOverlays(annotationId) {
  for (const marker of document.querySelectorAll("[data-pdf-annotation]")) {
    if (marker instanceof HTMLElement && marker.dataset.pdfAnnotation === annotationId) marker.remove();
  }
}

function renderAnnotations(scroll = false) {
  const liveAnnotationIds = new Set(annotations.keys());
  for (const marker of document.querySelectorAll("[data-pdf-annotation]")) {
    const annotationId = marker instanceof HTMLElement ? marker.dataset.pdfAnnotation : undefined;
    if (!annotationId || !liveAnnotationIds.has(annotationId)) marker.remove();
  }
  for (const annotation of annotations.values()) {
    const overlay = synctexOverlayPositions(annotation.message);
    if (!overlay) continue;
    removeAnnotationOverlays(annotation.id);
    renderAnnotation(annotation, scroll && selectedAnnotationId === annotation.id, overlay);
  }
}

function annotationSourceKey(message) {
  const span = message.source_span;
  if (span?.source_file && Number.isInteger(Number(span.start_line)) && Number.isInteger(Number(span.end_line))) {
    return `${span.source_file}:${Number(span.start_line)}-${Number(span.end_line)}`;
  }
  const sourceFile = message.source_file ?? message.reverse_source_file;
  const line = Number(message.line ?? message.reverse_line);
  return sourceFile && Number.isInteger(line) && line > 0 ? `${sourceFile}:${line}` : undefined;
}

function annotationRects(message) {
  const overlay = synctexOverlayPositions(message);
  if (!overlay) return [];
  return overlay.positions.map((position) => {
    const width = position.width ?? 8;
    const height = position.height ?? 8;
    const left = position.width === undefined ? position.left - width / 2 : position.left;
    const top = position.height === undefined ? position.top - height / 2 : position.top;
    return { pageNumber: overlay.pageNumber, left, top, right: left + width, bottom: top + height };
  });
}

function rectsOverlap(left, right) {
  if (left.pageNumber !== right.pageNumber) return false;
  return Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
    && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;
}

function findExistingAnnotationForMessage(message) {
  const key = annotationSourceKey(message);
  if (key) {
    for (const annotation of annotations.values()) {
      if (annotationSourceKey(annotation.message) === key) return annotation;
    }
  }
  const candidateRects = annotationRects(message);
  if (candidateRects.length === 0) return undefined;
  for (const annotation of annotations.values()) {
    const existingRects = annotationRects(annotation.message);
    if (candidateRects.some((candidate) => existingRects.some((existing) => rectsOverlap(candidate, existing)))) return annotation;
  }
  return undefined;
}

function createAnnotationFromMessage(message, { select = true, bubble = false, scroll = true } = {}) {
  if (message.error) return false;
  const existing = findExistingAnnotationForMessage(message);
  if (existing) {
    if (bubble) existing.hasBubble = true;
    persistAnnotations();
    if (select) selectedAnnotationId = existing.id;
    renderAnnotations(scroll);
    return true;
  }
  const id = `annotation-${Date.now()}-${nextAnnotationNumber}`;
  nextAnnotationNumber += 1;
  const annotation = { id, message, comment: "", hasBubble: bubble };
  annotations.set(id, annotation);
  persistAnnotations();
  if (select) selectedAnnotationId = id;
  renderAnnotations(scroll);
  sendAnnotationUpdate(annotation);
  return true;
}

function clearForwardSynctexMarker() {
  synctexOverlayState.forwardMessage = undefined;
  removeOverlays("[data-synctex-marker]");
}

function convertForwardMarkerToAnnotation() {
  const message = synctexOverlayState.forwardMessage;
  if (!message) return false;
  clearForwardSynctexMarker();
  return createAnnotationFromMessage(message, { select: true, bubble: false, scroll: false });
}

function clientPointToPdfPoint(event, pageNumber) {
  const page = pageElement(pageNumber);
  const viewport = pageViewport(pageNumber);
  const canvas = page ? pageCanvasElement(page) : undefined;
  if (!page || !viewport || !canvas) return undefined;
  const rect = (page.querySelector(".canvasWrapper") ?? canvas).getBoundingClientRect();
  return viewport.convertToPdfPoint(event.clientX - rect.left, rect.height - (event.clientY - rect.top));
}

function textNodeAtBoundary(root, node, offset, preferPrevious) {
  if (node.nodeType === Node.TEXT_NODE) return { node, offset };
  const children = Array.from(node.childNodes ?? []);
  const start = preferPrevious ? Math.min(children.length - 1, offset - 1) : Math.min(children.length - 1, offset);
  const step = preferPrevious ? -1 : 1;
  for (let index = start; index >= 0 && index < children.length; index += step) {
    const walker = document.createTreeWalker(children[index], NodeFilter.SHOW_TEXT);
    let candidate = preferPrevious ? undefined : walker.nextNode();
    if (preferPrevious) {
      let current = walker.nextNode();
      while (current) {
        candidate = current;
        current = walker.nextNode();
      }
    }
    if (candidate?.textContent) return { node: candidate, offset: preferPrevious ? candidate.textContent.length : 0 };
  }
  return undefined;
}

function boundaryClientRect(root, boundary) {
  const text = textNodeAtBoundary(root, boundary.node, boundary.offset, boundary.preferPrevious);
  if (!text?.node?.textContent) return undefined;
  const length = text.node.textContent.length;
  const start = boundary.preferPrevious ? text.offset - 1 : text.offset;
  const end = boundary.preferPrevious ? text.offset : text.offset + 1;
  if (start < 0 || end > length || start >= end) return undefined;
  const range = document.createRange();
  range.setStart(text.node, start);
  range.setEnd(text.node, end);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  return rect.width || rect.height ? rect : undefined;
}

function pdfPointFromRect(rect, page, viewport) {
  const canvas = pageCanvasElement(page);
  if (!canvas) return undefined;
  const canvasRect = (page.querySelector(".canvasWrapper") ?? canvas).getBoundingClientRect();
  return viewport.convertToPdfPoint(rect.left + rect.width / 2 - canvasRect.left, canvasRect.height - (rect.top + rect.height / 2 - canvasRect.top));
}

function reverseSynctexContextForPage(pageNumber) {
  const page = pageElement(pageNumber);
  const viewport = pageViewport(pageNumber);
  const selection = window.getSelection();
  if (!page || !viewport || !selection || selection.rangeCount === 0) return {};
  const textLayer = page.querySelector(".textLayer");
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
  const context = { selectedText };
  if (range.startContainer.nodeType === Node.TEXT_NODE && typeof range.startContainer.textContent === "string") {
    context.textBeforeSelection = range.startContainer.textContent.substring(0, range.startOffset);
  }
  if (range.endContainer.nodeType === Node.TEXT_NODE && typeof range.endContainer.textContent === "string") {
    context.textAfterSelection = range.endContainer.textContent.substring(range.endOffset);
  }
  const startRect = boundaryClientRect(textLayer, { node: range.startContainer, offset: range.startOffset, preferPrevious: false });
  const endRect = boundaryClientRect(textLayer, { node: range.endContainer, offset: range.endOffset, preferPrevious: true });
  if (!startRect || !endRect) return context;
  const start = pdfPointFromRect(startRect, page, viewport);
  const end = pdfPointFromRect(endRect, page, viewport);
  if (!start || !end) return context;
  return { ...context, selectionStartX: start[0], selectionStartY: start[1], selectionEndX: end[0], selectionEndY: end[1] };
}

function selectionSignature(pageNumber, context) {
  if (context.selectedText === undefined) return undefined;
  return [pageNumber, context.selectedText, context.selectionStartX, context.selectionStartY, context.selectionEndX, context.selectionEndY].join("|");
}

function currentSelectionSignature() {
  for (const page of document.querySelectorAll(".page[data-page-number]")) {
    const pageNumber = Number(page.dataset.pageNumber);
    if (!Number.isInteger(pageNumber) || pageNumber <= 0) continue;
    const signature = selectionSignature(pageNumber, reverseSynctexContextForPage(pageNumber));
    if (signature !== undefined) return signature;
  }
  return undefined;
}

function selectionPayload(pageNumber, context) {
  return {
    type: "reverse_synctex",
    page: pageNumber,
    x: context.selectionStartX,
    y: context.selectionStartY,
    selectedText: context.selectedText,
    selectionStartX: context.selectionStartX,
    selectionStartY: context.selectionStartY,
    selectionEndX: context.selectionEndX,
    selectionEndY: context.selectionEndY,
    ...(context.textBeforeSelection === undefined ? {} : { textBeforeSelection: context.textBeforeSelection }),
    ...(context.textAfterSelection === undefined ? {} : { textAfterSelection: context.textAfterSelection }),
  };
}

function sendSelectionPayload(pageNumber) {
  const context = reverseSynctexContextForPage(pageNumber);
  if (context.selectedText === undefined || context.selectionStartX === undefined || context.selectionStartY === undefined || context.selectionEndX === undefined || context.selectionEndY === undefined) {
    sendSelectionDebug("send_skip", pageNumber, { reason: "incomplete_selection", hasSelectedText: context.selectedText !== undefined, hasStart: context.selectionStartX !== undefined && context.selectionStartY !== undefined, hasEnd: context.selectionEndX !== undefined && context.selectionEndY !== undefined });
    return false;
  }
  const signature = selectionSignature(pageNumber, context);
  if (signature !== undefined && signature === lastSentSelectionSignature && selectionGeneration === lastSentSelectionGeneration) {
    sendSelectionDebug("suppress", pageNumber, { reason: "already_sent", signature, generation: selectionGeneration });
    return true;
  }
  lastSentSelectionSignature = signature;
  lastSentSelectionGeneration = selectionGeneration;
  const payload = selectionPayload(pageNumber, context);
  sendSelectionDebug("send", pageNumber, { signature, generation: selectionGeneration, selectedPayloadText: payload.selectedText, selectedPayloadTextLength: payload.selectedText.length, selectionStartX: payload.selectionStartX, selectionStartY: payload.selectionStartY, selectionEndX: payload.selectionEndX, selectionEndY: payload.selectionEndY });
  const sent = sendViewerSocketPayload(payload);
  setTimeout(() => {
    const currentText = window.getSelection()?.toString() ?? "";
    sendSelectionDebug("post_send_audit", pageNumber, { sentText: payload.selectedText, sentTextLength: payload.selectedText.length, currentText, currentTextLength: currentText.length, changed: currentText !== payload.selectedText });
  }, 300);
  return sent;
}

function scheduleSelectionPayload(pageNumber) {
  const request = { pageNumber };
  pendingSelectionSend = request;
  let observedGeneration = selectionGeneration;
  let observedSignature = currentSelectionSignature();
  let stableSamples = 0;
  const scheduleTick = (delay) => setTimeout(() => requestAnimationFrame(tick), delay);
  function tick() {
    if (pendingSelectionSend !== request) return;
    const signature = currentSelectionSignature();
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
    pendingSelectionSend = undefined;
    sendSelectionPayload(pageNumber);
  }
  scheduleTick(100);
}

document.addEventListener("selectionchange", () => {
  selectionGeneration += 1;
  const signature = currentSelectionSignature();
  sendSelectionDebug("selectionchange", undefined, { observedSignature: signature, generation: selectionGeneration });
});

function sendReverseSynctexClick(event, pageNumber) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  const point = clientPointToPdfPoint(event, pageNumber);
  if (!point) return false;
  if (sendSelectionPayload(pageNumber)) return true;
  return sendViewerSocketPayload({ type: "reverse_synctex", page: pageNumber, x: point[0], y: point[1], ...reverseSynctexContextForPage(pageNumber) });
}

function setHoverEnabled(enabled) {
  hostState.hoverEnabled = enabled;
  const button = document.getElementById("hostSynctexHoverButton");
  if (button) {
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.classList.toggle("toggled", enabled);
    button.title = enabled ? "Disable annotation mode" : "Enable annotation mode";
    button.setAttribute("aria-label", button.title);
  }
  if (!enabled) {
    latestHoverRequestId += 1;
    latestProbeRequestId += 1;
    pendingHover = undefined;
    pendingProbe = undefined;
    if (hoverTimer !== undefined) clearTimeout(hoverTimer);
    hoverTimer = undefined;
    removeOverlays("[data-reverse-synctex-hover]");
  } else {
    sendPendingProbe();
  }
  updateHostDataset();
}

function setDebugSynctexEnabled(enabled) {
  hostState.debugSynctexEnabled = enabled;
  const button = document.getElementById("hostSynctexDebugButton");
  if (button) {
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.classList.toggle("toggled", enabled);
    button.title = enabled ? "Disable SyncTeX debug overlays" : "Enable SyncTeX debug overlays";
    button.setAttribute("aria-label", button.title);
  }
  if (!enabled) {
    latestHoverRequestId += 1;
    pendingHover = undefined;
    if (hoverTimer !== undefined) clearTimeout(hoverTimer);
    hoverTimer = undefined;
    synctexOverlayState.hoverResult = undefined;
    removeOverlays("[data-reverse-synctex-hover]");
  }
  updateHostDataset();
}

function isEditableTarget(target) {
  const element = target instanceof Element ? target : undefined;
  if (!element) return false;
  return !!element.closest("input, textarea, select, button, a[href], [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], [role='button'], [role='textbox'], [role='combobox'], [role='listbox'], [role='slider'], [role='spinbutton']");
}

function isEditableEventTarget(event) {
  if (isEditableTarget(event.target)) return true;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return path.some((target) => isEditableTarget(target));
}

function hasEditableFocus() {
  return isEditableTarget(document.activeElement);
}

function invokeHistoryShortcut(direction, originalTarget) {
  if (isEditableTarget(originalTarget) || hasEditableFocus()) return false;
  return navigateHistory(direction);
}

function handleHistoryKeydown(event) {
  if (event.key === "Escape" && !hasEditableFocus()) {
    clearForwardSynctexMarker();
    return;
  }
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (key !== "o" && key !== "i") return;
  event.preventDefault();
  event.stopPropagation();
  invokeHistoryShortcut(key === "o" ? "back" : "forward", event.target);
}

function historyDirectionFromMouseEvent(event) {
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

function sideButtonDedupeKey(event, direction) {
  return `${direction}:${event.button}:${event.buttons}:${event.which}`;
}

function handleHistoryMouseButton(event) {
  const direction = historyDirectionFromMouseEvent(event);
  const rawDiagnostic = rememberRawMouseEvent(event, direction);
  sendSelectionDebug("lw_raw_mouse_event", undefined, rawDiagnostic);
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  rawDiagnostic.defaultPrevented = event.defaultPrevented;
  const key = sideButtonDedupeKey(event, direction);
  const now = performance.now();
  const recent = navigationHistory.lastSideButton;
  const alreadyHandled = recent?.key === key && now - recent.time < 250;
  if (!alreadyHandled && (event.type === "mousedown" || event.type === "auxclick")) {
    sendSelectionDebug("lw_raw_mouse_navigation", undefined, rawDiagnostic);
    invokeHistoryShortcut(direction, event.target);
    navigationHistory.lastSideButton = { key, time: now };
  }
}

function handleParentNavigationMessage(event) {
  if (event.source !== parent || !event.data) return;
  if (event.data.type === "host_lw_app_shell_mouse_diagnostic") {
    sendSelectionDebug("lw_app_shell_raw_mouse_event", undefined, event.data.diagnostic ?? {});
    return;
  }
  if (event.data.type !== "host_lw_navigation") return;
  const direction = event.data.direction === "forward" ? "forward" : event.data.direction === "back" ? "back" : undefined;
  if (!direction) return;
  invokeHistoryShortcut(direction, document.activeElement);
}

function pointInsideElement(element, x, y) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function handleToolsHitboxClick(event) {
  if (!(event instanceof MouseEvent) || event.defaultPrevented || event.button !== 0) return;
  const container = document.getElementById("secondaryToolbarToggle");
  const button = document.getElementById("secondaryToolbarToggleButton");
  if (!(button instanceof HTMLButtonElement)) return;
  const target = event.target instanceof Element ? event.target : undefined;
  if (target?.closest("#secondaryToolbarToggleButton")) return;
  if (!pointInsideElement(button, event.clientX, event.clientY) && !pointInsideElement(container, event.clientX, event.clientY)) return;
  event.preventDefault();
  event.stopPropagation();
  button.click();
}

function installToolsHitboxFallback() {
  for (const target of [window, document]) {
    target.addEventListener("click", handleToolsHitboxClick, true);
  }
}

function installNavigationHistoryControls() {
  const backButton = document.getElementById("historyBack");
  const forwardButton = document.getElementById("historyForward");
  const container = viewerContainer();
  backButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    navigateHistory("back");
  });
  forwardButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    navigateHistory("forward");
  });
  for (const target of [window, document]) {
    target.addEventListener("keydown", handleHistoryKeydown, true);
  }
  for (const eventName of ["mousedown", "mouseup", "auxclick"]) {
    for (const target of [window, document]) target.addEventListener(eventName, handleHistoryMouseButton, true);
  }
  window.addEventListener("message", handleParentNavigationMessage, true);
  container?.addEventListener("scroll", scheduleSettledNavigationCapture, { passive: true });
  app()?.eventBus?.on?.("pagechanging", scheduleSettledNavigationCapture);
  app()?.eventBus?.on?.("scalechanging", scheduleSettledNavigationCapture);
  navigationHistory.lastSettledState = captureNavigationState();
  updateNavigationButtons();
}

function updatePdfThemeButton(button, theme = activePdfTheme()) {
  const details = PDF_VIEWER_THEMES[theme] ?? PDF_VIEWER_THEMES.light;
  button.dataset.icon = details.icon;
  button.title = `${details.label} — click to switch to ${theme === "dark" ? "light" : "dark"}`;
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
}

function applyPdfTheme(theme) {
  const colors = pdfThemeColors(theme);
  globalThis.PDFViewerApplicationOptions?.setAll?.({
    forcePageColors: true,
    pageColorsBackground: colors.background,
    pageColorsForeground: colors.foreground,
    viewerCssTheme: 2,
  });
  document.documentElement.style.setProperty("color-scheme", "dark");
  const viewer = pdfViewer();
  if (viewer) {
    viewer.pageColors = { background: colors.background, foreground: colors.foreground };
    for (const pageView of viewer._pages ?? []) {
      pageView.pageColors = viewer.pageColors;
      pageView.div?.style.setProperty("--page-bg-color", colors.background);
    }
    viewer.refresh?.();
  }
  const button = document.getElementById("hostPdfThemeButton");
  if (button) updatePdfThemeButton(button, theme);
}

function installPdfThemeButton() {
  if (document.getElementById("hostPdfThemeButton")) return;
  const button = document.createElement("button");
  button.id = "hostPdfThemeButton";
  button.className = "toolbarButton";
  button.type = "button";
  button.tabIndex = 0;
  const label = document.createElement("span");
  label.textContent = "Toggle PDF theme";
  button.appendChild(label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextTheme = activePdfTheme() === "dark" ? "light" : "dark";
    setStoredPdfTheme(nextTheme);
    applyPdfTheme(nextTheme);
  });
  const anchor = document.getElementById("toolbarViewerRight")?.firstElementChild ?? document.getElementById("toolbarViewerRight");
  anchor?.parentNode?.insertBefore(button, anchor);
  updatePdfThemeButton(button);
  applyPdfTheme(activePdfTheme());
}

function installBrowserViewerToolbarLayout() {
  const left = document.getElementById("toolbarViewerLeft");
  const middle = document.getElementById("toolbarViewerMiddle");
  if (!left || !middle || middle.dataset.hostLayoutMoved === "true") return;
  middle.dataset.hostLayoutMoved = "true";
  for (const child of Array.from(middle.children)) left.appendChild(child);
  middle.hidden = true;
}

function installToolbarTabsContainer() {
  if (document.getElementById("hostPdfTabsContainer")) return;
  const toolbar = document.getElementById("toolbarViewer");
  const right = document.getElementById("toolbarViewerRight");
  if (!toolbar || !right) return;
  const strip = document.createElement("div");
  strip.id = "hostPdfTabsStrip";
  strip.className = "toolbarHorizontalGroup";
  strip.hidden = true;
  const leftScroll = document.createElement("button");
  leftScroll.id = "hostPdfTabScrollLeft";
  leftScroll.className = "toolbarButton hostPdfTabScrollButton";
  leftScroll.type = "button";
  leftScroll.hidden = true;
  leftScroll.setAttribute("aria-label", "Scroll PDF tabs left");
  const container = document.createElement("nav");
  container.id = "hostPdfTabsContainer";
  container.setAttribute("aria-label", "Open PDFs");
  const rightScroll = document.createElement("button");
  rightScroll.id = "hostPdfTabScrollRight";
  rightScroll.className = "toolbarButton hostPdfTabScrollButton";
  rightScroll.type = "button";
  rightScroll.hidden = true;
  rightScroll.setAttribute("aria-label", "Scroll PDF tabs right");
  leftScroll.addEventListener("click", () => scrollToolbarTabs(-1));
  rightScroll.addEventListener("click", () => scrollToolbarTabs(1));
  container.addEventListener("scroll", updateToolbarTabScrollButtons, { passive: true });
  strip.append(leftScroll, container, rightScroll);
  toolbar.insertBefore(strip, right);
  window.addEventListener("resize", updateToolbarTabScrollButtons);
}

function readLocalStorageJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function storedTabTitles() {
  return readLocalStorageJson(TAB_TITLE_STORAGE_KEY, {});
}

function customTabTitle(pdfId) {
  const title = storedTabTitles()[String(pdfId)];
  return typeof title === "string" && title.trim().length > 0 ? title : undefined;
}

function setCustomTabTitle(pdfId, title) {
  const titles = storedTabTitles();
  const key = String(pdfId);
  const trimmed = String(title || "").trim();
  if (trimmed.length > 0) {
    titles[key] = trimmed;
  } else {
    delete titles[key];
  }
  localStorage.setItem(TAB_TITLE_STORAGE_KEY, JSON.stringify(titles));
}

function tabDisplayTitle(tab, pdfId) {
  return customTabTitle(pdfId) || tab.title || tab.originalTitle || `PDF ${pdfId}`;
}

function storedTabOrder() {
  const value = readLocalStorageJson(TAB_ORDER_STORAGE_KEY, []);
  return Array.isArray(value) ? value.map((pdfId) => Number(pdfId)).filter((pdfId) => Number.isInteger(pdfId) && pdfId > 0) : [];
}

function setStoredTabOrder(order) {
  localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(order.map((pdfId) => Number(pdfId)).filter((pdfId) => Number.isInteger(pdfId) && pdfId > 0)));
}

function orderedTabsForRender(tabs) {
  const byId = new Map();
  for (const tab of tabs) {
    const pdfId = Number(tab.pdfId ?? tab.pdf_id);
    if (Number.isInteger(pdfId) && pdfId > 0) byId.set(pdfId, { ...tab, pdfId });
  }
  const ordered = [];
  const seen = new Set();
  for (const pdfId of storedTabOrder()) {
    const tab = byId.get(pdfId);
    if (!tab) continue;
    ordered.push(tab);
    seen.add(pdfId);
  }
  for (const [pdfId, tab] of byId) {
    if (seen.has(pdfId)) continue;
    ordered.push(tab);
  }
  return ordered;
}

function rememberDirectViewerTabOrderFromDom() {
  const order = Array.from(document.querySelectorAll("#hostPdfTabsContainer .hostPdfTab[data-pdf-id]"), (element) => Number(element.getAttribute("data-pdf-id"))).filter((pdfId) => Number.isInteger(pdfId) && pdfId > 0);
  if (order.length > 0) setStoredTabOrder(order);
}

function scrollToolbarTabs(direction) {
  const container = document.getElementById("hostPdfTabsContainer");
  if (!container) return;
  const delta = Math.max(160, Math.floor(container.clientWidth * 0.75));
  container.scrollBy({ left: direction * delta, behavior: "smooth" });
}

function updateToolbarTabScrollButtons() {
  const strip = document.getElementById("hostPdfTabsStrip");
  const container = document.getElementById("hostPdfTabsContainer");
  const left = document.getElementById("hostPdfTabScrollLeft");
  const right = document.getElementById("hostPdfTabScrollRight");
  if (!strip || !container || !left || !right) return;
  const hasTabs = container.childElementCount > 0;
  const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  const hasOverflow = hasTabs && maxScrollLeft > 1;
  strip.hidden = !hasTabs;
  left.hidden = !hasOverflow || container.scrollLeft <= 1;
  right.hidden = !hasOverflow || container.scrollLeft >= maxScrollLeft - 1;
}

function tabDragAfterElement(container, x) {
  const candidates = Array.from(container.querySelectorAll(".hostPdfTab:not(.is-dragging)"));
  return candidates.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    return offset < 0 && offset > closest.offset ? { offset, element: child } : closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: undefined }).element;
}

function installToolbarTabDragHandlers(item) {
  item.draggable = true;
  item.addEventListener("dragstart", (event) => {
    item.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", item.dataset.pdfId || "");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("is-dragging");
    rememberDirectViewerTabOrderFromDom();
    renderToolbarTabs(currentDirectTabsState());
  });
}

function installToolbarTabContainerDragHandlers(container) {
  if (container.dataset.dragHandlersInstalled === "true") return;
  container.dataset.dragHandlersInstalled = "true";
  container.addEventListener("dragover", (event) => {
    const dragging = container.querySelector(".hostPdfTab.is-dragging");
    if (!dragging) return;
    event.preventDefault();
    const after = tabDragAfterElement(container, event.clientX);
    if (after) container.insertBefore(dragging, after);
    else container.appendChild(dragging);
    updateToolbarTabScrollButtons();
  });
}

function beginToolbarTabRename(button, tab, pdfId) {
  const currentTitle = tabDisplayTitle(tab, pdfId);
  const input = document.createElement("input");
  input.className = "hostPdfTabRenameInput";
  input.type = "text";
  input.value = currentTitle;
  input.setAttribute("aria-label", `Rename ${currentTitle}`);
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    const nextTitle = input.value.trim();
    if (commit && nextTitle.length > 0) {
      setCustomTabTitle(pdfId, nextTitle);
      const current = directViewerTabs.get(pdfId);
      if (current) {
        current.title = nextTitle;
        directViewerTabs.set(pdfId, current);
      }
      if (pdfId === activePdfId()) document.title = nextTitle;
    }
    renderToolbarTabs(currentDirectTabsState());
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  button.replaceWith(input);
  input.focus();
  input.select();
}

function renderToolbarTabs(tabState) {
  const container = document.getElementById("hostPdfTabsContainer");
  if (!container) return;
  const tabs = Array.isArray(tabState?.tabs) ? tabState.tabs : [];
  const activeTabPdfId = Number(tabState?.activePdfId ?? activePdfId());
  const strip = document.getElementById("hostPdfTabsStrip");
  installToolbarTabContainerDragHandlers(container);
  container.replaceChildren();
  container.dataset.tabCount = String(tabs.length);
  if (strip) strip.dataset.tabCount = String(tabs.length);
  for (const tab of orderedTabsForRender(tabs)) {
    const pdfId = Number(tab.pdfId ?? tab.pdf_id);
    if (!Number.isInteger(pdfId) || pdfId <= 0) continue;
    const selected = pdfId === activeTabPdfId;
    const item = document.createElement("div");
    item.className = selected ? "hostPdfTab is-active" : "hostPdfTab";
    item.dataset.pdfId = String(pdfId);
    installToolbarTabDragHandlers(item);
    const title = tabDisplayTitle(tab, pdfId);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hostPdfTabButton";
    button.dataset.pdfId = String(pdfId);
    button.setAttribute("aria-current", selected ? "page" : "false");
    button.title = selected ? "Rename active PDF tab" : title;
    button.textContent = title;
    button.addEventListener("click", (event) => {
      const viewerUrl = tab.viewerUrl || `/viewer-lw/${encodeURIComponent(String(pdfId))}`;
      if (selected) {
        event.preventDefault();
        event.stopPropagation();
        beginToolbarTabRename(button, tab, pdfId);
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "host_lw_select_tab", pdfId }, location.origin);
      } else {
        void switchDirectViewerTab(pdfId, viewerUrl);
      }
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "hostPdfTabClose";
    close.dataset.closePdfId = String(pdfId);
    close.setAttribute("aria-label", `Close ${title}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "host_lw_close_tab", pdfId }, location.origin);
      } else {
        closeDirectViewerTab(pdfId);
      }
    });
    item.append(button, close);
    container.appendChild(item);
  }
  requestAnimationFrame(updateToolbarTabScrollButtons);
}

function notifyDirectViewerTabSelected(tab) {
  if (!tab) return;
  void fetch("/app-tab-selected", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pdf_id: tab.pdfId, revision: tab.revision, viewer_url: tab.viewerUrl, visible_tab_token: tab.visibleTabToken }),
  }).catch(() => undefined);
}

async function switchDirectViewerTab(pdfId, viewerUrl) {
  if (pdfId === activePdfId()) {
    notifyDirectViewerTabSelected(directViewerTabs.get(pdfId));
    return;
  }
  try {
    const tab = directViewerTabs.get(pdfId);
    notifyDirectViewerTabSelected(tab);
    const tabRevision = Number(tab?.revision);
    const cached = pdfByteCache.get(pdfId);
    const config = cached?.config && cached.revision === tabRevision ? cached.config : await fetchConfigForPdfId(pdfId);
    if (cached?.revision === tabRevision && cached.inFlight) await cached.inFlight.catch(() => undefined);
    persistAnnotations();
    disconnectViewerSocket();
    clearForwardSynctexMarker();
    clearAnnotations({ persist: false });
    hostState.config = config;
    hostState.visibleRevision = Number(config.revision);
    hostState.latestRevision = Number(config.revision);
    applyCompileStateForActivePdf();
    document.title = tabDisplayTitle(tab || config, pdfId) || document.title;
    await refreshToConfig(config, { preserveView: false });
    restoreAnnotationsForActivePdf();
    setDebugSynctexEnabled(config.debug_synctex === true);
    connectViewerSocket();
    history.pushState({ pdfId }, "", viewerUrl || `/viewer-lw/${encodeURIComponent(String(pdfId))}`);
    renderToolbarTabs(currentDirectTabsState());
  } catch (error) {
    hostState.lastError = `tab switch failed: ${error?.message ?? String(error)}`;
    updateHostDataset();
  }
}

function currentDirectTabsState() {
  return {
    activePdfId: activePdfId(),
    tabs: Array.from(directViewerTabs.values()),
  };
}

function updateDirectViewerTab(message) {
  const pdfId = Number(message.pdf_id);
  if (!Number.isInteger(pdfId) || pdfId <= 0) return;
  const revision = Number(message.revision);
  const originalTitle = message.title || `PDF ${pdfId}`;
  const tab = {
    pdfId,
    title: customTabTitle(pdfId) || originalTitle,
    originalTitle,
    revision,
    viewerUrl: message.viewer_url || `/viewer-lw/${encodeURIComponent(String(pdfId))}`,
    visibleTabToken: message.visible_tab_token,
  };
  const shouldLoadIntoEmptyDirectViewer = window.parent === window && !hasActiveConfig(hostState.config);
  directViewerTabs.set(pdfId, tab);
  if (shouldLoadIntoEmptyDirectViewer) {
    void switchDirectViewerTab(pdfId, tab.viewerUrl);
    return;
  }
  if (pdfId === activePdfId()) document.title = tabDisplayTitle(tab, pdfId);
  renderToolbarTabs(currentDirectTabsState());
  const cached = pdfByteCache.get(pdfId);
  if (cached?.revision !== revision || (!cached.bytes && !cached.inFlight)) {
    void fetchConfigForPdfId(pdfId).then((config) => prefetchPdfBytes(config)).catch(() => undefined);
  }
}

function closeDirectViewerTab(pdfId) {
  const tab = directViewerTabs.get(pdfId);
  directViewerTabs.delete(pdfId);
  renderToolbarTabs(currentDirectTabsState());
  void fetch("/app-tab-closed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pdf_id: pdfId, revision: tab?.revision, viewer_url: tab?.viewerUrl, visible_tab_token: tab?.visibleTabToken }),
  }).catch(() => undefined);
  if (pdfId === activePdfId()) {
    const next = orderedTabsForRender(Array.from(directViewerTabs.values())).at(-1);
    if (next?.viewerUrl) {
      void switchDirectViewerTab(next.pdfId, next.viewerUrl);
    } else {
      persistAnnotations();
      disconnectViewerSocket();
      clearForwardSynctexMarker();
      clearAnnotations({ persist: false });
      hostState.config = emptyViewerConfig();
      hostState.visibleRevision = 0;
      hostState.latestRevision = 0;
      hostState.lastError = undefined;
      hostState.debugSynctexEnabled = false;
      applyCompileStateForActivePdf();
      clearSynctexCapabilityIssue();
      document.title = "PDF Viewer";
      void app()?.close?.();
      updateHostDataset();
    }
  }
}

function connectDirectViewerTabs() {
  if (directViewerTabsConnected || typeof EventSource === "undefined") return;
  directViewerTabsConnected = true;
  if (hasActiveConfig(hostState.config)) {
    updateDirectViewerTab({
      type: "open_pdf",
      pdf_id: activePdfId(),
      title: hostState.config.title,
      revision: hostState.config.revision,
      viewer_url: `/viewer-lw/${encodeURIComponent(String(activePdfId()))}`,
    });
    void prefetchPdfBytes(hostState.config).catch(() => undefined);
  } else {
    renderToolbarTabs(currentDirectTabsState());
  }
  const events = new EventSource("/app-events");
  events.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message?.type === "open_pdf" || message?.type === "focus_pdf") updateDirectViewerTab(message);
    } catch {}
  });
}

function installHostTabMessageListener() {
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.type !== "host_lw_tabs_state") return;
    renderToolbarTabs(message);
  });
  window.parent?.postMessage?.({ type: "host_lw_tabs_ready", pdfId: activePdfId() }, location.origin);
  connectDirectViewerTabs();
}

function installHoverToolbarButton() {
  if (document.getElementById("hostSynctexHoverButton")) return;
  const button = document.createElement("button");
  button.id = "hostSynctexHoverButton";
  button.className = "toolbarButton hostAnnotationButton";
  button.type = "button";
  button.tabIndex = 0;
  const label = document.createElement("span");
  label.textContent = "💬";
  label.setAttribute("aria-hidden", "true");
  button.appendChild(label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setHoverEnabled(!hostState.hoverEnabled);
  });
  const clearButton = document.createElement("button");
  clearButton.id = "hostClearAnnotationsButton";
  clearButton.className = "toolbarButton hostAnnotationButton";
  clearButton.type = "button";
  clearButton.tabIndex = 0;
  clearButton.title = "Clear all marks and comments";
  clearButton.setAttribute("aria-label", clearButton.title);
  const clearLabel = document.createElement("span");
  clearLabel.textContent = "🧹";
  clearLabel.setAttribute("aria-hidden", "true");
  clearButton.appendChild(clearLabel);
  clearButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearUserAnnotations();
  });
  const separator = document.createElement("div");
  separator.className = "verticalToolbarSeparator hostSynctexSeparator";
  const anchor = document.getElementById("toolbarViewerRight")?.firstElementChild ?? document.getElementById("toolbarViewerRight");
  anchor?.parentNode?.insertBefore(separator, anchor);
  anchor?.parentNode?.insertBefore(button, anchor);
  anchor?.parentNode?.insertBefore(clearButton, anchor);
  setHoverEnabled(true);
}

function scheduleHover(event, pageNumber) {
  if (!hostState.debugSynctexEnabled || !viewerSocketOpen()) return;
  const point = clientPointToPdfPoint(event, pageNumber);
  if (!point) return;
  const requestId = hoverRequestId + 1;
  hoverRequestId = requestId;
  latestHoverRequestId = requestId;
  pendingHover = { type: "reverse_synctex_hover", request_id: requestId, page: pageNumber, x: point[0], y: point[1], ...reverseSynctexContextForPage(pageNumber) };
  if (hoverTimer !== undefined) return;
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined;
    const payload = pendingHover;
    pendingHover = undefined;
    if (!hostState.debugSynctexEnabled || !payload) return;
    sendViewerSocketPayload(payload);
  }, HOVER_THROTTLE_MS);
}

function sendPendingProbe() {
  if (!pendingProbe || !hostState.hoverEnabled || !viewerSocketOpen()) return;
  const payload = pendingProbe;
  pendingProbe = undefined;
  sendViewerSocketPayload(payload);
}

function sendProbe(event, pageNumber) {
  if (!hostState.hoverEnabled || event.ctrlKey || event.metaKey) return;
  if (isEditableEventTarget(event)) return;
  if ((window.getSelection()?.toString() ?? "").length > 0) return;
  const point = clientPointToPdfPoint(event, pageNumber);
  if (!point) return;
  const requestId = probeRequestId + 1;
  probeRequestId = requestId;
  latestProbeRequestId = requestId;
  removeOverlays("[data-reverse-synctex-forward-probe]");
  const payload = { type: "reverse_synctex_forward_probe", request_id: requestId, page: pageNumber, x: point[0], y: point[1], ...reverseSynctexContextForPage(pageNumber) };
  if (viewerSocketOpen()) {
    sendViewerSocketPayload(payload);
    return;
  }
  pendingProbe = payload;
}

function hoverDiagnosticsLabel(message) {
  const file = String(message.source_file || "").split(/[\\/]/).pop() || "source";
  return `${file}:${message.line ?? "?"}${message.source_line ? ` ${String(message.source_line).slice(0, 100)}` : ""}`;
}

function hoverRectPosition(rect, page, viewport) {
  const leftTop = viewport.convertToViewportPoint(Number(rect.left), Number(rect.top));
  const rightBottom = viewport.convertToViewportPoint(Number(rect.right), Number(rect.bottom));
  const pageHeight = pageViewportHeight(page, viewport);
  return {
    left: Math.min(leftTop[0], rightBottom[0]),
    top: pageHeight - Math.max(leftTop[1], rightBottom[1]),
    width: Math.max(2, Math.abs(rightBottom[0] - leftTop[0])),
    height: Math.max(2, Math.abs(leftTop[1] - rightBottom[1])),
  };
}

function showHoverResult(message, options = {}) {
  if (!hostState.debugSynctexEnabled || Number(message.request_id) !== latestHoverRequestId) return;
  if (options.remember !== false) synctexOverlayState.hoverResult = message;
  removeOverlays("[data-reverse-synctex-hover]");
  if (message.error || !message.rect) return;
  const pageNumber = Number(message.page);
  const page = pageElement(pageNumber);
  const viewport = pageViewport(pageNumber);
  if (!page || !viewport) return;
  const position = hoverRectPosition(message.rect, page, viewport);
  const overlayParent = pageOverlayParent(page);
  const marker = document.createElement("div");
  marker.dataset.reverseSynctexHover = "rect";
  marker.style.position = "absolute";
  marker.style.pointerEvents = "none";
  marker.style.zIndex = "100001";
  marker.style.left = `${position.left}px`;
  marker.style.top = `${position.top}px`;
  marker.style.width = `${position.width}px`;
  marker.style.height = `${position.height}px`;
  marker.style.outline = "2px solid rgba(14,165,233,.9)";
  marker.style.background = "rgba(14,165,233,.18)";
  const label = document.createElement("div");
  label.dataset.reverseSynctexHover = "label";
  label.className = "hostSynctexOverlayLabel";
  label.style.left = `${Math.max(0, position.left)}px`;
  label.style.top = `${Math.max(0, position.top - 28)}px`;
  label.textContent = hoverDiagnosticsLabel(message);
  overlayParent.append(marker, label);
}

function showProbeResult(message, options = {}) {
  if (Number(message.request_id) !== latestProbeRequestId) return;
  if (message.error) {
    setSynctexCapabilityIssue(synctexCapabilityIssueFromError(message.error));
    const label = document.createElement("div");
    label.dataset.reverseSynctexForwardProbe = "label";
    label.className = "hostSynctexOverlayLabel";
    label.textContent = String(message.error);
    label.style.left = "0px";
    label.style.top = "0px";
    renderSynctexOverlay(message, { selector: "[data-reverse-synctex-forward-probe]", datasetName: "reverseSynctexForwardProbe", label, scroll: options.scroll !== false });
    return;
  }
  if (options.remember === false) {
    renderAnnotations(false);
    return;
  }
  if (createAnnotationFromMessage(message, { select: true, bubble: false, scroll: options.scroll !== false })) clearSynctexCapabilityIssue();
}

function decodePdfHashDestination(hash) {
  const value = String(hash ?? "");
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return unescape(value);
    } catch {
      return value;
    }
  }
}

async function explicitDestinationPageNumber(destination) {
  const application = app();
  const pdfDocument = application?.pdfDocument;
  if (!pdfDocument) return undefined;
  const explicitDest = typeof destination === "string" ? await pdfDocument.getDestination(destination) : await destination;
  if (!Array.isArray(explicitDest)) return undefined;
  const [destRef] = explicitDest;
  if (destRef && typeof destRef === "object") {
    const cached = pdfDocument.cachedPageNumber(destRef);
    if (cached) return cached;
    try {
      return (await pdfDocument.getPageIndex(destRef)) + 1;
    } catch {
      return undefined;
    }
  }
  return Number.isInteger(destRef) ? destRef + 1 : undefined;
}

async function outlineItems() {
  const pdfDocument = app()?.pdfDocument;
  if (!pdfDocument) return [];
  outlinePromise ??= pdfDocument.getOutline().catch(() => []);
  return await outlinePromise;
}

function findOutlineDestinationByTitle(items, title) {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (item?.title === title && item.dest) return item.dest;
    const nested = findOutlineDestinationByTitle(item?.items, title);
    if (nested) return nested;
  }
  return undefined;
}

async function preferredNamedDestination(name) {
  const application = app();
  const pdfDocument = application?.pdfDocument;
  if (!pdfDocument || !name) return undefined;
  const directDest = await pdfDocument.getDestination(name).catch(() => undefined);
  const outlineDest = findOutlineDestinationByTitle(await outlineItems(), name);
  if (outlineDest) {
    const [directPage, outlinePage] = await Promise.all([
      directDest ? explicitDestinationPageNumber(directDest) : undefined,
      explicitDestinationPageNumber(outlineDest),
    ]);
    if (outlinePage && outlinePage !== directPage) return outlineDest;
  }
  return directDest ? name : undefined;
}

async function navigateNamedDestinationHash(hash) {
  if (!hash || hash.includes("=")) return false;
  const name = decodePdfHashDestination(hash);
  if (!name || name.trim().startsWith("[")) return false;
  const destination = await preferredNamedDestination(name);
  if (!destination) return false;
  app()?.pdfLinkService?.goToDestination(destination);
  return true;
}

async function applyInitialHashWhenReady() {
  if (!initialViewerHash || !hasActiveConfig(hostState.config)) return;
  const expectedPdfId = activePdfId();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && activePdfId() === expectedPdfId && location.hash.slice(1) === initialViewerHash) {
    await waitForPagesReady(app()).catch(() => undefined);
    const application = app();
    if (application?.pdfDocument && application?.pdfLinkService && application.isInitialViewSet) {
      if (!await navigateNamedDestinationHash(initialViewerHash)) application.pdfLinkService.setHash(initialViewerHash);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function internalLinkHashFromEvent(event) {
  const target = event.target instanceof Element ? event.target : undefined;
  const link = target?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return undefined;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || !url.hash) return undefined;
  return url.hash.slice(1);
}

function installPageEventHandlers() {
  const viewer = document.getElementById("viewer");
  if (!viewer || viewer.dataset.hostSynctexHandlers === "true") return;
  viewer.dataset.hostSynctexHandlers = "true";
  viewer.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const linkHash = internalLinkHashFromEvent(event);
    if (linkHash) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void navigateNamedDestinationHash(linkHash).then((handled) => {
        if (!handled) app()?.pdfLinkService?.setHash(linkHash);
      });
      return;
    }
    if (isEditableEventTarget(event)) return;
    if (target?.closest("[data-pdf-annotation]")) return;
    if (target?.closest("[data-synctex-marker]")) {
      event.preventDefault();
      event.stopPropagation();
      convertForwardMarkerToAnnotation();
      return;
    }
    const pageNumber = pageNumberFromElement(event.target);
    if (!pageNumber) return;
    selectedAnnotationId = undefined;
    renderAnnotations(false);
    if (sendReverseSynctexClick(event, pageNumber)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    sendProbe(event, pageNumber);
  }, true);
  viewer.addEventListener("mousedown", (event) => {
    const pageNumber = pageNumberFromElement(event.target);
    if (!pageNumber || event.button !== 0) return;
    sendSelectionDebug("mousedown", pageNumber, { clientX: event.clientX, clientY: event.clientY, generation: selectionGeneration });
  }, true);
  viewer.addEventListener("mouseup", (event) => {
    const pageNumber = pageNumberFromElement(event.target);
    if (!pageNumber || event.button !== 0) return;
    const selectedText = window.getSelection()?.toString() ?? "";
    sendSelectionDebug("mouseup", pageNumber, { clientX: event.clientX, clientY: event.clientY, selectedTextLength: selectedText.length, generation: selectionGeneration });
    if (selectedText.length > 0) scheduleSelectionPayload(pageNumber);
  }, true);
  viewer.addEventListener("mousemove", (event) => {
    const pageNumber = pageNumberFromElement(event.target);
    if (!pageNumber) return;
    scheduleHover(event, pageNumber);
  }, true);
}

function handleHostMessage(message) {
  if (!message) return;
  if (message.type === "error") {
    setSynctexCapabilityIssue(synctexCapabilityIssueFromError(message.message ?? message.code, "viewer_message_error"));
    return;
  }
  if (message.type === "annotations_cleared") {
    clearAnnotationsFromHostMessage(message);
    return;
  }
  if (message.type === "compile_status") {
    setCompileStatus(message);
    return;
  }
  if (Number(message.pdf_id) !== activePdfId()) return;
  if (message.type === "pdf_refresh") {
    const nextRevision = Number(message.revision);
    if (!Number.isFinite(nextRevision) || nextRevision < hostState.latestRevision) return;
    const nextConfig = { ...hostState.config, revision: nextRevision, pdf_url: message.pdf_url };
    hostState.latestRevision = nextRevision;
    updateHostDataset();
    void prefetchPdfBytes(nextConfig).catch(() => undefined).then(() => refreshToConfig(nextConfig));
  } else if (message.type === "synctex_forward") {
    pushNavigationHistory();
    showSynctexMarker(message);
  } else if (message.type === "set_debug_synctex") {
    setDebugSynctexEnabled(message.enabled === true);
  } else if (message.type === "reverse_synctex_hover_result") {
    if (message.error) setSynctexCapabilityIssue(synctexCapabilityIssueFromError(message.error));
    else clearSynctexCapabilityIssue();
    showHoverResult(message);
  } else if (message.type === "reverse_synctex_forward_probe_result") {
    showProbeResult(message);
  }
}

function scheduleViewerSocketReconnect() {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectViewerSocket();
  }, 300);
}

async function reportInitialLoadedState() {
  if (!hasActiveConfig(hostState.config)) return;
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      const state = viewerLoadedState({ trigger: "pages_ready" });
      if (state.pdfDocumentLoaded && state.pagesCount > 0 && state.renderedPageCount > 0 && state.canvasCount > 0) {
        sendLoadedStateDiagnostic("lw_loaded_state", { trigger: "pages_ready" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    sendLoadedStateDiagnostic("lw_loaded_state", { trigger: "pages_ready_timeout" });
  } catch (error) {
    hostState.lastError = `initial load diagnostic failed: ${error?.message ?? String(error)}`;
    updateHostDataset();
    sendLoadedStateDiagnostic("lw_loaded_state", { trigger: "pages_ready_error" });
  }
}

function disconnectViewerSocket() {
  const socket = activeSocket;
  activeSocket = undefined;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  pendingHover = undefined;
  pendingProbe = undefined;
  if (hoverTimer !== undefined) clearTimeout(hoverTimer);
  hoverTimer = undefined;
  socket?.close?.();
  hostState.socketStatus = "disconnected";
  updateHostDataset();
}

function connectViewerSocket() {
  const socketUrl = hostState.config?.viewer_socket_url;
  if (!socketUrl) {
    if (hasActiveConfig(hostState.config)) setSynctexCapabilityIssue({
      code: "server_unreachable",
      title: "Viewer Host connection is unavailable",
      detail: "The PDF has no Viewer Host socket URL, so SyncTeX annotations cannot be sent.",
    });
    return;
  }
  const socket = new WebSocket(socketUrl);
  activeSocket = socket;
  hostState.socketStatus = "connecting";
  updateHostDataset();
  socket.addEventListener("open", () => {
    if (activeSocket !== socket) return;
    hostState.socketStatus = "connected";
    clearSynctexCapabilityIssue("server_unreachable");
    updateHostDataset();
    sendLoadedStateDiagnostic("lw_loaded_state", { trigger: "socket_open" });
    sendToolsHitTargetDiagnostic("socket_open");
    sendPendingProbe();
    sendCompileAction("status");
  });
  socket.addEventListener("message", (event) => {
    if (activeSocket !== socket) return;
    try {
      handleHostMessage(JSON.parse(event.data));
    } catch (error) {
      hostState.lastError = `socket message failed: ${error?.message ?? String(error)}`;
      setSynctexCapabilityIssue(synctexCapabilityIssueFromError(hostState.lastError, "viewer_message_error"));
      updateHostDataset();
    }
  });
  socket.addEventListener("close", () => {
    if (activeSocket !== socket) return;
    hostState.socketStatus = "disconnected";
    if (hasActiveConfig(hostState.config)) setSynctexCapabilityIssue({
      code: "server_unreachable",
      title: "Viewer Host connection is unavailable",
      detail: "The SyncTeX annotation socket disconnected. Reconnecting…",
    });
    updateHostDataset();
    scheduleViewerSocketReconnect();
  });
  socket.addEventListener("error", () => {
    if (activeSocket !== socket) return;
    hostState.socketStatus = "error";
    setSynctexCapabilityIssue({
      code: "server_unreachable",
      title: "Viewer Host connection is unavailable",
      detail: "The browser could not reach the local Viewer Host socket. Check that the Viewer Host process is still running and reopen the PDF if needed.",
    });
    updateHostDataset();
  });
}

forceShowLaTeXWorkshopChrome();

installWebViewerLoadedConfigListener();

await import("/viewer-lw/viewer.mjs");
forceShowLaTeXWorkshopChrome();
installNavigationHistoryControls();
installSynctexOverlayRedrawHandlers();
installBrowserViewerToolbarLayout();
installToolbarTabsContainer();
installHostTabMessageListener();
installPdfThemeButton();
installHoverToolbarButton();
installCompileToolbarButtons();
setDebugSynctexEnabled(initialConfig.debug_synctex === true);
installToolsHitboxFallback();
installPageEventHandlers();
void applyInitialHashWhenReady();
void restoreAnnotationsForActivePdfWhenReady();
if (hasActiveConfig(initialConfig)) connectViewerSocket();
updateHostDataset();
void reportInitialLoadedState();

globalThis.__hostLwRefreshDebug = {
  state: () => ({ ...hostState }),
  capture: captureRefreshState,
  loadedState: viewerLoadedState,
};

globalThis.__hostLwSynctexDebug = {
  showSynctexMarker,
  setHoverEnabled,
  pointFromClient: clientPointToPdfPoint,
};

globalThis.__hostLwNavigationHistoryDebug = {
  capture: captureNavigationState,
  state: () => ({ back: navigationHistory.back.slice(), forward: navigationHistory.forward.slice() }),
  navigate: navigateHistory,
  invoke: invokeHistoryShortcut,
};

globalThis.__hostLwToolsHitTargetDebug = collectToolsHitTargetDiagnostics;
globalThis.__hostLwRawMouseDebug = () => recentRawMouseEvents.slice();

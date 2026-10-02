/**
 * The pack viewer's runtime in the browser (PHASE_19 P19-19): the MCP Apps
 * bridge to the host, polling and drawing. Shipped inside the viewer's HTML
 * like ./state.ts and ./render.ts, so it is SELF CONTAINED: everything it
 * uses arrives as a parameter (the window, the state and render functions,
 * the copy and the settings).
 *
 * Bridge (MCP Apps 2026-01-26, docs/verification.md "p19/ui"): JSON-RPC 2.0
 * over postMessage with the parent window. The viewer sends ui/initialize
 * and, once answered, ui/notifications/initialized. The host then sends
 * ui/notifications/tool-input (the seller confirmed create_pack) and
 * ui/notifications/tool-result (create_pack's result). While the pack is not
 * finished the viewer calls get_pack every few seconds through tools/call
 * (the only tool it ever calls; the host refuses any tool without "app" in
 * its visibility, M5), up to a cap. Links open with ui/open-link when the
 * host offers it, else window.openai.openExternal with redirectUrl false
 * (O2). "See all" asks for fullscreen with ui/request-display-mode. Messages
 * from anything but the parent window are ignored. ChatGPT's window.openai
 * aliases (toolInput, toolOutput, callTool, requestDisplayMode,
 * setOpenInAppUrl) are used only where the bridge does not cover a step.
 */

import type { PackViewerCopy } from "./copy";
import type { ViewerActions, renderPackViewer } from "./render";
import type { ViewerUi, initialViewerState, reduceViewer, viewerViewOf } from "./state";

/** The functions the runtime drives, each embedded from its own source. */
export interface ViewerLib {
  initial: typeof initialViewerState;
  reduce: typeof reduceViewer;
  view: typeof viewerViewOf;
  render: typeof renderPackViewer;
}

export interface ViewerConfig {
  /** The site origin of every link, such as https://curvi.ai. */
  origin: string;
  /** The tool the viewer polls: get_pack. */
  tool: string;
  pollMs: number;
  pollCapMs: number;
  maxPollErrors: number;
  /** How long a bridge request may wait for its answer. */
  requestTimeoutMs: number;
  /** How often the viewer checks the clock (link expiry, the poll cap). */
  tickMs: number;
  maxCarousel: number;
  /** MCP Apps protocol version the viewer speaks. */
  protocolVersion: string;
  appName: string;
  appVersion: string;
}

/** ChatGPT's optional window.openai helpers the viewer may use. */
export interface OpenAiGlobals {
  toolInput?: unknown;
  toolOutput?: unknown;
  callTool?: (name: string, args: Record<string, unknown>) => unknown;
  openExternal?: (options: { href: string; redirectUrl: false }) => unknown;
  requestDisplayMode?: (options: { mode: string }) => unknown;
  setOpenInAppUrl?: (options: { href: string }) => unknown;
  widgetState?: unknown;
  setWidgetState?: (state: unknown) => unknown;
}

/** What the runtime needs from the window: the real window in the browser, a
 * fake one in tests. */
export interface ViewerWindow {
  document: Document;
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: string, listener: (event: { source?: unknown; data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { source?: unknown; data?: unknown }) => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  openai?: OpenAiGlobals;
  open?: (url: string, target: string, features: string) => unknown;
  ResizeObserver?: new (callback: () => void) => { observe(target: unknown): void; disconnect(): void };
}

export interface ViewerHandle {
  /** The current state (tests). */
  state(): ReturnType<typeof initialViewerState>;
  /** Stops timers and listeners, as on ui/resource-teardown. */
  stop(): void;
}

/** Starts the viewer. Self contained (see the file comment). */
export function startPackViewer(win: ViewerWindow, lib: ViewerLib, copy: PackViewerCopy, config: ViewerConfig): ViewerHandle {
  type Json = Record<string, unknown>;
  type Listener = (event: { source?: unknown; data?: unknown }) => void;
  const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
  const doc = win.document;
  const root = (doc.getElementById("root") ?? doc.body) as HTMLElement;
  let state = lib.initial();
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: unknown }>();
  let hostCaps: Json = {};
  let hostModes: string[] = [];
  let displayMode = "inline";
  let expanded = false;
  let ready = false;
  let stopped = false;
  let pollTimer: unknown = null;
  let inFlight = false;
  let lastHeight = -1;
  let openInAppSet: string | null = null;
  let drawnKey = "";
  let resizeObserver: { disconnect(): void } | null = null;
  let lastRefreshAt = -Infinity;
  let lastHostResult = "";
  let savedState = "";
  const legacyTimers = new Set<unknown>();
  let packEpoch = 0;

  const openai = (): OpenAiGlobals | null => (isObject(win.openai) ? win.openai : null);
  const send = (message: Json): void => {
    try {
      win.parent.postMessage(message, "*");
    } catch {
      // The host went away; nothing to tell it.
    }
  };
  const notify = (method: string, params: Json): void => send({ jsonrpc: "2.0", method, params });
  const request = (method: string, params: Json): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = win.setTimeout(() => {
        pending.delete(id);
        reject(new Error("timeout"));
      }, config.requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const fullscreen = (): boolean => displayMode === "fullscreen" || expanded;
  const onSite = (url: string): boolean => typeof url === "string" && url.indexOf(`${config.origin}/`) === 0;

  const reportSize = (): void => {
    if (!ready || stopped) {
      return;
    }
    const element = doc.documentElement as HTMLElement | null;
    const height = Math.ceil((element && element.scrollHeight) || 0);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      notify("ui/notifications/size-changed", { height });
    }
  };

  const actions: ViewerActions = {
    refresh() {
      if (!ready || stopped || inFlight || !state.pack || Date.now() - lastRefreshAt < config.pollMs) return;
      lastRefreshAt = Date.now();
      dispatch({ type: "refresh" });
      if (!canCallTools()) return;
      if (pollTimer !== null) win.clearTimeout(pollTimer);
      pollTimer = null;
      poll();
    },
    open(url) {
      if (!onSite(url)) {
        return;
      }
      const fallback = (): void => {
        const helpers = openai();
        if (helpers && typeof helpers.openExternal === "function") {
          try {
            helpers.openExternal({ href: url, redirectUrl: false });
            return;
          } catch {
            // Fall through to a plain window.
          }
        }
        if (typeof win.open === "function") {
          try {
            win.open(url, "_blank", "noopener");
          } catch {
            // Nothing else can open it.
          }
        }
      };
      if (isObject(hostCaps.openLinks)) {
        // A denial by the seller or the host's policy is final.
        request("ui/open-link", { url }).catch(() => undefined);
      } else {
        fallback();
      }
    },
    seeAll() {
      const done = (mode: unknown): void => {
        if (typeof mode === "string") {
          displayMode = mode;
        }
        // No fullscreen: show every file inline instead.
        expanded = displayMode !== "fullscreen";
        draw();
      };
      if (hostModes.indexOf("fullscreen") >= 0) {
        request("ui/request-display-mode", { mode: "fullscreen" }).then(
          (result) => done(isObject(result) ? result.mode : undefined),
          () => done(undefined),
        );
        return;
      }
      const helpers = openai();
      if (helpers && typeof helpers.requestDisplayMode === "function") {
        try {
          helpers.requestDisplayMode({ mode: "fullscreen" });
        } catch {
          // Shown inline below.
        }
      }
      expanded = true;
      draw();
    },
    linkFailed() {
      dispatch({ type: "link_failed" });
    },
  };

  function draw(): void {
    if (stopped) {
      return;
    }
    const helpers = openai();
    const hostOpensInApp = !!helpers && typeof helpers.setOpenInAppUrl === "function";
    const ui: ViewerUi = { origin: config.origin, fullscreen: fullscreen(), maxCarousel: config.maxCarousel, hostOpensInApp };
    const view = lib.view(state, copy, ui);
    // Draw only what changed: a redraw makes new image elements, which would
    // fetch the previews again once their cache runs out, and resets the
    // carousel's scroll.
    const key = JSON.stringify(view);
    if (key !== drawnKey) {
      drawnKey = key;
      lib.render(doc, root, view, actions);
    }
    if (helpers && hostOpensInApp && view.openInCurvi !== null && view.openInCurvi !== openInAppSet) {
      openInAppSet = view.openInCurvi;
      try {
        helpers.setOpenInAppUrl!({ href: view.openInCurvi });
      } catch {
        // The host keeps its own target.
      }
    }
    if (state.pack !== null && helpers?.setWidgetState) {
      // Persist only a handle and presentation choice. Restoring never
      // reuses signed URLs, status, file checks or credit claims.
      const snapshot = { privateContent: { packId: state.pack.id, expanded: fullscreen() } };
      const key = JSON.stringify(snapshot);
      if (key !== savedState) {
        savedState = key;
        try { helpers.setWidgetState(snapshot); } catch { /* Optional host feature. */ }
      }
    }
    reportSize();
  }

  function canCallTools(): boolean {
    const helpers = openai();
    return isObject(hostCaps.serverTools) || (!!helpers && typeof helpers.callTool === "function");
  }

  function poll(): void {
    pollTimer = null;
    const pack = state.pack;
    if (stopped || inFlight || !pack || !state.polling) {
      return;
    }
    const epoch = packEpoch;
    inFlight = true;
    const args = { pack_id: pack.id };
    let call: Promise<unknown>;
    if (isObject(hostCaps.serverTools)) {
      call = request("tools/call", { name: config.tool, arguments: args });
    } else {
      try {
        const invoked = openai()!.callTool!(config.tool, args);
        call = new Promise((resolve, reject) => {
          const timer = win.setTimeout(() => { legacyTimers.delete(timer); reject(new Error("timeout")); }, config.requestTimeoutMs);
          legacyTimers.add(timer);
          Promise.resolve(invoked).then(
            (value) => { win.clearTimeout(timer); legacyTimers.delete(timer); resolve(value); },
            (error) => { win.clearTimeout(timer); legacyTimers.delete(timer); reject(error); },
          );
        });
      } catch (error) {
        call = Promise.reject(error);
      }
    }
    call.then(
      (result) => {
        if (stopped || epoch !== packEpoch) return;
        inFlight = false;
        dispatch({ type: "poll", result });
      },
      () => {
        if (stopped || epoch !== packEpoch) return;
        inFlight = false;
        dispatch({ type: "poll_failed" });
      },
    );
  }

  function schedule(): void {
    if (stopped || !ready || pollTimer !== null || inFlight || !state.polling || !state.pack) {
      return;
    }
    if (!canCallTools()) {
      dispatch({ type: "no_bridge" });
      return;
    }
    pollTimer = win.setTimeout(poll, config.pollMs * (state.pollErrors + 1));
  }

  function dispatch(event: Parameters<ViewerLib["reduce"]>[1]): void {
    if (stopped) {
      return;
    }
    const next = lib.reduce(state, event, {
      origin: config.origin,
      now: Date.now(),
      pollCapMs: config.pollCapMs,
      maxPollErrors: config.maxPollErrors,
    });
    if (next !== state) {
      state = next;
      draw();
    }
    schedule();
  }

  function applyContext(context: Json): void {
    const element = doc.documentElement as HTMLElement | null;
    if (element && (context.theme === "light" || context.theme === "dark")) {
      element.setAttribute("data-theme", context.theme);
    }
    if (Array.isArray(context.availableDisplayModes)) {
      hostModes = context.availableDisplayModes.filter((mode): mode is string => typeof mode === "string");
    }
    if (typeof context.displayMode === "string") {
      displayMode = context.displayMode;
      if (displayMode !== "fullscreen") {
        expanded = false;
      }
    }
    // The host's theme variables (MCP Apps "Theming"), kept to plain values.
    const styles = isObject(context.styles) ? context.styles : {};
    const variables = isObject(styles.variables) ? styles.variables : {};
    if (element) {
      for (const key of Object.keys(variables)) {
        const value = variables[key];
        if (/^--[a-z0-9-]{1,60}$/i.test(key) && typeof value === "string" && value.length <= 200 && !/url\(|[;{}<>\\]/i.test(value)) {
          element.style.setProperty(key, value);
        }
      }
    }
  }

  function legacyGlobals(): void {
    const helpers = openai();
    if (!helpers) {
      return;
    }
    if (isObject(helpers.toolInput)) {
      dispatch({ type: "input" });
    }
    if (isObject(helpers.toolOutput)) {
      acceptHostResult({ structuredContent: helpers.toolOutput });
    }
  }

  function acceptHostResult(result: Json): void {
    const key = JSON.stringify(result);
    if (key === lastHostResult) return;
    lastHostResult = key;
    packEpoch += 1;
    inFlight = false;
    if (pollTimer !== null) win.clearTimeout(pollTimer);
    pollTimer = null;
    dispatch({ type: "result", result });
  }

  const onMessage: Listener = (event) => {
    if (stopped || event.source !== win.parent || !isObject(event.data) || event.data.jsonrpc !== "2.0") {
      return;
    }
    const data = event.data;
    if (typeof data.method !== "string") {
      const entry = typeof data.id === "number" ? pending.get(data.id) : undefined;
      if (entry && typeof data.id === "number") {
        pending.delete(data.id);
        win.clearTimeout(entry.timer);
        if ("error" in data) {
          entry.reject(data.error);
        } else {
          entry.resolve(data.result);
        }
      }
      return;
    }
    const params = isObject(data.params) ? data.params : {};
    const id = typeof data.id === "string" || typeof data.id === "number" ? data.id : null;
    switch (data.method) {
      case "ui/notifications/tool-input":
        dispatch({ type: "input" });
        break;
      case "ui/notifications/tool-result":
        acceptHostResult(params);
        break;
      case "ui/notifications/tool-cancelled":
        dispatch({ type: "cancelled" });
        break;
      case "ui/notifications/host-context-changed":
        applyContext(params);
        draw();
        break;
      case "ui/resource-teardown":
        if (id !== null) {
          send({ jsonrpc: "2.0", id, result: {} });
        }
        stop();
        break;
      case "ping":
        if (id !== null) {
          send({ jsonrpc: "2.0", id, result: {} });
        }
        break;
      default:
        if (id !== null) {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
        }
    }
  };

  const onGlobals: Listener = () => legacyGlobals();

  const tickTimer = win.setInterval(() => dispatch({ type: "tick" }), config.tickMs);

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    packEpoch += 1;
    if (pollTimer !== null) {
      win.clearTimeout(pollTimer);
      pollTimer = null;
    }
    win.clearInterval(tickTimer);
    for (const entry of pending.values()) {
      win.clearTimeout(entry.timer);
    }
    pending.clear();
    for (const timer of legacyTimers) win.clearTimeout(timer);
    legacyTimers.clear();
    win.removeEventListener("message", onMessage);
    win.removeEventListener("openai:set_globals", onGlobals);
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  }

  win.addEventListener("message", onMessage);
  win.addEventListener("openai:set_globals", onGlobals);
  draw();
  legacyGlobals();
  const stored = openai()?.widgetState;
  const privateState = isObject(stored) && isObject(stored.privateContent) ? stored.privateContent : null;
  if (state.pack === null && privateState) {
    expanded = privateState.expanded === true;
    dispatch({ type: "restore", packId: privateState.packId });
  }
  const begin = (): void => {
    if (stopped) return;
    ready = true;
    if (typeof win.ResizeObserver === "function" && doc.body) {
      const observer = new win.ResizeObserver(reportSize);
      observer.observe(doc.body);
      resizeObserver = observer;
    }
    draw();
    schedule();
  };
  request("ui/initialize", {
    appInfo: { name: config.appName, version: config.appVersion },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: config.protocolVersion,
  }).then(
    (result) => {
      if (stopped) return;
      const answer = isObject(result) ? result : {};
      hostCaps = isObject(answer.hostCapabilities) ? answer.hostCapabilities : {};
      if (isObject(answer.hostContext)) {
        applyContext(answer.hostContext);
      }
      notify("ui/notifications/initialized", {});
      begin();
    },
    // No MCP Apps host answered: the window.openai helpers are all there is.
    () => begin(),
  );

  return { state: () => state, stop };
}

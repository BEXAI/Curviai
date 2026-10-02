/**
 * The pack viewer's state machine and view model (docs/phases/PHASE_19.md,
 * P19-19). Pure functions, tested here in Node and shipped to the browser
 * inside the viewer's one HTML file (./html.ts), which embeds each function's
 * source. So every function below is SELF CONTAINED: it reads only its own
 * parameters, its own nested helpers and browser built ins (URL, Math,
 * Array), never anything else at module level, not even another export of
 * this file. Types are erased, so they may be shared. A test evaluates each
 * function's source on its own to keep this true (runtime.test.ts).
 *
 * States: awaiting approval (the host shows the viewer before the seller
 * confirms create_pack; no tool input yet, O2), queued, running, finished,
 * failed and link expired. Everything that arrives from the host is
 * untrusted (O11): the pack is parsed field by field, text is cleaned and cut
 * to length and rendered as text only (./render.ts), and a link survives only
 * when it is a preview or file link on the configured site origin.
 */

import type { PackViewerCopy } from "./copy";

export type ViewerPhase = "awaiting_approval" | "queued" | "running" | "finished" | "failed" | "expired";

/** One delivered file, as the viewer keeps it. */
export interface ViewerFile {
  name: string;
  channel: string | null;
  kind: "image" | "zip" | "report";
  /** passes_channel_rules: false when the image did not pass its checks. */
  passes: boolean | null;
  /** A curvi.ai preview link, or null. */
  previewUrl: string | null;
  /** A curvi.ai download link, or null. */
  downloadUrl: string | null;
}

/** The pack, parsed from a create_pack or get_pack result (PackChat). */
export interface ViewerPack {
  id: string;
  status: string;
  finished: boolean;
  product: string;
  progress: { done: number; total: number };
  /** The delivered files, or null while the result listed none. */
  files: ViewerFile[] | null;
  linksValidHours: number | null;
  message: string;
  error: string | null;
}

export interface ViewerState {
  phase: ViewerPhase;
  pack: ViewerPack | null;
  /** When the links in pack.files arrived, in ms since the epoch. */
  linksAt: number | null;
  /** The line a failed state shows, or null for the general one. */
  failure: string | null;
  /** The seller declined, or the host cancelled create_pack. */
  cancelled: boolean;
  /** Whether another get_pack call is due. */
  polling: boolean;
  pollStartedAt: number | null;
  /** get_pack calls that failed in a row. */
  pollErrors: number;
  /** Why polling stopped before the pack finished, if it did. */
  stopped: "cap" | "errors" | "no_bridge" | null;
  /** The refusal text of the last failed get_pack call, if it gave one. */
  stoppedText: string | null;
}

export type ViewerEvent =
  /** ui/notifications/tool-input: the seller confirmed and the call runs. */
  | { type: "input" }
  /** ui/notifications/tool-result: create_pack's result. */
  | { type: "result"; result: unknown }
  /** The result of the viewer's own get_pack call. */
  | { type: "poll"; result: unknown }
  /** The viewer's get_pack call got no result (a bridge error or timeout). */
  | { type: "poll_failed"; text?: unknown }
  /** ui/notifications/tool-cancelled. */
  | { type: "cancelled" }
  /** A preview did not load (an expired or revoked link). */
  | { type: "link_failed" }
  /** The host cannot run get_pack for the viewer. */
  | { type: "no_bridge" }
  /** Time passed. */
  | { type: "tick" };

export interface ViewerEnv {
  /** The site origin every link must be on, such as https://curvi.ai. */
  origin: string;
  now: number;
  /** How long the viewer polls get_pack before it stops. */
  pollCapMs: number;
  /** Failed get_pack calls in a row before the viewer stops polling. */
  maxPollErrors: number;
}

/** The first state: shown before the seller confirms. */
export function initialViewerState(): ViewerState {
  return {
    phase: "awaiting_approval",
    pack: null,
    linksAt: null,
    failure: null,
    cancelled: false,
    polling: false,
    pollStartedAt: null,
    pollErrors: 0,
    stopped: null,
    stoppedText: null,
  };
}

/** The next state. Self contained (see the file comment). */
export function reduceViewer(state: ViewerState, event: ViewerEvent, env: ViewerEnv): ViewerState {
  const STATUSES = ["queued", "analyzing", "planning", "generating", "qc", "packaging", "done", "failed", "canceled"];
  const FINISHED = ["done", "failed", "canceled"];
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const cleanText = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") {
      return null;
    }
    const text = value
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text ? text.slice(0, max) : null;
  };
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 100000) : 0;
  // A link is kept only on the site origin, under the route that serves it,
  // with no user name or password in it.
  const linkOf = (value: unknown, path: string): string | null => {
    if (typeof value !== "string" || value.length > 4096) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.origin !== env.origin || url.username !== "" || url.password !== "" || url.pathname.indexOf(path) !== 0) {
      return null;
    }
    return url.href;
  };
  const textOf = (result: Record<string, unknown>): string | null => {
    const content = Array.isArray(result.content) ? result.content : [];
    for (const block of content) {
      if (isObject(block) && block.type === "text") {
        return cleanText(block.text, 400);
      }
    }
    return null;
  };
  const parseFile = (raw: unknown): ViewerFile | null => {
    if (!isObject(raw) || (raw.kind !== "image" && raw.kind !== "zip" && raw.kind !== "report")) {
      return null;
    }
    return {
      name: cleanText(raw.name, 200) ?? "",
      channel: cleanText(raw.channel, 100),
      kind: raw.kind,
      passes: typeof raw.passes_channel_rules === "boolean" ? raw.passes_channel_rules : null,
      previewUrl: raw.kind === "image" ? linkOf(raw.preview_url, "/api/mcp/preview/") : null,
      downloadUrl: linkOf(raw.download_url, "/api/mcp/files/"),
    };
  };
  const parsePack = (raw: unknown): ViewerPack | null => {
    if (!isObject(raw)) {
      return null;
    }
    const id = typeof raw.pack_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(raw.pack_id) ? raw.pack_id : null;
    const status = typeof raw.status === "string" && STATUSES.indexOf(raw.status) >= 0 ? raw.status : null;
    if (id === null || status === null) {
      return null;
    }
    const progress = isObject(raw.progress) ? raw.progress : {};
    const total = count(progress.total);
    const files = Array.isArray(raw.images)
      ? raw.images
          .slice(0, 200)
          .map(parseFile)
          .filter((file): file is ViewerFile => file !== null)
      : null;
    const hours = count(raw.links_valid_hours);
    return {
      id,
      status,
      finished: raw.finished === true || FINISHED.indexOf(status) >= 0,
      product: cleanText(raw.product, 200) ?? "",
      progress: { done: Math.min(count(progress.done), total), total },
      files,
      linksValidHours: hours > 0 ? hours : null,
      message: cleanText(raw.message, 400) ?? "",
      error: cleanText(raw.error, 400),
    };
  };
  const pollFailed = (current: ViewerState, text: string | null): ViewerState => {
    const errors = current.pollErrors + 1;
    return errors >= env.maxPollErrors
      ? { ...current, pollErrors: errors, polling: false, stopped: "errors", stoppedText: text }
      : { ...current, pollErrors: errors };
  };
  const withPack = (current: ViewerState, pack: ViewerPack, fromPoll: boolean): ViewerState => {
    const phase: ViewerPhase = pack.finished
      ? pack.status === "done"
        ? "finished"
        : "failed"
      : pack.status === "queued"
        ? "queued"
        : "running";
    const hasLinks = pack.files !== null && pack.files.some((file) => file.previewUrl !== null || file.downloadUrl !== null);
    // A finished pack from create_pack (a replay) lists no files: one more
    // get_pack call fetches them with their links.
    const wantsMore = !pack.finished || (pack.status === "done" && pack.files === null);
    const polling = wantsMore && current.stopped === null;
    return {
      ...current,
      phase,
      pack,
      failure: phase === "failed" ? pack.error ?? (pack.message || null) : null,
      cancelled: false,
      linksAt: hasLinks ? env.now : null,
      polling,
      pollStartedAt: polling ? (current.pollStartedAt ?? env.now) : current.pollStartedAt,
      pollErrors: fromPoll ? 0 : current.pollErrors,
    };
  };

  let next: ViewerState = state;
  switch (event.type) {
    case "input":
      next = state.phase === "awaiting_approval" ? { ...state, phase: "queued" } : state;
      break;
    case "cancelled":
      next =
        state.pack === null && (state.phase === "awaiting_approval" || state.phase === "queued")
          ? { ...state, phase: "failed", cancelled: true, polling: false }
          : state;
      break;
    case "result":
    case "poll": {
      const fromPoll = event.type === "poll";
      const result = event.result;
      const pack = isObject(result) && result.isError !== true ? parsePack(result.structuredContent) : null;
      if (pack) {
        next = withPack(state, pack, fromPoll);
        break;
      }
      // A refusal carries its neutral line as text (mcp-tools.ts toolResult).
      const text = isObject(result) && result.isError === true ? textOf(result) : null;
      next = fromPoll ? pollFailed(state, text) : { ...state, phase: "failed", failure: text, polling: false };
      break;
    }
    case "poll_failed":
      next = pollFailed(state, cleanText(event.text, 400));
      break;
    case "link_failed":
      next = state.phase === "finished" ? { ...state, phase: "expired", polling: false } : state;
      break;
    case "no_bridge":
      next = state.polling ? { ...state, polling: false, stopped: "no_bridge" } : state;
      break;
    case "tick":
      break;
  }
  // On every event: links run out after the hours the result gave, and
  // polling stops at the cap.
  if (
    next.phase === "finished" &&
    next.linksAt !== null &&
    next.pack !== null &&
    next.pack.linksValidHours !== null &&
    env.now - next.linksAt >= next.pack.linksValidHours * 3_600_000
  ) {
    next = { ...next, phase: "expired", polling: false };
  }
  if (next.polling && next.pollStartedAt !== null && env.now - next.pollStartedAt >= env.pollCapMs) {
    next = { ...next, polling: false, stopped: "cap" };
  }
  return next;
}

/** One file as the viewer shows it. */
export interface ViewerItem {
  title: string;
  meta: string | null;
  kind: "image" | "zip" | "report";
  previewUrl: string | null;
  downloadUrl: string | null;
}

export type ViewerLayout = "none" | "card" | "carousel" | "grid";

/** Everything the renderer draws; strings only, never markup. */
export interface ViewerView {
  heading: string | null;
  product: string | null;
  status: string | null;
  progress: { done: number; total: number } | null;
  note: string | null;
  tone: "normal" | "error";
  layout: ViewerLayout;
  items: ViewerItem[];
  /** "See all N files", when more files exist than the inline view shows. */
  seeAll: string | null;
  /** The pack in Curvi's web app, once the pack is known. */
  openInCurvi: string | null;
  /** Show an "Open in Curvi" button (fullscreen, when the host has no
   * setOpenInAppUrl of its own). */
  showOpenButton: boolean;
  downloadLabel: string;
  openLabel: string;
  imagesLabel: string;
}

export interface ViewerUi {
  origin: string;
  /** The viewer is fullscreen, or showing every file inline. */
  fullscreen: boolean;
  /** Most images the inline carousel shows (O11: 3 to 8). */
  maxCarousel: number;
  /** The host takes the Open in Curvi link itself (setOpenInAppUrl). */
  hostOpensInApp: boolean;
}

/** The view for a state. Self contained (see the file comment). */
export function viewerViewOf(state: ViewerState, copy: PackViewerCopy, ui: ViewerUi): ViewerView {
  const fill = (template: string, values: Record<string, number>): string =>
    template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
  const pack = state.pack;
  const openInCurvi = pack !== null && /^[0-9a-f-]{36}$/i.test(pack.id) ? `${ui.origin}/app/jobs/${pack.id}` : null;
  const stopNote = state.stopped !== null ? state.stoppedText ?? copy.askAssistant : null;
  const base: ViewerView = {
    heading: null,
    product: pack && pack.product ? pack.product : null,
    status: null,
    progress: null,
    note: null,
    tone: "normal",
    layout: "none",
    items: [],
    seeAll: null,
    openInCurvi,
    showOpenButton: false,
    downloadLabel: copy.download,
    openLabel: copy.openInCurvi,
    imagesLabel: copy.images,
  };
  switch (state.phase) {
    case "awaiting_approval":
      return { ...base, heading: copy.awaiting };
    case "queued":
      return { ...base, heading: copy.making, status: pack ? pack.message || null : null, note: stopNote };
    case "running": {
      const progress = pack ? pack.progress : { done: 0, total: 0 };
      const counted = progress.total > 0;
      return {
        ...base,
        heading: copy.making,
        status: counted ? fill(copy.progress, progress) : pack ? pack.message || null : null,
        progress: counted ? { done: progress.done, total: progress.total } : null,
        note: stopNote,
      };
    }
    case "failed":
      return {
        ...base,
        status: state.failure ?? (state.cancelled ? copy.notStarted : copy.unavailable),
        tone: "error",
      };
    case "expired":
      return { ...base, status: copy.linkExpired, tone: "error" };
    case "finished": {
      const files = pack && pack.files ? pack.files : [];
      const items: ViewerItem[] = files
        .filter((file) => file.previewUrl !== null || file.downloadUrl !== null)
        .map((file) => ({
          title: file.kind === "image" && file.channel ? file.channel : file.name,
          meta: file.kind === "image" && file.channel ? file.name || null : null,
          kind: file.kind,
          previewUrl: file.previewUrl,
          downloadUrl: file.downloadUrl,
        }));
      const someFailed = files.some((file) => file.kind === "image" && file.passes === false);
      const finished = {
        ...base,
        heading: copy.ready,
        status: pack ? pack.message || null : null,
        note: someFailed ? copy.someFailed : stopNote,
      };
      if (ui.fullscreen) {
        return {
          ...finished,
          layout: items.length > 0 ? "grid" : "none",
          items,
          showOpenButton: openInCurvi !== null && !ui.hostOpensInApp,
        };
      }
      // Inline: a card for one or two images, a carousel for three to eight
      // (O11), and "See all" for the rest, the zips and the report.
      const shown = items.filter((item) => item.kind === "image" && item.previewUrl !== null).slice(0, Math.max(1, ui.maxCarousel));
      return {
        ...finished,
        layout: shown.length === 0 ? "none" : shown.length <= 2 ? "card" : "carousel",
        items: shown,
        seeAll: items.length > shown.length ? fill(copy.seeAll, { n: items.length }) : null,
      };
    }
  }
}

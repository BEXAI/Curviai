/**
 * The in app "pack ready" notice (docs/PENDING.md, Conversion): which packs
 * the app keeps an eye on while the seller is elsewhere in /app, and when a
 * status change deserves a notice. Pure, so the rules are unit testable; the
 * PackReadyNotice component does the fetching with the same job endpoint and
 * backoff the progress board uses.
 *
 * A notice fires only for a change this tab saw happen: a pack last seen
 * running is now done or failed. A pack whose page is open is left to its
 * board, and its last seen status is forgotten, so finishing on screen and
 * then leaving never raises a stale notice. A pack the seller canceled
 * raises none.
 */

import { isTerminalJobStatus } from "@/lib/job-poll";
import { isUuid } from "@/lib/validation/ids";

/** How often watched packs are polled while the tab is visible. */
export const WATCH_POLL_MS = 4000;
/** How often a hidden tab checks; the notice waits for the seller anyway. */
export const WATCH_HIDDEN_POLL_MS = 20_000;
/** Minimum gap between two reads of the recent packs list. */
export const DISCOVER_MIN_GAP_MS = 10_000;
/** Most packs watched at once; the oldest drop first. */
export const MAX_WATCHED = 10;
/** sessionStorage key: the watch survives a reload in the same tab. */
export const WATCH_STORAGE_KEY = "curvi.packWatch.v1";

export type WatchStatus = string | "unknown";

export interface WatchEntry {
  id: string;
  title: string | null;
  /** Last status this tab saw while the pack's page was not open, or
   * "unknown" when it has not seen one yet. */
  status: WatchStatus;
}

export interface PackNotice {
  jobId: string;
  title: string;
  outcome: "done" | "failed";
}

export interface PackNoticeCopy {
  heading: string;
  body: string;
  action: string;
}

/** The job id of a pack page path, or null anywhere else. */
export function jobIdFromPath(pathname: string | null | undefined): string | null {
  const match = /^\/app\/jobs\/([^/?#]+)\/?$/.exec(pathname ?? "");
  return match && isUuid(match[1]) ? match[1].toLowerCase() : null;
}

export function packNoticeCopy(notice: PackNotice): PackNoticeCopy {
  if (notice.outcome === "done") {
    return {
      heading: "Your pack is ready",
      body: `${notice.title} is finished and ready to download.`,
      action: "View pack",
    };
  }
  return {
    heading: "A pack did not finish",
    body: `${notice.title} stopped early. You are only charged for shots that passed.`,
    action: "See what happened",
  };
}

export class PackWatch {
  private readonly entries = new Map<string, WatchEntry>();
  private viewingId: string | null = null;

  constructor(saved: readonly WatchEntry[] = []) {
    for (const entry of saved.slice(-MAX_WATCHED)) {
      if (isUuid(entry.id)) {
        this.entries.set(entry.id, {
          id: entry.id,
          title: typeof entry.title === "string" ? entry.title : null,
          status: typeof entry.status === "string" ? entry.status : "unknown",
        });
      }
    }
  }

  /** The pack page now open (null for any other page). Its board shows it,
   * so the watch forgets what it last saw, both for the page being left and
   * for the page being opened, and learns it afresh. */
  setViewing(jobId: string | null): void {
    for (const id of [this.viewingId, jobId]) {
      if (id) {
        const entry = this.entries.get(id);
        this.upsert(id, { title: entry?.title ?? null, status: "unknown" });
      }
    }
    this.viewingId = jobId;
  }

  get viewing(): string | null {
    return this.viewingId;
  }

  /** Folds in the recent packs list: running packs join the watch, and a
   * watched pack the list shows finished may raise a notice. */
  seed(jobs: ReadonlyArray<{ id: string; productTitle: string; status: string }>): PackNotice[] {
    const notices: PackNotice[] = [];
    for (const job of jobs) {
      if (!isUuid(job.id)) {
        continue;
      }
      if (job.id === this.viewingId) {
        const entry = this.entries.get(job.id);
        if (entry) {
          entry.title = job.productTitle;
        }
        continue;
      }
      if (!this.entries.has(job.id) && isTerminalJobStatus(job.status)) {
        continue;
      }
      const notice = this.observe(job.id, { status: job.status, title: job.productTitle });
      if (notice) {
        notices.push(notice);
      }
    }
    return notices;
  }

  /** One poll of a watched pack. Returns the notice to show, if any. */
  observe(jobId: string, job: { status: string; title: string }): PackNotice | null {
    const previous = this.entries.get(jobId);
    if (jobId === this.viewingId) {
      this.upsert(jobId, { title: job.title, status: "unknown" });
      return null;
    }
    if (!isTerminalJobStatus(job.status)) {
      this.upsert(jobId, { title: job.title, status: job.status });
      return null;
    }
    this.entries.delete(jobId);
    const sawRunning = previous !== undefined && previous.status !== "unknown" && !isTerminalJobStatus(previous.status);
    if (!sawRunning || (job.status !== "done" && job.status !== "failed")) {
      return null;
    }
    return { jobId, title: job.title || previous.title || "Your product", outcome: job.status };
  }

  /** Stops watching a pack the server no longer shows this user. */
  drop(jobId: string): void {
    this.entries.delete(jobId);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Packs to poll now: every watched pack except the one on screen. */
  toPoll(): string[] {
    return [...this.entries.keys()].filter((id) => id !== this.viewingId);
  }

  snapshot(): WatchEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  private upsert(id: string, value: Omit<WatchEntry, "id">): void {
    this.entries.delete(id);
    this.entries.set(id, { id, ...value });
    while (this.entries.size > MAX_WATCHED) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

/** Reads the saved watch. Storage can be missing or blocked; that is an
 * empty watch, never an error. */
export function loadWatch(storage: Pick<Storage, "getItem"> | null | undefined): WatchEntry[] {
  try {
    const raw = storage?.getItem(WATCH_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed.filter((e) => e && typeof e === "object") as WatchEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveWatch(storage: Pick<Storage, "setItem"> | null | undefined, entries: readonly WatchEntry[]): void {
  try {
    storage?.setItem(WATCH_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Full or blocked storage: the watch still works for this page load.
  }
}

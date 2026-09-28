"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonVariants, cn } from "@curvi/ui";
import { MAX_POLL_FAILURES, backoffMs } from "@/lib/job-poll";
import {
  DISCOVER_MIN_GAP_MS,
  PackWatch,
  WATCH_HIDDEN_POLL_MS,
  WATCH_POLL_MS,
  jobIdFromPath,
  loadWatch,
  packNoticeCopy,
  saveWatch,
  type PackNotice,
} from "@/lib/pack-watch";
import { track } from "@/lib/track";

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The in app "pack ready" notice. Mounted once in the /app layout, so it
 * lives across page changes: it learns running packs from the recent packs
 * list and from pack pages the seller opens, follows each one on the same job
 * endpoint and backoff the progress board uses, and shows a notice with a
 * link when one finishes while the seller is on another page. Polling stops
 * when nothing runs and while signed out. Email is a separate item.
 */
export function PackReadyNotice() {
  const pathname = usePathname();
  const watchRef = useRef<PackWatch | null>(null);
  const kickRef = useRef<() => void>(() => undefined);
  const lastDiscoverRef = useRef(0);
  const [notices, setNotices] = useState<PackNotice[]>([]);

  const watch = useCallback((): PackWatch => {
    watchRef.current ??= new PackWatch(loadWatch(sessionStore()));
    return watchRef.current;
  }, []);

  const persist = useCallback(() => saveWatch(sessionStore(), watch().snapshot()), [watch]);

  const show = useCallback((found: PackNotice[]) => {
    if (found.length === 0) {
      return;
    }
    for (const notice of found) {
      track("pack_ready_notice_shown", { jobId: notice.jobId, outcome: notice.outcome });
    }
    setNotices((current) => [...current.filter((n) => !found.some((f) => f.jobId === n.jobId)), ...found].slice(-3));
  }, []);

  // Poll loop: one timer for every watched pack, idle when none run.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failures = 0;

    function schedule(ms: number) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void poll(), ms);
    }

    async function poll() {
      timer = undefined;
      if (!active || inFlight) {
        return;
      }
      const ids = watch().toPoll();
      if (ids.length === 0) {
        return;
      }
      if (document.visibilityState === "hidden") {
        schedule(WATCH_HIDDEN_POLL_MS);
        return;
      }
      inFlight = true;
      let failed = false;
      let signedOut = false;
      const found: PackNotice[] = [];
      for (const id of ids) {
        try {
          const response = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
          if (response.ok) {
            const data = (await response.json()) as { job?: { status: string; productTitle: string } };
            if (data.job) {
              const notice = watch().observe(id, { status: data.job.status, title: data.job.productTitle });
              if (notice) {
                found.push(notice);
              }
            } else {
              failed = true;
            }
          } else if (response.status === 401) {
            signedOut = true;
            break;
          } else if (response.status === 403 || response.status === 404) {
            watch().drop(id);
          } else {
            failed = true;
          }
        } catch {
          failed = true;
        }
      }
      inFlight = false;
      if (signedOut) {
        watch().clear();
      }
      persist();
      if (!active) {
        return;
      }
      show(found);
      if (signedOut) {
        return;
      }
      failures = failed ? failures + 1 : 0;
      if (failures >= MAX_POLL_FAILURES) {
        // Server trouble: rest until the next page change or tab return.
        failures = 0;
        return;
      }
      schedule(failed ? backoffMs(failures) : WATCH_POLL_MS);
    }

    kickRef.current = () => {
      if (active && !inFlight && !timer) {
        schedule(WATCH_POLL_MS);
      }
    };
    kickRef.current();
    return () => {
      active = false;
      kickRef.current = () => undefined;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [watch, persist, show]);

  const discover = useCallback(async () => {
    const now = Date.now();
    if (now - lastDiscoverRef.current < DISCOVER_MIN_GAP_MS) {
      kickRef.current();
      return;
    }
    lastDiscoverRef.current = now;
    try {
      const response = await fetch("/api/jobs/recent", { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json()) as { jobs?: Array<{ id: string; productTitle: string; status: string }> };
        show(watch().seed(Array.isArray(data.jobs) ? data.jobs : []));
        persist();
      }
    } catch {
      // The next page change or tab return tries again.
    }
    kickRef.current();
  }, [watch, persist, show]);

  // Every page change: note the open pack page, clear its notice, look for
  // running packs.
  useEffect(() => {
    const viewing = jobIdFromPath(pathname);
    watch().setViewing(viewing);
    persist();
    if (viewing) {
      setNotices((current) => current.filter((n) => n.jobId !== viewing));
    }
    void discover();
  }, [pathname, watch, persist, discover]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        void discover();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [discover]);

  if (notices.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-3 sm:left-auto sm:right-6 sm:w-96"
      aria-live="polite"
    >
      {notices.map((notice) => {
        const copy = packNoticeCopy(notice);
        const dismiss = () => setNotices((current) => current.filter((n) => n.jobId !== notice.jobId));
        return (
          <div
            key={notice.jobId}
            role="status"
            data-testid="pack-ready-notice"
            data-outcome={notice.outcome}
            className={cn(
              "pointer-events-auto w-full rounded-xl border bg-white p-4 shadow-raised",
              notice.outcome === "done" ? "border-emerald-200" : "border-amber-200",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink-950">{copy.heading}</p>
                <p className="mt-1 text-sm text-ink-600">{copy.body}</p>
              </div>
              <button
                type="button"
                onClick={dismiss}
                className="-mr-1 -mt-1 rounded-md p-1 text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700"
                aria-label="Dismiss"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <Link
              href={`/app/jobs/${notice.jobId}`}
              className={buttonVariants({
                size: "sm",
                variant: notice.outcome === "done" ? "secondary" : "outline",
                className: "mt-3",
              })}
              onClick={() => track("pack_ready_notice_opened", { jobId: notice.jobId, outcome: notice.outcome })}
            >
              {copy.action}
            </Link>
          </div>
        );
      })}
    </div>
  );
}

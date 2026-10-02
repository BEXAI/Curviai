"use client";

import { useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@curvi/ui";
import { FEEDBACK_COPY } from "@/lib/feedback/copy";
import type { FeedbackStatus } from "@/lib/feedback/types";
import { PackFeedbackForm } from "./pack-feedback-form";

/** How often the card asks again while the pack is still running. */
const WAIT_POLL_MS = 10_000;
/** Stop asking after this long; a reload picks it up again. */
const WAIT_POLL_LIMIT_MS = 30 * 60 * 1000;

/** "Not now" is remembered in this browser only, per pack. */
export function feedbackDismissKey(jobId: string): string {
  return `curvi:feedback-dismissed:${jobId}`;
}

function readDismissed(jobId: string): boolean {
  try {
    return window.localStorage.getItem(feedbackDismissKey(jobId)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(jobId: string): void {
  try {
    window.localStorage.setItem(feedbackDismissKey(jobId), "1");
  } catch {
    // Private windows can refuse storage; the card simply shows again later.
  }
}

/**
 * The pack feedback card (docs/phases/PHASE_18.md P18-05): on a finished
 * pack, asks whether the files would go into a live listing, until the
 * person answers or says "Not now". Renders nothing before the pack is done,
 * after an answer, or when the status cannot be read.
 */
export function PackFeedbackCard({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [thanks, setThanks] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(readDismissed(jobId));
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const load = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}/feedback`, { cache: "no-store" });
        if (stopped || !response.ok) {
          return;
        }
        const { feedback } = (await response.json().catch(() => ({}))) as { feedback?: FeedbackStatus };
        if (!feedback) {
          return;
        }
        setStatus(feedback);
        if (!feedback.eligible && !feedback.answered && Date.now() - startedAt < WAIT_POLL_LIMIT_MS) {
          timer = setTimeout(load, WAIT_POLL_MS);
        }
      } catch {
        // Optional card: the pack page works without it.
      }
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (thanks) {
    return (
      <Card className="mt-8" data-testid="feedback-thanks">
        <CardContent className="p-5">
          <p className="text-sm text-ink-700" role="status">
            {thanks}
          </p>
          <a href={`/support?topic=pack&job=${jobId}`} className="mt-3 inline-block text-sm underline">Get help with this pack</a>
        </CardContent>
      </Card>
    );
  }
  if (!status?.eligible || status.answered || dismissed) {
    return null;
  }

  return (
    <Card id="feedback" className="mt-8" data-testid="feedback-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{FEEDBACK_COPY.title}</CardTitle>
            <p className="mt-1 text-sm text-ink-600">{FEEDBACK_COPY.intro}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="feedback-dismiss"
            onClick={() => {
              writeDismissed(jobId);
              setDismissed(true);
            }}
          >
            {FEEDBACK_COPY.dismiss}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <PackFeedbackForm
          endpoint={`/api/jobs/${jobId}/feedback`}
          idPrefix={`feedback-${jobId}`}
          onDone={(next, notice) => {
            if (next) setStatus(next);
            setThanks(notice);
          }}
        />
      </CardContent>
    </Card>
  );
}

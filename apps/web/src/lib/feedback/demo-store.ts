/**
 * Pack feedback in demo mode (no database): answers live in process memory,
 * one per pack, so the card's whole flow (appear on a done pack, send, stay
 * gone) works with zero env vars and in the e2e suite.
 */

import type { Services } from "@/lib/services/types";
import { FEEDBACK_COPY } from "./copy";
import type { FeedbackActor, FeedbackStore } from "./store";
import type { FeedbackAnswer, FeedbackStatus, FeedbackSubmitOutcome, FeedbackVia } from "./types";

export interface DemoFeedbackRecord extends FeedbackAnswer {
  jobId: string;
  userId: string;
  via: FeedbackVia;
  at: number;
}

export class DemoFeedbackState {
  readonly byKey = new Map<string, DemoFeedbackRecord>();
}

const globalScope = globalThis as typeof globalThis & { __curviDemoFeedback?: DemoFeedbackState };

export function getDemoFeedbackState(): DemoFeedbackState {
  if (!globalScope.__curviDemoFeedback) {
    globalScope.__curviDemoFeedback = new DemoFeedbackState();
  }
  return globalScope.__curviDemoFeedback;
}

const key = (jobId: string, userId: string) => `${jobId}:${userId}`;

export class DemoFeedbackStore implements FeedbackStore {
  constructor(
    private readonly services: Pick<Services, "getJob">,
    private readonly state: DemoFeedbackState = getDemoFeedbackState(),
  ) {}

  async status(actor: FeedbackActor, jobId: string): Promise<FeedbackStatus | null> {
    const job = await this.services.getJob(actor.workspaceId, jobId);
    if (!job) {
      return null;
    }
    return { jobId, eligible: job.status === "done", answered: this.state.byKey.has(key(jobId, actor.userId)) };
  }

  async submit(
    actor: FeedbackActor,
    jobId: string,
    answer: FeedbackAnswer,
    via: FeedbackVia,
  ): Promise<FeedbackSubmitOutcome> {
    const status = await this.status(actor, jobId);
    if (!status) {
      return { outcome: "rejected", reason: "not_found", message: FEEDBACK_COPY.notFound };
    }
    if (!status.eligible) {
      return { outcome: "rejected", reason: "not_ready", message: FEEDBACK_COPY.notReady };
    }
    const done: FeedbackStatus = { jobId, eligible: true, answered: true };
    if (status.answered) {
      return { outcome: "already", status: done };
    }
    this.state.byKey.set(key(jobId, actor.userId), { ...answer, jobId, userId: actor.userId, via, at: Date.now() });
    return { outcome: "saved", status: done };
  }

  /** The newest consented quote about this pack, for the demo gallery. */
  quoteFor(jobId: string): { text: string; name: string | null } | null {
    let best: DemoFeedbackRecord | null = null;
    for (const record of this.state.byKey.values()) {
      if (record.jobId === jobId && record.quoteConsent && record.comment && (!best || record.at > best.at)) {
        best = record;
      }
    }
    return best?.comment ? { text: best.comment, name: best.displayName } : null;
  }
}

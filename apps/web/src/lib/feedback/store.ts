/**
 * The pack feedback store (docs/phases/PHASE_18.md P18-05): the database
 * store in db mode, an in memory one in demo mode, decided at call time like
 * the share store. Server only.
 */

import type { FeedbackAnswer, FeedbackStatus, FeedbackSubmitOutcome, FeedbackVia } from "./types";

/** Who is answering: a member of the workspace the pack belongs to. */
export interface FeedbackActor {
  workspaceId: string;
  userId: string;
}

export interface FeedbackStore {
  /** The card's status for this pack and person, or null when the pack is
   * not in the actor's workspace. */
  status(actor: FeedbackActor, jobId: string): Promise<FeedbackStatus | null>;
  /** Saves one answer per pack and person. A second answer changes nothing. */
  submit(actor: FeedbackActor, jobId: string, answer: FeedbackAnswer, via: FeedbackVia): Promise<FeedbackSubmitOutcome>;
}

/**
 * Pack feedback entry point (P18-05): the database store in db mode, the in
 * memory demo store otherwise, decided at call time like getShareStore().
 * Server only.
 */

import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";
import { DbFeedbackStore } from "./db-store";
import { DemoFeedbackStore } from "./demo-store";
import type { FeedbackStore } from "./store";

export * from "./types";
export type { FeedbackActor, FeedbackStore } from "./store";

/** The demo workspace has no signed in user; every answer is this one's. */
export const DEMO_FEEDBACK_USER = "demo";

export function getFeedbackStore(): FeedbackStore {
  if (isDbMode()) {
    return new DbFeedbackStore(getDb());
  }
  return new DemoFeedbackStore(getServices());
}

/** The signed in user's id in db mode, the demo user otherwise, or null
 * when db mode has nobody signed in. */
export async function feedbackUserId(): Promise<string | null> {
  if (!isDbMode()) {
    return DEMO_FEEDBACK_USER;
  }
  try {
    return (await getSessionUser())?.id ?? null;
  } catch {
    return null;
  }
}

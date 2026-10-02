/**
 * Turns a signed feedback link (./link.ts) into the pack and person it is
 * for (P18-05). Db mode only: the token must verify, the pack must exist,
 * and the person must still be a member of the pack's workspace. Anything
 * else reads as an invalid link. Server only.
 */

import type { Db } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { DbFeedbackStore } from "./db-store";
import { verifyFeedbackToken } from "./link";
import type { FeedbackActor } from "./store";

export interface FeedbackLinkTarget {
  store: DbFeedbackStore;
  actor: FeedbackActor;
  jobId: string;
}

export async function resolveFeedbackLink(
  token: string,
  options: { db?: Db; now?: Date; secret?: string } = {},
): Promise<FeedbackLinkTarget | null> {
  const claims = verifyFeedbackToken(token, { now: options.now, secret: options.secret });
  if (!claims) {
    return null;
  }
  if (!options.db && !isDbMode()) {
    return null;
  }
  const db = options.db ?? getDb();
  const job = await db.query.generationJobs.findFirst({
    columns: { id: true, workspaceId: true },
    where: (t, { eq }) => eq(t.id, claims.jobId),
  });
  if (!job) {
    return null;
  }
  const store = new DbFeedbackStore(db);
  const actor: FeedbackActor = { workspaceId: job.workspaceId, userId: claims.userId };
  if (!(await store.isMember(actor))) {
    return null;
  }
  return { store, actor, jobId: job.id };
}

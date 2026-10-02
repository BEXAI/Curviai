/**
 * Pack feedback over the owner connection (P18-05). The owner connection
 * bypasses RLS, so every query is scoped by hand: the pack must be in the
 * actor's workspace, and the actor must be a member of it (the signed link
 * path checks that here; the pack page path resolved the workspace from the
 * session, which already means membership). One answer per pack and person
 * (pack_feedback_job_user_uq); the first one wins.
 */

import { packFeedback, recordFunnelEvent, sql, type Db } from "@curvi/db";
import { isUuid } from "@/lib/validation/ids";
import { feedbackNotifier } from "./notify";
import { FEEDBACK_COPY } from "./copy";
import type { FeedbackActor, FeedbackStore } from "./store";
import type { FeedbackAnswer, FeedbackStatus, FeedbackSubmitOutcome, FeedbackVia } from "./types";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

export class DbFeedbackStore implements FeedbackStore {
  constructor(private readonly db: Db) {}

  private async job(actor: FeedbackActor, jobId: string): Promise<{ id: string; status: string } | null> {
    if (!isUuid(jobId) || !isUuid(actor.workspaceId)) {
      return null;
    }
    const job = await this.db.query.generationJobs.findFirst({
      columns: { id: true, status: true },
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, actor.workspaceId)),
    });
    return job ?? null;
  }

  private async answered(actor: FeedbackActor, jobId: string): Promise<boolean> {
    if (!isUuid(actor.userId)) {
      return false;
    }
    const row = await this.db.query.packFeedback.findFirst({
      columns: { id: true },
      where: (t, { and, eq }) => and(eq(t.jobId, jobId), eq(t.userId, actor.userId)),
    });
    return row !== undefined;
  }

  async status(actor: FeedbackActor, jobId: string): Promise<FeedbackStatus | null> {
    const job = await this.job(actor, jobId);
    if (!job) {
      return null;
    }
    return { jobId: job.id, eligible: job.status === "done", answered: await this.answered(actor, job.id) };
  }

  /** True when the user is a member of the workspace, any role. */
  async isMember(actor: FeedbackActor): Promise<boolean> {
    if (!isUuid(actor.userId) || !isUuid(actor.workspaceId)) {
      return false;
    }
    const member = await this.db.query.members.findFirst({
      columns: { userId: true },
      where: (t, { and, eq }) => and(eq(t.userId, actor.userId), eq(t.workspaceId, actor.workspaceId)),
    });
    return member !== undefined;
  }

  async submit(
    actor: FeedbackActor,
    jobId: string,
    answer: FeedbackAnswer,
    via: FeedbackVia,
  ): Promise<FeedbackSubmitOutcome> {
    const job = await this.job(actor, jobId);
    if (!job || !isUuid(actor.userId)) {
      return { outcome: "rejected", reason: "not_found", message: FEEDBACK_COPY.notFound };
    }
    if (job.status !== "done") {
      return { outcome: "rejected", reason: "not_ready", message: FEEDBACK_COPY.notReady };
    }
    const inserted = await this.db
      .insert(packFeedback)
      .values({
        workspaceId: actor.workspaceId,
        jobId: job.id,
        userId: actor.userId,
        usable: answer.usable,
        wouldPay: answer.wouldPay,
        comment: answer.comment,
        quoteConsent: answer.quoteConsent,
        displayName: answer.quoteConsent ? answer.displayName : null,
      })
      .onConflictDoNothing({ target: [packFeedback.jobId, packFeedback.userId] })
      .returning({ id: packFeedback.id });
    const status: FeedbackStatus = { jobId: job.id, eligible: true, answered: true };
    if (inserted.length === 0) {
      return { outcome: "already", status };
    }
    // The day 14 gate reads the usable share from this step (P18-02). No
    // free text goes into props.
    await recordFunnelEvent(this.db, {
      workspaceId: actor.workspaceId,
      name: "feedback_submitted",
      props: {
        usable: answer.usable,
        would_pay: answer.wouldPay,
        quote: answer.quoteConsent,
        commented: answer.comment !== null,
        via,
      },
    });
    try { await feedbackNotifier(this.db)(job.id, answer); } catch { console.error("feedback_notification_failed"); }
    return { outcome: "saved", status };
  }
}

/** A consented quote, for the weekly email and the gallery. */
export interface ConsentedQuote {
  workspaceId: string;
  jobId: string;
  text: string;
  name: string | null;
  usable: string;
  createdAt: Date;
}

/**
 * Consented quotes written in [from, to), newest first, leaving out the
 * listed workspaces (the operator's own test packs). For the weekly funnel
 * email (P18-05, "Founder view").
 */
export async function loadConsentedQuotes(
  db: Db,
  window: { from: Date; to: Date },
  options: { excludeWorkspaces?: readonly string[]; limit: number },
): Promise<ConsentedQuote[]> {
  const excluded = (options.excludeWorkspaces ?? []).filter(isUuid);
  const rows = rowsOf<{
    workspace_id: string;
    job_id: string;
    comment: string;
    display_name: string | null;
    usable: string;
    created_at: string | Date;
  }>(
    await db.execute(sql`
      select workspace_id, job_id, comment, display_name, usable, created_at
      from pack_feedback
      where quote_consent
        and comment is not null
        and created_at >= ${window.from.toISOString()}::timestamptz
        and created_at < ${window.to.toISOString()}::timestamptz
        ${
          excluded.length > 0
            ? sql`and workspace_id not in (${sql.join(
                excluded.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`
            : sql``
        }
      order by created_at desc
      limit ${Math.max(1, Math.floor(options.limit))}
    `),
  );
  return rows.map((row) => ({
    workspaceId: String(row.workspace_id),
    jobId: String(row.job_id),
    text: row.comment,
    name: row.display_name,
    usable: row.usable,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * The newest consented quote for each listed job's workspace, preferring a
 * quote about that very job (P18-14: the gallery shows a consented quote
 * under the seller's entry). Keyed by job id.
 */
export async function consentedQuotesForJobs(
  db: Db,
  jobs: ReadonlyArray<{ jobId: string; workspaceId: string }>,
): Promise<Map<string, { text: string; name: string | null }>> {
  const valid = jobs.filter((job) => isUuid(job.jobId) && isUuid(job.workspaceId));
  const out = new Map<string, { text: string; name: string | null }>();
  if (valid.length === 0) {
    return out;
  }
  const workspaceIds = [...new Set(valid.map((job) => job.workspaceId))];
  const rows = await db.query.packFeedback.findMany({
    columns: { workspaceId: true, jobId: true, comment: true, displayName: true, createdAt: true },
    where: (t, { and, eq, inArray, isNotNull }) =>
      and(eq(t.quoteConsent, true), isNotNull(t.comment), inArray(t.workspaceId, workspaceIds)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 200,
  });
  for (const job of valid) {
    const own = rows.find((row) => row.jobId === job.jobId);
    const any = own ?? rows.find((row) => row.workspaceId === job.workspaceId);
    if (any?.comment) {
      out.set(job.jobId, { text: any.comment, name: any.displayName });
    }
  }
  return out;
}

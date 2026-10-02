/**
 * The email tables over the owner connection (docs/phases/PHASE_18.md
 * P18-06, migration lifecycle_email): the send log with its once per dedupe
 * key claim, the suppression list and the lifecycle email switch. Raw SQL so
 * the same calls run on postgres-js in production and PGlite in tests.
 */

import { sql, type EmailSendKind, type EmailSendStatus, type EmailSuppressionReason, type EmailSuppressionScope } from "@curvi/db";
import { LIFECYCLE_EMAIL_SETTING } from "@curvi/pipeline/seed";

/** Anything that runs a drizzle sql query: the owner connection or a transaction. */
export interface SqlDb {
  execute(query: ReturnType<typeof sql>): PromiseLike<unknown>;
}

/** postgres-js returns the rows array; PGlite returns { rows }. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export interface ClaimInput {
  recipientKey: string;
  workspaceId: string | null;
  template: string;
  dedupeKey: string;
  kind: EmailSendKind;
}

export interface ClaimPolicy {
  maxAttempts: number;
  staleClaimMinutes: number;
}

/**
 * Claims one dedupe key for a send and returns the row id, or null when the
 * key is taken: already sent or suppressed, in flight elsewhere, or failed
 * too often. A key whose last try was disabled (switched off, not
 * configured) or failed under the attempt cap, or a claim left pending by a
 * process that died, can be claimed again. One statement, so two callers
 * racing for a key never both win.
 */
export async function claimSend(db: SqlDb, input: ClaimInput, policy: ClaimPolicy, now: Date): Promise<string | null> {
  const at = now.toISOString();
  const staleBefore = new Date(now.getTime() - policy.staleClaimMinutes * 60_000).toISOString();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into email_sends (recipient_key, workspace_id, template, dedupe_key, kind, status, attempts, created_at, updated_at)
      values (${input.recipientKey}, ${input.workspaceId}::uuid, ${input.template}, ${input.dedupeKey}, ${input.kind},
              'pending', 1, ${at}::timestamptz, ${at}::timestamptz)
      on conflict (dedupe_key) do update
        set status = 'pending', attempts = email_sends.attempts + 1, error = null, updated_at = excluded.updated_at
        where email_sends.status = 'disabled'
           or (email_sends.status = 'failed' and email_sends.attempts < ${policy.maxAttempts})
           or (email_sends.status = 'pending' and email_sends.updated_at < ${staleBefore}::timestamptz)
      returning id
    `),
  );
  return rows[0]?.id ?? null;
}

/** Records how a claimed send ended. */
export async function finishSend(
  db: SqlDb,
  id: string,
  outcome: { status: Exclude<EmailSendStatus, "pending">; providerId?: string | null; error?: string | null },
  now: Date,
): Promise<void> {
  await db.execute(sql`
    update email_sends
    set status = ${outcome.status}, provider_id = ${outcome.providerId ?? null}, error = ${outcome.error?.slice(0, 500) ?? null},
        updated_at = ${now.toISOString()}::timestamptz
    where id = ${id}::uuid
  `);
}

/** The suppression on a key, or null. */
export async function suppressionOf(db: SqlDb, recipientKey: string): Promise<EmailSuppressionScope | null> {
  const rows = rowsOf<{ scope: EmailSuppressionScope }>(
    await db.execute(sql`select scope from email_suppressions where recipient_key = ${recipientKey}`),
  );
  return rows[0]?.scope ?? null;
}

/** The suppressions on many keys at once. */
export async function suppressionsOf(db: SqlDb, recipientKeys: readonly string[]): Promise<Map<string, EmailSuppressionScope>> {
  if (recipientKeys.length === 0) {
    return new Map();
  }
  const rows = rowsOf<{ recipient_key: string; scope: EmailSuppressionScope }>(
    await db.execute(sql`
      select recipient_key, scope from email_suppressions
      where recipient_key in (${sql.join(
        recipientKeys.map((key) => sql`${key}`),
        sql`, `,
      )})
    `),
  );
  return new Map(rows.map((row) => [row.recipient_key, row.scope]));
}

/** True when this suppression stops an email of this kind. */
export function blocks(scope: EmailSuppressionScope | null | undefined, kind: EmailSendKind): boolean {
  return scope === "all" || (scope === "marketing" && kind === "marketing");
}

/**
 * Adds a suppression. A wider one replaces a narrower one (a bounce after an
 * unsubscribe stops all mail); a narrower one never lifts a wider one.
 */
export async function addSuppression(
  db: SqlDb,
  recipientKey: string,
  scope: EmailSuppressionScope,
  reason: EmailSuppressionReason,
  now: Date = new Date(),
): Promise<void> {
  await db.execute(sql`
    insert into email_suppressions (recipient_key, scope, reason, created_at)
    values (${recipientKey}, ${scope}, ${reason}, ${now.toISOString()}::timestamptz)
    on conflict (recipient_key) do update
      set scope = excluded.scope, reason = excluded.reason, created_at = excluded.created_at
      where email_suppressions.scope = 'marketing' and excluded.scope = 'all'
  `);
}

export type LiftResult = "lifted" | "none" | "blocked";

/**
 * Lifts a marketing unsubscribe (the settings toggle). A suppression of all
 * mail after a bounce or a complaint is never lifted here: "blocked".
 */
export async function liftMarketingSuppression(db: SqlDb, recipientKey: string): Promise<LiftResult> {
  const deleted = rowsOf(
    await db.execute(sql`
      delete from email_suppressions where recipient_key = ${recipientKey} and scope = 'marketing' returning recipient_key
    `),
  );
  if (deleted.length > 0) {
    return "lifted";
  }
  return (await suppressionOf(db, recipientKey)) === "all" ? "blocked" : "none";
}

/** The lifecycle email switch (platform_settings, seeded false). Fails
 * closed: only a stored true turns email on. */
export async function lifecycleEmailEnabled(db: SqlDb): Promise<boolean> {
  try {
    const rows = rowsOf<{ on: unknown }>(
      await db.execute(sql`select value = 'true'::jsonb as on from platform_settings where key = ${LIFECYCLE_EMAIL_SETTING}`),
    );
    return rows[0]?.on === true;
  } catch {
    return false;
  }
}

/** Lifecycle emails sent since the start of this UTC day. */
export async function sentToday(db: SqlDb, now: Date): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const rows = rowsOf<{ n: number | string }>(
    await db.execute(sql`
      select count(*)::int as n from email_sends where status = 'sent' and updated_at >= ${dayStart}::timestamptz
    `),
  );
  return Number(rows[0]?.n ?? 0);
}

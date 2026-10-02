/** Bounded retention of operational history. Funnel claims and consents are never eligible. */
import { sql, type Db } from "@curvi/db";
import { dataRetention, renewalNotices } from "@curvi/pipeline/seed";

const DAY_MS = 86_400_000;
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];

export function counterRetentionDays(key: string): number {
  for (const [prefix, days] of Object.entries(dataRetention.counterDays)) {
    if (key.startsWith(prefix)) return days;
  }
  return dataRetention.otherCounterDays;
}

export interface RetentionRule { name: string; table: string; where: ReturnType<typeof sql> }
export function retentionRules(now: Date): RetentionRule[] {
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const billingBefore = new Date(now);
  billingBefore.setUTCFullYear(billingBefore.getUTCFullYear() - renewalNotices.consentRecordYears);
  const counterCases = Object.entries(dataRetention.counterDays).map(([prefix, days]) =>
    sql`when starts_with(key, ${prefix}) then ${before(days)}::timestamptz`,
  );
  return [
    { name: "events", table: "events", where: sql`name not like 'funnel.%' and at < case
        when name like 'billing:email:%' then ${billingBefore.toISOString()}::timestamptz
        when name like 'billing:%' then ${before(dataRetention.billingEventsDays)}::timestamptz
        else ${before(dataRetention.eventsDays)}::timestamptz end` },
    { name: "ops_audit", table: "ops_audit", where: sql`at < ${before(dataRetention.opsAuditDays)}::timestamptz` },
    { name: "job_steps", table: "job_steps", where: sql`created_at < ${before(dataRetention.jobStepsDays)}::timestamptz
        and exists (select 1 from generation_jobs j where j.id = job_steps.job_id and j.status in ('done', 'failed', 'canceled'))` },
    { name: "spend_cap_counters", table: "spend_cap_counters", where: sql`updated_at < case
        ${sql.join(counterCases, sql` `)} else ${before(dataRetention.otherCounterDays)}::timestamptz end` },
    { name: "site_visits", table: "site_visits", where: sql`day < ${before(dataRetention.siteVisitsDays).slice(0, 10)}::date` },
    { name: "upload_preflights", table: "upload_preflights", where: sql`updated_at < ${before(dataRetention.uploadPreflightsDays)}::timestamptz` },
    { name: "ops_alerts", table: "ops_alerts", where: sql`status = 'resolved' and resolved_at < ${before(dataRetention.resolvedAlertsDays)}::timestamptz` },
    // Only billing notice history has a specified email window. Other sends
    // keep their dedupe rows; retention must never cause a marketing resend.
    { name: "billing_email_sends", table: "email_sends", where: sql`(template = 'billing_notice' or dedupe_key like 'billing:%')
        and updated_at < ${billingBefore.toISOString()}::timestamptz` },
  ];
}

export interface RetentionReport {
  dryRun: boolean;
  tables: Record<string, { matched: number; deleted: number; complete: boolean }>;
  budgetExhausted: boolean;
}

/** Uses ctid only within one statement; no unbounded DELETE or OFFSET scan.
 * A dry run counts a bounded batch and marks an unfinished table incomplete. */
export async function runRetention(options: {
  db: Db; now?: Date; dryRun?: boolean; deadline?: Date; clock?: () => number;
}): Promise<RetentionReport> {
  const { db, dryRun = false, clock = Date.now } = options;
  const now = options.now ?? new Date();
  const deadline = Math.min(options.deadline?.getTime() ?? Infinity, clock() + dataRetention.budgetSeconds * 1000);
  const report: RetentionReport = { dryRun, tables: {}, budgetExhausted: false };
  for (const rule of retentionRules(now)) {
    const counts = { matched: 0, deleted: 0, complete: false };
    report.tables[rule.name] = counts;
    while (clock() < deadline) {
      const table = sql.identifier(rule.table);
      const selection = sql`select ctid from ${table} where ${rule.where} limit ${dataRetention.batchSize}`;
      let result: unknown;
      try {
        result = await db.transaction(async (tx) => {
          // SET LOCAL belongs to this transaction, so it is safe through
          // the transaction pooler and cannot leak to another request.
          await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, deadline - clock()))}, true)`);
          return dryRun
            ? tx.execute(sql`select count(*)::int as count from (${selection}) eligible`)
            : tx.execute(sql`with removed as (delete from ${table} where ctid in (${selection}) returning 1)
                select count(*)::int as count from removed`);
        });
      } catch (error) {
        const cause = (error as { cause?: { code?: string }; code?: string });
        if (cause.code === "57014" || cause.cause?.code === "57014") {
          report.budgetExhausted = true;
          return report;
        }
        throw error;
      }
      const count = Number(rowsOf<{ count: number }>(result)[0]?.count ?? 0);
      counts.matched += count;
      if (!dryRun) counts.deleted += count;
      counts.complete = count < dataRetention.batchSize;
      if (dryRun || counts.complete) break;
    }
    if (clock() >= deadline) {
      report.budgetExhausted = true;
      break;
    }
  }
  return report;
}

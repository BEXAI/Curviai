import { randomUUID } from "node:crypto";
import { and, eq, opsAlerts, platformSettings, sql, type Db, type OpsAlert } from "@curvi/db";
import { economics, opsAlertPolicy } from "@curvi/pipeline/seed";
import { DEFAULT_ALERT_FROM, sendResendEmail } from "@curvi/trigger/spend-alerts";
import * as Sentry from "@sentry/nextjs";
import { customerUser, customerWorkspace, operatorWorkspaceIds } from "@/lib/customer-metrics";
import { optionalEnv } from "@/lib/env";

export interface OpsAlertSignals {
  healthWarnings?: readonly string[];
  reconciledJobs?: number;
  workspaceCaps?: readonly { workspaceId: string; usedMicros: number; limitMicros: number }[];
  shotMargins?: readonly { shotType: string; grossMargin: number }[];
}
export interface OpsAlertNotification {
  id: string;
  rule: string;
  subject: string;
  status: "open" | "resolved";
  idempotencyKey: string;
  text: string;
}
export type OpsAlertNotifier = (notification: OpsAlertNotification) => Promise<boolean>;
interface Condition { rule: string; subject: string; detail: Record<string, unknown> }
interface Delivery { key: string; claim: string | null; claimedAt: string | null }
const MEMORY_KEY = "ops_alerts:memory_high_ticks";
const MINUTE = 60_000;
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];
}
function deliveryOf(detail: Record<string, unknown>): Delivery | null {
  const value = detail._delivery as Partial<Delivery> | null;
  return value && typeof value.key === "string"
    ? { key: value.key, claim: typeof value.claim === "string" ? value.claim : null, claimedAt: typeof value.claimedAt === "string" ? value.claimedAt : null }
    : null;
}
function pendingDelivery(key: string): Delivery { return { key, claim: null, claimedAt: null }; }

/** Notification identifiers contain only rule names and internal ids, never
 * seller notes, addresses, URLs or provider response bodies. */
export async function notifyOpsAlert(notification: OpsAlertNotification): Promise<boolean> {
  const to = optionalEnv("FOUNDER_ALERT_EMAIL");
  if (!to) return false;
  const result = await sendResendEmail({
    from: optionalEnv("FOUNDER_ALERT_FROM") ?? DEFAULT_ALERT_FROM,
    to, subject: `Curvi alert ${notification.status === "resolved" ? "resolved" : "opened"}: ${notification.rule}`,
    text: notification.text, idempotencyKey: notification.idempotencyKey,
  });
  if (!result.ok) return false;
  Sentry.captureMessage(`Ops alert ${notification.status}: ${notification.rule}`, {
    level: notification.status === "resolved" ? "info" : "warning",
    tags: { ops_alert_id: notification.id, ops_rule: notification.rule },
  });
  return true;
}

/** The tick supplies process health and optional cap/economics samples.
 * Absent telemetry leaves its rules unchanged instead of falsely resolving
 * an alert. Database rules are read on every evaluation. */
export async function evaluateOpsAlerts(db: Db, options: OpsAlertSignals & {
  now?: Date;
  notify?: OpsAlertNotifier;
} = {}): Promise<{ opened: number; resolved: number; notified: number; failedNotifications: number }> {
  const now = options.now ?? new Date();
  const excluded = await operatorWorkspaceIds(db);
  const customer = (column: ReturnType<typeof sql>) => customerWorkspace(excluded, column);
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString();
  const report = { opened: 0, resolved: 0, notified: 0, failedNotifications: 0 };
  const deliveries = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('curvi:ops-alert-evaluation', 0))`);
    const conditions: Condition[] = [];
    const activeRules = new Set(["failed_pack", "failure_rate", "stale_job", "queue_wait", "signups_high", "withheld_grants_high", "gallery_submission", "pack_not_yet"]);
    const add = (rule: string, subject: string, detail: Record<string, unknown> = {}) => conditions.push({ rule, subject, detail });
    const finished = rowsOf<{ id: string; status: string }>(await tx.execute(sql`
      select id, status from generation_jobs where ${customer(sql`workspace_id`)} and status in ('done', 'failed')
      and coalesce(finished_at, updated_at) >= ${ago(opsAlertPolicy.failureWindowMinutes)}::timestamptz
      and coalesce(finished_at, updated_at) <= ${now.toISOString()}::timestamptz`));
    const failed = finished.filter((job) => job.status === "failed");
    if (finished.length < opsAlertPolicy.minimumFinishedPacks) {
      for (const job of failed) add("failed_pack", job.id);
    } else if (failed.length / finished.length >= opsAlertPolicy.failureRate) {
      add("failure_rate", "all", { failed: failed.length, finished: finished.length });
    }
    const stale = rowsOf<{ id: string }>(await tx.execute(sql`
      select id from generation_jobs where status in ('queued','analyzing','planning','generating','qc','packaging')
      and coalesce(heartbeat_at, updated_at) < ${ago(opsAlertPolicy.staleHeartbeatMinutes)}::timestamptz`));
    for (const job of stale) add("stale_job", job.id);
    const queued = rowsOf<{ id: string }>(await tx.execute(sql`
      select id from generation_jobs where status = 'queued'
      and created_at < ${ago(opsAlertPolicy.queueWaitMinutes)}::timestamptz`));
    for (const job of queued) add("queue_wait", job.id);

    const authExists = rowsOf<{ present: boolean }>(await tx.execute(sql`select to_regclass('auth.users') is not null as present`))[0]?.present;
    const signupCount = authExists
      ? rowsOf<{ count: number }>(await tx.execute(sql`select count(*)::int as count from auth.users where ${customerUser(excluded, sql`auth.users.id`)} and created_at >= ${ago(opsAlertPolicy.signupWindowMinutes)}::timestamptz`))[0]?.count ?? 0
      : rowsOf<{ count: number }>(await tx.execute(sql`select count(*)::int as count from workspaces where ${customer(sql`id`)} and created_at >= ${ago(opsAlertPolicy.signupWindowMinutes)}::timestamptz`))[0]?.count ?? 0;
    if (signupCount >= opsAlertPolicy.signupsPerHour) add("signups_high", "all", { count: signupCount });
    const withheld = rowsOf<{ count: number }>(await tx.execute(sql`select count(*)::int as count from signup_grants where ${customer(sql`workspace_id`)} and withheld_reason is not null and granted_at >= ${ago(opsAlertPolicy.withheldWindowHours * 60)}::timestamptz`))[0]?.count ?? 0;
    if (withheld >= opsAlertPolicy.withheldGrantsPerDay) add("withheld_grants_high", "all", { count: withheld });
    const gallery = rowsOf<{ id: string }>(await tx.execute(sql`select g.id from gallery_items g join share_links s on g.share_slug = s.slug and g.workspace_id = s.workspace_id where ${customer(sql`g.workspace_id`)} and g.review_status = 'pending' and g.published and s.public`));
    for (const item of gallery) add("gallery_submission", item.id);
    const feedback = rowsOf<{ id: string }>(await tx.execute(sql`select id from pack_feedback where ${customer(sql`workspace_id`)} and usable = 'not_yet' and created_at >= ${ago(opsAlertPolicy.feedbackWindowDays * 24 * 60)}::timestamptz`));
    for (const item of feedback) add("pack_not_yet", item.id);

    if (options.healthWarnings !== undefined) {
      activeRules.add("memory_high"); activeRules.add("health_warning");
      const [memory] = await tx.select().from(platformSettings).where(eq(platformSettings.key, MEMORY_KEY));
      const prior = typeof memory?.value === "number" && Number.isFinite(memory.value) ? memory.value : 0;
      const ticks = options.healthWarnings.includes("memory_high") ? prior + 1 : 0;
      await tx.insert(platformSettings).values({ key: MEMORY_KEY, value: ticks, updatedAt: now }).onConflictDoUpdate({ target: platformSettings.key, set: { value: ticks, updatedAt: now } });
      if (ticks >= opsAlertPolicy.memoryHighTicks) add("memory_high", "all", { consecutiveTicks: ticks });
      for (const code of new Set(options.healthWarnings)) {
        if (code === "db_size_high" || code === "restore_drill_overdue" || /^(cron_overdue|cron_never_ran):/.test(code)) add("health_warning", code);
      }
    }
    if (options.reconciledJobs !== undefined) {
      activeRules.add("reconciled_jobs");
      if (options.reconciledJobs > 0) add("reconciled_jobs", "all", { count: options.reconciledJobs });
    }
    if (options.workspaceCaps !== undefined) {
      activeRules.add("workspace_day_cap");
      for (const cap of options.workspaceCaps) if (cap.limitMicros > 0 && cap.usedMicros >= cap.limitMicros) add("workspace_day_cap", cap.workspaceId, { usedMicros: cap.usedMicros, limitMicros: cap.limitMicros });
    }
    if (options.shotMargins !== undefined) {
      activeRules.add("shot_margin");
      for (const shot of options.shotMargins) if (Number.isFinite(shot.grossMargin) && shot.grossMargin < economics.minGrossMargin) add("shot_margin", shot.shotType, { grossMargin: shot.grossMargin });
    }

    const existing = await tx.select().from(opsAlerts).where(eq(opsAlerts.status, "open"));
    const key = (row: { rule: string; subject: string }) => JSON.stringify([row.rule, row.subject]);
    const byKey = new Map(existing.map((row) => [key(row), row]));
    const matched = new Set<string>();
    for (const condition of conditions) {
      const k = key(condition);
      if (matched.has(k)) continue;
      matched.add(k);
      const current = byKey.get(k);
      if (!current) {
        const id = randomUUID();
        await tx.insert(opsAlerts).values({ id, ...condition, openedAt: now, updatedAt: now,
          detail: { ...condition.detail, _delivery: pendingDelivery(`ops-alert:${id}:open`) } });
        report.opened += 1;
      } else {
        const pending = deliveryOf(current.detail) ?? (
          current.lastNotifiedAt && now.getTime() - current.lastNotifiedAt.getTime() >= opsAlertPolicy.dedupeMinutes * MINUTE
            ? pendingDelivery(`ops-alert:${current.id}:reminder:${now.toISOString()}`) : null
        );
        await tx.update(opsAlerts).set({ count: current.count + 1, updatedAt: now, detail: { ...condition.detail, _delivery: pending } }).where(eq(opsAlerts.id, current.id));
      }
    }
    for (const current of existing) {
      if (!activeRules.has(current.rule) || matched.has(key(current))) continue;
      await tx.update(opsAlerts).set({ status: "resolved", resolvedAt: now, updatedAt: now,
        detail: { ...current.detail, _delivery: pendingDelivery(`ops-alert:${current.id}:resolved`) } }).where(eq(opsAlerts.id, current.id));
      report.resolved += 1;
    }
    const pendingRows = await tx.select().from(opsAlerts)
      .where(sql`${opsAlerts.detail}->'_delivery'->>'key' IS NOT NULL`)
      .orderBy(opsAlerts.updatedAt).limit(opsAlertPolicy.maxNotificationsPerTick);
    const claimed: Array<{ row: OpsAlert; delivery: Delivery }> = [];
    for (const row of pendingRows) {
      const delivery = deliveryOf(row.detail)!;
      if (delivery.claimedAt && now.getTime() - Date.parse(delivery.claimedAt) < opsAlertPolicy.notificationLeaseMinutes * MINUTE) continue;
      delivery.claim = randomUUID(); delivery.claimedAt = now.toISOString();
      await tx.update(opsAlerts).set({ detail: { ...row.detail, _delivery: delivery } }).where(eq(opsAlerts.id, row.id));
      claimed.push({ row, delivery });
    }
    return claimed;
  });
  for (const { row, delivery } of deliveries) {
    let ok = false;
    try {
      ok = await (options.notify ?? notifyOpsAlert)({ id: row.id, rule: row.rule, subject: row.subject, status: row.status,
        idempotencyKey: delivery.key, text: `${row.status === "resolved" ? "Resolved" : "Open"}: ${row.rule} (${row.subject}).` });
    } catch { /* Keep the durable notification pending for the next tick. */ }
    await db.update(opsAlerts).set({
      detail: sql`jsonb_set(${opsAlerts.detail}, '{_delivery}', ${JSON.stringify(ok ? null : pendingDelivery(delivery.key))}::jsonb)`,
      ...(ok ? { lastNotifiedAt: now } : {}),
    }).where(and(eq(opsAlerts.id, row.id), sql`${opsAlerts.detail}->'_delivery'->>'claim' = ${delivery.claim}`));
    if (ok) report.notified += 1; else report.failedNotifications += 1;
  }
  return report;
}

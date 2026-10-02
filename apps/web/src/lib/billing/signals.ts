/**
 * Billing signals in platform_settings (docs/phases/PHASE_20.md P20-01 and
 * P20-02), the cron-health pattern: a platform table the web database role
 * already writes, so no migration.
 * - `webhook:stripe:last_success`: the Stripe webhook answered 2xx.
 * - `checkout:last_opened`: the checkout route handed a buyer a Stripe URL.
 * - `billing:reconcile:last_run`: what the last billing reconcile saw (the
 *   newest Stripe event, the webhook endpoint check, the failures already
 *   emailed to the founder).
 * - `billing:email:last_result`: whether the last plan email went out.
 * GET /api/health reads them for `stripe_webhook_quiet` and
 * `stripe_webhook_endpoint_mismatch` (lib/billing/billing-health.ts).
 *
 * Writes never throw: a signal is reporting, and the payment or the cron
 * run it describes already happened.
 */

import { platformSettings, sql, type Db } from "@curvi/db";
import type { SqlExecutor } from "@/lib/service-health";

export const WEBHOOK_SUCCESS_KEY = "webhook:stripe:last_success";
export const CHECKOUT_OPENED_KEY = "checkout:last_opened";
export const RECONCILE_RUN_KEY = "billing:reconcile:last_run";
/** The last plan email send (activation or plan change) and whether it
 * went out, for billing_email_failing (law and copy review major 4). */
export const BILLING_EMAIL_RESULT_KEY = "billing:email:last_result";

export const BILLING_SIGNAL_KEYS = [
  WEBHOOK_SUCCESS_KEY,
  CHECKOUT_OPENED_KEY,
  RECONCILE_RUN_KEY,
  BILLING_EMAIL_RESULT_KEY,
] as const;

/** What `billing:email:last_result` holds. */
export interface BillingEmailResultSignal {
  at: string;
  ok: boolean;
  kind: string;
  invoiceId: string;
  /** Why it failed (Resend's answer), only when it did. */
  notice?: string;
}

/** The webhook endpoint check of a reconcile run. */
export interface EndpointCheck {
  /** False when no enabled endpoint at the site's webhook URL covers every
   * handled event on the pinned API version. */
  ok: boolean;
  /** Why not, in plain words for the founder; empty when ok. */
  problems: string[];
  /** Set when the check did not run (a local site, or the list failed). */
  skipped?: string;
}

/** What `billing:reconcile:last_run` holds. */
export interface ReconcileRunSignal {
  /** When the run finished (ISO). */
  at: string;
  /** Created time (ISO) of the newest handled Stripe event in the lookback
   * window, null when there was none. */
  newestEventAt: string | null;
  applied: number;
  failed: number;
  endpoint: EndpointCheck | null;
  /** Failed event ids already emailed to the founder, with when (ISO), so a
   * failure that stays failed is not emailed on every run. */
  reportedFailures: Record<string, string>;
  /** The window held more events than one run reads (health warns
   * stripe_reconcile_behind); the next run starts at resumeFrom. */
  truncated?: boolean;
  resumeFrom?: string | null;
}

export interface BillingSignals {
  webhookSuccessAt: string | null;
  checkoutOpenedAt: string | null;
  reconcile: ReconcileRunSignal | null;
  /** Absent in signals read before the key existed. */
  email?: BillingEmailResultSignal | null;
}

/** Records `{ at }` under a signal key. Never throws. */
export async function recordBillingSignal(
  db: Pick<Db, "insert">,
  key: typeof WEBHOOK_SUCCESS_KEY | typeof CHECKOUT_OPENED_KEY,
  at: Date = new Date(),
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
  await writeSignal(db, key, { at: at.toISOString() }, at, logger);
}

/** Records the reconcile run. Never throws. */
export async function recordReconcileRun(
  db: Pick<Db, "insert">,
  run: ReconcileRunSignal,
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
  await writeSignal(db, RECONCILE_RUN_KEY, run, new Date(run.at), logger);
}

/** Records the last plan email send. Never throws. */
export async function recordBillingEmailResult(
  db: Pick<Db, "insert">,
  result: Omit<BillingEmailResultSignal, "at">,
  at: Date = new Date(),
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
  const value: BillingEmailResultSignal = {
    at: at.toISOString(),
    ok: result.ok,
    kind: result.kind,
    invoiceId: result.invoiceId,
    ...(result.notice ? { notice: result.notice.slice(0, 300) } : {}),
  };
  await writeSignal(db, BILLING_EMAIL_RESULT_KEY, value, at, logger);
}

async function writeSignal(
  db: Pick<Db, "insert">,
  key: string,
  value: unknown,
  at: Date,
  logger: Pick<Console, "warn">,
): Promise<void> {
  try {
    await db
      .insert(platformSettings)
      .values({ key, value, updatedAt: at })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      });
  } catch (err) {
    logger.warn(`[billing] could not record ${key}:`, err instanceof Error ? err.message : String(err));
  }
}

/** postgres-js returns the rows as an array, PGlite as { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function atOf(value: unknown): string | null {
  return isoOrNull((parsed(value) as { at?: unknown } | null)?.at);
}

/** A stored reconcile run, or null when absent or malformed. */
export function reconcileRunOf(value: unknown): ReconcileRunSignal | null {
  const run = parsed(value) as Partial<ReconcileRunSignal> | null;
  const at = isoOrNull(run?.at);
  if (!run || !at) return null;
  const reported: Record<string, string> = {};
  if (run.reportedFailures && typeof run.reportedFailures === "object") {
    for (const [id, when] of Object.entries(run.reportedFailures)) {
      const iso = isoOrNull(when);
      if (iso) reported[id] = iso;
    }
  }
  const endpoint =
    run.endpoint && typeof run.endpoint === "object" && typeof run.endpoint.ok === "boolean"
      ? {
          ok: run.endpoint.ok,
          problems: Array.isArray(run.endpoint.problems)
            ? run.endpoint.problems.filter((p): p is string => typeof p === "string")
            : [],
          ...(typeof run.endpoint.skipped === "string" ? { skipped: run.endpoint.skipped } : {}),
        }
      : null;
  return {
    at,
    newestEventAt: isoOrNull(run.newestEventAt),
    applied: Number(run.applied ?? 0) || 0,
    failed: Number(run.failed ?? 0) || 0,
    endpoint,
    reportedFailures: reported,
    truncated: run.truncated === true,
    resumeFrom: isoOrNull(run.resumeFrom),
  };
}

/** A stored email result, or null when absent or malformed. */
export function emailResultOf(value: unknown): BillingEmailResultSignal | null {
  const result = parsed(value) as Partial<BillingEmailResultSignal> | null;
  const at = isoOrNull(result?.at);
  if (!result || !at || typeof result.ok !== "boolean") return null;
  return {
    at,
    ok: result.ok,
    kind: typeof result.kind === "string" ? result.kind : "unknown",
    invoiceId: typeof result.invoiceId === "string" ? result.invoiceId : "unknown",
    ...(typeof result.notice === "string" ? { notice: result.notice } : {}),
  };
}

/** Reads every billing signal in one query. Throws when the read fails. */
export async function readBillingSignals(db: SqlExecutor): Promise<BillingSignals> {
  const rows = rowsOf<{ key: string; value: unknown }>(
    await db.execute(
      sql`select key, value from platform_settings where key in (${sql.join(
        BILLING_SIGNAL_KEYS.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    ),
  );
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    webhookSuccessAt: atOf(byKey.get(WEBHOOK_SUCCESS_KEY)),
    checkoutOpenedAt: atOf(byKey.get(CHECKOUT_OPENED_KEY)),
    reconcile: reconcileRunOf(byKey.get(RECONCILE_RUN_KEY)),
    email: emailResultOf(byKey.get(BILLING_EMAIL_RESULT_KEY)),
  };
}

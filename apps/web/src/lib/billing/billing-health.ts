/**
 * Billing warnings for GET /api/health (docs/phases/PHASE_20.md P20-01,
 * P20-02 and P20-07). lib/health-status.ts rates them; see its table.
 * - Each readiness problem (lib/billing/readiness.ts): a secret key, the
 *   webhook secret or a price missing, a key in the wrong mode, or the
 *   billing sender (`billing_email_not_configured`). Each closes checkout,
 *   so they are degraded once billing is meant to be live (`billingLive`:
 *   a live key, or a checkout has opened before) and info until then (law
 *   and copy review major 5).
 * - `stripe_webhook_quiet`: a checkout opened in the last
 *   `billingReconcile.quietWebhookDays` days and no webhook has succeeded
 *   since. That catches a wrong signing secret, which no API can check. Two
 *   narrowings keep an abandoned checkout from raising it: the checkout must
 *   be older than two reconcile intervals (time to pay and for a reconcile
 *   run), and it stays quiet when a reconcile run after the checkout saw no
 *   Stripe event created since (nothing was there to deliver).
 * - `stripe_portal_upgrade_config_missing` (P20-06 stopgap): checkout is
 *   open but a plan and cadence with an upgrade has no upgrade only portal
 *   configuration, so those subscribers cannot upgrade online.
 * - `billing_email_failing` (P20-07): the last plan email did not go out
 *   (for example Resend refused the key or the sender), so the claim was
 *   given back and a replay retries.
 * - `legal_facts_pending` (P20-23, decision 9): Stripe is set up while the
 *   terms still say the entity, address or governing law come later.
 * - `stripe_webhook_endpoint_mismatch`: the last reconcile run found no
 *   enabled endpoint at the site's webhook URL covering every handled event
 *   on the pinned API version.
 * - `stripe_reconcile_behind`: the last reconcile run hit its cap, so it
 *   processed the oldest events and the next run carries on.
 *
 * The database read runs under the health timeout; a failed read is logged
 * and gives no warning (cron_check_failed already reports an unreadable
 * platform_settings).
 */

import { billingReconcile } from "@curvi/pipeline/seed";
import type { HealthWarning } from "@/lib/config-health";
import { withTimeout, type SqlExecutor } from "@/lib/service-health";
import { pendingLegalFacts } from "@/lib/legal/copy";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { portalUpgradeConfigEnvName, upgradeConfigsNeeded } from "./checkout";
import { billingReadiness } from "./readiness";
import { readBillingSignals, type BillingSignals } from "./signals";
import type { EnvReader } from "./price-table";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface BillingHealthDeps {
  readEnv: EnvReader;
  /** Absent in demo mode or when the database did not answer. */
  db?: () => SqlExecutor;
  now: Date;
  timeoutMs: number;
  logger?: Pick<Console, "warn">;
  policy?: { quietWebhookDays: number; everyMinutes: number };
  /** The legal facts still to set (lib/legal/copy.ts); LEGAL_FACTS's by
   * default. */
  pendingLegalFacts?: () => string[];
}

function ms(iso: string): number {
  return Date.parse(iso);
}

/**
 * True when a checkout opened inside the quiet window, long enough ago for
 * its payment and a reconcile run, and neither a webhook success nor a
 * reconcile run that saw nothing new has come since.
 */
export function webhookQuiet(
  signals: BillingSignals,
  now: Date,
  policy: { quietWebhookDays: number; everyMinutes: number } = billingReconcile,
): boolean {
  const opened = signals.checkoutOpenedAt;
  if (!opened) return false;
  const openedMs = ms(opened);
  const age = now.getTime() - openedMs;
  if (age > policy.quietWebhookDays * DAY_MS) return false;
  if (age < 2 * policy.everyMinutes * MINUTE_MS) return false;
  if (signals.webhookSuccessAt && ms(signals.webhookSuccessAt) >= openedMs) return false;
  const run = signals.reconcile;
  if (run && ms(run.at) > openedMs && (run.newestEventAt === null || ms(run.newestEventAt) < openedMs)) {
    // Stripe made no handled event since the checkout opened: abandoned.
    return false;
  }
  return true;
}

function quietMessage(days: number): HealthWarning {
  return {
    code: "stripe_webhook_quiet",
    message: `A checkout opened in the last ${days} days and no Stripe webhook has succeeded since. Check the endpoint's recent deliveries in the Stripe Dashboard and that STRIPE_WEBHOOK_SECRET is that endpoint's signing secret.`,
  };
}

export interface BillingHealth {
  warnings: HealthWarning[];
  /** Billing is meant to be live: a live mode key is set, or a checkout
   * has opened before. The readiness problems are degraded from then on
   * (lib/health-status.ts `whileBillingNotLive`). */
  billingLive: boolean;
}

/** Every billing warning for the health report, and whether billing is
 * meant to be live. */
export async function billingHealth(deps: BillingHealthDeps): Promise<BillingHealth> {
  const readiness = billingReadiness(deps.readEnv);
  const warnings: HealthWarning[] = readiness.problems.map((problem) => ({
    code: problem.code,
    message: problem.message,
  }));
  let billingLive = readiness.keyMode === "live";
  if (readiness.checkoutOpen) {
    const missing = upgradeConfigsNeeded()
      .map(portalUpgradeConfigEnvName)
      .filter((name) => !deps.readEnv(name));
    if (missing.length > 0) {
      warnings.push({
        code: "stripe_portal_upgrade_config_missing",
        message: `Subscribers cannot upgrade online until these are set to their upgrade only portal configurations (docs/STRIPE_SETUP.md section 5): ${missing.join(", ")}.`,
      });
    }
  }
  if (readiness.apiKey) {
    const pending = (deps.pendingLegalFacts ?? (() => pendingLegalFacts(LEGAL_FACTS)))();
    if (pending.length > 0) {
      warnings.push({
        code: "legal_facts_pending",
        message: `The terms still say these come later, so set them in apps/web/src/lib/legal/facts.ts before live keys (decision 9): ${pending.join(", ")}.`,
      });
    }
  }
  if (!readiness.apiKey || !deps.db) {
    return { warnings, billingLive };
  }
  const policy = deps.policy ?? billingReconcile;
  let signals: BillingSignals;
  try {
    const db = deps.db();
    signals = await withTimeout(() => readBillingSignals(db), deps.timeoutMs);
  } catch (err) {
    (deps.logger ?? console).warn(
      "[health] billing signals could not be read:",
      err instanceof Error ? err.message : String(err),
    );
    return { warnings, billingLive };
  }
  billingLive ||= signals.checkoutOpenedAt !== null;
  if (webhookQuiet(signals, deps.now, policy)) {
    warnings.push(quietMessage(policy.quietWebhookDays));
  }
  const endpoint = signals.reconcile?.endpoint;
  if (endpoint && !endpoint.ok) {
    warnings.push({
      code: "stripe_webhook_endpoint_mismatch",
      message: `The Stripe webhook endpoint does not match what this build needs: ${endpoint.problems.join(" ")}`,
    });
  }
  if (signals.reconcile?.truncated) {
    warnings.push({
      code: "stripe_reconcile_behind",
      message: `The last billing reconcile found more Stripe events than one run reads, so it processed the oldest and the next run carries on from ${signals.reconcile.resumeFrom ?? "where it stopped"}. If this stays for hours, raise billingReconcile.maxEventsPerRun in the seed or run the reconcile route by hand.`,
    });
  }
  if (signals.email && !signals.email.ok) {
    warnings.push({
      code: "billing_email_failing",
      message: `The last plan email (${signals.email.kind} for invoice ${signals.email.invoiceId}) did not go out at ${signals.email.at}: ${signals.email.notice ?? "no reason given"}. Check RESEND_API_KEY and that BILLING_EMAIL_FROM is on a verified domain; the next webhook retry or reconcile sends it.`,
    });
  }
  return { warnings, billingLive };
}

/** Every billing warning for the health report. */
export async function billingHealthWarnings(deps: BillingHealthDeps): Promise<HealthWarning[]> {
  return (await billingHealth(deps)).warnings;
}

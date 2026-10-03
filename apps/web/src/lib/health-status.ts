/**
 * Health status: ok, degraded or down (docs/phases/PHASE_20.md P20-15).
 *
 * A keyword monitor on `"ok":true` misses fal running dry or a dead cron,
 * because warnings never change `ok`. This module turns the
 * checks and warning codes of GET /api/health into one status:
 * - down: today's `ok: false` cases (database failed, schema behind,
 *   draining);
 * - degraded: anything that stops or threatens packs, payments or recovery;
 * - info: drift and reminders that need a look but break nothing.
 * A code missing from the table counts as degraded, so a new warning is
 * never silently ignored. `ok` and the HTTP status keep their meaning.
 *
 * GET /api/health reports the result as `status` and `degradedBy`
 * (lib/service-health.ts); `ok` and the HTTP status keep their meaning, so
 * Render's restarts do not change. health-status.test.ts fails when a code
 * config-health (or any lib file named *health*) can emit has no row here,
 * and docs/ops/ALERTS.md must explain every down and degraded row. A lane
 * that adds a warning code adds its row and its ALERTS.md entry in the same
 * change.
 */

export type HealthStatus = "ok" | "degraded" | "down";
export type HealthSeverity = "down" | "degraded" | "info";

/**
 * One row of the severity table. `code` is an exact code, or a pattern in
 * which `*` stands for any text ("cron_overdue:*", "no_*_provider").
 * `whileCheckoutClosed` is the severity while checkout is not open: a
 * billing problem cannot cost a payment yet (P20-01). `whileBillingNotLive`
 * is the severity until billing is meant to be live (a live key, or a
 * checkout has opened before): a readiness problem keeps checkout closed,
 * so it must count as degraded once sales should be running, or a broken
 * setup after launch would only ever show as info (law and copy review
 * major 5).
 */
export interface SeverityRule {
  code: string;
  severity: HealthSeverity;
  whileCheckoutClosed?: HealthSeverity;
  whileBillingNotLive?: HealthSeverity;
  /** The severity while the provider named after the code's first colon
   * is not in a paused stage, so another provider of its stage still
   * serves. Applied only when the context lists the paused providers. */
  whileStageRunning?: HealthSeverity;
}

/** The codes for today's `ok: false` cases (lib/service-health.ts). */
export const DOWN_CODES = {
  database: "database_failed",
  schema: "schema_behind",
  draining: "draining",
} as const;

/** The severity of every code /api/health can show. The first matching row
 * wins, so exact codes come before the patterns that would also match. */
export const SEVERITY_TABLE: readonly SeverityRule[] = [
  // Down: the cases that already set ok to false.
  { code: DOWN_CODES.database, severity: "down" },
  { code: DOWN_CODES.schema, severity: "down" },
  { code: DOWN_CODES.draining, severity: "down" },

  // Degraded: packs, payments or alerts are at risk.
  { code: "packs_paused:*", severity: "degraded" },
  { code: "scenes_paused", severity: "degraded" },
  // P20-19's pause switch.
  { code: "maintenance", severity: "degraded" },
  // A provider whose breaker a quota answer opened (lib/service-health.ts):
  // degraded only when it pauses a stage, since a failover provider of the
  // same stage otherwise keeps packs running.
  { code: "provider_quota:*", severity: "degraded", whileStageRunning: "info" },
  // Every provider of a stage open (P20-15).
  { code: "breaker_open:*", severity: "degraded" },
  { code: "no_*_provider", severity: "degraded" },
  { code: "storage_not_configured", severity: "degraded" },
  // P20-16, from P18-03's balance rows.
  { code: "fal_balance_low", severity: "degraded" },
  { code: "cron_never_ran:*", severity: "degraded" },
  { code: "cron_overdue:*", severity: "degraded" },
  { code: "cron_check_failed", severity: "degraded" },
  { code: "memory_high", severity: "degraded" },
  { code: "db_size_high", severity: "degraded" },
  { code: "llm_credits_expired:*", severity: "degraded" },
  // P20-22 emits this within 14 days of the earliest retirement date.
  { code: "llm_model_retiring:*", severity: "degraded" },
  // P20-01 readiness problems, each of which closes checkout (P20-07's
  // billing sender among them): degraded once billing is meant to be live.
  { code: "stripe_secret_key_missing", severity: "degraded", whileBillingNotLive: "info" },
  { code: "stripe_webhook_secret_missing", severity: "degraded", whileBillingNotLive: "info" },
  { code: "stripe_price_missing", severity: "degraded", whileBillingNotLive: "info" },
  { code: "stripe_key_mode_mismatch", severity: "degraded", whileBillingNotLive: "info" },
  { code: "billing_email_not_configured", severity: "degraded", whileBillingNotLive: "info" },
  // P20-02 webhook warnings and P20-06's portal configurations: they only
  // cost a payment while checkout is open.
  { code: "stripe_*", severity: "degraded", whileCheckoutClosed: "info" },
  // P20-07: a plan email Resend refused.
  { code: "billing_email_failing", severity: "degraded" },
  // P18-06: lifecycle email is switched on but a sender variable is
  // missing, so every email the founder turned on is skipped.
  { code: "lifecycle_email_not_configured", severity: "degraded" },
  // P20-23: the terms still say the entity and governing law come later.
  { code: "legal_facts_pending", severity: "degraded", whileCheckoutClosed: "info" },
  // P20-29.
  { code: "turnstile_secret_missing", severity: "degraded" },
  { code: "config_check_failed", severity: "degraded" },

  // Info: a look is due, nothing is broken.
  { code: "recipe_drift", severity: "info" },
  { code: "recipe_check_failed", severity: "info" },
  // P18-03.
  { code: "fal_admin_key_missing", severity: "info" },
  { code: "llm_credits_expiring:*", severity: "info" },
  { code: "shot_concurrency_invalid", severity: "info" },
  // P20-18.
  { code: "trigger_secret_ignored", severity: "info" },
];

export interface ClassifyContext {
  /** True once checkout is open (P20-01's isCheckoutOpen); default false. */
  checkoutOpen?: boolean;
  /** True once billing is meant to be live (lib/billing/billing-health.ts
   * `billingLive`); default false. */
  billingLive?: boolean;
  /** Providers in a stage whose every configured provider is unavailable
   * (lib/service-health.ts stageBreakerWarnings). Left out, rules with
   * whileStageRunning keep their main severity. */
  pausedProviders?: readonly string[];
  /** Explicit 15 to 30 day notices from the model retirement check. */
  retirementInfoCodes?: readonly string[];
}

export interface HealthClassification {
  status: HealthStatus;
  /** Every code that keeps the status from ok: the down codes, then the
   * degraded ones, each in input order without repeats; empty when ok. */
  degradedBy: string[];
}

function patternMatches(pattern: string, code: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === code;
  }
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(code);
}

/** The table row for a code, or null when no row matches. */
export function severityRuleFor(code: string, table: readonly SeverityRule[] = SEVERITY_TABLE): SeverityRule | null {
  return table.find((rule) => patternMatches(rule.code, code)) ?? null;
}

/** A code's severity; a code with no row is degraded. */
export function severityOf(code: string, context: ClassifyContext = {}): HealthSeverity {
  const rule = severityRuleFor(code);
  if (!rule) {
    return "degraded";
  }
  if (code.startsWith("llm_model_retiring:") && context.retirementInfoCodes?.includes(code)) return "info";
  if (!context.billingLive && rule.whileBillingNotLive) {
    return rule.whileBillingNotLive;
  }
  if (!context.checkoutOpen && rule.whileCheckoutClosed) {
    return rule.whileCheckoutClosed;
  }
  if (rule.whileStageRunning && context.pausedProviders) {
    const provider = code.slice(code.indexOf(":") + 1);
    if (!context.pausedProviders.includes(provider)) {
      return rule.whileStageRunning;
    }
  }
  return rule.severity;
}

/** The down codes for the three checks GET /api/health runs. */
export function downCodes(checks: { database: string; schema: string; packRunner: string }): string[] {
  const codes: string[] = [];
  if (checks.database === "failed") codes.push(DOWN_CODES.database);
  if (checks.schema === "behind") codes.push(DOWN_CODES.schema);
  if (checks.packRunner === "draining") codes.push(DOWN_CODES.draining);
  return codes;
}

/** The status for a set of codes: down if any is down, degraded if any is
 * degraded (unknown codes included), otherwise ok. */
export function classify(codes: readonly string[], context: ClassifyContext = {}): HealthClassification {
  const unique = [...new Set(codes)];
  const severities = unique.map((code) => ({ code, severity: severityOf(code, context) }));
  const down = severities.filter((entry) => entry.severity === "down").map((entry) => entry.code);
  const degraded = severities.filter((entry) => entry.severity === "degraded").map((entry) => entry.code);
  const status: HealthStatus = down.length > 0 ? "down" : degraded.length > 0 ? "degraded" : "ok";
  return { status, degradedBy: [...down, ...degraded] };
}

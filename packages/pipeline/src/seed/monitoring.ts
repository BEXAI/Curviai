/**
 * LLM cost monitoring seed (docs/phases/PHASE_17.md workstream 6 and the
 * founder decisions of 2026-10-01). The dates and thresholds the founder
 * alerts use live here, never in the monitoring code (CLAUDE.md rule 2), so
 * a new credit grant or a different alert line is a seed change.
 */

import type { LlmProviderFamily } from "./models";

export interface LlmModelRetirement {
  model: string;
  /** Earliest published bound, not necessarily an announced shutdown. */
  earliestRetirementDate: string;
  dateKind: "not-sooner-than" | "announced";
  source: string;
  checkedOn: string;
}

/** Verified on Anthropic's official table on 2026-10-02. These three rows
 * still have no announced retirement. Do not describe the bounds as outages. */
export const llmModelRetirements: readonly LlmModelRetirement[] = [
  { model: "claude-haiku-4-5-20251001", earliestRetirementDate: "2026-10-15", dateKind: "not-sooner-than",
    source: "https://platform.claude.com/docs/en/about-claude/model-deprecations", checkedOn: "2026-10-02" },
  { model: "claude-sonnet-5", earliestRetirementDate: "2027-06-30", dateKind: "not-sooner-than",
    source: "https://platform.claude.com/docs/en/about-claude/model-deprecations", checkedOn: "2026-10-02" },
  { model: "claude-opus-5-5", earliestRetirementDate: "2027-09-22", dateKind: "not-sooner-than",
    source: "https://platform.claude.com/docs/en/about-claude/model-deprecations", checkedOn: "2026-10-02" },
];

export const llmRetirementWarningPolicy = { infoDays: 30, degradedDays: 14 } as const;

interface RetirementRecipe {
  active: boolean;
  model: string;
  fallbackModels?: readonly string[] | null;
  body?: unknown;
}

/** Active zero-weight rollback rows can still serve failover calls. */
export function activeRecipeModels(rows: readonly RetirementRecipe[]): Set<string> {
  const models = new Set<string>();
  for (const row of rows) {
    if (!row.active) continue;
    models.add(row.model);
    for (const model of row.fallbackModels ?? []) models.add(model);
    const escalation = row.body && typeof row.body === "object" && "escalation" in row.body ? row.body.escalation : null;
    if (Array.isArray(escalation)) for (const model of escalation) if (typeof model === "string") models.add(model);
  }
  return models;
}

export function modelRetirementNotices(
  rows: readonly RetirementRecipe[],
  asOf: Date,
  retirements: readonly LlmModelRetirement[] = llmModelRetirements,
): Array<LlmModelRetirement & { daysUntil: number; severity: "info" | "degraded" }> {
  const models = activeRecipeModels(rows);
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return retirements.flatMap((retirement) => {
    if (!models.has(retirement.model)) return [];
    const daysUntil = Math.ceil((Date.parse(`${retirement.earliestRetirementDate}T00:00:00Z`) - today) / 86_400_000);
    if (!Number.isFinite(daysUntil) || daysUntil > llmRetirementWarningPolicy.infoDays) return [];
    return [{ ...retirement, daysUntil, severity: daysUntil <= llmRetirementWarningPolicy.degradedDays ? "degraded" as const : "info" as const }];
  });
}

// ===========================================================================
// PHASE_20 Lane 4 Observe (p20/observe): P20-13 and P20-15.
// ===========================================================================

export interface ErrorReportingLimits {
  /** An error whose fingerprint was already sent this many times in the
   * last hour is dropped until the hour moves on. */
  maxSameErrorPerHour: number;
  /** At most this many events leave one server process in any hour... */
  maxEventsPerHour: number;
  /** ...and in any 24 hours, across every fingerprint. */
  maxEventsPerDay: number;
}

/**
 * P20-13, founder decision 13: Sentry's free Developer plan holds 5k errors
 * a month (docs/verification.md, PHASE_20). At 150 a day the month stays
 * under 5k, so a hot loop of the same error during a provider outage cannot
 * use up the quota and leave the rest of the month blind. Founder alerts
 * never depend on Sentry: email stays the first channel.
 */
export const errorReporting: ErrorReportingLimits = {
  maxSameErrorPerHour: 20,
  maxEventsPerHour: 60,
  maxEventsPerDay: 150,
};

export interface HealthLimits {
  /** The Supabase Free plan database size; the project turns read only
   * past it (docs/verification.md, PHASE_20). In bytes, as
   * pg_database_size counts (500 MB of 1024 x 1024 bytes). */
  dbSizeLimitBytes: number;
  /** /api/health warns db_size_high (degraded) at this share of the limit. */
  dbSizeHighRatio: number;
  /** P20-34: a new pack starts only below this share of the container
   * memory limit. */
  memoryStartRatio: number;
}

/** P20-15: the numbers behind the health warnings that read a limit. */
export const healthLimits: HealthLimits = {
  dbSizeLimitBytes: 500 * 1024 * 1024,
  dbSizeHighRatio: 0.7,
  memoryStartRatio: 0.6,
};
// The restore drill's age limit (restore_drill_overdue, P20-11) is
// restoreDrill.maxAgeDays in operations.ts; the combine kept that one.

/**
 * P20-23: how long error reports are kept, which the privacy page states
 * (lib/legal/facts.ts logDays). Sentry's free Developer plan has a 30 day
 * lookback (founder decision 13; docs/verification.md, PHASE_20, checked
 * 2026-10-01). PHASE_19's request log retention replaces it at the combine.
 */
export const errorReportRetentionDays = 30;

// End of Lane 4 Observe.

export interface LlmCreditWindow {
  /** The provider family whose credits these are. */
  family: LlmProviderFamily;
  /** The last day (UTC, YYYY-MM-DD) the credits can be spent. */
  expiresOn: string;
  /** Days (UTC, YYYY-MM-DD) the founder is reminded of the expiry, in order. */
  reminderDates: readonly string[];
}

/**
 * The OpenAI credit grant. Founder decision 4: the credits expire on
 * December 31, 2026, and the founder is reminded 30 days before (December 1)
 * and again on December 24, so the switch back to paid OpenAI or to Claude
 * primary is decided before then.
 */
export const llmCreditWindows: readonly LlmCreditWindow[] = [
  { family: "openai", expiresOn: "2026-12-31", reminderDates: ["2026-12-01", "2026-12-24"] },
];

export interface LlmFallbackAlertPolicy {
  /** The family every recipe chain starts with. */
  primaryFamily: LlmProviderFamily;
  /** The family whose share of those calls is watched (the last fallback). */
  fallbackFamily: LlmProviderFamily;
  /** The alert fires when the fallback share of an hour's calls goes above this. */
  maxFallbackShare: number;
  /** Fewer calls than this in the hour say too little to alert on. */
  minCallsPerHour: number;
}

/**
 * Workstream 6 item 3: the founder hears when traffic falls back to Claude
 * above 5 percent of the calls in a UTC hour. Only calls whose chain starts
 * with OpenAI count, so a recipe still served by Claude during the canary
 * never trips it. The minimum keeps one fallback in a quiet hour from
 * reading as 100 percent.
 */
export const llmFallbackAlertPolicy: LlmFallbackAlertPolicy = {
  primaryFamily: "openai",
  fallbackFamily: "anthropic",
  maxFallbackShare: 0.05,
  minCallsPerHour: 20,
};

/** Workstream 6 item 3: provider_quota answers from these families reach the founder. */
export const llmQuotaAlertFamilies: readonly LlmProviderFamily[] = ["openai"];

/** P20-16: one quota notification path for all registered provider families. */
export const providerAlertPolicy = {
  quotaEmailFamilies: "all",
  quotaDedupeMinutes: 60,
  stagePausedMinutes: 10,
  lowBalance: { bflCredits: 10 },
} as const;

/** Metered probes stay opt-in until the founder funds and enables them. */
export const canaryPolicy = {
  enabled: false,
  keyProbeEveryMinutes: 15,
  primaryEveryMinutes: 360,
  backupEveryMinutes: 1440,
  recoveryEveryMinutes: 15,
  fixtureWidth: 64,
  fixtureHeight: 64,
  maxMicrosPerRun: 25_000,
  timeoutMs: 60_000,
} as const;

// ---------------------------------------------------------------------------
// fal balance lines (docs/phases/PHASE_18.md P18-03, founder decision 8).

export interface FalBalanceLines {
  /** Below this balance (USD) the founder gets one email per UTC day per account. */
  alertUsd: number;
  /** Below this balance (USD) on every configured cutout account, the
   * acquisition gate turns marketing calls to action into a waitlist, and
   * the founder is emailed at once (still at most once per UTC day). */
  pauseUsd: number;
}

/** Decision 8: alert below $15, pause acquisition below $3. */
export const falBalanceLines: FalBalanceLines = { alertUsd: 15, pauseUsd: 3 };

export interface FalBalanceAccount {
  /** The cutout provider this account bills (cutoutModelSeedRows providerName). */
  provider: string;
  /** Env var holding the fal Admin API key that can read the balance. A name, never a value. */
  adminKeyEnv: string;
  /** Env var holding the inference key the cutout chain uses on this account. */
  keyEnv: string;
}

/**
 * The fal accounts the balance probe reads, matched to the cutout chain's
 * keys (cutoutModelSeedRows keyEnv): FAL_ADMIN_KEY reads the FAL_KEY
 * account, the optional FAL_ADMIN_KEY_BACKUP the FAL_KEY_BACKUP account.
 * An account is probed only when its admin key is set.
 */
export const falBalanceAccounts: readonly FalBalanceAccount[] = [
  { provider: "fal-birefnet", adminKeyEnv: "FAL_ADMIN_KEY", keyEnv: "FAL_KEY" },
  { provider: "fal-birefnet-backup", adminKeyEnv: "FAL_ADMIN_KEY_BACKUP", keyEnv: "FAL_KEY_BACKUP" },
];

export interface FalBalanceProbePolicy {
  /** Hard ceiling on one balance call. */
  timeoutMs: number;
  /** One provider_balance events row per account at most this often. */
  eventEveryMinutes: number;
  /** A stored balance older than this no longer counts toward the pause,
   * so a stopped cron cannot hold the waitlist after a top up. */
  staleAfterMinutes: number;
}

/** The probe runs from the stale-jobs cron command, every 10 to 15 minutes. */
export const falBalanceProbePolicy: FalBalanceProbePolicy = {
  timeoutMs: 5_000,
  eventEveryMinutes: 60,
  staleAfterMinutes: 90,
};

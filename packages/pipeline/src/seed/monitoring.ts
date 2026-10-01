/**
 * LLM cost monitoring seed (docs/phases/PHASE_17.md workstream 6 and the
 * founder decisions of 2026-10-01). The dates and thresholds the founder
 * alerts use live here, never in the monitoring code (CLAUDE.md rule 2), so
 * a new credit grant or a different alert line is a seed change.
 */

import type { LlmProviderFamily } from "./models";

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

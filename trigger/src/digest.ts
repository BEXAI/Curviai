/** Pure composition for the operational metrics report. */

export interface MonthlyMetrics {
  /** Month the numbers describe, e.g. "2026-09". */
  month: string;
  mrrUsd: number;
  /** Monthly churn as a share, 0 to 1. */
  churnRate: number;
  cogsUsd: number;
  /** Gross margin as a share, 0 to 1. */
  grossMargin: number;
  /** True when the numbers come from the in memory demo reader. */
  demo?: boolean;
  /** LLM spend per provider family over recent days (docs/phases/
   * PHASE_17.md workstream 6), from the LLM usage counters. */
  llmSpend?: DigestLlmSpend;
}

export interface DigestLlmSpend {
  /** The UTC days covered, oldest first. */
  days: string[];
  /** Per provider family: spend in USD micros, calls, and the input tokens
   * served from the cache. */
  byFamily: Record<string, { costMicros: number; calls: number; inputTokens: number; cachedInputTokens: number; reasoningTokens: number }>;
}

/** Display names of the LLM provider families in founder emails and the
 * health details. This module imports nothing, so the LLM monitor, the
 * spend alerts and the web app can all use it without an import cycle. */
export const LLM_FAMILY_NAMES: Readonly<Record<string, string>> = { openai: "OpenAI", anthropic: "Claude" };

/** The display name of an LLM provider family, or the family id itself. */
export function llmFamilyName(family: string): string {
  return LLM_FAMILY_NAMES[family] ?? family;
}

export interface MetricsReader {
  read(): Promise<MonthlyMetrics>;
}

/** In memory demo metrics so the cron runs with zero env configured. */
export class DemoMetricsReader implements MetricsReader {
  constructor(private readonly month: string) {}

  async read(): Promise<MonthlyMetrics> {
    return {
      month: this.month,
      mrrUsd: 0,
      churnRate: 0,
      cogsUsd: 0,
      grossMargin: 0,
      demo: true,
    };
  }
}

export interface DigestEmail {
  subject: string;
  text: string;
}

export const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** USD micros as dollars, for example 1500000 as $1.50. */
export function dollars(micros: number): string {
  return usd.format(micros / 1_000_000);
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function composeDigest(metrics: MonthlyMetrics): DigestEmail {
  const lines = [
    `Curvi metrics for ${metrics.month}.`,
    "",
    `MRR: ${usd.format(metrics.mrrUsd)}`,
    `Churn: ${pct(metrics.churnRate)}`,
    `COGS: ${usd.format(metrics.cogsUsd)}`,
    `Gross margin: ${pct(metrics.grossMargin)}`,
  ];
  if (metrics.llmSpend) {
    const { days, byFamily } = metrics.llmSpend;
    const families = Object.keys(byFamily).sort();
    const range = days.length > 0 ? `${days[0]} to ${days[days.length - 1]}` : "the last days";
    lines.push("", `LLM spend by provider, ${range} (UTC):`);
    if (families.length === 0) {
      lines.push("No LLM calls were recorded.");
    }
    for (const family of families) {
      const f = byFamily[family];
      const cachedShare = f.inputTokens > 0 ? f.cachedInputTokens / f.inputTokens : 0;
      lines.push(
        `${llmFamilyName(family)}: ${dollars(f.costMicros)} over ${f.calls} calls, ${pct(cachedShare)} of input tokens cached, ${f.reasoningTokens} reasoning tokens`,
      );
    }
  }
  if (metrics.demo) {
    lines.push(
      "",
      "These are demo numbers. Connect the database and billing so the digest reads real figures.",
    );
  }
  return {
    subject: `Curvi weekly metrics for ${metrics.month}`,
    text: lines.join("\n"),
  };
}

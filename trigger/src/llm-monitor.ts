/**
 * LLM cost and traffic monitoring (docs/phases/PHASE_17.md workstream 6).
 *
 * Every routed LLM attempt reaches LlmMonitor through the cost meter
 * (LlmMonitorMeter wraps the in memory meter the runtime already uses):
 *   * one structured log line per attempt (event llm_call) with the recipe,
 *     provider, cost and the token counts: uncached input, cached input,
 *     output and the reasoning tokens inside the output. Log search reads
 *     the per call distribution from it, for the p99 output budget of each
 *     recipe once OpenAI serves 100 percent (workstream 6 item 2);
 *   * running counters per UTC day, recipe and provider (calls, failures,
 *     spend, the four token counts) and per pack and provider family (LLM
 *     spend), kept in spend_cap_counters through PgCapStore.addMany so every
 *     task run and web instance adds to the same rows. llmSpendReport reads
 *     them back: LLM spend per provider for the cost reporting;
 *   * per UTC hour, the calls whose chain starts with OpenAI and how many of
 *     them Claude served. Above the seeded share (5 percent) the founder is
 *     alerted once that hour.
 *
 * The founder also hears, through the same Resend email, log line and
 * events row as the spend alerts (spend-alerts.ts), when OpenAI answers
 * provider_quota (onProviderQuota, once per family and hour), and on the
 * seeded credit expiry reminder days (2026-12-01 and 2026-12-24, founder
 * decision 4), checked on the first LLM call of each day.
 *
 * Every date, family and threshold comes from @curvi/pipeline/seed
 * (CLAUDE.md rule 2). Monitoring is best effort: nothing here throws into a
 * provider call, and a failed counter write is logged and skipped.
 */

import {
  InMemoryCostMeter,
  emptyLlmUsageTotals,
  llmProviderFamilyOf,
  type CapStore,
  type CostMeterEntry,
  type LlmUsageTotals,
  type ProviderQuotaInfo,
} from "@curvi/ai";
import { events, type Db } from "@curvi/db";
import {
  llmCreditWindows,
  llmFallbackAlertPolicy,
  llmModelProviders,
  llmQuotaAlertFamilies,
  type LlmCreditWindow,
  type LlmFallbackAlertPolicy,
} from "@curvi/pipeline/seed";
import type { FetchLike } from "./digest";
import { InMemoryAlertDedupe, sendFounderEmail, type AlertDedupe, type ReadEnv, type SpendAlertEmail } from "./spend-alerts";

/** Counter key parts are joined with this; provider names hold colons. */
const SEP = "|";
export const LLM_COUNTER_PREFIX = `llm${SEP}`;

/** The token and spend metrics kept per day, recipe and provider. */
export const LLM_DAY_METRICS = [
  "calls",
  "failed",
  "cost_micros",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
] as const;
export type LlmDayMetric = (typeof LLM_DAY_METRICS)[number];

export interface CounterDelta {
  key: string;
  delta: number;
}

/** Where the counters live: PgCapStore in production, in memory otherwise. */
export interface LlmCounterStore {
  /** Adds every delta and returns each key's new total. */
  addMany(deltas: ReadonlyArray<CounterDelta>): Promise<Map<string, number>>;
  /** Current totals of every key starting with prefix. */
  listByPrefix(prefix: string): Promise<Map<string, number>>;
}

export class InMemoryLlmCounterStore implements LlmCounterStore {
  readonly totals = new Map<string, number>();

  async addMany(deltas: ReadonlyArray<CounterDelta>): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const { key, delta } of deltas) {
      const next = (this.totals.get(key) ?? 0) + Math.round(delta);
      this.totals.set(key, next);
      result.set(key, next);
    }
    return result;
  }

  async listByPrefix(prefix: string): Promise<Map<string, number>> {
    return new Map([...this.totals].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)));
  }
}

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The UTC hour bucket, e.g. "2026-12-01T14". */
export function utcHour(at: Date): string {
  return at.toISOString().slice(0, 13);
}

export function llmDayKey(day: string, recipe: string, provider: string, metric: LlmDayMetric): string {
  return ["llm", "day", day, recipe, provider, metric].join(SEP);
}

export function llmJobKey(jobId: string, family: string): string {
  return ["llm", "job", jobId, family, "cost_micros"].join(SEP);
}

export function llmHourKey(hour: string, counter: "primary_calls" | "fallback_calls"): string {
  return ["llm", "hour", hour, counter].join(SEP);
}

const LLM_FAMILIES = new Set<string>(Object.values(llmModelProviders));

/** The LLM family of a metered attempt, or null for a non LLM call. An
 * attempt with token usage is an LLM call even from a test provider. */
export function llmFamilyOfEntry(entry: Pick<CostMeterEntry, "provider" | "usage">): string | null {
  const family = llmProviderFamilyOf(entry.provider);
  if (family !== null && LLM_FAMILIES.has(family)) return family;
  return entry.usage ? (family ?? "other") : null;
}

/** The counter deltas one metered LLM attempt adds. */
export function llmCounterDeltas(
  entry: CostMeterEntry,
  family: string,
  policy: LlmFallbackAlertPolicy = llmFallbackAlertPolicy,
): CounterDelta[] {
  const day = utcDay(entry.at);
  const metric = (name: LlmDayMetric, delta: number): CounterDelta => ({
    key: llmDayKey(day, entry.task, entry.provider, name),
    delta,
  });
  const deltas: CounterDelta[] = [metric("calls", 1)];
  const addIfAny = (name: LlmDayMetric, delta: number): void => {
    if (delta !== 0) deltas.push(metric(name, delta));
  };
  addIfAny("failed", entry.ok ? 0 : 1);
  addIfAny("cost_micros", entry.costMicros);
  if (entry.usage) {
    // Cached input is metered apart from uncached input, and the reasoning
    // tokens apart from the output they are part of.
    addIfAny("input_tokens", entry.usage.inputTokens);
    addIfAny("cached_input_tokens", entry.usage.cachedInputTokens);
    addIfAny("output_tokens", entry.usage.outputTokens);
    addIfAny("reasoning_tokens", entry.usage.reasoningTokens);
  }
  if (entry.jobId && entry.costMicros > 0) {
    deltas.push({ key: llmJobKey(entry.jobId, family), delta: entry.costMicros });
  }
  // Fallback traffic: answered calls whose chain starts with the primary
  // family, and those of them the fallback family served. The fallback
  // counter is touched (by 0 or 1) on every such call, so the new totals of
  // both come back and the share is checked on each one.
  const primaryFamily = entry.primaryProvider ? llmProviderFamilyOf(entry.primaryProvider) : null;
  if (entry.ok && primaryFamily === policy.primaryFamily) {
    const hour = utcHour(entry.at);
    deltas.push(
      { key: llmHourKey(hour, "primary_calls"), delta: 1 },
      { key: llmHourKey(hour, "fallback_calls"), delta: family === policy.fallbackFamily ? 1 : 0 },
    );
  }
  return deltas;
}

/** True when an hour's fallback share is past the policy line. */
export function fallbackShareExceeded(
  primaryCalls: number,
  fallbackCalls: number,
  policy: LlmFallbackAlertPolicy = llmFallbackAlertPolicy,
): boolean {
  return primaryCalls >= policy.minCallsPerHour && fallbackCalls / primaryCalls > policy.maxFallbackShare;
}

/** The reminder due on day for a credit window: the latest reminder date on
 * or before day, while the credits have not expired. */
export function dueCreditReminder(window: LlmCreditWindow, day: string): string | null {
  if (day > window.expiresOn) return null;
  let due: string | null = null;
  for (const reminder of window.reminderDates) {
    if (reminder <= day) due = reminder;
  }
  return due;
}

/** Whole days from day until the end of expiresOn (0 on the last day). */
export function daysUntil(day: string, expiresOn: string): number {
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}

/** "today", "in 1 day" or "in N days". */
export function inDaysText(days: number): string {
  if (days <= 0) return "today";
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

// ---------------------------------------------------------------------------
// Founder alerts

export type LlmAlertKind = "llm_quota" | "llm_fallback" | "llm_credit_expiry";

export const LLM_ALERT_EVENT_NAMES: Record<LlmAlertKind, string> = {
  llm_quota: "llm_provider_quota_alert",
  llm_fallback: "llm_fallback_alert",
  llm_credit_expiry: "llm_credit_expiry_reminder",
};

const FAMILY_NAMES: Record<string, string> = { openai: "OpenAI", anthropic: "Claude" };

function familyName(family: string): string {
  return FAMILY_NAMES[family] ?? family;
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)} percent`;
}

export function composeQuotaAlert(family: string, info: ProviderQuotaInfo, hour: string): SpendAlertEmail {
  const name = familyName(family);
  return {
    subject: `Curvi: ${name} says the account is out of quota or credit`,
    text: [
      `${name} answered that the account is out of quota or credit (${info.provider}, recipe ${info.task}) in the hour starting ${hour}:00 UTC.`,
      "",
      `Its breaker is open, so packs skip ${name} and run on the next model in each chain, ending with Claude.`,
      `Check the ${name} credit balance and spend limits. Every recipe goes back to ${name} on its own once the breaker closes.`,
    ].join("\n"),
  };
}

export function composeFallbackAlert(
  hour: string,
  primaryCalls: number,
  fallbackCalls: number,
  policy: LlmFallbackAlertPolicy = llmFallbackAlertPolicy,
): SpendAlertEmail {
  const primary = familyName(policy.primaryFamily);
  const fallback = familyName(policy.fallbackFamily);
  return {
    subject: `Curvi: ${fallback} served ${pct(fallbackCalls / primaryCalls)} of ${primary} calls this hour`,
    text: [
      `In the hour starting ${hour}:00 UTC, ${fallbackCalls} of ${primaryCalls} LLM calls that start on ${primary} were served by ${fallback}, above the alert line of ${pct(policy.maxFallbackShare)}.`,
      "",
      `Packs keep running on ${fallback}. Look for ${primary} quota, rate limit or outage errors in the llm_call and provider_quota_exhausted logs.`,
    ].join("\n"),
  };
}

export function composeCreditExpiryReminder(window: LlmCreditWindow, day: string): SpendAlertEmail {
  const name = familyName(window.family);
  const days = daysUntil(day, window.expiresOn);
  return {
    subject: `Curvi: the ${name} credits expire on ${window.expiresOn}`,
    text: [
      `The ${name} credits expire on ${window.expiresOn}, ${inDaysText(days)}.`,
      "",
      `Decide before then whether to keep ${name} on paid usage or make Claude the primary model again.`,
      "Making Claude primary is one recipe row per stage, as in the rollback steps of docs/phases/PHASE_17.md workstream 5.",
    ].join("\n"),
  };
}

/** How long after a failed founder email the same alert is tried again. */
export const LLM_ALERT_RETRY_MS = 15 * 60_000;

export interface LlmAlertNotifierOptions {
  /** Records the events row; absent in envless demo runs. */
  db?: Pick<Db, "insert"> | null;
  dedupe?: AlertDedupe;
  readEnv?: ReadEnv;
  fetchImpl?: FetchLike;
  log?: Pick<Console, "error" | "warn">;
  now?: () => Date;
  /** Wait before a failed send is tried again. Default LLM_ALERT_RETRY_MS. */
  retryAfterMs?: number;
}

export interface LlmAlertResult {
  kind: LlmAlertKind;
  /** True when this alert already went out for its period. */
  deduped: boolean;
  delivered: "email" | "log" | null;
  eventRecorded: boolean;
  /** True when the email could not be sent for now: the claim was given
   * back, so a later call tries again after the retry wait. */
  retryScheduled?: boolean;
}

/** Sends each founder alert once per dedupe key: by email when Resend is
 * set up, else as a structured error log line, and always as an events row
 * when a database is wired. A send that fails for a reason that may pass
 * (Resend down, slow or rate limiting) gives its claim back, so a later
 * call tries again after the retry wait. Never throws. */
export class LlmAlertNotifier {
  private readonly claimedHere = new Set<string>();
  /** Keys whose send failed, with the earliest time to try again. */
  private readonly retryAt = new Map<string, number>();
  private readonly dedupe: AlertDedupe;
  private readonly log: Pick<Console, "error" | "warn">;

  constructor(private readonly opts: LlmAlertNotifierOptions = {}) {
    this.dedupe = opts.dedupe ?? new InMemoryAlertDedupe();
    this.log = opts.log ?? console;
  }

  /** True when this process already claimed the key (no store read needed). */
  claimedInProcess(kind: LlmAlertKind, period: string): boolean {
    return this.claimedHere.has(`alerts:${kind}:${period}`);
  }

  async notify(
    kind: LlmAlertKind,
    period: string,
    email: SpendAlertEmail,
    props: Record<string, unknown>,
  ): Promise<LlmAlertResult> {
    const key = `alerts:${kind}:${period}`;
    const result: LlmAlertResult = { kind, deduped: true, delivered: null, eventRecorded: false };
    if (this.claimedHere.has(key)) {
      return result;
    }
    const nowMs = (this.opts.now?.() ?? new Date()).getTime();
    const retryAt = this.retryAt.get(key);
    if (retryAt !== undefined && nowMs < retryAt) {
      return result;
    }
    this.claimedHere.add(key);
    let claimed = true;
    try {
      claimed = await this.dedupe.claim(key);
    } catch (err) {
      // Better a second alert than none.
      this.logJson("llm_alert_dedupe_failed", { kind, period, error: errorText(err) });
    }
    if (!claimed) {
      return result;
    }
    result.deduped = false;

    const sent = await sendFounderEmail(email, { readEnv: this.opts.readEnv, fetchImpl: this.opts.fetchImpl });
    this.retryAt.delete(key);
    if (sent.ok) {
      result.delivered = "email";
      this.log.warn(JSON.stringify({ level: "warn", event: LLM_ALERT_EVENT_NAMES[kind], period, ...props, delivered: "email" }));
    } else {
      result.delivered = "log";
      this.logJson(LLM_ALERT_EVENT_NAMES[kind], {
        period,
        ...props,
        subject: email.subject,
        message: email.text,
        notice: sent.notice,
        ...(sent.retryable ? { retryInMs: this.opts.retryAfterMs ?? LLM_ALERT_RETRY_MS } : {}),
      });
      if (sent.retryable) {
        // Give the claim back, here and in the shared store, so the reminder
        // or alert is not used up by a Resend outage.
        this.claimedHere.delete(key);
        this.retryAt.set(key, nowMs + (this.opts.retryAfterMs ?? LLM_ALERT_RETRY_MS));
        result.retryScheduled = true;
        try {
          await this.dedupe.release?.(key);
        } catch (err) {
          this.logJson("llm_alert_release_failed", { kind, period, error: errorText(err) });
        }
      }
    }
    if (this.opts.db) {
      try {
        await this.opts.db.insert(events).values({
          workspaceId: null,
          name: LLM_ALERT_EVENT_NAMES[kind],
          props: { period, ...props, delivered: result.delivered },
        });
        result.eventRecorded = true;
      } catch (err) {
        this.logJson("llm_alert_event_failed", { kind, period, error: errorText(err) });
      }
    }
    return result;
  }

  private logJson(event: string, fields: Record<string, unknown>): void {
    this.log.error(JSON.stringify({ level: "error", event, ...fields }));
  }
}

// ---------------------------------------------------------------------------
// The monitor

export interface LlmMonitorOptions {
  /** Shared counters; in memory when absent. */
  store?: LlmCounterStore;
  alerts?: LlmAlertNotifier;
  policy?: LlmFallbackAlertPolicy;
  creditWindows?: readonly LlmCreditWindow[];
  quotaFamilies?: readonly string[];
  now?: () => Date;
  log?: Pick<Console, "info" | "error">;
}

export class LlmMonitor {
  readonly store: LlmCounterStore;
  readonly alerts: LlmAlertNotifier;
  private readonly policy: LlmFallbackAlertPolicy;
  private readonly creditWindows: readonly LlmCreditWindow[];
  private readonly quotaFamilies: ReadonlySet<string>;
  private readonly log: Pick<Console, "info" | "error">;
  /** Days whose credit reminders this process already checked. */
  private readonly creditCheckedDays = new Set<string>();
  /** Background observations and alerts not yet settled. */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly opts: LlmMonitorOptions = {}) {
    this.store = opts.store ?? new InMemoryLlmCounterStore();
    this.alerts = opts.alerts ?? new LlmAlertNotifier();
    this.policy = opts.policy ?? llmFallbackAlertPolicy;
    this.creditWindows = opts.creditWindows ?? llmCreditWindows;
    this.quotaFamilies = new Set(opts.quotaFamilies ?? llmQuotaAlertFamilies);
    this.log = opts.log ?? console;
  }

  /** Called for every metered attempt; does nothing for a non LLM call. Never throws. */
  async observe(entry: CostMeterEntry): Promise<void> {
    const family = llmFamilyOfEntry(entry);
    if (family === null) return;
    this.logCall(entry, family);
    try {
      const totals = await this.store.addMany(llmCounterDeltas(entry, family, this.policy));
      await this.checkFallbackShare(utcHour(entry.at), totals);
    } catch (err) {
      this.log.error(JSON.stringify({ level: "error", event: "llm_counters_failed", error: errorText(err) }));
    }
    await this.checkCreditExpiry(this.opts.now?.() ?? entry.at);
  }

  /**
   * Runs work off the provider call path: the counter upsert and the
   * founder email must never hold a seller's call, least of all the quota
   * failover to Claude. Errors are logged; flush() waits for the rest.
   */
  track(work: Promise<unknown>): void {
    const tracked = work.catch((err: unknown) => {
      this.log.error(JSON.stringify({ level: "error", event: "llm_monitor_failed", error: errorText(err) }));
    });
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  /** Waits for background observations and alerts, for tests and shutdown. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** AiDeps.onProviderQuota in the runtime: the quota alert in the background. */
  readonly onProviderQuotaInBackground = (info: ProviderQuotaInfo): void => {
    this.track(this.onProviderQuota(info));
  };

  /** AiDeps.onProviderQuota: alerts the founder when a watched family
   * (OpenAI) answers provider_quota, once per family and UTC hour. */
  readonly onProviderQuota = async (info: ProviderQuotaInfo): Promise<void> => {
    const family = llmProviderFamilyOf(info.provider);
    if (family === null || !this.quotaFamilies.has(family)) return;
    const hour = utcHour(this.opts.now?.() ?? new Date());
    await this.alerts.notify("llm_quota", `${family}:${hour}`, composeQuotaAlert(family, info, hour), {
      family,
      provider: info.provider,
      task: info.task,
      hour,
    });
  };

  /** Sends the credit expiry reminder due today, at most once per reminder date. */
  async checkCreditExpiry(at: Date): Promise<void> {
    const day = utcDay(at);
    if (this.creditCheckedDays.has(day)) return;
    this.creditCheckedDays.add(day);
    for (const window of this.creditWindows) {
      const reminder = dueCreditReminder(window, day);
      if (reminder === null) continue;
      const period = `${window.family}:${reminder}`;
      await this.alerts.notify(
        "llm_credit_expiry",
        period,
        composeCreditExpiryReminder(window, day),
        { family: window.family, expiresOn: window.expiresOn, reminder, day, daysLeft: daysUntil(day, window.expiresOn) },
      );
      // A reminder whose send failed for now gave its claim back: check
      // again on a later call today (the notifier spaces the retries).
      if (!this.alerts.claimedInProcess("llm_credit_expiry", period)) {
        this.creditCheckedDays.delete(day);
      }
    }
  }

  private async checkFallbackShare(hour: string, totals: Map<string, number>): Promise<void> {
    const primaryCalls = totals.get(llmHourKey(hour, "primary_calls"));
    const fallbackCalls = totals.get(llmHourKey(hour, "fallback_calls"));
    // Absent when this call did not start on the primary family.
    if (primaryCalls === undefined || fallbackCalls === undefined) return;
    if (!fallbackShareExceeded(primaryCalls, fallbackCalls, this.policy)) return;
    if (this.alerts.claimedInProcess("llm_fallback", hour)) return;
    await this.alerts.notify("llm_fallback", hour, composeFallbackAlert(hour, primaryCalls, fallbackCalls, this.policy), {
      hour,
      primaryCalls,
      fallbackCalls,
      share: fallbackCalls / primaryCalls,
    });
  }

  private logCall(entry: CostMeterEntry, family: string): void {
    this.log.info(
      JSON.stringify({
        level: "info",
        event: "llm_call",
        recipe: entry.task,
        provider: entry.provider,
        family,
        ok: entry.ok,
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        attempt: entry.attempt,
        fallback: entry.primaryProvider !== undefined && entry.primaryProvider !== entry.provider,
        costMicros: entry.costMicros,
        latencyMs: entry.latencyMs,
        inputTokens: entry.usage?.inputTokens ?? null,
        cachedInputTokens: entry.usage?.cachedInputTokens ?? null,
        outputTokens: entry.usage?.outputTokens ?? null,
        reasoningTokens: entry.usage?.reasoningTokens ?? null,
        jobId: entry.jobId,
      }),
    );
  }
}

/** The runtime's cost meter: the in memory meter plus the LLM monitor,
 * which runs in the background (LlmMonitor.track), so the router's await
 * on record never waits on Postgres or Resend. */
export class LlmMonitorMeter extends InMemoryCostMeter {
  constructor(readonly monitor: LlmMonitor) {
    super();
  }

  override async record(entry: CostMeterEntry): Promise<void> {
    super.record(entry);
    this.monitor.track(this.monitor.observe(entry));
  }
}

/** PgCapStore and the in memory store both serve as counter stores. */
export function llmCounterStoreFrom(store: CapStore | LlmCounterStore | undefined): LlmCounterStore | undefined {
  if (!store) return undefined;
  if ("addMany" in store && "listByPrefix" in store) return store;
  return undefined;
}

const monitorScope = globalThis as typeof globalThis & { __curviLlmMonitor?: LlmMonitor };

/** The process wide monitor without a database: in memory counters, alerts
 * by log line only. The db runtime builds its own with the shared store. */
export function processLlmMonitor(): LlmMonitor {
  monitorScope.__curviLlmMonitor ??= new LlmMonitor();
  return monitorScope.__curviLlmMonitor;
}

// ---------------------------------------------------------------------------
// The cost report

export interface LlmRecipeSpend extends LlmUsageTotals {
  day: string;
  recipe: string;
  provider: string;
  family: string;
  failed: number;
}

export interface LlmSpendReport {
  days: string[];
  /** LLM spend and tokens per provider family over the days. */
  byFamily: Record<string, LlmUsageTotals & { failed: number }>;
  /** One row per day, recipe and provider. */
  rows: LlmRecipeSpend[];
  totalMicros: number;
}

/** The last n UTC days ending with at, oldest first. */
export function lastUtcDays(at: Date, n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    days.push(utcDay(new Date(at.getTime() - i * 86_400_000)));
  }
  return days;
}

const METRIC_FIELDS: Record<LlmDayMetric, keyof LlmUsageTotals | "failed"> = {
  calls: "calls",
  failed: "failed",
  cost_micros: "costMicros",
  input_tokens: "inputTokens",
  cached_input_tokens: "cachedInputTokens",
  output_tokens: "outputTokens",
  reasoning_tokens: "reasoningTokens",
};

/** Builds the report from day counters (keys from llmDayKey). */
export function llmSpendReportFromCounters(counters: ReadonlyMap<string, number>, days: readonly string[]): LlmSpendReport {
  const wanted = new Set(days);
  const rows = new Map<string, LlmRecipeSpend>();
  for (const [key, value] of counters) {
    const parts = key.split(SEP);
    if (parts.length !== 6 || parts[0] !== "llm" || parts[1] !== "day") continue;
    const [, , day, recipe, provider, metric] = parts;
    if (!wanted.has(day) || !Object.hasOwn(METRIC_FIELDS, metric)) continue;
    const rowKey = [day, recipe, provider].join(SEP);
    let row = rows.get(rowKey);
    if (!row) {
      row = { day, recipe, provider, family: llmProviderFamilyOf(provider) ?? "other", failed: 0, ...emptyLlmUsageTotals() };
      rows.set(rowKey, row);
    }
    row[METRIC_FIELDS[metric as LlmDayMetric]] += value;
  }
  const byFamily: LlmSpendReport["byFamily"] = {};
  let totalMicros = 0;
  for (const row of rows.values()) {
    const family = (byFamily[row.family] ??= { failed: 0, ...emptyLlmUsageTotals() });
    family.failed += row.failed;
    for (const field of ["calls", "costMicros", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"] as const) {
      family[field] += row[field];
    }
    totalMicros += row.costMicros;
  }
  const sorted = [...rows.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.recipe.localeCompare(b.recipe) || a.provider.localeCompare(b.provider),
  );
  return { days: [...days], byFamily, rows: sorted, totalMicros };
}

/** LLM spend per provider for the given UTC days, from the shared counters. */
export async function llmSpendReport(store: Pick<LlmCounterStore, "listByPrefix">, days: readonly string[]): Promise<LlmSpendReport> {
  const counters = new Map<string, number>();
  for (const day of new Set(days)) {
    for (const [key, value] of await store.listByPrefix(`llm${SEP}day${SEP}${day}${SEP}`)) {
      counters.set(key, value);
    }
  }
  return llmSpendReportFromCounters(counters, days);
}

/** One pack's LLM spend per provider family, in USD micros. */
export async function packLlmSpend(
  store: Pick<LlmCounterStore, "listByPrefix">,
  jobId: string,
): Promise<Record<string, number>> {
  const spend: Record<string, number> = {};
  for (const [key, value] of await store.listByPrefix(`llm${SEP}job${SEP}${jobId}${SEP}`)) {
    const family = key.split(SEP)[3];
    if (family) spend[family] = (spend[family] ?? 0) + value;
  }
  return spend;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

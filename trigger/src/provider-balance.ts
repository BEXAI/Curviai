/**
 * fal balance probe, low balance alerts and the acquisition pause email
 * (docs/phases/PHASE_18.md P18-03, founder decision 8).
 *
 * Every white main image needs a fal cutout, so an empty fal balance pauses
 * most packs. POST /api/cron/provider-balance (on the stale-jobs cron
 * command, every 10 to 15 minutes) calls checkFalBalances, which for each
 * seeded account whose Admin API key is set:
 *   * reads the balance through probeFalBalance (packages/ai, one GET, a
 *     hard timeout, no retry, the key never logged);
 *   * stores the newest reading in platform_settings under
 *     fal_balance:<provider>, which the acquisition gate and the health
 *     details read (a failed read keeps the last good balance and its time);
 *   * writes an events row provider_balance at most once per
 *     eventEveryMinutes per account (the history);
 *   * emails the founder once per UTC day per account below the alert line,
 *     and at once (still once per UTC day) below the pause line.
 *
 * Founder email goes through sendFounderEmail (Resend, spend-alerts.ts) and
 * FounderAlerts, which claims one key per alert in a shared AlertDedupe
 * (PgCapStore in production) and gives the claim back when a send fails
 * for a reason that may pass. Email is not an AI provider, so it keeps its
 * plain fetch path (PHASE_18 principle 3). Every line and limit comes from
 * @curvi/pipeline/seed (CLAUDE.md rule 2). Nothing here throws.
 */

import { probeFalBalance, type FalBalanceResult } from "@curvi/ai";
import { events, sql, type Db } from "@curvi/db";
import {
  falBalanceAccounts,
  falBalanceLines,
  falBalanceProbePolicy,
  type FalBalanceAccount,
  type FalBalanceLines,
  type FalBalanceProbePolicy,
} from "@curvi/pipeline/seed";
import type { FetchLike } from "./email-transport";
import { InMemoryAlertDedupe, sendFounderEmail, type AlertDedupe, type ReadEnv, type SpendAlertEmail } from "./spend-alerts";

export const PROVIDER_BALANCE_EVENT = "provider_balance";
export const FAL_BALANCE_SETTING_PREFIX = "fal_balance:";

/** Where a balance sits against the seeded lines. */
export type FalBalanceBand = "ok" | "alert" | "pause" | "unknown";

export function falBalanceBand(balanceUsd: number | null | undefined, lines: FalBalanceLines = falBalanceLines): FalBalanceBand {
  if (typeof balanceUsd !== "number" || !Number.isFinite(balanceUsd)) return "unknown";
  if (balanceUsd < lines.pauseUsd) return "pause";
  if (balanceUsd < lines.alertUsd) return "alert";
  return "ok";
}

export function falBalanceSettingKey(provider: string): string {
  return `${FAL_BALANCE_SETTING_PREFIX}${provider}`;
}

/** The newest reading of one account, as platform_settings holds it. */
export interface StoredFalBalance {
  provider: string;
  /** When the probe last ran (ISO). */
  checkedAt: string | null;
  /** Whether that probe read a balance. */
  ok: boolean;
  status: number | null;
  /** The last balance read successfully, kept through a failed probe. */
  balanceUsd: number | null;
  currency: string | null;
  /** When balanceUsd was read (ISO). */
  balanceAt: string | null;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function dollarsText(amount: number): string {
  return usd.format(amount);
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readEnvDefault(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** postgres-js returns the rows array; PGlite (tests) returns { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

// ---------------------------------------------------------------------------
// Founder alerts

export type FounderAlertOutcome = "email" | "log" | "deduped";

export interface FounderAlertsOptions {
  /** Shared claims (PgCapStore in production); in memory otherwise. */
  dedupe?: AlertDedupe;
  readEnv?: ReadEnv;
  fetchImpl?: FetchLike;
  log?: Pick<Console, "warn" | "error">;
}

/**
 * One founder email per key: the first caller to claim the key sends it,
 * by Resend when RESEND_API_KEY and FOUNDER_ALERT_EMAIL are set, otherwise
 * as a structured error log line. A send that may work later (Resend down,
 * 429, 5xx) gives the claim back so a later call tries again. Never throws.
 */
export class FounderAlerts {
  private readonly dedupe: AlertDedupe;
  private readonly log: Pick<Console, "warn" | "error">;

  constructor(private readonly opts: FounderAlertsOptions = {}) {
    this.dedupe = opts.dedupe ?? new InMemoryAlertDedupe();
    this.log = opts.log ?? console;
  }

  async send(key: string, event: string, email: SpendAlertEmail, fields: Record<string, unknown> = {}): Promise<FounderAlertOutcome> {
    let claimed = true;
    try {
      claimed = await this.dedupe.claim(key);
    } catch (err) {
      // Better a second email than none.
      this.log.error(JSON.stringify({ level: "error", event: "founder_alert_dedupe_failed", key, error: errorText(err) }));
    }
    if (!claimed) return "deduped";
    const sent = await sendFounderEmail(email, { readEnv: this.opts.readEnv ?? readEnvDefault, fetchImpl: this.opts.fetchImpl });
    if (sent.ok) {
      this.log.warn(JSON.stringify({ level: "warn", event, ...fields, delivered: "email" }));
      return "email";
    }
    this.log.error(
      JSON.stringify({ level: "error", event, ...fields, subject: email.subject, message: email.text, notice: sent.notice }),
    );
    if (sent.retryable) {
      try {
        await this.dedupe.release?.(key);
      } catch (err) {
        this.log.error(JSON.stringify({ level: "error", event: "founder_alert_release_failed", key, error: errorText(err) }));
      }
    }
    return "log";
  }
}

// ---------------------------------------------------------------------------
// Emails. Plain spoken, no dashes used as punctuation (CLAUDE.md rule 9).

/** The manual step for ads: no campaign pause API was found (docs/verification.md). */
export const PAUSE_ADS_LINE = "If a ChatGPT ads campaign is running, pause it in Ads Manager. Curvi cannot pause it for you.";

export function composeFalBalanceEmail(
  account: Pick<FalBalanceAccount, "provider" | "keyEnv">,
  balanceUsd: number,
  band: "alert" | "pause",
  lines: FalBalanceLines = falBalanceLines,
): SpendAlertEmail {
  const amount = dollarsText(balanceUsd);
  const text = [
    `The fal account behind ${account.keyEnv} (${account.provider}) has ${amount} left, below the alert line of ${dollarsText(lines.alertUsd)}.`,
    "",
    "Every white main image needs a fal cutout, so packs pause when the balance runs out. Top up at fal.ai to keep packs running.",
  ];
  if (band === "pause") {
    text.push(
      "",
      `This is also below the pause line of ${dollarsText(lines.pauseUsd)}. While every cutout account is below it, the Start free buttons on the site offer a waitlist instead, and /signup shows a notice. The free checkers still work.`,
      PAUSE_ADS_LINE,
    );
  }
  return { subject: `Curvi: the fal balance is low (${amount} left)`, text: text.join("\n") };
}

/** Why the gate paused acquisition, for the founder email. */
export type AcquisitionPauseReason = "packs_paused" | "fal_balance";

export function composeAcquisitionPausedEmail(reason: AcquisitionPauseReason): SpendAlertEmail {
  const why =
    reason === "fal_balance"
      ? `Every configured fal account is below the pause line of ${dollarsText(falBalanceLines.pauseUsd)}.`
      : "Every configured background removal account is unavailable (out of credit or failing), so packs that need a cutout cannot start.";
  return {
    subject: "Curvi: acquisition is paused because packs cannot run",
    text: [
      why,
      "",
      "The Start free buttons on the site now offer a waitlist (lead source packs-paused), and /signup shows a notice and stays open. The free checkers still work.",
      PAUSE_ADS_LINE,
      "Acquisition opens again on its own once packs can run. Top up fal.ai or check /api/health for the cause.",
    ].join("\n"),
  };
}

/** Sends the acquisition paused email at most once per UTC day and reason. */
export async function notifyAcquisitionPaused(
  reason: AcquisitionPauseReason,
  alerts: FounderAlerts,
  now: Date = new Date(),
): Promise<FounderAlertOutcome> {
  return alerts.send(`alerts:acquisition_paused:${reason}:${utcDay(now)}`, "acquisition_paused_alert", composeAcquisitionPausedEmail(reason), {
    reason,
  });
}

// ---------------------------------------------------------------------------
// The balance check

export interface FalBalanceReport {
  provider: string;
  adminKeyEnv: string;
  /** True when the admin key is set, so the account was probed. */
  probed: boolean;
  /** True when the account's inference key (FAL_KEY or FAL_KEY_BACKUP) is set. */
  keyConfigured: boolean;
  ok: boolean;
  status: number | null;
  balanceUsd: number | null;
  currency: string | null;
  band: FalBalanceBand;
  /** The founder email this run sent or logged for the account. */
  alert: "low" | "pause" | null;
  eventRecorded: boolean;
  error?: string;
}

export interface FalBalanceCheckDeps {
  /** Stores the reading and the events row; absent in envless demo runs. */
  db?: Pick<Db, "insert" | "execute"> | null;
  /** Claims for the hourly events row (PgCapStore in production). */
  dedupe?: AlertDedupe;
  alerts?: FounderAlerts;
  readEnv?: ReadEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  accounts?: readonly FalBalanceAccount[];
  lines?: FalBalanceLines;
  policy?: FalBalanceProbePolicy;
  /** Swapped in tests. */
  probe?: typeof probeFalBalance;
  log?: Pick<Console, "warn" | "error">;
}

/** Upserts the reading; a failed probe keeps the last good balance. */
async function storeReading(
  db: Pick<Db, "execute">,
  provider: string,
  result: FalBalanceResult,
  at: Date,
): Promise<void> {
  const iso = at.toISOString();
  const value: Record<string, unknown> = { provider, checkedAt: iso, ok: result.ok, status: result.status };
  if (result.ok) {
    value.balanceUsd = result.balanceUsd;
    value.currency = result.currency;
    value.balanceAt = iso;
  }
  await db.execute(sql`
    insert into platform_settings (key, value, updated_at)
    values (${falBalanceSettingKey(provider)}, ${JSON.stringify(value)}::jsonb, ${iso}::timestamptz)
    on conflict (key) do update
      set value = platform_settings.value || excluded.value, updated_at = excluded.updated_at
  `);
}

/** Probes every account whose admin key is set. Never throws. */
export async function checkFalBalances(deps: FalBalanceCheckDeps = {}): Promise<FalBalanceReport[]> {
  const readEnv = deps.readEnv ?? readEnvDefault;
  const now = (deps.now ?? (() => new Date()))();
  const lines = deps.lines ?? falBalanceLines;
  const policy = deps.policy ?? falBalanceProbePolicy;
  const probe = deps.probe ?? probeFalBalance;
  const log = deps.log ?? console;
  const dedupe = deps.dedupe ?? new InMemoryAlertDedupe();
  const alerts = deps.alerts ?? new FounderAlerts({ dedupe, readEnv, fetchImpl: deps.fetchImpl, log });
  const bucket = Math.floor(now.getTime() / (policy.eventEveryMinutes * 60_000));

  const reports: FalBalanceReport[] = [];
  for (const account of deps.accounts ?? falBalanceAccounts) {
    const adminKey = readEnv(account.adminKeyEnv);
    const base = {
      provider: account.provider,
      adminKeyEnv: account.adminKeyEnv,
      keyConfigured: Boolean(readEnv(account.keyEnv)),
      alert: null,
      eventRecorded: false,
    } as const;
    if (!adminKey) {
      reports.push({ ...base, probed: false, ok: false, status: null, balanceUsd: null, currency: null, band: "unknown" });
      continue;
    }
    const result = await probe({ adminKey, timeoutMs: policy.timeoutMs, fetchImpl: deps.fetchImpl });
    const band = result.ok ? falBalanceBand(result.balanceUsd, lines) : "unknown";
    const report: FalBalanceReport = {
      ...base,
      probed: true,
      ok: result.ok,
      status: result.status,
      balanceUsd: result.balanceUsd,
      currency: result.currency,
      band,
      ...(result.error ? { error: result.error } : {}),
    };

    if (deps.db) {
      try {
        await storeReading(deps.db, account.provider, result, now);
      } catch (err) {
        log.error(JSON.stringify({ level: "error", event: "fal_balance_store_failed", provider: account.provider, error: errorText(err) }));
      }
      let claimEvent = true;
      try {
        claimEvent = await dedupe.claim(`events:${PROVIDER_BALANCE_EVENT}:${account.provider}:${bucket}`);
      } catch {
        claimEvent = true;
      }
      if (claimEvent) {
        try {
          await deps.db.insert(events).values({
            workspaceId: null,
            name: PROVIDER_BALANCE_EVENT,
            props: {
              provider: account.provider,
              ok: result.ok,
              status: result.status,
              balanceUsd: result.balanceUsd,
              currency: result.currency,
              band,
            },
            at: now,
          });
          report.eventRecorded = true;
        } catch (err) {
          log.error(JSON.stringify({ level: "error", event: "fal_balance_event_failed", provider: account.provider, error: errorText(err) }));
        }
      }
    }

    if ((band === "alert" || band === "pause") && result.balanceUsd !== null) {
      const kind = band === "pause" ? "pause" : "low";
      const outcome = await alerts.send(
        `alerts:fal_balance_${kind}:${account.provider}:${utcDay(now)}`,
        band === "pause" ? "fal_balance_pause_alert" : "fal_balance_low_alert",
        composeFalBalanceEmail(account, result.balanceUsd, band, lines),
        { provider: account.provider, balanceUsd: result.balanceUsd, band },
      );
      if (outcome !== "deduped") report.alert = kind;
    }
    reports.push(report);
  }
  return reports;
}

/** The stored reading of every account, keyed by provider. Throws on a
 * failed read; callers decide what a failure means. */
export async function readFalBalances(db: Pick<Db, "execute">): Promise<Map<string, StoredFalBalance>> {
  const rows = rowsOf<{ key: string; value: unknown }>(
    await db.execute(
      sql`select key, value from platform_settings where key like ${`${FAL_BALANCE_SETTING_PREFIX}%`}`,
    ),
  );
  const out = new Map<string, StoredFalBalance>();
  for (const row of rows) {
    const provider = row.key.slice(FAL_BALANCE_SETTING_PREFIX.length);
    const value = (typeof row.value === "string" ? (JSON.parse(row.value) as unknown) : row.value) as Record<string, unknown> | null;
    if (!provider || !value || typeof value !== "object") continue;
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.set(provider, {
      provider,
      checkedAt: text(value.checkedAt),
      ok: value.ok === true,
      status: num(value.status),
      balanceUsd: num(value.balanceUsd),
      currency: text(value.currency),
      balanceAt: text(value.balanceAt),
    });
  }
  return out;
}

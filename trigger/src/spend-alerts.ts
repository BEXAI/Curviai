/**
 * Founder spend alerts (plan 4.4.3 and section 8, "Spend alerts"): when global
 * provider spend for the UTC day passes the $50 alert line, and when the $150
 * hard stop starts refusing provider calls, the founder hears about it once
 * per day each:
 *   * an email through the Resend REST API when RESEND_API_KEY and
 *     FOUNDER_ALERT_EMAIL are set (FOUNDER_ALERT_FROM overrides the sender);
 *   * otherwise, or when the send fails, a structured console error that log
 *     search and alerting can match on;
 *   * always an events row (provider_spend_alert or provider_spend_hard_stop,
 *     no workspace) so the history stays queryable.
 * Deduplication claims one key per kind and day through an AlertDedupe; the
 * db runtime uses PgCapStore, so every task run and web instance shares it.
 *
 * The runner reports the alert through PipelineDeps.onSpendAlert. The hard
 * stop is observed on the SpendCaps instance itself (watchGlobalSpend), since
 * a refused reservation surfaces to the runner only as a needs review shot.
 * The dollar lines come from SPEND_CAPS in @curvi/ai, the single home of the
 * cap amounts, and the DAILY_SPEND_HARD_STOP_USD override.
 */

import { SPEND_CAPS, type CapReservation, type SpendCaps } from "@curvi/ai";
import { events, type Db } from "@curvi/db";
import { RESEND_EMAILS_URL, type FetchLike } from "./digest";

export type SpendAlertKind = "spend_alert" | "hard_stop";

export type ReadEnv = (name: string) => string | undefined;

/** One time claims per key. */
export interface AlertDedupe {
  /** True for the first caller to claim the key, false for every later one. */
  claim(key: string): Promise<boolean>;
}

export class InMemoryAlertDedupe implements AlertDedupe {
  private readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) {
      return false;
    }
    this.claimed.add(key);
    return true;
  }
}

export interface SpendAlertNotifierOptions {
  /** Records the events row; null or absent in envless demo runs. */
  db?: Db | null;
  dedupe?: AlertDedupe;
  readEnv?: ReadEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: Pick<Console, "error" | "warn">;
}

export interface SpendAlertResult {
  kind: SpendAlertKind;
  day: string;
  /** True when this kind already went out today; nothing else happened. */
  deduped: boolean;
  delivered: "email" | "log" | null;
  eventRecorded: boolean;
  notice?: string;
}

export const EVENT_NAMES: Record<SpendAlertKind, string> = {
  spend_alert: "provider_spend_alert",
  hard_stop: "provider_spend_hard_stop",
};

export const DEFAULT_ALERT_FROM = "Curvi Alerts <alerts@curvi.ai>";

function readEnvDefault(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function dollars(micros: number): string {
  return usd.format(micros / 1_000_000);
}

/** The hard stop in force: the founder's DAILY_SPEND_HARD_STOP_USD raise, or
 * the platform default. Mirrors the parse in runtime.ts buildRuntimeDeps. */
export function hardStopMicros(readEnv: ReadEnv = readEnvDefault): number {
  const raised = Number(readEnv("DAILY_SPEND_HARD_STOP_USD") ?? "");
  return Number.isFinite(raised) && raised > 0 ? Math.round(raised * 1_000_000) : SPEND_CAPS.globalDailyHardStopMicros;
}

export interface SpendAlertEmail {
  subject: string;
  text: string;
}

export function composeSpendAlert(
  kind: SpendAlertKind,
  totalMicros: number,
  day: string,
  stopMicros: number,
): SpendAlertEmail {
  if (kind === "hard_stop") {
    return {
      subject: `Curvi provider spend hit the daily hard stop on ${day}`,
      text: [
        `Provider spend for ${day} (UTC) is ${dollars(totalMicros)}, and the daily hard stop of ${dollars(stopMicros)} is now refusing provider calls.`,
        "",
        "Shots that need a provider go to needs review at no charge until the UTC day rolls over.",
        "To keep packs running today, raise DAILY_SPEND_HARD_STOP_USD and restart the workers.",
      ].join("\n"),
    };
  }
  return {
    subject: `Curvi provider spend passed ${dollars(SPEND_CAPS.globalDailyAlertMicros)} on ${day}`,
    text: [
      `Provider spend for ${day} (UTC) is ${dollars(totalMicros)}, past the daily alert line of ${dollars(SPEND_CAPS.globalDailyAlertMicros)}.`,
      "",
      `Packs keep running. Provider calls stop at the daily hard stop of ${dollars(stopMicros)}.`,
      "Check the cost per job (generation_jobs.cogs_micros) for a runaway workspace.",
    ].join("\n"),
  };
}

export class SpendAlertNotifier {
  private readonly claimedHere = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly readEnv: ReadEnv;
  private readonly dedupe: AlertDedupe;
  private readonly log: Pick<Console, "error" | "warn">;

  constructor(private readonly opts: SpendAlertNotifierOptions = {}) {
    this.readEnv = opts.readEnv ?? readEnvDefault;
    this.dedupe = opts.dedupe ?? new InMemoryAlertDedupe();
    this.log = opts.log ?? console;
  }

  /** PipelineDeps.onSpendAlert: fire and forget, never throws. */
  readonly onSpendAlert = (totalMicros: number): void => {
    this.track(this.notify("spend_alert", totalMicros));
  };

  /** Called when the global day cap refuses a reservation. */
  readonly onHardStop = (totalMicros: number): void => {
    this.track(this.notify("hard_stop", totalMicros));
  };

  /** Waits for alerts still being delivered, for tests and shutdown. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async notify(kind: SpendAlertKind, totalMicros: number): Promise<SpendAlertResult> {
    const day = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 10);
    const key = `alerts:${kind}:${day}`;
    const result: SpendAlertResult = { kind, day, deduped: true, delivered: null, eventRecorded: false };
    // Every generation past the alert line reports it again; only the first
    // one per process even asks the shared store.
    if (this.claimedHere.has(key)) {
      return result;
    }
    this.claimedHere.add(key);
    let claimed = true;
    try {
      claimed = await this.dedupe.claim(key);
    } catch (err) {
      // Better a second alert than none: send when the claim cannot be made.
      this.logJson("spend_alert_dedupe_failed", { kind, day, error: errorText(err) });
    }
    if (!claimed) {
      return result;
    }
    result.deduped = false;

    const email = composeSpendAlert(kind, totalMicros, day, hardStopMicros(this.readEnv));
    const sent = await this.sendEmail(email);
    result.notice = sent.notice;
    if (sent.ok) {
      result.delivered = "email";
      this.log.warn(
        JSON.stringify({ level: "warn", event: EVENT_NAMES[kind], day, totalUsd: totalMicros / 1_000_000, delivered: "email" }),
      );
    } else {
      result.delivered = "log";
      this.logJson(EVENT_NAMES[kind], {
        day,
        totalUsd: totalMicros / 1_000_000,
        subject: email.subject,
        message: email.text,
        notice: sent.notice,
      });
    }

    if (this.opts.db) {
      try {
        await this.opts.db.insert(events).values({
          workspaceId: null,
          name: EVENT_NAMES[kind],
          props: { day, totalMicros: Math.round(totalMicros), delivered: result.delivered },
        });
        result.eventRecorded = true;
      } catch (err) {
        this.logJson("spend_alert_event_failed", { kind, day, error: errorText(err) });
      }
    }
    return result;
  }

  private sendEmail(email: SpendAlertEmail): Promise<{ ok: boolean; notice?: string }> {
    return sendFounderEmail(email, { readEnv: this.readEnv, fetchImpl: this.opts.fetchImpl });
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((err) => {
      this.logJson("spend_alert_failed", { error: errorText(err) });
    });
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  private logJson(event: string, fields: Record<string, unknown>): void {
    this.log.error(JSON.stringify({ level: "error", event, ...fields }));
  }
}

/**
 * Emails the founder through the Resend REST API when RESEND_API_KEY and
 * FOUNDER_ALERT_EMAIL are set (FOUNDER_ALERT_FROM overrides the sender).
 * Never throws: a missing setting or a failed send comes back as a notice,
 * so the caller logs the alert instead.
 */
export async function sendFounderEmail(
  email: SpendAlertEmail,
  opts: { readEnv?: ReadEnv; fetchImpl?: FetchLike } = {},
): Promise<{ ok: boolean; notice?: string }> {
  const readEnv = opts.readEnv ?? readEnvDefault;
  const apiKey = readEnv("RESEND_API_KEY");
  const to = readEnv("FOUNDER_ALERT_EMAIL");
  if (!apiKey || !to) {
    return {
      ok: false,
      notice: "Set RESEND_API_KEY and FOUNDER_ALERT_EMAIL to email spend alerts to the founder.",
    };
  }
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: readEnv("FOUNDER_ALERT_FROM") ?? DEFAULT_ALERT_FROM,
        to: [to],
        subject: email.subject,
        text: email.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, notice: `Resend returned status ${res.status}. ${body}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, notice: `Resend could not be reached. ${errorText(err)}` };
  }
}

const watched = new WeakSet<SpendCaps>();

/**
 * Reports global day spend on the caps instance every provider call and the
 * runner share: the hard stop when a reservation is refused, and the alert
 * line when an allowed reservation crosses it (which also covers LLM calls,
 * whose path has no onSpendAlert). Idempotent per instance; a notifier error
 * never breaks a reservation.
 */
export function watchGlobalSpend(
  caps: SpendCaps,
  notifier: Pick<SpendAlertNotifier, "onSpendAlert" | "onHardStop">,
): void {
  if (watched.has(caps)) {
    return;
  }
  watched.add(caps);
  const reserve = caps.checkAndReserveGlobalDay.bind(caps);
  caps.checkAndReserveGlobalDay = async (costMicros: number): Promise<CapReservation> => {
    const result = await reserve(costMicros);
    try {
      if (!result.allowed) {
        notifier.onHardStop(result.totalMicros);
      } else if (result.totalMicros >= SPEND_CAPS.globalDailyAlertMicros) {
        notifier.onSpendAlert(result.totalMicros);
      }
    } catch {
      // Alerts are best effort; the reservation result stands.
    }
    return result;
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

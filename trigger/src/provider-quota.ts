/**
 * What happens when a provider answers that its account is out of quota
 * (provider_quota, docs/phases/PHASE_14.md 1.2). The router already opened
 * that provider's breaker for a long cooldown and logged a structured
 * warning; this records it where the founder looks: an events row named
 * provider_quota_exhausted with the provider and the task, at most once per
 * hour per provider in this process, so a busy hour does not write a row per
 * shot. Without a database it only logs.
 *
 * Cutout and image providers also email the founder (docs/phases/PHASE_18.md
 * P18-03), once per provider per UTC hour across every process (a claim in
 * the shared AlertDedupe), through sendFounderEmail. LLM quota emails stay
 * with the LLM monitor (llm-monitor.ts). The email runs in the background:
 * the router awaits this hook before it fails over.
 */

import { events, sql, type Db } from "@curvi/db";
import type { ProviderQuotaInfo } from "@curvi/ai";
import { cutoutModelSeedRows, imageModelSeedRows, llmModelProviders, providerAlertPolicy } from "@curvi/pipeline/seed";
import { llmModelProviderName } from "./recipes";
import { FounderAlerts } from "./provider-balance";
import type { AlertDedupe, SpendAlertEmail } from "./spend-alerts";
import { sendAlertReport, type AlertReport } from "./alert-report";

export const PROVIDER_QUOTA_EVENT = "provider_quota_exhausted";
/** One events row per provider per this window. */
export const PROVIDER_QUOTA_EVENT_WINDOW_MS = providerAlertPolicy.quotaDedupeMinutes * 60_000;

/** The one call the notifier makes on the database. */
export type QuotaEventWriter = Pick<Db, "insert"> & Partial<Pick<Db, "execute">>;

/** The provider kinds whose quota answers reach the founder by email. */
export type QuotaAlertKind = "cutout" | "image" | "llm";

/** Cutout and image provider names from the seed, with their kind. */
export function quotaAlertKinds(): ReadonlyMap<string, QuotaAlertKind> {
  return new Map<string, QuotaAlertKind>([
    ...cutoutModelSeedRows.map((row) => [row.providerName, "cutout"] as const),
    ...imageModelSeedRows.map((row) => [row.providerName, "image"] as const),
    ...Object.keys(llmModelProviders).map((model) => [llmModelProviderName(model), "llm"] as const),
  ]);
}

/** The founder email for a cutout or image provider out of quota. Plain
 * spoken, no dashes used as punctuation (CLAUDE.md rule 9). */
export function composeProviderQuotaEmail(kind: QuotaAlertKind, info: ProviderQuotaInfo, hour: string): SpendAlertEmail {
  if (kind === "llm") return {
    subject: `Curvi: ${info.provider} says the account is out of quota or credit`,
    text: `Planning (${info.provider}, recipe ${info.task}) answered that its account is out of quota or credit in the hour starting ${hour}:00 UTC. Check this account's balance and spend limits. Plans use the next available provider when one is configured.`,
  };
  if (kind === "cutout") {
    return {
      subject: `Curvi: ${info.provider} says the account is out of quota or credit`,
      text: [
        `Background removal (${info.provider}) answered that its account is out of quota or credit, in the hour starting ${hour}:00 UTC.`,
        "",
        "Packs that need a cutout move to the next cutout account when one is set. When none is left, they pause at no charge, and the Start free buttons on the site offer a waitlist until packs can run.",
        "Top up the fal account at fal.ai. Packs go back to it on their own once its breaker closes.",
      ].join("\n"),
    };
  }
  return {
    subject: `Curvi: ${info.provider} says the account is out of quota or credit`,
    text: [
      `Scene generation (${info.provider}, recipe ${info.task}) answered that its account is out of quota or credit, in the hour starting ${hour}:00 UTC.`,
      "",
      "Scenes move to the next image model in the chain. When none is left, scenes pause at no charge and packs still deliver their white background and cutout files.",
      `Check the ${info.provider} credit balance and spend limits.`,
    ].join("\n"),
  };
}

export interface ProviderQuotaNotifierOptions {
  /** The second channel (PHASE_20 P20-13): the process wide hook the web
   * app installs (alert-report.ts) unless one is injected. Once per
   * provider per window, like the events row. */
  report?: AlertReport;
  db?: QuotaEventWriter;
  now?: () => number;
  log?: Pick<Console, "warn" | "error">;
  /** Emails the founder for cutout and image providers. Absent, nothing is emailed. */
  alerts?: FounderAlerts | null;
  /** Provider name to kind; the seed's cutout and image rows by default. */
  alertKinds?: ReadonlyMap<string, QuotaAlertKind>;
}

export class ProviderQuotaNotifier {
  private readonly lastRecorded = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly alertKinds: ReadonlyMap<string, QuotaAlertKind>;

  constructor(private readonly opts: ProviderQuotaNotifierOptions = {}) {
    this.alertKinds = opts.alertKinds ?? quotaAlertKinds();
  }

  /** Waits for founder emails still being sent, for tests and shutdown. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** The founder email, in the background, once per provider and UTC hour. */
  private emailFounder(info: ProviderQuotaInfo, now: number): void {
    const kind = this.alertKinds.get(info.provider);
    const alerts = this.opts.alerts;
    if (!kind || !alerts) {
      return;
    }
    const hour = new Date(now).toISOString().slice(0, 13);
    const work = alerts
      .send(`alerts:provider_quota:${info.provider}:${hour}`, "provider_quota_alert", composeProviderQuotaEmail(kind, info, hour), {
        provider: info.provider,
        task: info.task,
        kind,
        hour,
      })
      .catch(() => undefined);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /** Bound for passing as AiDeps.onProviderQuota. */
  readonly onProviderQuota = async (info: ProviderQuotaInfo): Promise<void> => {
    await this.notify(info);
  };

  /** Records the event unless this provider already had one within the
   * window. Returns true when a row was written. Never throws. */
  async notify(info: ProviderQuotaInfo): Promise<boolean> {
    const now = (this.opts.now ?? Date.now)();
    // Every actual quota answer supersedes an earlier canary/reset, even
    // while email and event history are deduplicated for this hour.
    if (this.opts.db?.execute) {
      try {
        await this.opts.db.execute(sql`insert into platform_settings (key, value, updated_at)
          values (${`provider_quota:last:${info.provider}`}, ${JSON.stringify({ at: now })}::jsonb, ${new Date(now)})
          on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
          where coalesce((platform_settings.value->>'at')::numeric, 0) <= ${now}`);
      } catch {
        (this.opts.log ?? console).error("[provider-quota] durable quota state could not be saved");
      }
    }
    const last = this.lastRecorded.get(info.provider);
    if (last !== undefined && now - last < PROVIDER_QUOTA_EVENT_WINDOW_MS) {
      return false;
    }
    this.lastRecorded.set(info.provider, now);
    this.emailFounder(info, now);
    const log = this.opts.log ?? console;
    log.warn(
      JSON.stringify({
        level: "warn",
        event: PROVIDER_QUOTA_EVENT,
        provider: info.provider,
        task: info.task,
        recorded: Boolean(this.opts.db),
      }),
    );
    sendAlertReport(
      this.opts.report,
      `${info.provider} answered that its account is out of quota or credit`,
      { alert: "provider_quota", provider: info.provider, task: info.task, period: new Date(now).toISOString().slice(0, 13) },
      "error",
    );
    if (!this.opts.db) {
      return false;
    }
    try {
      await this.opts.db.insert(events).values({
        workspaceId: null,
        name: PROVIDER_QUOTA_EVENT,
        props: { provider: info.provider, task: info.task },
      });
      return true;
    } catch (err) {
      // Let the next quota answer try again rather than lose the record.
      this.lastRecorded.delete(info.provider);
      log.error(
        JSON.stringify({
          level: "error",
          event: "provider_quota_event_failed",
          provider: info.provider,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return false;
    }
  }
}

const quotaScope = globalThis as typeof globalThis & {
  __curviQuotaNotifier?: ProviderQuotaNotifier;
  __curviQuotaNotifierHasDb?: boolean;
};

/** The process wide notifier, created with the database the first time one
 * is given (the db runtime), so the hourly dedupe holds across pack runs.
 * The founder emails claim their hour in `dedupe` (PgCapStore in the db
 * runtime), so every process shares one email per provider and hour. */
export function processQuotaNotifier(db?: QuotaEventWriter, dedupe?: AlertDedupe): ProviderQuotaNotifier {
  if (!quotaScope.__curviQuotaNotifier || (db && !quotaScope.__curviQuotaNotifierHasDb)) {
    quotaScope.__curviQuotaNotifier = new ProviderQuotaNotifier({ db, alerts: new FounderAlerts({ dedupe }) });
    quotaScope.__curviQuotaNotifierHasDb = Boolean(db);
  }
  return quotaScope.__curviQuotaNotifier;
}

/**
 * What happens when a provider answers that its account is out of quota
 * (provider_quota, docs/phases/PHASE_14.md 1.2). The router already opened
 * that provider's breaker for a long cooldown and logged a structured
 * warning; this records it where the founder looks: an events row named
 * provider_quota_exhausted with the provider and the task, at most once per
 * hour per provider in this process, so a busy hour does not write a row per
 * shot. Without a database it only logs.
 */

import { events, type Db } from "@curvi/db";
import type { ProviderQuotaInfo } from "@curvi/ai";

export const PROVIDER_QUOTA_EVENT = "provider_quota_exhausted";
/** One events row per provider per this window. */
export const PROVIDER_QUOTA_EVENT_WINDOW_MS = 60 * 60_000;

/** The one call the notifier makes on the database. */
export type QuotaEventWriter = Pick<Db, "insert">;

export interface ProviderQuotaNotifierOptions {
  db?: QuotaEventWriter;
  now?: () => number;
  log?: Pick<Console, "warn" | "error">;
}

export class ProviderQuotaNotifier {
  private readonly lastRecorded = new Map<string, number>();

  constructor(private readonly opts: ProviderQuotaNotifierOptions = {}) {}

  /** Bound for passing as AiDeps.onProviderQuota. */
  readonly onProviderQuota = async (info: ProviderQuotaInfo): Promise<void> => {
    await this.notify(info);
  };

  /** Records the event unless this provider already had one within the
   * window. Returns true when a row was written. Never throws. */
  async notify(info: ProviderQuotaInfo): Promise<boolean> {
    const now = (this.opts.now ?? Date.now)();
    const last = this.lastRecorded.get(info.provider);
    if (last !== undefined && now - last < PROVIDER_QUOTA_EVENT_WINDOW_MS) {
      return false;
    }
    this.lastRecorded.set(info.provider, now);
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
 * is given (the db runtime), so the hourly dedupe holds across pack runs. */
export function processQuotaNotifier(db?: QuotaEventWriter): ProviderQuotaNotifier {
  if (!quotaScope.__curviQuotaNotifier || (db && !quotaScope.__curviQuotaNotifierHasDb)) {
    quotaScope.__curviQuotaNotifier = new ProviderQuotaNotifier({ db });
    quotaScope.__curviQuotaNotifierHasDb = Boolean(db);
  }
  return quotaScope.__curviQuotaNotifier;
}

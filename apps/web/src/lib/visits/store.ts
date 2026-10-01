/**
 * Storage for the cookieless visitor count (migration 0027). The salt of the
 * day is made on demand by the first page view of that UTC day and shared by
 * every instance through site_visit_salts. Salts older than yesterday are
 * deleted when a new day's salt is loaded, by the stale-jobs cron
 * (deleteExpiredVisitSalts) and when an operator opens /app/ops/visitors, so
 * an idle site does not keep them either. Page views go to site_visits, at
 * most DAILY_PAGE_VIEW_CAP per visitor code and day, and at most
 * DAILY_PAGE_VIEW_CEILING per process and day in all, so a script that
 * replays the beacon cannot flood the table even when it changes its user
 * agent or forges its IP on every request. Both tables are written over the
 * owner connection, since anon and authenticated have no privileges on
 * them.
 *
 * Without a database (demo mode, local development, e2e) there is no store
 * and the beacon route stores nothing.
 */

import { sql, type Db, type VisitDevice } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { daysBefore, newSalt, utcDay } from "./hash";

/** Most page views stored per visitor code and day. */
export const DAILY_PAGE_VIEW_CAP = 500;

/**
 * Most page views one process stores in a UTC day, all visitors together.
 * Far above what the site sees; it only bounds a flood. Each instance counts
 * for itself, so N instances can store up to N times this.
 */
export const DAILY_PAGE_VIEW_CEILING = 100_000;

export interface PageViewRow {
  day: string;
  visitorHash: string;
  path: string;
  referrerHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  device: VisitDevice;
}

/** stored, or why not: the visitor's daily cap or the day's ceiling. */
export type RecordResult = "stored" | "capped" | "ceiling";

export interface VisitStore {
  /** The salt of a UTC day (YYYY-MM-DD), made if the day has none yet. */
  saltFor(day: string): Promise<string>;
  /** True when this process has already seen the visitor code on that day. */
  knows(day: string, visitorHash: string): boolean;
  /** Stores one page view unless the visitor's cap or the day's ceiling is reached. */
  record(view: PageViewRow): Promise<RecordResult>;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Deletes the salt of every UTC day before yesterday, counting from now. Safe to run any time. */
export async function deleteExpiredVisitSalts(db: Db, now: Date): Promise<void> {
  await deleteSaltsBefore(db, daysBefore(utcDay(now), 1));
}

async function deleteSaltsBefore(db: Db, day: string): Promise<void> {
  await db.execute(sql`delete from site_visit_salts where day < ${day}::date`);
}

/** Bounds the in process cap counter, so a flood of codes cannot grow memory. */
const MAX_COUNTED_VISITORS = 50_000;

interface DayCounters {
  day: string;
  /** Page views stored per visitor code by this process (the cap). */
  views: Map<string, number>;
  /** Page views of the day in all, read once from the database, then counted here (the ceiling). */
  total: number | null;
}

export class DbVisitStore implements VisitStore {
  private salt: { day: string; value: string } | null = null;
  private counted: DayCounters = { day: "", views: new Map(), total: null };

  constructor(
    private readonly db: Db,
    private readonly cap = DAILY_PAGE_VIEW_CAP,
    private readonly ceiling = DAILY_PAGE_VIEW_CEILING,
  ) {}

  async saltFor(day: string): Promise<string> {
    if (this.salt?.day === day) {
      return this.salt.value;
    }
    const candidate = newSalt();
    const created = await this.db.execute(sql`
      with inserted as (
        insert into site_visit_salts (day, salt) values (${day}::date, ${candidate})
        on conflict (day) do nothing
        returning salt
      )
      select salt from inserted
      union all
      select salt from site_visit_salts where day = ${day}::date
      limit 1
    `);
    let salt = rowsOf<{ salt: string }>(created)[0]?.salt;
    if (!salt) {
      // Another instance inserted the day's salt after this statement's
      // snapshot was taken; it is committed now.
      const existing = await this.db.execute(sql`select salt from site_visit_salts where day = ${day}::date`);
      salt = rowsOf<{ salt: string }>(existing)[0]?.salt;
    }
    if (!salt) {
      throw new Error("No visitor salt for the day");
    }
    // Only today's and yesterday's salts are ever kept.
    await deleteSaltsBefore(this.db, daysBefore(day, 1));
    this.salt = { day, value: salt };
    return salt;
  }

  knows(day: string, visitorHash: string): boolean {
    return this.counted.day === day && this.counted.views.has(visitorHash);
  }

  async record(view: PageViewRow): Promise<RecordResult> {
    const counters = this.countersFor(view.day);
    const seen = counters.views.get(view.visitorHash) ?? 0;
    if (seen >= this.cap) {
      return "capped";
    }
    if (counters.total === null) {
      const total = await this.storedOn(view.day);
      // A concurrent first page view may have read it already.
      counters.total ??= total;
    }
    if (counters.total >= this.ceiling) {
      return "ceiling";
    }
    const result = await this.db.execute(sql`
      insert into site_visits (day, visitor_hash, path, referrer_host, utm_source, utm_medium, utm_campaign, device)
      select ${view.day}::date, ${view.visitorHash}, ${view.path}, ${view.referrerHost}, ${view.utmSource},
        ${view.utmMedium}, ${view.utmCampaign}, ${view.device}
      where (
        select count(*) from site_visits where day = ${view.day}::date and visitor_hash = ${view.visitorHash}
      ) < ${this.cap}
      returning id
    `);
    const stored = rowsOf(result).length > 0;
    if (counters.views.size >= MAX_COUNTED_VISITORS && !counters.views.has(view.visitorHash)) {
      counters.views.clear();
    }
    // Over the cap in the database (another instance counted the rest) means
    // over the cap here too.
    counters.views.set(view.visitorHash, stored ? seen + 1 : this.cap);
    if (stored) {
      counters.total = (counters.total ?? 0) + 1;
    }
    return stored ? "stored" : "capped";
  }

  private countersFor(day: string): DayCounters {
    if (this.counted.day !== day) {
      this.counted = { day, views: new Map(), total: null };
    }
    return this.counted;
  }

  /** Page views stored on a day by every instance (index only on (day, visitor_hash)). */
  private async storedOn(day: string): Promise<number> {
    const result = await this.db.execute(sql`select count(*)::int as n from site_visits where day = ${day}::date`);
    return Number(rowsOf<{ n: number | string }>(result)[0]?.n ?? 0);
  }
}

const globalScope = globalThis as typeof globalThis & { __curviVisitStore?: VisitStore | null };

/** The process wide store in db mode, null without a database. */
export function getVisitStore(): VisitStore | null {
  if (globalScope.__curviVisitStore !== undefined) {
    return globalScope.__curviVisitStore;
  }
  if (!isDbMode()) {
    return null;
  }
  globalScope.__curviVisitStore = new DbVisitStore(getDb());
  return globalScope.__curviVisitStore;
}

/** Test hook: swap the process wide store (undefined resets to the env default). */
export function setVisitStoreForTests(store: VisitStore | null | undefined): void {
  globalScope.__curviVisitStore = store;
}

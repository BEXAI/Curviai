/**
 * Storage for the cookieless visitor count (migration 0027). The salt of the
 * day is made on demand by the first page view of that UTC day and shared by
 * every instance through site_visit_salts; salts older than yesterday are
 * deleted when a new day's salt is loaded. Page views go to site_visits,
 * at most DAILY_PAGE_VIEW_CAP per visitor code and day, so a script that
 * replays the beacon cannot flood the table. Both tables are written over
 * the owner connection, since anon and authenticated have no privileges on
 * them.
 *
 * Without a database (demo mode, local development, e2e) there is no store
 * and the beacon route stores nothing.
 */

import { sql, type Db, type VisitDevice } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { daysBefore, newSalt } from "./hash";

/** Most page views stored per visitor code and day. */
export const DAILY_PAGE_VIEW_CAP = 500;

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

export interface VisitStore {
  /** The salt of a UTC day (YYYY-MM-DD), made if the day has none yet. */
  saltFor(day: string): Promise<string>;
  /** Stores one page view; false when the visitor is over the daily cap. */
  record(view: PageViewRow): Promise<boolean>;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Bounds the in process cap counter, so a flood of codes cannot grow memory. */
const MAX_COUNTED_VISITORS = 50_000;

export class DbVisitStore implements VisitStore {
  private salt: { day: string; value: string } | null = null;
  private counted: { day: string; views: Map<string, number> } = { day: "", views: new Map() };

  constructor(
    private readonly db: Db,
    private readonly cap = DAILY_PAGE_VIEW_CAP,
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
    await this.db.execute(sql`delete from site_visit_salts where day < ${daysBefore(day, 1)}::date`);
    this.salt = { day, value: salt };
    return salt;
  }

  async record(view: PageViewRow): Promise<boolean> {
    if (this.counted.day !== view.day) {
      this.counted = { day: view.day, views: new Map() };
    }
    const seen = this.counted.views.get(view.visitorHash) ?? 0;
    if (seen >= this.cap) {
      return false;
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
    if (this.counted.views.size >= MAX_COUNTED_VISITORS && !this.counted.views.has(view.visitorHash)) {
      this.counted.views.clear();
    }
    // Over the cap in the database (another instance counted the rest) means
    // over the cap here too.
    this.counted.views.set(view.visitorHash, stored ? seen + 1 : this.cap);
    return stored;
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

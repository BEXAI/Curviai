/**
 * The numbers on /app/ops/visitors, read over the owner connection from
 * site_visits (migration 0027). Days are UTC days, the same days the salt
 * rotates on.
 *
 * A visitor code lasts one day, so a person who comes back on another day
 * gets a new code and counts again. Every count over more than one day is
 * therefore daily unique visitors added up: exact for one day, and an upper
 * bound for the number of different people over a range. The page says so.
 */

import { siteVisits, sql, type Db } from "@curvi/db";
import { daysBefore, utcDay } from "./hash";

/** How many days the dashboard covers. */
export const STATS_DAYS = 30;
const TOP_LIMIT = 10;

type TopColumn = "path" | "referrerHost" | "utmSource" | "utmCampaign" | "device";

export interface DayCount {
  day: string;
  visitors: number;
  pageViews: number;
}

export interface RangeCount {
  key: "today" | "yesterday" | "last7" | "last30";
  label: string;
  visitors: number;
  pageViews: number;
}

export interface TopRow {
  label: string;
  visitors: number;
  pageViews: number;
}

export interface VisitorStats {
  today: string;
  ranges: RangeCount[];
  /** Oldest first, one entry per day of the last STATS_DAYS days, zeros included. */
  daily: DayCount[];
  topPages: TopRow[];
  topReferrers: TopRow[];
  topSources: TopRow[];
  topCampaigns: TopRow[];
  devices: TopRow[];
}

/** Every day from the first to the last, oldest first. */
function daysFrom(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => daysBefore(today, count - 1 - i));
}

function sum(days: DayCount[]): { visitors: number; pageViews: number } {
  return days.reduce(
    (total, d) => ({ visitors: total.visitors + d.visitors, pageViews: total.pageViews + d.pageViews }),
    { visitors: 0, pageViews: 0 },
  );
}

/** The four headline ranges from the daily series (oldest first, ending today). */
export function rangesFrom(daily: DayCount[]): RangeCount[] {
  const last = daily.length - 1;
  return [
    { key: "today", label: "Today", ...sum(daily.slice(last)) },
    { key: "yesterday", label: "Yesterday", ...sum(daily.slice(Math.max(0, last - 1), last)) },
    { key: "last7", label: "Last 7 days", ...sum(daily.slice(-7)) },
    { key: "last30", label: "Last 30 days", ...sum(daily.slice(-30)) },
  ];
}

export async function loadVisitorStats(db: Db, now: Date): Promise<VisitorStats> {
  const today = utcDay(now);
  const from = daysBefore(today, STATS_DAYS - 1);
  const inRange = sql`${siteVisits.day} >= ${from}::date and ${siteVisits.day} <= ${today}::date`;
  // A visitor on one day: the (day, code) pair, so ranges add daily counts up.
  const dailyVisitors = sql<number>`count(distinct (${siteVisits.day}, ${siteVisits.visitorHash}))::int`;
  const pageViews = sql<number>`count(*)::int`;

  const top = (key: TopColumn) => {
    const column = siteVisits[key];
    return db
      .select({ label: sql<string>`${column}`, visitors: dailyVisitors, pageViews })
      .from(siteVisits)
      .where(sql`${inRange} and ${column} is not null`)
      .groupBy(column)
      .orderBy(sql`2 desc`, sql`3 desc`, sql`1`)
      .limit(TOP_LIMIT);
  };

  const [dailyRows, topPages, topReferrers, topSources, topCampaigns, devices] = await Promise.all([
    db
      .select({ day: sql<string>`${siteVisits.day}::text`, visitors: sql<number>`count(distinct ${siteVisits.visitorHash})::int`, pageViews })
      .from(siteVisits)
      .where(inRange)
      .groupBy(siteVisits.day),
    top("path"),
    top("referrerHost"),
    top("utmSource"),
    top("utmCampaign"),
    top("device"),
  ]);

  const byDay = new Map(dailyRows.map((row) => [row.day, row]));
  const daily = daysFrom(today, STATS_DAYS).map((day) => ({
    day,
    visitors: Number(byDay.get(day)?.visitors ?? 0),
    pageViews: Number(byDay.get(day)?.pageViews ?? 0),
  }));
  const numeric = (rows: TopRow[]): TopRow[] =>
    rows.map((row) => ({ label: row.label, visitors: Number(row.visitors), pageViews: Number(row.pageViews) }));

  return {
    today,
    ranges: rangesFrom(daily),
    daily,
    topPages: numeric(topPages),
    topReferrers: numeric(topReferrers),
    topSources: numeric(topSources),
    topCampaigns: numeric(topCampaigns),
    devices: numeric(devices),
  };
}

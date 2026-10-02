/**
 * The numbers behind the weekly funnel email and /app/ops/funnel
 * (docs/phases/PHASE_18.md P18-02), read over the owner connection from the
 * server side funnel in events (funnel.<step>), the leads table, share_links
 * and the cookieless visitor count. Counts only: nothing here names a
 * person, and visits never join to signups.
 *
 * Two windows: the last funnelDigest.windowDays days and everything since
 * funnelDigest.since (day 0 of docs/marketing.md). Workspaces owned by an
 * operator (OPS_EMAILS, lib/ops.ts) are left out of the seller funnel, so
 * the founder's own test packs never count as activation; prospect packs
 * and claims (P18-04) are counted from the operator's side on purpose.
 *
 * Steps other lanes write are read by name with the props listed in
 * packages/db/src/funnel.ts; until a step ships its count is 0.
 */

import { funnelDigest, packFeedback, validationGates, type ValidationGate } from "@curvi/pipeline/seed";
import { sql, type Db } from "@curvi/db";
import { loadConsentedQuotes, type ConsentedQuote } from "@/lib/feedback/db-store";
import { claimsByCampaign, type ClaimCountRow } from "@/lib/prospects/digest";
import { customerWorkspace, operatorWorkspaceIds } from "@/lib/customer-metrics";
export { operatorWorkspaceIds } from "@/lib/customer-metrics";

type SQL = ReturnType<typeof sql>;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FunnelWindow {
  key: "week" | "since";
  from: Date;
  to: Date;
}

export interface CountRow {
  label: string;
  count: number;
}

export interface Ratio {
  hits: number;
  of: number;
}

export interface FunnelWindowStats {
  window: FunnelWindow;
  confirmedSignups: number;
  bySelfReported: CountRow[];
  byUtmSource: CountRow[];
  byPageSource: CountRow[];
  firstPacksStarted: number;
  firstPacksDone: number;
  /** Signups confirmed in the window with a first pack done by its end. */
  activation: Ratio;
  firstDownloads: number;
  payments: number;
  firstPayments: number;
  paymentsUsd: number;
  /** Workspaces whose first pack was done in the window, and those of them
   * with a second pack done within repeatWindowDays. */
  repeat: Ratio;
  /** Paying workspaces (first payment in the window) that paid again or
   * started a pack within repeatWindowDays. */
  payerRepeat: Ratio;
  sharesPublished: number;
  leadsCaptured: number;
  newLeads: CountRow[];
  feedback: Ratio;
  previewsMade: number;
  previewsClaimed: number;
  prospectPacks: number;
  claimsRedeemed: number;
  /** Lifecycle emails sent, by template (P18-07, funnel.email_sent). */
  emailsSent: CountRow[];
}

export interface VisitorSummary {
  visitors: number;
  pageViews: number;
  topSources: CountRow[];
}

export interface WeekRow {
  /** Monday of the ISO week, YYYY-MM-DD (UTC). */
  week: string;
  signups: number;
  firstPacksDone: number;
  firstDownloads: number;
  firstPayments: number;
}

export type GateState = "met" | "doubt" | "too_early" | "watch";

export interface GateReadout {
  gate: ValidationGate;
  value: number;
  denominator: number | null;
  state: GateState;
}

export interface FunnelReport {
  generatedAt: Date;
  week: FunnelWindowStats;
  since: FunnelWindowStats;
  /** Last windowDays of the visitor count; null when it cannot be read. */
  visitors: VisitorSummary | null;
  /** Public share pages' views so far. */
  shareViews: number;
  weekly: WeekRow[];
  gates: GateReadout[];
  excludedWorkspaces: number;
  /** New quotes sellers let Curvi use, last windowDays (P18-05). */
  quotes?: ConsentedQuote[];
  /** Redeemed prospect claims by store since day 0 (P18-04). */
  claims?: ClaimCountRow[];
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The two windows ending at now. */
export function funnelWindows(now: Date): { week: FunnelWindow; since: FunnelWindow } {
  return {
    week: { key: "week", from: new Date(now.getTime() - funnelDigest.windowDays * DAY_MS), to: now },
    since: { key: "since", from: new Date(`${funnelDigest.since}T00:00:00.000Z`), to: now },
  };
}

/** Fixed report aliases only; the shared policy also serves smoke and economics. */
function notExcluded(excluded: readonly string[], alias = ""): SQL {
  return customerWorkspace(excluded, sql.raw(alias ? `${alias}.workspace_id` : "workspace_id"));
}

function inWindow(window: FunnelWindow, alias = ""): SQL {
  const column = sql.raw(alias ? `${alias}.at` : "at");
  return sql`${column} >= ${window.from.toISOString()}::timestamptz and ${column} < ${window.to.toISOString()}::timestamptz`;
}

/** Steps counted from the operator's side as well (P18-04). */
const OPERATOR_STEPS = ["funnel.prospect_pack_made", "funnel.claim_redeemed", "funnel.claim_taken_down"];

const COUNTED_STEPS = [
  "funnel.signup_confirmed",
  "funnel.first_pack_started",
  "funnel.first_pack_done",
  "funnel.first_download",
  "funnel.payment",
  "funnel.first_payment",
  "funnel.share_published",
  "funnel.lead_captured",
  "funnel.preview_made",
  "funnel.preview_claimed",
  ...OPERATOR_STEPS,
];

async function stepCounts(db: Db, window: FunnelWindow, excluded: readonly string[]): Promise<Map<string, number>> {
  const rows = rowsOf<{ name: string; n: number | string }>(
    await db.execute(sql`
      select name, count(*)::int as n
      from events
      where name in (${sql.join(
        COUNTED_STEPS.map((name) => sql`${name}`),
        sql`, `,
      )})
        and ${inWindow(window)}
        and (name in (${sql.join(
          OPERATOR_STEPS.map((name) => sql`${name}`),
          sql`, `,
        )}) or ${notExcluded(excluded)})
      group by name
    `),
  );
  return new Map(rows.map((row) => [row.name, num(row.n)]));
}

async function signupsBy(
  db: Db,
  window: FunnelWindow,
  excluded: readonly string[],
  prop: "self_reported" | "utm_source" | "source",
  missing: string,
): Promise<CountRow[]> {
  const rows = rowsOf<{ label: string; n: number | string }>(
    await db.execute(sql`
      select coalesce(nullif(props ->> ${prop}, ''), ${missing}) as label, count(*)::int as n
      from events
      where name = 'funnel.signup_confirmed' and ${inWindow(window)} and ${notExcluded(excluded)}
      group by 1
      order by n desc, label
      limit ${funnelDigest.topRows}
    `),
  );
  return rows.map((row) => ({ label: String(row.label), count: num(row.n) }));
}

async function windowStats(db: Db, window: FunnelWindow, excluded: readonly string[]): Promise<FunnelWindowStats> {
  const repeatDays = funnelDigest.repeatWindowDays;
  const [counts, bySelfReported, byUtmSource, byPageSource, activationRows, paymentRows, repeatRows, payerRows, feedbackRows, leadRows, emailRows] =
    await Promise.all([
      stepCounts(db, window, excluded),
      signupsBy(db, window, excluded, "self_reported", "not answered"),
      signupsBy(db, window, excluded, "utm_source", "no utm_source"),
      signupsBy(db, window, excluded, "source", "no page source"),
      db.execute(sql`
        with signups as (
          select distinct workspace_id from events
          where name = 'funnel.signup_confirmed' and workspace_id is not null
            and ${inWindow(window)} and ${notExcluded(excluded)}
        )
        select count(*)::int as signups,
          (count(*) filter (where exists (
            select 1 from events e
            where e.workspace_id = s.workspace_id and e.name = 'funnel.first_pack_done'
              and e.at < ${window.to.toISOString()}::timestamptz
          )))::int as activated
        from signups s
      `),
      db.execute(sql`
        select coalesce(sum((props ->> 'amount_usd')::numeric), 0)::float8 as usd
        from events
        where name = 'funnel.payment' and ${inWindow(window)} and ${notExcluded(excluded)}
          and (props ->> 'amount_usd') ~ '^[0-9]+(\\.[0-9]+)?$'
      `),
      db.execute(sql`
        with firsts as (
          select workspace_id, at from events
          where name = 'funnel.first_pack_done' and ${inWindow(window)} and ${notExcluded(excluded)}
        )
        select count(*)::int as activated,
          (count(*) filter (where (
            select count(distinct e.props ->> 'job_id') from events e
            where e.workspace_id = f.workspace_id and e.name = 'funnel.pack_done'
              and e.at < f.at + (${repeatDays}::int * interval '1 day')
          ) >= 2))::int as repeaters
        from firsts f
      `),
      db.execute(sql`
        with payers as (
          select workspace_id, at from events
          where name = 'funnel.first_payment' and ${inWindow(window)} and ${notExcluded(excluded)}
        )
        select count(*)::int as payers,
          (count(*) filter (where exists (
            select 1 from events e
            where e.workspace_id = p.workspace_id
              and e.name in ('funnel.payment', 'funnel.pack_started')
              and e.at > p.at and e.at < p.at + (${repeatDays}::int * interval '1 day')
          )))::int as repeaters
        from payers p
      `),
      db.execute(sql`
        select count(*)::int as answers,
          (count(*) filter (where props ->> 'usable' = 'yes'))::int as usable
        from events
        where name = 'funnel.feedback_submitted' and ${inWindow(window)} and ${notExcluded(excluded)}
      `),
      db.execute(sql`
        select source as label, count(*)::int as n
        from leads
        where created_at >= ${window.from.toISOString()}::timestamptz and created_at < ${window.to.toISOString()}::timestamptz
        group by source
        order by n desc, source
        limit ${funnelDigest.topRows}
      `),
      db.execute(sql`
        select coalesce(nullif(props ->> 'template', ''), 'unknown') as label, count(*)::int as n
        from events
        where name = 'funnel.email_sent' and ${inWindow(window)} and ${notExcluded(excluded)}
        group by 1
        order by n desc, label
      `),
    ]);
  const activation = rowsOf<{ signups: number; activated: number }>(activationRows)[0];
  const repeat = rowsOf<{ activated: number; repeaters: number }>(repeatRows)[0];
  const payers = rowsOf<{ payers: number; repeaters: number }>(payerRows)[0];
  const feedback = rowsOf<{ answers: number; usable: number }>(feedbackRows)[0];
  const count = (name: string): number => counts.get(name) ?? 0;
  return {
    window,
    confirmedSignups: count("funnel.signup_confirmed"),
    bySelfReported,
    byUtmSource,
    byPageSource,
    firstPacksStarted: count("funnel.first_pack_started"),
    firstPacksDone: count("funnel.first_pack_done"),
    activation: { hits: num(activation?.activated), of: num(activation?.signups) },
    firstDownloads: count("funnel.first_download"),
    payments: count("funnel.payment"),
    firstPayments: count("funnel.first_payment"),
    paymentsUsd: Math.round(num(rowsOf<{ usd: number }>(paymentRows)[0]?.usd) * 100) / 100,
    repeat: { hits: num(repeat?.repeaters), of: num(repeat?.activated) },
    payerRepeat: { hits: num(payers?.repeaters), of: num(payers?.payers) },
    sharesPublished: count("funnel.share_published"),
    leadsCaptured: count("funnel.lead_captured"),
    newLeads: rowsOf<{ label: string; n: number }>(leadRows).map((row) => ({ label: String(row.label), count: num(row.n) })),
    feedback: { hits: num(feedback?.usable), of: num(feedback?.answers) },
    previewsMade: count("funnel.preview_made"),
    previewsClaimed: count("funnel.preview_claimed"),
    prospectPacks: count("funnel.prospect_pack_made"),
    claimsRedeemed: count("funnel.claim_redeemed"),
    emailsSent: rowsOf<{ label: string; n: number }>(emailRows).map((row) => ({ label: String(row.label), count: num(row.n) })),
  };
}

async function visitorSummary(db: Db, window: FunnelWindow): Promise<VisitorSummary | null> {
  try {
    const from = window.from.toISOString().slice(0, 10);
    const to = window.to.toISOString().slice(0, 10);
    const [totals, sources] = await Promise.all([
      db.execute(sql`
        select coalesce(sum(visitors), 0)::int as visitors, coalesce(sum(page_views), 0)::int as page_views
        from (
          select day, count(distinct visitor_hash) as visitors, count(*) as page_views
          from site_visits
          where day > ${from}::date and day <= ${to}::date
          group by day
        ) as daily
      `),
      db.execute(sql`
        select utm_source as label, count(distinct (day, visitor_hash))::int as n
        from site_visits
        where day > ${from}::date and day <= ${to}::date and utm_source is not null
        group by utm_source
        order by n desc, label
        limit ${funnelDigest.topRows}
      `),
    ]);
    const total = rowsOf<{ visitors: number; page_views: number }>(totals)[0];
    return {
      visitors: num(total?.visitors),
      pageViews: num(total?.page_views),
      topSources: rowsOf<{ label: string; n: number }>(sources).map((row) => ({ label: String(row.label), count: num(row.n) })),
    };
  } catch {
    return null;
  }
}

async function shareViews(db: Db, excluded: readonly string[]): Promise<number> {
  const rows = rowsOf<{ views: number }>(
    await db.execute(sql`
      select coalesce(sum(views), 0)::int as views from share_links where public and ${notExcluded(excluded)}
    `),
  );
  return num(rows[0]?.views);
}

/** Mondays (UTC, YYYY-MM-DD) of the last `weeks` ISO weeks, oldest first. */
export function recentWeekStarts(now: Date, weeks: number): string[] {
  const monday = isoWeekStart(now);
  return Array.from({ length: weeks }, (_, i) =>
    new Date(monday.getTime() - (weeks - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
  );
}

async function weeklyRows(db: Db, now: Date, excluded: readonly string[]): Promise<WeekRow[]> {
  const weeks = recentWeekStarts(now, funnelDigest.pageWeeks);
  const rows = rowsOf<{ week: string; name: string; n: number }>(
    await db.execute(sql`
      select to_char(date_trunc('week', at at time zone 'UTC'), 'YYYY-MM-DD') as week, name, count(*)::int as n
      from events
      where name in ('funnel.signup_confirmed', 'funnel.first_pack_done', 'funnel.first_download', 'funnel.first_payment')
        and at >= ${`${weeks[0]}T00:00:00.000Z`}::timestamptz
        and ${notExcluded(excluded)}
      group by 1, 2
    `),
  );
  const byKey = new Map(rows.map((row) => [`${row.week}|${row.name}`, num(row.n)]));
  return weeks.map((week) => ({
    week,
    signups: byKey.get(`${week}|funnel.signup_confirmed`) ?? 0,
    firstPacksDone: byKey.get(`${week}|funnel.first_pack_done`) ?? 0,
    firstDownloads: byKey.get(`${week}|funnel.first_download`) ?? 0,
    firstPayments: byKey.get(`${week}|funnel.first_payment`) ?? 0,
  }));
}

function percent(ratio: Ratio): number {
  return ratio.of > 0 ? Math.round((ratio.hits / ratio.of) * 1000) / 10 : 0;
}

/** Each seeded gate against the numbers since day 0. */
export function gateReadouts(since: FunnelWindowStats, gates: readonly ValidationGate[] = validationGates): GateReadout[] {
  return gates.map((gate) => {
    let value: number;
    let denominator: number | null;
    switch (gate.metric) {
      case "usable_share":
        value = percent(since.feedback);
        denominator = since.feedback.of;
        break;
      case "activation":
        value = percent(since.activation);
        denominator = since.activation.of;
        break;
      case "first_payments":
        value = since.firstPayments;
        denominator = null;
        break;
      case "payer_repeat":
        value = percent(since.payerRepeat);
        denominator = since.payerRepeat.of;
        break;
      case "paid_share":
        value = percent({ hits: since.firstPayments, of: since.activation.of });
        denominator = since.activation.of;
        break;
    }
    let state: GateState;
    if (gate.minSample !== null && (denominator ?? 0) < gate.minSample) {
      state = "too_early";
    } else if (gate.unit === "percent" && (denominator ?? 0) === 0) {
      state = "too_early";
    } else if (value >= gate.target) {
      state = "met";
    } else if (gate.doubtBelow !== null && value < gate.doubtBelow) {
      state = "doubt";
    } else {
      state = "watch";
    }
    return { gate, value, denominator, state };
  });
}

/** Everything the weekly email and the operator page show. */
export async function loadFunnelReport(
  db: Db,
  options: { now?: Date; operatorEmails?: readonly string[] } = {},
): Promise<FunnelReport> {
  const now = options.now ?? new Date();
  const excluded = await operatorWorkspaceIds(db, options.operatorEmails ?? []);
  const windows = funnelWindows(now);
  const [week, since, visitors, views, weekly, quotes, claims] = await Promise.all([
    windowStats(db, windows.week, excluded),
    windowStats(db, windows.since, excluded),
    visitorSummary(db, windows.week),
    shareViews(db, excluded),
    weeklyRows(db, now, excluded),
    loadConsentedQuotes(db, windows.week, { excludeWorkspaces: excluded, limit: packFeedback.digestQuotes }),
    claimsByCampaign(db, windows.since, funnelDigest.topRows),
  ]);
  return {
    generatedAt: now,
    week,
    since,
    visitors,
    shareViews: views,
    weekly,
    gates: gateReadouts(since),
    excludedWorkspaces: excluded.length,
    quotes,
    claims,
  };
}

// ---------------------------------------------------------------------------
// ISO weeks and the send schedule.
// ---------------------------------------------------------------------------

/** Monday 00:00 UTC of the ISO week holding `at`. */
export function isoWeekStart(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  return new Date(day.getTime() - (weekday - 1) * DAY_MS);
}

/** The ISO week key, for example 2026-W40. */
export function isoWeekKey(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  // The Thursday of this week decides the ISO year.
  const thursday = new Date(day.getTime() + (4 - weekday) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** True once this ISO week's send time (funnelDigest.sendWeekday at
 * sendHourUtc) has passed. */
export function funnelDigestDue(now: Date): boolean {
  const sendAt =
    isoWeekStart(now).getTime() + (funnelDigest.sendWeekday - 1) * DAY_MS + funnelDigest.sendHourUtc * 60 * 60 * 1000;
  return now.getTime() >= sendAt;
}

/**
 * The weekly funnel email to the founder (docs/phases/PHASE_18.md P18-02):
 * a plain text summary of lib/funnel-report.ts, sent once per ISO week
 * through Resend by the founder alert path (sendFounderEmail in
 * trigger/src/spend-alerts.ts, to FOUNDER_ALERT_EMAIL).
 *
 * POST /api/cron/funnel-digest calls runFunnelDigest from the existing
 * daily cron command. It sends on the first call on or after the seeded
 * weekday and hour (Monday 13:00 UTC), and claims the week first in
 * platform_settings (funnel_digest:last_week), so a cron that runs every day
 * of a week sends one email. A failed send gives the claim back, so the
 * next call tries again. A dry run composes the email and sends nothing.
 *
 * Founder only copy, still plain (CLAUDE.md rule 9).
 */

import { sql, type Db } from "@curvi/db";
import { funnelDigest } from "@curvi/pipeline/seed";
import {
  funnelDigestDue,
  isoWeekKey,
  isoWeekStart,
  loadFunnelReport,
  type CountRow,
  type FunnelReport,
  type FunnelWindowStats,
  type GateReadout,
  type Ratio,
} from "./funnel-report";

export const FUNNEL_DIGEST_SETTING_KEY = "funnel_digest:last_week";

export interface FunnelDigestEmail {
  subject: string;
  text: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** October 5, 2026 (UTC). */
export function longDate(at: Date): string {
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}`;
}

function shortDate(at: Date): string {
  return `${MONTHS[at.getUTCMonth()].slice(0, 3)} ${at.getUTCDate()}`;
}

function pct(ratio: Ratio): string {
  if (ratio.of === 0) {
    return "none yet";
  }
  return `${Math.round((ratio.hits / ratio.of) * 1000) / 10}% (${ratio.hits} of ${ratio.of})`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Rows as text columns: by default a left aligned label column and right
 * aligned value columns; leftColumns lists any other left aligned ones. */
function table(header: string[], rows: string[][], leftColumns: readonly number[] = [0]): string[] {
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => (leftColumns.includes(i) ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join("   ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

function mergeCounts(week: CountRow[], since: CountRow[]): string[][] {
  const labels = [...new Set([...since.map((row) => row.label), ...week.map((row) => row.label)])];
  const weekBy = new Map(week.map((row) => [row.label, row.count]));
  const sinceBy = new Map(since.map((row) => [row.label, row.count]));
  return labels.map((label) => [label, String(weekBy.get(label) ?? 0), String(sinceBy.get(label) ?? 0)]);
}

function funnelRows(week: FunnelWindowStats, since: FunnelWindowStats): string[][] {
  const both = (pick: (stats: FunnelWindowStats) => string): [string, string] => [pick(week), pick(since)];
  return [
    ["Confirmed signups", ...both((s) => String(s.confirmedSignups))],
    ["First pack started", ...both((s) => String(s.firstPacksStarted))],
    ["First pack done", ...both((s) => String(s.firstPacksDone))],
    ["Activation of these signups", ...both((s) => pct(s.activation))],
    ["First download", ...both((s) => String(s.firstDownloads))],
    ["Payments", ...both((s) => String(s.payments))],
    ["First payments", ...both((s) => String(s.firstPayments))],
    ["Paid, in US dollars", ...both((s) => usd(s.paymentsUsd))],
    ["Second pack within 30 days", ...both((s) => pct(s.repeat))],
    ["Share pages published", ...both((s) => String(s.sharesPublished))],
    ["Leads left on free tools", ...both((s) => String(s.leadsCaptured))],
    ["Feedback: usable as they are", ...both((s) => pct(s.feedback))],
    ["Free previews made", ...both((s) => String(s.previewsMade))],
    ["Free previews claimed", ...both((s) => String(s.previewsClaimed))],
    ["Prospect packs made", ...both((s) => String(s.prospectPacks))],
    ["Prospect claims", ...both((s) => String(s.claimsRedeemed))],
  ];
}

const GATE_WORDS: Record<GateReadout["state"], string> = {
  met: "met",
  doubt: "below the doubt line",
  too_early: "too early to read",
  watch: "between the lines",
};

function gateLine(readout: GateReadout): string[] {
  const { gate } = readout;
  const value = gate.unit === "percent" ? `${readout.value}%` : String(readout.value);
  const target = gate.unit === "percent" ? `${gate.target}%` : String(gate.target);
  const doubt =
    gate.doubtBelow === null ? "" : `; doubt below ${gate.unit === "percent" ? `${gate.doubtBelow}%` : gate.doubtBelow}`;
  const sample =
    gate.minSample === null ? "" : `; needs ${gate.minSample}, have ${readout.denominator ?? 0}`;
  return [`Day ${gate.day} (${shortDate(new Date(`${gate.date}T00:00:00Z`))})`, gate.label, value, `${GATE_WORDS[readout.state]} (target ${target}${doubt}${sample})`];
}

/** New consented quotes (P18-05), in the seller's own words. The consent
 * box says "You can quote me on curvi.ai with this name and store", so the
 * heading says where they may go. */
function quoteLines(report: FunnelReport, weekLabel: string): string[] {
  const quotes = report.quotes ?? [];
  if (quotes.length === 0) {
    return ["", `New quotes you may use on curvi.ai only, ${weekLabel.toLowerCase()}: none yet.`];
  }
  return [
    "",
    `New quotes you may use on curvi.ai only, ${weekLabel.toLowerCase()} (pack feedback with consent; quote them word for word; ask the seller before using one anywhere else)`,
    ...quotes.map(
      (quote) => `"${quote.text.replace(/\s+/g, " ")}" (${quote.name ?? "no name given"}; usable: ${quote.usable})`,
    ),
  ];
}

/** The email for one report. Pure. */
export function composeFunnelDigest(report: FunnelReport): FunnelDigestEmail {
  const weekOf = isoWeekStart(report.generatedAt);
  const since = new Date(`${funnelDigest.since}T00:00:00Z`);
  const weekLabel = `Last ${funnelDigest.windowDays} days`;
  const sinceLabel = `Since ${shortDate(since)}`;
  const lines: string[] = [
    `Curvi weekly funnel, week of ${longDate(weekOf)}`,
    "",
    `${weekLabel}: ${shortDate(report.week.window.from)} to ${shortDate(report.week.window.to)}. ${sinceLabel}: everything since ${longDate(since)}.`,
    report.excludedWorkspaces > 0
      ? `Workspaces owned by an operator email are left out (${report.excludedWorkspaces}).`
      : "No operator workspace is left out (OPS_EMAILS is empty or matches no owner).",
    "",
    "Funnel",
    ...table(["", weekLabel, sinceLabel], funnelRows(report.week, report.since)),
    "",
    "Confirmed signups by how they heard about Curvi",
    ...table(["Answer", weekLabel, sinceLabel], mergeCounts(report.week.bySelfReported, report.since.bySelfReported)),
    "",
    "Confirmed signups by utm_source",
    ...table(["utm_source", weekLabel, sinceLabel], mergeCounts(report.week.byUtmSource, report.since.byUtmSource)),
    "",
    "Confirmed signups by the page of the signup link",
    ...table(["Page", weekLabel, sinceLabel], mergeCounts(report.week.byPageSource, report.since.byPageSource)),
    "",
    "New leads by source",
    ...table(["Source", weekLabel, sinceLabel], mergeCounts(report.week.newLeads, report.since.newLeads)),
    "",
    "Lifecycle emails sent by template",
    ...table(["Template", weekLabel, sinceLabel], mergeCounts(report.week.emailsSent, report.since.emailsSent)),
    "",
    `Share page views so far: ${report.shareViews}`,
    "",
  ];
  if (report.visitors) {
    lines.push(
      `Site visitors, ${weekLabel.toLowerCase()} (daily visitors added up, never joined to signups): ${report.visitors.visitors} visitors, ${report.visitors.pageViews} page views`,
    );
    if (report.visitors.topSources.length > 0) {
      lines.push(...table(["utm_source", "Visitors"], report.visitors.topSources.map((row) => [row.label, String(row.count)])));
    }
  } else {
    lines.push("Site visitors: the visitor count could not be read.");
  }
  lines.push(...quoteLines(report, weekLabel));
  if (report.claims && report.claims.length > 0) {
    // P18-04: each claimed signup by the store it was made for.
    lines.push("", `Prospect claims by store, ${sinceLabel.toLowerCase()}`, ...table(["Store", "Claims"], report.claims.map((row) => [row.label, String(row.count)])));
  }
  lines.push(
    "",
    "Gates (docs/marketing.md section 5.5), on the numbers since day 0",
    ...table(["Gate", "Measure", "Now", "Reading"], report.gates.map(gateLine), [0, 1, 3]),
    "",
    "The same counts by week are on /app/ops/funnel, and the saved SQL is in docs/LAUNCH_CHECKLIST.md.",
  );
  return { subject: `Curvi weekly funnel, week of ${longDate(weekOf)}`, text: `${lines.join("\n")}\n` };
}

export type SendFounderEmail = (email: FunnelDigestEmail) => Promise<{ ok: boolean; notice?: string; retryable?: boolean }>;

export type FunnelDigestOutcome =
  | { status: "not_due"; week: string }
  | { status: "already_sent"; week: string }
  | { status: "sent"; week: string; subject: string }
  | { status: "dry_run"; week: string; email: FunnelDigestEmail }
  | { status: "send_failed"; week: string; notice: string; retryable: boolean };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

/** Claims this ISO week for one send. True when this call took it. */
export async function claimDigestWeek(db: Db, week: string, now: Date): Promise<boolean> {
  const value = JSON.stringify({ week, claimedAt: now.toISOString() });
  const rows = rowsOf(
    await db.execute(sql`
      insert into platform_settings (key, value, updated_at)
      values (${FUNNEL_DIGEST_SETTING_KEY}, ${value}::jsonb, ${now.toISOString()}::timestamptz)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
      where platform_settings.value ->> 'week' is distinct from excluded.value ->> 'week'
      returning key
    `),
  );
  return rows.length > 0;
}

/** Gives a claimed week back after a failed send. */
export async function releaseDigestWeek(db: Db, week: string): Promise<void> {
  await db.execute(sql`
    delete from platform_settings where key = ${FUNNEL_DIGEST_SETTING_KEY} and value ->> 'week' = ${week}
  `);
}

/**
 * One cron call: not due yet, already sent this week, or claim, compose and
 * send. dryRun composes now whatever the schedule and claims nothing.
 */
export async function runFunnelDigest(
  db: Db,
  options: { now?: Date; dryRun?: boolean; operatorEmails?: readonly string[]; send: SendFounderEmail; extraSections?: () => Promise<string[]> },
): Promise<FunnelDigestOutcome> {
  const now = options.now ?? new Date();
  const week = isoWeekKey(now);
  if (options.dryRun) {
    const report = await loadFunnelReport(db, { now, operatorEmails: options.operatorEmails ?? [] });
    const email = composeFunnelDigest(report);
    if (options.extraSections) email.text += `${(await options.extraSections()).join("\n")}\n`;
    return { status: "dry_run", week, email };
  }
  if (!funnelDigestDue(now)) {
    return { status: "not_due", week };
  }
  if (!(await claimDigestWeek(db, week, now))) {
    return { status: "already_sent", week };
  }
  try {
    const report = await loadFunnelReport(db, { now, operatorEmails: options.operatorEmails ?? [] });
    const email = composeFunnelDigest(report);
    if (options.extraSections) email.text += `${(await options.extraSections()).join("\n")}\n`;
    const sent = await options.send(email);
    if (!sent.ok) {
      await releaseDigestWeek(db, week);
      return { status: "send_failed", week, notice: sent.notice ?? "The email was not sent.", retryable: sent.retryable ?? false };
    }
    return { status: "sent", week, subject: email.subject };
  } catch (err) {
    await releaseDigestWeek(db, week).catch(() => undefined);
    throw err;
  }
}

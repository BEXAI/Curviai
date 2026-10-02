import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@curvi/ui";
import type { CountRow, FunnelReport, FunnelWindowStats, GateReadout, Ratio, WeekRow } from "@/lib/funnel-report";

/**
 * The operator view of the server side funnel (/app/ops/funnel,
 * docs/phases/PHASE_18.md P18-02): the same counts as the weekly funnel
 * email, by week and by source. Server rendered tables, no chart library.
 * Counts only; nothing here names a person.
 */

export const FUNNEL_COPY = {
  title: "Funnel",
  intro:
    "Counted on the server from the funnel steps in the events table, whatever the visitor chose about cookies. Weeks run Monday to Sunday, UTC.",
  excluded: (n: number) =>
    n === 0
      ? "No workspace is left out. Workspaces owned by an email in OPS_EMAILS are left out once they exist."
      : `${n} workspace${n === 1 ? " is" : "s are"} left out because an operator email owns ${n === 1 ? "it" : "them"}.`,
  weekly: "By week",
  weeklyNote: "Confirmed signups and the first time each workspace reached a step.",
  funnel: "Last 7 days and since day 0",
  sources: "Confirmed signups by source, since day 0",
  gates: "Gates on the numbers since day 0",
  empty: "Nothing counted yet.",
  needsDatabase: "The funnel needs the database. Set DATABASE_URL and the Supabase keys, apply the migrations, and this page fills in.",
  unavailable: "The funnel could not be read just now. Reload the page in a minute.",
} as const;

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function ratio(value: Ratio): string {
  if (value.of === 0) {
    return "none yet";
  }
  return `${Math.round((value.hits / value.of) * 1000) / 10}% (${formatNumber(value.hits)} of ${formatNumber(value.of)})`;
}

function formatWeek(week: string): string {
  return new Date(`${week}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const ROWS: Array<[string, (stats: FunnelWindowStats) => string]> = [
  ["Confirmed signups", (s) => formatNumber(s.confirmedSignups)],
  ["First pack started", (s) => formatNumber(s.firstPacksStarted)],
  ["First pack done", (s) => formatNumber(s.firstPacksDone)],
  ["Activation of these signups", (s) => ratio(s.activation)],
  ["First download", (s) => formatNumber(s.firstDownloads)],
  ["Payments", (s) => formatNumber(s.payments)],
  ["First payments", (s) => formatNumber(s.firstPayments)],
  ["Paid, in US dollars", (s) => `$${s.paymentsUsd.toFixed(2)}`],
  ["Second pack within 30 days", (s) => ratio(s.repeat)],
  ["Share pages published", (s) => formatNumber(s.sharesPublished)],
  ["Leads left on free tools", (s) => formatNumber(s.leadsCaptured)],
  ["Feedback: usable as they are", (s) => ratio(s.feedback)],
  ["Free previews made", (s) => formatNumber(s.previewsMade)],
  ["Free previews claimed", (s) => formatNumber(s.previewsClaimed)],
  ["Prospect packs made", (s) => formatNumber(s.prospectPacks)],
  ["Prospect claims", (s) => formatNumber(s.claimsRedeemed)],
];

function FunnelTable({ report }: { report: FunnelReport }) {
  return (
    <Card data-testid="funnel-steps">
      <CardHeader>
        <CardTitle>{FUNNEL_COPY.funnel}</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-ink-500">
            <tr>
              <th className="py-1 font-medium">Step</th>
              <th className="py-1 text-right font-medium">Last 7 days</th>
              <th className="py-1 text-right font-medium">Since day 0</th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-ink-800">
            {ROWS.map(([label, pick]) => (
              <tr key={label} className="border-t border-ink-100">
                <td className="py-1.5 pr-2">{label}</td>
                <td className="py-1.5 text-right">{pick(report.week)}</td>
                <td className="py-1.5 text-right">{pick(report.since)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function WeeklyTable({ weekly }: { weekly: WeekRow[] }) {
  return (
    <Card data-testid="funnel-weekly">
      <CardHeader>
        <CardTitle>{FUNNEL_COPY.weekly}</CardTitle>
        <CardDescription>{FUNNEL_COPY.weeklyNote}</CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-ink-500">
            <tr>
              <th className="py-1 font-medium">Week of</th>
              <th className="py-1 text-right font-medium">Signups</th>
              <th className="py-1 text-right font-medium">First pack done</th>
              <th className="py-1 text-right font-medium">First download</th>
              <th className="py-1 text-right font-medium">First payment</th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-ink-800">
            {[...weekly].reverse().map((row) => (
              <tr key={row.week} className="border-t border-ink-100">
                <td className="py-1.5">{formatWeek(row.week)}</td>
                <td className="py-1.5 text-right">{formatNumber(row.signups)}</td>
                <td className="py-1.5 text-right">{formatNumber(row.firstPacksDone)}</td>
                <td className="py-1.5 text-right">{formatNumber(row.firstDownloads)}</td>
                <td className="py-1.5 text-right">{formatNumber(row.firstPayments)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SourceTable({ title, firstColumn, rows, testId }: { title: string; firstColumn: string; rows: CountRow[]; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-500">{FUNNEL_COPY.empty}</p>
        ) : (
          <table className="w-full table-fixed text-left text-sm">
            <thead className="text-xs text-ink-500">
              <tr>
                <th className="py-1 font-medium">{firstColumn}</th>
                <th className="w-20 py-1 text-right font-medium">Signups</th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-ink-800">
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-ink-100">
                  <td className="truncate py-1.5 pr-2 font-mono text-xs" title={row.label}>
                    {row.label}
                  </td>
                  <td className="py-1.5 text-right">{formatNumber(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

const GATE_WORDS: Record<GateReadout["state"], string> = {
  met: "Met",
  doubt: "Below the doubt line",
  too_early: "Too early to read",
  watch: "Between the lines",
};

function GateTable({ gates }: { gates: GateReadout[] }) {
  return (
    <Card data-testid="funnel-gates">
      <CardHeader>
        <CardTitle>{FUNNEL_COPY.gates}</CardTitle>
        <CardDescription>The dated decisions in docs/marketing.md section 5.5.</CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-ink-500">
            <tr>
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 font-medium">Measure</th>
              <th className="py-1 text-right font-medium">Now</th>
              <th className="py-1 text-right font-medium">Target</th>
              <th className="py-1 pl-3 font-medium">Reading</th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-ink-800">
            {gates.map(({ gate, value, state }) => {
              const unit = gate.unit === "percent" ? "%" : "";
              return (
                <tr key={gate.key} className="border-t border-ink-100">
                  <td className="py-1.5">{gate.day}</td>
                  <td className="py-1.5 pr-2">{gate.label}</td>
                  <td className="py-1.5 text-right">{`${value}${unit}`}</td>
                  <td className="py-1.5 text-right">{`${gate.target}${unit}`}</td>
                  <td className="py-1.5 pl-3">{GATE_WORDS[state]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export function FunnelHeader({ excluded }: { excluded?: number }) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-950">{FUNNEL_COPY.title}</h1>
      <p className="mt-1 text-sm text-ink-500">{FUNNEL_COPY.intro}</p>
      {excluded !== undefined ? <p className="mt-1 text-sm text-ink-500">{FUNNEL_COPY.excluded(excluded)}</p> : null}
    </div>
  );
}

/** Shown to an operator when there is no database or the read failed. */
export function FunnelNotice({ message }: { message: string }) {
  return (
    <div className="max-w-3xl space-y-6">
      <FunnelHeader />
      <Card>
        <CardContent className="pt-6 text-sm text-ink-600">{message}</CardContent>
      </Card>
    </div>
  );
}

export function FunnelDashboard({ report }: { report: FunnelReport }) {
  return (
    <div className="max-w-5xl space-y-6" data-testid="funnel-dashboard">
      <FunnelHeader excluded={report.excludedWorkspaces} />
      <div className="grid gap-6 lg:grid-cols-2">
        <FunnelTable report={report} />
        <div className="space-y-6">
          <WeeklyTable weekly={report.weekly} />
          <GateTable gates={report.gates} />
        </div>
      </div>
      <h2 className="text-lg font-semibold text-ink-950">{FUNNEL_COPY.sources}</h2>
      <div className="grid gap-6 lg:grid-cols-3">
        <SourceTable title="How they heard" firstColumn="Answer" rows={report.since.bySelfReported} testId="funnel-self-reported" />
        <SourceTable title="utm_source" firstColumn="utm_source" rows={report.since.byUtmSource} testId="funnel-utm-source" />
        <SourceTable title="Page of the signup link" firstColumn="Page" rows={report.since.byPageSource} testId="funnel-page-source" />
      </div>
    </div>
  );
}

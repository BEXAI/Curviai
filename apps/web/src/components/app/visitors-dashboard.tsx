import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@curvi/ui";
import type { DayCount, RangeCount, TopRow, VisitorStats } from "@/lib/visits/stats";

/**
 * The operator view of the cookieless visitor count (/app/ops/visitors).
 * Server rendered, no chart library: the daily chart is a row of columns
 * with a hover or focus tooltip, and the same numbers sit in a table below.
 * One series, so one color (teal, checked against the night surface); text
 * stays in the ink colors.
 */

export const VISITORS_COPY = {
  title: "Site visitors",
  intro: "Counted on this site without cookies. Days run from midnight to midnight UTC.",
  rangeNote:
    "Each visitor gets a new code every day, so someone who comes back on another day counts again, and a total for several days is the daily visitors added up.",
  addedUp: "Daily visitors, added up",
  chartTitle: "Daily visitors, last 30 days",
  showNumbers: "Show the numbers by day",
  empty: "Nothing counted yet.",
  needsDatabase:
    "Visitor counts need the database. Set DATABASE_URL and the Supabase keys, apply migration 0027, and this page fills in as people visit.",
  unavailable: "The counts could not be read just now. Reload the page in a minute.",
} as const;

const BAR_COLOR = "bg-[#0d9488]";
const BAR_HOVER = "group-hover:bg-[#2dd4bf] group-focus-visible:bg-[#2dd4bf]";

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function plural(value: number, one: string, many: string): string {
  return `${formatNumber(value)} ${value === 1 ? one : many}`;
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A round number at or above value for the top of the axis: 1, 2 or 5 times a power of ten. */
export function niceCeiling(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= value) {
      return step * power;
    }
  }
  return 10 * power;
}

function RangeTile({ range }: { range: RangeCount }) {
  const severalDays = range.key === "last7" || range.key === "last30";
  return (
    <Card data-testid={`visitors-range-${range.key}`}>
      <CardHeader className="gap-2 pb-2">
        <CardDescription>{range.label}</CardDescription>
        <p className="text-3xl font-semibold text-ink-950">{formatNumber(range.visitors)}</p>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-ink-500">
        <p>{severalDays ? VISITORS_COPY.addedUp : range.visitors === 1 ? "Visitor" : "Visitors"}</p>
        <p>{plural(range.pageViews, "page view", "page views")}</p>
      </CardContent>
    </Card>
  );
}

function DailyChart({ daily }: { daily: DayCount[] }) {
  const peak = daily.reduce((best, d) => (d.visitors > best.visitors ? d : best), daily[0] ?? { day: "", visitors: 0, pageViews: 0 });
  const top = niceCeiling(peak.visitors);
  const ticks = [daily[0], daily[Math.floor(daily.length / 2)], daily[daily.length - 1]].filter(
    (d): d is DayCount => Boolean(d),
  );
  const summary =
    peak.visitors > 0
      ? `Daily visitors for the last ${daily.length} days. The busiest day was ${formatDay(peak.day)} with ${plural(peak.visitors, "visitor", "visitors")}.`
      : `Daily visitors for the last ${daily.length} days. ${VISITORS_COPY.empty}`;
  return (
    <figure className="space-y-2" data-testid="visitors-daily-chart">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="flex gap-3">
        <div className="flex h-48 flex-col justify-between text-right font-mono text-xs tabular-nums text-ink-500" aria-hidden="true">
          <span>{formatNumber(top)}</span>
          <span>0</span>
        </div>
        <div className="relative h-48 flex-1">
          <div className="absolute inset-x-0 top-0 border-t border-ink-100" aria-hidden="true" />
          <div className="absolute inset-x-0 bottom-0 border-t border-ink-200" aria-hidden="true" />
          <ol className="relative flex h-full items-end gap-[2px]">
            {daily.map((d) => {
              const height = d.visitors > 0 ? Math.max(1.5, (d.visitors / top) * 100) : 0;
              const label = `${formatDay(d.day)}: ${plural(d.visitors, "visitor", "visitors")}, ${plural(d.pageViews, "page view", "page views")}`;
              return (
                <li
                  key={d.day}
                  tabIndex={0}
                  aria-label={label}
                  className="group relative flex h-full flex-1 items-end justify-center outline-none"
                >
                  <span
                    className={`block w-full max-w-6 rounded-t-[4px] ${BAR_COLOR} ${BAR_HOVER}`}
                    style={{ height: `${height}%` }}
                    aria-hidden="true"
                  />
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-ink-100 bg-night px-2.5 py-1.5 text-xs text-ink-900 shadow-lg group-hover:block group-focus-visible:block"
                  >
                    {label}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <div className="flex justify-between pl-8 font-mono text-xs text-ink-500" aria-hidden="true">
        {ticks.map((d) => (
          <span key={d.day}>{formatDay(d.day)}</span>
        ))}
      </div>
    </figure>
  );
}

function DailyTable({ daily }: { daily: DayCount[] }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium text-ink-700">{VISITORS_COPY.showNumbers}</summary>
      <table className="mt-3 w-full text-left">
        <thead className="text-xs text-ink-500">
          <tr>
            <th className="py-1 font-medium">Day</th>
            <th className="py-1 text-right font-medium">Visitors</th>
            <th className="py-1 text-right font-medium">Page views</th>
          </tr>
        </thead>
        <tbody className="tabular-nums text-ink-800">
          {[...daily].reverse().map((d) => (
            <tr key={d.day} className="border-t border-ink-100">
              <td className="py-1">{formatDay(d.day)}</td>
              <td className="py-1 text-right">{formatNumber(d.visitors)}</td>
              <td className="py-1 text-right">{formatNumber(d.pageViews)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function TopTable({
  title,
  description,
  rows,
  firstColumn,
  testId,
  showPageViews = true,
}: {
  title: string;
  description: string;
  rows: TopRow[];
  firstColumn: string;
  testId: string;
  showPageViews?: boolean;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-500">{VISITORS_COPY.empty}</p>
        ) : (
          <table className="w-full table-fixed text-left text-sm">
            <thead className="text-xs text-ink-500">
              <tr>
                <th className="py-1 font-medium">{firstColumn}</th>
                <th className="w-20 py-1 text-right font-medium">Visitors</th>
                {showPageViews ? <th className="w-24 py-1 text-right font-medium">Page views</th> : null}
              </tr>
            </thead>
            <tbody className="tabular-nums text-ink-800">
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-ink-100">
                  <td className="truncate py-1.5 pr-2 font-mono text-xs" title={row.label}>
                    {row.label}
                  </td>
                  <td className="py-1.5 text-right">{formatNumber(row.visitors)}</td>
                  {showPageViews ? <td className="py-1.5 text-right">{formatNumber(row.pageViews)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

const DEVICE_NAMES: Record<string, string> = { mobile: "Phone", tablet: "Tablet", desktop: "Computer" };

function DeviceSplit({ devices }: { devices: TopRow[] }) {
  const total = devices.reduce((n, d) => n + d.visitors, 0);
  return (
    <Card data-testid="visitors-devices">
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <CardDescription>Last 30 days, daily visitors added up.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {devices.length === 0 || total === 0 ? (
          <p className="text-sm text-ink-500">{VISITORS_COPY.empty}</p>
        ) : (
          devices.map((d) => {
            const share = Math.round((d.visitors / total) * 100);
            return (
              <div key={d.label} className="space-y-1">
                <div className="flex justify-between text-sm text-ink-800">
                  <span>{DEVICE_NAMES[d.label] ?? d.label}</span>
                  <span className="tabular-nums">
                    {formatNumber(d.visitors)} ({share}%)
                  </span>
                </div>
                <div className="h-2 rounded-full bg-ink-100" aria-hidden="true">
                  <div className={`h-2 rounded-full ${BAR_COLOR}`} style={{ width: `${Math.max(share, 1)}%` }} />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export function VisitorsHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink-950">{VISITORS_COPY.title}</h1>
      <p className="mt-1 text-sm text-ink-500">{VISITORS_COPY.intro}</p>
    </div>
  );
}

/** Shown to an operator when there is no database to read. */
export function VisitorsNotice({ message }: { message: string }) {
  return (
    <div className="max-w-3xl space-y-6">
      <VisitorsHeader />
      <p className="text-sm text-ink-700" data-testid="visitors-notice">
        {message}
      </p>
    </div>
  );
}

export function VisitorsDashboard({ stats }: { stats: VisitorStats }) {
  return (
    <div className="space-y-8" data-testid="visitors-dashboard">
      <VisitorsHeader />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.ranges.map((range) => (
          <RangeTile key={range.key} range={range} />
        ))}
      </div>
      <p className="max-w-3xl text-sm text-ink-600" data-testid="visitors-range-note">
        {VISITORS_COPY.rangeNote}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>{VISITORS_COPY.chartTitle}</CardTitle>
          <CardDescription>Hover or focus a day to see its numbers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DailyChart daily={stats.daily} />
          <DailyTable daily={stats.daily} />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopTable
          title="Top pages"
          description="Last 30 days. Ids in addresses show as :id."
          rows={stats.topPages}
          firstColumn="Page"
          testId="visitors-top-pages"
        />
        <TopTable
          title="Sites that sent visitors"
          description="Last 30 days, from the first page of each visit."
          rows={stats.topReferrers}
          firstColumn="Site"
          testId="visitors-top-referrers"
          showPageViews={false}
        />
        <TopTable
          title="Campaign sources"
          description="Last 30 days, from utm_source in the link."
          rows={stats.topSources}
          firstColumn="Source"
          testId="visitors-top-sources"
          showPageViews={false}
        />
        <TopTable
          title="Campaigns"
          description="Last 30 days, from utm_campaign in the link."
          rows={stats.topCampaigns}
          firstColumn="Campaign"
          testId="visitors-top-campaigns"
          showPageViews={false}
        />
        <DeviceSplit devices={stats.devices} />
      </div>
    </div>
  );
}

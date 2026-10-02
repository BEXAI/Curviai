/**
 * Unit economics reads (docs/phases/PHASE_20.md P20-04): the database side
 * of `pnpm report:unit-economics`, later also P20-48's economics page and
 * P20-38's weekly report. Read only, in one READ ONLY transaction on the
 * owner connection; the math is in @curvi/pipeline/economics.
 *
 * - Delivered shots: approved assets of packs that finished (`done`), with
 *   the shot's method, metered cost and attempts from `assets.qc` (the qc
 *   row carries the planned shot, so the exact method; job_steps carries
 *   only a stage label).
 * - Undelivered shots: every other asset of a pack in the window, whose
 *   cost was spent but not charged.
 * - Packs: `generation_jobs.cogs_micros` (all metered provider spend at list
 *   price) and `credits_charged`, with the pack's LLM cost per provider
 *   family from the `llm|job|<job>|<family>|cost_micros` counters, so the
 *   report can show the cost while a provider credit pays for that family.
 * - Stages: `job_steps.cost_micros` summed by stage and status.
 */

import { sql, type Db } from "@curvi/db";
import {
  buildEconomicsReport,
  type Distribution,
  type EconomicsInputs,
  type EconomicsReport,
} from "@curvi/pipeline/economics";
import { customerWorkspace, operatorWorkspaceIds } from "@/lib/customer-metrics";
import { creditCosts, llmCreditWindows, type LlmCreditWindow } from "@curvi/pipeline/seed";

/** postgres-js returns the rows as an array, PGlite as { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

export interface EconomicsWindow {
  since: Date;
  until: Date;
}

/** Reads every input the report needs for packs created in the window. */
export async function loadEconomicsInputs(db: Db, window: EconomicsWindow): Promise<EconomicsInputs> {
  const excluded = await operatorWorkspaceIds(db);
  const customer = (column: ReturnType<typeof sql>) => customerWorkspace(excluded, column);
  const since = window.since.toISOString();
  const until = window.until.toISOString();
  return db.transaction(
    async (tx) => {
      const assetRows = rowsOf<{
        job_id: string;
        method: string | null;
        cost_micros: string | number | null;
        attempts: string | number | null;
        delivered: boolean;
      }>(
        await tx.execute(sql`
          select a.job_id::text as job_id,
                 a.qc->'shot'->>'method' as method,
                 coalesce(nullif(a.qc->>'costMicros', '')::numeric, 0) as cost_micros,
                 coalesce(nullif(a.qc->>'attempts', '')::numeric, 1) as attempts,
                 (a.approved and j.status = 'done') as delivered
          from assets a
          join generation_jobs j on j.id = a.job_id
          where ${customer(sql`j.workspace_id`)} and j.created_at >= ${since}::timestamptz and j.created_at < ${until}::timestamptz`),
      );
      const packRows = rowsOf<{ id: string; cogs_micros: string | number; credits_charged: string | number }>(
        await tx.execute(sql`
          select id::text as id, cogs_micros, credits_charged
          from generation_jobs
          where ${customer(sql`workspace_id`)} and status = 'done' and created_at >= ${since}::timestamptz and created_at < ${until}::timestamptz`),
      );
      const llmRows = rowsOf<{ job_id: string; family: string; total_micros: string | number }>(
        await tx.execute(sql`
          select split_part(c.key, '|', 3) as job_id, split_part(c.key, '|', 4) as family, c.total_micros
          from spend_cap_counters c
          join generation_jobs j on j.id::text = split_part(c.key, '|', 3)
          where ${customer(sql`j.workspace_id`)} and c.key like ${"llm|job|%"}
            and j.status = 'done' and j.created_at >= ${since}::timestamptz and j.created_at < ${until}::timestamptz`),
      );
      const stageRows = rowsOf<{ stage: string | null; status: string | null; rows: string | number; cost_micros: string | number }>(
        await tx.execute(sql`
          select s.stage, s.status, count(*) as rows, coalesce(sum(s.cost_micros), 0) as cost_micros
          from job_steps s
          join generation_jobs j on j.id = s.job_id
          where ${customer(sql`j.workspace_id`)} and j.created_at >= ${since}::timestamptz and j.created_at < ${until}::timestamptz and s.cost_micros > 0
          group by s.stage, s.status
          order by 4 desc, 1, 2`),
      );

      const llmByJob = new Map<string, Record<string, number>>();
      for (const row of llmRows) {
        const families = llmByJob.get(row.job_id) ?? {};
        families[row.family] = (families[row.family] ?? 0) + Number(row.total_micros);
        llmByJob.set(row.job_id, families);
      }
      return {
        shots: assetRows
          .filter((row) => row.delivered)
          .map((row) => ({
            jobId: row.job_id,
            method: row.method,
            costMicros: Number(row.cost_micros ?? 0),
            attempts: Math.max(1, Number(row.attempts ?? 1)),
          })),
        undelivered: assetRows
          .filter((row) => !row.delivered)
          .map((row) => ({ jobId: row.job_id, costMicros: Number(row.cost_micros ?? 0) })),
        packs: packRows.map((row) => ({
          jobId: row.id,
          cogsMicros: Number(row.cogs_micros),
          creditsCharged: Number(row.credits_charged),
          llmMicrosByFamily: llmByJob.get(row.id) ?? {},
        })),
        stages: stageRows.map((row) => ({
          stage: row.stage ?? "unknown",
          status: row.status ?? "unknown",
          rows: Number(row.rows),
          costMicros: Number(row.cost_micros),
        })),
      };
    },
    { accessMode: "read only" },
  );
}

/** Provider families whose credit still pays for their LLM calls on `now`'s
 * UTC day (seed llmCreditWindows). */
export function creditFamiliesOn(now: Date, windows: readonly LlmCreditWindow[] = llmCreditWindows): string[] {
  const day = now.toISOString().slice(0, 10);
  return windows.filter((window) => day <= window.expiresOn).map((window) => window.family);
}

/** The report for the last `days` days. */
export async function unitEconomicsReport(db: Db, days: number, now: Date = new Date()): Promise<EconomicsReport> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const inputs = await loadEconomicsInputs(db, { since, until: now });
  return buildEconomicsReport(inputs, {
    days,
    creditFamilies: creditFamiliesOn(now),
    currentCreditsPerStill: creditCosts.generativeStill,
  });
}

function money(value: number | null): string {
  if (value === null) return "none";
  return `$${value.toFixed(value !== 0 && Math.abs(value) < 1 ? 4 : 2)}`;
}

function pct(value: number | null): string {
  return value === null ? "none" : `${Math.round(value * 100)} percent`;
}

function dist(value: Distribution, format: (n: number | null) => string = money): string {
  if (value.count === 0) return "no data";
  return `n ${value.count}, p50 ${format(value.p50)}, p90 ${format(value.p90)}, mean ${format(value.mean)}`;
}

function credits(value: number | null): string {
  return value === null ? "none" : `${value} ${value === 1 ? "credit" : "credits"}`;
}

/** The report as lines for the terminal. */
export function formatUnitEconomicsReport(report: EconomicsReport): string[] {
  const lines: string[] = [];
  lines.push(`Unit economics, packs created in the last ${report.days} days. Read only.`);
  lines.push(
    report.creditFamilies.length
      ? `LLM cost of ${report.creditFamilies.join(", ")} is paid from a provider credit today, so packs are shown at list price and with that cost at zero.`
      : "No provider credit applies today; costs are at list price.",
  );
  lines.push("");
  lines.push("Cost per delivered shot, by method:");
  if (report.perShotByMethod.length === 0) lines.push("  no delivered shots");
  for (const row of report.perShotByMethod) {
    lines.push(`  ${row.method}: ${dist(row.usd)}`);
  }
  lines.push(`  Generative stills: ${dist(report.generativeStill)}`);
  lines.push("");
  lines.push("Cost per pack:");
  lines.push(`  At list price: ${dist(report.perPack.atListPrice)}`);
  lines.push(`  With the provider credit: ${dist(report.perPack.withCredit)}`);
  lines.push(`  Credits charged: ${dist(report.perPack.creditsCharged, (n) => (n === null ? "none" : String(Math.round(n * 10) / 10)))}`);
  lines.push(`  Gross margin per pack at the floor price: ${dist(report.packMarginAtFloor, pct)}`);
  lines.push("");
  lines.push("Retry overhead:");
  lines.push(`  Delivered shots: ${report.retry.deliveredShots}`);
  lines.push(`  Needed more than one attempt: ${pct(report.retry.retriedShare)}`);
  lines.push(`  Mean attempts: ${report.retry.meanAttempts === null ? "none" : report.retry.meanAttempts.toFixed(2)}`);
  lines.push(`  Cost of shots not delivered (not charged): ${pct(report.retry.undeliveredCostShare)} of all shot cost`);
  lines.push("");
  lines.push("Cost by stage (job_steps):");
  if (report.stages.length === 0) lines.push("  no metered steps");
  for (const stage of report.stages) {
    lines.push(`  ${stage.stage} ${stage.status}: ${stage.rows} rows, ${money(stage.costMicros / 1_000_000)}`);
  }
  lines.push("");
  lines.push("Revenue per credit (before the payment fee, after it):");
  for (const offer of report.offers) {
    lines.push(
      `  ${offer.label}: ${money(offer.revenuePerCredit)}, ${money(offer.netRevenuePerCredit)}${offer.selfServe ? "" : " (not self serve)"}`,
    );
  }
  lines.push(`  Floor: ${report.floor.gross.label} at ${money(report.floor.gross.revenuePerCredit)} a credit.`);
  lines.push(
    `  After the payment fee the lowest is ${report.floor.net.label} at ${money(report.floor.net.netRevenuePerCredit)} a credit.`,
  );
  lines.push("");
  lines.push("Price rule for a generative still (decision 2):");
  lines.push(`  Target gross margin: ${pct(report.rule.targetGrossMargin)}. Today a still costs ${credits(report.rule.currentCreditsPerStill)}.`);
  if (report.rule.fromGrossFloor === null) {
    lines.push(
      "  No generative still was delivered in the window, so the rule has no p90. Run the golden set live, or widen --days.",
    );
  } else {
    lines.push(
      `  p90 ${money(report.generativeStill.p90)} over ${money(report.floor.gross.revenuePerCredit)} times ${1 - report.rule.targetGrossMargin} gives ${credits(report.rule.fromGrossFloor)} a still.`,
    );
    lines.push(`  At the floor after the payment fee it would be ${credits(report.rule.fromNetFloor)}.`);
    lines.push(`  Gross margin of a still at today's price and the floor: ${pct(report.rule.marginAtCurrentPrice)}.`);
  }
  lines.push("");
  lines.push(
    "This report changes nothing. A reprice changes only creditCosts, tiers and topUps in packages/pipeline/src/seed/credits.ts and the docs/STRIPE_SETUP.md table.",
  );
  return lines;
}

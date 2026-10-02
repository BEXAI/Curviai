/** Bounded owner-side telemetry for the tick's optional cap and margin rules. */
import { sql, type Db } from "@curvi/db";
import { grossMargin, priceFloor } from "@curvi/pipeline/economics";
import { costCaps, opsAlertPolicy } from "@curvi/pipeline/seed";
import { customerWorkspace, operatorWorkspaceIds } from "@/lib/customer-metrics";
import type { OpsAlertSignals } from "./alerts";

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];

export async function readOpsAlertSignals(db: Db, now: Date, deadline: Date): Promise<Pick<OpsAlertSignals, "workspaceCaps" | "shotMargins">> {
  const remaining = deadline.getTime() - Date.now();
  if (remaining <= 0) throw new Error("No tick budget remains for alert telemetry.");
  const excluded = await operatorWorkspaceIds(db);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(remaining)}, true)`);
    const caps = rowsOf<{ workspace_id: string; plan: string; total_micros: string | number }>(await tx.execute(sql`
      select w.id::text as workspace_id, w.plan, c.total_micros
      from spend_cap_counters c join workspaces w
      on c.key = 'caps:workspace:' || w.id::text || ':' || ${now.toISOString().slice(0, 10)}`));
    const assets = rowsOf<{ shot_type: string; delivered: boolean; cost_micros: unknown; credits: unknown }>(await tx.execute(sql`
      select a.shot_type, (a.approved and j.status = 'done') as delivered,
        a.qc->>'costMicros' as cost_micros, a.qc->'shot'->>'credits' as credits
      from assets a join generation_jobs j on j.id = a.job_id and j.workspace_id = a.workspace_id
      where ${customerWorkspace(excluded, sql`j.workspace_id`)} and j.status in ('done', 'failed', 'canceled')
        and coalesce(j.finished_at, j.updated_at) >= ${new Date(now.getTime() - opsAlertPolicy.marginWindowDays * 86_400_000).toISOString()}::timestamptz
        and coalesce(j.finished_at, j.updated_at) < ${now.toISOString()}::timestamptz`));
    const amounts = new Map<string, { costMicros: number; credits: number; known: boolean }>();
    for (const asset of assets) {
      const total = amounts.get(asset.shot_type) ?? { costMicros: 0, credits: 0, known: true };
      const cost = asset.cost_micros == null ? NaN : Number(asset.cost_micros);
      const credits = asset.delivered ? asset.credits == null ? NaN : Number(asset.credits) : 0;
      if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(credits) || credits < 0) total.known = false;
      else { total.costMicros += cost; total.credits += credits; }
      amounts.set(asset.shot_type, total);
    }
    const netPerCredit = priceFloor().net.netRevenuePerCredit;
    const shotMargins = [...amounts].map(([shotType, total]) => ({
      shotType,
      grossMargin: total.known ? grossMargin(total.credits * netPerCredit, total.costMicros / 1e6) : null,
    }));
    return {
      workspaceCaps: caps.map((row) => ({
        workspaceId: row.workspace_id,
        usedMicros: Number(row.total_micros),
        limitMicros: (costCaps.workspaceExpectedDailyMicrosByTier[row.plan as keyof typeof costCaps.workspaceExpectedDailyMicrosByTier]
          ?? costCaps.workspaceExpectedDailyMicrosByTier.free) * costCaps.workspaceDailyMultiplier,
      })),
      // An incomplete window cannot establish that any old margin alert has
      // recovered. Omitting the signal preserves those rules unchanged.
      ...(shotMargins.every((sample) => sample.grossMargin !== null)
        ? { shotMargins: shotMargins.map((sample) => ({ ...sample, grossMargin: sample.grossMargin! })) }
        : {}),
    };
  }, { accessMode: "read only" });
}

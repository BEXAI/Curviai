import { creditPlanningPolicy } from "@curvi/pipeline/seed";
import { sql, type Db } from "@curvi/db";

export interface CreditBudgetView {
  periodStart: string;
  periodEnd: string;
  monthlyLimit: number | null;
  consumed: number;
  held: number;
  remaining: number | null;
}
export interface CreditPlanningView {
  available: number;
  budget: CreditBudgetView;
  observation: { from: string; to: string; days: number; consumed: number; returned: number; activeDays: number };
  projection: { monthTotal: number | null; reason: "insufficient_history" | "estimate" };
}
interface BudgetRow {
  period_start: string | Date; period_end: string | Date; monthly_limit: string | number | null;
  consumed: string | number; held: string | number; remaining: string | number | null;
}
interface PlanningRow extends BudgetRow {
  available: string | number; observed_consumed: string | number; returned: string | number;
  active_days: number | string; first_charge: Date | string | null; last_charge: Date | string | null;
  workspace_created_at: Date | string; observed_from: Date | string; observed_to: Date | string;
}
function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows?: T[] })?.rows ?? []) as T[];
}
const credits = (value: string | number): number => Math.round(Number(value) * 10) / 10;
const iso = (value: string | Date): string => new Date(value).toISOString();
function budgetOf(row: BudgetRow): CreditBudgetView {
  return {
    periodStart: iso(row.period_start), periodEnd: iso(row.period_end),
    monthlyLimit: row.monthly_limit === null ? null : credits(row.monthly_limit),
    consumed: credits(row.consumed), held: credits(row.held),
    remaining: row.remaining === null ? null : credits(row.remaining),
  };
}
/** Authoritative accounting also used by reserve_credits while it owns the workspace lock. */
export async function readCreditBudget(db: Db, workspaceId: string): Promise<CreditBudgetView> {
  const [row] = rowsOf<BudgetRow>(await db.execute(sql`select * from workspace_credit_budget_snapshot(${workspaceId}::uuid)`));
  if (!row) throw new Error("Credit budget could not be read.");
  return budgetOf(row);
}

/** Route authentication supplies workspace and actor; the SQL setter checks owner membership again. */
export async function setCreditBudget(db: Db, workspaceId: string, actorId: string, monthlyLimit: number | null): Promise<void> {
  await db.execute(sql`select set_workspace_credit_budget(${workspaceId}::uuid, ${actorId}::uuid, ${monthlyLimit}::numeric)`);
}

export function planningOf(row: PlanningRow): CreditPlanningView {
  const budget = budgetOf(row);
  const to = new Date(row.observed_to).getTime();
  const from = Math.max(new Date(row.observed_from).getTime(), new Date(row.workspace_created_at).getTime());
  const days = Math.max(0, (to - from) / 86_400_000);
  const activitySpan = row.first_charge && row.last_charge
    ? (new Date(row.last_charge).getTime() - new Date(row.first_charge).getTime()) / 86_400_000 : 0;
  const sufficient = days >= creditPlanningPolicy.minimumHistoryDays &&
    Number(row.active_days) >= creditPlanningPolicy.minimumActiveDays &&
    activitySpan >= creditPlanningPolicy.minimumActivitySpanDays;
  const consumed = credits(row.observed_consumed);
  const remainingDays = Math.max(0, (new Date(budget.periodEnd).getTime() - to) / 86_400_000);
  return {
    available: credits(row.available), budget,
    observation: { from: iso(new Date(from)), to: iso(row.observed_to), days: Math.floor(days), consumed,
      returned: Math.max(0, credits(row.returned)), activeDays: Number(row.active_days) },
    projection: { reason: sufficient ? "estimate" : "insufficient_history",
      monthTotal: sufficient ? Math.round(budget.consumed + consumed / days * remainingDays) : null },
  };
}

/** Read raw movements, never the grouped history net. A delivered charge has
 * a paired release; subtracting charges from releases counts only real returns.
 * The paired rows have the same transaction timestamp, so window boundaries
 * cannot split them. All aggregates stay scoped to this workspace. */
export async function readCreditPlanning(db: Db, workspaceId: string): Promise<CreditPlanningView> {
  const [row] = rowsOf<PlanningRow>(await db.execute(sql`
    select b.*, w.created_at as workspace_created_at, now() as observed_to,
      now() - (${creditPlanningPolicy.observationDays * 24} * interval '1 hour') as observed_from,
      coalesce(l.available, 0) as available, coalesce(l.observed_consumed, 0) as observed_consumed,
      coalesce(l.returned, 0) as returned, coalesce(l.active_days, 0) as active_days,
      l.first_charge, l.last_charge
    from workspaces w cross join lateral workspace_credit_budget_snapshot(w.id) b
    cross join lateral (
      select sum(delta) as available,
        -sum(delta) filter (where reason = 'charge' and created_at >= now() - (${creditPlanningPolicy.observationDays * 24} * interval '1 hour')) as observed_consumed,
        sum(delta) filter (where reason in ('charge', 'release') and created_at >= now() - (${creditPlanningPolicy.observationDays * 24} * interval '1 hour')) as returned,
        count(distinct (created_at at time zone 'UTC')::date) filter (where reason = 'charge' and created_at >= now() - (${creditPlanningPolicy.observationDays * 24} * interval '1 hour')) as active_days,
        min(created_at) filter (where reason = 'charge' and created_at >= now() - (${creditPlanningPolicy.observationDays * 24} * interval '1 hour')) as first_charge,
        max(created_at) filter (where reason = 'charge' and created_at >= now() - (${creditPlanningPolicy.observationDays * 24} * interval '1 hour')) as last_charge
      from credit_ledger where workspace_id = w.id and created_at <= now()
    ) l where w.id = ${workspaceId}::uuid
  `));
  if (!row) throw new Error("Credit planning could not be read.");
  return planningOf(row);
}

/** A demo is read only and clearly labeled by the component. */
export function demoCreditPlanning(available: number, now = new Date()): CreditPlanningView {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    available, budget: { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), monthlyLimit: null, consumed: 0, held: 0, remaining: null },
    observation: { from: now.toISOString(), to: now.toISOString(), days: 0, consumed: 0, returned: 0, activeDays: 0 },
    projection: { monthTotal: null, reason: "insufficient_history" },
  };
}

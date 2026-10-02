/**
 * Prospect credits (docs/phases/PHASE_18.md P18-04): the operator adds
 * credits to their own workspace for prospect packs, written as an ordinary
 * `grant` ledger row with source `system`, never more than the seeded
 * staffMonthlyCreditCap per calendar month (UTC). Each addition also writes
 * an `ops:prospect_credits` events row, which is what the cap counts, so
 * other system grants never use it up. One transaction holds the workspace
 * row lock, so two additions at once cannot both pass the cap. Server only;
 * the routes check isOperator first. Clients cannot write ops:% events
 * (events_insert_member refuses the prefix, migration attribution_and_funnel),
 * and the sum counts only positive numbers as a second layer.
 */

import { creditLedger, events, sql, type Db } from "@curvi/db";
import { prospectClaims, staffMonthlyCreditCap } from "@curvi/pipeline/seed";
import { isUuid } from "@/lib/validation/ids";

export const PROSPECT_CREDITS_EVENT = "ops:prospect_credits";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

/** The calendar month (UTC) holding now, as [start, next start). */
export function monthWindow(now: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}

type Reader = Pick<Db, "execute">;

/** Prospect credits added to this workspace in now's calendar month. */
export async function prospectCreditsUsed(db: Reader, workspaceId: string, now: Date): Promise<number> {
  if (!isUuid(workspaceId)) {
    return 0;
  }
  const { from, to } = monthWindow(now);
  const rows = rowsOf<{ used: string | number | null }>(
    await db.execute(sql`
      select coalesce(sum(
        case when jsonb_typeof(props -> 'credits') = 'number' then greatest((props ->> 'credits')::numeric, 0) else 0 end
      ), 0) as used
      from events
      where workspace_id = ${workspaceId}::uuid
        and name = ${PROSPECT_CREDITS_EVENT}
        and at >= ${from.toISOString()}::timestamptz
        and at < ${to.toISOString()}::timestamptz
    `),
  );
  const used = Number(rows[0]?.used ?? 0);
  return Number.isFinite(used) ? used : 0;
}

export interface ProspectCreditStatus {
  usedThisMonth: number;
  cap: number;
}

export async function prospectCreditStatus(db: Reader, workspaceId: string, now: Date): Promise<ProspectCreditStatus> {
  return { usedThisMonth: await prospectCreditsUsed(db, workspaceId, now), cap: staffMonthlyCreditCap };
}

export type AddCreditsResult =
  | { outcome: "added"; credits: number; status: ProspectCreditStatus }
  | { outcome: "over_cap"; left: number; status: ProspectCreditStatus }
  | { outcome: "invalid" };

/** True for a whole number from 1 to prospectClaims.maxCreditsPerAdd. */
export function validCreditAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= prospectClaims.maxCreditsPerAdd;
}

export async function addProspectCredits(
  db: Db,
  input: { workspaceId: string; userId: string; credits: number; now: Date },
): Promise<AddCreditsResult> {
  if (!validCreditAmount(input.credits) || !isUuid(input.workspaceId)) {
    return { outcome: "invalid" };
  }
  return db.transaction(async (tx) => {
    // Serialize additions per workspace for the cap check.
    await tx.execute(sql`select id from workspaces where id = ${input.workspaceId}::uuid for update`);
    const used = await prospectCreditsUsed(tx, input.workspaceId, input.now);
    if (used + input.credits > staffMonthlyCreditCap) {
      return {
        outcome: "over_cap" as const,
        left: Math.max(0, staffMonthlyCreditCap - used),
        status: { usedThisMonth: used, cap: staffMonthlyCreditCap },
      };
    }
    await tx.insert(creditLedger).values({
      workspaceId: input.workspaceId,
      delta: input.credits,
      reason: "grant",
      source: "system",
      createdAt: input.now,
    });
    await tx.insert(events).values({
      workspaceId: input.workspaceId,
      name: PROSPECT_CREDITS_EVENT,
      props: { credits: input.credits, by: input.userId },
      at: input.now,
    });
    return {
      outcome: "added" as const,
      credits: input.credits,
      status: { usedThisMonth: used + input.credits, cap: staffMonthlyCreditCap },
    };
  });
}

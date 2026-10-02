/**
 * Prospect claims in the weekly funnel email (docs/phases/PHASE_18.md
 * P18-04 acceptance: "a claimed signup appears in the funnel email as
 * concierge with its prospect label"). The signup itself is counted under
 * the concierge page source; this lists the redeemed claims by store, from
 * funnel.claim_redeemed's campaign prop (the store name as a slug). Server
 * only.
 */

import { sql, type Db } from "@curvi/db";

export interface ClaimCountRow {
  label: string;
  count: number;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

export async function claimsByCampaign(
  db: Pick<Db, "execute">,
  window: { from: Date; to: Date },
  limit: number,
): Promise<ClaimCountRow[]> {
  const rows = rowsOf<{ label: string; n: number | string }>(
    await db.execute(sql`
      select coalesce(nullif(props ->> 'campaign', ''), 'unknown') as label, count(*)::int as n
      from events
      where name = 'funnel.claim_redeemed'
        and at >= ${window.from.toISOString()}::timestamptz
        and at < ${window.to.toISOString()}::timestamptz
      group by 1
      order by n desc, label
      limit ${Math.max(1, Math.floor(limit))}
    `),
  );
  return rows.map((row) => ({ label: String(row.label), count: Number(row.n) || 0 }));
}

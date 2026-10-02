/**
 * cancel_flows reads and writes over the owner connection (migration 0018),
 * and the live dependencies of the cancel flow. Demo mode has no database,
 * so nothing is recorded and no offer counts as used.
 */

import { and, cancelFlows, eq, inArray, sql, type CancelFlow, type NewCancelFlow } from "@curvi/db";
import { hasStripeApiKey } from "@/lib/env";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import type { SaveOfferKind } from "./cancel-flow";
import type { CancelDeps, CancelState } from "./cancel-service";
import { buildPriceTable, priceIdForTier } from "./price-table";
import { liveScheduleReleaseNotifier } from "./schedule-release";
import { getStripe } from "./stripe";
import { scheduleWorkspaceDowngrade } from "./scheduled-change";

const OFFER_FOR_OUTCOME: Partial<Record<string, SaveOfferKind>> = {
  paused: "pause",
  discounted: "discount",
  downgraded: "downgrade",
};

export async function loadCancelState(workspaceId: string, now: Date = new Date()): Promise<CancelState> {
  if (!isDbMode()) {
    return { usedOffers: new Set(), pending: null };
  }
  try {
    const db = getDb();
    const [rows, takenOffers] = await Promise.all([
      db.query.cancelFlows.findMany({
        where: (t, { eq }) => eq(t.workspaceId, workspaceId),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
        limit: 200,
      }),
      // One-time offers belong to the workspace's entire history. Keeping
      // a plan repeatedly must not hide an older pause or discount behind
      // the recent-history limit. DISTINCT returns at most three outcomes.
      db.selectDistinct({ outcome: cancelFlows.outcome }).from(cancelFlows).where(and(
        eq(cancelFlows.workspaceId, workspaceId),
        sql`${cancelFlows.error} is null`,
        inArray(cancelFlows.outcome, ["paused", "discounted", "downgraded"]),
      )),
    ]);
    return {
      ...cancelStateFromRows(rows, now),
      usedOffers: new Set(takenOffers.flatMap(({ outcome }) => {
        const offer = OFFER_FOR_OUTCOME[outcome];
        return offer ? [offer] : [];
      })),
    };
  } catch (error) {
    // A failed read (for example before migration 0018 is applied) must not
    // take the billing page down; Stripe still refuses a second pause or
    // cancellation, since the flow reads the subscription itself.
    console.error(JSON.stringify({ msg: "billing: cancel flow state read failed", workspaceId, error: String(error) }));
    return { usedOffers: new Set(), pending: null };
  }
}

/**
 * The state earlier passes leave, from rows newest first: save offers taken
 * (a failed Stripe change was never given), and a pause or cancellation
 * that Stripe holds and that is still ahead.
 */
export function cancelStateFromRows(
  rows: Array<Pick<CancelFlow, "outcome" | "error" | "stripeApplied" | "effectiveAt">>,
  now: Date,
): CancelState {
  const usedOffers = new Set<SaveOfferKind>();
  for (const row of rows) {
    const offer = OFFER_FOR_OUTCOME[row.outcome];
    if (offer && !row.error) {
      usedOffers.add(offer);
    }
  }
  const latest = rows.find((row) => !row.error && row.outcome !== "kept");
  const pending =
    latest &&
    (latest.outcome === "paused" || latest.outcome === "canceled") &&
    latest.stripeApplied &&
    latest.effectiveAt &&
    latest.effectiveAt.getTime() > now.getTime()
      ? { outcome: latest.outcome, effectiveAt: latest.effectiveAt.toISOString() }
      : null;
  return { usedOffers, pending };
}

export async function recordCancelFlow(row: NewCancelFlow): Promise<void> {
  if (!isDbMode()) {
    return;
  }
  await getDb().insert(cancelFlows).values(row);
}

export function liveCancelDeps(): CancelDeps {
  const stripe = hasStripeApiKey() ? getStripe() : null;
  return {
    stripe,
    scheduleChange: isDbMode() && stripe ? async (input) => {
      const change = await scheduleWorkspaceDowngrade(getDb(), stripe, {
        ...input, targetPriceId: input.priceId, target: { tier: input.tier, cadence: input.cadence }, prices: buildPriceTable(),
      });
      return change.startsAt;
    } : undefined,
    priceTable: buildPriceTable(),
    priceIdFor: (tier, cadence) => priceIdForTier(tier, cadence),
    now: () => new Date(),
    loadState: (workspaceId) => loadCancelState(workspaceId),
    record: recordCancelFlow,
    onScheduleReleased: liveScheduleReleaseNotifier({ db: isDbMode() ? getDb() : null }),
  };
}

/**
 * cancel_flows reads and writes over the owner connection (migration 0018),
 * and the live dependencies of the cancel flow. Demo mode has no database,
 * so nothing is recorded and no offer counts as used.
 */

import { cancelFlows, type CancelFlow, type NewCancelFlow } from "@curvi/db";
import { isStripeConfigured } from "@/lib/env";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import type { SaveOfferKind } from "./cancel-flow";
import type { CancelDeps, CancelState } from "./cancel-service";
import { buildPriceTable, priceIdForTier } from "./price-table";
import { getStripe } from "./stripe";

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
    const rows = await getDb().query.cancelFlows.findMany({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 200,
    });
    return cancelStateFromRows(rows, now);
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
  return {
    stripe: isStripeConfigured() ? getStripe() : null,
    priceTable: buildPriceTable(),
    priceIdFor: (tier, cadence) => priceIdForTier(tier, cadence),
    now: () => new Date(),
    loadState: (workspaceId) => loadCancelState(workspaceId),
    record: recordCancelFlow,
  };
}

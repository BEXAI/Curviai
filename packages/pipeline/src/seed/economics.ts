/**
 * Unit economics seed (docs/phases/PHASE_20.md P20-04): the target and floor
 * gross margins and the payment fee that the price rule and the margin
 * alerts read. The pure math lives in packages/pipeline/src/economics/; the
 * numbers live here (CLAUDE.md rule 2), and a reprice changes only
 * creditCosts, tiers and topUps in credits.ts.
 *
 * Empty in the contract commit. One section per lane below, so lanes never
 * edit the same lines.
 *
 * Pure data only: this module is bundled into client pages through
 * @curvi/pipeline/seed.
 */

// ===========================================================================
// Lane 1 Billing core (p20/billing-core): P20-04.
// ===========================================================================

export interface EconomicsSeed {
  /** The price rule's target: credits per generative still are set so the
   * p90 cost is at most (1 minus this) of the lowest self serve revenue for
   * those credits (decision 2). */
  targetGrossMargin: number;
  /** Stripe's standard US card fee per successful charge, taken off revenue
   * in the report: `percent` of the amount plus `fixedUsd` (docs/
   * verification.md, PHASE_20 billing core, checked 2026-10-01). Cards
   * from outside the US, currency conversion and Stripe Tax add more. */
  paymentFee: { percent: number; fixedUsd: number };
  /** The gross margin below which P20-47's ops alert fires. */
  minGrossMargin: number;
}

export const economics: EconomicsSeed = {
  targetGrossMargin: 0.6,
  paymentFee: { percent: 0.029, fixedUsd: 0.3 },
  minGrossMargin: 0.4,
};

// End of Lane 1 Billing core.

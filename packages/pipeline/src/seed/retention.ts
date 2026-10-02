/**
 * Save offers shown in the cancel flow on /app/billing. Terms live here, not
 * in the billing code (CLAUDE.md rule 2): the discount coupon is created in
 * Stripe from these numbers, and the page copy reads them too.
 */

export const retentionOffers = {
  /** Months of paused billing a subscriber can take instead of canceling.
   * Stripe voids the invoices of the paused period, so no renewal is charged
   * and no renewal credits arrive until billing resumes. */
  pauseMonths: 1,
  /** Percent off the plan price for a number of monthly renewals. */
  discount: { percentOff: 30, months: 3 },
  /** Each offer is given at most once per workspace, so a save offer cannot
   * turn into a standing discount by canceling every few months. */
  oncePerWorkspace: true,
  /**
   * The "smaller plan" save offer uses scheduleDowngrade and starts at the
   * next renewal. The runtime also requires a database-backed schedule writer.
   */
  smallerPlanOffer: true,
} as const;

export type RetentionOffers = typeof retentionOffers;

/**
 * Stripe's part of referral rewards (docs/phases/PHASE_18.md P18-24). The
 * webhook route calls recordStripeReferrals after processStripeEvent and the
 * funnel, so the billing logic stays as it is:
 * - A payment (the same steps the funnel counts: a paid grant with money
 *   moved, lib/billing/funnel.ts) qualifies the paying workspace's pending
 *   referral. It is booked to the workspace the grant went to, read from
 *   the billing:stripe:<grant key> claim row. A retried delivery (the grant
 *   already applied) runs again, so a reward whose transaction failed is
 *   paid on the retry, once (service.ts locks the row and the ledger index
 *   dedupes).
 * - Before a reward, the card (or bank account) fingerprints on the
 *   referred workspace's charges are compared with the referrer's. Every
 *   workspace has its own Stripe customer, so a person referring their own
 *   second account with the same card is rejected as same_card here.
 * - A refund or dispute the billing store clawed back names the grant it
 *   reversed on its billing:stripe:clawback:<key> row; a referral that
 *   qualified on that grant's payment is reversed.
 * Never throws, and never changes the billing result: a failed step is
 * logged and reported as failed, and the webhook route then answers 500 so
 * Stripe delivers the event again. Billing is idempotent per event, and the
 * referral steps are too (the row lock, the status and the ledger index), so
 * the retry pays a reward or takes it back exactly once.
 */

import type Stripe from "stripe";
import { sql, type Db } from "@curvi/db";
import { hasStripeApiKey } from "@/lib/env";
import { stripeFunnelSteps } from "@/lib/billing/funnel";
import type { PriceTable } from "@/lib/billing/price-table";
import { getStripe, isStripeMissingResource, STRIPE_LOOKUP_OPTIONS } from "@/lib/billing/stripe";
import { disputeKey, type StripeProcessResult } from "@/lib/billing/stripe-webhook";
import { qualifyReferral, reverseReferral, type QualifyOutcome, type ReverseOutcome } from "./service";
import { referralsOn } from "./switch";

const BILLING_PREFIX = "billing:stripe:";
const PAYMENT_KEY = /^(invoice|checkout):[A-Za-z0-9_]{1,200}$/;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

/** The payment method fingerprints on one Stripe customer's charges. */
export type CustomerFingerprints = (customerId: string) => Promise<ReadonlySet<string>>;

export interface StripeReferralDeps {
  /** ops:referrals_enabled, read only when a payment meets an open referral. */
  enabled?: () => Promise<boolean>;
  /** Read only when a payment meets an open referral while rewards are on.
   * Defaults to Stripe's charge list (stripeCustomerFingerprints). */
  fingerprints?: CustomerFingerprints;
  now?: () => Date;
  log?: Pick<Console, "error">;
}

export type StripeReferralResult =
  | { kind: "qualify"; paymentKey: string; result: QualifyOutcome }
  | { kind: "reverse"; paymentKey: string; result: ReverseOutcome };

export interface StripeReferralReport {
  steps: StripeReferralResult[];
  /** A step threw; the route answers 500 so Stripe delivers the event again. */
  failed: boolean;
}

/** The fingerprints a charge's payment method carries: the card number
 * (Stripe documents card.fingerprint as the way to see two customers using
 * the same card) and a US bank account. Link payments carry none. Pure. */
export function chargeFingerprints(charge: Pick<Stripe.Charge, "payment_method_details">): string[] {
  const details = charge.payment_method_details;
  const out: string[] = [];
  if (details?.card?.fingerprint) {
    out.push(`card:${details.card.fingerprint}`);
  }
  if (details?.us_bank_account?.fingerprint) {
    out.push(`us_bank_account:${details.us_bank_account.fingerprint}`);
  }
  return out;
}

/** The fingerprints on a customer's newest 100 charges (GET /v1/charges
 * with customer, docs/verification.md). A customer Stripe no longer has has
 * none; any other failure throws, so the delivery is retried. */
export function stripeCustomerFingerprints(stripe: Stripe): CustomerFingerprints {
  return async (customerId) => {
    try {
      const charges = await stripe.charges.list({ customer: customerId, limit: 100 }, { ...STRIPE_LOOKUP_OPTIONS });
      return new Set(charges.data.flatMap(chargeFingerprints));
    } catch (error) {
      if (isStripeMissingResource(error)) {
        return new Set<string>();
      }
      throw error;
    }
  };
}

function defaultFingerprints(): CustomerFingerprints {
  // A read only Stripe call: the key is enough (P20-01).
  if (!hasStripeApiKey()) {
    // Fail closed: a reward is never paid without the card check.
    return async () => {
      throw new Error("STRIPE_SECRET_KEY is not set, so the referral card check cannot run.");
    };
  }
  return stripeCustomerFingerprints(getStripe());
}

/**
 * True when the referred workspace paid with a card (or bank account) that
 * also paid on the referrer's Stripe customer. Both workspaces are read on
 * the owner connection; a side with no customer has no charges.
 */
export async function referralSharesPaymentMethod(
  db: Pick<Db, "execute">,
  referredWorkspaceId: string,
  fingerprints: CustomerFingerprints,
): Promise<boolean> {
  const [row] = rowsOf<{ referrer_customer: string | null; referred_customer: string | null }>(
    await db.execute(sql`
      select referrer.stripe_customer_id as referrer_customer, referred.stripe_customer_id as referred_customer
      from referrals r
      left join workspaces referrer on referrer.id = r.referrer_workspace_id
      left join workspaces referred on referred.id = r.referred_workspace_id
      where r.referred_workspace_id = ${referredWorkspaceId}::uuid
      limit 1
    `),
  );
  if (!row?.referrer_customer || !row.referred_customer) {
    return false;
  }
  if (row.referrer_customer === row.referred_customer) {
    return true;
  }
  const [referred, referrer] = await Promise.all([fingerprints(row.referred_customer), fingerprints(row.referrer_customer)]);
  for (const fingerprint of referred) {
    if (referrer.has(fingerprint)) {
      return true;
    }
  }
  return false;
}

/** The payment steps of one processed event, retries included. Pure. */
export function referralPaymentSteps(
  event: Stripe.Event,
  result: StripeProcessResult,
  table: PriceTable,
): Array<{ grantKey: string; workspaceHint: string | null }> {
  return stripeFunnelSteps(event, { ...result, duplicate: false }, table)
    .filter((step) => step.name === "payment" && step.grantKey !== null)
    .map((step) => ({ grantKey: step.grantKey as string, workspaceHint: step.workspaceHint }));
}

/** The billing clawback key of a refund or dispute event the billing store
 * acted on, with the reversal reason, or null. Pure. */
export function referralClawbackKey(
  event: Stripe.Event,
  result: StripeProcessResult,
): { key: string; reason: "refunded" | "disputed" } | null {
  if (event.type === "charge.refunded" && result.action === "refund_clawed_back") {
    return { key: event.id, reason: "refunded" };
  }
  if (event.type === "charge.dispute.funds_withdrawn" && result.action === "dispute_clawed_back") {
    const dispute = event.data.object;
    return dispute.id ? { key: disputeKey(dispute.id), reason: "disputed" } : null;
  }
  return null;
}

/** Writes the referral steps of one processed Stripe event. Never throws;
 * a failure comes back as failed: true. */
export async function recordStripeReferrals(
  db: Db,
  event: Stripe.Event,
  result: StripeProcessResult,
  table: PriceTable,
  deps: StripeReferralDeps = {},
): Promise<StripeReferralReport> {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());
  const done: StripeReferralResult[] = [];
  try {
    for (const step of referralPaymentSteps(event, result, table)) {
      const booked = rowsOf<{ workspace_id: string | null }>(
        await db.execute(sql`select workspace_id from events where name = ${`${BILLING_PREFIX}${step.grantKey}`} limit 1`),
      );
      const workspaceId = booked[0]?.workspace_id ?? null;
      if (!workspaceId || !PAYMENT_KEY.test(step.grantKey)) {
        continue;
      }
      // Most payments have no open referral: skip the switch read and the
      // transaction for them.
      const open = rowsOf(
        await db.execute(
          sql`select 1 from referrals where referred_workspace_id = ${workspaceId}::uuid and status in ('pending', 'qualified') limit 1`,
        ),
      );
      if (open.length === 0) {
        continue;
      }
      const enabled = await (deps.enabled ?? (() => referralsOn()))();
      // Stripe is read before the referral transaction opens, so no row lock
      // waits on it.
      const sharedPaymentMethod = enabled
        ? await referralSharesPaymentMethod(db, workspaceId, deps.fingerprints ?? defaultFingerprints())
        : false;
      done.push({
        kind: "qualify",
        paymentKey: step.grantKey,
        result: await qualifyReferral(db, {
          referredWorkspaceId: workspaceId,
          paymentKey: step.grantKey,
          enabled,
          sharedPaymentMethod,
          now: now(),
        }),
      });
    }

    const clawback = referralClawbackKey(event, result);
    if (clawback) {
      const claim = rowsOf<{ grant: string | null }>(
        await db.execute(
          sql`select props->>'grant' as grant from events where name = ${`${BILLING_PREFIX}clawback:${clawback.key}`} limit 1`,
        ),
      );
      const grant = claim[0]?.grant ?? null;
      const paymentKey = grant?.startsWith(BILLING_PREFIX) ? grant.slice(BILLING_PREFIX.length) : null;
      if (paymentKey && PAYMENT_KEY.test(paymentKey)) {
        const at = typeof event.created === "number" ? new Date(event.created * 1000) : now();
        done.push({
          kind: "reverse",
          paymentKey,
          result: await reverseReferral(db, { paymentKey, reason: clawback.reason, at }),
        });
      }
    }
  } catch (err) {
    log.error(
      JSON.stringify({
        level: "error",
        event: "referral_stripe_failed",
        eventId: event.id,
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { steps: done, failed: true };
  }
  return { steps: done, failed: false };
}

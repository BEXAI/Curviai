/**
 * Plan intent that travels from the pricing page through signup to the
 * billing page: /signup?plan=growth&cadence=annual&source=pricing for
 * visitors, then /app/billing?checkout=growth&cadence=annual once signed in.
 * Every value is validated against the seed tiers, so a crafted link can only
 * ever select a real plan.
 */

import type { SignupSourceKey } from "@curvi/pipeline/seed";
import { SIGNUP_EXTRA_KEYS, cleanLandingValue, cleanSignupExtra, type SignupLinkExtra } from "@/lib/attribution";
import { isBillingCadence, isSelfServeTierKey, type BillingCadence, type PaidTierKey } from "./plans";

export interface CheckoutIntent {
  tier: PaidTierKey;
  cadence: BillingCadence;
}

/** Where a checkout was started from, stored as Stripe metadata. */
export const CHECKOUT_SOURCES = ["billing", "pricing", "finish_upgrade"] as const;
export type CheckoutSource = (typeof CHECKOUT_SOURCES)[number];

export type CheckoutStatus = "success" | "canceled";

type ParamValue = string | string[] | undefined;

function first(value: ParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads ?checkout=<tier>&cadence=<monthly|annual>. Also accepts the combined
 * form ?checkout=<tier>_<cadence>. A missing or unknown cadence falls back to
 * monthly; an unknown tier, or one not sold online (Agency, P20-08), gives
 * null.
 */
export function parseCheckoutIntent(params: { checkout?: ParamValue; cadence?: ParamValue }): CheckoutIntent | null {
  const raw = first(params.checkout)?.trim().toLowerCase();
  if (!raw) {
    return null;
  }
  let tierPart = raw;
  let cadencePart = first(params.cadence)?.trim().toLowerCase();
  const combined = /^([a-z]+)_(monthly|annual)$/.exec(raw);
  if (combined) {
    tierPart = combined[1];
    cadencePart = cadencePart ?? combined[2];
  }
  if (!isSelfServeTierKey(tierPart)) {
    return null;
  }
  return { tier: tierPart, cadence: isBillingCadence(cadencePart) ? cadencePart : "monthly" };
}

export function parseCheckoutStatus(value: ParamValue): CheckoutStatus | null {
  const status = first(value);
  return status === "success" || status === "canceled" ? status : null;
}

export interface SignupHrefInput {
  plan?: PaidTierKey;
  cadence?: BillingCadence;
  /** Where the link sits: a seeded key (packages/pipeline/src/seed/growth.ts). */
  source: SignupSourceKey;
  /** Share slug, claim token, preview id, referral code, category or channel
   * (docs/phases/PHASE_18.md P18-01). Each is validated; a bad value is
   * left off the link rather than failing the page. */
  extra?: SignupLinkExtra;
}

/**
 * The one signup link builder (P18-01): the chosen plan for an anonymous
 * visitor, the page's source key and any validated extras, in that order.
 * Landing parameters from the current page (UTM tags, ref) are added at
 * click time by the signup link component, not here.
 */
export function signupHref(input: SignupHrefInput): string {
  const params = new URLSearchParams();
  if (input.plan) {
    params.set("plan", input.plan);
    params.set("cadence", input.cadence ?? "monthly");
  }
  const source = cleanLandingValue("source", input.source);
  if (source) {
    params.set("source", source);
  }
  for (const key of SIGNUP_EXTRA_KEYS) {
    const value = cleanSignupExtra(key, input.extra?.[key]);
    if (value) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `/signup?${query}` : "/signup";
}

/** Billing page link that opens the focused "finish upgrading" card. */
export function billingCheckoutHref(intent: CheckoutIntent): string {
  const params = new URLSearchParams({ checkout: intent.tier, cadence: intent.cadence });
  return `/app/billing?${params.toString()}`;
}

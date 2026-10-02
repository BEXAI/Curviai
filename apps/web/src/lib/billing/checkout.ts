/**
 * Builds Stripe Checkout and Customer Portal requests. Pure where possible so
 * the exact parameters are unit tested without the network.
 *
 * Checkout always:
 * - uses the workspace's one Stripe customer, created before Checkout when
 *   the workspace has none (checkout-guard.ts), so Checkout never makes a
 *   second customer for the same workspace,
 * - accepts promotion codes, and for a plan says beside the pay button what
 *   a code changes and what the plan renews at afterwards,
 * - requires agreement to the terms (the terms URL must be set in the
 *   Stripe Dashboard public details, see docs/STRIPE_SETUP.md); for a plan
 *   the checkbox names the automatic renewal and the renewal terms sit
 *   beside the pay button, with their version and hash in the metadata
 *   so the consent record keeps what the buyer saw (P20-07),
 * - tags the session, the subscription and the payment with the workspace,
 *   plan, cadence and source.
 * Automatic tax and tax id collection switch on only with STRIPE_TAX_ENABLED=1.
 */

import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { optionalEnv } from "@/lib/env";
import type { CheckoutSource } from "./intent";
import {
  BILLING_CADENCES,
  DOWNGRADE_BY_EMAIL_LINE,
  downgradeByEmailLine,
  planChangeDirection,
  selfServeTierKeys,
  upgradeTargets,
  type BillingCadence,
  type PaidTierKey,
  type PlanPrice,
} from "./plans";
import { buildPriceTable, type EnvReader, type PriceTable } from "./price-table";
import { describeScheduledChange, upgradeReleaseNotice, type ScheduledChange } from "./schedule-release";
import {
  firstRenewal,
  promotionCodeLine,
  RENEWAL_DISCLOSURE_VERSION,
  renewalCheckboxText,
  renewalTerms,
} from "./renewal-terms";

export type CheckoutPurchase =
  | { kind: "tier"; tier: PaidTierKey; cadence: BillingCadence }
  | { kind: "topup"; credits: number };

export interface CheckoutParamsInput {
  purchase: CheckoutPurchase;
  priceId: string;
  workspaceId: string;
  siteUrl: string;
  source: CheckoutSource;
  /** workspaces.stripe_customer_id, created first when it was missing. */
  customerId: string;
  taxEnabled: boolean;
  /** The signed in buyer, kept on the session for the consent record. */
  userId?: string | null;
  /** When the session is made; dates the renewal deadline. */
  now?: Date;
}

/** Stripe's limit for each custom_text message. */
export const CHECKOUT_CUSTOM_TEXT_MAX = 1200;

export interface CheckoutDisclosure {
  /** Beside the pay button (custom_text.submit). */
  submit: string;
  /** The consent checkbox (custom_text.terms_of_service_acceptance). */
  acceptance: string;
  version: string;
  /** sha256 of the exact submit and acceptance text, joined by a newline. */
  sha256: string;
}

/** The renewal terms and checkbox Checkout shows for a plan (P20-07): the
 * terms shown beside the site's buy buttons plus the promotion code line. */
export function checkoutDisclosure(input: {
  tier: PaidTierKey;
  cadence: BillingCadence;
  siteUrl: string;
  now: Date;
}): CheckoutDisclosure {
  const submit = `${renewalTerms({ tier: input.tier, cadence: input.cadence, renewsOn: firstRenewal(input.now, input.cadence) })} ${promotionCodeLine(input.tier, input.cadence)}`;
  const acceptance = renewalCheckboxText(input.siteUrl);
  return {
    submit,
    acceptance,
    version: RENEWAL_DISCLOSURE_VERSION,
    sha256: createHash("sha256").update(`${submit}\n${acceptance}`).digest("hex"),
  };
}

/**
 * The renewal terms beside a subscriber's plan change button on
 * /app/billing (the plan picker and the finish upgrading card show the same
 * text, with "your next renewal date"), kept with its version and hash in
 * the consent row written when the button opens the portal (law and copy
 * review major 3).
 */
export function planChangeDisclosure(target: PlanPrice): { text: string; version: string; sha256: string } {
  const text = renewalTerms({ tier: target.tier, cadence: target.cadence, renewsOn: null });
  return { text, version: RENEWAL_DISCLOSURE_VERSION, sha256: createHash("sha256").update(text).digest("hex") };
}

export function checkoutReturnUrls(siteUrl: string, purchase: CheckoutPurchase): { success: string; cancel: string } {
  return {
    // Stripe fills in {CHECKOUT_SESSION_ID}, so the billing page can tell
    // when the webhook has granted this exact purchase.
    success: `${siteUrl}/app/billing?status=success&kind=${purchase.kind}&session_id={CHECKOUT_SESSION_ID}`,
    cancel: `${siteUrl}/app/billing?status=canceled`,
  };
}

export function buildCheckoutParams(input: CheckoutParamsInput): Stripe.Checkout.SessionCreateParams {
  const { purchase, priceId, workspaceId, siteUrl, source, customerId, taxEnabled } = input;
  const isSubscription = purchase.kind === "tier";
  const urls = checkoutReturnUrls(siteUrl, purchase);
  const disclosure =
    purchase.kind === "tier"
      ? checkoutDisclosure({ tier: purchase.tier, cadence: purchase.cadence, siteUrl, now: input.now ?? new Date() })
      : null;

  const metadata: Record<string, string> = {
    workspaceId,
    priceId,
    kind: purchase.kind,
    plan: purchase.kind === "tier" ? purchase.tier : "topup",
    cadence: purchase.kind === "tier" ? purchase.cadence : "one_time",
    source,
  };
  if (purchase.kind === "topup") {
    metadata.credits = String(purchase.credits);
  }
  if (disclosure) {
    metadata.disclosure_version = disclosure.version;
    metadata.disclosure_sha256 = disclosure.sha256;
  }
  if (input.userId) {
    metadata.userId = input.userId;
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: isSubscription ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: urls.success,
    cancel_url: urls.cancel,
    client_reference_id: workspaceId,
    // Always the workspace's own customer: never customer_email or
    // customer_creation, which would let Checkout make another customer.
    customer: customerId,
    metadata,
    allow_promotion_codes: true,
    consent_collection: { terms_of_service: "required" },
    custom_text: disclosure
      ? { submit: { message: disclosure.submit }, terms_of_service_acceptance: { message: disclosure.acceptance } }
      : { terms_of_service_acceptance: { message: `I agree to the [Terms of Service](${siteUrl}/terms).` } },
  };

  if (isSubscription) {
    params.subscription_data = {
      metadata: {
        workspaceId,
        plan: metadata.plan,
        cadence: metadata.cadence,
        source,
      },
    };
  } else {
    // An invoice so business buyers have a document for their books.
    params.invoice_creation = {
      enabled: true,
      invoice_data: { metadata: { workspaceId, credits: metadata.credits ?? "" } },
    };
    params.payment_intent_data = { metadata: { workspaceId, credits: metadata.credits ?? "" } };
  }

  if (taxEnabled) {
    params.automatic_tax = { enabled: true };
    params.billing_address_collection = "required";
    params.tax_id_collection = { enabled: true };
    // An existing customer must let Checkout save the address and business
    // name it collects, or Stripe rejects tax and tax id collection.
    params.customer_update = { address: "auto", name: "auto" };
  }

  return params;
}

export interface PlanChangePortalInput {
  customerId: string;
  subscriptionId: string;
  /** The subscription item to move to the new price, when known. */
  subscriptionItemId: string | null;
  priceId: string;
  returnUrl: string;
  /** The upgrade only portal configuration for the current tier (P20-06). */
  configuration?: string | null;
}

/**
 * docs/phases/PHASE_20.md P20-06, the P0 stopgap: downgrades take effect at
 * the next renewal, which the portal cannot do across products. Until the P1
 * schedule ships, an existing subscriber changes plan online only upward,
 * through a portal configuration per current plan and cadence that lists
 * only the prices upgradeTargets names, and anything else (a smaller plan,
 * or yearly to monthly billing) is an email the founder schedules in the
 * Stripe Dashboard for the period end.
 */
export {
  DOWNGRADE_BY_EMAIL_LINE,
  MONTHLY_BY_EMAIL_LINE,
  planChangeDirection,
  upgradeTargets,
  type PlanChangeDirection,
  type PlanPrice,
} from "./plans";

/** The env var holding the upgrade only portal configuration (bpc_...) for
 * subscribers on this plan and cadence: STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH
 * for Growth monthly, STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH_ANNUAL for Growth
 * yearly. */
export function portalUpgradeConfigEnvName(from: PlanPrice): string {
  return `STRIPE_PORTAL_UPGRADE_CONFIG_${from.tier.toUpperCase()}${from.cadence === "annual" ? "_ANNUAL" : ""}`;
}

/** Every plan and cadence sold online whose subscribers can upgrade, so
 * each needs its configuration: Starter and Growth at both cadences and Pro
 * monthly (for Pro yearly). Pro yearly is the top and has none. */
export function upgradeConfigsNeeded(): PlanPrice[] {
  return selfServeTierKeys
    .flatMap((tier) => BILLING_CADENCES.map((cadence) => ({ tier, cadence })))
    .filter((from) => upgradeTargets(from).length > 0);
}

/**
 * An existing subscriber who picks another plan confirms the change in the
 * Customer Portal instead of opening a second subscription (Update.md 1.5).
 * With the item id the portal opens straight on the confirm step for the
 * chosen price; without it the portal shows the plan picker.
 */
export function buildPlanChangePortalParams(input: PlanChangePortalInput): Stripe.BillingPortal.SessionCreateParams {
  const afterCompletion: Stripe.BillingPortal.SessionCreateParams.FlowData.AfterCompletion = {
    type: "redirect",
    redirect: { return_url: `${input.returnUrl}?status=success&kind=plan_change` },
  };
  const configuration = input.configuration ? { configuration: input.configuration } : {};
  if (input.subscriptionItemId) {
    return {
      customer: input.customerId,
      return_url: input.returnUrl,
      ...configuration,
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: {
          subscription: input.subscriptionId,
          items: [{ id: input.subscriptionItemId, price: input.priceId, quantity: 1 }],
        },
        after_completion: afterCompletion,
      },
    };
  }
  return {
    customer: input.customerId,
    return_url: input.returnUrl,
    ...configuration,
    flow_data: {
      type: "subscription_update",
      subscription_update: { subscription: input.subscriptionId },
      after_completion: afterCompletion,
    },
  };
}

export type PlanChangeResult =
  /** `upgrade` is the price the portal opens on for a change (null on the
   * portal home); `sessionId` is the portal session (bps_...). */
  | { kind: "portal"; url: string; sessionId: string | null; upgrade: PlanPrice | null }
  /** A smaller plan, or yearly to monthly: the founder schedules it by
   * email. `line` says which (downgradeByEmailLine). */
  | { kind: "downgrade_by_email"; line: string }
  /** An upgrade while a change the founder scheduled is attached: nothing
   * is released until the subscriber confirms (`notice` asks them). */
  | { kind: "scheduled_change"; change: ScheduledChange; notice: string };

export interface PlanChangeOptions {
  /** Maps price ids to tiers; built from the env by default. */
  priceTable?: PriceTable;
  readEnv?: EnvReader;
  logger?: Pick<Console, "warn">;
  /** Records and reports a released schedule (schedule-release.ts); never
   * throws. */
  onScheduleReleased?: (change: ScheduledChange) => Promise<void>;
}

function scheduleIdOf(subscription: Stripe.Subscription): string | null {
  const schedule = subscription.schedule;
  return typeof schedule === "string" ? schedule : (schedule?.id ?? null);
}

/**
 * Opens the portal on the plan change for an existing subscriber (P20-06
 * stopgap). On the chosen price already, the portal home opens. A downgrade
 * is never changed online: the buyer is asked to email us. An attached
 * subscription schedule (a downgrade the founder set up by hand) must be
 * released first, because the portal can neither update nor cancel a
 * subscription that has one; the subscriber confirms that first
 * (scheduled_change), and the release is recorded and emailed to the
 * founder (onScheduleReleased). The session uses the upgrade only configuration of the
 * current tier and falls back from the confirm step to the plan picker, then
 * to the portal home, so it still lands somewhere useful.
 */
export async function createPlanChangePortalSession(
  stripe: Stripe,
  input: Omit<PlanChangePortalInput, "subscriptionItemId" | "configuration"> & {
    /** The subscriber confirmed that the upgrade cancels the change the
     * founder scheduled (the notice of a scheduled_change result). */
    releaseScheduledChange?: boolean;
  },
  options: PlanChangeOptions = {},
): Promise<PlanChangeResult> {
  const readEnv = options.readEnv ?? optionalEnv;
  const table = options.priceTable ?? buildPriceTable(readEnv);
  const logger = options.logger ?? console;

  const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);
  const items = subscription.items?.data ?? [];
  const subscriptionItemId = items.length === 1 ? (items[0]?.id ?? null) : null;
  const currentPriceId = items.length === 1 ? (items[0]?.price?.id ?? null) : null;
  if (currentPriceId !== null && currentPriceId === input.priceId) {
    // Already on this price: the portal home shows the current plan.
    const home = await stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
    return { kind: "portal", url: home.url, sessionId: home.id ?? null, upgrade: null };
  }

  const current = currentPriceId ? table[currentPriceId] : undefined;
  const target = table[input.priceId];
  const from: PlanPrice | null =
    current?.kind === "tier" ? { tier: current.tier as PaidTierKey, cadence: current.cadence } : null;
  if (target?.kind !== "tier") {
    return { kind: "downgrade_by_email", line: DOWNGRADE_BY_EMAIL_LINE };
  }
  const to: PlanPrice = { tier: target.tier as PaidTierKey, cadence: target.cadence };
  if (planChangeDirection(from, to) !== "upgrade") {
    return { kind: "downgrade_by_email", line: downgradeByEmailLine(from, to) };
  }

  const scheduleId = scheduleIdOf(subscription);
  if (scheduleId) {
    const change = await describeScheduledChange(stripe, scheduleId, table);
    if (!input.releaseScheduledChange) {
      // Ask first: the release undoes what the subscriber asked us for.
      return { kind: "scheduled_change", change, notice: upgradeReleaseNotice(change, from?.tier) };
    }
    await stripe.subscriptionSchedules.release(scheduleId);
    logger.warn(
      JSON.stringify({
        msg: "billing: released a scheduled plan change before an upgrade",
        subscription: input.subscriptionId,
        schedule: scheduleId,
      }),
    );
    await options.onScheduleReleased?.(change);
  }

  // The configuration of the subscriber's own plan and cadence: a yearly
  // subscriber's lists only yearly prices, so the portal's plan picker and
  // home never offer a move to monthly billing. Without it the default
  // configuration (Switch plan off) refuses the change, which is safe.
  const configEnv = from ? portalUpgradeConfigEnvName(from) : null;
  const configuration = configEnv ? (readEnv(configEnv) ?? null) : null;
  if (!configuration) {
    logger.warn(
      JSON.stringify({
        msg: "billing: no upgrade portal configuration for this plan and cadence, using the default one",
        env: configEnv,
      }),
    );
  }

  const attempts: Stripe.BillingPortal.SessionCreateParams[] = [];
  if (subscriptionItemId) {
    attempts.push(buildPlanChangePortalParams({ ...input, subscriptionItemId, configuration }));
  }
  attempts.push(buildPlanChangePortalParams({ ...input, subscriptionItemId: null, configuration }));
  attempts.push({ customer: input.customerId, return_url: input.returnUrl });

  let lastError: unknown = null;
  for (const params of attempts) {
    try {
      const session = await stripe.billingPortal.sessions.create(params);
      return { kind: "portal", url: session.url, sessionId: session.id ?? null, upgrade: params.flow_data ? to : null };
    } catch (error) {
      lastError = error;
      console.warn(
        JSON.stringify({
          msg: "billing: portal flow rejected, trying the next one",
          flow: params.flow_data?.type ?? "home",
          error: String(error),
        }),
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not open the customer portal.");
}

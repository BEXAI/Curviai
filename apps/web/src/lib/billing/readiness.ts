/**
 * Billing readiness (docs/phases/PHASE_20.md P20-01): checkout opens only
 * when Stripe can grant the credits a payment buys.
 *
 * A Stripe secret key alone used to open checkout on every selling surface
 * while the webhook answered 503 without its signing secret, so a buyer
 * could pay and get nothing. Checkout is open only when all of these hold:
 * - STRIPE_SECRET_KEY is set;
 * - STRIPE_WEBHOOK_SECRET is set, so the webhook can verify and grant;
 * - every self serve price has its STRIPE_PRICE_* variable (names from
 *   price-table.ts; a tier the seed marks `selfServe: false`, Agency after
 *   P20-08, needs none);
 * - the billing sender is set up (BILLING_EMAIL_FROM and RESEND_API_KEY),
 *   so the plan activation email the renewal laws ask for can go out
 *   (law and copy review major 4);
 * - the key's mode fits the environment, keyed on an explicit label rather
 *   than on https: a test key on the production site (NEXT_PUBLIC_SITE_URL
 *   is https://curvi.ai and NEXT_PUBLIC_ENV_LABEL is unset), a live key on
 *   localhost or while NEXT_PUBLIC_ENV_LABEL is set (staging, P20-54), or a
 *   publishable key in another mode than the secret key is a mismatch. A
 *   test key on staging or on localhost is fine.
 *
 * With no Stripe variable set at all, billing is simply off and there is no
 * problem to report. Once any of them is set, every missing piece is a
 * problem with a stable code that /api/health shows as a warning.
 *
 * Pure: reads only through the injected env reader, so it runs anywhere
 * and tests cover every combination.
 */

import type { TierDefinition } from "@curvi/pipeline/seed";
import { topUps } from "@curvi/pipeline/seed";
import { BILLING_CADENCES, paidTiers } from "./plans";
import { tierPriceEnvName, topUpPriceEnvName, type EnvReader } from "./price-table";

export const STRIPE_SECRET_KEY_ENV = "STRIPE_SECRET_KEY";
export const STRIPE_WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET";
/** Optional: checked against the secret key's mode only when set. */
export const STRIPE_PUBLISHABLE_KEY_ENV = "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY";
/** Set on staging (P20-54); unset in production. */
export const ENV_LABEL_ENV = "NEXT_PUBLIC_ENV_LABEL";
export const SITE_URL_ENV = "NEXT_PUBLIC_SITE_URL";

/** The production site. A Stripe test key here, with no environment label,
 * means real buyers would pay with test cards and nothing would arrive. */
export const PRODUCTION_SITE_HOSTS: readonly string[] = ["curvi.ai", "www.curvi.ai"];

export type BillingProblemCode =
  | "stripe_secret_key_missing"
  | "stripe_webhook_secret_missing"
  | "stripe_price_missing"
  | "stripe_key_mode_mismatch"
  | "billing_email_not_configured";

/** The billing sender (lib/billing/billing-email.ts reads the same two). */
export const BILLING_EMAIL_ENV_NAMES = ["BILLING_EMAIL_FROM", "RESEND_API_KEY"] as const;

export interface BillingProblem {
  /** Short stable code, safe to show publicly (health warning codes). */
  code: BillingProblemCode;
  /** Plain sentence for the founder. Names variables, never their values. */
  message: string;
}

export type StripeKeyMode = "live" | "test";

/** Where this instance runs, as far as billing cares. */
export type SiteEnvironment = "production" | "staging" | "local" | "other";

export interface BillingReadiness {
  /** True only when a payment can be verified and granted. Every selling
   * surface and the checkout route read this (env.ts isCheckoutOpen). */
  checkoutOpen: boolean;
  /** STRIPE_SECRET_KEY is set: enough for read only Stripe calls (the
   * webhook lookups, the cancel flow, account deletion), never for
   * checkout. */
  apiKey: boolean;
  problems: BillingProblem[];
  environment: SiteEnvironment;
  /** The secret key's mode, null when unset or not a recognized key. */
  keyMode: StripeKeyMode | null;
}

function present(readEnv: EnvReader, name: string): string | undefined {
  const value = readEnv(name)?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** sk_live_ and rk_live_ are live, sk_test_ and rk_test_ test (secret and
 * restricted keys); pk_live_ and pk_test_ for publishable keys. */
export function stripeKeyMode(key: string | undefined): StripeKeyMode | null {
  if (!key) return null;
  if (/^(sk|rk|pk)_live_/.test(key)) return "live";
  if (/^(sk|rk|pk)_test_/.test(key)) return "test";
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * The environment from explicit settings: any NEXT_PUBLIC_ENV_LABEL is
 * staging; otherwise the production site host is production, localhost (or
 * no site URL, which the app reads as http://localhost:3000) is local, and
 * anything else is other, where no mode rule applies.
 */
export function siteEnvironment(readEnv: EnvReader): SiteEnvironment {
  if (present(readEnv, ENV_LABEL_ENV)) return "staging";
  const siteUrl = present(readEnv, SITE_URL_ENV);
  if (!siteUrl) return "local";
  const host = hostOf(siteUrl);
  if (host === null) return "other";
  if (PRODUCTION_SITE_HOSTS.includes(host)) return "production";
  if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) return "local";
  return "other";
}

/** A paid tier sold through checkout. The seed's `selfServe: false` (P20-08,
 * Agency) takes a tier off self serve. */
export function isSelfServeTier(tier: TierDefinition): boolean {
  return tier.selfServe;
}

/** The paid tiers checkout sells. */
export function selfServeTiers(): TierDefinition[] {
  return paidTiers.filter(isSelfServeTier);
}

/** Every STRIPE_PRICE_* variable checkout needs: each self serve tier at
 * both cadences, and each top up. */
export function requiredPriceEnvNames(): string[] {
  const names: string[] = [];
  for (const tier of selfServeTiers()) {
    for (const cadence of BILLING_CADENCES) {
      names.push(tierPriceEnvName(tier.key, cadence));
    }
  }
  for (const topUp of topUps) {
    names.push(topUpPriceEnvName(topUp.credits));
  }
  return names;
}

/** Every variable whose presence means someone is setting Stripe up. */
function anyStripeVariable(readEnv: EnvReader, priceNames: readonly string[]): boolean {
  return [STRIPE_SECRET_KEY_ENV, STRIPE_WEBHOOK_SECRET_ENV, STRIPE_PUBLISHABLE_KEY_ENV, ...priceNames].some((name) =>
    Boolean(present(readEnv, name)),
  );
}

function modeMismatch(
  environment: SiteEnvironment,
  keyMode: StripeKeyMode | null,
  publishableMode: StripeKeyMode | null,
): string | null {
  if (keyMode === "test" && environment === "production") {
    return "A Stripe test key is set on the production site with no NEXT_PUBLIC_ENV_LABEL, so buyers would pay with test cards and nothing real would arrive. Set the live keys, or label the environment.";
  }
  if (keyMode === "live" && environment === "local") {
    return "A Stripe live key is set on a local site, so real cards would be charged from a laptop. Use a test key here.";
  }
  if (keyMode === "live" && environment === "staging") {
    return "A Stripe live key is set while NEXT_PUBLIC_ENV_LABEL marks this as staging. Use a test key on staging.";
  }
  if (keyMode && publishableMode && keyMode !== publishableMode) {
    return `The Stripe publishable key is a ${publishableMode} key but the secret key is a ${keyMode} key. Set both from the same mode.`;
  }
  return null;
}

/** Billing readiness from the environment. */
export function billingReadiness(readEnv: EnvReader): BillingReadiness {
  const secretKey = present(readEnv, STRIPE_SECRET_KEY_ENV);
  const keyMode = stripeKeyMode(secretKey);
  const environment = siteEnvironment(readEnv);
  const priceNames = requiredPriceEnvNames();
  const problems: BillingProblem[] = [];

  if (!anyStripeVariable(readEnv, priceNames)) {
    // Billing is off on purpose: nothing to warn about.
    return { checkoutOpen: false, apiKey: false, problems, environment, keyMode: null };
  }

  if (!secretKey) {
    problems.push({
      code: "stripe_secret_key_missing",
      message: "Stripe variables are set but STRIPE_SECRET_KEY is not, so checkout stays closed.",
    });
  }
  if (!present(readEnv, STRIPE_WEBHOOK_SECRET_ENV)) {
    problems.push({
      code: "stripe_webhook_secret_missing",
      message:
        "STRIPE_WEBHOOK_SECRET is not set, so the webhook could not verify a payment or grant its credits. Checkout stays closed until it is set.",
    });
  }
  const missingPrices = priceNames.filter((name) => !present(readEnv, name));
  if (missingPrices.length > 0) {
    problems.push({
      code: "stripe_price_missing",
      message: `${missingPrices.length === 1 ? "This price variable is" : "These price variables are"} not set, so checkout stays closed: ${missingPrices.join(", ")}.`,
    });
  }
  const missingEmail = BILLING_EMAIL_ENV_NAMES.filter((name) => !present(readEnv, name));
  if (missingEmail.length > 0) {
    problems.push({
      code: "billing_email_not_configured",
      message: `${missingEmail.join(" and ")} ${missingEmail.length === 1 ? "is" : "are"} not set, so no plan activation email could go out after a purchase. Checkout stays closed until the billing sender is set up (docs/STRIPE_SETUP.md section 2).`,
    });
  }
  const mismatch = modeMismatch(environment, keyMode, stripeKeyMode(present(readEnv, STRIPE_PUBLISHABLE_KEY_ENV)));
  if (mismatch) {
    problems.push({ code: "stripe_key_mode_mismatch", message: mismatch });
  }

  return {
    checkoutOpen: Boolean(secretKey) && problems.length === 0,
    apiKey: Boolean(secretKey),
    problems,
    environment,
    keyMode,
  };
}

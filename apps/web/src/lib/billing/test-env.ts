/**
 * Test helper: the environment that opens checkout (P20-01), for tests
 * that render or call a selling surface with payments open. Values are
 * placeholders; the price ids follow `price_<tier>_<cadence>` and
 * `price_topup_<credits>`. NEXT_PUBLIC_ENV_LABEL is set so a test key stays
 * valid whatever NEXT_PUBLIC_SITE_URL a test uses (a test key on the
 * production site with no label is a mode mismatch).
 *
 * Used by tests only; nothing in the app imports it.
 */

import { portalUpgradeConfigEnvName, upgradeConfigsNeeded } from "./checkout";
import {
  ENV_LABEL_ENV,
  requiredPriceEnvNames,
  STRIPE_SECRET_KEY_ENV,
  STRIPE_WEBHOOK_SECRET_ENV,
} from "./readiness";

/** Every variable an open checkout needs, with placeholder values. */
export function openCheckoutEnv(): Record<string, string> {
  const env: Record<string, string> = {
    [STRIPE_SECRET_KEY_ENV]: "sk_test_open_checkout",
    [STRIPE_WEBHOOK_SECRET_ENV]: "whsec_open_checkout",
    [ENV_LABEL_ENV]: "test",
  };
  for (const name of requiredPriceEnvNames()) {
    env[name] = `price_${name.slice("STRIPE_PRICE_".length).toLowerCase()}`;
  }
  // P20-07: the billing sender of a full setup.
  env.BILLING_EMAIL_FROM = "Curvi Billing <billing@updates.curvi.ai>";
  // A fake key: suites that send stub fetch (billing-flow.test.ts).
  env.RESEND_API_KEY = "re_test_checkout_env";
  // P20-06: the upgrade only portal configurations of a full setup.
  for (const from of upgradeConfigsNeeded()) {
    env[portalUpgradeConfigEnvName(from)] = `bpc_upgrade_${from.tier}_${from.cadence}`;
  }
  return env;
}

/** Stubs the open checkout environment, e.g. stubOpenCheckout(vi.stubEnv). */
export function stubOpenCheckout(stubEnv: (name: string, value: string) => unknown): void {
  for (const [name, value] of Object.entries(openCheckoutEnv())) {
    stubEnv(name, value);
  }
}

/** Stubs only the secret key: the half configured Stripe that must keep
 * checkout closed. Clears the rest so earlier stubs cannot open it. */
export function stubKeyOnly(stubEnv: (name: string, value: string) => unknown): void {
  for (const name of Object.keys(openCheckoutEnv())) {
    stubEnv(name, "");
  }
  stubEnv(STRIPE_SECRET_KEY_ENV, "sk_test_key_only");
}

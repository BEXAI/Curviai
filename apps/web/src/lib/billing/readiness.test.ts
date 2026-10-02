import { afterEach, describe, expect, it, vi } from "vitest";
import { tiers, topUps } from "@curvi/pipeline/seed";
import { hasStripeApiKey, isCheckoutOpen } from "@/lib/env";
import { paidTiers } from "./plans";
import { tierPriceEnvName, topUpPriceEnvName } from "./price-table";
import {
  billingReadiness,
  isSelfServeTier,
  requiredPriceEnvNames,
  siteEnvironment,
  stripeKeyMode,
  type BillingProblemCode,
} from "./readiness";
import { openCheckoutEnv, stubKeyOnly, stubOpenCheckout } from "./test-env";

// docs/phases/PHASE_20.md P20-01: checkout opens only when Stripe can grant
// the credits a payment buys.

function reader(env: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => env[name];
}

function codes(env: Record<string, string | undefined>): BillingProblemCode[] {
  return billingReadiness(reader(env)).problems.map((problem) => problem.code);
}

const OPEN = openCheckoutEnv();
const { NEXT_PUBLIC_ENV_LABEL: _label, ...OPEN_NO_LABEL } = OPEN;
const LOCAL = { ...OPEN_NO_LABEL, NEXT_PUBLIC_SITE_URL: "http://localhost:3000" };
const PROD_LIVE = {
  ...OPEN_NO_LABEL,
  STRIPE_SECRET_KEY: "sk_live_prod",
  NEXT_PUBLIC_SITE_URL: "https://curvi.ai",
};

describe("required prices", () => {
  it("names every self serve tier at both cadences and every top up, from the seed", () => {
    const names = requiredPriceEnvNames();
    for (const tier of paidTiers.filter(isSelfServeTier)) {
      expect(names).toContain(tierPriceEnvName(tier.key, "monthly"));
      expect(names).toContain(tierPriceEnvName(tier.key, "annual"));
    }
    for (const topUp of topUps) {
      expect(names).toContain(topUpPriceEnvName(topUp.credits));
    }
    expect(names).not.toContain(tierPriceEnvName("free", "monthly"));
  });

  it("leaves out a tier the seed marks selfServe false (Agency, P20-08)", () => {
    const agency = tiers.find((tier) => tier.key === "agency");
    expect(agency).toBeDefined();
    expect(isSelfServeTier(agency!)).toBe(false);
    expect(isSelfServeTier({ ...agency!, selfServe: true })).toBe(true);
    const names = requiredPriceEnvNames();
    expect(names).not.toContain(tierPriceEnvName("agency", "monthly"));
    expect(names).not.toContain(tierPriceEnvName("agency", "annual"));
  });
});

describe("stripeKeyMode and siteEnvironment", () => {
  it.each([
    ["sk_live_x", "live"],
    ["rk_live_x", "live"],
    ["pk_live_x", "live"],
    ["sk_test_x", "test"],
    ["rk_test_x", "test"],
    ["pk_test_x", "test"],
    ["whsec_x", null],
    [undefined, null],
  ])("%s is %s", (key, mode) => {
    expect(stripeKeyMode(key)).toBe(mode);
  });

  it.each([
    [{}, "local"],
    [{ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }, "local"],
    [{ NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000" }, "local"],
    [{ NEXT_PUBLIC_SITE_URL: "https://curvi.ai" }, "production"],
    [{ NEXT_PUBLIC_SITE_URL: "https://www.curvi.ai/" }, "production"],
    [{ NEXT_PUBLIC_SITE_URL: "https://curvi.ai", NEXT_PUBLIC_ENV_LABEL: "staging" }, "staging"],
    [{ NEXT_PUBLIC_SITE_URL: "https://curvi-staging.onrender.com" }, "other"],
  ])("%j is %s", (env, expected) => {
    expect(siteEnvironment(reader(env))).toBe(expected);
  });
});

describe("billingReadiness over every combination", () => {
  it("reports nothing and stays closed while no Stripe variable is set", () => {
    expect(billingReadiness(reader({}))).toMatchObject({ checkoutOpen: false, apiKey: false, problems: [] });
    expect(billingReadiness(reader({ NEXT_PUBLIC_SITE_URL: "https://curvi.ai" })).problems).toEqual([]);
  });

  it("opens with the key, the webhook secret and every price", () => {
    expect(billingReadiness(reader(OPEN))).toMatchObject({ checkoutOpen: true, apiKey: true, problems: [] });
    expect(billingReadiness(reader(LOCAL)).checkoutOpen).toBe(true);
    expect(billingReadiness(reader(PROD_LIVE))).toMatchObject({ checkoutOpen: true, environment: "production", keyMode: "live" });
  });

  it("keeps checkout closed with the secret key alone and names the webhook secret", () => {
    const readiness = billingReadiness(reader({ STRIPE_SECRET_KEY: "sk_test_alone" }));
    expect(readiness.checkoutOpen).toBe(false);
    expect(readiness.apiKey).toBe(true);
    expect(readiness.problems.map((p) => p.code)).toEqual([
      "stripe_webhook_secret_missing",
      "stripe_price_missing",
      "billing_email_not_configured",
    ]);
  });

  it("stays closed until the billing sender can send the activation email (law and copy review major 4)", () => {
    for (const name of ["BILLING_EMAIL_FROM", "RESEND_API_KEY"]) {
      const readiness = billingReadiness(reader({ ...LOCAL, [name]: undefined }));
      expect(readiness.checkoutOpen).toBe(false);
      expect(readiness.problems.map((p) => p.code)).toEqual(["billing_email_not_configured"]);
      expect(readiness.problems[0]?.message).toContain(name);
    }
  });

  it("closes for each missing piece on its own", () => {
    expect(codes({ ...LOCAL, STRIPE_WEBHOOK_SECRET: undefined })).toEqual(["stripe_webhook_secret_missing"]);
    expect(codes({ ...LOCAL, STRIPE_SECRET_KEY: undefined })).toEqual(["stripe_secret_key_missing"]);
    for (const name of requiredPriceEnvNames()) {
      expect(codes({ ...LOCAL, [name]: undefined })).toEqual(["stripe_price_missing"]);
      expect(billingReadiness(reader({ ...LOCAL, [name]: "  " })).checkoutOpen).toBe(false);
    }
  });

  it("names the missing price variables, never a value", () => {
    const name = requiredPriceEnvNames()[0];
    const problem = billingReadiness(reader({ ...LOCAL, [name]: undefined })).problems[0];
    expect(problem.message).toContain(name);
    expect(JSON.stringify(billingReadiness(reader({ STRIPE_SECRET_KEY: "sk_test_secretvalue" })))).not.toContain(
      "secretvalue",
    );
  });

  it("a test key on staging or on localhost is fine", () => {
    expect(codes({ ...OPEN_NO_LABEL, NEXT_PUBLIC_SITE_URL: "https://curvi.ai", NEXT_PUBLIC_ENV_LABEL: "staging" })).toEqual(
      [],
    );
    expect(codes(LOCAL)).toEqual([]);
    expect(codes({ ...OPEN_NO_LABEL })).toEqual([]);
  });

  it("a test key on the production site with no label is a mismatch", () => {
    const readiness = billingReadiness(reader({ ...OPEN_NO_LABEL, NEXT_PUBLIC_SITE_URL: "https://curvi.ai" }));
    expect(readiness.checkoutOpen).toBe(false);
    expect(readiness.problems.map((p) => p.code)).toEqual(["stripe_key_mode_mismatch"]);
  });

  it("a live key on localhost or on a labelled staging site is a mismatch", () => {
    expect(codes({ ...LOCAL, STRIPE_SECRET_KEY: "sk_live_laptop" })).toEqual(["stripe_key_mode_mismatch"]);
    expect(codes({ ...OPEN, STRIPE_SECRET_KEY: "sk_live_staging" })).toEqual(["stripe_key_mode_mismatch"]);
  });

  it("publishable and secret keys in different modes are a mismatch", () => {
    expect(codes({ ...PROD_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" })).toEqual(["stripe_key_mode_mismatch"]);
    expect(codes({ ...PROD_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_x" })).toEqual([]);
  });

  it("an unrecognized key on another host applies no mode rule", () => {
    expect(codes({ ...OPEN_NO_LABEL, NEXT_PUBLIC_SITE_URL: "https://preview.example.com" })).toEqual([]);
  });

  it("writes every message without dashes as punctuation or arrows (rule 9)", () => {
    const all = [
      billingReadiness(reader({ STRIPE_WEBHOOK_SECRET: "whsec_x" })),
      billingReadiness(reader({ STRIPE_SECRET_KEY: "sk_test_x" })),
      billingReadiness(reader({ ...LOCAL, STRIPE_SECRET_KEY: "sk_live_x" })),
      billingReadiness(reader({ ...OPEN_NO_LABEL, NEXT_PUBLIC_SITE_URL: "https://curvi.ai" })),
      billingReadiness(reader({ ...OPEN, STRIPE_SECRET_KEY: "sk_live_x" })),
      billingReadiness(reader({ ...PROD_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" })),
    ].flatMap((readiness) => readiness.problems.map((problem) => problem.message));
    expect(all.length).toBeGreaterThan(5);
    for (const message of all) {
      expect(message).not.toMatch(/ [-–—] |→|->/);
    }
  });
});

describe("env.ts gates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isCheckoutOpen follows readiness while hasStripeApiKey only sees the key", () => {
    stubKeyOnly(vi.stubEnv);
    expect(hasStripeApiKey()).toBe(true);
    expect(isCheckoutOpen()).toBe(false);
    stubOpenCheckout(vi.stubEnv);
    expect(isCheckoutOpen()).toBe(true);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect(isCheckoutOpen()).toBe(false);
  });
});

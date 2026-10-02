import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  buildCheckoutParams,
  buildPlanChangePortalParams,
  checkoutDisclosure,
  createPlanChangePortalSession,
  DOWNGRADE_BY_EMAIL_LINE,
  MONTHLY_BY_EMAIL_LINE,
  planChangeDirection,
  portalUpgradeConfigEnvName,
  upgradeConfigsNeeded,
  upgradeTargets,
  type CheckoutParamsInput,
} from "./checkout";
import { downgradeByEmailLine } from "./plans";
import type { PriceTable } from "./price-table";
import { RENEWAL_DISCLOSURE_VERSION } from "./renewal-terms";

const base: CheckoutParamsInput = {
  purchase: { kind: "tier", tier: "growth", cadence: "annual" },
  priceId: "price_growth_annual",
  workspaceId: "ws_1",
  siteUrl: "https://curvi.ai",
  source: "pricing",
  customerId: "cus_ws_1",
  taxEnabled: false,
};

describe("buildCheckoutParams", () => {
  it("builds a subscription session with promotion codes, terms consent and full metadata", () => {
    const params = buildCheckoutParams(base);
    expect(params).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_growth_annual", quantity: 1 }],
      success_url: "https://curvi.ai/app/billing?status=success&kind=tier&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://curvi.ai/app/billing?status=canceled",
      client_reference_id: "ws_1",
      allow_promotion_codes: true,
      consent_collection: { terms_of_service: "required" },
      customer: "cus_ws_1",
      metadata: {
        workspaceId: "ws_1",
        priceId: "price_growth_annual",
        kind: "tier",
        plan: "growth",
        cadence: "annual",
        source: "pricing",
      },
      subscription_data: { metadata: { workspaceId: "ws_1", plan: "growth", cadence: "annual", source: "pricing" } },
    });
    const acceptance = params.custom_text?.terms_of_service_acceptance;
    expect(acceptance && typeof acceptance === "object" ? acceptance.message : "").toContain("https://curvi.ai/terms");
    expect(params.automatic_tax).toBeUndefined();
    expect(params.customer_creation).toBeUndefined();
    expect(params.customer_email).toBeUndefined();
  });

  it("puts the renewal terms beside the pay button and the renewal consent in the checkbox, with the disclosure in the metadata (P20-07)", () => {
    const now = new Date("2026-10-02T15:00:00Z");
    const params = buildCheckoutParams({ ...base, now, userId: "user_1" });
    const disclosure = checkoutDisclosure({ tier: "growth", cadence: "annual", siteUrl: "https://curvi.ai", now });
    expect(params.consent_collection).toEqual({ terms_of_service: "required" });
    expect(params.custom_text).toEqual({
      submit: { message: disclosure.submit },
      terms_of_service_acceptance: { message: disclosure.acceptance },
    });
    expect(disclosure.submit).toContain("renews automatically every year at $792");
    expect(disclosure.submit).toContain("cancel before October 2, 2027");
    expect(params.metadata).toMatchObject({
      disclosure_version: RENEWAL_DISCLOSURE_VERSION,
      disclosure_sha256: disclosure.sha256,
      userId: "user_1",
    });
  });

  it("keeps a top up's plain terms checkbox and no renewal disclosure", () => {
    const params = buildCheckoutParams({ ...base, purchase: { kind: "topup", credits: 100 } });
    expect(params.custom_text).toEqual({
      terms_of_service_acceptance: { message: "I agree to the [Terms of Service](https://curvi.ai/terms)." },
    });
    expect(params.metadata).not.toHaveProperty("disclosure_version");
  });

  it("always passes the workspace customer and never lets Checkout make one, for tiers and top ups", () => {
    for (const purchase of [base.purchase, { kind: "topup" as const, credits: 100 }]) {
      const params = buildCheckoutParams({ ...base, purchase, customerId: "cus_existing" });
      expect(params.customer).toBe("cus_existing");
      expect(params.customer_email).toBeUndefined();
      expect(params.customer_creation).toBeUndefined();
    }
  });

  it("turns on tax only behind the flag, saving address and name for existing customers", () => {
    const withTax = buildCheckoutParams({ ...base, customerId: "cus_existing", taxEnabled: true });
    expect(withTax).toMatchObject({
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
    });
    const withoutTax = buildCheckoutParams({ ...base, customerId: "cus_existing" });
    expect(withoutTax.customer_update).toBeUndefined();
  });

  it("builds a top up as a one time payment with a customer, an invoice and tagged payment", () => {
    const params = buildCheckoutParams({
      ...base,
      purchase: { kind: "topup", credits: 100 },
      priceId: "price_topup_100",
      source: "billing",
    });
    expect(params).toMatchObject({
      mode: "payment",
      customer: "cus_ws_1",
      invoice_creation: { enabled: true },
      payment_intent_data: { metadata: { workspaceId: "ws_1", credits: "100" } },
      metadata: { kind: "topup", plan: "topup", cadence: "one_time", credits: "100", priceId: "price_topup_100" },
      success_url: "https://curvi.ai/app/billing?status=success&kind=topup&session_id={CHECKOUT_SESSION_ID}",
    });
    expect(params.subscription_data).toBeUndefined();
  });
});

describe("buildPlanChangePortalParams", () => {
  const input = {
    customerId: "cus_1",
    subscriptionId: "sub_1",
    priceId: "price_pro_monthly",
    returnUrl: "https://curvi.ai/app/billing",
  };

  it("opens the confirm step for the chosen price when the item is known", () => {
    const params = buildPlanChangePortalParams({ ...input, subscriptionItemId: "si_1" });
    expect(params.flow_data).toMatchObject({
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: "sub_1",
        items: [{ id: "si_1", price: "price_pro_monthly", quantity: 1 }],
      },
      after_completion: {
        type: "redirect",
        redirect: { return_url: "https://curvi.ai/app/billing?status=success&kind=plan_change" },
      },
    });
  });

  it("falls back to the plan picker without an item id", () => {
    const params = buildPlanChangePortalParams({ ...input, subscriptionItemId: null });
    expect(params.flow_data).toMatchObject({
      type: "subscription_update",
      subscription_update: { subscription: "sub_1" },
    });
  });
});

describe("downgrades by email, upgrades through an upgrade only portal (P20-06 stopgap)", () => {
  const table: PriceTable = {
    price_starter_m: { kind: "tier", tier: "starter", cadence: "monthly", creditsPerMonth: 200, priceCents: 2900 },
    price_growth_m: { kind: "tier", tier: "growth", cadence: "monthly", creditsPerMonth: 600, priceCents: 7900 },
    price_growth_a: { kind: "tier", tier: "growth", cadence: "annual", creditsPerMonth: 600, priceCents: 79200 },
    price_pro_m: { kind: "tier", tier: "pro", cadence: "monthly", creditsPerMonth: 1300, priceCents: 14900 },
    price_pro_a: { kind: "tier", tier: "pro", cadence: "annual", creditsPerMonth: 1300, priceCents: 148800 },
    price_starter_a: { kind: "tier", tier: "starter", cadence: "annual", creditsPerMonth: 200, priceCents: 28800 },
  };
  const env: Record<string, string> = {
    [portalUpgradeConfigEnvName({ tier: "growth", cadence: "monthly" })]: "bpc_growth_up",
    [portalUpgradeConfigEnvName({ tier: "growth", cadence: "annual" })]: "bpc_growth_annual_up",
    [portalUpgradeConfigEnvName({ tier: "starter", cadence: "annual" })]: "bpc_starter_annual_up",
    [portalUpgradeConfigEnvName({ tier: "pro", cadence: "monthly" })]: "bpc_pro_up",
  };
  const input = { customerId: "cus_1", subscriptionId: "sub_1", returnUrl: "https://curvi.ai/app/billing" };

  function fakeStripe(currentPrice: string, schedule: string | null = null) {
    const calls: string[] = [];
    const create = vi.fn(async (_params: Stripe.BillingPortal.SessionCreateParams) => {
      calls.push("portal.create");
      return { id: "bps_1", url: "https://billing.stripe.test/portal" };
    });
    const release = vi.fn(async (id: string) => {
      calls.push(`release:${id}`);
      return { id };
    });
    // The founder's schedule: Starter monthly from November 3, 2026.
    const retrieveSchedule = vi.fn(async (id: string) => ({
      id,
      phases: [
        { start_date: 1_790_000_000, items: [{ price: currentPrice }] },
        { start_date: 1_793_664_000, items: [{ price: "price_starter_m" }] },
      ],
    }));
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(async () => ({ id: "sub_1", schedule, items: { data: [{ id: "si_1", price: { id: currentPrice } }] } })),
      },
      subscriptionSchedules: { release, retrieve: retrieveSchedule },
      billingPortal: { sessions: { create } },
    } as unknown as Stripe;
    return { stripe, create, release, calls };
  }

  const quiet = { warn: () => undefined };

  it("names one upgrade configuration per plan and cadence below the top price sold online, never listing Agency", () => {
    expect(upgradeConfigsNeeded()).toEqual([
      { tier: "starter", cadence: "monthly" },
      { tier: "starter", cadence: "annual" },
      { tier: "growth", cadence: "monthly" },
      { tier: "growth", cadence: "annual" },
      { tier: "pro", cadence: "monthly" },
    ]);
    expect(upgradeTargets({ tier: "starter", cadence: "monthly" })).toEqual([
      { tier: "starter", cadence: "annual" },
      { tier: "growth", cadence: "monthly" },
      { tier: "growth", cadence: "annual" },
      { tier: "pro", cadence: "monthly" },
      { tier: "pro", cadence: "annual" },
    ]);
    // A yearly subscriber's configuration lists yearly prices only.
    expect(upgradeTargets({ tier: "starter", cadence: "annual" })).toEqual([
      { tier: "growth", cadence: "annual" },
      { tier: "pro", cadence: "annual" },
    ]);
    expect(upgradeTargets({ tier: "growth", cadence: "annual" })).toEqual([{ tier: "pro", cadence: "annual" }]);
    expect(upgradeTargets({ tier: "pro", cadence: "monthly" })).toEqual([{ tier: "pro", cadence: "annual" }]);
    expect(upgradeTargets({ tier: "pro", cadence: "annual" })).toEqual([]);
    expect(portalUpgradeConfigEnvName({ tier: "starter", cadence: "monthly" })).toBe("STRIPE_PORTAL_UPGRADE_CONFIG_STARTER");
    expect(portalUpgradeConfigEnvName({ tier: "growth", cadence: "annual" })).toBe("STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH_ANNUAL");
    expect(portalUpgradeConfigEnvName({ tier: "pro", cadence: "monthly" })).toBe("STRIPE_PORTAL_UPGRADE_CONFIG_PRO");
  });

  it("tells an upgrade from a downgrade, by plan and by cadence", () => {
    expect(planChangeDirection({ tier: "starter", cadence: "monthly" }, { tier: "growth", cadence: "monthly" })).toBe("upgrade");
    expect(planChangeDirection({ tier: "starter", cadence: "monthly" }, { tier: "growth", cadence: "annual" })).toBe("upgrade");
    expect(planChangeDirection({ tier: "growth", cadence: "monthly" }, { tier: "growth", cadence: "annual" })).toBe("upgrade");
    expect(planChangeDirection({ tier: "starter", cadence: "annual" }, { tier: "pro", cadence: "annual" })).toBe("upgrade");
    expect(planChangeDirection({ tier: "pro", cadence: "annual" }, { tier: "growth", cadence: "annual" })).toBe("downgrade");
    expect(planChangeDirection({ tier: "growth", cadence: "annual" }, { tier: "growth", cadence: "monthly" })).toBe("downgrade");
    expect(planChangeDirection({ tier: "growth", cadence: "monthly" }, { tier: "growth", cadence: "monthly" })).toBe("same");
    expect(planChangeDirection(null, { tier: "pro", cadence: "monthly" })).toBe("downgrade");
  });

  it("treats yearly to monthly as a downgrade even onto a bigger plan (security review major 1)", () => {
    // Stripe returns the rest of the year as credit, so applying it at once
    // would take the year's credits back in full, below zero.
    expect(planChangeDirection({ tier: "growth", cadence: "annual" }, { tier: "pro", cadence: "monthly" })).toBe("downgrade");
    expect(planChangeDirection({ tier: "starter", cadence: "annual" }, { tier: "growth", cadence: "monthly" })).toBe("downgrade");
    expect(planChangeDirection({ tier: "starter", cadence: "annual" }, { tier: "pro", cadence: "monthly" })).toBe("downgrade");
    expect(downgradeByEmailLine({ tier: "growth", cadence: "annual" }, { tier: "pro", cadence: "monthly" })).toBe(MONTHLY_BY_EMAIL_LINE);
    expect(downgradeByEmailLine({ tier: "growth", cadence: "annual" }, { tier: "growth", cadence: "monthly" })).toBe(MONTHLY_BY_EMAIL_LINE);
    expect(downgradeByEmailLine({ tier: "pro", cadence: "annual" }, { tier: "growth", cadence: "monthly" })).toBe(DOWNGRADE_BY_EMAIL_LINE);
    expect(downgradeByEmailLine({ tier: "pro", cadence: "monthly" }, { tier: "growth", cadence: "monthly" })).toBe(DOWNGRADE_BY_EMAIL_LINE);
    expect(MONTHLY_BY_EMAIL_LINE).toBe("Email us to switch to monthly billing. It takes effect at your next renewal.");
  });

  it("calls a change an upgrade exactly when the subscriber's configuration lists the price", () => {
    const prices = upgradeConfigsNeeded().concat([{ tier: "pro", cadence: "annual" }]);
    for (const from of prices) {
      const listed = upgradeTargets(from);
      for (const to of prices) {
        const isListed = listed.some((target) => target.tier === to.tier && target.cadence === to.cadence);
        const direction = planChangeDirection(from, to);
        expect(direction === "upgrade", `${from.tier} ${from.cadence} to ${to.tier} ${to.cadence}`).toBe(isListed);
        if (direction === "upgrade") {
          // Never a cut in money: monthly to yearly, or a bigger plan.
          expect(from.cadence === "annual" && to.cadence === "monthly").toBe(false);
        }
      }
    }
  });

  it("passes the configuration to both portal flows", () => {
    const params = buildPlanChangePortalParams({ ...input, priceId: "price_pro_m", subscriptionItemId: "si_1", configuration: "bpc_1" });
    expect(params.configuration).toBe("bpc_1");
    expect(buildPlanChangePortalParams({ ...input, priceId: "price_pro_m", subscriptionItemId: null, configuration: null }).configuration).toBeUndefined();
  });

  it("opens the upgrade on the current tier's upgrade only configuration", async () => {
    const { stripe, create } = fakeStripe("price_growth_m");
    const result = await createPlanChangePortalSession(stripe, { ...input, priceId: "price_pro_m" }, { priceTable: table, readEnv: (name) => env[name], logger: quiet });
    expect(result).toEqual({
      kind: "portal",
      url: "https://billing.stripe.test/portal",
      sessionId: "bps_1",
      upgrade: { tier: "pro", cadence: "monthly" },
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      configuration: "bpc_growth_up",
      flow_data: { type: "subscription_update_confirm" },
    });
  });

  it("never changes a smaller plan or yearly to monthly online", async () => {
    for (const [current, chosen] of [
      ["price_pro_m", "price_growth_m"],
      ["price_growth_a", "price_growth_m"],
      ["price_growth_a", "price_pro_m"],
      ["price_starter_a", "price_growth_m"],
    ]) {
      const { stripe, create, release } = fakeStripe(current, "sub_sched_1");
      const result = await createPlanChangePortalSession(stripe, { ...input, priceId: chosen }, { priceTable: table, readEnv: () => undefined, logger: quiet });
      expect(result.kind).toBe("downgrade_by_email");
      expect(create).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    }
    expect(DOWNGRADE_BY_EMAIL_LINE).toBe("Email us to move to a smaller plan. It takes effect at your next renewal.");
  });

  it("says which email a change needs: a smaller plan, or monthly billing", async () => {
    const smaller = await createPlanChangePortalSession(fakeStripe("price_pro_m").stripe, { ...input, priceId: "price_growth_m" }, { priceTable: table, readEnv: () => undefined, logger: quiet });
    expect(smaller).toEqual({ kind: "downgrade_by_email", line: DOWNGRADE_BY_EMAIL_LINE });
    const monthly = await createPlanChangePortalSession(fakeStripe("price_growth_a").stripe, { ...input, priceId: "price_pro_m" }, { priceTable: table, readEnv: () => undefined, logger: quiet });
    expect(monthly).toEqual({ kind: "downgrade_by_email", line: MONTHLY_BY_EMAIL_LINE });
  });

  it("opens a yearly subscriber's upgrade on the yearly only configuration, and Pro monthly on Pro's", async () => {
    const yearly = fakeStripe("price_growth_a");
    await createPlanChangePortalSession(yearly.stripe, { ...input, priceId: "price_pro_a" }, { priceTable: table, readEnv: (name) => env[name], logger: quiet });
    expect(yearly.create.mock.calls[0]?.[0]).toMatchObject({ configuration: "bpc_growth_annual_up" });
    const pro = fakeStripe("price_pro_m");
    await createPlanChangePortalSession(pro.stripe, { ...input, priceId: "price_pro_a" }, { priceTable: table, readEnv: (name) => env[name], logger: quiet });
    expect(pro.create.mock.calls[0]?.[0]).toMatchObject({ configuration: "bpc_pro_up", flow_data: { type: "subscription_update_confirm" } });
  });

  it("never falls back to a monthly subscriber's configuration for a yearly one", async () => {
    const { stripe, create } = fakeStripe("price_starter_a");
    const onlyMonthly = { [portalUpgradeConfigEnvName({ tier: "starter", cadence: "monthly" })]: "bpc_starter_up" };
    await createPlanChangePortalSession(stripe, { ...input, priceId: "price_pro_a" }, { priceTable: table, readEnv: (name) => onlyMonthly[name], logger: quiet });
    for (const call of create.mock.calls) {
      expect(call[0].configuration).toBeUndefined();
    }
  });

  it("asks before an upgrade cancels a change the founder scheduled, and releases nothing (law and copy review major 7)", async () => {
    const { stripe, release, create } = fakeStripe("price_growth_m", "sub_sched_9");
    const onScheduleReleased = vi.fn(async () => undefined);
    const result = await createPlanChangePortalSession(
      stripe,
      { ...input, priceId: "price_pro_m" },
      { priceTable: table, readEnv: () => undefined, logger: quiet, onScheduleReleased },
    );
    expect(result).toMatchObject({
      kind: "scheduled_change",
      notice: "This cancels your move to Starter on November 3, 2026. Choose Continue to upgrade anyway.",
    });
    expect(release).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(onScheduleReleased).not.toHaveBeenCalled();
  });

  it("releases the attached schedule once the subscriber confirms, reports it, then opens the upgrade", async () => {
    const { stripe, calls } = fakeStripe("price_growth_m", "sub_sched_9");
    const reported: unknown[] = [];
    const result = await createPlanChangePortalSession(
      stripe,
      { ...input, priceId: "price_pro_m", releaseScheduledChange: true },
      {
        priceTable: table,
        readEnv: () => undefined,
        logger: quiet,
        onScheduleReleased: async (change) => {
          calls.push("reported");
          reported.push(change);
        },
      },
    );
    expect(result.kind).toBe("portal");
    expect(calls).toEqual(["release:sub_sched_9", "reported", "portal.create"]);
    expect(reported[0]).toMatchObject({ scheduleId: "sub_sched_9", tier: "starter", cadence: "monthly" });
  });

  it("opens the portal home on the plan the subscriber already has", async () => {
    const { stripe, create } = fakeStripe("price_growth_m");
    const result = await createPlanChangePortalSession(stripe, { ...input, priceId: "price_growth_m" }, { priceTable: table, logger: quiet });
    // The home is no plan change, so no consent row names a price.
    expect(result).toMatchObject({ kind: "portal", upgrade: null });
    expect(create.mock.calls[0]?.[0]).toEqual({ customer: "cus_1", return_url: "https://curvi.ai/app/billing" });
  });
});

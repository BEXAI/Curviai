import { describe, expect, it } from "vitest";
import { buildCheckoutParams, buildPlanChangePortalParams, type CheckoutParamsInput } from "./checkout";

const base: CheckoutParamsInput = {
  purchase: { kind: "tier", tier: "growth", cadence: "annual" },
  priceId: "price_growth_annual",
  workspaceId: "ws_1",
  siteUrl: "https://curvi.ai",
  source: "pricing",
  customerId: null,
  customerEmail: "owner@example.com",
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
      customer_email: "owner@example.com",
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
    expect(params.customer).toBeUndefined();
    expect(params.automatic_tax).toBeUndefined();
    expect(params.customer_creation).toBeUndefined();
  });

  it("reuses the workspace customer instead of the email", () => {
    const params = buildCheckoutParams({ ...base, customerId: "cus_existing" });
    expect(params.customer).toBe("cus_existing");
    expect(params.customer_email).toBeUndefined();
  });

  it("turns on tax only behind the flag, saving address and name for existing customers", () => {
    const withTax = buildCheckoutParams({ ...base, customerId: "cus_existing", taxEnabled: true });
    expect(withTax).toMatchObject({
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
    });
    const newCustomer = buildCheckoutParams({ ...base, taxEnabled: true });
    expect(newCustomer.customer_update).toBeUndefined();
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
      customer_creation: "always",
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

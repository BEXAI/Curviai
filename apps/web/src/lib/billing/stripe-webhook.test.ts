import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { tierByKey, topUps } from "@curvi/pipeline/seed";
import { buildPriceTable, tierPriceCents, tierPriceEnvName, topUpPriceEnvName } from "./price-table";
import {
  billingPeriodStart,
  ceilCredits,
  floorCredits,
  HANDLED_STRIPE_EVENTS,
  InMemoryBillingStore,
  type StripeBillingActions,
  planInvoiceGrant,
  processStripeEvent,
  prorationShare,
  roundCredits,
  timeShareBounds,
  UnroutableBillingEventError,
  verifyStripeEvent,
} from "./stripe-webhook";

const SECRET = "whsec_test_secret";
const stripe = new Stripe("sk_test_placeholder");

const ENV: Record<string, string> = {
  [tierPriceEnvName("starter", "monthly")]: "price_starter_monthly",
  [tierPriceEnvName("growth", "monthly")]: "price_growth_monthly",
  [tierPriceEnvName("growth", "annual")]: "price_growth_annual",
  [tierPriceEnvName("pro", "monthly")]: "price_pro_monthly",
  [tierPriceEnvName("pro", "annual")]: "price_pro_annual",
  [topUpPriceEnvName(100)]: "price_topup_100",
};

const table = buildPriceTable((name) => ENV[name]);

const growth = tierByKey("growth");
const pro = tierByKey("pro");
const DAY = 24 * 60 * 60;
const T0 = 1_790_000_000;

function signedEvent(payloadObject: Record<string, unknown>): { payload: string; header: string } {
  const payload = JSON.stringify(payloadObject);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, header };
}

function verify(payloadObject: Record<string, unknown>): Stripe.Event {
  const { payload, header } = signedEvent(payloadObject);
  return verifyStripeEvent(payload, header, SECRET);
}

interface LineFixture {
  price: string;
  amount: number;
  proration?: boolean;
  start?: number;
  end?: number;
}

function line({ price, amount, proration = false, start = T0, end = T0 + 30 * DAY }: LineFixture) {
  return {
    id: `il_${price}_${amount}`,
    amount,
    period: { start, end },
    pricing: { type: "price_details", price_details: { price } },
    parent: {
      type: "subscription_item_details",
      subscription_item_details: { proration, subscription: "sub_1", subscription_item: "si_1" },
      invoice_item_details: null,
    },
  };
}

function invoiceEvent(
  id: string,
  billingReason: string | null,
  lines: ReturnType<typeof line>[],
  workspaceId: string | null = "ws_9",
  customer = "cus_1",
): Stripe.Event {
  return verify({
    id: `evt_${id}`,
    type: "invoice.paid",
    data: {
      object: {
        id,
        object: "invoice",
        customer,
        billing_reason: billingReason,
        parent: {
          type: "subscription_details",
          subscription_details: { metadata: workspaceId ? { workspaceId } : {} },
        },
        lines: { data: lines },
      },
    },
  });
}

function checkoutEvent(
  eventId: string,
  type: string,
  overrides: Record<string, unknown> = {},
): Stripe.Event {
  return verify({
    id: eventId,
    type,
    data: {
      object: {
        id: "cs_1",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_1",
        payment_status: "paid",
        payment_intent: "pi_topup_1",
        metadata: { workspaceId: "ws_1", priceId: "price_topup_100" },
        ...overrides,
      },
    },
  });
}

describe("verifyStripeEvent", () => {
  it("accepts a header generated with generateTestHeaderString", () => {
    const event = verify({ id: "evt_ok", type: "checkout.session.completed", data: { object: {} } });
    expect(event.id).toBe("evt_ok");
  });

  it("rejects a tampered payload", () => {
    const { header } = signedEvent({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const tampered = JSON.stringify({ id: "evt_2", type: "invoice.paid", data: { object: {} } });
    expect(() => verifyStripeEvent(tampered, header, SECRET)).toThrow();
  });

  it("rejects the wrong secret", () => {
    const { payload, header } = signedEvent({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    expect(() => verifyStripeEvent(payload, header, "whsec_other")).toThrow();
  });
});

describe("price table", () => {
  it("maps env named price ids to seed tiers and top ups", () => {
    expect(table["price_starter_monthly"]).toEqual({
      kind: "tier",
      tier: "starter",
      cadence: "monthly",
      creditsPerMonth: tierByKey("starter").creditsPerMonth,
      priceCents: tierByKey("starter").monthlyUsd * 100,
    });
    expect(table["price_growth_annual"]).toMatchObject({
      kind: "tier",
      tier: "growth",
      cadence: "annual",
      // A full year at the annual rate, from the seed.
      priceCents: tierByKey("growth").annualUsdPerMonth * 12 * 100,
    });
    expect(tierPriceCents("free", "monthly")).toBe(0);
    expect(table["price_topup_100"]).toEqual({
      kind: "topup",
      credits: 100,
      expiresMonths: topUps.find((t) => t.credits === 100)?.expiresMonths,
    });
    expect(table["price_unset"]).toBeUndefined();
  });
});

describe("top ups (Update.md 1.4)", () => {
  it("grants a paid top up once and dedupes the retry", async () => {
    const store = new InMemoryBillingStore();
    const event = checkoutEvent("evt_checkout_1", "checkout.session.completed");

    const first = await processStripeEvent(event, table, store);
    expect(first).toMatchObject({ handled: true, action: "topup_granted", duplicate: false, credits: 100 });
    const second = await processStripeEvent(event, table, store);
    expect(second).toMatchObject({ handled: true, action: "topup_granted", duplicate: true });

    expect(store.grants).toHaveLength(1);
    expect(store.grants[0].grant).toMatchObject({
      workspaceId: "ws_1",
      credits: 100,
      reason: "topup",
      payment: { paymentIntentId: "pi_topup_1", checkoutSessionId: "cs_1" },
    });
    expect(store.customerLinks.get("ws_1")).toBe("cus_1");
  });

  it("does not grant when the session completes before the payment clears", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      checkoutEvent("evt_checkout_unpaid", "checkout.session.completed", { payment_status: "unpaid" }),
      table,
      store,
    );
    expect(result).toEqual({ handled: true, action: "topup_awaiting_payment" });
    expect(store.grants).toHaveLength(0);
  });

  it("grants once on async_payment_succeeded, even if delivered twice", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      checkoutEvent("evt_checkout_unpaid", "checkout.session.completed", { payment_status: "unpaid" }),
      table,
      store,
    );
    const success = checkoutEvent("evt_async_ok", "checkout.session.async_payment_succeeded");
    expect(await processStripeEvent(success, table, store)).toMatchObject({ action: "topup_granted", duplicate: false });
    expect(await processStripeEvent(success, table, store)).toMatchObject({ action: "topup_granted", duplicate: true });
    expect(store.grants).toHaveLength(1);
  });

  it("records an async payment failure without granting", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      checkoutEvent("evt_async_fail", "checkout.session.async_payment_failed", { payment_status: "unpaid" }),
      table,
      store,
    );
    expect(result).toEqual({ handled: true, action: "topup_payment_failed" });
    expect(store.grants).toHaveLength(0);
    expect(store.notes[0].note.kind).toBe("async_payment_failed");
  });
});

/** Half of the September to October period that ends at T0 + 15 days. */
const HALF_MONTH = { start: T0, end: T0 + 15 * DAY };
const PRO_GROWTH_MONTH = pro.creditsPerMonth - growth.creditsPerMonth;

function planOf(event: Stripe.Event) {
  return planInvoiceGrant(event.data.object as Stripe.Invoice, table);
}

const utc = (iso: string) => Date.parse(iso) / 1000;
const PRO_CENTS = tierPriceCents("pro", "monthly");
const GROWTH_CENTS = tierPriceCents("growth", "monthly");
const PRO_MONTHLY = { cadence: "monthly" as const, priceCents: PRO_CENTS };
const GROWTH_MONTHLY = { cadence: "monthly" as const, priceCents: GROWTH_CENTS };
/** A subscription anchored on the 31st: its February period is 28 days. */
const JAN31_FEB28 = { start: utc("2027-01-31T00:00:00Z"), end: utc("2027-02-28T00:00:00Z") };
/** The same anchor in a 30 day month. */
const MAR31_APR30 = { start: utc("2027-03-31T00:00:00Z"), end: utc("2027-04-30T00:00:00Z") };

/** What Stripe puts on a proration line for a change at `changeAt`: the full
 * period price times the time left of the real period, to the cent. */
function stripeProration(priceCents: number, period: { start: number; end: number }, changeAt: number): number {
  return Math.round((priceCents * (period.end - changeAt)) / (period.end - period.start));
}

describe("proration share (money-plan-change)", () => {
  it("finds the longest and the shortest billing period that can end on a date", () => {
    expect(billingPeriodStart(utc("2027-03-31T00:00:00Z"), "monthly")).toBe(utc("2027-02-28T00:00:00Z"));
    expect(billingPeriodStart(utc("2027-01-15T08:00:00Z"), "monthly")).toBe(utc("2026-12-15T08:00:00Z"));
    expect(billingPeriodStart(utc("2028-02-29T00:00:00Z"), "annual")).toBe(utc("2027-02-28T00:00:00Z"));
    // A period ending on a month end may have begun on a later anchor day.
    expect(billingPeriodStart(JAN31_FEB28.end, "monthly")).toBe(utc("2027-01-28T00:00:00Z"));
    expect(billingPeriodStart(JAN31_FEB28.end, "monthly", "shortest")).toBe(JAN31_FEB28.start);
    expect(billingPeriodStart(MAR31_APR30.end, "monthly")).toBe(utc("2027-03-30T00:00:00Z"));
    expect(billingPeriodStart(MAR31_APR30.end, "monthly", "shortest")).toBe(MAR31_APR30.start);
    expect(billingPeriodStart(utc("2029-02-28T00:00:00Z"), "annual", "shortest")).toBe(utc("2028-02-29T00:00:00Z"));
    // Away from a month end both are the calendar start.
    expect(billingPeriodStart(utc("2027-01-15T08:00:00Z"), "monthly", "shortest")).toBe(utc("2026-12-15T08:00:00Z"));
  });

  it("bounds the time a line covers between the longest and the shortest period", () => {
    expect(timeShareBounds({ periodStart: HALF_MONTH.start, periodEnd: HALF_MONTH.end }, "monthly")).toEqual({
      floor: 0.5,
      ceiling: 0.5,
    });
    const midFeb = timeShareBounds({ periodStart: utc("2027-02-14T00:00:00Z"), periodEnd: JAN31_FEB28.end }, "monthly");
    expect(midFeb.floor).toBeCloseTo(14 / 31, 10);
    expect(midFeb.ceiling).toBe(0.5);
    const end = utc("2027-09-21T00:00:00Z");
    expect(timeShareBounds({ periodStart: end - 73 * DAY, periodEnd: end }, "annual").floor).toBeCloseTo(73 / 365, 10);
    expect(timeShareBounds({ periodStart: T0 - 60 * DAY, periodEnd: T0 }, "monthly")).toEqual({ floor: 1, ceiling: 1 });
    expect(timeShareBounds({ periodStart: null, periodEnd: null }, "monthly")).toEqual({ floor: 1, ceiling: 1 });
  });

  it("follows Stripe's own proration on a clamped period, not the calendar month", () => {
    const changeAt = utc("2027-02-14T00:00:00Z");
    const credit = { amount: -stripeProration(PRO_CENTS, JAN31_FEB28, changeAt), periodStart: changeAt, periodEnd: JAN31_FEB28.end };
    const charge = { amount: stripeProration(GROWTH_CENTS, JAN31_FEB28, changeAt), periodStart: changeAt, periodEnd: JAN31_FEB28.end };
    // Half of the real 28 day period is left; a calendar month says 14 of 31 days.
    expect(prorationShare(credit, PRO_MONTHLY)).toBe(0.5);
    expect(prorationShare(charge, GROWTH_MONTHLY)).toBe(0.5);
    // A minute after a full price renewal Stripe returns almost the whole
    // price; the share never passes the time actually left.
    const renewal = { amount: -PRO_CENTS, periodStart: JAN31_FEB28.start + 60, periodEnd: JAN31_FEB28.end };
    expect(prorationShare(renewal, PRO_MONTHLY)).toBeCloseTo(1, 4);
  });

  it("follows time, not money, when the amount share falls outside the time bounds", () => {
    const half = { periodStart: HALF_MONTH.start, periodEnd: HALF_MONTH.end };
    // A discount or a Stripe price below the seed shrinks the amount share;
    // the line still stands for half of the period.
    expect(prorationShare({ ...half, amount: 3000 }, PRO_MONTHLY)).toBe(0.5);
    expect(prorationShare({ ...half, amount: -3000 }, PRO_MONTHLY)).toBe(0.5);
    // A Stripe price above the seed returns more money, not more time.
    expect(prorationShare({ ...half, amount: -11175 }, PRO_MONTHLY)).toBe(0.5);
    expect(prorationShare({ ...half, amount: PRO_CENTS * 2 }, PRO_MONTHLY)).toBe(0.5);
    expect(prorationShare({ ...half, amount: -PRO_CENTS * 2 }, PRO_MONTHLY)).toBe(0.5);
    // On a clamped period the time bounds differ: a charge counts the
    // shortest share, a credit the longest.
    const changeAt = utc("2027-02-14T00:00:00Z");
    const feb = { periodStart: changeAt, periodEnd: JAN31_FEB28.end };
    const discounted = Math.round(stripeProration(PRO_CENTS, JAN31_FEB28, changeAt) * 0.3);
    expect(prorationShare({ ...feb, amount: discounted }, PRO_MONTHLY)).toBeCloseTo(14 / 31, 10);
    expect(prorationShare({ ...feb, amount: -discounted }, PRO_MONTHLY)).toBe(0.5);
  });

  it("uses the side of the time bounds that cannot create credits when amounts are not comparable", () => {
    const changeAt = utc("2027-02-14T00:00:00Z");
    const feb = { periodStart: changeAt, periodEnd: JAN31_FEB28.end };
    expect(prorationShare({ ...feb, amount: 5000 }, PRO_MONTHLY, "eur")).toBeCloseTo(14 / 31, 10);
    expect(prorationShare({ ...feb, amount: -5000 }, PRO_MONTHLY, "eur")).toBe(0.5);
    expect(prorationShare({ ...feb, amount: 5000 }, { cadence: "monthly", priceCents: 0 })).toBeCloseTo(14 / 31, 10);
    expect(prorationShare({ ...feb, amount: -5000 }, { cadence: "monthly", priceCents: 0 })).toBe(0.5);
    expect(prorationShare({ ...feb, amount: -7450 }, PRO_MONTHLY, "USD")).toBe(0.5);
  });

  it("rounds grants down and debits up", () => {
    expect(floorCredits(233.39)).toBe(233.3);
    expect(ceilCredits(233.31)).toBe(233.4);
    expect(floorCredits(350)).toBe(350);
    expect(ceilCredits(350)).toBe(350);
  });
});

describe("subscription invoices (Update.md 1.2, money-webhook-hardening)", () => {
  it("grants one month on a monthly cycle invoice, keyed on the invoice", async () => {
    const store = new InMemoryBillingStore();
    const event = invoiceEvent("in_1", "subscription_cycle", [line({ price: "price_growth_monthly", amount: 7900 })]);

    const result = await processStripeEvent(event, table, store);
    expect(result).toMatchObject({ handled: true, action: "cycle_credits_granted", duplicate: false });
    expect(store.grants[0].grant).toMatchObject({
      workspaceId: "ws_9",
      credits: growth.creditsPerMonth,
      reason: "grant",
      payment: { invoiceId: "in_1" },
    });

    await processStripeEvent(event, table, store);
    expect(store.grants).toHaveLength(1);
  });

  it("grants the full year up front on a paid annual invoice", async () => {
    const store = new InMemoryBillingStore();
    const event = invoiceEvent("in_annual", "subscription_create", [
      line({ price: "price_growth_annual", amount: 79200, end: T0 + 365 * DAY }),
    ]);
    const result = await processStripeEvent(event, table, store);
    expect(result).toMatchObject({ action: "cycle_credits_granted", credits: growth.creditsPerMonth * 12 });
    expect(store.grants[0].grant.credits).toBe(growth.creditsPerMonth * 12);
  });

  it("grants only the upgrade difference for the half month left", () => {
    const plan = planOf(
      invoiceEvent("in_up", "subscription_update", [
        line({ price: "price_growth_monthly", amount: -3950, proration: true, ...HALF_MONTH }),
        line({ price: "price_pro_monthly", amount: 7450, proration: true, ...HALF_MONTH }),
      ]),
    );
    expect(plan.credits).toBe(PRO_GROWTH_MONTH / 2);
    expect(plan.debit).toBe(0);
    expect(plan.base).toBe(0);
  });

  it("grants the whole month's difference only when the change covers the whole month", () => {
    const plan = planOf(
      invoiceEvent("in_up_full", "subscription_update", [
        line({ price: "price_growth_monthly", amount: -7900, proration: true }),
        line({ price: "price_pro_monthly", amount: 14900, proration: true }),
      ]),
    );
    expect(plan.credits).toBe(PRO_GROWTH_MONTH);
  });

  it("does not use the first line when a cycle invoice starts with a proration", async () => {
    const store = new InMemoryBillingStore();
    const event = invoiceEvent("in_cycle_mixed", "subscription_cycle", [
      line({ price: "price_growth_monthly", amount: -3950, proration: true, ...HALF_MONTH }),
      line({ price: "price_pro_monthly", amount: 7450, proration: true, ...HALF_MONTH }),
      line({ price: "price_pro_monthly", amount: 14900, start: HALF_MONTH.end, end: HALF_MONTH.end + 31 * DAY }),
    ]);
    await processStripeEvent(event, table, store);
    expect(store.grants[0].grant.credits).toBe(pro.creditsPerMonth + PRO_GROWTH_MONTH / 2);
  });

  it("takes back the same difference on a downgrade, since Stripe returns the unused money", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_pro_cycle", "subscription_cycle", [line({ price: "price_pro_monthly", amount: 14900 })]),
      table,
      store,
    );
    const downgrade = invoiceEvent("in_down", "subscription_update", [
      line({ price: "price_pro_monthly", amount: -7450, proration: true, ...HALF_MONTH }),
      line({ price: "price_growth_monthly", amount: 3950, proration: true, ...HALF_MONTH }),
    ]);
    const result = await processStripeEvent(downgrade, table, store);
    expect(result).toEqual({
      handled: true,
      action: "plan_change_credits_returned",
      credits: PRO_GROWTH_MONTH / 2,
    });
    expect(store.balance("ws_9")).toBe(pro.creditsPerMonth - PRO_GROWTH_MONTH / 2);
    expect(await processStripeEvent(downgrade, table, store)).toMatchObject({ duplicate: true });
    expect(store.balance("ws_9")).toBe(pro.creditsPerMonth - PRO_GROWTH_MONTH / 2);
  });

  it("takes the whole downgrade difference even below a zero balance", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      invoiceEvent("in_down_empty", "subscription_update", [
        line({ price: "price_pro_monthly", amount: -7450, proration: true, ...HALF_MONTH }),
        line({ price: "price_growth_monthly", amount: 3950, proration: true, ...HALF_MONTH }),
      ]),
      table,
      store,
    );
    expect(result).toMatchObject({ action: "plan_change_credits_returned", credits: PRO_GROWTH_MONTH / 2 });
    expect(store.balance("ws_9")).toBe(-PRO_GROWTH_MONTH / 2);
    expect(store.spend("ws_9", 0.5)).toBe(false);
  });

  it("switching monthly to annual grants the year minus the unused half month", () => {
    const plan = planOf(
      invoiceEvent("in_interval", "subscription_update", [
        line({ price: "price_growth_monthly", amount: -3950, proration: true, ...HALF_MONTH }),
        line({ price: "price_growth_annual", amount: 79200, end: T0 + 365 * DAY }),
      ]),
    );
    expect(plan.credits).toBe(growth.creditsPerMonth * 12 - growth.creditsPerMonth / 2);
  });

  it("prorates an annual upgrade by the share of the year left", () => {
    const left = { start: T0, end: T0 + 182 * DAY };
    const plan = planOf(
      invoiceEvent("in_annual_up", "subscription_update", [
        line({ price: "price_growth_annual", amount: -39490, proration: true, ...left }),
        line({ price: "price_pro_annual", amount: 74196, proration: true, ...left }),
      ]),
    );
    const exact = (pro.creditsPerMonth - growth.creditsPerMonth) * 12 * (182 / 365);
    expect(plan.credits).toBeLessThanOrEqual(exact);
    expect(plan.credits).toBeGreaterThan(exact - 0.1);
  });

  it("takes back the unused annual credits when a year plan moves to a month plan at once", () => {
    const left = { start: T0, end: T0 + 182 * DAY };
    const plan = planOf(
      invoiceEvent("in_annual_down", "subscription_update", [
        line({ price: "price_growth_annual", amount: -39490, proration: true, ...left }),
        line({ price: "price_growth_monthly", amount: 7900, start: T0, end: T0 + 30 * DAY }),
      ]),
    );
    const exact = growth.creditsPerMonth * 12 * (182 / 365) - growth.creditsPerMonth;
    expect(plan.credits).toBe(0);
    expect(plan.debit).toBeGreaterThanOrEqual(exact);
    expect(plan.debit).toBeLessThan(exact + 0.1);
  });

  it("ignores manual invoices and unknown prices", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_manual", "manual", [line({ price: "price_growth_monthly", amount: 7900 })]),
      table,
      store,
    );
    await processStripeEvent(
      invoiceEvent("in_unknown", "subscription_cycle", [line({ price: "price_other", amount: 7900 })]),
      table,
      store,
    );
    expect(store.grants).toHaveLength(0);
  });

  it("throws a retryable error for a grant no workspace can receive", async () => {
    const store = new InMemoryBillingStore({ requireRouting: true });
    const event = invoiceEvent("in_orphan", "subscription_cycle", [line({ price: "price_growth_monthly", amount: 7900 })], null, "cus_unknown");
    await expect(processStripeEvent(event, table, store)).rejects.toBeInstanceOf(UnroutableBillingEventError);
    expect(store.grants).toHaveLength(0);

    await store.linkCustomer("ws_linked", "cus_unknown");
    await processStripeEvent(event, table, store);
    expect(store.grants).toHaveLength(1);
  });

  it("notes failed payments and 3D Secure requests", async () => {
    const store = new InMemoryBillingStore();
    const failed = verify({
      id: "evt_fail",
      type: "invoice.payment_failed",
      data: { object: { id: "in_f", object: "invoice", customer: "cus_1", attempt_count: 2, metadata: { workspaceId: "ws_9" } } },
    });
    expect(await processStripeEvent(failed, table, store)).toEqual({ handled: true, action: "payment_failure_noted" });
    const action = verify({
      id: "evt_action",
      type: "invoice.payment_action_required",
      data: { object: { id: "in_a", object: "invoice", customer: "cus_1" } },
    });
    expect(await processStripeEvent(action, table, store)).toEqual({ handled: true, action: "payment_action_noted" });
    expect(store.notes.map((n) => n.note.kind)).toEqual(["payment_failed", "payment_action_required"]);
    expect(store.notes[0].note.props).toMatchObject({ invoiceId: "in_f", attemptCount: 2 });
  });
});

describe("plan changes never create credits (money-plan-change exploit loop)", () => {
  /** Upgrade Growth to Pro and back with `leftAtUp` and `leftAtDown` days
   * of the 30 day period remaining, spending everything in between. */
  function changeLines(id: string, from: string, to: string, fromAmount: number, toAmount: number, daysLeft: number) {
    const period = { start: HALF_MONTH.end - daysLeft * DAY, end: HALF_MONTH.end };
    return invoiceEvent(id, "subscription_update", [
      line({ price: from, amount: -fromAmount, proration: true, ...period }),
      line({ price: to, amount: toAmount, proration: true, ...period }),
    ]);
  }

  it("upgrade, spend, downgrade, repeat leaves only what the Growth invoice paid for", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_growth", "subscription_cycle", [line({ price: "price_growth_monthly", amount: 7900 })]),
      table,
      store,
    );
    let spent = 0;
    for (let round = 0; round < 5; round += 1) {
      await processStripeEvent(
        changeLines(`in_up_${round}`, "price_growth_monthly", "price_pro_monthly", 3950, 7450, 15),
        table,
        store,
      );
      const available = store.balance("ws_9");
      if (available > 0 && store.spend("ws_9", available)) {
        spent += available;
      }
      await processStripeEvent(
        changeLines(`in_down_${round}`, "price_pro_monthly", "price_growth_monthly", 7450, 3950, 15),
        table,
        store,
      );
    }
    // Every upgrade credit came back on the matching downgrade, so the
    // credits used plus the (negative) balance equal the one Growth month.
    expect(roundCredits(spent + store.balance("ws_9"))).toBe(growth.creditsPerMonth);
    expect(store.balance("ws_9")).toBe(-PRO_GROWTH_MONTH / 2);
    expect(store.spend("ws_9", 0.5)).toBe(false);
  });

  it("keeps only the credits for the days actually paid for on the bigger plan", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(changeLines("in_up_t", "price_growth_monthly", "price_pro_monthly", 3950, 7450, 15), table, store);
    // Stripe returns ten of thirty days of the Pro price and charges ten of Growth.
    await processStripeEvent(changeLines("in_down_t", "price_pro_monthly", "price_growth_monthly", 4967, 2633, 10), table, store);
    // Five of thirty days on Pro were paid for, so at most five days of the
    // Pro minus Growth allowance may remain.
    const paidFor = PRO_GROWTH_MONTH * (5 / 30);
    expect(store.balance("ws_9")).toBeLessThanOrEqual(paidFor);
    expect(store.balance("ws_9")).toBeGreaterThan(paidFor - 0.2);
  });

  it("a year plan moved to a month plan and back cannot mint credits either", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_year", "subscription_create", [
        line({ price: "price_growth_annual", amount: 79200, start: T0, end: T0 + 365 * DAY }),
      ]),
      table,
      store,
    );
    expect(store.spend("ws_9", growth.creditsPerMonth * 12)).toBe(true);
    // Immediately to monthly: Stripe credits almost the whole year back.
    await processStripeEvent(
      invoiceEvent("in_to_month", "subscription_update", [
        line({ price: "price_growth_annual", amount: -79000, proration: true, start: T0 + DAY, end: T0 + 365 * DAY }),
        line({ price: "price_growth_monthly", amount: 7900, start: T0 + DAY, end: T0 + 31 * DAY }),
      ]),
      table,
      store,
    );
    const owed = growth.creditsPerMonth * 12 * (364 / 365) - growth.creditsPerMonth;
    expect(store.balance("ws_9")).toBeLessThanOrEqual(-owed + 0.1);
    expect(store.spend("ws_9", 0.5)).toBe(false);
  });

  // Stripe prorates a discounted subscription from its discounted price, so
  // with 70 percent off every proration amount is 30 percent of the list
  // price share. Renewals still grant a full allowance.
  const discounted = (cents: number) => Math.round(cents * 0.3);

  it("a paid upgrade with a large discount still adds credits", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      changeLines("in_up_coupon", "price_growth_monthly", "price_pro_monthly", discounted(3950), discounted(7450), 15),
      table,
      store,
    );
    expect(store.balance("ws_9")).toBe(PRO_GROWTH_MONTH / 2);
  });

  it("a discounted customer who downgrades right after a renewal keeps only the day paid for", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_pro_coupon", "subscription_cycle", [line({ price: "price_pro_monthly", amount: discounted(14900) })]),
      table,
      store,
    );
    expect(store.balance("ws_9")).toBe(pro.creditsPerMonth);
    await processStripeEvent(
      changeLines(
        "in_down_coupon",
        "price_pro_monthly",
        "price_growth_monthly",
        discounted(Math.round((14900 * 29) / 30)),
        discounted(Math.round((7900 * 29) / 30)),
        29,
      ),
      table,
      store,
    );
    // One of thirty days on Pro was paid for, so at most that day's share of
    // the Pro minus Growth allowance may stay above the Growth allowance.
    expect(store.balance("ws_9")).toBeLessThanOrEqual(growth.creditsPerMonth + PRO_GROWTH_MONTH / 30 + 0.1);
  });

  it("a discounted upgrade followed by a downgrade adds nothing", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_growth_coupon", "subscription_cycle", [line({ price: "price_growth_monthly", amount: discounted(7900) })]),
      table,
      store,
    );
    await processStripeEvent(
      changeLines("in_up_rt", "price_growth_monthly", "price_pro_monthly", discounted(3950), discounted(7450), 15),
      table,
      store,
    );
    await processStripeEvent(
      changeLines("in_down_rt", "price_pro_monthly", "price_growth_monthly", discounted(7450), discounted(3950), 15),
      table,
      store,
    );
    expect(store.balance("ws_9")).toBeLessThanOrEqual(growth.creditsPerMonth);
  });
});

describe("plan changes on short and clamped periods follow Stripe's proration", () => {
  /** A Pro to Growth (or Growth to Pro) change at `changeAt`, with the
   * amounts Stripe computes over the real period. */
  function changeInvoice(id: string, period: { start: number; end: number }, changeAt: number, direction: "down" | "up") {
    const [from, fromCents, to, toCents] =
      direction === "down"
        ? (["price_pro_monthly", PRO_CENTS, "price_growth_monthly", GROWTH_CENTS] as const)
        : (["price_growth_monthly", GROWTH_CENTS, "price_pro_monthly", PRO_CENTS] as const);
    const returned = stripeProration(fromCents, period, changeAt);
    const charged = stripeProration(toCents, period, changeAt);
    return {
      event: invoiceEvent(id, "subscription_update", [
        line({ price: from, amount: -returned, proration: true, start: changeAt, end: period.end }),
        line({ price: to, amount: charged, proration: true, start: changeAt, end: period.end }),
      ]),
      returned,
      charged,
    };
  }

  const periods = [
    { name: "2027-01-31 to 2027-02-28", period: JAN31_FEB28 },
    { name: "2027-03-31 to 2027-04-30", period: MAR31_APR30 },
  ];
  const moments = [
    // One minute after a full price renewal Stripe returns the whole price.
    { name: "right after the full price renewal", at: (p: { start: number }) => p.start + 60, share: 1 },
    { name: "halfway through", at: (p: { start: number; end: number }) => (p.start + p.end) / 2, share: 0.5 },
  ];

  for (const { name, period } of periods) {
    for (const moment of moments) {
      it(`a downgrade ${moment.name} of ${name} takes back the full difference times Stripe's share`, async () => {
        const store = new InMemoryBillingStore();
        const tag = `${period.start}_${moment.share}`;
        await processStripeEvent(
          invoiceEvent(`in_renew_${tag}`, "subscription_cycle", [
            line({ price: "price_pro_monthly", amount: PRO_CENTS, start: period.start, end: period.end }),
          ]),
          table,
          store,
        );
        const spent = store.balance("ws_9");
        expect(store.spend("ws_9", spent)).toBe(true);

        const changeAt = moment.at(period);
        const { event, returned, charged } = changeInvoice(`in_down_${tag}`, period, changeAt, "down");
        expect(returned / PRO_CENTS).toBe(moment.share);
        const result = await processStripeEvent(event, table, store);
        expect(result).toEqual({
          handled: true,
          action: "plan_change_credits_returned",
          credits: PRO_GROWTH_MONTH * moment.share,
        });
        // The calendar month is longer than this period, so measuring
        // against it would have taken back less than Stripe returned.
        const calendar = timeShareBounds({ periodStart: changeAt, periodEnd: period.end }, "monthly").floor;
        expect(PRO_GROWTH_MONTH * calendar).toBeLessThan(PRO_GROWTH_MONTH * moment.share);

        // What was paid, in credits at the seed rate: the Pro month, less
        // the Pro time Stripe returned, plus the Growth time it charged.
        const paid =
          pro.creditsPerMonth -
          (pro.creditsPerMonth * returned) / PRO_CENTS +
          (growth.creditsPerMonth * charged) / GROWTH_CENTS;
        expect(roundCredits(spent + store.balance("ws_9"))).toBe(roundCredits(paid));
        expect(store.spend("ws_9", 0.5)).toBe(false);
      });
    }

    it(`an upgrade halfway through ${name} grants the full difference for half the period`, () => {
      const changeAt = (period.start + period.end) / 2;
      const plan = planOf(changeInvoice(`in_up_${period.start}`, period, changeAt, "up").event);
      expect(plan.credits).toBe(PRO_GROWTH_MONTH / 2);
    });

    it(`upgrade, spend, downgrade on ${name} leaves only what was paid for`, async () => {
      const store = new InMemoryBillingStore();
      await processStripeEvent(
        invoiceEvent(`in_growth_${period.start}`, "subscription_cycle", [
          line({ price: "price_growth_monthly", amount: GROWTH_CENTS, start: period.start, end: period.end }),
        ]),
        table,
        store,
      );
      let spent = 0;
      const upAt = period.start + 3 * DAY;
      const downAt = period.start + 9 * DAY;
      const up = changeInvoice(`in_up_loop_${period.start}`, period, upAt, "up");
      await processStripeEvent(up.event, table, store);
      spent += store.balance("ws_9");
      expect(store.spend("ws_9", store.balance("ws_9"))).toBe(true);
      const down = changeInvoice(`in_down_loop_${period.start}`, period, downAt, "down");
      await processStripeEvent(down.event, table, store);

      const paid =
        growth.creditsPerMonth +
        (pro.creditsPerMonth * up.charged) / PRO_CENTS -
        (growth.creditsPerMonth * up.returned) / GROWTH_CENTS -
        (pro.creditsPerMonth * down.returned) / PRO_CENTS +
        (growth.creditsPerMonth * down.charged) / GROWTH_CENTS;
      // Grants round down and debits round up, so what is left never beats
      // what was paid, and misses it by less than the rounding.
      const kept = spent + store.balance("ws_9");
      expect(kept).toBeLessThanOrEqual(paid + 1e-9);
      expect(kept).toBeGreaterThan(paid - 0.2);
    });
  }

  it("a bill in another currency still never grants more than the time allows", () => {
    const changeAt = utc("2027-02-14T00:00:00Z");
    const eur = (event: Stripe.Event) => {
      (event.data.object as { currency?: string }).currency = "eur";
      return event;
    };
    const up = planOf(eur(changeInvoice("in_up_eur", JAN31_FEB28, changeAt, "up").event));
    // Growth to Pro still grants, at most the difference for the time left.
    expect(up.credits).toBeGreaterThan(0);
    expect(up.credits).toBeLessThanOrEqual(PRO_GROWTH_MONTH / 2);
    const down = planOf(eur(changeInvoice("in_down_eur", JAN31_FEB28, changeAt, "down").event));
    // Pro to Growth takes back at least the difference for the time left.
    expect(down.debit).toBeGreaterThanOrEqual(PRO_GROWTH_MONTH / 2);
  });
});

describe("subscription sync (Update.md 1.1)", () => {
  const base = {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    metadata: { workspaceId: "ws_2" },
    items: {
      data: [
        {
          id: "si_1",
          current_period_end: 1_790_000_000,
          price: { id: "price_starter_monthly" },
        },
      ],
    },
  };

  function subEvent(id: string, type: string, overrides: Record<string, unknown> = {}): Stripe.Event {
    return verify({ id, type, data: { object: { ...base, ...overrides } } });
  }

  function withPrice(price: string) {
    return { items: { data: [{ id: "si_1", current_period_end: 1_790_000_000, price: { id: price } }] } };
  }

  /** A Stripe lookup whose subscription reads return `current`. */
  function lookupReturning(current: () => Record<string, unknown> | null) {
    return {
      invoiceIdForPaymentIntent: async () => null,
      retrieveSubscription: async () => current() as unknown as Stripe.Subscription | null,
    };
  }

  it("syncs created and updated subscriptions and marks deletions canceled", async () => {
    const store = new InMemoryBillingStore();
    const created = await processStripeEvent(subEvent("evt_sub_0", "customer.subscription.created"), table, store);
    expect(created).toEqual({ handled: true, action: "subscription_synced" });
    expect(store.subscriptions.get("sub_1")).toMatchObject({ workspaceId: "ws_2", tier: "starter", status: "active" });
    expect(store.subscriptions.get("sub_1")?.periodEnd).toBe(new Date(1_790_000_000 * 1000).toISOString());

    await processStripeEvent(subEvent("evt_sub_2", "customer.subscription.deleted"), table, store);
    expect(store.subscriptions.get("sub_1")?.status).toBe("canceled");
  });

  it("carries whether Stripe will end the subscription on its own", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(subEvent("evt_end_0", "customer.subscription.created"), table, store);
    expect(store.subscriptions.get("sub_1")?.cancelAtPeriodEnd).toBe(false);
    await processStripeEvent(
      subEvent("evt_end_1", "customer.subscription.updated", { cancel_at_period_end: true }),
      table,
      store,
    );
    expect(store.subscriptions.get("sub_1")).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    // The portal can schedule the end with cancel_at instead.
    await processStripeEvent(
      subEvent("evt_end_2", "customer.subscription.updated", { cancel_at_period_end: false, cancel_at: 1_790_000_000 }),
      table,
      store,
    );
    expect(store.subscriptions.get("sub_1")?.cancelAtPeriodEnd).toBe(true);
    // Renewed in the portal.
    await processStripeEvent(
      subEvent("evt_end_3", "customer.subscription.updated", { cancel_at_period_end: false, cancel_at: null }),
      table,
      store,
    );
    expect(store.subscriptions.get("sub_1")?.cancelAtPeriodEnd).toBe(false);
  });

  describe("events out of order, without a Stripe lookup", () => {
    it("created (incomplete) arriving after updated (active) keeps active", async () => {
      const store = new InMemoryBillingStore();
      await processStripeEvent(subEvent("evt_upd", "customer.subscription.updated", { status: "active" }), table, store);
      const late = await processStripeEvent(
        subEvent("evt_created", "customer.subscription.created", { status: "incomplete" }),
        table,
        store,
      );
      expect(late).toEqual({ handled: true, action: "subscription_stale_ignored" });
      expect(store.subscriptions.get("sub_1")?.status).toBe("active");
    });

    it("created (incomplete) then updated (active) in order ends active", async () => {
      const store = new InMemoryBillingStore();
      await processStripeEvent(subEvent("evt_created", "customer.subscription.created", { status: "incomplete" }), table, store);
      await processStripeEvent(subEvent("evt_upd", "customer.subscription.updated", { status: "active" }), table, store);
      expect(store.subscriptions.get("sub_1")?.status).toBe("active");
    });

    it("never moves a canceled or expired subscription to another status", async () => {
      const store = new InMemoryBillingStore();
      await processStripeEvent(subEvent("evt_del", "customer.subscription.deleted"), table, store);
      await processStripeEvent(
        subEvent("evt_old", "customer.subscription.updated", { status: "active", ...withPrice("price_pro_monthly") }),
        table,
        store,
      );
      expect(store.subscriptions.get("sub_1")).toMatchObject({ status: "canceled", tier: "starter" });

      await processStripeEvent(
        subEvent("evt_exp", "customer.subscription.updated", { id: "sub_exp", status: "incomplete_expired" }),
        table,
        store,
      );
      await processStripeEvent(
        subEvent("evt_exp_old", "customer.subscription.created", { id: "sub_exp", status: "incomplete" }),
        table,
        store,
      );
      expect(store.subscriptions.get("sub_exp")?.status).toBe("incomplete_expired");
    });
  });

  describe("events out of order, with the Stripe lookup", () => {
    it("uses Stripe's current status and price whatever the payload says", async () => {
      const store = new InMemoryBillingStore();
      const now = { ...base, status: "active", ...withPrice("price_pro_monthly") };
      const lookup = lookupReturning(() => now);
      // The payload is the older created event: incomplete, on Starter.
      await processStripeEvent(
        subEvent("evt_created", "customer.subscription.created", { status: "incomplete" }),
        table,
        store,
        { lookup },
      );
      expect(store.subscriptions.get("sub_1")).toMatchObject({ status: "active", tier: "pro" });
    });

    it("lands on the same state in either order", async () => {
      for (const order of [
        ["created", "updated"],
        ["updated", "created"],
      ]) {
        const store = new InMemoryBillingStore();
        let stripeNow: Record<string, unknown> = { ...base, status: "incomplete" };
        const lookup = lookupReturning(() => stripeNow);
        stripeNow = { ...base, status: "active", ...withPrice("price_growth_monthly") };
        for (const kind of order) {
          await processStripeEvent(
            subEvent(`evt_${kind}`, `customer.subscription.${kind}`, {
              status: kind === "created" ? "incomplete" : "active",
            }),
            table,
            store,
            { lookup },
          );
        }
        expect(store.subscriptions.get("sub_1"), order.join(" then ")).toMatchObject({
          status: "active",
          tier: "growth",
        });
      }
    });

    it("falls back to the payload when Stripe no longer knows the subscription", async () => {
      const store = new InMemoryBillingStore();
      await processStripeEvent(subEvent("evt_gone", "customer.subscription.updated"), table, store, {
        lookup: lookupReturning(() => null),
      });
      expect(store.subscriptions.get("sub_1")).toMatchObject({ status: "active", tier: "starter" });
    });

    it("fails the delivery when Stripe cannot be read, so Stripe retries", async () => {
      const store = new InMemoryBillingStore();
      const lookup = {
        invoiceIdForPaymentIntent: async () => null,
        retrieveSubscription: async (): Promise<Stripe.Subscription | null> => {
          throw new Error("stripe timeout");
        },
      };
      await expect(
        processStripeEvent(subEvent("evt_down", "customer.subscription.updated"), table, store, { lookup }),
      ).rejects.toThrow("stripe timeout");
      expect(store.subscriptions.size).toBe(0);
    });
  });
});

describe("refunds and disputes (Phase 10 decision 3)", () => {
  async function storeWithTopUp(): Promise<InMemoryBillingStore> {
    const store = new InMemoryBillingStore();
    await processStripeEvent(checkoutEvent("evt_checkout_1", "checkout.session.completed"), table, store);
    return store;
  }

  function refundEvent(id: string, amountRefunded: number, paymentIntent = "pi_topup_1"): Stripe.Event {
    return verify({
      id,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          object: "charge",
          amount: 1500,
          amount_refunded: amountRefunded,
          payment_intent: paymentIntent,
        },
      },
    });
  }

  function disputeEvent(
    eventId: string,
    type: string,
    status: string,
    disputeId = "dp_1",
    paymentIntent = "pi_topup_1",
  ): Stripe.Event {
    return verify({
      id: eventId,
      type,
      data: {
        object: { id: disputeId, object: "dispute", charge: "ch_1", payment_intent: paymentIntent, amount: 1500, status },
      },
    });
  }

  it("claws back a refunded top up in proportion and only once per event", async () => {
    const store = await storeWithTopUp();
    const half = refundEvent("evt_refund_half", 750);
    expect(await processStripeEvent(half, table, store)).toMatchObject({ action: "refund_clawed_back", credits: 50 });
    expect(await processStripeEvent(half, table, store)).toMatchObject({ duplicate: true });
    expect(store.balance("ws_1")).toBe(50);

    const full = refundEvent("evt_refund_full", 1500);
    expect(await processStripeEvent(full, table, store)).toMatchObject({ credits: 50 });
    expect(store.balance("ws_1")).toBe(0);
  });

  it("takes nothing for an inquiry", async () => {
    const store = await storeWithTopUp();
    const inquiry = await processStripeEvent(
      disputeEvent("evt_inq", "charge.dispute.funds_withdrawn", "warning_needs_response"),
      table,
      store,
    );
    expect(inquiry).toEqual({ handled: true, action: "dispute_inquiry_ignored" });
    expect(store.balance("ws_1")).toBe(100);
    // charge.dispute.created no longer moves credits at all.
    const created = await processStripeEvent(
      disputeEvent("evt_created", "charge.dispute.created", "needs_response"),
      table,
      store,
    );
    expect(created).toEqual({ handled: false, action: "ignored" });
    expect(store.balance("ws_1")).toBe(100);
  });

  it("claws back once when funds are withdrawn, keyed on the dispute", async () => {
    const store = await storeWithTopUp();
    const withdrawn = await processStripeEvent(
      disputeEvent("evt_w1", "charge.dispute.funds_withdrawn", "needs_response"),
      table,
      store,
    );
    expect(withdrawn).toMatchObject({ action: "dispute_clawed_back", credits: 100 });
    // A second withdrawal event for the same dispute takes nothing more.
    const again = await processStripeEvent(
      disputeEvent("evt_w2", "charge.dispute.funds_withdrawn", "needs_response"),
      table,
      store,
    );
    expect(again).toMatchObject({ duplicate: true });
    expect(store.balance("ws_1")).toBe(0);
  });

  it("gives the credits back once when the dispute is won", async () => {
    const store = await storeWithTopUp();
    await processStripeEvent(disputeEvent("evt_w", "charge.dispute.funds_withdrawn", "needs_response"), table, store);
    expect(store.balance("ws_1")).toBe(0);

    const closed = await processStripeEvent(disputeEvent("evt_c", "charge.dispute.closed", "won"), table, store);
    expect(closed).toMatchObject({ action: "dispute_won_credits_restored", credits: 100 });
    const reinstated = await processStripeEvent(
      disputeEvent("evt_r", "charge.dispute.funds_reinstated", "won"),
      table,
      store,
    );
    expect(reinstated).toMatchObject({ duplicate: true });
    expect(store.balance("ws_1")).toBe(100);
  });

  it("gives back only what the clawback took when the balance was short", async () => {
    const store = await storeWithTopUp();
    expect(store.spend("ws_1", 70)).toBe(true);
    await processStripeEvent(disputeEvent("evt_w", "charge.dispute.funds_withdrawn", "under_review"), table, store);
    expect(store.balance("ws_1")).toBe(0);
    await processStripeEvent(disputeEvent("evt_r", "charge.dispute.funds_reinstated", "won"), table, store);
    expect(store.balance("ws_1")).toBe(30);
  });

  it("keeps the clawback when the dispute is lost, even when funds are reinstated", async () => {
    const store = await storeWithTopUp();
    await processStripeEvent(refundEvent("evt_refund_part", 300), table, store);
    await processStripeEvent(disputeEvent("evt_w", "charge.dispute.funds_withdrawn", "needs_response"), table, store);
    expect(store.balance("ws_1")).toBe(0);
    // Stripe reinstates the refunded part of a partly refunded payment on a
    // lost dispute; those credits were already taken back by the refund.
    const reinstated = await processStripeEvent(
      disputeEvent("evt_r", "charge.dispute.funds_reinstated", "lost"),
      table,
      store,
    );
    expect(reinstated).toEqual({ handled: true, action: "dispute_closed_noted" });
    await processStripeEvent(disputeEvent("evt_c", "charge.dispute.closed", "lost"), table, store);
    expect(store.balance("ws_1")).toBe(0);
  });

  it("skips a withdrawal processed after the dispute was already won", async () => {
    const store = await storeWithTopUp();
    const won = await processStripeEvent(disputeEvent("evt_c", "charge.dispute.closed", "won"), table, store);
    expect(won).toEqual({ handled: true, action: "dispute_won_nothing_to_restore" });
    const late = await processStripeEvent(
      disputeEvent("evt_w", "charge.dispute.funds_withdrawn", "needs_response"),
      table,
      store,
    );
    expect(late).toEqual({ handled: true, action: "dispute_already_won" });
    expect(store.balance("ws_1")).toBe(100);
  });

  it("finds a subscription invoice through the Stripe lookup for a dispute", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_disputed", "subscription_cycle", [line({ price: "price_growth_monthly", amount: 7900 })]),
      table,
      store,
    );
    const lookup = {
      invoiceIdForPaymentIntent: async (pi: string) => (pi === "pi_invoice_9" ? "in_disputed" : null),
    };
    const result = await processStripeEvent(
      disputeEvent("evt_dispute", "charge.dispute.funds_withdrawn", "needs_response", "dp_9", "pi_invoice_9"),
      table,
      store,
      { lookup },
    );
    expect(result).toMatchObject({ action: "dispute_clawed_back", credits: growth.creditsPerMonth });
    expect(store.balance("ws_9")).toBe(0);
  });

  it("reports a refund with no matching grant", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(refundEvent("evt_refund_x", 1500, "pi_unknown"), table, store);
    expect(result).toEqual({ handled: true, action: "refund_no_grant" });
  });
});

describe("handled events", () => {
  it("acts on every event type the setup doc subscribes to", async () => {
    for (const type of HANDLED_STRIPE_EVENTS) {
      const store = new InMemoryBillingStore();
      const result = await processStripeEvent(
        verify({
          id: `evt_${type}`,
          type,
          data: { object: { id: `obj_${type}`, amount: 100, amount_refunded: 100, items: { data: [] } } },
        }),
        table,
        store,
      );
      expect(result.handled, type).toBe(true);
    }
  });
});

describe("unhandled events", () => {
  it("ignores event types it does not handle", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      verify({ id: "evt_x", type: "payment_intent.created", data: { object: {} } }),
      table,
      store,
    );
    expect(result).toEqual({ handled: false, action: "ignored" });
    expect(store.grants).toHaveLength(0);
  });
});

describe("duplicate subscription backstop", () => {
  interface FakeSub {
    id: string;
    status: string;
    created: number;
    customerId: string;
    latestInvoiceId: string | null;
  }

  function fakeActions(subs: FakeSub[]) {
    const calls: string[] = [];
    const actions: StripeBillingActions = {
      listCustomerSubscriptions: async (customerId) => {
        calls.push(`list:${customerId}`);
        return subs.filter((sub) => sub.customerId === customerId).map((sub) => ({ ...sub }));
      },
      refundInvoice: async (subscriptionId, invoiceId) => {
        calls.push(`refund:${subscriptionId}:${invoiceId}`);
        return { amount: 7900, currency: "usd", refundIds: [`re_${subscriptionId}`] };
      },
      cancelSubscription: async (subscriptionId) => {
        calls.push(`cancel:${subscriptionId}`);
        const sub = subs.find((entry) => entry.id === subscriptionId);
        if (sub) {
          sub.status = "canceled";
        }
      },
    };
    return { actions, calls };
  }

  function subscriptionEvent(
    id: string,
    sub: { id: string; customer: string; status?: string },
    type = "customer.subscription.updated",
  ): Stripe.Event {
    return {
      id,
      type,
      object: "event",
      data: {
        object: {
          id: sub.id,
          object: "subscription",
          customer: sub.customer,
          status: sub.status ?? "active",
          metadata: { workspaceId: "ws_dup" },
          items: { data: [{ id: `si_${sub.id}`, current_period_end: T0, price: { id: "price_growth_monthly" } }] },
        },
      },
    } as unknown as Stripe.Event;
  }

  it("refunds and cancels the newer subscription when it becomes active, keeping the older one", async () => {
    const store = new InMemoryBillingStore();
    await store.linkCustomer("ws_dup", "cus_a");
    const { actions, calls } = fakeActions([
      { id: "sub_old", status: "active", created: 100, customerId: "cus_a", latestInvoiceId: "in_old" },
      { id: "sub_new", status: "active", created: 200, customerId: "cus_a", latestInvoiceId: "in_new" },
    ]);
    const result = await processStripeEvent(subscriptionEvent("evt_dup_1", { id: "sub_new", customer: "cus_a" }), table, store, {
      actions,
    });
    expect(result).toEqual({ handled: true, action: "duplicate_subscription_refunded" });
    expect(calls).toEqual(["list:cus_a", "refund:sub_new:in_new", "cancel:sub_new"]);
    expect(store.duplicates).toEqual([
      {
        workspaceId: "ws_dup",
        keptSubscriptionId: "sub_old",
        duplicateSubscriptionId: "sub_new",
        stripeCustomerId: "cus_a",
        amount: 7900,
        currency: "usd",
        refundIds: ["re_sub_new"],
      },
    ]);
  });

  it("never refunds twice when the delivery is retried", async () => {
    const store = new InMemoryBillingStore();
    const subs: FakeSub[] = [
      { id: "sub_old", status: "active", created: 100, customerId: "cus_a", latestInvoiceId: "in_old" },
      { id: "sub_new", status: "active", created: 200, customerId: "cus_a", latestInvoiceId: "in_new" },
    ];
    const { actions, calls } = fakeActions(subs);
    const event = subscriptionEvent("evt_dup_retry", { id: "sub_new", customer: "cus_a" });
    await processStripeEvent(event, table, store, { actions });
    // The cancel reached Stripe, the answer did not: Stripe still shows it live.
    subs[1].status = "active";
    await processStripeEvent(event, table, store, { actions });
    await processStripeEvent(event, table, store, { actions });
    expect(calls.filter((call) => call.startsWith("refund:"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("cancel:"))).toEqual(["cancel:sub_new", "cancel:sub_new"]);
    expect(store.duplicates).toHaveLength(1);
  });

  it("an event for the older subscription retires a newer duplicate too", async () => {
    const store = new InMemoryBillingStore();
    const { actions, calls } = fakeActions([
      { id: "sub_old", status: "active", created: 100, customerId: "cus_a", latestInvoiceId: "in_old" },
      { id: "sub_new", status: "active", created: 200, customerId: "cus_a", latestInvoiceId: "in_new" },
    ]);
    const result = await processStripeEvent(subscriptionEvent("evt_dup_old", { id: "sub_old", customer: "cus_a" }), table, store, {
      actions,
    });
    expect(result.action).toBe("subscription_synced");
    expect(calls).toEqual(["list:cus_a", "refund:sub_new:in_new", "cancel:sub_new"]);
    expect(store.subscriptions.get("sub_old")?.status).toBe("active");
  });

  it("checks the customer stored on the workspace as well as the event's, so a second customer is caught", async () => {
    const store = new InMemoryBillingStore();
    await store.linkCustomer("ws_dup", "cus_first");
    const { actions, calls } = fakeActions([
      { id: "sub_first", status: "active", created: 100, customerId: "cus_first", latestInvoiceId: "in_first" },
      { id: "sub_second", status: "active", created: 200, customerId: "cus_second", latestInvoiceId: "in_second" },
    ]);
    await processStripeEvent(subscriptionEvent("evt_two_customers", { id: "sub_second", customer: "cus_second" }), table, store, {
      actions,
    });
    expect(calls).toEqual(["list:cus_second", "list:cus_first", "refund:sub_second:in_second", "cancel:sub_second"]);
    expect(store.duplicates[0]).toMatchObject({ keptSubscriptionId: "sub_first", duplicateSubscriptionId: "sub_second" });
  });

  it("leaves a single subscription, canceled ones and deletions alone", async () => {
    const store = new InMemoryBillingStore();
    const { actions, calls } = fakeActions([
      { id: "sub_gone", status: "canceled", created: 100, customerId: "cus_a", latestInvoiceId: "in_gone" },
      { id: "sub_only", status: "active", created: 200, customerId: "cus_a", latestInvoiceId: "in_only" },
    ]);
    await processStripeEvent(subscriptionEvent("evt_single", { id: "sub_only", customer: "cus_a" }), table, store, { actions });
    await processStripeEvent(
      subscriptionEvent("evt_deleted", { id: "sub_gone", customer: "cus_a", status: "canceled" }, "customer.subscription.deleted"),
      table,
      store,
      { actions },
    );
    expect(calls).toEqual(["list:cus_a"]);
    expect(store.duplicates).toHaveLength(0);
  });

  it("does nothing extra in payload only mode (no Stripe key)", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(subscriptionEvent("evt_payload", { id: "sub_payload", customer: "cus_a" }), table, store);
    expect(result.action).toBe("subscription_synced");
    expect(store.duplicates).toHaveLength(0);
  });
});

describe("linkCustomer keeps the first customer", () => {
  it("does not overwrite a different stored customer", async () => {
    const store = new InMemoryBillingStore();
    await store.linkCustomer("ws_keep", "cus_first");
    await store.linkCustomer("ws_keep", "cus_second");
    expect(store.customerLinks.get("ws_keep")).toBe("cus_first");
  });
});

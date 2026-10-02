import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tierByKey, topUps } from "@curvi/pipeline/seed";
import { billingConsents, creditLedger, events, platformSettings, subscriptions, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq } from "@curvi/db";
import { FIXTURE_NAMES, fixturePlaceholders, loadFixture } from "./fixtures";
import { openCheckoutEnv, stubOpenCheckout } from "./test-env";
import { readBillingSignals } from "./signals";

// docs/phases/PHASE_20.md P20-03: the billing flow suite. Stripe event
// fixtures (lib/billing/fixtures) are signed with
// stripe.webhooks.generateTestHeaderString and posted to POST
// /api/webhooks/stripe, which runs DbBillingStore on a real Postgres
// (PGlite, every migration applied). Each case checks the ledger,
// workspaces.plan and the subscriptions row.

const stripeState = vi.hoisted(() => ({
  db: null as unknown,
  /** What Stripe holds now, as the lookups read it. */
  subscriptions: new Map<string, Record<string, unknown>>(),
  invoiceForPaymentIntent: new Map<string, string>(),
  moneyWrites: [] as string[],
}));

vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => stripeState.db }));
vi.mock("@/lib/billing/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripe")>()),
  getStripe: () => ({}),
  createStripeLookup: () => ({
    invoiceIdForPaymentIntent: async (paymentIntentId: string) =>
      stripeState.invoiceForPaymentIntent.get(paymentIntentId) ?? null,
    retrieveSubscription: async (id: string) => stripeState.subscriptions.get(id) ?? null,
  }),
  createStripeBillingActions: () => ({
    listCustomerSubscriptions: async (customerId: string) =>
      [...stripeState.subscriptions.values()]
        .filter((sub) => sub.customer === customerId)
        .map((sub) => ({
          id: sub.id as string,
          status: sub.status as string,
          created: sub.created as number,
          customerId,
          latestInvoiceId: (sub.latest_invoice as string) ?? null,
        })),
    refundInvoice: async (subscriptionId: string) => {
      stripeState.moneyWrites.push(`refund:${subscriptionId}`);
      return { amount: 0, currency: "usd", refundIds: [] };
    },
    cancelSubscription: async (subscriptionId: string) => {
      stripeState.moneyWrites.push(`cancel:${subscriptionId}`);
    },
  }),
}));

const { POST } = await import("@/app/api/webhooks/stripe/route");

const ENV = openCheckoutEnv();
const SECRET = ENV.STRIPE_WEBHOOK_SECRET;
const PRICE = {
  growthMonthly: ENV.STRIPE_PRICE_GROWTH_MONTHLY,
  growthAnnual: ENV.STRIPE_PRICE_GROWTH_ANNUAL,
  proMonthly: ENV.STRIPE_PRICE_PRO_MONTHLY,
  topUp100: ENV.STRIPE_PRICE_TOPUP_100,
};
const growth = tierByKey("growth");
const pro = tierByKey("pro");
const topUp = topUps.find((entry) => entry.credits === 100)!;
const CENTS = { growth: growth.monthlyUsd * 100, growthYear: growth.annualUsdPerMonth * 12 * 100, pro: pro.monthlyUsd * 100, topUp: topUp.usd * 100 };

// A 30 day November, so half the period is exactly half the price.
const PERIOD_START = Date.UTC(2026, 10, 1) / 1000;
const PERIOD_END = Date.UTC(2026, 11, 1) / 1000;
const MID = Date.UTC(2026, 10, 16) / 1000;
const NEXT_END = Date.UTC(2027, 0, 1) / 1000;
const YEAR_END = Date.UTC(2027, 10, 1) / 1000;

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let seq = 0;
const signer = new Stripe("sk_test_signing_only");

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  stripeState.db = db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  stubOpenCheckout(vi.stubEnv);
  stripeState.subscriptions.clear();
  stripeState.invoiceForPaymentIntent.clear();
  stripeState.moneyWrites = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function id(prefix: string): string {
  seq += 1;
  return `${prefix}_Fixture${seq}`;
}

async function newWorkspace(): Promise<string> {
  const [row] = await db.insert(workspaces).values({ name: id("Flow") }).returning();
  return row.id;
}

interface Snapshot {
  balance: number;
  plan: string;
  stripeCustomerId: string | null;
  subscriptions: Array<{ externalId: string | null; tier: string | null; status: string | null }>;
  ledger: Array<{ reason: string; delta: number }>;
}

async function snapshot(workspaceId: string): Promise<Snapshot> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  return {
    balance: Math.round(ledger.reduce((sum, row) => sum + Number(row.delta), 0) * 10) / 10,
    plan: workspace.plan,
    stripeCustomerId: workspace.stripeCustomerId ?? null,
    subscriptions: subs.map((row) => ({ externalId: row.externalId, tier: row.tier, status: row.status })),
    ledger: ledger.map((row) => ({ reason: row.reason, delta: Number(row.delta) })),
  };
}

async function post(event: unknown, options: { timestamp?: number } = {}) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: options.timestamp });
  const response = await POST(
    new Request("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": header },
      body: payload,
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// --- Fixture builders -------------------------------------------------------

interface Sub {
  workspaceId: string;
  customer: string;
  subscription: string;
  invoice: string;
  plan: "growth" | "pro";
  cadence: "monthly" | "annual";
  price: string;
  amount: number;
}

function newSub(workspaceId: string, plan: Sub["plan"], cadence: Sub["cadence"] = "monthly"): Sub {
  const price = plan === "pro" ? PRICE.proMonthly : cadence === "annual" ? PRICE.growthAnnual : PRICE.growthMonthly;
  const amount = plan === "pro" ? CENTS.pro : cadence === "annual" ? CENTS.growthYear : CENTS.growth;
  return { workspaceId, customer: id("cus"), subscription: id("sub"), invoice: id("in"), plan, cadence, price, amount };
}

const BUYER = "00000000-0000-4000-8000-00000000b0b0";

function checkoutCompleted(sub: Sub, disclosure: { version?: string; sha256?: string; session?: string } = {}) {
  return loadFixture("checkout.session.completed.subscription", {
    EVENT_ID: id("evt"),
    CREATED: PERIOD_START,
    SESSION_ID: disclosure.session ?? `cs_${sub.subscription}`,
    USER_ID: BUYER,
    DISCLOSURE_VERSION: disclosure.version ?? "2026-10-02",
    DISCLOSURE_SHA256: disclosure.sha256 ?? `sha_${sub.subscription}`,
    AMOUNT: sub.amount,
    WORKSPACE_ID: sub.workspaceId,
    CUSTOMER_ID: sub.customer,
    INVOICE_ID: sub.invoice,
    SUBSCRIPTION_ID: sub.subscription,
    PRICE_ID: sub.price,
    PLAN: sub.plan,
    CADENCE: sub.cadence,
  });
}

function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted",
  sub: Sub,
  status: string,
  periodEnd = sub.cadence === "annual" ? YEAR_END : PERIOD_END,
) {
  const event = loadFixture<{ data: { object: Record<string, unknown> } }>("customer.subscription", {
    EVENT_ID: id("evt"),
    TYPE: type,
    CREATED: PERIOD_START,
    SUBSCRIPTION_ID: sub.subscription,
    CUSTOMER_ID: sub.customer,
    WORKSPACE_ID: sub.workspaceId,
    INVOICE_ID: sub.invoice,
    PRICE_ID: sub.price,
    AMOUNT: sub.amount,
    INTERVAL: sub.cadence === "annual" ? "year" : "month",
    PLAN: sub.plan,
    CADENCE: sub.cadence,
    STATUS: status,
    PERIOD_START,
    PERIOD_END: periodEnd,
  });
  return event;
}

/** Makes Stripe hold this state, so the webhook's subscription read sees it. */
function stripeHolds(event: { data: { object: Record<string, unknown> } }): void {
  const object = event.data.object;
  stripeState.subscriptions.set(object.id as string, object);
}

function line(sub: Sub, price: string, amount: number, start: number, end: number, proration: boolean) {
  return loadFixture("invoice.line", {
    LINE_ID: id("il"),
    LINE_AMOUNT: amount,
    DISCOUNTABLE: !proration,
    INVOICE_ID: sub.invoice,
    PRORATION: proration,
    SUBSCRIPTION_ID: sub.subscription,
    LINE_START: start,
    LINE_END: end,
    LINE_PRICE: price,
  });
}

function invoicePaid(sub: Sub, reason: string, lines: unknown[], invoiceId = sub.invoice, amount = sub.amount) {
  return loadFixture("invoice.paid", {
    EVENT_ID: id("evt"),
    CREATED: PERIOD_START,
    INVOICE_ID: invoiceId,
    AMOUNT: amount,
    BILLING_REASON: reason,
    CUSTOMER_ID: sub.customer,
    LINES: lines,
    WORKSPACE_ID: sub.workspaceId,
    PLAN: sub.plan,
    CADENCE: sub.cadence,
    SUBSCRIPTION_ID: sub.subscription,
  });
}

function firstInvoice(sub: Sub) {
  const end = sub.cadence === "annual" ? YEAR_END : PERIOD_END;
  return invoicePaid(sub, "subscription_create", [line(sub, sub.price, sub.amount, PERIOD_START, end, false)]);
}

/** checkout.session.completed, customer.subscription.created and the first
 * invoice.paid, in the order Stripe usually sends them. */
async function startSubscription(sub: Sub): Promise<void> {
  const created = subscriptionEvent("customer.subscription.created", sub, "active");
  stripeHolds(created);
  stripeState.invoiceForPaymentIntent.set(`pi_${sub.invoice}`, sub.invoice);
  for (const event of [checkoutCompleted(sub), created, firstInvoice(sub)]) {
    expect((await post(event)).status).toBe(200);
  }
}

interface TopUpRef {
  workspaceId: string;
  session: string;
  paymentIntent: string;
  customer: string;
}

function topUpEvent(ref: TopUpRef, type: string, paymentStatus: string) {
  return loadFixture("checkout.session.topup", {
    EVENT_ID: id("evt"),
    TYPE: type,
    CREATED: PERIOD_START,
    SESSION_ID: ref.session,
    AMOUNT: CENTS.topUp,
    WORKSPACE_ID: ref.workspaceId,
    CUSTOMER_ID: ref.customer,
    INVOICE_ID: id("in"),
    PRICE_ID: PRICE.topUp100,
    PAYMENT_INTENT_ID: ref.paymentIntent,
    PAYMENT_STATUS: paymentStatus,
  });
}

function newTopUp(workspaceId: string): TopUpRef {
  return { workspaceId, session: id("cs"), paymentIntent: id("pi"), customer: id("cus") };
}

function refund(paymentIntent: string, amount: number, refunded: number) {
  return loadFixture("charge.refunded", {
    EVENT_ID: id("evt"),
    CREATED: MID,
    CHARGE_ID: `ch_${paymentIntent}`,
    AMOUNT: amount,
    AMOUNT_REFUNDED: refunded,
    CUSTOMER_ID: "cus_refund",
    PAYMENT_INTENT_ID: paymentIntent,
    FULLY_REFUNDED: refunded >= amount,
  });
}

function dispute(paymentIntent: string, disputeId: string, type: string, status: string) {
  return loadFixture("charge.dispute", {
    EVENT_ID: id("evt"),
    CREATED: MID,
    DISPUTE_ID: disputeId,
    AMOUNT: CENTS.topUp,
    CHARGE_ID: `ch_${paymentIntent}`,
    PAYMENT_INTENT_ID: paymentIntent,
    DISPUTE_STATUS: status,
    TYPE: type,
  });
}

// --- Cases ------------------------------------------------------------------

describe("fixtures", () => {
  it("every fixture fills completely and parses as a Stripe event or line", () => {
    for (const name of FIXTURE_NAMES) {
      const vars = Object.fromEntries(fixturePlaceholders(name).map((key) => [key, key === "LINES" ? [] : 1]));
      const filled = JSON.stringify(loadFixture(name, vars));
      expect(filled).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
      if (name !== "invoice.line") {
        expect(JSON.parse(filled)).toMatchObject({ object: "event", api_version: "2025-08-27.basil" });
      }
    }
    expect(() => loadFixture("charge.refunded", {})).toThrow(/needs a value/);
  });
});

describe("subscriptions", () => {
  it("monthly start: grants one month, sets the plan, the row and the customer, and records the webhook success", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    const after = await snapshot(ws);
    expect(after).toMatchObject({ balance: growth.creditsPerMonth, plan: "growth", stripeCustomerId: sub.customer });
    expect(after.subscriptions).toEqual([{ externalId: sub.subscription, tier: "growth", status: "active" }]);
    expect(after.ledger).toEqual([{ reason: "grant", delta: growth.creditsPerMonth }]);
    expect((await readBillingSignals(db as never)).webhookSuccessAt).not.toBeNull();
    expect(stripeState.moneyWrites).toEqual([]);
  });

  it("annual start: grants the full year up front", async () => {
    const ws = await newWorkspace();
    await startSubscription(newSub(ws, "growth", "annual"));
    expect(await snapshot(ws)).toMatchObject({ balance: growth.creditsPerMonth * 12, plan: "growth" });
  });

  it("renewal: a subscription_cycle invoice grants the next month", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    const renewal = invoicePaid(sub, "subscription_cycle", [line(sub, sub.price, sub.amount, PERIOD_END, NEXT_END, false)], id("in"));
    const updated = subscriptionEvent("customer.subscription.updated", sub, "active", NEXT_END);
    stripeHolds(updated);
    expect((await post(renewal)).body).toMatchObject({ action: "cycle_credits_granted", credits: growth.creditsPerMonth });
    expect((await post(updated)).status).toBe(200);
    const after = await snapshot(ws);
    expect(after).toMatchObject({ balance: growth.creditsPerMonth * 2, plan: "growth" });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.externalId, sub.subscription));
    expect(row.periodEnd?.getTime()).toBe(NEXT_END * 1000);
  });

  it("upgrade mid period: grants the new minus the old allowance for the time left", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    const upgraded: Sub = { ...sub, plan: "pro", price: PRICE.proMonthly, amount: CENTS.pro };
    const updated = subscriptionEvent("customer.subscription.updated", upgraded, "active");
    stripeHolds(updated);
    const invoice = invoicePaid(
      upgraded,
      "subscription_update",
      [
        line(upgraded, PRICE.growthMonthly, -CENTS.growth / 2, MID, PERIOD_END, true),
        line(upgraded, PRICE.proMonthly, CENTS.pro / 2, MID, PERIOD_END, true),
      ],
      id("in"),
      (CENTS.pro - CENTS.growth) / 2,
    );
    expect((await post(updated)).status).toBe(200);
    const granted = (pro.creditsPerMonth - growth.creditsPerMonth) / 2;
    expect((await post(invoice)).body).toMatchObject({ action: "plan_change_credits_granted", credits: granted });
    const after = await snapshot(ws);
    expect(after).toMatchObject({ balance: growth.creditsPerMonth + granted, plan: "pro" });
    expect(after.subscriptions).toEqual([{ externalId: sub.subscription, tier: "pro", status: "active" }]);
  });

  it("immediate downgrade: takes the difference back in full, even below zero", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "pro");
    await startSubscription(sub);
    // Spend most of the month on packs first.
    await db.insert(creditLedger).values({ workspaceId: ws, delta: -(pro.creditsPerMonth - 100), reason: "charge", source: "system" });
    const downgraded: Sub = { ...sub, plan: "growth", price: PRICE.growthMonthly, amount: CENTS.growth };
    const updated = subscriptionEvent("customer.subscription.updated", downgraded, "active");
    stripeHolds(updated);
    const invoice = invoicePaid(
      downgraded,
      "subscription_update",
      [
        line(downgraded, PRICE.proMonthly, -CENTS.pro / 2, MID, PERIOD_END, true),
        line(downgraded, PRICE.growthMonthly, CENTS.growth / 2, MID, PERIOD_END, true),
      ],
      id("in"),
      (CENTS.growth - CENTS.pro) / 2,
    );
    expect((await post(updated)).status).toBe(200);
    const debited = (pro.creditsPerMonth - growth.creditsPerMonth) / 2;
    expect((await post(invoice)).body).toMatchObject({ action: "plan_change_credits_returned", credits: debited });
    expect(await snapshot(ws)).toMatchObject({ balance: 100 - debited, plan: "growth" });
  });

  it("a full refund of a subscription invoice takes its credits back", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    expect((await post(refund(`pi_${sub.invoice}`, sub.amount, sub.amount))).body).toMatchObject({
      action: "refund_clawed_back",
      credits: growth.creditsPerMonth,
    });
    expect((await snapshot(ws)).balance).toBe(0);
  });

  it("subscription events out of order never move a status backwards", async () => {
    // Payload only (no key): the status rules alone decide.
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    expect((await post(subscriptionEvent("customer.subscription.updated", sub, "active"))).status).toBe(200);
    expect((await post(subscriptionEvent("customer.subscription.created", sub, "incomplete"))).body).toMatchObject({
      action: "subscription_stale_ignored",
    });
    expect(await snapshot(ws)).toMatchObject({ plan: "growth", subscriptions: [{ status: "active" }] });

    expect((await post(subscriptionEvent("customer.subscription.deleted", sub, "canceled"))).status).toBe(200);
    expect((await post(subscriptionEvent("customer.subscription.updated", sub, "active"))).body).toMatchObject({
      action: "subscription_stale_ignored",
    });
    expect(await snapshot(ws)).toMatchObject({ plan: "free", subscriptions: [{ status: "canceled" }] });
  });

  it("with Stripe's state read, a late older payload writes the current state", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    const current = subscriptionEvent("customer.subscription.updated", sub, "active");
    stripeHolds(current);
    expect((await post(subscriptionEvent("customer.subscription.created", sub, "incomplete"))).status).toBe(200);
    expect(await snapshot(ws)).toMatchObject({ plan: "growth", subscriptions: [{ status: "active" }] });
  });
});

describe("top ups", () => {
  it("paid at once: grants the top up, plan unchanged", async () => {
    const ws = await newWorkspace();
    const ref = newTopUp(ws);
    expect((await post(topUpEvent(ref, "checkout.session.completed", "paid"))).body).toMatchObject({
      action: "topup_granted",
      credits: topUp.credits,
    });
    expect(await snapshot(ws)).toMatchObject({ balance: topUp.credits, plan: "free", ledger: [{ reason: "topup" }] });
  });

  it("paid later: nothing on completion, the grant on async_payment_succeeded", async () => {
    const ws = await newWorkspace();
    const ref = newTopUp(ws);
    expect((await post(topUpEvent(ref, "checkout.session.completed", "unpaid"))).body).toMatchObject({
      action: "topup_awaiting_payment",
    });
    expect((await snapshot(ws)).balance).toBe(0);
    expect((await post(topUpEvent(ref, "checkout.session.async_payment_succeeded", "paid"))).body).toMatchObject({
      action: "topup_granted",
    });
    expect((await snapshot(ws)).balance).toBe(topUp.credits);
  });

  it("partial then full refund: takes back in proportion, never twice", async () => {
    const ws = await newWorkspace();
    const ref = newTopUp(ws);
    await post(topUpEvent(ref, "checkout.session.completed", "paid"));
    await post(refund(ref.paymentIntent, CENTS.topUp, CENTS.topUp / 2));
    expect((await snapshot(ws)).balance).toBe(topUp.credits / 2);
    await post(refund(ref.paymentIntent, CENTS.topUp, CENTS.topUp));
    const after = await snapshot(ws);
    expect(after.balance).toBe(0);
    expect(after.ledger.filter((row) => row.reason === "refund")).toHaveLength(2);
  });

  it("a dispute won gives back exactly what it took", async () => {
    const ws = await newWorkspace();
    const ref = newTopUp(ws);
    const disputeId = id("dp");
    await post(topUpEvent(ref, "checkout.session.completed", "paid"));
    await post(dispute(ref.paymentIntent, disputeId, "charge.dispute.funds_withdrawn", "needs_response"));
    expect((await snapshot(ws)).balance).toBe(0);
    expect((await post(dispute(ref.paymentIntent, disputeId, "charge.dispute.closed", "won"))).body).toMatchObject({
      action: "dispute_won_credits_restored",
      credits: topUp.credits,
    });
    // funds_reinstated for the same win restores nothing more.
    await post(dispute(ref.paymentIntent, disputeId, "charge.dispute.funds_reinstated", "won"));
    expect((await snapshot(ws)).balance).toBe(topUp.credits);
  });

  it("a dispute lost keeps the credits taken back", async () => {
    const ws = await newWorkspace();
    const ref = newTopUp(ws);
    const disputeId = id("dp");
    await post(topUpEvent(ref, "checkout.session.completed", "paid"));
    await post(dispute(ref.paymentIntent, disputeId, "charge.dispute.funds_withdrawn", "needs_response"));
    expect((await post(dispute(ref.paymentIntent, disputeId, "charge.dispute.closed", "lost"))).body).toMatchObject({
      action: "dispute_closed_noted",
    });
    await post(dispute(ref.paymentIntent, disputeId, "charge.dispute.funds_reinstated", "lost"));
    expect((await snapshot(ws)).balance).toBe(0);
  });
});

describe("delivery", () => {
  it("a duplicate delivery grants once", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    stripeHolds(subscriptionEvent("customer.subscription.created", sub, "active"));
    const paid = firstInvoice(sub);
    expect((await post(paid)).body).toMatchObject({ duplicate: false });
    expect((await post(paid)).body).toMatchObject({ duplicate: true });
    expect((await snapshot(ws)).ledger).toEqual([{ reason: "grant", delta: growth.creditsPerMonth }]);
  });

  it("an event that routes to no workspace answers 500 so Stripe retries, and writes nothing", async () => {
    await db.delete(platformSettings);
    const orphan = newSub("", "growth");
    const paid = invoicePaid(orphan, "subscription_create", [line(orphan, orphan.price, orphan.amount, PERIOD_START, PERIOD_END, false)]);
    const rowsBefore = (await db.select().from(creditLedger)).length;
    const response = await post(paid);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: "unroutable_event" });
    expect((await db.select().from(creditLedger)).length).toBe(rowsBefore);
    expect((await readBillingSignals(db as never)).webhookSuccessAt).toBeNull();
  });

  it("refuses a signature older than 300 seconds", async () => {
    const ws = await newWorkspace();
    const ref = newTopUp(ws);
    const stale = Math.floor(Date.now() / 1000) - 301;
    const response = await post(topUpEvent(ref, "checkout.session.completed", "paid"), { timestamp: stale });
    expect(response.status).toBe(400);
    expect((await snapshot(ws)).balance).toBe(0);
    const fresh = await post(topUpEvent(ref, "checkout.session.completed", "paid"), { timestamp: Math.floor(Date.now() / 1000) - 30 });
    expect(fresh.status).toBe(200);
  });
});

describe("renewal consent, cadence and the activation email (P20-07)", () => {
  function resend(status = 200) {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify(status === 200 ? { id: "email_1" } : { message: "down" }), { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    return { calls, fetchMock };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records one consent row per completed plan checkout, copying the disclosure from the session", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth", "annual");
    await startSubscription(sub);
    const rows = await db.select().from(billingConsents).where(eq(billingConsents.workspaceId, ws));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      checkoutSessionId: `cs_${sub.subscription}`,
      userId: BUYER,
      tier: "growth",
      cadence: "annual",
      amountUsd: sub.amount / 100,
      disclosureVersion: "2026-10-02",
      disclosureSha256: `sha_${sub.subscription}`,
    });
    expect(rows[0]?.acceptedAt.getTime()).toBe(PERIOD_START * 1000);
    // The record shows by itself who agreed and what they saw (law and copy
    // review major 8): the email as given and its 0012 normalized key, the
    // Stripe customer, and the exact text copied from the session.
    const key = await client.query<{ key: string }>("select normalized_email_key('buyer@example.com') as key");
    expect(rows[0]?.emailKey).toBe(key.rows[0]?.key);
    expect(rows[0]).toMatchObject({
      email: "buyer@example.com",
      stripeCustomerId: sub.customer,
      portalSessionId: null,
      disclosureText:
        "Your Curvi plan renews automatically until you cancel.\nI agree that my plan renews automatically at the price above until I cancel.",
    });
    // A retried delivery and a replay write no second row.
    expect((await post(checkoutCompleted(sub))).body).toMatchObject({ action: "consent_recorded", duplicate: true });
    expect(await db.select().from(billingConsents).where(eq(billingConsents.workspaceId, ws))).toHaveLength(1);
  });

  it("records nothing for a session whose terms checkbox was not accepted (law and copy review major 8)", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    const event = checkoutCompleted(sub) as unknown as { data: { object: { consent: unknown } } };
    event.data.object.consent = { promotions: null, terms_of_service: null };
    await post(event);
    expect(await db.select().from(billingConsents).where(eq(billingConsents.workspaceId, ws))).toHaveLength(0);
  });

  it("keeps the version the buyer saw, even when the wording changed before a replay", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await post(checkoutCompleted(sub, { version: "2025-12-01", sha256: "sha_old_wording" }));
    const [row] = await db.select().from(billingConsents).where(eq(billingConsents.workspaceId, ws));
    expect(row).toMatchObject({ disclosureVersion: "2025-12-01", disclosureSha256: "sha_old_wording" });
  });

  it("writes the cadence from the price interval on every subscription event", async () => {
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth", "annual");
    await startSubscription(sub);
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ws));
    expect(row?.cadence).toBe("annual");
  });

  it("sends one activation email for the first paid invoice, never for a retry or a renewal", async () => {
    const { calls } = resend();
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.body).toMatchObject({
      from: openCheckoutEnv().BILLING_EMAIL_FROM,
      to: ["buyer@example.com"],
      subject: "Your Curvi Growth plan is active",
      reply_to: "hello@curvi.ai",
    });
    expect(calls[0]?.headers["Idempotency-Key"]).toBe(`plan_active:${sub.invoice}`);
    const text = String(calls[0]?.body.text);
    expect(text).toContain("Charged today: $79");
    expect(text).toContain("billed every month");
    expect(text).toContain("Next renewal: December 1, 2026");
    expect(text).toContain("Cancel any time in Billing: ");
    expect(text).toContain("Questions? Reply to this email or write to hello@curvi.ai.");

    // Stripe retries the same invoice.paid: no second email.
    expect((await post(firstInvoice(sub))).status).toBe(200);
    // A renewal is not an activation.
    const renewal = { ...sub, invoice: id("in") };
    await post(invoicePaid(renewal, "subscription_cycle", [line(renewal, sub.price, sub.amount, PERIOD_END, NEXT_END, false)]));
    expect(calls).toHaveLength(1);
    const claims = await db.select().from(events).where(eq(events.name, `billing:email:plan_active:${sub.invoice}`));
    expect(claims).toHaveLength(1);
  });

  it("gives the claim back when Resend fails, so the next delivery sends it", async () => {
    const failing = resend(500);
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    expect(failing.calls).toHaveLength(1);
    expect(await db.select().from(events).where(eq(events.name, `billing:email:plan_active:${sub.invoice}`))).toHaveLength(0);
    // The grant itself went through; the webhook answered 200.
    expect((await snapshot(ws)).balance).toBe(growth.creditsPerMonth);

    const working = resend(200);
    await post(firstInvoice(sub));
    expect(working.calls).toHaveLength(1);
    expect(await db.select().from(events).where(eq(events.name, `billing:email:plan_active:${sub.invoice}`))).toHaveLength(1);
  });

  it("acknowledges a paid upgrade once with the new plan (law and copy review major 3)", async () => {
    const { calls } = resend();
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    const upgraded: Sub = { ...sub, plan: "pro", price: PRICE.proMonthly, amount: CENTS.pro };
    const changeInvoice = id("in");
    const invoice = invoicePaid(
      upgraded,
      "subscription_update",
      [
        line(upgraded, PRICE.growthMonthly, -CENTS.growth / 2, MID, PERIOD_END, true),
        line(upgraded, PRICE.proMonthly, CENTS.pro / 2, MID, PERIOD_END, true),
      ],
      changeInvoice,
      (CENTS.pro - CENTS.growth) / 2,
    );
    await post(invoice);
    await post(invoice);
    const changes = calls.filter((call) => call.headers["Idempotency-Key"] === `plan_changed:${changeInvoice}`);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.body).toMatchObject({ subject: "Your Curvi plan is now Pro", to: ["buyer@example.com"] });
    const text = String(changes[0]?.body.text);
    expect(text).toContain(`Renews at: $${CENTS.pro / 100} a month plus any tax that applies`);
    expect(text).toContain("Next renewal: December 1, 2026");
    expect(await db.select().from(events).where(eq(events.name, `billing:email:plan_changed:${changeInvoice}`))).toHaveLength(1);
  });

  it("sends nothing and claims nothing without the billing sender", async () => {
    const { calls } = resend();
    vi.stubEnv("BILLING_EMAIL_FROM", "");
    const ws = await newWorkspace();
    const sub = newSub(ws, "growth");
    await startSubscription(sub);
    expect(calls).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.name, `billing:email:plan_active:${sub.invoice}`))).toHaveLength(0);
  });
});

import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tierByKey } from "@curvi/pipeline/seed";
import { creditLedger, events, generationJobs, products, subscriptions, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { DbBillingStore } from "./db-store";
import { buildPriceTable, tierPriceEnvName, topUpPriceEnvName } from "./price-table";
import { processStripeEvent, UnroutableBillingEventError } from "./stripe-webhook";

// Billing on a real Postgres (PGlite) with every migration applied: grant
// atomicity (Update.md 1.3), annual grants (1.2), workspaces.plan (1.1),
// second subscriptions (1.5), paid only top ups (1.4) and clawbacks.

const ENV: Record<string, string> = {
  [tierPriceEnvName("growth", "monthly")]: "price_growth_monthly",
  [tierPriceEnvName("growth", "annual")]: "price_growth_annual",
  [tierPriceEnvName("pro", "monthly")]: "price_pro_monthly",
  [topUpPriceEnvName(100)]: "price_topup_100",
};
const table = buildPriceTable((name) => ENV[name]);
const growth = tierByKey("growth");
const pro = tierByKey("pro");
const T0 = 1_790_000_000;
const DAY = 24 * 60 * 60;

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 0;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

function asDb(value: unknown): Db {
  return value as Db;
}

function store(target: unknown = db): DbBillingStore {
  return new DbBillingStore(asDb(target), "stripe");
}

async function newWorkspace(plan = "free", stripeCustomerId: string | null = null): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(workspaces)
    .values({ name: `Billing ${counter}`, plan, stripeCustomerId })
    .returning();
  return row.id;
}

async function balance(workspaceId: string): Promise<number> {
  const result = await client.query<{ balance: string | number }>(
    "select coalesce(sum(delta), 0) as balance from credit_ledger where workspace_id = $1",
    [workspaceId],
  );
  return Number(result.rows[0].balance);
}

async function ledgerRows(workspaceId: string) {
  return db.select().from(creditLedger).where(eq(creditLedger.workspaceId, workspaceId));
}

async function planOf(workspaceId: string): Promise<string> {
  const [row] = await db.select({ plan: workspaces.plan }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row.plan;
}

function event(id: string, type: string, object: Record<string, unknown>): Stripe.Event {
  return { id, type, object: "event", data: { object } } as unknown as Stripe.Event;
}

function invoice(id: string, workspaceId: string | null, billingReason: string, lines: Array<Record<string, unknown>>, customer = "cus_x") {
  return event(`evt_${id}`, "invoice.paid", {
    id,
    object: "invoice",
    customer,
    billing_reason: billingReason,
    parent: {
      type: "subscription_details",
      subscription_details: { metadata: workspaceId ? { workspaceId } : {} },
    },
    lines: { data: lines },
  });
}

function line(price: string, amount: number, proration = false, days = 30) {
  return {
    id: `il_${price}_${amount}`,
    amount,
    period: { start: T0, end: T0 + days * DAY },
    pricing: { type: "price_details", price_details: { price } },
    parent: {
      type: "subscription_item_details",
      subscription_item_details: { proration },
      invoice_item_details: null,
    },
  };
}

function subscriptionEvent(id: string, type: string, sub: { id: string; workspaceId: string; status: string; price: string }) {
  return event(id, type, {
    id: sub.id,
    object: "subscription",
    customer: "cus_sub",
    status: sub.status,
    metadata: { workspaceId: sub.workspaceId },
    items: { data: [{ id: `si_${sub.id}`, current_period_end: T0, price: { id: sub.price } }] },
  });
}

/**
 * Wraps the database so the first `failures` credit_ledger inserts inside a
 * transaction throw, the way a dropped connection or a constraint error
 * would after the dedupe row was written.
 */
function failingLedgerDb(target: TestDb, failures: number): TestDb {
  let remaining = failures;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === "transaction") {
        return (fn: (tx: unknown) => Promise<unknown>) =>
          obj.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(txObj, txProp, txReceiver) {
                  if (txProp === "insert") {
                    return (tableArg: unknown) => {
                      if (tableArg === creditLedger && remaining > 0) {
                        remaining -= 1;
                        throw new Error("injected ledger failure");
                      }
                      return txObj.insert(tableArg as typeof creditLedger);
                    };
                  }
                  const value = Reflect.get(txObj, txProp, txReceiver) as unknown;
                  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(txObj) : value;
                },
              }),
            ),
          );
      }
      const value = Reflect.get(obj, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(obj) : value;
    },
  });
}

describe("grant atomicity (Update.md 1.3)", () => {
  it("rolls the dedupe claim back when the ledger insert fails, so the retry grants exactly once", async () => {
    const ws = await newWorkspace();
    const paid = invoice("in_atomic", ws, "subscription_cycle", [line("price_growth_monthly", 7900)]);

    await expect(processStripeEvent(paid, table, store(failingLedgerDb(db, 1)))).rejects.toThrow(
      "injected ledger failure",
    );
    expect(await ledgerRows(ws)).toHaveLength(0);
    const claimed = await db.select().from(events).where(eq(events.name, "billing:stripe:invoice:in_atomic"));
    expect(claimed).toHaveLength(0);

    // Stripe retries the same event.
    const retry = await processStripeEvent(paid, table, store());
    expect(retry).toMatchObject({ action: "cycle_credits_granted", duplicate: false });
    const again = await processStripeEvent(paid, table, store());
    expect(again).toMatchObject({ duplicate: true });

    expect(await ledgerRows(ws)).toHaveLength(1);
    expect(await balance(ws)).toBe(growth.creditsPerMonth);
  });
});

describe("annual grant (Update.md 1.2, decision 2)", () => {
  it("adds twelve months of credits when the annual invoice is paid", async () => {
    const ws = await newWorkspace();
    await processStripeEvent(
      invoice("in_year", ws, "subscription_create", [line("price_growth_annual", 79200, false, 365)]),
      table,
      store(),
    );
    expect(await balance(ws)).toBe(growth.creditsPerMonth * 12);
    const [row] = await ledgerRows(ws);
    expect(row).toMatchObject({ reason: "grant", source: "stripe" });
  });

  it("adds only the upgrade difference on a plan change invoice", async () => {
    const ws = await newWorkspace();
    await processStripeEvent(
      invoice("in_upgrade", ws, "subscription_update", [
        line("price_growth_monthly", -3900, true),
        line("price_pro_monthly", 7400, true),
      ]),
      table,
      store(),
    );
    expect(await balance(ws)).toBe(pro.creditsPerMonth - growth.creditsPerMonth);
  });
});

describe("plan change debit (money-plan-change)", () => {
  it("takes back the downgrade difference once and never below zero", async () => {
    const ws = await newWorkspace();
    await processStripeEvent(
      invoice("in_pro_month", ws, "subscription_cycle", [line("price_pro_monthly", 14900)]),
      table,
      store(),
    );
    const downgrade = invoice("in_downgrade", ws, "subscription_update", [
      line("price_pro_monthly", -7400, true),
      line("price_growth_monthly", 3900, true),
    ]);
    await processStripeEvent(downgrade, table, store());
    await processStripeEvent(downgrade, table, store());
    expect(await balance(ws)).toBe(growth.creditsPerMonth);

    const empty = await newWorkspace();
    await processStripeEvent(
      invoice("in_downgrade_empty", empty, "subscription_update", [
        line("price_pro_monthly", -7400, true),
        line("price_growth_monthly", 3900, true),
      ]),
      table,
      store(),
    );
    expect(await balance(empty)).toBe(0);
  });
});

describe("workspaces.plan follows the subscription (Update.md 1.1)", () => {
  it("sets the plan on create, moves it on update and returns to free on delete", async () => {
    const ws = await newWorkspace();
    const sub = { id: "sub_plan", workspaceId: ws, status: "active", price: "price_growth_monthly" };

    await processStripeEvent(subscriptionEvent("evt_p1", "customer.subscription.created", sub), table, store());
    expect(await planOf(ws)).toBe("growth");

    await processStripeEvent(
      subscriptionEvent("evt_p2", "customer.subscription.updated", { ...sub, price: "price_pro_monthly" }),
      table,
      store(),
    );
    expect(await planOf(ws)).toBe("pro");

    await processStripeEvent(
      subscriptionEvent("evt_p3", "customer.subscription.updated", { ...sub, status: "past_due", price: "price_pro_monthly" }),
      table,
      store(),
    );
    expect(await planOf(ws)).toBe("pro");

    await processStripeEvent(subscriptionEvent("evt_p4", "customer.subscription.deleted", sub), table, store());
    expect(await planOf(ws)).toBe("free");

    const changes = await db.select().from(events).where(eq(events.workspaceId, ws));
    const planChanges = changes.filter((row) => row.name === "plan_changed").map((row) => row.props);
    expect(planChanges).toEqual([
      expect.objectContaining({ from: "free", to: "growth" }),
      expect.objectContaining({ from: "growth", to: "pro" }),
      expect.objectContaining({ from: "pro", to: "free" }),
    ]);
  });

  it("keeps the plan when a live subscription is on a price the table does not know", async () => {
    const ws = await newWorkspace("growth");
    await processStripeEvent(
      subscriptionEvent("evt_unknown_price", "customer.subscription.updated", {
        id: "sub_unknown",
        workspaceId: ws,
        status: "active",
        price: "price_not_mapped",
      }),
      table,
      store(),
    );
    expect(await planOf(ws)).toBe("growth");
  });

  it("does not throw when a second subscription becomes active (Update.md 1.5)", async () => {
    const ws = await newWorkspace();
    await processStripeEvent(
      subscriptionEvent("evt_first", "customer.subscription.created", {
        id: "sub_first",
        workspaceId: ws,
        status: "active",
        price: "price_growth_monthly",
      }),
      table,
      store(),
    );
    await expect(
      processStripeEvent(
        subscriptionEvent("evt_second", "customer.subscription.created", {
          id: "sub_second",
          workspaceId: ws,
          status: "active",
          price: "price_pro_monthly",
        }),
        table,
        store(),
      ),
    ).resolves.toMatchObject({ action: "subscription_synced" });

    const rows = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ws));
    expect(rows.filter((row) => row.status === "active").map((row) => row.externalId)).toEqual(["sub_second"]);
    expect(rows.find((row) => row.externalId === "sub_first")?.status).toBe("superseded");
    expect(await planOf(ws)).toBe("pro");
  });
});

describe("top ups only when paid (Update.md 1.4)", () => {
  function session(eventId: string, type: string, ws: string, paymentStatus: string) {
    return event(eventId, type, {
      id: `cs_${ws}`,
      object: "checkout.session",
      mode: "payment",
      customer: `cus_${ws}`,
      payment_status: paymentStatus,
      payment_intent: `pi_${ws}`,
      metadata: { workspaceId: ws, priceId: "price_topup_100" },
    });
  }

  it("waits for an unpaid session, then grants once on async success", async () => {
    const ws = await newWorkspace();
    await processStripeEvent(session("evt_t1", "checkout.session.completed", ws, "unpaid"), table, store());
    expect(await balance(ws)).toBe(0);
    const [linked] = await db.select().from(workspaces).where(eq(workspaces.id, ws));
    expect(linked.stripeCustomerId).toBe(`cus_${ws}`);

    const success = session("evt_t2", "checkout.session.async_payment_succeeded", ws, "paid");
    await processStripeEvent(success, table, store());
    await processStripeEvent(success, table, store());
    expect(await balance(ws)).toBe(100);
    expect(await ledgerRows(ws)).toHaveLength(1);
  });
});

describe("refund and dispute clawback (decision 3)", () => {
  function refund(eventId: string, paymentIntent: string, amount: number, refunded: number) {
    return event(eventId, "charge.refunded", {
      id: `ch_${eventId}`,
      object: "charge",
      amount,
      amount_refunded: refunded,
      payment_intent: paymentIntent,
    });
  }

  async function toppedUp(): Promise<string> {
    const ws = await newWorkspace();
    await processStripeEvent(
      event(`evt_top_${ws}`, "checkout.session.completed", {
        id: `cs_${ws}`,
        object: "checkout.session",
        mode: "payment",
        customer: `cus_${ws}`,
        payment_status: "paid",
        payment_intent: `pi_${ws}`,
        metadata: { workspaceId: ws, priceId: "price_topup_100" },
      }),
      table,
      store(),
    );
    return ws;
  }

  it("claws back a refunded top up but never below zero, and collects the rest on a later refund", async () => {
    const ws = await toppedUp();
    const [product] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId: product.id }).returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 95, job.id]);
    expect(await balance(ws)).toBe(5);

    const first = await processStripeEvent(refund("evt_r1", `pi_${ws}`, 1500, 1500), table, store());
    expect(first).toMatchObject({ action: "refund_clawed_back", credits: 5 });
    expect(await balance(ws)).toBe(0);

    // The duplicate delivery changes nothing.
    await processStripeEvent(refund("evt_r1", `pi_${ws}`, 1500, 1500), table, store());
    expect(await balance(ws)).toBe(0);

    // The held credits come back, then a later refund event collects the shortfall.
    await client.query("select release_credits($1, $2)", [ws, job.id]);
    expect(await balance(ws)).toBe(95);
    await processStripeEvent(refund("evt_r2", `pi_${ws}`, 1500, 1500), table, store());
    expect(await balance(ws)).toBe(0);
    const refunds = (await ledgerRows(ws)).filter((row) => row.reason === "refund");
    expect(refunds.reduce((sum, row) => sum - row.delta, 0)).toBe(100);
  });

  it("claws back in proportion to a partial refund", async () => {
    const ws = await toppedUp();
    await processStripeEvent(refund("evt_partial", `pi_${ws}`, 1500, 300), table, store());
    expect(await balance(ws)).toBe(80);
  });

  it("ignores a forged smaller grant row when choosing what to claw back", async () => {
    const ws = await toppedUp();
    await db.insert(events).values({
      workspaceId: ws,
      name: "billing:stripe:checkout:cs_forged",
      props: { kind: "grant", credits: 1, paymentIntentId: `pi_${ws}` },
    });
    await processStripeEvent(refund("evt_forged", `pi_${ws}`, 1500, 1500), table, store());
    expect(await balance(ws)).toBe(0);
  });

  it("claws back a disputed subscription invoice found through the Stripe lookup", async () => {
    const ws = await newWorkspace();
    await processStripeEvent(
      invoice("in_dispute_db", ws, "subscription_cycle", [line("price_growth_monthly", 7900)]),
      table,
      store(),
    );
    const dispute = event("evt_dp", "charge.dispute.created", {
      id: "dp_db",
      object: "dispute",
      charge: "ch_dp",
      payment_intent: "pi_invoice_dp",
    });
    const lookup = { invoiceIdForPaymentIntent: async () => "in_dispute_db" };
    const result = await processStripeEvent(dispute, table, store(), { lookup });
    expect(result).toMatchObject({ action: "dispute_clawed_back", credits: growth.creditsPerMonth });
    expect(await balance(ws)).toBe(0);
  });
});

describe("unroutable events", () => {
  it("throws for Stripe without writing anything, then lands once the customer is linked", async () => {
    const paid = invoice("in_orphan_db", null, "subscription_cycle", [line("price_growth_monthly", 7900)], "cus_orphan");
    await expect(processStripeEvent(paid, table, store())).rejects.toBeInstanceOf(UnroutableBillingEventError);
    const claimed = await db.select().from(events).where(eq(events.name, "billing:stripe:invoice:in_orphan_db"));
    expect(claimed).toHaveLength(0);

    const ws = await newWorkspace("free", "cus_orphan");
    await processStripeEvent(paid, table, store());
    await processStripeEvent(paid, table, store());
    expect(await balance(ws)).toBe(growth.creditsPerMonth);
  });

  it("keeps acknowledging unroutable Shopify grants", async () => {
    const shopify = new DbBillingStore(asDb(db), "shopify");
    await expect(
      shopify.recordGrantOnce("shopify_webhook_1", {
        workspaceId: null,
        stripeCustomerId: null,
        credits: 10,
        reason: "grant",
        expiresMonths: null,
      }),
    ).resolves.toBe(true);
  });
});

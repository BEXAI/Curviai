/**
 * The Stripe webhook path of referral rewards (docs/phases/PHASE_18.md
 * P18-24), run through the real billing store on PGlite: a referred
 * workspace's first payment produces exactly two reward rows, once across
 * retried deliveries, and a refund or dispute of that payment within the
 * window reverses both. Two workspaces paying with the same card are one
 * person, so that referral is rejected (same_card), and a failed step is
 * reported so the route answers 500 and Stripe delivers again.
 */

import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { referralReward } from "@curvi/pipeline/seed";
import { creditLedger, members, referrals, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { DbBillingStore } from "@/lib/billing/db-store";
import { recordStripeFunnel } from "@/lib/billing/funnel";
import { buildPriceTable, tierPriceEnvName, topUpPriceEnvName } from "@/lib/billing/price-table";
import { processStripeEvent, type StripeProcessDeps } from "@/lib/billing/stripe-webhook";
import { issueReferralCode, recordReferralSignup } from "./service";
import {
  chargeFingerprints,
  recordStripeReferrals,
  referralClawbackKey,
  referralPaymentSteps,
  type CustomerFingerprints,
} from "./stripe";

const ENV: Record<string, string> = {
  [tierPriceEnvName("starter", "monthly")]: "price_starter_monthly",
  [topUpPriceEnvName(100)]: "price_topup_100",
};
const table = buildPriceTable((name) => ENV[name]);
const NOW = new Date(Date.UTC(2026, 11, 10, 12));
const DAY_S = 24 * 60 * 60;

function event(type: string, object: Record<string, unknown>, id: string, createdAt: Date = NOW): Stripe.Event {
  return { id, type, created: Math.floor(createdAt.getTime() / 1000), data: { object } } as unknown as Stripe.Event;
}

function topUpCheckout(workspaceId: string, sessionId: string, paymentIntent: string): Stripe.Event {
  return event(
    "checkout.session.completed",
    {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      amount_total: 1500,
      currency: "usd",
      payment_status: "paid",
      payment_intent: paymentIntent,
      metadata: { workspaceId, kind: "topup", plan: "topup", cadence: "one_time", source: "billing", priceId: "price_topup_100" },
    },
    `evt_${sessionId}`,
  );
}

function paidInvoice(id: string, workspaceId: string): Stripe.Event {
  return event(
    "invoice.paid",
    {
      id,
      object: "invoice",
      billing_reason: "subscription_create",
      amount_paid: 1900,
      currency: "usd",
      parent: { type: "subscription_details", subscription_details: { metadata: { workspaceId } } },
      lines: {
        data: [
          {
            id: "il_1",
            amount: 2900,
            period: { start: 1_796_000_000, end: 1_798_592_000 },
            pricing: { type: "price_details", price_details: { price: "price_starter_monthly" } },
            parent: { type: "subscription_item_details", subscription_item_details: { proration: false } },
          },
        ],
      },
    },
    `evt_${id}`,
  );
}

/** Each workspace gets its own Stripe customer (as checkout-guard.ts makes
 * them); cards maps a customer to the fingerprints on its charges. */
const cards = new Map<string, Set<string>>();
const fingerprints: CustomerFingerprints = async (customer) => cards.get(customer) ?? new Set();

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 0;
const asDb = () => db as unknown as Db;

async function workspaceWithOwner(name: string, card = `card:${name}-${counter}`): Promise<{ ws: string; user: string }> {
  const [row] = await db.insert(workspaces).values({ name }).returning();
  counter += 1;
  const customer = `cus_test${counter}`;
  await db.update(workspaces).set({ stripeCustomerId: customer }).where(eq(workspaces.id, row.id));
  cards.set(customer, new Set([card]));
  const user = `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  await db.insert(members).values({ workspaceId: row.id, userId: user, role: "owner" });
  return { ws: row.id, user };
}

async function referredPair(card?: string): Promise<{ referrer: string; referred: string }> {
  const a = await workspaceWithOwner("Referrer", card);
  const b = await workspaceWithOwner("Referred", card);
  const { code } = await issueReferralCode(asDb(), a.ws);
  await recordReferralSignup(asDb(), { userId: b.user, code, now: NOW });
  return { referrer: a.ws, referred: b.ws };
}

async function rewardRows(ws: string) {
  return (await db.select().from(creditLedger)).filter((row) => row.workspaceId === ws && row.reason === "referral");
}

async function balance(ws: string): Promise<number> {
  return (await db.select().from(creditLedger))
    .filter((row) => row.workspaceId === ws)
    .reduce((sum, row) => sum + Number(row.delta), 0);
}

/** What the webhook route does in db mode, in order. */
async function deliver(stripeEvent: Stripe.Event, deps: StripeProcessDeps = {}, enabled = true) {
  const result = await processStripeEvent(stripeEvent, table, new DbBillingStore(asDb()), deps);
  await recordStripeFunnel(asDb(), stripeEvent, result, table);
  const report = await recordStripeReferrals(asDb(), stripeEvent, result, table, {
    enabled: async () => enabled,
    fingerprints,
    now: () => NOW,
  });
  expect(report.failed).toBe(false);
  return { result, referral: report.steps };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("referralPaymentSteps and referralClawbackKey", () => {
  it("counts a paid grant on a retried delivery too, and nothing else", () => {
    const paid = topUpCheckout("ws", "cs_x", "pi_x");
    expect(referralPaymentSteps(paid, { handled: true, action: "topup_granted", duplicate: true }, table)).toEqual([
      { grantKey: "checkout:cs_x", workspaceHint: "ws" },
    ]);
    expect(referralPaymentSteps(paid, { handled: true, action: "checkout_noted" }, table)).toEqual([]);
  });

  it("names the billing clawback a refund or a dispute made", () => {
    expect(referralClawbackKey(event("charge.refunded", { id: "ch_1" }, "evt_r"), { handled: true, action: "refund_clawed_back" })).toEqual({
      key: "evt_r",
      reason: "refunded",
    });
    expect(
      referralClawbackKey(event("charge.dispute.funds_withdrawn", { id: "dp_1" }, "evt_d"), {
        handled: true,
        action: "dispute_clawed_back",
      }),
    ).toEqual({ key: "dispute:dp_1", reason: "disputed" });
    expect(referralClawbackKey(event("charge.refunded", { id: "ch_1" }, "evt_n"), { handled: true, action: "refund_no_grant" })).toBeNull();
  });
});

describe("recordStripeReferrals", () => {
  it("rewards a top up first payment with exactly two rows, once, and a refund within 30 days reverses both", async () => {
    const { referrer, referred } = await referredPair();
    const paid = topUpCheckout(referred, "cs_first", "pi_first");
    const first = await deliver(paid);
    expect(first.result.action).toBe("topup_granted");
    expect(first.referral).toMatchObject([{ kind: "qualify", paymentKey: "checkout:cs_first", result: { outcome: "rewarded" } }]);

    const retry = await deliver(paid);
    expect(retry.result.duplicate).toBe(true);
    expect(retry.referral).toEqual([]);
    expect(await rewardRows(referrer)).toHaveLength(1);
    expect(await rewardRows(referred)).toHaveLength(1);
    expect(await balance(referrer)).toBe(referralReward.credits);
    expect(await balance(referred)).toBe(100 + referralReward.credits);

    const refund = event(
      "charge.refunded",
      { id: "ch_first", object: "charge", amount: 1500, amount_refunded: 1500, payment_intent: "pi_first" },
      "evt_refund_first",
      new Date(NOW.getTime() + 10 * DAY_S * 1000),
    );
    const refunded = await deliver(refund);
    expect(refunded.result.action).toBe("refund_clawed_back");
    expect(refunded.referral).toMatchObject([{ kind: "reverse", paymentKey: "checkout:cs_first", result: { outcome: "reversed" } }]);
    expect(await balance(referrer)).toBe(0);
    expect(await balance(referred)).toBe(0);
    const [row] = (await db.select().from(referrals)).filter((r) => r.referredWorkspaceId === referred);
    expect(row).toMatchObject({ status: "reversed", rejectReason: "refunded" });

    // A second delivery of the refund changes nothing.
    await deliver(refund);
    expect(await rewardRows(referrer)).toHaveLength(2);
  });

  it("rewards a subscription invoice and reverses it on a dispute found through the invoice lookup", async () => {
    const { referrer, referred } = await referredPair();
    const paid = await deliver(paidInvoice("in_sub_first", referred));
    expect(paid.referral).toMatchObject([{ kind: "qualify", paymentKey: "invoice:in_sub_first", result: { outcome: "rewarded" } }]);

    const lookup = { invoiceIdForPaymentIntent: vi.fn(async () => "in_sub_first") };
    const dispute = event(
      "charge.dispute.funds_withdrawn",
      { id: "dp_first", object: "dispute", status: "needs_response", charge: "ch_sub", payment_intent: "pi_sub" },
      "evt_dispute_first",
    );
    const disputed = await deliver(dispute, { lookup });
    expect(disputed.result.action).toBe("dispute_clawed_back");
    expect(disputed.referral).toMatchObject([{ kind: "reverse", result: { outcome: "reversed" } }]);
    expect(await balance(referrer)).toBe(0);
    const [row] = (await db.select().from(referrals)).filter((r) => r.referredWorkspaceId === referred);
    expect(row).toMatchObject({ status: "reversed", rejectReason: "disputed" });
  });

  it("rejects the referral when its first payment arrives while rewards are off", async () => {
    const { referrer, referred } = await referredPair();
    const paid = await deliver(topUpCheckout(referred, "cs_off", "pi_off"), {}, false);
    expect(paid.referral).toMatchObject([{ kind: "qualify", result: { outcome: "rejected", reason: "rewards_off" } }]);
    expect(await rewardRows(referrer)).toHaveLength(0);
  });

  it("rejects a referral whose first payment used a card that also paid for the referrer", async () => {
    // One person, two emails, one card: every workspace has its own Stripe
    // customer, so only the card fingerprint shows it.
    const { referrer, referred } = await referredPair("card:fp_same");
    const paid = await deliver(topUpCheckout(referred, "cs_same_card", "pi_same_card"));
    expect(paid.result.action).toBe("topup_granted");
    expect(paid.referral).toMatchObject([{ kind: "qualify", result: { outcome: "rejected", reason: "same_card" } }]);
    expect(await rewardRows(referrer)).toHaveLength(0);
    expect(await rewardRows(referred)).toHaveLength(0);
    const [row] = (await db.select().from(referrals)).filter((r) => r.referredWorkspaceId === referred);
    expect(row).toMatchObject({ status: "rejected", rejectReason: "same_card" });
  });

  it("reads the cards only while rewards are on", async () => {
    const { referred } = await referredPair();
    const read = vi.fn(fingerprints);
    const result = await processStripeEvent(topUpCheckout(referred, "cs_no_read", "pi_no_read"), table, new DbBillingStore(asDb()), {});
    const report = await recordStripeReferrals(asDb(), topUpCheckout(referred, "cs_no_read", "pi_no_read"), result, table, {
      enabled: async () => false,
      fingerprints: read,
      now: () => NOW,
    });
    expect(report.steps).toMatchObject([{ result: { outcome: "rejected", reason: "rewards_off" } }]);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports a failed step, so the route answers 500 and the retry pays the reward once", async () => {
    const { referrer, referred } = await referredPair();
    const paid = topUpCheckout(referred, "cs_retry", "pi_retry");
    const result = await processStripeEvent(paid, table, new DbBillingStore(asDb()), {});
    const log = { error: vi.fn() };
    const failing = await recordStripeReferrals(asDb(), paid, result, table, {
      enabled: async () => true,
      fingerprints: async () => {
        throw new Error("stripe down");
      },
      log,
      now: () => NOW,
    });
    expect(failing).toEqual({ steps: [], failed: true });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(await rewardRows(referrer)).toHaveLength(0);

    // Stripe delivers the event again: billing sees a duplicate, the reward lands once.
    const retry = await deliver(paid);
    expect(retry.result.duplicate).toBe(true);
    expect(retry.referral).toMatchObject([{ kind: "qualify", result: { outcome: "rewarded" } }]);
    expect(await rewardRows(referrer)).toHaveLength(1);
    expect(await rewardRows(referred)).toHaveLength(1);
  });

  it("does nothing for a payment with no open referral, and never throws", async () => {
    const lone = await workspaceWithOwner("No referral");
    const paid = await deliver(topUpCheckout(lone.ws, "cs_lone", "pi_lone"));
    expect(paid.referral).toEqual([]);

    const log = { error: vi.fn() };
    const broken = { execute: () => Promise.reject(new Error("db down")) } as unknown as Db;
    const done = await recordStripeReferrals(
      broken,
      topUpCheckout(lone.ws, "cs_broken", "pi_broken"),
      { handled: true, action: "topup_granted" },
      table,
      { log, enabled: async () => true, fingerprints },
    );
    expect(done).toEqual({ steps: [], failed: true });
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("chargeFingerprints", () => {
  it("reads the card and bank account fingerprints, and nothing from a Link payment", () => {
    expect(
      chargeFingerprints({ payment_method_details: { type: "card", card: { fingerprint: "fp1" } } } as never),
    ).toEqual(["card:fp1"]);
    expect(
      chargeFingerprints({
        payment_method_details: { type: "us_bank_account", us_bank_account: { fingerprint: "ba1" } },
      } as never),
    ).toEqual(["us_bank_account:ba1"]);
    expect(chargeFingerprints({ payment_method_details: { type: "link", link: { country: "US" } } } as never)).toEqual([]);
    expect(chargeFingerprints({ payment_method_details: null })).toEqual([]);
  });
});

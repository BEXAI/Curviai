/**
 * Referral give and get credits (docs/phases/PHASE_18.md P18-24, founder
 * decision 12) against a real schema in PGlite: codes, signups, the reward
 * on the first payment (exactly two ledger rows, once), the rejections
 * (rewards off, self referral, a reused email, a shared Stripe customer,
 * the monthly cap) and the reversal on a refund within the window.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { referralReward } from "@curvi/pipeline/seed";
import { creditLedger, events, members, referralCodes, referrals, signupGrants, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import {
  issueReferralCode,
  qualifyReferral,
  recordReferralSignup,
  referralStepKey,
  referralSummary,
  reverseReferral,
  utcMonthBounds,
} from "./service";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 11, 10, 12));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 0;

function uid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

async function workspaceWithOwner(name: string): Promise<{ ws: string; user: string }> {
  const [row] = await db.insert(workspaces).values({ name }).returning();
  const user = uid();
  await db.insert(members).values({ workspaceId: row.id, userId: user, role: "owner" });
  return { ws: row.id, user };
}

async function ledger(ws: string) {
  return (await db.select().from(creditLedger)).filter((row) => row.workspaceId === ws && row.reason === "referral");
}

async function balance(ws: string): Promise<number> {
  return (await db.select().from(creditLedger))
    .filter((row) => row.workspaceId === ws)
    .reduce((sum, row) => sum + Number(row.delta), 0);
}

async function funnel(name: string) {
  return (await db.select().from(events)).filter((row) => row.name === `funnel.${name}`);
}

const asDb = () => db as unknown as Db;

/** A referrer with a code and a referred signup with a pending referral. */
async function pendingPair(): Promise<{ referrer: string; referred: string; referredUser: string; code: string }> {
  const a = await workspaceWithOwner("Referrer");
  const b = await workspaceWithOwner("Referred");
  const { code } = await issueReferralCode(asDb(), a.ws);
  const signup = await recordReferralSignup(asDb(), { userId: b.user, code, now: NOW });
  expect(signup.outcome).toBe("pending");
  return { referrer: a.ws, referred: b.ws, referredUser: b.user, code };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("issueReferralCode", () => {
  it("issues one code per workspace, lazily, and records the link once", async () => {
    const a = await workspaceWithOwner("Codes");
    const first = await issueReferralCode(asDb(), a.ws);
    expect(first.created).toBe(true);
    expect(first.code).toMatch(/^[a-z2-7]{8}$/);
    expect(await issueReferralCode(asDb(), a.ws)).toEqual({ code: first.code, created: false });
    expect((await funnel("referral_link_created")).filter((row) => row.workspaceId === a.ws)).toHaveLength(1);
  });

  it("tries again on a code another workspace holds, and gives up after the seeded attempts", async () => {
    const a = await workspaceWithOwner("Taken");
    const b = await workspaceWithOwner("Retry");
    await db.insert(referralCodes).values({ workspaceId: a.ws, code: "takenaaa" });
    const codes = ["takenaaa", "freshbbb"];
    expect(await issueReferralCode(asDb(), b.ws, () => codes.shift() as string)).toEqual({ code: "freshbbb", created: true });
    const c = await workspaceWithOwner("Unlucky");
    await expect(issueReferralCode(asDb(), c.ws, () => "takenaaa")).rejects.toThrow(/Could not issue/);
  });
});

describe("recordReferralSignup", () => {
  it("records a pending referral once, with the referral_signup step", async () => {
    const { referrer, referred, referredUser, code } = await pendingPair();
    const [row] = (await db.select().from(referrals)).filter((r) => r.referredWorkspaceId === referred);
    expect(row).toMatchObject({ code, referrerWorkspaceId: referrer, status: "pending", rejectReason: null });
    expect(await recordReferralSignup(asDb(), { userId: referredUser, code })).toEqual({ outcome: "already_recorded" });
    const steps = (await funnel("referral_signup")).filter((r) => r.workspaceId === referred);
    expect(steps).toHaveLength(1);
    expect(steps[0].props).toMatchObject({ status: "pending" });
  });

  it("ignores an unknown code and a user with no workspace", async () => {
    const b = await workspaceWithOwner("Lost");
    expect(await recordReferralSignup(asDb(), { userId: b.user, code: "nosuchcd" })).toEqual({ outcome: "unknown_code" });
    const a = await workspaceWithOwner("Has code");
    const { code } = await issueReferralCode(asDb(), a.ws);
    expect(await recordReferralSignup(asDb(), { userId: uid(), code })).toEqual({ outcome: "no_workspace" });
  });

  it("rejects a referrer's own member and an email that already had a signup grant", async () => {
    const a = await workspaceWithOwner("Self");
    const { code } = await issueReferralCode(asDb(), a.ws);
    const self = await workspaceWithOwner("Self second workspace");
    await db.insert(members).values({ workspaceId: a.ws, userId: self.user, role: "editor" });
    expect(await recordReferralSignup(asDb(), { userId: self.user, code })).toMatchObject({
      outcome: "rejected",
      reason: "self_referral",
    });

    const withheld = await workspaceWithOwner("Second account");
    await db.insert(signupGrants).values({
      userId: withheld.user,
      workspaceId: withheld.ws,
      emailKey: "a".repeat(64),
      credits: 0,
      withheldReason: "email_already_granted",
    });
    expect(await recordReferralSignup(asDb(), { userId: withheld.user, code })).toMatchObject({
      outcome: "rejected",
      reason: "email_reused",
    });

    const earlier = await workspaceWithOwner("Earlier account");
    const again = await workspaceWithOwner("Again");
    await db.insert(signupGrants).values([
      { userId: earlier.user, workspaceId: earlier.ws, emailKey: "b".repeat(64), credits: 15 },
      { userId: again.user, workspaceId: again.ws, emailKey: "b".repeat(64), credits: 0 },
    ]);
    expect(await recordReferralSignup(asDb(), { userId: again.user, code })).toMatchObject({
      outcome: "rejected",
      reason: "email_reused",
    });

    const fresh = await workspaceWithOwner("Fresh");
    await db.insert(signupGrants).values({ userId: fresh.user, workspaceId: fresh.ws, emailKey: "c".repeat(64), credits: 15 });
    expect((await recordReferralSignup(asDb(), { userId: fresh.user, code })).outcome).toBe("pending");
  });
});

describe("qualifyReferral", () => {
  it("rewards both sides once with seeded credits that expire like top ups", async () => {
    const { referrer, referred } = await pendingPair();
    const result = await qualifyReferral(asDb(), {
      referredWorkspaceId: referred,
      paymentKey: "invoice:in_first",
      enabled: true,
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: "rewarded", referrerWorkspaceId: referrer, credits: referralReward.credits });
    const again = await qualifyReferral(asDb(), {
      referredWorkspaceId: referred,
      paymentKey: "invoice:in_second",
      enabled: true,
      now: NOW,
    });
    expect(again.outcome).toBe("settled");

    const referralId = result.outcome === "rewarded" ? result.referralId : "";
    for (const [ws, side] of [
      [referrer, "referrer"],
      [referred, "referred"],
    ] as const) {
      const rows = await ledger(ws);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        delta: referralReward.credits,
        source: "system",
        stepKey: referralStepKey(referralId, side),
      });
      // P20-05: reward credits carry no expiry.
      expect(rows[0].expiresAt).toBeNull();
    }
    const [row] = (await db.select().from(referrals)).filter((r) => r.referredWorkspaceId === referred);
    expect(row).toMatchObject({ status: "rewarded", qualifyingPayment: "invoice:in_first" });
    expect(row.qualifiedAt?.toISOString()).toBe(NOW.toISOString());
    expect((await funnel("referral_rewarded")).filter((r) => r.workspaceId === referrer)).toHaveLength(1);
    expect((await funnel("referral_qualified")).filter((r) => r.workspaceId === referred)).toHaveLength(1);
  });

  it("pays a referral whose reward did not land on an earlier delivery", async () => {
    const { referred } = await pendingPair();
    await client.query(
      "update referrals set status = 'qualified', qualified_at = $1, qualifying_payment = 'checkout:cs_1' where referred_workspace_id = $2",
      [NOW.toISOString(), referred],
    );
    const result = await qualifyReferral(asDb(), { referredWorkspaceId: referred, paymentKey: "checkout:cs_1", enabled: true, now: NOW });
    expect(result.outcome).toBe("rewarded");
    expect(await ledger(referred)).toHaveLength(1);
  });

  it("rejects while rewards are off, and writes no ledger row", async () => {
    const { referred } = await pendingPair();
    expect(
      await qualifyReferral(asDb(), { referredWorkspaceId: referred, paymentKey: "invoice:in_off", enabled: false, now: NOW }),
    ).toMatchObject({ outcome: "rejected", reason: "rewards_off" });
    expect(await ledger(referred)).toHaveLength(0);
    expect(
      await qualifyReferral(asDb(), { referredWorkspaceId: referred, paymentKey: "invoice:in_on", enabled: true, now: NOW }),
    ).toMatchObject({ outcome: "settled" });
  });

  it("rejects when both sides share a Stripe customer", async () => {
    const { referrer, referred } = await pendingPair();
    await client.query("update workspaces set stripe_customer_id = 'cus_same' where id in ($1, $2)", [referrer, referred]);
    expect(
      await qualifyReferral(asDb(), { referredWorkspaceId: referred, paymentKey: "invoice:in_same", enabled: true, now: NOW }),
    ).toMatchObject({ outcome: "rejected", reason: "same_customer", qualified: true });
    expect(await ledger(referrer)).toHaveLength(0);
  });

  it("rejects when the referrer's workspace is gone", async () => {
    const { referrer, referred } = await pendingPair();
    await client.query("delete from workspaces where id = $1", [referrer]);
    expect(
      await qualifyReferral(asDb(), { referredWorkspaceId: referred, paymentKey: "invoice:in_gone", enabled: true, now: NOW }),
    ).toMatchObject({ outcome: "rejected", reason: "referrer_gone" });
    expect(await ledger(referred)).toHaveLength(0);
  });

  it("rewards at most the seeded number per referrer per UTC month", async () => {
    const a = await workspaceWithOwner("Busy referrer");
    const { code } = await issueReferralCode(asDb(), a.ws);
    const cap = referralReward.monthlyCapPerReferrer;
    const lastMonth = new Date(utcMonthBounds(NOW).start.getTime() - DAY_MS);
    const outcomes: string[] = [];
    // One reward last month does not count toward this month.
    for (let i = 0; i <= cap + 1; i += 1) {
      const b = await workspaceWithOwner(`Referred ${i}`);
      await recordReferralSignup(asDb(), { userId: b.user, code });
      const at = i === 0 ? lastMonth : NOW;
      const result = await qualifyReferral(asDb(), { referredWorkspaceId: b.ws, paymentKey: `invoice:in_cap_${i}`, enabled: true, now: at });
      outcomes.push(result.outcome === "rejected" ? result.reason : result.outcome);
    }
    expect(outcomes.filter((o) => o === "rewarded")).toHaveLength(cap + 1);
    expect(outcomes.slice(-1)).toEqual(["monthly_cap"]);
    expect(await ledger(a.ws)).toHaveLength(cap + 1);
    expect((await referralSummary(asDb(), a.ws, NOW)).rewardedThisMonth).toBe(cap);
  });

  it("finds nothing for a workspace no one referred", async () => {
    const b = await workspaceWithOwner("Unreferred");
    expect(
      await qualifyReferral(asDb(), { referredWorkspaceId: b.ws, paymentKey: "invoice:in_none", enabled: true, now: NOW }),
    ).toEqual({ outcome: "no_referral" });
  });
});

describe("reverseReferral", () => {
  async function rewardedPair(paymentKey: string) {
    const pair = await pendingPair();
    await qualifyReferral(asDb(), { referredWorkspaceId: pair.referred, paymentKey, enabled: true, now: NOW });
    return pair;
  }

  beforeEach(() => {
    counter += 100;
  });

  it("takes both rewards back on a refund within the window, once", async () => {
    const { referrer, referred } = await rewardedPair("invoice:in_refund");
    const at = new Date(NOW.getTime() + (referralReward.clawbackDays - 1) * DAY_MS);
    const result = await reverseReferral(asDb(), { paymentKey: "invoice:in_refund", reason: "refunded", at });
    expect(result).toMatchObject({
      outcome: "reversed",
      taken: { referrer: referralReward.credits, referred: referralReward.credits },
    });
    expect(await balance(referrer)).toBe(0);
    expect(await balance(referred)).toBe(0);
    expect((await reverseReferral(asDb(), { paymentKey: "invoice:in_refund", reason: "refunded", at })).outcome).toBe("settled");
    expect(await ledger(referrer)).toHaveLength(2);
    const [row] = (await db.select().from(referrals)).filter((r) => r.referredWorkspaceId === referred);
    expect(row).toMatchObject({ status: "reversed", rejectReason: "refunded" });
  });

  it("never takes a balance below zero", async () => {
    const { referrer, referred } = await rewardedPair("checkout:cs_spent");
    await db.insert(creditLedger).values({ workspaceId: referred, delta: -45, reason: "charge", source: "system" });
    const result = await reverseReferral(asDb(), { paymentKey: "checkout:cs_spent", reason: "disputed", at: NOW });
    expect(result).toMatchObject({ outcome: "reversed", taken: { referrer: referralReward.credits, referred: 5 } });
    expect(await balance(referred)).toBe(0);
    expect(await balance(referrer)).toBe(0);
  });

  it("keeps the rewards after the window and for other payments", async () => {
    const { referrer } = await rewardedPair("invoice:in_late");
    const late = new Date(NOW.getTime() + (referralReward.clawbackDays + 1) * DAY_MS);
    expect((await reverseReferral(asDb(), { paymentKey: "invoice:in_late", reason: "refunded", at: late })).outcome).toBe("too_late");
    expect((await reverseReferral(asDb(), { paymentKey: "invoice:in_other", reason: "refunded", at: NOW })).outcome).toBe("no_referral");
    expect(await balance(referrer)).toBe(referralReward.credits);
  });

  it("rejects a referral that qualified on the refunded payment but was never paid", async () => {
    const { referred } = await pendingPair();
    await client.query(
      "update referrals set status = 'qualified', qualified_at = $1, qualifying_payment = 'invoice:in_unpaid' where referred_workspace_id = $2",
      [NOW.toISOString(), referred],
    );
    expect((await reverseReferral(asDb(), { paymentKey: "invoice:in_unpaid", reason: "refunded", at: NOW })).outcome).toBe("rejected");
    expect(
      (await qualifyReferral(asDb(), { referredWorkspaceId: referred, paymentKey: "invoice:in_next", enabled: true, now: NOW })).outcome,
    ).toBe("settled");
    expect(await ledger(referred)).toHaveLength(0);
  });
});

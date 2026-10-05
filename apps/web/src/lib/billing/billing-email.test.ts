import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renewalNotices } from "@curvi/pipeline/seed";
import { rule9Problems } from "@curvi/pipeline";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { events } from "@curvi/db/schema";
import { eq, type Db } from "@curvi/db";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import {
  activationClaimName,
  activationEmail,
  createActivationSender,
  dbEmailClaims,
  memoryEmailClaims,
  planEmail,
  planEmailClaimName,
  sendBillingEmail,
  type PlanEmailResult,
} from "./billing-email";
import { YEARLY_CANCEL_LINE } from "./renewal-terms";

// docs/phases/PHASE_20.md P20-07: the plan activation email.

function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: "in_first",
    amount_paid: 7900,
    customer_email: "buyer@example.com",
    lines: { data: [{ period: { start: 1793491200, end: 1796083200 } }] },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

const ENV: Record<string, string> = {
  RESEND_API_KEY: "re_test",
  BILLING_EMAIL_FROM: "Curvi Billing <billing@updates.curvi.ai>",
};
const readEnv = (name: string) => ENV[name];
const quiet = { warn: () => undefined, error: () => undefined };

describe("activationEmail", () => {
  it("states the plan, the charge, the cadence, the renewal date, how to cancel and how to reach us", () => {
    const email = activationEmail({ invoice: invoice(), plan: { tier: "growth", cadence: "monthly" }, siteUrl: "https://curvi.ai" })!;
    expect(email.subject).toBe("Your Curvi Growth plan is active");
    expect(email.text).toContain("Plan: Curvi Growth, billed every month");
    expect(email.text).toContain("Charged today: $79");
    expect(email.text).toContain("Next renewal: December 1, 2026");
    expect(email.text).toContain("To avoid the next charge, cancel before December 1, 2026.");
    expect(email.text).toContain("Cancel any time in Billing: https://curvi.ai/app/billing");
    expect(email.text).toContain("Questions? Reply to this email or write to support@curvi.ai.");
    expect(email.text).not.toContain("days before each renewal");
  });

  it("promises the yearly reminder window from the seed on a yearly plan", () => {
    const [earliest, latest] = renewalNotices.annualWindow;
    const email = activationEmail({ invoice: invoice({ amount_paid: 79200 }), plan: { tier: "growth", cadence: "annual" }, siteUrl: "https://curvi.ai" })!;
    expect(email.text).toContain("billed every year");
    expect(email.text).toContain(`We email you ${earliest} to ${latest} days before each renewal.`);
  });

  it("is plain, offers nothing and sells nothing that does not run", () => {
    for (const cadence of ["monthly", "annual"] as const) {
      const email = activationEmail({ invoice: invoice(), plan: { tier: "pro", cadence }, siteUrl: "https://curvi.ai" })!;
      for (const text of [email.subject, ...email.text.split("\n").filter(Boolean)]) {
        expect(rule9Problems(text), text).toEqual([]);
        expect(unqualifiedClaims(text), text).toEqual([]);
        expect(text).not.toMatch(/percent off|discount|upgrade|offer|expire/i);
      }
    }
  });

  it("states the renewal price from the seed and what canceling means (law and copy review major 1)", () => {
    const monthly = activationEmail({ invoice: invoice(), plan: { tier: "growth", cadence: "monthly" }, siteUrl: "https://curvi.ai" })!;
    expect(monthly.text).toContain("Renews at: $79 a month plus any tax that applies");
    expect(monthly.text).toContain("Your plan renews automatically every month at $79 a month plus any tax that applies, until you cancel.");
    expect(monthly.text).toContain("If you cancel, you keep your plan until the end of the month you paid for.");
    const yearly = activationEmail({ invoice: invoice({ amount_paid: 79200 }), plan: { tier: "growth", cadence: "annual" }, siteUrl: "https://curvi.ai" })!;
    expect(yearly.text).toContain("Renews at: $792 a year plus any tax that applies");
    expect(yearly.text).toContain(YEARLY_CANCEL_LINE);
  });

  it("says a discount may still apply when the invoice had one, and never names its amount", () => {
    const discounted = invoice({
      amount_paid: 1900,
      total_discount_amounts: [{ amount: 1000, discount: "di_1" }],
    } as unknown as Partial<Stripe.Invoice>);
    const email = activationEmail({ invoice: discounted, plan: { tier: "starter", cadence: "monthly" }, siteUrl: "https://curvi.ai" })!;
    expect(email.text).toContain("Charged today: $19");
    expect(email.text).toContain("Renews at: $29 a month plus any tax that applies, less any discount that still applies");
    for (const line of email.text.split("\n").filter(Boolean)) {
      expect(rule9Problems(line), line).toEqual([]);
    }
  });

  it("acknowledges a plan change with the new plan and the renewal the change set (law and copy review major 3)", () => {
    // A move to yearly starts a new year: the credit line for the old month
    // ends sooner than the new plan's line.
    const change = invoice({
      id: "in_change",
      amount_paid: 70000,
      lines: {
        data: [
          { amount: -5000, period: { start: 1793491200, end: 1796083200 } },
          { amount: 148800, period: { start: 1793491200, end: 1825027200 } },
        ],
      },
    } as unknown as Partial<Stripe.Invoice>);
    const email = planEmail({ kind: "plan_changed", invoice: change, plan: { tier: "pro", cadence: "annual" }, siteUrl: "https://curvi.ai" })!;
    expect(email.subject).toBe("Your Curvi plan is now Pro");
    expect(email.text).toContain("Your Curvi plan is now Pro, billed every year.");
    expect(email.text).toContain("Renews at: $1,488 a year plus any tax that applies");
    expect(email.text).toContain("Next renewal: November 1, 2027");
    expect(planEmailClaimName("plan_changed", "in_change")).toBe("billing:email:plan_changed:in_change");
    for (const text of [email.subject, ...email.text.split("\n").filter(Boolean)]) {
      expect(rule9Problems(text), text).toEqual([]);
      expect(text).not.toMatch(/percent off|offer|expire/i);
    }
  });

  it("is null for an invoice that names no plan", () => {
    expect(activationEmail({ invoice: invoice(), plan: { tier: null, cadence: null }, siteUrl: "https://curvi.ai" })).toBeNull();
  });
});

describe("sendBillingEmail", () => {
  it("sends from BILLING_EMAIL_FROM with replies to support, and refuses without it", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    await sendBillingEmail({ to: "a@b.co", subject: "S", text: "T", idempotencyKey: "k" }, { readEnv, send });
    expect(send).toHaveBeenCalledWith({
      from: ENV.BILLING_EMAIL_FROM,
      to: "a@b.co",
      subject: "S",
      text: "T",
      replyTo: "support@curvi.ai",
      idempotencyKey: "k",
    });
    expect(await sendBillingEmail({ to: "a@b.co", subject: "S", text: "T", idempotencyKey: "k" }, { readEnv: () => undefined, send })).toMatchObject({ ok: false });
  });
});

describe("one activation email per invoice across the webhook and a reconcile replay", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  it("sends once when both share the database claim", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const claims = dbEmailClaims(db as unknown as Db);
    const webhook = createActivationSender({ claims, readEnv, siteUrl: "https://curvi.ai", send, logger: quiet });
    const replay = createActivationSender({ claims, readEnv, siteUrl: "https://curvi.ai", send, logger: quiet });
    const plan = { tier: "growth", cadence: "monthly", credits: 600, debit: 0, billingReason: "subscription_create", base: 600, changeNew: 0, changeOld: 0 } as const;
    await webhook.planActivated(invoice(), plan);
    await webhook.planActivated(invoice(), plan);
    await replay.planActivated(invoice(), plan);
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(events).where(eq(events.name, activationClaimName("in_first")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspaceId).toBeNull();
  });

  it("never throws, and gives the claim back when the send throws", async () => {
    const claims = memoryEmailClaims();
    const sender = createActivationSender({
      claims,
      readEnv,
      siteUrl: "https://curvi.ai",
      send: async () => {
        throw new Error("network down");
      },
      logger: quiet,
    });
    const plan = { tier: "starter", cadence: "monthly", credits: 200, debit: 0, billingReason: "subscription_create", base: 200, changeNew: 0, changeOld: 0 } as const;
    await expect(sender.planActivated(invoice({ id: "in_throw" }), plan)).resolves.toBeUndefined();
    expect(claims.names.has(activationClaimName("in_throw"))).toBe(false);
  });

  it("sends the plan change acknowledgment once per invoice, apart from the activation", async () => {
    const send = vi.fn(async (_email: { subject: string; idempotencyKey?: string }) => ({ ok: true }));
    const claims = memoryEmailClaims();
    const sender = createActivationSender({ claims, readEnv, siteUrl: "https://curvi.ai", send, logger: quiet });
    const plan = { tier: "pro", cadence: "monthly", credits: 350, debit: 0, billingReason: "subscription_update", base: 0, changeNew: 650, changeOld: 300 } as const;
    await sender.planChanged!(invoice({ id: "in_up" }), plan);
    await sender.planChanged!(invoice({ id: "in_up" }), plan);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ subject: "Your Curvi plan is now Pro", idempotencyKey: "plan_changed:in_up" });
    expect(claims.names.has(planEmailClaimName("plan_changed", "in_up"))).toBe(true);
  });

  it("records each send's result for the billing_email_failing health signal (law and copy review major 4)", async () => {
    const results: PlanEmailResult[] = [];
    const recordResult = async (result: PlanEmailResult) => {
      results.push(result);
    };
    const plan = { tier: "starter", cadence: "monthly", credits: 200, debit: 0, billingReason: "subscription_create", base: 200, changeNew: 0, changeOld: 0 } as const;
    const failing = createActivationSender({
      claims: memoryEmailClaims(),
      readEnv,
      siteUrl: "https://curvi.ai",
      send: async () => ({ ok: false, notice: "Resend answered 403" }),
      logger: quiet,
      recordResult,
    });
    await failing.planActivated(invoice({ id: "in_403" }), plan);
    const working = createActivationSender({ claims: memoryEmailClaims(), readEnv, siteUrl: "https://curvi.ai", send: async () => ({ ok: true }), logger: quiet, recordResult });
    await working.planActivated(invoice({ id: "in_ok" }), plan);
    expect(results).toEqual([
      { ok: false, kind: "plan_active", invoiceId: "in_403", notice: "Resend answered 403" },
      { ok: true, kind: "plan_active", invoiceId: "in_ok" },
    ]);
  });

  it("sends nothing without a customer email", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const sender = createActivationSender({ claims: memoryEmailClaims(), readEnv, siteUrl: "https://curvi.ai", send, logger: quiet });
    const plan = { tier: "starter", cadence: "monthly", credits: 200, debit: 0, billingReason: "subscription_create", base: 200, changeNew: 0, changeOld: 0 } as const;
    await sender.planActivated(invoice({ id: "in_noemail", customer_email: null }), plan);
    expect(send).not.toHaveBeenCalled();
  });
});

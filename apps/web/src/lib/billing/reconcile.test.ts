import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tierByKey } from "@curvi/pipeline/seed";
import { creditLedger, events, platformSettings, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, type Db } from "@curvi/db";
import { readCronSuccesses } from "@/lib/cron-health";
import { DbBillingStore } from "./db-store";
import { buildPriceTable, tierPriceEnvName, topUpPriceEnvName } from "./price-table";
import {
  checkWebhookEndpoint,
  classifyOutcome,
  composeReconcileEmail,
  CREDIT_ACTIONS,
  reconcileStripe,
  type ReconcileStripeClient,
} from "./reconcile";
import { runBillingReconcile } from "./reconcile-run";
import { readBillingSignals } from "./signals";
import { STRIPE_API_VERSION } from "./stripe";
import { HANDLED_STRIPE_EVENTS, processStripeEvent, type StripeLookup } from "./stripe-webhook";

// docs/phases/PHASE_20.md P20-02: the billing reconciler replays missed
// Stripe events through the webhook handler, once, and never moves money.

const ENV: Record<string, string> = {
  [tierPriceEnvName("growth", "monthly")]: "price_growth_monthly",
  [topUpPriceEnvName(100)]: "price_topup_100",
};
const table = buildPriceTable((name) => ENV[name]);
const growth = tierByKey("growth");
const NOW = new Date("2026-10-05T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const PROD_ENV = (name: string): string | undefined => (name === "NEXT_PUBLIC_SITE_URL" ? "https://curvi.ai" : undefined);

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

beforeEach(async () => {
  await db.delete(platformSettings);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const asDb = (): Db => db as unknown as Db;

async function newWorkspace(stripeCustomerId: string | null = null): Promise<string> {
  counter += 1;
  const [row] = await db.insert(workspaces).values({ name: `Reconcile ${counter}`, stripeCustomerId }).returning();
  return row.id;
}

async function balance(workspaceId: string): Promise<number> {
  const result = await client.query<{ balance: string | number }>(
    "select coalesce(sum(delta), 0) as balance from credit_ledger where workspace_id = $1",
    [workspaceId],
  );
  return Number(result.rows[0].balance);
}

function stripeEvent(id: string, type: string, object: Record<string, unknown>, created = NOW_S - 3600): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

function invoicePaid(id: string, workspaceId: string | null, opts: { reason?: string; created?: number; customer?: string } = {}) {
  return stripeEvent(
    `evt_${id}`,
    "invoice.paid",
    {
      id,
      object: "invoice",
      customer: opts.customer ?? "cus_reconcile",
      currency: "usd",
      billing_reason: opts.reason ?? "subscription_create",
      parent: {
        type: "subscription_details",
        subscription_details: { metadata: workspaceId ? { workspaceId } : {}, subscription: `sub_${id}` },
      },
      lines: {
        data: [
          {
            id: `il_${id}`,
            amount: growth.monthlyUsd * 100,
            period: { start: NOW_S - 3600, end: NOW_S - 3600 + 30 * 86400 },
            pricing: { type: "price_details", price_details: { price: "price_growth_monthly" } },
            parent: { type: "subscription_item_details", subscription_item_details: { proration: false } },
          },
        ],
      },
    },
    opts.created,
  );
}

function topUpCompleted(id: string, workspaceId: string, created?: number) {
  return stripeEvent(
    `evt_${id}`,
    "checkout.session.completed",
    {
      id,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      customer: "cus_topup",
      client_reference_id: workspaceId,
      payment_intent: `pi_${id}`,
      metadata: { workspaceId, priceId: "price_topup_100", kind: "topup" },
    },
    created,
  );
}

function subscriptionUpdated(id: string, workspaceId: string) {
  return stripeEvent(`evt_${id}`, "customer.subscription.created", {
    id,
    object: "subscription",
    customer: "cus_sub",
    status: "active",
    metadata: { workspaceId },
    items: { data: [{ id: `si_${id}`, current_period_end: NOW_S + 30 * 86400, price: { id: "price_growth_monthly" } }] },
  });
}

interface FakeStripe extends ReconcileStripeClient {
  eventLists: Stripe.EventListParams[];
  writes: ReturnType<typeof vi.fn>;
}

/** A Stripe client over a fixed set of events, listed newest first with
 * the documented filters and paging, plus write methods that must never be
 * called. */
function fakeStripe(all: Stripe.Event[], endpoints: Partial<Stripe.WebhookEndpoint>[] = []): FakeStripe {
  const eventLists: Stripe.EventListParams[] = [];
  const writes = vi.fn();
  return {
    eventLists,
    writes,
    events: {
      async list(params: Stripe.EventListParams) {
        eventLists.push(params);
        const gte = (params.created as { gte: number }).gte;
        const matching = all
          .filter((event) => params.types?.includes(event.type) && event.created >= gte)
          .sort((a, b) => b.created - a.created);
        const start = params.starting_after ? matching.findIndex((event) => event.id === params.starting_after) + 1 : 0;
        const limit = params.limit ?? 10;
        const data = matching.slice(start, start + limit);
        return { object: "list", url: "/v1/events", data, has_more: start + limit < matching.length } as Stripe.ApiList<Stripe.Event>;
      },
    },
    webhookEndpoints: {
      async list() {
        return { object: "list", url: "/v1/webhook_endpoints", data: endpoints, has_more: false } as Stripe.ApiList<Stripe.WebhookEndpoint>;
      },
    },
    // Anything that moves money; the reconciler must never reach them.
    refunds: { create: writes },
    subscriptions: { cancel: writes, list: writes, update: writes },
  } as unknown as FakeStripe;
}

const GOOD_ENDPOINT: Partial<Stripe.WebhookEndpoint> = {
  id: "we_1",
  url: "https://curvi.ai/api/webhooks/stripe",
  status: "enabled",
  enabled_events: [...HANDLED_STRIPE_EVENTS],
  api_version: STRIPE_API_VERSION,
};

function run(stripe: FakeStripe, extra: Partial<Parameters<typeof runBillingReconcile>[0]> = {}) {
  const sendEmail = vi.fn(async (_email: { subject: string; text: string }) => ({ ok: true }));
  return {
    sendEmail,
    report: runBillingReconcile({
      db: asDb(),
      stripe,
      priceTable: table,
      siteUrl: "https://curvi.ai",
      readEnv: PROD_ENV,
      sendEmail,
      now: NOW,
      ...extra,
    }),
  };
}

describe("classifyOutcome", () => {
  it("counts only credit moves, and duplicates as already applied", () => {
    for (const action of CREDIT_ACTIONS) {
      expect(classifyOutcome({ handled: true, action, duplicate: false })).toBe("applied");
      expect(classifyOutcome({ handled: true, action })).toBe("applied");
      expect(classifyOutcome({ handled: true, action, duplicate: true })).toBe("already_applied");
    }
    for (const action of [
      "subscription_synced",
      "subscription_stale_ignored",
      "payment_failure_noted",
      "payment_action_noted",
      "invoice_noted",
      "checkout_noted",
      "topup_awaiting_payment",
      "topup_payment_failed",
      "refund_no_grant",
      "dispute_already_won",
      "dispute_inquiry_ignored",
      "dispute_closed_noted",
      "dispute_won_nothing_to_restore",
      "duplicate_subscription_refunded",
    ]) {
      expect(classifyOutcome({ handled: true, action })).toBe("ignored");
    }
    expect(classifyOutcome({ handled: false, action: "ignored" })).toBe("ignored");
  });
});

describe("runBillingReconcile on a database", () => {
  it("applies missed payments once across two runs and emails once", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const stripe = fakeStripe([topUpCompleted("cs_two_runs", a), invoicePaid("in_two_runs", b)], [GOOD_ENDPOINT]);

    const first = run(stripe);
    const report = await first.report;
    expect(report.result).toMatchObject({ scanned: 2, applied: 2, alreadyApplied: 0, failed: [] });
    expect(await balance(a)).toBe(100);
    expect(await balance(b)).toBe(growth.creditsPerMonth);
    expect(first.sendEmail).toHaveBeenCalledTimes(1);
    const email = first.sendEmail.mock.calls[0]?.[0];
    expect(email?.text).toContain("Billing check: 2 payments were missing credits. They are granted now.");

    const second = run(stripe);
    expect((await second.report).result).toMatchObject({ applied: 0, alreadyApplied: 2 });
    expect(second.sendEmail).not.toHaveBeenCalled();
    expect(await balance(a)).toBe(100);
    expect(await balance(b)).toBe(growth.creditsPerMonth);
  });

  it("grants once when the webhook and a reconcile both see the same invoice", async () => {
    const ws = await newWorkspace();
    const paid = invoicePaid("in_both", ws);
    expect(await processStripeEvent(paid, table, new DbBillingStore(asDb(), "stripe"))).toMatchObject({
      action: "cycle_credits_granted",
      duplicate: false,
    });
    const { report, sendEmail } = run(fakeStripe([paid], [GOOD_ENDPOINT]));
    expect((await report).result).toMatchObject({ applied: 0, alreadyApplied: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws));
    expect(rows).toHaveLength(1);
  });

  it("counts a replayed subscription sync or an invoice that grants nothing as nothing, and sends no email", async () => {
    const ws = await newWorkspace();
    const { report, sendEmail } = run(
      fakeStripe([subscriptionUpdated("sub_synced", ws), invoicePaid("in_manual", ws, { reason: "manual" })], [GOOD_ENDPOINT]),
    );
    expect((await report).result).toMatchObject({ scanned: 2, applied: 0, alreadyApplied: 0, ignored: 2 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await balance(ws)).toBe(0);
  });

  it("replays a subscription event with only read lookups: no refund, cancel or list is ever called", async () => {
    const ws = await newWorkspace("cus_two_live");
    const stripe = fakeStripe([subscriptionUpdated("sub_dup_new", ws)], [GOOD_ENDPOINT]);
    const retrieveSubscription = vi.fn(async (id: string) => ({
      id,
      status: "active",
      customer: "cus_two_live",
      metadata: { workspaceId: ws },
      items: { data: [{ id: "si", current_period_end: NOW_S + 86400, price: { id: "price_growth_monthly" } }] },
    }));
    const lookup = { invoiceIdForPaymentIntent: vi.fn(async () => null), retrieveSubscription } as unknown as StripeLookup;
    const { report } = run(stripe, { lookup });
    expect((await report).result.failed).toEqual([]);
    expect(retrieveSubscription).toHaveBeenCalledWith("sub_dup_new");
    expect(stripe.writes).not.toHaveBeenCalled();
    const [row] = await db.select({ plan: workspaces.plan }).from(workspaces).where(eq(workspaces.id, ws));
    expect(row.plan).toBe("growth");
  });

  it("writes nothing, records nothing and emails nobody on a dry run", async () => {
    const ws = await newWorkspace();
    const stripe = fakeStripe([invoicePaid("in_dry", ws), subscriptionUpdated("sub_dry", ws)], [GOOD_ENDPOINT]);
    const eventsBefore = (await db.select().from(events)).length;
    const { report, sendEmail } = run(stripe, { dryRun: true });
    const done = await report;
    expect(done.dryRun).toBe(true);
    expect(done.result.applied).toBe(1);
    expect(done.wouldWrite).toEqual(
      expect.arrayContaining([
        { kind: "grant", key: "invoice:in_dry", credits: growth.creditsPerMonth },
        { kind: "subscription", key: "sub_dry" },
      ]),
    );
    expect(await balance(ws)).toBe(0);
    expect((await db.select().from(events)).length).toBe(eventsBefore);
    expect(await db.select().from(platformSettings)).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(stripe.writes).not.toHaveBeenCalled();
  });

  it("records a throwing event and still applies the next one", async () => {
    const ws = await newWorkspace();
    const unroutable = invoicePaid("in_unroutable", null, { customer: "cus_nobody", created: NOW_S - 7200 });
    const { report, sendEmail } = run(fakeStripe([unroutable, invoicePaid("in_after", ws)], [GOOD_ENDPOINT]));
    const done = await report;
    expect(done.result.failed).toEqual([
      expect.objectContaining({ eventId: "evt_in_unroutable", type: "invoice.paid", code: "unroutable" }),
    ]);
    expect(done.result.applied).toBe(1);
    expect(await balance(ws)).toBe(growth.creditsPerMonth);
    const email = sendEmail.mock.calls[0]?.[0];
    expect(email?.text).toContain("1 payment was missing credits. It is granted now.");
    expect(email?.text).toContain("1 billing event could not be applied: evt_in_unroutable.");
    expect(await readCronSuccesses(asDb())).not.toHaveProperty("billing-reconcile");
  });

  it("preserves the last successful replay time after a later failure", async () => {
    const previous = new Date(NOW.getTime() - 24 * 3600_000);
    await run(fakeStripe([], [GOOD_ENDPOINT]), { now: previous }).report;
    const failed = await run(fakeStripe([
      invoicePaid("in_after_success", null, { customer: "cus_missing_after_success" }),
    ], [GOOD_ENDPOINT])).report;
    expect(failed.result.failed).toHaveLength(1);
    expect((await readBillingSignals(asDb())).reconcile).toMatchObject({ at: NOW.toISOString(), failed: 1 });
    expect(await readCronSuccesses(asDb())).toMatchObject({ "billing-reconcile": previous.toISOString() });
  });

  it("emails a failure that stays failed only once", async () => {
    const stripe = fakeStripe([invoicePaid("in_stuck", null, { customer: "cus_stuck" })], [GOOD_ENDPOINT]);
    const first = run(stripe);
    expect((await first.report).result.failed).toHaveLength(1);
    expect(first.sendEmail).toHaveBeenCalledTimes(1);
    const second = run(stripe, { now: new Date(NOW.getTime() + 30 * 60_000) });
    expect((await second.report).result.failed).toHaveLength(1);
    expect(second.sendEmail).not.toHaveBeenCalled();
    const stored = await readBillingSignals(asDb());
    expect(Object.keys(stored.reconcile?.reportedFailures ?? {})).toEqual(["evt_in_stuck"]);
  });

  it("acknowledges an event for a workspace that no longer exists", async () => {
    const gone = "00000000-0000-4000-8000-000000000123";
    const { report, sendEmail } = run(fakeStripe([invoicePaid("in_gone", gone)], [GOOD_ENDPOINT]));
    const done = await report;
    expect(done.result.failed).toEqual([]);
    expect(done.result.acknowledged).toEqual([expect.objectContaining({ eventId: "evt_in_gone", code: "workspace_gone" })]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("restores a grant whose events row and ledger row were deleted, exactly once, with one email (acceptance)", async () => {
    const ws = await newWorkspace();
    const paid = invoicePaid("in_restored", ws);
    await processStripeEvent(paid, table, new DbBillingStore(asDb(), "stripe"));
    expect(await balance(ws)).toBe(growth.creditsPerMonth);
    await db.delete(events).where(eq(events.name, "billing:stripe:invoice:in_restored"));
    await db.delete(creditLedger).where(and(eq(creditLedger.workspaceId, ws), eq(creditLedger.reason, "grant")));
    expect(await balance(ws)).toBe(0);

    const stripe = fakeStripe([paid], [GOOD_ENDPOINT]);
    const first = run(stripe);
    expect((await first.report).result.applied).toBe(1);
    expect(await balance(ws)).toBe(growth.creditsPerMonth);
    expect(first.sendEmail).toHaveBeenCalledTimes(1);
    const again = run(stripe);
    expect((await again.report).result.applied).toBe(0);
    expect(again.sendEmail).not.toHaveBeenCalled();
    expect(await balance(ws)).toBe(growth.creditsPerMonth);
  });

  it("records the run for health and the cron freshness", async () => {
    const { report } = run(fakeStripe([], [{ ...GOOD_ENDPOINT, status: "disabled" }]));
    await report;
    const stored = await readBillingSignals(asDb());
    expect(stored.reconcile).toMatchObject({ at: NOW.toISOString(), newestEventAt: null, applied: 0, failed: 0 });
    expect(stored.reconcile?.endpoint).toEqual({ ok: false, problems: ["The endpoint is disabled."] });
    expect(await readCronSuccesses(asDb())).toMatchObject({ "billing-reconcile": NOW.toISOString() });
  });
});

describe("reconcileStripe listing", () => {
  it("asks for the handled types since the lookback, in pages of 100, and processes oldest first", async () => {
    const ws = await newWorkspace();
    const many = Array.from({ length: 150 }, (_, i) =>
      invoicePaid(`in_page_${i}`, ws, { reason: "manual", created: NOW_S - 10_000 + i }),
    );
    // Older than the lookback: Stripe's created filter leaves it out.
    const old = invoicePaid("in_too_old", ws, { created: NOW_S - 100 * 3600 });
    const since = new Date(NOW.getTime() - 72 * 3600_000);
    const listed = fakeStripe([...many, old]);
    const done = await reconcileStripe({
      stripe: listed,
      store: new DbBillingStore(asDb(), "stripe"),
      priceTable: table,
      since,
      maxEvents: 1000,
    });
    expect(done.scanned).toBe(150);
    expect(done.ignored).toBe(150);
    expect(done.truncated).toBe(false);
    expect(listed.eventLists).toHaveLength(2);
    expect(listed.eventLists[0]).toMatchObject({
      types: [...HANDLED_STRIPE_EVENTS],
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
    });
    // Newest first from Stripe, so the second page starts after the 100th newest.
    expect(listed.eventLists[1]).toMatchObject({ starting_after: "evt_in_page_50", limit: 100 });
    expect(done.newestEventAt).toBe(new Date((NOW_S - 10_000 + 149) * 1000).toISOString());
    expect(await balance(ws)).toBe(0);
  });

  it("processes the oldest maxEvents and says where the next run carries on (security review 8, law and copy review 18)", async () => {
    const ws = await newWorkspace();
    const many = Array.from({ length: 150 }, (_, i) =>
      invoicePaid(`in_cap_${i}`, ws, { reason: "manual", created: NOW_S - 10_000 + i }),
    );
    const stripe = fakeStripe(many);
    const done = await reconcileStripe({
      stripe,
      store: new DbBillingStore(asDb(), "stripe"),
      priceTable: table,
      since: new Date(NOW.getTime() - 72 * 3600_000),
      maxEvents: 120,
      logger: { warn: () => undefined },
    });
    expect(done.scanned).toBe(120);
    expect(done.truncated).toBe(true);
    // The whole window was listed, newest first, then the oldest 120 run.
    expect(stripe.eventLists.map((params) => params.limit)).toEqual([100, 100]);
    expect(done.resumeFrom).toBe(new Date((NOW_S - 10_000 + 119) * 1000).toISOString());
    expect(done.newestEventAt).toBe(new Date((NOW_S - 10_000 + 149) * 1000).toISOString());
  });

  it("carries on from the last run's resume point, then goes back to the full window", async () => {
    const ws = await newWorkspace();
    // Missed grants: 3 old and 2 newer, and a cap of 3 a run.
    const missed = Array.from({ length: 5 }, (_, i) => invoicePaid(`in_resume_${i}`, ws, { created: NOW_S - 5_000 + i * 100 }));
    const stripe = fakeStripe(missed, [GOOD_ENDPOINT]);
    const policy = { lookbackHours: 72, maxEventsPerRun: 3 };
    const first = run(stripe, { policy, logger: { warn: () => undefined, info: () => undefined } });
    const firstReport = await first.report;
    expect(firstReport.result).toMatchObject({ scanned: 3, applied: 3, truncated: true });
    expect((await readBillingSignals(asDb())).reconcile).toMatchObject({
      truncated: true,
      resumeFrom: new Date((NOW_S - 5_000 + 200) * 1000).toISOString(),
    });
    expect(await readCronSuccesses(asDb())).not.toHaveProperty("billing-reconcile");

    const second = run(stripe, { policy, logger: { warn: () => undefined, info: () => undefined } });
    const secondReport = await second.report;
    // Starts at the last processed event: the newer two get their credits.
    expect(secondReport.since).toBe(new Date((NOW_S - 5_000 + 200) * 1000).toISOString());
    expect(secondReport.result).toMatchObject({ scanned: 3, applied: 2, alreadyApplied: 1, truncated: false });
    expect((await readBillingSignals(asDb())).reconcile).toMatchObject({ truncated: false, resumeFrom: null });
    expect(await readCronSuccesses(asDb())).toMatchObject({ "billing-reconcile": NOW.toISOString() });

    const third = await run(stripe, { policy, logger: { warn: () => undefined, info: () => undefined } }).report;
    expect(third.since).toBe(new Date(NOW.getTime() - 72 * 3600_000).toISOString());
  });

  it("never applies an event rendered at another API version, and reports it (security review 9)", async () => {
    const ws = await newWorkspace();
    const old = { ...invoicePaid("in_old_version", ws), api_version: "2024-06-20" } as Stripe.Event;
    const done = await reconcileStripe({
      stripe: fakeStripe([old]),
      store: new DbBillingStore(asDb(), "stripe"),
      priceTable: table,
      since: new Date(NOW.getTime() - 72 * 3600_000),
      maxEvents: 10,
    });
    expect(done.failed).toEqual([
      expect.objectContaining({ eventId: "evt_in_old_version", code: "api_version_mismatch" }),
    ]);
    expect(done.applied).toBe(0);
    expect(await balance(ws)).toBe(0);
  });

  it("runs the webhook's after steps on each replayed event and lists a failed one (PHASE_18 referrals)", async () => {
    const ws = await newWorkspace();
    const seen: Array<{ id: string; action: string; duplicate: boolean }> = [];
    const run = (failed: boolean) =>
      reconcileStripe({
        stripe: fakeStripe([invoicePaid("in_after_steps", ws)]),
        store: new DbBillingStore(asDb(), "stripe"),
        priceTable: table,
        since: new Date(NOW.getTime() - 72 * 3600_000),
        maxEvents: 10,
        afterEvent: async (event, outcome) => {
          seen.push({ id: event.id, action: outcome.action, duplicate: Boolean(outcome.duplicate) });
          return { failed };
        },
      });
    const first = await run(false);
    expect(first.applied).toBe(1);
    expect(first.failed).toEqual([]);
    // The next run sees the grant as applied, still runs the steps (they
    // are idempotent), and lists a step that failed.
    const second = await run(true);
    expect(second.alreadyApplied).toBe(1);
    expect(second.failed).toEqual([expect.objectContaining({ eventId: "evt_in_after_steps", code: "after_event_failed" })]);
    expect(seen.map((entry) => [entry.id, entry.duplicate])).toEqual([
      ["evt_in_after_steps", false],
      ["evt_in_after_steps", true],
    ]);
  });

  it("replays a grant before a refund of it when both were missed", async () => {
    const ws = await newWorkspace();
    const granted = topUpCompleted("cs_then_refund", ws, NOW_S - 7200);
    const refunded = stripeEvent(
      "evt_refund_after",
      "charge.refunded",
      { id: "ch_1", object: "charge", amount: 1500, amount_refunded: 1500, payment_intent: "pi_cs_then_refund" },
      NOW_S - 3600,
    );
    const done = await reconcileStripe({
      stripe: fakeStripe([refunded, granted]),
      store: new DbBillingStore(asDb(), "stripe"),
      priceTable: table,
      since: new Date(NOW.getTime() - 72 * 3600_000),
      maxEvents: 1000,
    });
    expect(done.appliedEvents.map((event) => event.action)).toEqual(["topup_granted", "refund_clawed_back"]);
    expect(await balance(ws)).toBe(0);
  });
});

describe("checkWebhookEndpoint", () => {
  async function check(endpoints: Partial<Stripe.WebhookEndpoint>[], readEnv = PROD_ENV) {
    return checkWebhookEndpoint(fakeStripe([], endpoints), { siteUrl: "https://curvi.ai", readEnv });
  }

  it("passes an enabled endpoint at the site URL with every handled event on the pinned version", async () => {
    expect(await check([GOOD_ENDPOINT])).toEqual({ ok: true, problems: [] });
    expect(await check([{ ...GOOD_ENDPOINT, url: "https://curvi.ai/api/webhooks/stripe/" }])).toEqual({ ok: true, problems: [] });
    expect(await check([{ ...GOOD_ENDPOINT, enabled_events: ["*"] }])).toEqual({ ok: true, problems: [] });
  });

  it("names what is wrong", async () => {
    expect(await check([])).toEqual({ ok: false, problems: ["No endpoint listens at https://curvi.ai/api/webhooks/stripe."] });
    expect(await check([{ ...GOOD_ENDPOINT, url: "https://old.example.com/api/webhooks/stripe" }])).toMatchObject({ ok: false });
    expect((await check([{ ...GOOD_ENDPOINT, status: "disabled" }])).problems).toEqual(["The endpoint is disabled."]);
    const missing = await check([{ ...GOOD_ENDPOINT, enabled_events: HANDLED_STRIPE_EVENTS.filter((t) => t !== "invoice.paid") }]);
    expect(missing.problems).toEqual(["It does not send invoice.paid."]);
    const version = await check([{ ...GOOD_ENDPOINT, api_version: null }]);
    expect(version.problems[0]).toContain(`not ${STRIPE_API_VERSION}`);
  });

  it("passes when any one endpoint at the URL is right", async () => {
    expect(await check([{ ...GOOD_ENDPOINT, id: "we_old", status: "disabled" }, GOOD_ENDPOINT])).toEqual({ ok: true, problems: [] });
  });

  it("is skipped on a local site, where the Stripe CLI forwards events", async () => {
    const local = await check([], (): string | undefined => undefined);
    expect(local.ok).toBe(true);
    expect(local.skipped).toContain("Stripe CLI");
  });
});

describe("composeReconcileEmail", () => {
  it("returns nothing when nothing moved and nothing newly failed", () => {
    expect(composeReconcileEmail({ appliedEvents: [] }, [])).toBeNull();
  });

  it("separates grants from other credit moves and writes plain copy", () => {
    const email = composeReconcileEmail(
      {
        appliedEvents: [
          { eventId: "evt_1", type: "invoice.paid", action: "cycle_credits_granted", credits: 600, workspaceId: "ws" },
          { eventId: "evt_2", type: "charge.refunded", action: "refund_clawed_back", credits: 100, workspaceId: null },
        ],
      },
      [],
    );
    expect(email?.text).toContain("Billing check: 1 payment was missing credits. It is granted now.");
    expect(email?.text).toContain("1 refund, dispute or plan change had not moved credits yet. It is applied now.");
    expect(`${email?.subject} ${email?.text}`).not.toMatch(/ [-–—] |→|->/);
  });
});

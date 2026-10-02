import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import {
  customerIdempotencyKey,
  ensureStripeCustomer,
  openTierCheckout,
  withCheckoutLock,
} from "./checkout-guard";
import { claimStripeCustomer } from "./db-store";

// The checkout side of the duplicate subscription protection, with the
// Stripe client mocked and the customer claim on a real Postgres (PGlite).

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

function asDb(value: unknown): Db {
  return value as Db;
}

async function newWorkspace(stripeCustomerId: string | null = null): Promise<string> {
  const [row] = await db.insert(workspaces).values({ name: "Guard", plan: "free", stripeCustomerId }).returning();
  return row.id;
}

async function storedCustomer(workspaceId: string): Promise<string | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  return row.stripeCustomerId ?? null;
}

interface FakeSession {
  id: string;
  mode: "subscription" | "payment";
  status: "open" | "complete" | "expired";
}

function fakeStripe(options: { subscriptions?: Array<{ id: string; status: string }>; sessions?: FakeSession[] } = {}) {
  const calls: string[] = [];
  let customers = 0;
  const sessions = [...(options.sessions ?? [])];
  const stripe = {
    customers: {
      create: vi.fn(async (_params: Stripe.CustomerCreateParams, _opts?: Stripe.RequestOptions) => {
        calls.push("customers.create");
        customers += 1;
        return { id: `cus_new_${customers}` };
      }),
    },
    subscriptions: {
      list: vi.fn(async (_params: Stripe.SubscriptionListParams, _opts?: Stripe.RequestOptions) => {
        calls.push("subscriptions.list");
        return { data: options.subscriptions ?? [] };
      }),
      retrieve: vi.fn(async () => ({ items: { data: [{ id: "si_1", price: { id: "price_starter_monthly" } }] } })),
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async (_params: unknown) => {
          calls.push("portal.create");
          return { url: "https://billing.stripe.test/portal" };
        }),
      },
    },
    checkout: {
      sessions: {
        list: vi.fn(async (params: Stripe.Checkout.SessionListParams, _opts?: Stripe.RequestOptions) => {
          calls.push("sessions.list");
          return { data: sessions.filter((session) => !params.status || session.status === params.status) };
        }),
        expire: vi.fn(async (id: string) => {
          calls.push(`sessions.expire:${id}`);
          const session = sessions.find((entry) => entry.id === id);
          if (!session || session.status !== "open") {
            throw new Error("session is not open");
          }
          session.status = "expired";
          return session;
        }),
        create: vi.fn(async (_params: Stripe.Checkout.SessionCreateParams, _opts?: Stripe.RequestOptions) => {
          calls.push("sessions.create");
          const session: FakeSession = { id: `cs_${sessions.length + 1}`, mode: "subscription", status: "open" };
          sessions.push(session);
          return { ...session, url: `https://checkout.stripe.test/${session.id}` };
        }),
      },
    },
  };
  return { stripe, asStripe: stripe as unknown as Stripe, calls, sessions };
}

const tierParams = { mode: "subscription", customer: "cus_1" } as Stripe.Checkout.SessionCreateParams;

describe("one customer per workspace", () => {
  it("returns the stored customer without calling Stripe", async () => {
    const { stripe, asStripe } = fakeStripe();
    const id = await ensureStripeCustomer(asStripe, {
      workspaceId: "ws_1",
      email: "owner@example.com",
      storedCustomerId: "cus_saved",
      claim: async (value) => value,
      reread: async () => null,
    });
    expect(id).toBe("cus_saved");
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("creates the customer with the workspace idempotency key and bounded options, then stores it", async () => {
    const ws = await newWorkspace();
    const { stripe, asStripe } = fakeStripe();
    const id = await ensureStripeCustomer(asStripe, {
      workspaceId: ws,
      email: "owner@example.com",
      storedCustomerId: null,
      claim: (value) => claimStripeCustomer(asDb(db), ws, value),
      reread: () => storedCustomer(ws),
    });
    expect(id).toBe("cus_new_1");
    expect(await storedCustomer(ws)).toBe("cus_new_1");
    const [params, opts] = stripe.customers.create.mock.calls[0] ?? [];
    expect(params).toEqual({ email: "owner@example.com", metadata: { workspaceId: ws } });
    expect(opts).toMatchObject({ idempotencyKey: `curvi-customer-${ws}`, timeout: 10_000 });
    expect(customerIdempotencyKey(ws)).toBe(`curvi-customer-${ws}`);
  });

  it("uses the customer another request stored first instead of overwriting it", async () => {
    const ws = await newWorkspace();
    // The concurrent request stored its customer between our read and our write.
    await claimStripeCustomer(asDb(db), ws, "cus_first");
    const { asStripe } = fakeStripe();
    const id = await ensureStripeCustomer(asStripe, {
      workspaceId: ws,
      email: null,
      storedCustomerId: null,
      claim: (value) => claimStripeCustomer(asDb(db), ws, value),
      reread: () => storedCustomer(ws),
    });
    expect(id).toBe("cus_first");
    expect(await storedCustomer(ws)).toBe("cus_first");
  });

  it("falls back to what is stored when Stripe refuses the create (key in use)", async () => {
    const { stripe, asStripe } = fakeStripe();
    stripe.customers.create.mockRejectedValueOnce(Object.assign(new Error("in use"), { code: "idempotency_key_in_use" }));
    await expect(
      ensureStripeCustomer(asStripe, {
        workspaceId: "ws_1",
        email: null,
        storedCustomerId: null,
        claim: async (value) => value,
        reread: async () => "cus_other_request",
      }),
    ).resolves.toBe("cus_other_request");

    stripe.customers.create.mockRejectedValueOnce(new Error("Stripe is down"));
    await expect(
      ensureStripeCustomer(asStripe, {
        workspaceId: "ws_1",
        email: null,
        storedCustomerId: null,
        claim: async (value) => value,
        reread: async () => null,
      }),
    ).rejects.toThrow("Stripe is down");
  });

  it("claimStripeCustomer only fills an empty column", async () => {
    const ws = await newWorkspace("cus_kept");
    await expect(claimStripeCustomer(asDb(db), ws, "cus_other")).resolves.toBe("cus_kept");
    expect(await storedCustomer(ws)).toBe("cus_kept");
  });
});

describe("one open tier checkout at a time", () => {
  // The plan change compares the current and the chosen price (P20-06).
  beforeEach(() => {
    vi.stubEnv("STRIPE_PRICE_STARTER_MONTHLY", "price_starter_monthly");
    vi.stubEnv("STRIPE_PRICE_GROWTH_MONTHLY", "price_growth_monthly");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const status of ["active", "trialing", "past_due", "incomplete", "unpaid"]) {
    it(`sends a customer with a ${status} subscription in Stripe to the plan change portal, before our row exists`, async () => {
      const { stripe, asStripe, calls } = fakeStripe({ subscriptions: [{ id: "sub_live", status }] });
      const result = await openTierCheckout(asStripe, {
        customerId: "cus_1",
        priceId: "price_growth_monthly",
        returnUrl: "https://curvi.ai/app/billing",
        params: tierParams,
      });
      expect(result).toMatchObject({ via: "portal", url: "https://billing.stripe.test/portal" });
      expect(stripe.subscriptions.list.mock.calls[0]?.[0]).toEqual({ customer: "cus_1", status: "all", limit: 20 });
      expect(calls).not.toContain("sessions.create");
      expect(stripe.billingPortal.sessions.create.mock.calls[0]?.[0]).toMatchObject({
        customer: "cus_1",
        flow_data: { subscription_update_confirm: { subscription: "sub_live" } },
      });
    });
  }

  it("asks a subscriber who picks a smaller plan to email us, and opens nothing (P20-06)", async () => {
    const { stripe, asStripe, calls } = fakeStripe({ subscriptions: [{ id: "sub_live", status: "active" }] });
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      items: { data: [{ id: "si_1", price: { id: "price_growth_monthly" } }] },
    });
    const result = await openTierCheckout(asStripe, {
      customerId: "cus_1",
      priceId: "price_starter_monthly",
      returnUrl: "https://curvi.ai/app/billing",
      params: tierParams,
    });
    expect(result).toMatchObject({ via: "downgrade_by_email" });
    expect(calls).not.toContain("portal.create");
    expect(calls).not.toContain("sessions.create");
  });

  it("ignores canceled and expired subscriptions", async () => {
    const { asStripe } = fakeStripe({
      subscriptions: [
        { id: "sub_old", status: "canceled" },
        { id: "sub_abandoned", status: "incomplete_expired" },
      ],
    });
    const result = await openTierCheckout(asStripe, {
      customerId: "cus_1",
      priceId: "price_growth_monthly",
      returnUrl: "https://curvi.ai/app/billing",
      params: tierParams,
    });
    expect(result.via).toBe("checkout");
  });

  it("expires every open subscription session before creating the new one, and leaves top ups alone", async () => {
    const { stripe, asStripe, calls, sessions } = fakeStripe({
      sessions: [
        { id: "cs_tab_1", mode: "subscription", status: "open" },
        { id: "cs_topup", mode: "payment", status: "open" },
        { id: "cs_done", mode: "subscription", status: "complete" },
      ],
    });
    const result = await openTierCheckout(asStripe, {
      customerId: "cus_1",
      priceId: "price_growth_monthly",
      returnUrl: "https://curvi.ai/app/billing",
      params: tierParams,
    });
    expect(result).toEqual({ via: "checkout", url: "https://checkout.stripe.test/cs_4" });
    expect(stripe.checkout.sessions.list.mock.calls[0]?.[0]).toEqual({ customer: "cus_1", status: "open", limit: 100 });
    expect(calls).toEqual(["subscriptions.list", "sessions.list", "sessions.expire:cs_tab_1", "sessions.create"]);
    expect(sessions.find((session) => session.id === "cs_tab_1")?.status).toBe("expired");
    expect(sessions.find((session) => session.id === "cs_topup")?.status).toBe("open");
    expect(stripe.checkout.sessions.create.mock.calls[0]?.[1]).toMatchObject({ timeout: 10_000 });
  });

  it("a second tab's checkout expires the first tab's session", async () => {
    const { asStripe, sessions } = fakeStripe();
    const input = { customerId: "cus_1", priceId: "price_growth_monthly", returnUrl: "https://curvi.ai/app/billing", params: tierParams };
    const first = await openTierCheckout(asStripe, input);
    const second = await openTierCheckout(asStripe, input);
    expect("url" in first && first.url).not.toBe("url" in second && second.url);
    expect(sessions.filter((session) => session.status === "open").map((session) => session.id)).toEqual(["cs_2"]);
    expect(sessions.find((session) => session.id === "cs_1")?.status).toBe("expired");
  });

  it("fails instead of opening a second session when an older one cannot be expired", async () => {
    const { stripe, asStripe } = fakeStripe({ sessions: [{ id: "cs_paid_now", mode: "subscription", status: "open" }] });
    stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error("session is complete"));
    await expect(
      openTierCheckout(asStripe, {
        customerId: "cus_1",
        priceId: "price_growth_monthly",
        returnUrl: "https://curvi.ai/app/billing",
        params: tierParams,
      }),
    ).rejects.toThrow("session is complete");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("withCheckoutLock", () => {
  it("runs without a database (demo mode) and returns the result", async () => {
    await expect(withCheckoutLock(null, "ws_1", async () => "ran")).resolves.toBe("ran");
  });

  it("takes a transaction scoped advisory lock on the workspace checkout", async () => {
    const statements: string[] = [];
    const fakeDb = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
        fn({
          execute: async (query: { queryChunks?: unknown[] }) => {
            statements.push(JSON.stringify(query));
            return [];
          },
        }),
    };
    const result = await withCheckoutLock(asDb(fakeDb), "ws_lock", async () => {
      expect(statements).toHaveLength(2);
      return "inside";
    });
    expect(result).toBe("inside");
    expect(statements[0]).toContain("lock_timeout");
    expect(statements[1]).toContain("pg_advisory_xact_lock(hashtext(");
    expect(statements[1]).toContain("checkout:ws_lock");
  });

  it("serializes two checkouts for one workspace on a real Postgres", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withCheckoutLock(asDb(db), "ws_serial", async () => {
      order.push("first start");
      await firstHolds;
      order.push("first end");
    });
    const second = withCheckoutLock(asDb(db), "ws_serial", async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second"]);
  });
});

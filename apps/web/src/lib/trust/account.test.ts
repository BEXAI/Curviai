import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelFlows,
  creditLedger,
  generationJobs,
  members,
  products,
  signupGrants,
  sourceMedia,
  subscriptions,
  termsAcceptances,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { DELETE_ACCOUNT_NOTICES, deleteAccountData } from "./account";
import { isDeleteConfirmed } from "./confirmation";
import { MemoryTrustStorage } from "./storage";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 0;

function nextUser(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(900 + counter).padStart(12, "0")}`;
}

/** A workspace owned by a fresh user, with a product, a photo, a finished
 * pack, credits, a terms record and a settled signup grant. */
async function account(storage?: MemoryTrustStorage) {
  const user = nextUser();
  const [ws] = await db.insert(workspaces).values({ name: `WS ${counter}` }).returning();
  await db.insert(members).values({ workspaceId: ws.id, userId: user, role: "owner" });
  await db.insert(signupGrants).values({ userId: user, workspaceId: ws.id, emailKey: `key-${counter}`, credits: 10 });
  const [product] = await db.insert(products).values({ workspaceId: ws.id, title: "Kettle", mode: "listing" }).returning();
  const key = `ws/${ws.id}/src/photo`;
  await db.insert(sourceMedia).values({ workspaceId: ws.id, productId: product.id, r2Key: key, sha256: "a".repeat(64) });
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: ws.id, productId: product.id, status: "done" })
    .returning();
  await db.insert(creditLedger).values([
    { workspaceId: ws.id, delta: 10, reason: "grant", source: "system" },
    { workspaceId: ws.id, delta: -2, reason: "charge", source: "system", jobId: job.id, stepKey: "s1" },
  ]);
  await db.insert(termsAcceptances).values({ userId: user, workspaceId: ws.id, version: "2026-09-28", source: "signup_callback" });
  storage?.seed(key, Buffer.from("photo"));
  storage?.seed(`ws/${ws.id}/out/${job.id}/main.jpg`, Buffer.from("output"));
  return { user, ws: ws.id, product: product.id, job: job.id };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await client.close();
});

describe("deleteAccountData", () => {
  it("deletes the owned workspace, its rows and every stored object, and leaves others alone", async () => {
    const storage = new MemoryTrustStorage();
    const me = await account(storage);
    const other = await account(storage);

    const result = await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage });
    expect(result).toEqual({ ok: true, workspacesDeleted: [me.ws], objectsDeleted: 2, objectsFailed: 0 });

    expect(await db.select().from(workspaces).where(eq(workspaces.id, me.ws))).toHaveLength(0);
    for (const table of [products, sourceMedia, generationJobs, creditLedger]) {
      expect(await db.select().from(table).where(eq(table.workspaceId, me.ws))).toHaveLength(0);
    }
    expect(await db.select().from(members).where(eq(members.userId, me.user))).toHaveLength(0);
    expect(await db.select().from(termsAcceptances).where(eq(termsAcceptances.userId, me.user))).toHaveLength(0);
    expect([...storage.objects.keys()].some((k) => k.startsWith(`ws/${me.ws}/`))).toBe(false);

    // The grant record stays, so a new signup cannot farm another grant.
    const [grant] = await db.select().from(signupGrants).where(eq(signupGrants.userId, me.user));
    expect(grant).toMatchObject({ workspaceId: null, credits: 10 });

    // The other account keeps everything.
    expect(await db.select().from(workspaces).where(eq(workspaces.id, other.ws))).toHaveLength(1);
    expect([...storage.objects.keys()].filter((k) => k.startsWith(`ws/${other.ws}/`))).toHaveLength(2);
  });

  it("refuses while a pack is running, and deletes nothing", async () => {
    const storage = new MemoryTrustStorage();
    const me = await account(storage);
    await db.insert(generationJobs).values({ workspaceId: me.ws, productId: me.product, status: "generating" });
    expect(await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage })).toEqual({
      ok: false,
      reason: "pack_running",
      notice: DELETE_ACCOUNT_NOTICES.pack_running,
    });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, me.ws))).toHaveLength(1);
    expect(storage.objects.size).toBe(2);
  });

  it("does not let an orphaned run block deletion forever", async () => {
    const me = await account();
    const [job] = await db
      .insert(generationJobs)
      .values({ workspaceId: me.ws, productId: me.product, status: "generating" })
      .returning();
    await db
      .update(generationJobs)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(generationJobs.id, job.id));
    const result = await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null });
    expect(result.ok).toBe(true);
  });

  it("refuses while a paid plan is open", async () => {
    const me = await account();
    await db.insert(subscriptions).values({ workspaceId: me.ws, provider: "stripe", status: "active", tier: "growth" });
    expect(await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null })).toMatchObject({
      ok: false,
      reason: "subscription_open",
    });
  });

  describe("a plan the seller already set to end", () => {
    function fakeStripe(live: Record<string, unknown> | "missing") {
      const retrieve = vi.fn(async () => {
        if (live === "missing") {
          throw Object.assign(new Error("No such subscription"), { statusCode: 404, code: "resource_missing" });
        }
        return { id: "sub_live", status: "active", cancel_at_period_end: false, cancel_at: null, ...live };
      });
      const cancel = vi.fn(async () => ({ id: "sub_live", status: "canceled" }));
      return { stripe: { subscriptions: { retrieve, cancel } } as unknown as Stripe, retrieve, cancel };
    }

    async function subscribed() {
      const me = await account();
      await db
        .insert(subscriptions)
        .values({ workspaceId: me.ws, provider: "stripe", externalId: "sub_live", status: "active", tier: "growth" });
      return me;
    }

    it("deletes the account and ends the subscription in Stripe at once", async () => {
      const me = await subscribed();
      const fake = fakeStripe({ cancel_at_period_end: true });
      const result = await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null, stripe: fake.stripe });
      expect(result.ok).toBe(true);
      expect(fake.retrieve).toHaveBeenCalledWith("sub_live", {}, expect.objectContaining({ timeout: expect.any(Number) }));
      expect(fake.cancel).toHaveBeenCalledWith(
        "sub_live",
        expect.objectContaining({ prorate: false, invoice_now: false }),
        expect.anything(),
      );
      expect(await db.select().from(workspaces).where(eq(workspaces.id, me.ws))).toEqual([]);
    });

    it("treats a portal cancel_at date as set to end", async () => {
      const me = await subscribed();
      const fake = fakeStripe({ cancel_at: 1_790_000_000 });
      expect((await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null, stripe: fake.stripe })).ok).toBe(true);
      expect(fake.cancel).toHaveBeenCalledTimes(1);
    });

    it("still refuses when Stripe says the plan renews", async () => {
      const me = await subscribed();
      const fake = fakeStripe({});
      expect(
        await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null, stripe: fake.stripe }),
      ).toMatchObject({ ok: false, reason: "subscription_open" });
      expect(fake.cancel).not.toHaveBeenCalled();
      expect(await db.select().from(workspaces).where(eq(workspaces.id, me.ws))).toHaveLength(1);
    });

    it("does not block on a subscription Stripe no longer has, and cancels nothing", async () => {
      const me = await subscribed();
      const fake = fakeStripe("missing");
      expect((await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null, stripe: fake.stripe })).ok).toBe(true);
      expect(fake.cancel).not.toHaveBeenCalled();
    });

    it("keeps the deletion when the Stripe cancel fails, since the plan ends on its own", async () => {
      const me = await subscribed();
      const fake = fakeStripe({ cancel_at_period_end: true });
      fake.cancel.mockRejectedValueOnce(new Error("network down"));
      expect((await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null, stripe: fake.stripe })).ok).toBe(true);
    });

    it("without Stripe keys, goes by the cancel flow's record of a cancellation Stripe accepted", async () => {
      const me = await subscribed();
      const now = new Date("2026-09-28T12:00:00Z");
      expect(
        await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null, stripe: null, now }),
      ).toMatchObject({ ok: false, reason: "subscription_open" });
      await db.insert(cancelFlows).values({
        workspaceId: me.ws,
        reason: "too_expensive",
        outcome: "canceled",
        stripeApplied: true,
        stripeSubscriptionId: "sub_live",
        effectiveAt: new Date("2026-10-15T00:00:00Z"),
      });
      expect((await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null, stripe: null, now })).ok).toBe(
        true,
      );
    });
  });

  it("allows deletion once the plan is canceled", async () => {
    const me = await account();
    await db.insert(subscriptions).values({ workspaceId: me.ws, provider: "stripe", status: "canceled", tier: "growth" });
    expect((await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null })).ok).toBe(true);
  });

  it("refuses when the owned workspace has other members", async () => {
    const me = await account();
    await db.insert(members).values({ workspaceId: me.ws, userId: nextUser(), role: "editor" });
    expect(await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage: null })).toMatchObject({
      ok: false,
      reason: "shared_workspace",
    });
  });

  it("removes only the seat of a member who does not own the workspace", async () => {
    const owner = await account();
    const editor = nextUser();
    await db.insert(members).values({ workspaceId: owner.ws, userId: editor, role: "editor" });
    const result = await deleteAccountData({ db: db as unknown as Db, userId: editor, storage: null });
    expect(result).toMatchObject({ ok: true, workspacesDeleted: [] });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, owner.ws))).toHaveLength(1);
    expect(await db.select().from(members).where(eq(members.workspaceId, owner.ws))).toHaveLength(1);
  });

  it("reports objects it could not delete without undoing the deletion", async () => {
    const storage = new MemoryTrustStorage();
    const me = await account(storage);
    storage.failDeletes.add(`ws/${me.ws}/src/photo`);
    const result = await deleteAccountData({ db: db as unknown as Db, userId: me.user, storage });
    expect(result).toMatchObject({ ok: true, objectsDeleted: 1, objectsFailed: 1 });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, me.ws))).toHaveLength(0);
  });
});

describe("isDeleteConfirmed", () => {
  it("needs the word typed out", () => {
    expect(isDeleteConfirmed("DELETE")).toBe(true);
    expect(isDeleteConfirmed(" delete ")).toBe(true);
    expect(isDeleteConfirmed("")).toBe(false);
    expect(isDeleteConfirmed("yes")).toBe(false);
    expect(isDeleteConfirmed(undefined)).toBe(false);
  });
});

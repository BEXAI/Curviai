import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assets, brandKits, creditLedger, generationJobs, members, products, retiredSourceObjects, shareLinks, sourceMedia, workspaces, eq, loadChannelSpecs, type Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { creditCosts } from "@curvi/pipeline/seed";
import type { Shot } from "@curvi/pipeline/schemas";
import { DbService } from "@/lib/services/db";
import type { CreateJobInput } from "@/lib/services/types";
import { purgeStaleSourceMedia } from "./purge";
import { MemoryTrustStorage } from "./storage";

const enqueue = vi.hoisted(() => vi.fn(async () => "inline"));
const followUp = vi.hoisted(() => vi.fn(async () => "inline"));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: enqueue, enqueuePackFollowUp: followUp }));
let client: Awaited<ReturnType<typeof createTestDb>>["client"], db: TestDb;
const now = new Date();
const old = new Date(now.getTime() - 60 * 86400000);
beforeAll(async () => { ({ client, db } = await createTestDb()); await loadChannelSpecs(db as unknown as Db); });
afterAll(async () => { await client.close(); });
beforeEach(() => { enqueue.mockClear(); followUp.mockClear(); });
const ownerDb = () => db as unknown as Db;

async function fixture() {
  const userId = randomUUID();
  const [workspace] = await db.insert(workspaces).values({ name: "Retention", plan: "growth" }).returning();
  const [product] = await db.insert(products).values({ workspaceId: workspace.id, title: "Mug", mode: "listing" }).returning();
  await db.insert(members).values({ workspaceId: workspace.id, userId, role: "owner" });
  await db.insert(creditLedger).values({ workspaceId: workspace.id, delta: 200, reason: "grant", source: "system" });
  const key = `ws/${workspace.id}/src/photo`;
  const [source] = await db.insert(sourceMedia).values({ workspaceId: workspace.id, productId: product.id, r2Key: key, kind: "image", sha256: "a".repeat(64), createdAt: old }).returning();
  const storage = new MemoryTrustStorage();
  storage.seed(key, Buffer.from("photo"), old);
  const service = (database = ownerDb()) => new DbService({
    db: database, getUserId: async () => userId, getSupabase: async () => null,
    ingestUpload: null, sourceObjectExists: async (key) => (await storage.head(key)) !== null,
    providerVerdict: async () => "ok",
  });
  const create = (database = ownerDb()) => service(database).createJob(workspace.id, {
    productId: product.id, channels: ["amazon.main"], mode: "listing", idempotencyKey: randomUUID(),
  });
  return { workspace, product, source, key, storage, service, create };
}

/** Deterministic interleaving immediately before the writer's first transaction.
 * PGlite is single-connection; the separate PG suite proves lock contention. */
function beforeTransaction(action: () => Promise<void>): Db {
  let first = true;
  return new Proxy(ownerDb(), { get(target, prop, receiver) {
    if (prop === "transaction") return async (callback: Parameters<Db["transaction"]>[0]) => {
      if (first) { first = false; await action(); }
      return target.transaction(callback);
    };
    return Reflect.get(target, prop, receiver);
  } });
}

describe("source retention acceptance interleavings", () => {
  it("refuses a preloaded product photo when purge wins before createJob locks, without credits or enqueue", async () => {
    const f = await fixture();
    const result = await f.create(beforeTransaction(async () => {
      expect((await purgeStaleSourceMedia({ db: ownerDb(), storage: f.storage, now, maxOrphanObjects: 0 })).rowsDeleted).toBeGreaterThan(0);
    }));
    expect(result).toMatchObject({ outcome: "rejected", reason: "invalid_upload" });
    expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspace.id))).toEqual([]);
    expect((await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, f.workspace.id))).map((row) => row.reason)).toEqual(["grant"]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rechecks a stale purge candidate after a new pack commits", async () => {
    const f = await fixture();
    let selected = false;
    const database = new Proxy(ownerDb(), { get(target, prop, receiver) {
      if (prop === "execute") return async (query: Parameters<Db["execute"]>[0]) => {
        const result = await target.execute(query);
        if (!selected) { selected = true; expect(await f.create()).toMatchObject({ outcome: "created" }); }
        return result;
      };
      return Reflect.get(target, prop, receiver);
    } });
    const report = await purgeStaleSourceMedia({ db: database, storage: f.storage, now, maxOrphanObjects: 0 });
    expect(report.rowsMatched).toBeGreaterThan(0);
    expect(f.storage.objects.has(f.key)).toBe(true);
    expect(await db.select().from(sourceMedia).where(eq(sourceMedia.id, f.source.id))).toHaveLength(1);
    expect(await db.select().from(retiredSourceObjects).where(eq(retiredSourceObjects.workspaceId, f.workspace.id))).toEqual([]);
  });

  it("refuses borrowing another product's registered upload key for a new pack", async () => {
    const f = await fixture();
    expect(await f.service().createJob(f.workspace.id, {
      productId: "new", channels: ["amazon.main"], mode: "listing", idempotencyKey: randomUUID(),
      uploads: [{ key: f.key, kind: "image", sha256: "a".repeat(64) }],
    })).toMatchObject({ outcome: "rejected", reason: "invalid_upload" });
    expect(await db.select().from(products).where(eq(products.workspaceId, f.workspace.id))).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses registration and logo acceptance while a retired object's deletion is still failing", async () => {
    const f = await fixture();
    const logo = `ws/${f.workspace.id}/src/logo`;
    f.storage.seed(logo, Buffer.from("logo"), old);
    f.storage.failDeletes.add(f.key);
    f.storage.failDeletes.add(logo);
    await purgeStaleSourceMedia({ db: ownerDb(), storage: f.storage, now });
    expect(f.storage.objects.has(f.key)).toBe(true);
    expect(await f.service().registerSourceMedia(f.workspace.id, { productId: f.product.id, r2Key: f.key, sha256: "a".repeat(64), kind: "image", bytes: 5 })).toMatchObject({ ok: false, reason: "invalid_upload" });
    expect(await f.service().saveBrandKit(f.workspace.id, { name: "Mug", colors: ["#ffffff"], fonts: { heading: "inter", body: "inter" }, stylePreset: "minimal_studio", hasLogo: true, logoKey: logo })).toMatchObject({ ok: false, notice: "The original photo is no longer available. Upload it again to continue." });
    expect(await db.select().from(brandKits).where(eq(brandKits.workspaceId, f.workspace.id))).toEqual([]);
  });

  it("refuses a missing object even if its source row remains from a legacy partial delete", async () => {
    const f = await fixture();
    f.storage.objects.delete(f.key);
    expect(await f.create()).toMatchObject({ outcome: "rejected", reason: "invalid_upload" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

async function browserRequestAtQueue(f: Awaited<ReturnType<typeof fixture>>) {
  const key = `ws/${f.workspace.id}/src/browser.jpg`;
  f.storage.seed(key, Buffer.from("browser photo"));
  const input: CreateJobInput = { productId: "new", channels: ["amazon.main"], mode: "listing", idempotencyKey: randomUUID(),
    uploads: [{ key, kind: "image", sha256: "b".repeat(64) }] };
  let entered!: () => void, refuse!: (error: Error) => void;
  const atQueue = new Promise<void>((resolve) => { entered = resolve; });
  const reply = new Promise<never>((_, reject) => { refuse = reject; });
  enqueue.mockImplementationOnce(async () => { entered(); return reply; });
  const first = f.service().createJob(f.workspace.id, input);
  await atQueue;
  const [source] = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
  return { key, input, source, first, refuse };
}

describe("abandoned browser source ownership", () => {
  it.each(["brand", "share", "mask alias", "legacy image", "legacy shot", "legacy logo"] as const)("preserves a committed %s reference when enqueue fails", async (reference) => {
    const f = await fixture(), a = await browserRequestAtQueue(f), workspaceId = f.workspace.id;
    if (reference === "brand") await db.insert(brandKits).values({ workspaceId, logoR2Key: a.key });
    else if (reference === "share") await db.insert(shareLinks).values({ workspaceId, slug: randomUUID(), beforeMediaId: a.source.id });
    else if (reference === "mask alias") await db.update(sourceMedia).set({ maskR2Key: a.key }).where(eq(sourceMedia.id, f.source.id));
    else await db.insert(generationJobs).values({ workspaceId, productId: f.product.id, status: "done", restartPayload:
      reference === "legacy image" ? { images: [{ mediaId: a.key }] }
        : reference === "legacy shot" ? { shots: [{ sourceMediaId: a.key }] } : { brand: { logoKey: a.key } } });
    a.refuse(new Error("Delayed enqueue failure"));
    expect(await a.first).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    expect(await db.select().from(sourceMedia).where(eq(sourceMedia.id, a.source.id))).toHaveLength(1);
  });

  it("keeps a source accepted by a second pack and usable by that pack's later follow-up", async () => {
    const f = await fixture(), a = await browserRequestAtQueue(f);
    const second = await f.service().createJob(f.workspace.id, {
      productId: a.source.productId, channels: ["amazon.main"], mode: "listing", idempotencyKey: randomUUID(),
    });
    expect(second.outcome).toBe("created");
    if (second.outcome !== "created") throw new Error("Second pack was refused");
    a.refuse(new Error("Delayed enqueue failure"));
    expect(await a.first).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    expect(await db.select().from(sourceMedia).where(eq(sourceMedia.id, a.source.id))).toHaveLength(1);
    expect(f.storage.objects.has(a.key)).toBe(true);

    await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, second.job.id));
    const shot: Shot = { id: "s01_amazon_main", type: "amazon_main", sourceMediaId: a.key,
      method: "deterministic", channels: ["amazon.main"], stylePreset: "none", credits: creditCosts.deterministic, priority: 1 };
    await db.insert(assets).values({ workspaceId: f.workspace.id, jobId: second.job.id, shotType: shot.type,
      approved: false, qc: { shotId: shot.id, status: "needs_review", pass: false, credits: shot.credits, shot,
        sourceSelection: { version: 1, basis: "first_run", sourceMediaId: shot.sourceMediaId, target: null, exclude: [], otherItems: false } } });
    expect(await f.service().retryShot(f.workspace.id, second.job.id, shot.id)).toMatchObject({ outcome: "started" });
    expect(followUp).toHaveBeenCalledOnce();

    // The refused first form must not reparent a key another pack now owns.
    expect(await f.service().createJob(f.workspace.id, a.input)).toMatchObject({ outcome: "rejected", reason: "invalid_upload" });
    expect((await db.select().from(sourceMedia).where(eq(sourceMedia.id, a.source.id)))[0].productId).toBe(second.job.productId);
  });

  it("revalidates a preloaded source when cleanup wins first and keeps an unshared browser retry working", async () => {
    const f = await fixture(), a = await browserRequestAtQueue(f);
    const result = await f.service(beforeTransaction(async () => {
      a.refuse(new Error("Enqueue failed before the other acceptance"));
      expect(await a.first).toMatchObject({ outcome: "rejected", reason: "unavailable" });
      expect(await db.select().from(sourceMedia).where(eq(sourceMedia.id, a.source.id))).toHaveLength(0);
    })).createJob(f.workspace.id, {
      productId: a.source.productId, channels: ["amazon.main"], mode: "listing", idempotencyKey: randomUUID(),
    });
    expect(result).toMatchObject({ outcome: "rejected", reason: "invalid_upload" });
    expect(enqueue).toHaveBeenCalledOnce();
    const retry = await f.service().createJob(f.workspace.id, a.input);
    expect(retry.outcome).toBe("created");
    if (retry.outcome !== "created") throw new Error("Unshared browser retry was refused");
    expect(retry.job.productId).not.toBe(a.source.productId);
    expect((await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, a.key)))[0].productId).toBe(retry.job.productId);
  });
});

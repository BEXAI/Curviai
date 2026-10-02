import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { brandKits, generationJobs, platformSettings, products, retiredSourceObjects, shareLinks, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { ORPHAN_CURSOR_KEY, purgeCutoff, purgeStaleSourceMedia } from "./purge";
import { MemoryTrustStorage } from "./storage";

const NOW = new Date("2026-09-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let storage: MemoryTrustStorage;
let ws: string;
let counter = 0;

async function product(): Promise<string> {
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  return p.id;
}

/** A source photo (and its object) created `age` days ago. */
async function photo(productId: string, age: number, withMask = false): Promise<{ id: string; key: string; mask: string }> {
  counter += 1;
  const key = `ws/${ws}/src/photo-${counter}`;
  const mask = `ws/${ws}/src/mask-${counter}`;
  const [row] = await db
    .insert(sourceMedia)
    .values({
      workspaceId: ws,
      productId,
      r2Key: key,
      sha256: "b".repeat(64),
      maskR2Key: withMask ? mask : null,
      createdAt: daysAgo(age),
    })
    .returning();
  storage.seed(key, Buffer.from("photo"), daysAgo(age));
  if (withMask) {
    storage.seed(mask, Buffer.from("mask"), daysAgo(age));
  }
  return { id: row.id, key, mask };
}

async function pack(productId: string, age: number, status: "done" | "generating" = "done"): Promise<void> {
  await db.insert(generationJobs).values({ workspaceId: ws, productId, status, createdAt: daysAgo(age), updatedAt: NOW });
}

async function rowExists(id: string): Promise<boolean> {
  return (await db.select().from(sourceMedia).where(eq(sourceMedia.id, id))).length > 0;
}

function run(dryRun = false) {
  return purgeStaleSourceMedia({ db: db as unknown as Db, storage, now: NOW, dryRun });
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

beforeEach(async () => {
  storage = new MemoryTrustStorage();
  const [w] = await db.insert(workspaces).values({ name: `Purge ${counter}` }).returning();
  ws = w.id;
});

afterAll(async () => {
  await client.close();
});

describe("purgeStaleSourceMedia", () => {
  it("uses a 30 day cutoff", () => {
    expect(purgeCutoff(NOW).toISOString()).toBe("2026-08-29T12:00:00.000Z");
  });

  it("deletes an old photo, its mask and its row when no recent pack used the product", async () => {
    const p = await product();
    await pack(p, 45);
    const old = await photo(p, 40, true);
    const report = await run();
    expect(report).toMatchObject({ rowsMatched: 1, rowsDeleted: 1, objectsDeleted: 2, objectsFailed: 0 });
    expect(await rowExists(old.id)).toBe(false);
    expect(storage.objects.has(old.key)).toBe(false);
    expect(storage.objects.has(old.mask)).toBe(false);
  });

  it("keeps an old photo whose product had a pack in the last 30 days", async () => {
    const p = await product();
    const old = await photo(p, 40);
    await pack(p, 5);
    await run();
    expect(await rowExists(old.id)).toBe(true);
    expect(storage.objects.has(old.key)).toBe(true);
  });

  it("keeps an old source after a recent followup run of an old pack", async () => {
    const p = await product();
    const old = await photo(p, 60);
    await db.insert(generationJobs).values({ workspaceId: ws, productId: p, status: "done", createdAt: daysAgo(60), startedAt: daysAgo(1), updatedAt: NOW });
    await run();
    expect(await rowExists(old.id)).toBe(true);
    expect(storage.objects.has(old.key)).toBe(true);
  });

  it("keeps photos of a product with a pack still running, however old", async () => {
    const p = await product();
    const old = await photo(p, 90);
    await pack(p, 60, "generating");
    await run();
    expect(await rowExists(old.id)).toBe(true);
  });

  it("keeps a photo a share link shows as its before image", async () => {
    const p = await product();
    const old = await photo(p, 40);
    await db.insert(shareLinks).values({ slug: `share-${counter}`, workspaceId: ws, beforeMediaId: old.id });
    await run();
    expect(await rowExists(old.id)).toBe(true);
  });

  it("keeps legacy source keys referenced by active payloads from another product", async () => {
    const original = await product();
    const used = await photo(original, 60);
    const other = await product();
    await db.insert(generationJobs).values({ workspaceId: ws, productId: other, status: "queued", restartPayload: { images: [{ mediaId: used.key }] } });
    await run();
    expect(storage.objects.has(used.key)).toBe(true);
    expect(await rowExists(used.id)).toBe(true);
    const orphan = `ws/${ws}/src/legacy-followup`;
    storage.seed(orphan, Buffer.from("followup"), daysAgo(60));
    await db.insert(generationJobs).values({ workspaceId: ws, productId: other, status: "generating", restartPayload: { shots: [{ sourceMediaId: orphan }] } });
    await run();
    expect(storage.objects.has(orphan)).toBe(true);
    expect(await db.select().from(retiredSourceObjects).where(eq(retiredSourceObjects.workspaceId, ws))).toEqual([]);
  });

  it("rechecks row removal when a shared original gains a share after retirement planning", async () => {
    const p = await product();
    const stale = await photo(p, 60, true);
    const other = await product();
    await db.insert(sourceMedia).values({ workspaceId: ws, productId: other, r2Key: `ws/${ws}/src/other`, maskR2Key: stale.key, kind: "image", sha256: "a".repeat(64) });
    const remove = storage.deleteMany.bind(storage);
    storage.deleteMany = async (keys) => {
      // Retirement committed, and this original was kept because another
      // row uses it as a mask. A new share legitimately gains that reference.
      await db.insert(shareLinks).values({ slug: `race-share-${counter}`, workspaceId: ws, beforeMediaId: stale.id }).onConflictDoNothing();
      return remove(keys);
    };
    await purgeStaleSourceMedia({ db: db as unknown as Db, storage, now: NOW, maxOrphanObjects: 0 });
    expect(await rowExists(stale.id)).toBe(true);
    expect(storage.objects.has(stale.key)).toBe(true);
    expect((await db.select().from(shareLinks).where(eq(shareLinks.beforeMediaId, stale.id)))).toHaveLength(1);
  });

  it("keeps a source used as the brand logo or an active run's snapshotted logo", async () => {
    const p = await product();
    const logo = await photo(p, 70);
    await db.insert(brandKits).values({ workspaceId: ws, logoR2Key: logo.key });
    await run();
    expect(storage.objects.has(logo.key)).toBe(true);
    await db.delete(brandKits).where(eq(brandKits.workspaceId, ws));
    const other = await product();
    await db.insert(generationJobs).values({ workspaceId: ws, productId: other, status: "generating", restartPayload: { brand: { logoKey: logo.key } } });
    await run();
    expect(storage.objects.has(logo.key)).toBe(true);
    expect(await rowExists(logo.id)).toBe(true);
  });

  it("retries retired sources even after another photo of the product gets a new pack", async () => {
    const p = await product();
    const old = await photo(p, 60, true);
    storage.failDeletes.add(old.key);
    storage.failDeletes.add(old.mask);
    await run();
    const fresh = await photo(p, 1);
    await pack(p, 0, "generating");
    storage.failDeletes.clear();
    const report = await run();
    expect(report.rowsDeleted).toBeGreaterThan(0);
    expect(await rowExists(old.id)).toBe(false);
    expect(storage.objects.has(old.key)).toBe(false);
    expect(storage.objects.has(old.mask)).toBe(false);
    expect(await rowExists(fresh.id)).toBe(true);
    expect(storage.objects.has(fresh.key)).toBe(true);
  });

  it("keeps a shared mask while deleting the stale row's own photo", async () => {
    const p = await product();
    const stale = await photo(p, 60, true);
    const other = await product();
    await db.insert(sourceMedia).values({ workspaceId: ws, productId: other, r2Key: stale.mask, kind: "image", sha256: "a".repeat(64), createdAt: NOW });
    await run();
    expect(await rowExists(stale.id)).toBe(false);
    expect(storage.objects.has(stale.key)).toBe(false);
    expect(storage.objects.has(stale.mask)).toBe(true);
    expect(await db.select().from(retiredSourceObjects).where(eq(retiredSourceObjects.r2Key, stale.mask))).toEqual([]);
  });

  it("keeps retirement durable and removes a copy that finishes after a successful delete", async () => {
    const key = `ws/${ws}/src/copy-finishes-late`;
    storage.seed(key, Buffer.from("old copy"), daysAgo(40));
    await run();
    expect(storage.objects.has(key)).toBe(false);
    expect(await db.select().from(retiredSourceObjects).where(eq(retiredSourceObjects.r2Key, key))).toHaveLength(1);
    storage.seed(key, Buffer.from("late copy"), NOW);
    expect((await run()).orphansDeleted).toBe(1);
    expect(storage.objects.has(key)).toBe(false);
    expect(await db.select().from(retiredSourceObjects).where(eq(retiredSourceObjects.r2Key, key))).toHaveLength(1);
  });

  it("keeps photos younger than 30 days", async () => {
    const p = await product();
    const young = await photo(p, 29);
    await run();
    expect(await rowExists(young.id)).toBe(true);
  });

  it("deletes nothing on a dry run but reports the match", async () => {
    const p = await product();
    const old = await photo(p, 40);
    const report = await run(true);
    expect(report).toMatchObject({ dryRun: true, rowsDeleted: 0, objectsDeleted: 0 });
    expect(report.rowsMatched).toBeGreaterThanOrEqual(1);
    expect(await rowExists(old.id)).toBe(true);
    expect(storage.objects.has(old.key)).toBe(true);
  });

  it("keeps the row when its object could not be deleted, so the next run retries", async () => {
    const p = await product();
    const old = await photo(p, 40);
    storage.failDeletes.add(old.key);
    const report = await run();
    expect(report.objectsFailed).toBe(1);
    expect(await rowExists(old.id)).toBe(true);
  });

  it("sweeps old orphan uploads, but never logos, referenced photos, young files or outputs", async () => {
    const p = await product();
    const referenced = await photo(p, 10);
    await db.insert(brandKits).values({ workspaceId: ws, logoR2Key: `ws/${ws}/src/logo` });
    storage.seed(`ws/${ws}/src/logo`, Buffer.from("logo"), daysAgo(100));
    storage.seed(`ws/${ws}/src/abandoned`, Buffer.from("x"), daysAgo(40));
    storage.seed(`ws/${ws}/src/fresh`, Buffer.from("x"), daysAgo(2));
    storage.seed(`ws/${ws}/out/job/main.jpg`, Buffer.from("x"), daysAgo(100));
    const report = await run();
    expect(report.orphansDeleted).toBe(1);
    expect(storage.objects.has(`ws/${ws}/src/abandoned`)).toBe(false);
    for (const kept of [`ws/${ws}/src/logo`, `ws/${ws}/src/fresh`, `ws/${ws}/out/job/main.jpg`, referenced.key]) {
      expect(storage.objects.has(kept), kept).toBe(true);
    }
  });
});

describe("the orphan sweep cursor", () => {
  beforeEach(async () => {
    await db.delete(platformSettings).where(eq(platformSettings.key, ORPHAN_CURSOR_KEY));
  });

  const sweep = (budget = 2, dryRun = false) =>
    purgeStaleSourceMedia({ db: db as unknown as Db, storage, now: NOW, dryRun, maxOrphanObjects: budget });
  const cursor = async () =>
    (await db.select().from(platformSettings).where(eq(platformSettings.key, ORPHAN_CURSOR_KEY)))[0]?.value;

  it("continues inside a protected prefix larger than the budget, then reaches the next workspace", async () => {
    const a = "ffffffff-ffff-4fff-8fff-00000000000a";
    const b = "ffffffff-ffff-4fff-8fff-00000000000b";
    await db.insert(workspaces).values([{ id: a, name: "Busy" }, { id: b, name: "Quiet" }]);
    // These files stay on every pass. Resuming only by workspace always
    // re-lists them and never reaches the orphan at the end of this prefix.
    for (let i = 0; i < 5; i++) storage.seed(`ws/${a}/src/a-${i}`, Buffer.from("x"), daysAgo(2));
    storage.seed(`ws/${a}/src/z-orphan`, Buffer.from("x"), daysAgo(40));
    storage.seed(`ws/${b}/src/orphan`, Buffer.from("x"), daysAgo(40));
    expect((await sweep()).orphansDeleted).toBe(0);
    const first = await cursor();
    expect(first).toMatchObject({ workspaceId: a, inProgress: true });
    await sweep(2, true);
    expect(await cursor()).toEqual(first);
    expect((await sweep()).orphansDeleted).toBe(0);
    expect((await sweep()).orphansDeleted).toBe(1);
    expect(storage.objects.has(`ws/${a}/src/z-orphan`)).toBe(false);
    expect((await sweep()).orphansDeleted).toBe(1);
    expect(storage.objects.has(`ws/${b}/src/orphan`)).toBe(false);
    for (let i = 0; i < 5; i++) expect(storage.objects.has(`ws/${a}/src/a-${i}`)).toBe(true);
  });

  it("retries the failed page even after other objects on it were deleted", async () => {
    const prefix = `ws/${ws}/src/`;
    storage.seed(`${prefix}a`, Buffer.from("x"), daysAgo(40));
    storage.seed(`${prefix}b`, Buffer.from("x"), daysAgo(40));
    storage.seed(`${prefix}c`, Buffer.from("x"), daysAgo(40));
    storage.failDeletes.add(`${prefix}b`);
    expect((await sweep()).orphansDeleted).toBe(1);
    expect(await cursor()).toMatchObject({ workspaceId: ws, inProgress: true, continuationToken: null });
    storage.failDeletes.clear();
    expect((await sweep()).orphansDeleted).toBe(2);
    expect(storage.objects.size).toBe(0);
  });

  it("retains a noninitial page token after failed deletion", async () => {
    const prefix = `ws/${ws}/src/`;
    storage.seed(`${prefix}a`, Buffer.from("x"), daysAgo(2));
    storage.seed(`${prefix}b`, Buffer.from("x"), daysAgo(40));
    storage.seed(`${prefix}c`, Buffer.from("x"), daysAgo(40));
    await sweep(1);
    const first = await cursor();
    storage.failDeletes.add(`${prefix}b`);
    expect((await sweep(1)).orphansDeleted).toBe(0);
    expect(await cursor()).toEqual(first);
    storage.failDeletes.clear();
    expect((await sweep(1)).orphansDeleted).toBe(1);
    expect((await sweep(1)).orphansDeleted).toBe(1);
    expect(storage.objects.has(`${prefix}a`)).toBe(true);
  });

  it("accepts a legacy completed-workspace cursor and skips a deleted workspace", async () => {
    await db.insert(platformSettings).values({ key: ORPHAN_CURSOR_KEY, value: { workspaceId: ws } });
    storage.seed(`ws/${ws}/src/orphan`, Buffer.from("x"), daysAgo(40));
    expect((await sweep()).orphansDeleted).toBe(1);
    await db.update(platformSettings).set({ value: {
      workspaceId: "ffffffff-ffff-4fff-8fff-ffffffffffff", inProgress: true, continuationToken: "old-token",
    } }).where(eq(platformSettings.key, ORPHAN_CURSOR_KEY));
    storage.seed(`ws/${ws}/src/another-orphan`, Buffer.from("x"), daysAgo(40));
    expect((await sweep()).orphansDeleted).toBe(1);
  });
});

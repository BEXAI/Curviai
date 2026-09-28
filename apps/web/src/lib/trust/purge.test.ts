import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { brandKits, generationJobs, platformSettings, products, shareLinks, sourceMedia, workspaces } from "@curvi/db/schema";
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
  it("resumes after the last workspace it finished instead of always starting from the first", async () => {
    await db.delete(platformSettings).where(eq(platformSettings.key, ORPHAN_CURSOR_KEY));
    // Ids that sort after every random workspace: A, whose young files fill
    // the whole listing budget, then B, which holds an old orphan.
    const a = "ffffffff-ffff-4fff-8fff-00000000000a";
    const b = "ffffffff-ffff-4fff-8fff-00000000000b";
    await db.insert(workspaces).values([
      { id: a, name: "Busy" },
      { id: b, name: "Quiet" },
    ]);
    storage.seed(`ws/${a}/src/young-1`, Buffer.from("x"), daysAgo(2));
    storage.seed(`ws/${a}/src/young-2`, Buffer.from("x"), daysAgo(2));
    storage.seed(`ws/${b}/src/abandoned`, Buffer.from("x"), daysAgo(40));
    const sweep = (dryRun = false) =>
      purgeStaleSourceMedia({ db: db as unknown as Db, storage, now: NOW, dryRun, maxOrphanObjects: 2 });
    const cursor = async () =>
      (await db.select().from(platformSettings).where(eq(platformSettings.key, ORPHAN_CURSOR_KEY)))[0]?.value as
        | { workspaceId: string }
        | undefined;

    // First run: A takes the whole budget and is cut short, so B is not
    // reached (before the cursor, every run stopped here).
    expect((await sweep()).orphansDeleted).toBe(0);
    expect(storage.objects.has(`ws/${b}/src/abandoned`)).toBe(true);
    const first = await cursor();
    expect(first?.workspaceId).toBeDefined();
    expect(first?.workspaceId).not.toBe(a);

    // A dry run leaves the cursor alone.
    await sweep(true);
    expect(await cursor()).toEqual(first);

    // Second run starts at A; A alone fills the budget, so it is passed over.
    await sweep();
    expect((await cursor())?.workspaceId).toBe(a);

    // Third run resumes after A and reaches B.
    expect((await sweep()).orphansDeleted).toBe(1);
    expect(storage.objects.has(`ws/${b}/src/abandoned`)).toBe(false);
    expect(storage.objects.has(`ws/${a}/src/young-1`)).toBe(true);
    // It wrapped round to the first workspaces and stopped short of A again.
    expect((await cursor())?.workspaceId).not.toBe(a);
  });
});

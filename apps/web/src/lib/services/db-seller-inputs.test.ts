/**
 * Seller inputs and the products library in DbService, against the real
 * migrations in PGlite: a pack saves photo roles, the SKU, box contents and
 * comparison facts, sends them to the worker, and holds credits for the
 * images they unlock; the library lists each product with its photos and
 * packs, and never another workspace's.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creditLedger, generationJobs, members, products, signupGrants, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { DbService } from "./db";

const enqueue = vi.hoisted(() => ({
  fn: vi.fn<(payload: GeneratePackInput) => Promise<"inline">>(async () => "inline"),
}));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: enqueue.fn }));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f501";
const OTHER_OWNER = "00000000-0000-4000-8000-00000000f502";
const CHANNELS = ["amazon.main", "shopify.product"];
let keyCounter = 0;

function service(userId = OWNER): DbService {
  return new DbService({ db: db as unknown as Db, getUserId: async () => userId, getSupabase: async () => null });
}

async function workspaceFor(userId: string, credits = 200): Promise<string> {
  const [w] = await db.insert(workspaces).values({ name: "Seller ws", plan: "growth" }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId, role: "owner" });
  await db.insert(creditLedger).values({ workspaceId: w.id, delta: credits, reason: "grant", source: "system" });
  return w.id;
}

function upload(ws: string, name: string, angle?: "front" | "back" | "in_the_box") {
  return { key: `ws/${ws}/src/${name}`, sha256: "b".repeat(64), kind: "image" as const, ...(angle ? { angle } : {}) };
}

function nextKey(): string {
  keyCounter += 1;
  return `seller-inputs-${keyCounter}`;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await db.insert(signupGrants).values([
    { userId: OWNER, credits: 0 },
    { userId: OTHER_OWNER, credits: 0 },
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  enqueue.fn.mockReset();
  enqueue.fn.mockResolvedValue("inline");
});

describe("DbService.createJob with seller inputs", () => {
  it("saves roles and details, sends them to the worker and holds credits for what they unlock", async () => {
    const ws = await workspaceFor(OWNER);
    const result = await service().createJob(ws, {
      productId: "new",
      newProductTitle: "Pour over mug",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: nextKey(),
      uploads: [upload(ws, "back.jpg", "back"), upload(ws, "front.jpg", "front"), upload(ws, "box.jpg", "in_the_box")],
      sku: " MUG-12 ",
      boxContents: ["Mug", "Pour over cone"],
      comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
    });
    expect(result.outcome).toBe("created");

    const [product] = await db.select().from(products).where(eq(products.workspaceId, ws));
    expect(product.sku).toBe("MUG-12");
    expect(product.boxContents).toEqual(["Mug", "Pour over cone"]);
    expect(product.comparisonFacts).toEqual(["Holds 12 oz, most hold 8 oz"]);
    const media = await db.select().from(sourceMedia).where(eq(sourceMedia.productId, product.id));
    expect(Object.fromEntries(media.map((m) => [m.r2Key.split("/").pop(), m.angle]))).toEqual({
      "back.jpg": "back",
      "front.jpg": "front",
      "box.jpg": "in_the_box",
    });

    const payload = enqueue.fn.mock.calls[0]?.[0];
    expect(payload?.images[0]).toEqual({ mediaId: `ws/${ws}/src/front.jpg`, angle: "front" });
    expect(payload?.images).toContainEqual({ mediaId: `ws/${ws}/src/box.jpg`, angle: "in_the_box" });
    expect(payload?.sku).toBe("MUG-12");
    expect(payload?.boxContents).toEqual(["Mug", "Pour over cone"]);
    expect(payload?.comparisonFacts).toEqual(["Holds 12 oz, most hold 8 oz"]);

    // The hold covers the angles and the two seller images.
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    const plain = estimatePackCredits(CHANNELS, "listing", "growth").total;
    const withInputs = estimatePackCredits(CHANNELS, "listing", "growth", {
      angles: ["back", "front", "in_the_box"],
      hasBoxContents: true,
      hasComparisonFacts: true,
    }).total;
    expect(withInputs).toBeGreaterThan(plain);
    expect(job.creditsReserved).toBe(withInputs);
    expect(payload?.creditBudget).toBe(withInputs);
  });

  it("stores the seller's note on the job and sends it to the worker (0020)", async () => {
    const ws = await workspaceFor(OWNER);
    const note = "Feature only the blue bottle, leave the red one out";
    const result = await service().createJob(ws, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: nextKey(),
      uploads: [upload(ws, "two-bottles.jpg", "front")],
      userDescription: note,
    });
    expect(result.outcome).toBe("created");
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    expect(job.sellerNote).toBe(note);
    // Intake fills the parsed intent in once the run starts.
    expect(job.sellerIntent).toBeNull();
    expect(enqueue.fn.mock.calls[0]?.[0]?.userDescription).toBe(note);

    const ws2 = await workspaceFor(OWNER);
    await service().createJob(ws2, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: nextKey(),
      uploads: [upload(ws2, "mug.jpg", "front")],
    });
    const [plain] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws2));
    expect(plain.sellerNote).toBeNull();
  });

  it("keeps saved details a later pack leaves out, and clears the ones it empties", async () => {
    const ws = await workspaceFor(OWNER);
    const [p] = await db
      .insert(products)
      .values({ workspaceId: ws, title: "Mug", mode: "listing", sku: "OLD-1", boxContents: ["Mug"], comparisonFacts: ["Holds 12 oz"] })
      .returning();
    await db.insert(sourceMedia).values({
      workspaceId: ws,
      productId: p.id,
      r2Key: `ws/${ws}/src/stored.jpg`,
      kind: "image",
      sha256: "c".repeat(64),
      angle: "front",
    });

    const first = await service().createJob(ws, { productId: p.id, channels: CHANNELS, mode: "listing", idempotencyKey: nextKey() });
    expect(first.outcome).toBe("created");
    const firstPayload = enqueue.fn.mock.calls[0]?.[0];
    // Stored photos keep their roles, and saved details reach the worker.
    expect(firstPayload?.images).toEqual([{ mediaId: `ws/${ws}/src/stored.jpg`, angle: "front" }]);
    expect(firstPayload?.boxContents).toEqual(["Mug"]);

    const second = await service().createJob(ws, {
      productId: p.id,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: nextKey(),
      sku: "",
      comparisonFacts: [],
    });
    expect(second.outcome).toBe("created");
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.sku).toBeNull();
    expect(after.boxContents).toEqual(["Mug"]);
    expect(after.comparisonFacts).toEqual([]);
    expect(enqueue.fn.mock.calls[1]?.[0].comparisonFacts).toEqual([]);
  });

  it("writes nothing to the product when the pack is refused", async () => {
    const ws = await workspaceFor(OWNER, 1);
    const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing", sku: "KEEP" }).returning();
    const result = await service().createJob(ws, {
      productId: p.id,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: nextKey(),
      uploads: [upload(ws, "refused.jpg", "front")],
      sku: "CHANGED",
    });
    expect(result).toMatchObject({ outcome: "rejected", reason: "insufficient_credits" });
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.sku).toBe("KEEP");
  });
});

describe("DbService.listProductLibrary", () => {
  it("lists each product with its photos and packs, newest first, and only this workspace's", async () => {
    const ws = await workspaceFor(OWNER);
    const otherWs = await workspaceFor(OTHER_OWNER);
    const [older] = await db
      .insert(products)
      .values({ workspaceId: ws, title: "Older", mode: "listing", createdAt: new Date("2026-09-01T00:00:00Z") })
      .returning();
    const [newer] = await db
      .insert(products)
      .values({ workspaceId: ws, title: "Newer", mode: "listing", sku: "NEW-1", createdAt: new Date("2026-09-02T00:00:00Z") })
      .returning();
    await db.insert(products).values({ workspaceId: otherWs, title: "Not yours", mode: "listing" });
    await db.insert(sourceMedia).values([
      { workspaceId: ws, productId: newer.id, r2Key: `ws/${ws}/src/n1.jpg`, sha256: "d", angle: "front" },
      { workspaceId: ws, productId: newer.id, r2Key: `ws/${ws}/src/n2.jpg`, sha256: "e", angle: "back" },
    ]);
    await db.insert(generationJobs).values([
      {
        workspaceId: ws,
        productId: newer.id,
        status: "done",
        channels: ["amazon.main", "amazon.secondary", "meta.feed_1x1"],
        creditsReserved: 20,
        creditsCharged: 14.5,
        createdAt: new Date("2026-09-10T00:00:00Z"),
        updatedAt: new Date("2026-09-10T00:00:00Z"),
      },
      {
        workspaceId: ws,
        productId: newer.id,
        status: "failed",
        channels: ["shopify.product"],
        creditsReserved: 8,
        creditsCharged: 0,
        createdAt: new Date("2026-09-12T00:00:00Z"),
        updatedAt: new Date("2026-09-12T00:00:00Z"),
      },
    ]);

    const library = await service().listProductLibrary(ws);
    expect(library.map((p) => p.title)).toEqual(["Newer", "Older"]);
    const [first, second] = library;
    expect(first.sku).toBe("NEW-1");
    expect(first.photoCount).toBe(2);
    expect(first.packs.map((pack) => [pack.status, pack.channels, pack.creditsReserved, pack.creditsCharged])).toEqual([
      ["failed", ["shopify.product"], 8, 0],
      ["done", ["amazon.main", "amazon.secondary", "meta.feed_1x1"], 20, 14.5],
    ]);
    expect(first.packs[0].createdAt).toBe("2026-09-12T00:00:00.000Z");
    expect(second.id).toBe(older.id);
    expect(second.photoCount).toBe(0);
    expect(second.packs).toEqual([]);

    const theirs = await service(OTHER_OWNER).listProductLibrary(otherWs);
    expect(theirs.map((p) => p.title)).toEqual(["Not yours"]);
  });

  it("is empty for a workspace with no products", async () => {
    const ws = await workspaceFor(OWNER);
    expect(await service().listProductLibrary(ws)).toEqual([]);
  });
});

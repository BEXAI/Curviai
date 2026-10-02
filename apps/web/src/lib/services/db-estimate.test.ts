/**
 * DbService.estimateJob against the real migrations in PGlite (PHASE_19
 * P19-16, founder decision 5): the estimate is createJob's own hold for the
 * same request, photo sizes and kept photos included, it writes nothing, a
 * hold above maxCredits is refused before anything is written, a replay
 * under a previous derived key answers first, and an underfunded workspace
 * is refused with both numbers.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { creditLedger, generationJobs, members, products, signupGrants, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import type { IngestOutcome } from "@/lib/trust/ingest";
import { DbService } from "./db";
import { INSUFFICIENT_CREDITS_MESSAGE } from "./errors";
import type { CreateJobInput, EstimateJobInput } from "./types";

vi.mock("@/lib/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/enqueue")>()),
  enqueueGeneratePack: vi.fn(async () => "inline"),
}));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f701";
const STRANGER = "00000000-0000-4000-8000-00000000f702";
const CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1", "etsy.listing"];
let keyCounter = 0;

/** Upright sizes the ingest stub reports, by key: what estimate_pack
 * measures from the same bytes. */
const sizes = new Map<string, { width: number; height: number }>();

function service(userId = OWNER): DbService {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => userId,
    getSupabase: async () => null,
    outputOptionsEnabled: async () => true,
    providerVerdict: async () => "ok",
    cutoutCached: async () => false,
    ingestUpload: async (key: string): Promise<IngestOutcome> => {
      const size = sizes.get(key);
      return { ok: true, sha256: null, width: size?.width ?? null, height: size?.height ?? null, bytes: 1, rewritten: false };
    },
  });
}

async function workspaceWith(plan: string, credits: number): Promise<{ ws: string; productId: string }> {
  const [w] = await db.insert(workspaces).values({ name: `${plan} ws`, plan }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: OWNER, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
  await db.insert(sourceMedia).values({
    workspaceId: w.id,
    productId: p.id,
    r2Key: `ws/${w.id}/src/stored-front.jpg`,
    kind: "image",
    sha256: "c".repeat(64),
    angle: "front",
    width: 3000,
    height: 3000,
  });
  if (credits > 0) {
    await db.insert(creditLedger).values({ workspaceId: w.id, delta: credits, reason: "grant", source: "system" });
  }
  return { ws: w.id, productId: p.id };
}

/** A photo as estimate_pack measures it and create_pack stores it: the same
 * key, hash and upright size. */
function photo(ws: string, name: string, width: number, height: number, angle?: "front" | "back" | "detail") {
  const sha256 = name.padEnd(64, "0").slice(0, 64);
  const key = `ws/${ws}/src/api/${sha256}`;
  sizes.set(key, { width, height });
  return { key, sha256, kind: "image" as const, width, height, ...(angle ? { angle } : {}) };
}

function toCreate(input: EstimateJobInput, extra: Partial<CreateJobInput> = {}): CreateJobInput {
  keyCounter += 1;
  return {
    ...input,
    idempotencyKey: `estimate-${keyCounter}`,
    ...(input.uploads ? { uploads: input.uploads.map(({ width: _w, height: _h, ...upload }) => upload) } : {}),
    ...extra,
  };
}

async function counts(ws: string): Promise<{ jobs: number; products: number; media: number; ledger: number }> {
  const [jobs, prods, media, ledger] = await Promise.all([
    db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws)),
    db.select().from(products).where(eq(products.workspaceId, ws)),
    db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, ws)),
    db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws)),
  ]);
  return { jobs: jobs.length, products: prods.length, media: media.length, ledger: ledger.length };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  await db.insert(signupGrants).values({ userId: OWNER, credits: 0 });
  vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

describe("DbService.estimateJob", () => {
  it("is the hold createJob makes for the same request, and writes nothing", async () => {
    const { ws, productId } = await workspaceWith("pro", 2000);
    const requests: Array<(ws: string) => EstimateJobInput> = [
      // The product's stored photo.
      () => ({ productId, channels: CHANNELS, mode: "listing" }),
      // New photos with roles and seller inputs.
      (w) => ({
        productId: "new",
        channels: CHANNELS,
        mode: "listing",
        uploads: [photo(w, "big-front", 4032, 3024, "front"), photo(w, "big-back", 3000, 3000, "back")],
        boxContents: ["Mug", "Lid"],
        newProductTitle: "Travel mug",
      }),
      // Kept photos, one too small for most channels.
      (w) => ({
        productId: "new",
        channels: CHANNELS,
        mode: "listing",
        uploads: [photo(w, "kept-big", 3000, 3000, "front"), photo(w, "kept-small", 400, 300, "detail")],
        outputOptions: { background: "keep", bundle: "listing" },
      }),
      // A bundle and a colored background on the stored photo.
      () => ({
        productId,
        channels: ["amazon.main", "shopify.product", "pinterest.pin"],
        mode: "listing",
        outputOptions: { bundle: "main", color: { kind: "swatch", key: "sand" } },
      }),
    ];
    for (const make of requests) {
      const input = make(ws);
      const before = await counts(ws);
      const estimate = await service().estimateJob(ws, input);
      expect(await counts(ws), JSON.stringify(input)).toEqual(before);
      if (estimate.outcome !== "estimated") {
        throw new Error(`estimate refused: ${estimate.message}`);
      }
      expect([...estimate.channels, ...estimate.leftOut.map((entry) => entry.specId)].sort()).toEqual(
        [...new Set(input.channels)].sort(),
      );
      const created = await service().createJob(ws, toCreate(input));
      if (created.outcome !== "created") {
        throw new Error(`create refused: ${JSON.stringify(created)}`);
      }
      expect(created.job.creditsReserved, JSON.stringify(input.outputOptions ?? {})).toBe(estimate.creditsNeeded);
    }
  });

  it("measures the photos: a kept photo too small for a channel leaves it out and costs less", async () => {
    const { ws } = await workspaceWith("pro", 2000);
    const keep = { background: "keep" as const, bundle: "main" as const };
    // Amazon secondary and eBay need a longer side than a 300 px photo can
    // be enlarged to; Etsy pads it.
    const channels = ["amazon.secondary", "ebay.listing", "etsy.listing"];
    const big = await service().estimateJob(ws, {
      productId: "new",
      channels,
      mode: "listing",
      uploads: [photo(ws, "keep-big-only", 3000, 3000, "front")],
      outputOptions: keep,
    });
    const small = await service().estimateJob(ws, {
      productId: "new",
      channels,
      mode: "listing",
      uploads: [photo(ws, "keep-small-only", 300, 300, "front")],
      outputOptions: keep,
    });
    if (big.outcome !== "estimated" || small.outcome !== "estimated") {
      throw new Error("both estimates should run");
    }
    expect(big.leftOut).toEqual([]);
    expect(small.channels).toEqual(["etsy.listing"]);
    expect(small.leftOut).toEqual([
      { specId: "amazon.secondary", reason: "not_made" },
      { specId: "ebay.listing", reason: "not_made" },
    ]);
    expect(small.creditsNeeded).toBeLessThanOrEqual(big.creditsNeeded);
  });

  it("refuses exactly as createJob refuses before its hold", async () => {
    const { ws } = await workspaceWith("free", 100);
    expect(await service().estimateJob(ws, { productId: "new", channels: ["amazon.main"], mode: "listing" })).toMatchObject({
      outcome: "rejected",
      reason: "needs_photo",
    });
    expect(
      await service().estimateJob(ws, {
        productId: "new",
        channels: ["amazon.main"],
        mode: "listing",
        uploads: [photo(ws, "brand-front", 3000, 3000)],
        outputOptions: { color: { kind: "brand", index: 0 } },
      }),
    ).toMatchObject({ outcome: "rejected", reason: "upgrade_required" });
    expect(await service(STRANGER).estimateJob(ws, { productId: "new", channels: ["amazon.main"], mode: "listing" })).toMatchObject({
      outcome: "rejected",
      reason: "role_forbidden",
    });
  });

  it("reads the balance of the named workspace for its members only", async () => {
    const { ws } = await workspaceWith("starter", 321);
    expect(await service().workspaceBalance(ws)).toBe(321);
    expect(await service(STRANGER).workspaceBalance(ws)).toBeNull();
  });
});

describe("DbService.createJob caps and keys (P19-16)", () => {
  it("refuses a hold above maxCredits before anything is written or held", async () => {
    const { ws, productId } = await workspaceWith("pro", 2000);
    const estimate = await service().estimateJob(ws, { productId, channels: CHANNELS, mode: "listing" });
    if (estimate.outcome !== "estimated") {
      throw new Error("estimate refused");
    }
    const before = await counts(ws);
    const refused = await service().createJob(
      ws,
      toCreate({ productId, channels: CHANNELS, mode: "listing" }, { maxCredits: estimate.creditsNeeded - 1 }),
    );
    expect(refused).toMatchObject({
      outcome: "rejected",
      reason: "over_max_credits",
      creditsNeeded: estimate.creditsNeeded,
      maxCredits: estimate.creditsNeeded - 1,
    });
    expect(await counts(ws)).toEqual(before);
    const exact = await service().createJob(
      ws,
      toCreate({ productId, channels: CHANNELS, mode: "listing" }, { maxCredits: estimate.creditsNeeded }),
    );
    expect(exact.outcome).toBe("created");
  });

  it("replays under a previous key first and passes over a conflict there", async () => {
    const { ws, productId } = await workspaceWith("pro", 2000);
    const first = await service().createJob(ws, {
      productId,
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: "mcp:window-1",
    });
    expect(first.outcome).toBe("created");
    const retry = await service().createJob(ws, {
      productId,
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: "mcp:window-2",
      previousIdempotencyKeys: ["mcp:window-1"],
    });
    expect(retry.outcome).toBe("replayed");
    if (retry.outcome === "replayed" && first.outcome === "created") {
      expect(retry.job.id).toBe(first.job.id);
    }
    // Another request whose previous window key named a different pack is
    // not a conflict: it starts its own pack under its own key.
    const other = await service().createJob(ws, {
      productId,
      channels: ["shopify.product"],
      mode: "listing",
      idempotencyKey: "mcp:window-3",
      previousIdempotencyKeys: ["mcp:window-1"],
    });
    expect(other.outcome).toBe("created");
  });

  it("refuses an underfunded workspace with both numbers and keeps the web line", async () => {
    const { ws, productId } = await workspaceWith("starter", 3);
    const refused = await service().createJob(ws, toCreate({ productId, channels: CHANNELS, mode: "listing" }));
    expect(refused).toMatchObject({
      outcome: "rejected",
      reason: "insufficient_credits",
      message: INSUFFICIENT_CREDITS_MESSAGE,
      creditsAvailable: 3,
    });
    if (refused.outcome === "rejected") {
      expect(refused.creditsNeeded).toBeGreaterThan(3);
    }
  });
});

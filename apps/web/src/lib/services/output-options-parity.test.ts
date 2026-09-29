/**
 * Parity property (docs/phases/PHASE_15.md, Pricing, holds and
 * idempotency): for random option sets on the same merged media list
 * createJob uses, the form's estimate, the createJob hold and the demo plan
 * agree, and the deterministic planner fits the hold with no credit budget
 * skip. The form and the demo build their estimate inputs with the same
 * outputEstimateInputs createJob uses.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brandKits,
  creditLedger,
  generationJobs,
  members,
  products,
  signupGrants,
  sourceMedia,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { EXTRA_FAMILY_KEYS, SWATCH_KEYS, type OutputOptionsInput } from "@curvi/pipeline/output-options";
import { CREDIT_BUDGET_REASON, planShots } from "@curvi/pipeline/planner";
import { undeliverableShotMethods, type TierKey } from "@curvi/pipeline/seed";
import type { AngleRole } from "@curvi/pipeline/seller-inputs";
import { ESTIMATE_REFERENCE_PRODUCT, estimatePackCredits } from "@/lib/pack-estimate";
import { DbService } from "./db";
import { planDemoShots } from "./demo-plan";
import { outputEstimateInputs, resolveJobOutput, type OutputPhoto } from "./output-options";

vi.mock("@/lib/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/enqueue")>()),
  enqueueGeneratePack: vi.fn(async () => "inline"),
}));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f601";
const TIER: TierKey = "pro";
const KIT = ["#1F2A44", "#FD7F11"];
const ALL_CHANNELS = [
  "amazon.main",
  "amazon.secondary",
  "shopify.product",
  "meta.feed_1x1",
  "meta.feed_4x5",
  "etsy.listing",
  "ebay.listing",
  "walmart.main",
  "tiktokshop.main",
  "google.merchant.main",
  "google.merchant.lifestyle",
  "pinterest.pin",
];
const ANGLES: AngleRole[] = ["front", "back", "side", "detail"];
const SIZES: Array<[number, number] | null> = [[4032, 3024], [3000, 3000], [900, 700], [3000, 400], null];

/** Deterministic pseudo random numbers, so a failure is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

function randomOptions(next: () => number): OutputOptionsInput {
  const extras: Record<string, boolean> = {};
  for (const family of EXTRA_FAMILY_KEYS) {
    if (next() < 0.5) {
      extras[family] = next() < 0.5;
    }
  }
  const colorRoll = next();
  return {
    background: next() < 0.5 ? "keep" : "remove",
    fit: next() < 0.5 ? "pad" : "auto",
    color:
      colorRoll < 0.4
        ? { kind: "swatch", key: pick(next, SWATCH_KEYS) }
        : colorRoll < 0.7
          ? { kind: "brand", index: Math.floor(next() * KIT.length) }
          : { kind: "custom", hex: "#2B3A4C" },
    extras,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  await db.insert(signupGrants).values({ userId: OWNER, credits: 0 });
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("form estimate, createJob hold and demo plan parity", () => {
  it("agree for random option sets on the same photos", async () => {
    const next = random(15);
    let compared = 0;
    let keptRuns = 0;
    for (let run = 0; run < 12; run++) {
      const channels = ALL_CHANNELS.filter(() => next() < 0.5);
      if (channels.length === 0) {
        channels.push("shopify.product");
      }
      const photoCount = 1 + Math.floor(next() * 4);
      const options = randomOptions(next);

      const [w] = await db.insert(workspaces).values({ name: `parity ${run}`, plan: TIER }).returning();
      await db.insert(members).values({ workspaceId: w.id, userId: OWNER, role: "owner" });
      await db.insert(creditLedger).values({ workspaceId: w.id, delta: 1000, reason: "grant", source: "system" });
      const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
      const photos: OutputPhoto[] = [];
      for (let i = 0; i < photoCount; i++) {
        const size = pick(next, SIZES);
        const angle = ANGLES[i];
        const id = `ws/${w.id}/src/p${i}.jpg`;
        photos.push({ id, angle, width: size?.[0] ?? null, height: size?.[1] ?? null });
        await db.insert(sourceMedia).values({
          workspaceId: w.id,
          productId: p.id,
          r2Key: id,
          kind: "image",
          sha256: "a".repeat(64),
          angle,
          width: size?.[0] ?? null,
          height: size?.[1] ?? null,
          // Newest first is how createJob reads stored photos: stagger the
          // times so the merged order is known.
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, photoCount - i)),
        });
      }
      await db.insert(brandKits).values({ workspaceId: w.id, colors: KIT });

      // The form: the same resolution with the kit and the product's photos.
      const resolved = resolveJobOutput({
        input: options,
        mode: "listing",
        enabled: true,
        brandColors: KIT,
        brandKitsAllowed: true,
        photos,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      const angles = photos.flatMap((photo) => (photo.angle ? [photo.angle] : []));
      const estimate = estimatePackCredits(channels, "listing", TIER, {
        angles,
        ...outputEstimateInputs(resolved.resolved, photos),
      }).total;

      // createJob.
      const service = new DbService({
        db: db as unknown as Db,
        getUserId: async () => OWNER,
        getSupabase: async () => null,
        outputOptionsEnabled: async () => true,
        providerVerdict: async () => "ok",
      });
      const created = await service.createJob(w.id, {
        productId: p.id,
        channels,
        mode: "listing",
        idempotencyKey: `parity-${run}`,
        outputOptions: options,
      });
      const context = JSON.stringify({ run, channels, options, photos });
      if (estimate <= 0) {
        expect(created, context).toMatchObject({ outcome: "rejected", reason: "insufficient_credits" });
        continue;
      }
      expect(created.outcome, context).toBe("created");
      compared += 1;
      keptRuns += resolved.resolved.keepMediaIds.length > 0 ? 1 : 0;
      const [row] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, w.id));
      expect(row.creditsReserved, context).toBe(estimate);

      // The demo plan.
      const demo = planDemoShots(channels, TIER, "listing", {
        angles,
        output: outputEstimateInputs(resolved.resolved, photos),
      });
      expect(Math.ceil(demo.reduce((sum, shot) => sum + shot.credits, 0)), context).toBe(estimate);

      // The runner's deterministic plan fits the hold without a budget skip.
      const inputs = outputEstimateInputs(resolved.resolved, photos);
      const plan = planShots(ESTIMATE_REFERENCE_PRODUCT, {
        channels,
        tier: TIER,
        creditBudget: row.creditsReserved,
        primaryMediaId: photos[0].id,
        undeliverableMethods: [...undeliverableShotMethods],
        ...(inputs.output ? { output: inputs.output } : {}),
      });
      expect(plan.skipped.filter((s) => s.reason === CREDIT_BUDGET_REASON), context).toEqual([]);
    }
    // The seed must reach real packs, Keep ones among them.
    expect(compared).toBeGreaterThanOrEqual(8);
    expect(keptRuns).toBeGreaterThanOrEqual(3);
  });
});

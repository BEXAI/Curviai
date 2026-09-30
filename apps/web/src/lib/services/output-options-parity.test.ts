/**
 * Parity property (docs/phases/PHASE_15.md, Pricing, holds and
 * idempotency): for random option sets on the same merged media list
 * createJob uses, the form's estimate, the createJob hold and the demo plan
 * agree, and the deterministic planner fits the hold with no credit budget
 * skip. The form and the demo build their estimate inputs with the same
 * outputEstimateInputs createJob uses. Pack bundles (PHASE_16 workstream 1)
 * join the random options and reach the planner through planFlagsOf. A
 * second run adds A+ modules, the ads formats and extra scene versions, and
 * checks that a scene carousel holds one generated scene.
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
import { BUNDLE_KEYS, EXTRA_FAMILY_KEYS, SWATCH_KEYS, type OutputOptionsInput } from "@curvi/pipeline/output-options";
import { CREDIT_BUDGET_REASON, planShots } from "@curvi/pipeline/planner";
import { isAplusModuleType, type Shot } from "@curvi/pipeline/schemas";
import { adsFormats, creditCosts, undeliverableShotMethods, type TierKey } from "@curvi/pipeline/seed";
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
/** The specs PHASE_16's A+ modules and ad placements need, drawn only by
 * the Phase 16 run so the first run's random stream stays as it was. */
const PHASE_16_CHANNELS = ["amazon.aplus.basic_header", "meta.story_9x16", "meta.reels_9x16", "tiktok.ad_9x16"];
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

/** A pack bundle for most runs (PHASE_16), drawn from its own stream so the
 * option draws above stay as they were. */
function randomBundle(next: () => number): Pick<OutputOptionsInput, "bundle"> {
  return next() < 0.75 ? { bundle: pick(next, BUNDLE_KEYS) } : {};
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

interface ParityRun {
  run: string;
  channels: string[];
  photoCount: number;
  options: OutputOptionsInput;
  sizes: () => [number, number] | null;
  /** Press quotes for the A+ endorsement module (PHASE_16 workstream 2). */
  endorsements?: string[];
}

interface ParityOutcome {
  /** False when the pick plans no billable shot and createJob refused it. */
  compared: boolean;
  kept: boolean;
  /** The demo plan, which prices exactly what the hold holds. */
  shots: Shot[];
  creditsReserved: number;
}

/**
 * One pack through the three paths on the same photos: the form's estimate,
 * createJob's hold and the demo plan agree, and the runner's deterministic
 * plan fits the hold with no credit budget skip.
 */
async function checkParity({ run, channels, photoCount, options, sizes, endorsements }: ParityRun): Promise<ParityOutcome> {
  const [w] = await db.insert(workspaces).values({ name: `parity ${run}`, plan: TIER }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: OWNER, role: "owner" });
  await db.insert(creditLedger).values({ workspaceId: w.id, delta: 1000, reason: "grant", source: "system" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
  const photos: OutputPhoto[] = [];
  for (let i = 0; i < photoCount; i++) {
    const size = sizes();
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
  if (!resolved.ok) return { compared: false, kept: false, shots: [], creditsReserved: 0 };
  const angles = photos.flatMap((photo) => (photo.angle ? [photo.angle] : []));
  const hasEndorsements = (endorsements?.length ?? 0) > 0;
  const estimate = estimatePackCredits(channels, "listing", TIER, {
    angles,
    hasEndorsements,
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
    ...(hasEndorsements ? { endorsements } : {}),
  });
  const context = JSON.stringify({ run, channels, options, photos, endorsements });
  if (estimate <= 0) {
    expect(created, context).toMatchObject({ outcome: "rejected", reason: "insufficient_credits" });
    return { compared: false, kept: false, shots: [], creditsReserved: 0 };
  }
  expect(created.outcome, context).toBe("created");
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, w.id));
  expect(row.creditsReserved, context).toBe(estimate);

  // The demo plan.
  const demo = planDemoShots(channels, TIER, "listing", {
    angles,
    ...(hasEndorsements ? { endorsements } : {}),
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
    hasEndorsements,
    ...(hasEndorsements ? { endorsements } : {}),
    ...(inputs.output ? { output: inputs.output } : {}),
  });
  expect(plan.skipped.filter((s) => s.reason === CREDIT_BUDGET_REASON), context).toEqual([]);
  return { compared: true, kept: resolved.resolved.keepMediaIds.length > 0, shots: demo, creditsReserved: row.creditsReserved };
}

describe("form estimate, createJob hold and demo plan parity", () => {
  it("agree for random option sets on the same photos", async () => {
    const next = random(15);
    const nextBundle = random(16);
    let compared = 0;
    let keptRuns = 0;
    const bundles = new Set<string>();
    for (let run = 0; run < 16; run++) {
      const channels = ALL_CHANNELS.filter(() => next() < 0.5);
      if (channels.length === 0) {
        channels.push("shopify.product");
      }
      const photoCount = 1 + Math.floor(next() * 4);
      const options = { ...randomOptions(next), ...randomBundle(nextBundle) };
      const outcome = await checkParity({ run: String(run), channels, photoCount, options, sizes: () => pick(next, SIZES) });
      if (!outcome.compared) continue;
      compared += 1;
      keptRuns += outcome.kept ? 1 : 0;
      bundles.add(options.bundle ?? "everything");
    }
    // The seed must reach real packs, Keep ones among them.
    expect(compared).toBeGreaterThanOrEqual(8);
    expect(keptRuns).toBeGreaterThanOrEqual(3);
    // And packs of several bundles, not only today's.
    expect(bundles.size).toBeGreaterThanOrEqual(3);
  });

  // PHASE_16 workstreams 2, 3 and 6: A+ modules, the ads formats and extra
  // scene versions go through the same three paths, and the hold counts one
  // scene per carousel (founder decision 4).
  it("agree for A+ modules, ad packs, scene carousels and scene versions", async () => {
    const next = random(1616);
    let compared = 0;
    let aplusRuns = 0;
    let adRuns = 0;
    let sceneCarousels = 0;
    let versionRuns = 0;
    for (let run = 0; run < 16; run++) {
      const channels = [...ALL_CHANNELS, ...PHASE_16_CHANNELS].filter(() => next() < 0.6);
      if (channels.length === 0) {
        channels.push("meta.feed_4x5");
      }
      const photoCount = 1 + Math.floor(next() * 4);
      const base = randomOptions(next);
      const scenes = next() < 0.6;
      const options: OutputOptionsInput = {
        ...base,
        extras: { ...base.extras, ads: next() < 0.7, scenes },
        ...(next() < 0.5 ? { variations: 2 + Math.floor(next() * 3) } : {}),
        ...(next() < 0.3 ? { bundle: pick(next, BUNDLE_KEYS) } : {}),
      };
      const endorsements = next() < 0.5 ? ["Gift Guide pick"] : undefined;
      const outcome = await checkParity({
        run: `p16-${run}`,
        channels,
        photoCount,
        options,
        sizes: () => pick(next, SIZES),
        ...(endorsements ? { endorsements } : {}),
      });
      if (!outcome.compared) continue;
      compared += 1;
      const shots = outcome.shots;
      aplusRuns += shots.some((s) => isAplusModuleType(s.type)) ? 1 : 0;
      adRuns += shots.some((s) => s.type === "ad_variant") ? 1 : 0;
      versionRuns += shots.some((s) => (s.variations ?? 1) > 1) ? 1 : 0;
      const slides = shots.filter((s) => s.type === "carousel_slide");
      if (slides.some((s) => s.method === "composite_generate")) {
        sceneCarousels += 1;
        // One generated scene per carousel, however many slides it has.
        expect(slides.length).toBeGreaterThanOrEqual(adsFormats.carousel.minSlides);
        expect(slides.reduce((sum, s) => sum + s.credits, 0)).toBe(creditCosts.generativeStill);
      }
    }
    expect(compared).toBeGreaterThanOrEqual(8);
    expect(aplusRuns).toBeGreaterThanOrEqual(1);
    expect(adRuns).toBeGreaterThanOrEqual(1);
    expect(sceneCarousels).toBeGreaterThanOrEqual(1);
    expect(versionRuns).toBeGreaterThanOrEqual(1);
  });
});

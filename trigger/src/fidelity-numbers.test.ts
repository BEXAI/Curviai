/**
 * P18-08: the fidelity numbers QC measures survive. The runner keeps them
 * on every channel output, the asset it saves carries the representative
 * output's record (qc.fidelity) and every passed output's record and proof
 * rows (qc.outputs), the subtask boundary carries them per file, and the
 * pack's compliance report shows them. Product pixels are never touched by
 * any of this; the rule 3 suites run unchanged.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { InMemoryBreakerStore, InMemoryCostMeter, ProviderRegistry } from "@curvi/ai";
import { MockProvider } from "@curvi/ai/testing";
import { and, eq, type Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { assets, generationJobs, products, workspaces } from "@curvi/db/schema";
import {
  encodeJpeg,
  encodePng,
  endExiftool,
  PRODUCT_UNCHANGED_CHECK,
  solidCanvas,
  type PackFileReport,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import { DbJobStore } from "./db-store";
import {
  activeRecipe,
  deserializeShotOutcome,
  InMemoryJobStore,
  runGeneratePack,
  runShot,
  serializeShotOutcome,
  systemClock,
  type AiDeps,
  type GeneratePackInput,
  type PipelineDeps,
  type ShotGeneration,
  type ShotGenerator,
  type StoredPack,
} from "./pipeline-runner";
import { demoAplusCopy, demoProfile, DemoShotGenerator } from "./runtime";

const passVerdict = { pass: true, fidelity: 0.97, issues: [], repairHint: "" };

function makeAi(): AiDeps {
  const intakeFixture = {
    images: [
      {
        sellableProduct: true,
        distinctProducts: 1,
        sharpEnough: true,
        flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
      },
    ],
  };
  const providers = {
    intake: new MockProvider({ name: "mock-intake", tasks: [activeRecipe("intake").key], output: intakeFixture }),
    analyze: new MockProvider({ name: "mock-analyze", tasks: [activeRecipe("analyze").key], output: demoProfile }),
    plan: new MockProvider({ name: "mock-plan", tasks: [activeRecipe("plan").key], output: { notAShotList: true } }),
    qc: new MockProvider({ name: "mock-qc", tasks: [activeRecipe("qc").key], output: passVerdict }),
    copy: new MockProvider({ name: "mock-copy", tasks: [activeRecipe("copy").key], output: demoAplusCopy }),
  };
  const registry = new ProviderRegistry();
  const routing: Record<string, string[]> = {};
  for (const [stage, provider] of Object.entries(providers)) {
    registry.register(provider);
    routing[activeRecipe(stage as Parameters<typeof activeRecipe>[0]).key] = [provider.name];
  }
  return { registry, routing, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore() };
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & { store: InMemoryJobStore } {
  return {
    ai: makeAi(),
    store: new InMemoryJobStore(),
    clock: systemClock,
    generator: new DemoShotGenerator(),
    delayedRetry: { sleep: async () => {} },
    ...overrides,
  } as PipelineDeps & { store: InMemoryJobStore };
}

const baseInput: GeneratePackInput = {
  jobId: "job1",
  workspaceId: "ws1",
  tier: "starter",
  channels: ["amazon", "shopify"],
  creditBudget: 20,
  images: [{ mediaId: "m1" }],
  sku: "SKU1",
  seoSlug: "demo-mug",
};

class FixedGenerator implements ShotGenerator {
  constructor(private readonly generation: () => Promise<ShotGeneration>) {}
  generate(): Promise<ShotGeneration> {
    return this.generation();
  }
}

const ctx = { jobId: "job1", workspaceId: "ws1" };

function keptShot(channels: string[] = ["amazon.secondary"]): Shot {
  return {
    id: "o1",
    type: "original_photo",
    sourceMediaId: "m1",
    method: "deterministic",
    channels,
    stylePreset: "none",
    credits: 1,
    priority: 1,
  };
}

/** A 2000 px textured photo and its full frame mask. */
function texturedPhoto(size = 2000): { photo: RawImage; mask: RawMask } {
  const photo = solidCanvas(size, size, 0, 0, 0);
  for (let i = 0; i < size * size; i++) {
    photo.data[i * 4] = 60 + (i % 97);
    photo.data[i * 4 + 1] = 80 + (i % 53);
    photo.data[i * 4 + 2] = 120;
  }
  return { photo, mask: { data: Buffer.alloc(size * size, 255), width: size, height: size } };
}

async function packReport(summary: { pack: StoredPack | null }): Promise<PackFileReport[]> {
  return (JSON.parse(await readFile(summary.pack!.reportPath, "utf8")) as { files: PackFileReport[] }).files;
}

afterAll(async () => {
  await endExiftool();
});

describe("the runner keeps the fidelity numbers", () => {
  it("saves them for composites, null where no reference exists, and writes them into the report", async () => {
    const deps = makeDeps();
    const summary = await runGeneratePack(baseInput, deps);
    expect(summary.state).toBe("done");

    const lifestyle = deps.store.assets.find((a) => a.shotType.startsWith("lifestyle") && a.status === "passed");
    expect(lifestyle?.fidelity).toMatchObject({ meanDeltaE: 0, maxDeltaE: 0, exact: false });
    expect(lifestyle?.fidelity?.maskArea).toBeGreaterThan(0);
    expect(lifestyle?.digitalSource).toBe("composite");
    // Every passed channel output keeps its own record and proof rows.
    expect(lifestyle?.outputs?.length).toBeGreaterThan(0);
    for (const output of lifestyle?.outputs ?? []) {
      expect(output.fidelity).not.toBeNull();
      expect(output.checks.map((c) => c.name)).toContain("dimensions");
      expect(output.checks.every((c) => ["dimensions", "backgroundWhiteShare", "backgroundWhiteOrClear", "fillRatio"].includes(c.name))).toBe(true);
    }

    // The demo main image is drawn with no product reference: nothing to measure.
    const main = deps.store.assets.find((a) => a.shotType === "amazon_main");
    expect(main?.fidelity).toBeNull();

    const files = await packReport(summary);
    const lifestyleFiles = files.filter((f) => f.ref === lifestyle?.shotId);
    expect(lifestyleFiles.length).toBeGreaterThan(0);
    for (const file of lifestyleFiles) {
      expect(file.fidelity).toMatchObject({ meanDeltaE: 0 });
      expect(file.checks.find((c) => c.name === PRODUCT_UNCHANGED_CHECK)).toMatchObject({ pass: true, measured: 0 });
    }
    const mainFile = files.find((f) => f.ref === main?.shotId);
    expect(mainFile?.fidelity).toBeUndefined();
  });

  it("saves the numbers of a kept photo rendered against its reference", async () => {
    const { photo, mask } = texturedPhoto();
    const png = await encodePng(photo);
    const generator = new FixedGenerator(async () => ({
      image: photo,
      mask,
      productReference: photo,
      encoded: { buffer: png, format: "png" },
      costMicros: 0,
      fidelityRequired: true,
      fidelityKind: "main",
    }));
    const deps = makeDeps({ generator });
    const outcome = await runShot(keptShot(), ctx, deps);
    expect(outcome.status).toBe("passed");
    expect(outcome.fidelity).toMatchObject({ meanDeltaE: 0, maxDeltaE: 0, exactByteShare: 1, kind: "main", threshold: 3, exact: false });
    expect(deps.store.assets[0].fidelity).toEqual(outcome.fidelity);
    expect(outcome.packAssets?.[0].fidelity).toEqual(outcome.fidelity);
  });

  it("records a kept photo shipped as the stored upload as exact", async () => {
    const bytes = await encodeJpeg(solidCanvas(2000, 1500, 120, 140, 160));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generator = new FixedGenerator(async () => ({
      image: { data: Buffer.alloc(0), width: 2000, height: 1500, channels: 4 },
      mask: null,
      encoded: { buffer: bytes, format: "jpg" },
      costMicros: 0,
      fidelityKind: "main",
      treatment: { kind: "original_unchanged", scale: 1, sourceWidth: 2000, sourceHeight: 1500 },
      passthrough: { sha256 },
    }));
    const deps = makeDeps({ generator });
    const outcome = await runShot(keptShot(), ctx, deps);
    expect(outcome.status).toBe("passed");
    expect(outcome.fidelity).toEqual({
      meanDeltaE: 0,
      maxDeltaE: 0,
      exactByteShare: 1,
      maskArea: 3_000_000,
      threshold: 3,
      maxDeltaELimit: 10,
      kind: "main",
      exact: true,
    });
  });

  it("saves the numbers of a template render that declares a reference", async () => {
    const { photo, mask } = texturedPhoto();
    const generator = new FixedGenerator(async () => ({
      image: photo,
      mask,
      productReference: photo,
      encoded: { buffer: await encodePng(photo), format: "png" },
      costMicros: 0,
      fidelityRequired: true,
    }));
    const shot: Shot = { ...keptShot(), id: "t1", type: "social_1x1", method: "template", channels: ["meta.feed_1x1"] };
    const deps = makeDeps({ generator });
    const outcome = await runShot(shot, ctx, deps);
    expect(outcome.fidelity).toMatchObject({ meanDeltaE: 0, exact: false });
    expect(deps.store.assets[0].fidelity).toEqual(outcome.fidelity);
  });

  it("stores null when the generation has no reference", async () => {
    const image = solidCanvas(2000, 2000, 240, 240, 240);
    const generator = new FixedGenerator(async () => ({
      image,
      mask: null,
      encoded: { buffer: await encodePng(image), format: "png" },
      costMicros: 0,
    }));
    const shot: Shot = { ...keptShot(), id: "t2", type: "social_1x1", method: "template", channels: ["meta.feed_1x1"] };
    const deps = makeDeps({ generator });
    const outcome = await runShot(shot, ctx, deps);
    expect(outcome.fidelity).toBeNull();
    expect(deps.store.assets[0].fidelity).toBeNull();
  });

  it("carries each file's numbers across the subtask boundary", async () => {
    const { photo, mask } = texturedPhoto();
    const png = await encodePng(photo);
    const generator = new FixedGenerator(async () => ({
      image: photo,
      mask,
      productReference: photo,
      encoded: { buffer: png, format: "png" },
      costMicros: 0,
      fidelityRequired: true,
      fidelityKind: "main",
    }));
    const outcome = await runShot(keptShot(), ctx, makeDeps({ generator }));
    const serialized = JSON.parse(JSON.stringify(await serializeShotOutcome(outcome)));
    const back = await deserializeShotOutcome(serialized, ctx);
    expect(back.fidelity).toEqual(outcome.fidelity);
    expect(back.packAssets?.[0].fidelity).toEqual(outcome.fidelity);
    expect(back.outputs[0].fidelity).toEqual(outcome.fidelity);
  });
});

describe("DbJobStore.saveAsset writes qc.fidelity", () => {
  let client: PGlite;
  let db: TestDb;
  let ws: string;
  let jobId: string;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
    const [w] = await db.insert(workspaces).values({ name: "Proof" }).returning();
    ws = w.id;
    const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId: p.id, status: "generating" }).returning();
    jobId = job.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("stores the record, the per output proofs and the digital source", async () => {
    const fidelity = {
      meanDeltaE: 0.84,
      maxDeltaE: 3.2,
      exactByteShare: 0.41,
      maskArea: 52000,
      threshold: 5,
      maxDeltaELimit: 10,
      kind: "other" as const,
      exact: false,
    };
    const store = new DbJobStore(db as unknown as Db);
    await store.saveAsset({
      jobId,
      workspaceId: ws,
      shotId: "s01_lifestyle",
      shotType: "lifestyle",
      specId: "shopify.product",
      status: "passed",
      attempts: 1,
      credits: 3,
      costMicros: 0,
      verdict: passVerdict,
      measured: { fillPct: 64, background: null },
      fidelity,
      outputs: [
        { specId: "shopify.product", fidelity, checks: [{ name: "dimensions", pass: true, measured: "2048x2048", limit: "2048x2048 to 4472x4472" }] },
      ],
      digitalSource: "composite",
    });
    await store.saveAsset({
      jobId,
      workspaceId: ws,
      shotId: "s02_amazon_main",
      shotType: "amazon_main",
      specId: "amazon.main",
      status: "passed",
      attempts: 1,
      credits: 1,
      costMicros: 0,
      verdict: passVerdict,
      measured: { fillPct: 87, background: [255, 255, 255] },
    });
    const rows = await db.select().from(assets).where(and(eq(assets.jobId, jobId), eq(assets.workspaceId, ws)));
    const lifestyle = rows.find((r) => r.shotType === "lifestyle");
    expect(lifestyle?.qc).toMatchObject({
      fidelity,
      outputs: [{ specId: "shopify.product", fidelity }],
      digitalSource: "composite",
    });
    // An asset saved without numbers says so with null, not a missing key.
    const main = rows.find((r) => r.shotType === "amazon_main");
    expect(main?.qc?.fidelity).toBeNull();
    expect(main?.qc).not.toHaveProperty("outputs");
  });
});

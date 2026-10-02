import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "./client";
import { packFidelitySummary } from "./fidelity-summary";
import { assets, assetVariants, channelSpecs, generationJobs, products, workspaces } from "./schema";
import { createTestDb, type TestDb } from "./test-helpers";

// P18-08: the pack fidelity summary reads the measured numbers the runner
// stores on each asset (qc.outputs) for the files the pack delivers only.

let client: PGlite;
let db: TestDb;
let reader: Db;
let wsA: string;
let wsB: string;
let productA: string;

function fidelity(mean: number, max: number, threshold = 3) {
  return {
    meanDeltaE: mean,
    maxDeltaE: max,
    exactByteShare: 0.4,
    maskArea: 1000,
    threshold,
    maxDeltaELimit: 10,
    kind: threshold === 3 ? "main" : "other",
    exact: false,
  };
}

async function newJob(): Promise<string> {
  const [job] = await db.insert(generationJobs).values({ workspaceId: wsA, productId: productA, status: "done" }).returning();
  return job.id;
}

async function addAsset(
  jobId: string,
  opts: { approved?: boolean; qc: Record<string, unknown>; files: Array<{ specId: string; picked?: boolean }> },
): Promise<void> {
  const [asset] = await db
    .insert(assets)
    .values({ workspaceId: wsA, jobId, shotType: "lifestyle", approved: opts.approved ?? true, qc: opts.qc })
    .returning();
  for (const file of opts.files) {
    await db.insert(assetVariants).values({
      workspaceId: wsA,
      assetId: asset.id,
      channelSpecId: file.specId,
      r2Key: `ws/${wsA}/jobs/${jobId}/${file.specId}.png`,
      filename: `${file.specId}.png`,
      picked: file.picked ?? true,
    });
  }
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  reader = db as unknown as Db;
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  wsB = b.id;
  await db.insert(channelSpecs).values([
    { id: "test.main_p18", version: 1, spec: {} },
    { id: "test.scene_p18", version: 1, spec: {} },
  ]);
  const [product] = await db.insert(products).values({ workspaceId: wsA, title: "Bottle", mode: "listing" }).returning();
  productA = product.id;
});

afterAll(async () => {
  await client.close();
});

describe("packFidelitySummary", () => {
  it("takes the highest mean across the delivered files and counts them", async () => {
    const jobId = await newJob();
    await addAsset(jobId, {
      qc: {
        fidelity: fidelity(0.4, 2.1),
        outputs: [
          { specId: "test.main_p18", fidelity: fidelity(0.4, 2.1), checks: [] },
          { specId: "test.scene_p18", fidelity: fidelity(1.27, 4.5, 5), checks: [] },
        ],
      },
      files: [{ specId: "test.main_p18" }, { specId: "test.scene_p18" }],
    });
    // A template shot with no product reference ships a file with no numbers.
    await addAsset(jobId, {
      qc: { fidelity: null, outputs: [{ specId: "test.main_p18", fidelity: null, checks: [] }] },
      files: [{ specId: "test.main_p18" }],
    });
    expect(await packFidelitySummary(reader, { jobId, workspaceId: wsA })).toEqual({
      deliveredFiles: 3,
      measuredFiles: 2,
      highestMeanDeltaE: 1.27,
      highestMaxDeltaE: 4.5,
      allWithinLimits: true,
    });
  });

  it("leaves out unpicked versions, assets that were not delivered, and other workspaces", async () => {
    const jobId = await newJob();
    await addAsset(jobId, {
      qc: { outputs: [{ specId: "test.main_p18", fidelity: fidelity(0.5, 1), checks: [] }] },
      files: [{ specId: "test.main_p18" }],
    });
    await addAsset(jobId, {
      qc: { outputs: [{ specId: "test.scene_p18", fidelity: fidelity(4.9, 9, 5), checks: [] }] },
      files: [{ specId: "test.scene_p18", picked: false }],
    });
    await addAsset(jobId, {
      approved: false,
      qc: { outputs: [{ specId: "test.main_p18", fidelity: fidelity(2.9, 9), checks: [] }] },
      files: [{ specId: "test.main_p18" }],
    });
    expect(await packFidelitySummary(reader, { jobId, workspaceId: wsA })).toMatchObject({
      deliveredFiles: 1,
      measuredFiles: 1,
      highestMeanDeltaE: 0.5,
    });
    expect(await packFidelitySummary(reader, { jobId, workspaceId: wsB })).toEqual({
      deliveredFiles: 0,
      measuredFiles: 0,
      highestMeanDeltaE: null,
      highestMaxDeltaE: null,
      allWithinLimits: true,
    });
  });

  it("reads a pack made before Phase 18 as delivered with nothing measured", async () => {
    const jobId = await newJob();
    await addAsset(jobId, { qc: { pass: true, fillPct: 87 }, files: [{ specId: "test.main_p18" }] });
    expect(await packFidelitySummary(reader, { jobId, workspaceId: wsA })).toMatchObject({
      deliveredFiles: 1,
      measuredFiles: 0,
      highestMeanDeltaE: null,
    });
  });

  it("counts only the output whose spec matches the delivered file, and flags a file outside its limits", async () => {
    const jobId = await newJob();
    await addAsset(jobId, {
      qc: {
        outputs: [
          { specId: "test.main_p18", fidelity: fidelity(3.4, 6), checks: [] },
          { specId: "test.scene_p18", fidelity: fidelity(0.1, 1, 5), checks: [] },
        ],
      },
      files: [{ specId: "test.main_p18" }],
    });
    expect(await packFidelitySummary(reader, { jobId, workspaceId: wsA })).toMatchObject({
      measuredFiles: 1,
      highestMeanDeltaE: 3.4,
      allWithinLimits: false,
    });
  });
});

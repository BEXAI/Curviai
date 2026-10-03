/**
 * Scene variations through DbJobStore against the real migrations in PGlite
 * (docs/phases/PHASE_16.md workstream 6): the extra versions' files are
 * uploaded under their own keys and recorded with picked false, the pack's
 * own files with picked true, and each extra version is charged exactly
 * creditCosts.generativeStill.
 */

import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { assetVariants, assets, creditLedger, generationJobs, products, workspaces } from "@curvi/db/schema";
import { endExiftool } from "@curvi/pipeline";
import { normalizeOutputOptions, resolveOutputOptions } from "@curvi/pipeline/output-options";
import { creditCosts, stillStyle } from "@curvi/pipeline/seed";
import { parseVariationShotId } from "@curvi/pipeline/variations";
import { DbJobStore } from "./db-store";
import { runGeneratePack, systemClock, type GeneratePackInput } from "./pipeline-runner";
import type { PackUploader } from "./r2";
import { buildRuntimeDeps } from "./runtime";

let client: PGlite;
let db: TestDb;
let ws: string;
let jobId: string;

const GRANT = 200;
const BUDGET = 80;

class FakeUploader implements PackUploader {
  readonly bucket = "test-bucket";
  readonly keys: string[] = [];

  async upload(localPath: string, key: string): Promise<{ bytes: number }> {
    this.keys.push(key);
    return { bytes: (await stat(localPath)).size };
  }
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Versions", plan: "growth" }).returning();
  ws = w.id;
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Ceramic mug", mode: "listing" }).returning();
  const [j] = await db.insert(generationJobs).values({ workspaceId: ws, productId: p.id, status: "queued" }).returning();
  jobId = j.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: GRANT, reason: "grant", source: "system" });
  await client.query("select reserve_credits($1, $2, $3)", [ws, BUDGET, jobId]);
});

afterAll(async () => {
  await endExiftool();
  await client.close();
});

describe("scene versions in DbJobStore", () => {
  const uploader = new FakeUploader();

  it("stores extra versions unpicked under their own keys and charges each at the seed price", async () => {
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader });
    const output = resolveOutputOptions(normalizeOutputOptions({ variations: 2 }), {
      colorHex: stillStyle.whiteHex,
      brandSweepHex: stillStyle.whiteHex,
      keepMediaIds: [],
    });
    const input: GeneratePackInput = {
      jobId,
      workspaceId: ws,
      tier: "growth",
      channels: ["amazon", "shopify"],
      creditBudget: BUDGET,
      images: [{ mediaId: "m1" }],
      sku: "MUG1",
      seoSlug: "ceramic-mug",
      mode: "listing",
      output,
    };
    const summary = await runGeneratePack(input, { ...buildRuntimeDeps(), store, clock: systemClock });
    expect(summary.state).toBe("done");

    const assetRows = await db.select().from(assets).where(eq(assets.jobId, jobId));
    const shotOf = new Map(assetRows.map((a) => [a.id, String(a.qc?.shotId ?? "")]));
    const variantRows = await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws));
    const extra = variantRows.filter((v) => parseVariationShotId(shotOf.get(v.assetId) ?? "") !== null);
    const own = variantRows.filter((v) => parseVariationShotId(shotOf.get(v.assetId) ?? "") === null);
    expect(extra.length).toBeGreaterThan(0);
    expect(own.length).toBeGreaterThan(0);
    expect(extra.every((v) => v.picked === false)).toBe(true);
    expect(own.every((v) => v.picked === true)).toBe(true);
    expect(extra.every((v) => v.r2Key.startsWith(`ws/${ws}/jobs/${jobId}/files/`) && v.r2Key.includes("/variation-2-run-"))).toBe(true);
    // No file overwrites another.
    expect(new Set(variantRows.map((v) => v.r2Key)).size).toBe(variantRows.length);

    const charges = await db.select().from(creditLedger).where(eq(creditLedger.jobId, jobId));
    const versionCharges = charges.filter(
      (c) => c.reason === "charge" && c.stepKey !== null && parseVariationShotId(c.stepKey) !== null,
    );
    const extraAssets = new Set(extra.map((v) => v.assetId));
    expect(versionCharges).toHaveLength(extraAssets.size);
    for (const charge of versionCharges) {
      expect(-Number(charge.delta)).toBe(creditCosts.generativeStill);
    }
  });
});

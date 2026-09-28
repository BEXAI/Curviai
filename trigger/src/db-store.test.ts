/**
 * DbJobStore against the real migrations in PGlite: a full runGeneratePack
 * must move the generation_jobs row to done, convert the web layer's
 * reservation into per asset charges keyed by shot id, release the remainder,
 * persist assets and job_steps for the progress board, and record uploaded
 * asset_variants and pack_files rows. This is the settlement path the plan
 * describes in 4.4: reserve at queue, charge per passing asset, release the
 * rest.
 */

import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import {
  assetVariants,
  assets,
  creditLedger,
  generationJobs,
  jobSteps,
  packFiles,
  products,
  workspaces,
} from "@curvi/db/schema";
import { endExiftool } from "@curvi/pipeline";
import { DbJobStore } from "./db-store";
import { runGeneratePack, systemClock, type GeneratePackInput } from "./pipeline-runner";
import { buildRuntimeDeps } from "./runtime";
import type { PackUploader } from "./r2";

let client: PGlite;
let db: TestDb;
let ws: string;
let jobId: string;

const GRANT = 100;
const BUDGET = 20;

class FakeUploader implements PackUploader {
  readonly bucket = "test-bucket";
  readonly uploads: Array<{ localPath: string; key: string; bytes: number }> = [];

  async upload(localPath: string, key: string): Promise<{ bytes: number }> {
    const info = await stat(localPath);
    this.uploads.push({ localPath, key, bytes: info.size });
    return { bytes: info.size };
  }
}

async function balance(): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>(
    "select credit_balance($1)",
    [ws],
  );
  return Number(result.rows[0].credit_balance);
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Settle", plan: "starter" }).returning();
  ws = w.id;
  const [p] = await db
    .insert(products)
    .values({ workspaceId: ws, title: "Ceramic mug", mode: "listing" })
    .returning();
  const [j] = await db
    .insert(generationJobs)
    .values({ workspaceId: ws, productId: p.id, status: "queued" })
    .returning();
  jobId = j.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: GRANT, reason: "grant", source: "system" });
  // The web layer reserves at job creation; the store treats reserve as handled.
  await client.query("select reserve_credits($1, $2, $3)", [ws, BUDGET, jobId]);
});

afterAll(async () => {
  await endExiftool();
  await client.close();
});

describe("DbJobStore settles a pack run end to end", () => {
  const uploader = new FakeUploader();
  let summaryCharged = 0;

  it("runs the pack to done and persists everything", async () => {
    const store = new DbJobStore(db as unknown as Db, {
      reserveHandledExternally: true,
      uploader,
    });
    const deps = { ...buildRuntimeDeps(), store, clock: systemClock };
    const input: GeneratePackInput = {
      jobId,
      workspaceId: ws,
      tier: "starter",
      channels: ["amazon", "shopify"],
      creditBudget: BUDGET,
      images: [{ mediaId: "m1" }],
      sku: "MUG1",
      seoSlug: "ceramic-mug",
      mode: "listing",
    };
    const summary = await runGeneratePack(input, deps);
    expect(summary.state).toBe("done");
    expect(summary.chargedCredits).toBeGreaterThan(0);
    expect(summary.chargedCredits + summary.releasedCredits).toBe(summary.reservedCredits);
    summaryCharged = summary.chargedCredits;

    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    expect(job.status).toBe("done");
    expect(job.creditsReserved).toBe(BUDGET);
    expect(job.creditsCharged).toBe(summary.chargedCredits);
  });

  it("converts the reservation into charges and releases, no credits stranded", async () => {
    // Balance ends at grant minus what was actually charged: the reservation
    // hold was fully settled, nothing leaks into a permanently held state.
    expect(await balance()).toBe(GRANT - summaryCharged);
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, jobId));
    const charges = rows.filter((r) => r.reason === "charge");
    expect(charges.length).toBeGreaterThan(0);
    // Every charge is keyed by its shot id for idempotent retries.
    expect(charges.every((r) => typeof r.stepKey === "string" && r.stepKey.length > 0)).toBe(true);
    const held = rows
      .filter((r) => r.reason === "reserve" || r.reason === "release")
      .reduce((sum, r) => sum - r.delta, 0);
    expect(held).toBe(0);
  });

  it("persists assets and job_steps for the progress board", async () => {
    const assetRows = await db.select().from(assets).where(eq(assets.jobId, jobId));
    expect(assetRows.length).toBeGreaterThan(0);
    expect(assetRows.every((a) => a.workspaceId === ws)).toBe(true);
    expect(assetRows.every((a) => typeof a.qc?.shotId === "string")).toBe(true);
    const stepRows = await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId));
    // One final row per stored asset; the plan's pending and skipped rows
    // (savePlan) come on top of those.
    const finalRows = stepRows.filter((s) => s.status === "done" || s.status === "needs_review");
    expect(finalRows.length).toBe(assetRows.length);
  });

  it("uploads and records asset variants and pack files", async () => {
    const variantRows = await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws));
    expect(variantRows.length).toBeGreaterThan(0);
    expect(variantRows.every((v) => v.r2Key.startsWith(`ws/${ws}/jobs/${jobId}/files/`))).toBe(true);
    expect(variantRows.every((v) => (v.bytes ?? 0) > 0)).toBe(true);

    const packRows = await db.select().from(packFiles).where(eq(packFiles.jobId, jobId));
    const zips = packRows.filter((f) => f.kind === "zip");
    const reports = packRows.filter((f) => f.kind === "report");
    expect(zips.length).toBeGreaterThan(0);
    expect(reports.length).toBe(1);
    expect(uploader.uploads.length).toBe(variantRows.length + packRows.length);
  });

  it("marks a failed run and returns the remaining hold", async () => {
    const [p] = await db.select().from(products).where(eq(products.workspaceId, ws));
    const [j2] = await db
      .insert(generationJobs)
      .values({ workspaceId: ws, productId: p.id, status: "queued" })
      .returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 10, j2.id]);
    const before = await balance();

    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true });
    const deps = { ...buildRuntimeDeps(), store, clock: systemClock };
    const failing = {
      ...deps,
      generator: {
        generate: async () => {
          throw new Error("provider exploded");
        },
      },
    };
    const summary = await runGeneratePack(
      {
        jobId: j2.id,
        workspaceId: ws,
        tier: "starter",
        channels: ["amazon"],
        creditBudget: 10,
        images: [{ mediaId: "m1" }],
      },
      failing,
    );
    expect(summary.state).toBe("failed");
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, j2.id));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("provider exploded");
    // The whole reservation came back.
    expect(await balance()).toBe(before + 10);
  });
});

describe("DbJobStore guards live pack runs", () => {
  async function newJob(reserve: number): Promise<string> {
    const [p] = await db.select().from(products).where(eq(products.workspaceId, ws));
    const [j] = await db
      .insert(generationJobs)
      .values({ workspaceId: ws, productId: p.id, status: "queued" })
      .returning();
    if (reserve > 0) {
      await client.query("select reserve_credits($1, $2, $3)", [ws, reserve, j.id]);
    }
    return j.id;
  }

  const packInput = (id: string): GeneratePackInput => ({
    jobId: id,
    workspaceId: ws,
    tier: "starter",
    channels: ["amazon"],
    creditBudget: 10,
    images: [{ mediaId: "m1" }],
    mode: "listing",
  });

  it("refuses to move a terminal job and leaves heartbeats off it", async () => {
    const id = await newJob(0);
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true });
    await db.update(generationJobs).set({ status: "failed" }).where(eq(generationJobs.id, id));
    const [before] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));

    expect(await store.setJobState(id, "qc")).toBe(false);
    expect(await store.heartbeat(id)).toBe(false);

    const [after] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
    expect(after.status).toBe("failed");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("heartbeats a live job", async () => {
    const id = await newJob(0);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(generationJobs).set({ status: "generating", updatedAt: old }).where(eq(generationJobs.id, id));
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true });
    expect(await store.heartbeat(id)).toBe(true);
    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
    expect(row.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    expect(row.status).toBe("generating");
  });

  it("charges nothing for a job the reconciler already failed and released", async () => {
    const id = await newJob(10);
    const startBalance = await balance();
    // What the web reconciler does to a stale job.
    await db.update(generationJobs).set({ status: "failed" }).where(eq(generationJobs.id, id));
    await client.query("select release_credits($1, $2)", [ws, id]);
    const afterReconcile = await balance();
    expect(afterReconcile).toBe(startBalance + 10);

    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader: new FakeUploader() });
    const summary = await runGeneratePack(packInput(id), { ...buildRuntimeDeps(), store, clock: systemClock });

    expect(summary.state).toBe("failed");
    expect(await balance()).toBe(afterReconcile);
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, id));
    expect(rows.filter((r) => r.reason === "charge")).toHaveLength(0);
    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
    expect(row.status).toBe("failed");
  });

  it("fails the run and returns the hold when the pack cannot be stored", async () => {
    const id = await newJob(10);
    const held = await balance();
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader: null });
    const summary = await runGeneratePack(packInput(id), { ...buildRuntimeDeps(), store, clock: systemClock });

    expect(summary.state).toBe("failed");
    expect(summary.error).toContain("Pack storage is not configured");
    expect(await balance()).toBe(held + 10);
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, id));
    expect(rows.filter((r) => r.reason === "charge")).toHaveLength(0);
  });
});

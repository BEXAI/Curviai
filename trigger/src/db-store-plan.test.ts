/**
 * What the progress board reads from job_steps (Update.md 3.5 and the job
 * board truth finding): a shot that did not pass is stored as needs_review,
 * never failed, and the plan lands as pending and skipped rows before any
 * shot finishes, so the board can list the whole pack from the start.
 */

import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, type Db } from "@curvi/db";
import { creditLedger, generationJobs, jobSteps, products, workspaces } from "@curvi/db/schema";
import { endExiftool } from "@curvi/pipeline";
import type { Shot } from "@curvi/pipeline/schemas";
import { DbJobStore } from "./db-store";
import { runGeneratePack, systemClock, type GeneratePackInput, type StoredAsset } from "./pipeline-runner";
import type { PackUploader } from "./r2";
import { buildRuntimeDeps } from "./runtime";

let client: PGlite;
let db: TestDb;
let ws: string;
let productId: string;

class FakeUploader implements PackUploader {
  readonly bucket = "test-bucket";
  async upload(localPath: string): Promise<{ bytes: number }> {
    return { bytes: (await stat(localPath)).size };
  }
}

async function newJob(): Promise<string> {
  const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "queued" }).returning();
  return job.id;
}

function shot(id: string, type: Shot["type"], method: Shot["method"]): Shot {
  return {
    id,
    type,
    sourceMediaId: "m1",
    method,
    channels: ["amazon.secondary"],
    stylePreset: "none",
    credits: 1,
    priority: 1,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Board", plan: "starter" }).returning();
  ws = w.id;
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  productId = p.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 100, reason: "grant", source: "system" });
});

afterAll(async () => {
  await endExiftool();
  await client.close();
});

describe("DbJobStore.saveAsset step status", () => {
  it("stores a shot that did not pass as needs_review, not failed", async () => {
    const jobId = await newJob();
    const store = new DbJobStore(db as unknown as Db);
    const asset: StoredAsset = {
      jobId,
      workspaceId: ws,
      shotId: "s01_lifestyle",
      shotType: "lifestyle",
      specId: "amazon.secondary",
      status: "needs_review",
      attempts: 3,
      credits: 1,
      costMicros: 0,
      verdict: { pass: false, fidelity: 0, issues: ["other"], repairHint: "Fix failed checks: fill" },
      measured: { fillPct: null, background: null },
    };
    await store.saveAsset(asset);
    await store.saveAsset({ ...asset, shotId: "s02_amazon_main", shotType: "amazon_main", status: "passed" });

    const steps = await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId));
    const byShot = new Map(steps.map((s) => [s.shotId, s.status]));
    expect(byShot.get("s01_lifestyle")).toBe("needs_review");
    expect(byShot.get("s02_amazon_main")).toBe("done");
    expect(steps.some((s) => s.status === "failed")).toBe(false);
  });
});

describe("DbJobStore.savePlan", () => {
  it("writes a pending row per planned shot and a skipped row with its reason", async () => {
    const jobId = await newJob();
    const store = new DbJobStore(db as unknown as Db);
    await store.savePlan({
      jobId,
      workspaceId: ws,
      shots: [shot("s01_amazon_main", "amazon_main", "deterministic"), shot("s02_lifestyle", "lifestyle", "composite_generate")],
      skipped: [
        { type: "in_the_box", reason: "seller did not list contents" },
        { type: "video_hero_6s", reason: "provider not enabled" },
      ],
    });

    const pending = await db
      .select()
      .from(jobSteps)
      .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.status, "pending")));
    expect(pending.map((s) => s.shotId).sort()).toEqual(["s01_amazon_main", "s02_lifestyle"]);
    expect(pending.find((s) => s.shotId === "s02_lifestyle")?.provider).toBe("image model");
    expect(pending.find((s) => s.shotId === "s01_amazon_main")?.stage).toBe("amazon_main");

    const skipped = await db
      .select()
      .from(jobSteps)
      .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.status, "skipped")));
    expect(skipped).toHaveLength(2);
    expect(skipped.map((s) => s.stage).sort()).toEqual(["in_the_box", "video_hero_6s"]);
    expect(skipped.find((s) => s.stage === "in_the_box")?.error).toBe("seller did not list contents");
    expect(new Set(skipped.map((s) => s.shotId)).size).toBe(2);
  });

  it("never throws, even when the rows cannot be written", async () => {
    const store = new DbJobStore(db as unknown as Db);
    await expect(
      store.savePlan({
        jobId: "00000000-0000-4000-8000-00000000beef",
        workspaceId: ws,
        shots: [shot("s01_amazon_main", "amazon_main", "deterministic")],
        skipped: [],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("runGeneratePack records the plan", () => {
  it("lists every planned and skipped shot, and every planned shot ends with a final row", async () => {
    const jobId = await newJob();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 20, jobId]);
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader: new FakeUploader() });
    const input: GeneratePackInput = {
      jobId,
      workspaceId: ws,
      tier: "starter",
      channels: ["amazon", "shopify"],
      creditBudget: 20,
      images: [{ mediaId: "m1" }],
      sku: "MUG1",
      seoSlug: "mug",
      mode: "listing",
    };
    const summary = await runGeneratePack(input, { ...buildRuntimeDeps(), store, clock: systemClock });

    const steps = await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId));
    const pending = steps.filter((s) => s.status === "pending");
    const skipped = steps.filter((s) => s.status === "skipped");
    expect(pending.length).toBe(summary.plannedShots);
    expect(skipped.length).toBe(summary.skipped.length);
    for (const planned of pending) {
      const final = steps.find(
        (s) => s.shotId === planned.shotId && (s.status === "done" || s.status === "needs_review"),
      );
      expect(final, `shot ${planned.shotId} has a final row`).toBeDefined();
    }
  });
});

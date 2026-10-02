/**
 * Run keys on DbJobStore against the real migrations in PGlite (0019): a
 * store bound to a run that no longer owns the job is refused by every
 * liveness check, state write, delivery check and ledger write, even while
 * the job is live under a newer run; the live run's store works as before;
 * and a row or payload without a run key (queued before 0019) falls back to
 * the status check alone.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { creditLedger, generationJobs, packFiles, products, workspaces } from "@curvi/db/schema";
import { DbJobStore } from "./db-store";
import { JobAbandonedError } from "./pipeline-runner";
import type { PackUploader } from "./r2";

let client: PGlite;
let db: TestDb;
let ws: string;
let productId: string;

class FakeUploader implements PackUploader {
  readonly bucket = "test-bucket";
  onUpload: (() => Promise<void>) | null = null;
  async upload(): Promise<{ bytes: number }> {
    await this.onUpload?.();
    return { bytes: 1 };
  }
}

function store(uploader: PackUploader = new FakeUploader()): DbJobStore {
  return new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader });
}

async function newJob(status: string, runKey: string | null, hold = 5): Promise<string> {
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: ws, productId, status: status as "generating", runKey })
    .returning();
  if (hold > 0) {
    await client.query("select reserve_credits($1, $2, $3)", [ws, hold, job.id]);
  }
  return job.id;
}

async function held(jobId: string): Promise<number> {
  const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, jobId));
  return rows.filter((r) => r.reason === "reserve" || r.reason === "release").reduce((s, r) => s - r.delta, 0);
}

async function charges(jobId: string): Promise<number> {
  const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, jobId));
  return rows.filter((r) => r.reason === "charge").length;
}

async function row(jobId: string) {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return job;
}

async function emptyPack(): Promise<{ outDir: string; reportPath: string }> {
  const outDir = await mkdtemp(path.join(tmpdir(), "curvi-run-key-"));
  const reportPath = path.join(outDir, "compliance-report.json");
  await writeFile(reportPath, JSON.stringify({ files: [] }));
  return { outDir, reportPath };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Run keys", plan: "starter" }).returning();
  ws = w.id;
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  productId = p.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 100, reason: "grant", source: "system" });
});

afterAll(async () => {
  await client.close();
});

describe("DbJobStore bound to a run that lost the job", () => {
  it("refuses every check and write while the job is live under another run", async () => {
    const jobId = await newJob("generating", "run-new");
    const stale = store().forRun("run-old");

    expect(await stale.heartbeat(jobId)).toBe(false);
    expect(await stale.setJobState(jobId, "done", { costMicros: 10 })).toBe(false);
    expect((await row(jobId)).status).toBe("generating");

    const at = new Date();
    await expect(
      stale.appendLedger({ reason: "charge", credits: 1, ref: "s01", note: "test", jobId, workspaceId: ws, at }),
    ).rejects.toBeInstanceOf(JobAbandonedError);
    await expect(
      stale.appendLedger({ reason: "release", credits: 1, note: "test", jobId, workspaceId: ws, at }),
    ).rejects.toBeInstanceOf(JobAbandonedError);
    await stale.releaseAllHeld(jobId, ws);
    expect(await charges(jobId)).toBe(0);
    expect(await held(jobId)).toBe(5);

    const pack = await emptyPack();
    await expect(
      stale.savePack({ jobId, workspaceId: ws, outDir: pack.outDir, channels: [], files: 0, reportPath: pack.reportPath }),
    ).rejects.toBeInstanceOf(JobAbandonedError);
    await expect(
      stale.saveFollowUpFiles({ jobId, workspaceId: ws, runKey: "run-old", outDir: pack.outDir, files: [] }),
    ).rejects.toBeInstanceOf(JobAbandonedError);
    expect(await db.select().from(packFiles).where(eq(packFiles.jobId, jobId))).toHaveLength(0);

    // The run that owns the job works as before.
    const live = store().forRun("run-new");
    expect(await live.heartbeat(jobId)).toBe(true);
    await live.appendLedger({ reason: "charge", credits: 1, ref: "s01", note: "test", jobId, workspaceId: ws, at });
    expect(await charges(jobId)).toBe(1);
    await live.releaseAllHeld(jobId, ws);
    expect(await held(jobId)).toBe(0);
    expect(await live.setJobState(jobId, "done")).toBe(true);
    // Terminal now, so even the owning run is refused.
    expect(await live.heartbeat(jobId)).toBe(false);
  });

  it("records nothing when the run loses the job while the pack uploads", async () => {
    const jobId = await newJob("packaging", "run-a", 0);
    const uploader = new FakeUploader();
    // A cancel and a new run take the job over mid upload.
    uploader.onUpload = async () => {
      await db.update(generationJobs).set({ runKey: "run-b" }).where(eq(generationJobs.id, jobId));
    };
    const pack = await emptyPack();
    await expect(
      store(uploader)
        .forRun("run-a")
        .savePack({ jobId, workspaceId: ws, outDir: pack.outDir, channels: [], files: 0, reportPath: pack.reportPath }),
    ).rejects.toBeInstanceOf(JobAbandonedError);
    expect(await db.select().from(packFiles).where(eq(packFiles.jobId, jobId))).toHaveLength(0);
  });

  it("falls back to the status check for rows and payloads without a run key", async () => {
    // A job queued before 0019: its row has no key.
    const legacyRow = await newJob("generating", null, 0);
    expect(await store().forRun("run-x").heartbeat(legacyRow)).toBe(true);
    // A payload queued before 0019: its runner has no key.
    const keyedRow = await newJob("generating", "run-y", 0);
    expect(await store().heartbeat(keyedRow)).toBe(true);
    await db.update(generationJobs).set({ status: "failed" }).where(eq(generationJobs.id, keyedRow));
    expect(await store().heartbeat(keyedRow)).toBe(false);
  });

  it("saves the seller intent only for the run that owns a live job (0020)", async () => {
    const intent = { featureOnly: "blue bottle", exclude: ["red bottle"], mustKeep: [], styleNotes: null };
    const jobId = await newJob("analyzing", "run-b", 0);
    // A stale run writes nothing.
    await store().forRun("run-a").saveSellerIntent(jobId, intent);
    expect((await row(jobId)).sellerIntent).toBeNull();
    // The live run records it.
    await store().forRun("run-b").saveSellerIntent(jobId, intent);
    expect((await row(jobId)).sellerIntent).toEqual(intent);
    // A terminal job keeps what it had.
    await db.update(generationJobs).set({ status: "failed" }).where(eq(generationJobs.id, jobId));
    await store().forRun("run-b").saveSellerIntent(jobId, { ...intent, featureOnly: "red bottle" });
    expect((await row(jobId)).sellerIntent).toEqual(intent);
  });

  it("saves the inventory only for the run that owns a live job (0021)", async () => {
    const inventory = {
      version: 1 as const,
      photos: [
        {
          mediaId: "ws/a/src/p1",
          items: [
            {
              label: "blue tall object",
              labelSource: "deterministic" as const,
              box: { x: 0.5, y: 0.1, width: 0.3, height: 0.6 },
              areaShare: 0.18,
              aspectRatio: 2,
              shape: "tall" as const,
              colorHex: "#1e28c8",
              colorName: "blue" as const,
              status: "featured" as const,
            },
          ],
          intakeCount: 1,
          countMatch: true,
          unmatchedItems: [],
          unmatchedProducts: [],
          rule: "single_object" as const,
          touching: false,
        },
      ],
    };
    const jobId = await newJob("analyzing", "run-b", 0);
    await store().forRun("run-a").saveInventory(jobId, inventory);
    expect((await row(jobId)).inventory).toBeNull();
    await store().forRun("run-b").saveInventory(jobId, inventory);
    expect((await row(jobId)).inventory).toEqual(inventory);
    await db.update(generationJobs).set({ status: "failed" }).where(eq(generationJobs.id, jobId));
    await store().forRun("run-b").saveInventory(jobId, { version: 1, photos: [] });
    expect((await row(jobId)).inventory).toEqual(inventory);
  });
});


describe("metered cost across process runs", () => {
  it("adds different runs, ignores duplicate reports, and includes late fenced cost", async () => {
    const id = await newJob("generating", "first", 0);
    await store().forRun("first").setJobState(id, "generating", { costMicros: 100 });
    await db.update(generationJobs).set({ runKey: "second" }).where(eq(generationJobs.id, id));
    await store().forRun("second").setJobState(id, "generating", { costMicros: 60 });
    expect((await row(id)).cogsMicros).toBe(160);
    expect(await store().forRun("first").setJobState(id, "done", { costMicros: 130 })).toBe(false);
    await store().forRun("second").setJobState(id, "done", { costMicros: 60 });
    await store().forRun("first").setJobState(id, "failed", { costMicros: 120 });
    expect(await row(id)).toMatchObject({ cogsMicros: 190, status: "done", runnerId: null, restartPayload: null });
    expect((await row(id)).finishedAt).toBeInstanceOf(Date);
  });
  it("does not count the previous pack cost again for a followup", async () => {
    const id = await newJob("generating", "pack", 0);
    await store().forRun("pack").setJobState(id, "done", { costMicros: 100 });
    await db.update(generationJobs).set({ status: "generating", runKey: "followup" }).where(eq(generationJobs.id, id));
    await store().forRun("followup").setJobState(id, "done", { costMicros: 125, baseCostMicros: 100 });
    expect((await row(id)).cogsMicros).toBe(125);
  });
});

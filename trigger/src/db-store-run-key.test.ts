/**
 * Run keys on DbJobStore against the real migrations in PGlite (0019): a
 * store bound to a run that no longer owns the job is refused by every
 * liveness check, state write, delivery check and ledger write, even while
 * the job is live under a newer run; the live run's store works as before;
 * and a legacy payload without a run key can finish only a row whose key
 * is still null, never a replacement that has acquired a key.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { assetVariants, assets, creditLedger, generationJobs, jobSteps, packFiles, products, workspaces } from "@curvi/db/schema";
import { DbJobStore } from "./db-store";
import { JobAbandonedError, type StoredAsset, type StoredPack } from "./pipeline-runner";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function packWithFiles(jobId: string, run: string): Promise<StoredPack> {
  const outDir = await mkdtemp(path.join(tmpdir(), "curvi-run-objects-"));
  const variationDir = path.join(outDir, "variations", "v2");
  await mkdir(path.join(outDir, "files", "shopify"), { recursive: true });
  await mkdir(path.join(variationDir, "files", "shopify"), { recursive: true });
  const reportPath = path.join(outDir, "compliance-report.json");
  const file = { file: "product.jpg", channel: "shopify", specId: "shopify.product", ref: "s1", measured: { width: 1, height: 1 } };
  await Promise.all([
    writeFile(path.join(outDir, "files", "shopify", file.file), `${run} image`),
    writeFile(path.join(variationDir, "files", "shopify", file.file), `${run} version`),
    writeFile(path.join(outDir, "shopify.zip"), `${run} zip`),
    writeFile(reportPath, JSON.stringify({ run, files: [file] })),
  ]);
  return {
    jobId, workspaceId: ws, outDir, reportPath, channels: ["shopify"], files: 1,
    variations: [{ variation: 2, outDir: variationDir, files: [{ ...file, ref: "s1-v2", width: 1, height: 1 }] }],
  };
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
  it.each(["run-old", null])("refuses every check and write from %s while another run owns the live job", async (oldRunKey) => {
    const jobId = await newJob("generating", "run-new");
    const stale = oldRunKey ? store().forRun(oldRunKey) : store();

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

    await stale.saveRecipeVariants(jobId, { plan: { recipeId: null, version: 1, source: "seed" } });
    await stale.savePlan({ jobId, workspaceId: ws, shots: [], skipped: [{ type: "lifestyle", reason: "old plan" }] });
    const replacementAsset: StoredAsset = {
      jobId, workspaceId: ws, shotId: "s01", shotType: "lifestyle", specId: "shopify.product",
      status: "passed", attempts: 1, credits: 1, costMicros: 0,
      verdict: { pass: true, fidelity: 1, issues: [], repairHint: "" },
      measured: { fillPct: null, background: null },
    };
    await stale.saveAsset(replacementAsset);
    expect(await db.select().from(assets).where(eq(assets.jobId, jobId))).toHaveLength(0);
    expect(await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))).toHaveLength(0);
    expect((await row(jobId)).recipeVariants).toBeNull();
    await store().forRun("run-new").saveAsset(replacementAsset);
    await stale.markShotUndelivered({ jobId, workspaceId: ws, shotId: "s01", shotType: "lifestyle", reason: "old pack omitted shot" });
    const [untouched] = await db.select().from(assets).where(eq(assets.jobId, jobId));
    expect(untouched).toMatchObject({ approved: true, qc: { status: "passed" } });
    expect(await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))).toHaveLength(1);

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

  it.each(["run-old", null])("rejects a delayed %s upload and settlement while the replacement is still packaging", async (oldRunKey) => {
    const jobId = await newJob("packaging", oldRunKey, 5);
    const oldPack = await packWithFiles(jobId, "old");
    const newPack = await packWithFiles(jobId, "new");
    const makeAssets = () => db.insert(assets).values([
      { workspaceId: ws, jobId, shotType: "lifestyle", approved: true, qc: { shotId: "s1" } },
      { workspaceId: ws, jobId, shotType: "lifestyle", approved: true, qc: { shotId: "s1-v2" } },
    ]).returning();
    const oldAssets = await makeAssets();
    const paused = deferred();
    const resume = deferred();
    const objects = new Map<string, Buffer>();
    const uploaded = { old: [] as string[], new: [] as string[] };
    const uploader: PackUploader = {
      bucket: "test-bucket",
      async upload(localPath, key) {
        const old = localPath.startsWith(`${oldPack.outDir}${path.sep}`);
        const bytes = await readFile(localPath);
        if (old && uploaded.old.length === 0) {
          paused.resolve();
          await resume.promise;
        }
        uploaded[old ? "old" : "new"].push(key);
        // An unconditional object PUT overwrites existing bytes, as R2 does.
        objects.set(key, bytes);
        return { bytes: bytes.length };
      },
    };
    const oldStore = oldRunKey ? store(uploader).forRun(oldRunKey) : store(uploader);
    const oldSave = oldStore.savePack(oldPack).then(() => null, (error: unknown) => error);
    try {
      await paused.promise;
      // Requeue supersedes the first run while its object upload is in flight.
      for (const asset of oldAssets) {
        await db.update(assets).set({ approved: false, qc: { status: "superseded" } }).where(eq(assets.id, asset.id));
      }
      await db.update(generationJobs).set({ runKey: "run-new" }).where(eq(generationJobs.id, jobId));
      await makeAssets();
      const replacement = store(uploader).forRun("run-new");
      await replacement.savePack(newPack);
      const delivered = new Map(uploaded.new.map((key) => [key, Buffer.from(objects.get(key)!)]));

      resume.resolve();
      expect(await oldSave).toBeInstanceOf(JobAbandonedError);
      expect(uploaded.old).toHaveLength(4);
      expect(uploaded.new).toHaveLength(4);
      // Covers the base image, extra version, channel ZIP and report, not
      // just the DB fence: every already-delivered object retains its bytes.
      for (const [key, bytes] of delivered) expect(objects.get(key), key).toEqual(bytes);
      expect(uploaded.old.every((key) => !delivered.has(key))).toBe(true);
      const variants = await db.select({ key: assetVariants.r2Key }).from(assetVariants)
        .innerJoin(assets, eq(assets.id, assetVariants.assetId)).where(eq(assets.jobId, jobId));
      const packs = await db.select().from(packFiles).where(eq(packFiles.jobId, jobId));
      expect(variants).toHaveLength(2);
      expect(packs).toHaveLength(2);
      expect([...variants.map((file) => file.key), ...packs.map((file) => file.r2Key)].sort()).toEqual([...delivered.keys()].sort());
      expect(await oldStore.setJobState(jobId, "done")).toBe(false);
      const at = new Date();
      await expect(oldStore.appendLedger({ jobId, workspaceId: ws, reason: "charge", credits: 1, ref: "s1", note: "late charge", at }))
        .rejects.toBeInstanceOf(JobAbandonedError);
      await expect(oldStore.appendLedger({ jobId, workspaceId: ws, reason: "release", credits: 1, note: "late release", at }))
        .rejects.toBeInstanceOf(JobAbandonedError);
      await oldStore.releaseAllHeld(jobId, ws);
      expect(await row(jobId)).toMatchObject({ status: "packaging", runKey: "run-new" });
      expect(await held(jobId)).toBe(5);
      expect(await charges(jobId)).toBe(0);
      await replacement.appendLedger({ jobId, workspaceId: ws, reason: "charge", credits: 1, ref: "s1", note: "replacement charge", at });
      await replacement.releaseAllHeld(jobId, ws);
      expect(await charges(jobId)).toBe(1);
      expect(await held(jobId)).toBe(0);
      expect(await replacement.setJobState(jobId, "done")).toBe(true);
    } finally {
      resume.resolve();
      await oldSave;
      await Promise.all([oldPack, newPack].map((pack) => rm(pack.outDir, { recursive: true, force: true })));
    }
  });

  it("allows legacy rows to finish but fences an unbound store after a replacement takes ownership", async () => {
    // A job queued before 0019: its row has no key.
    const legacyRow = await newJob("generating", null, 0);
    expect(await store().forRun("run-x").heartbeat(legacyRow)).toBe(true);
    expect(await store().heartbeat(legacyRow)).toBe(true);
    const at = new Date();
    const legacy = new DbJobStore(db as unknown as Db);
    await legacy.appendLedger({ jobId: legacyRow, workspaceId: ws, reason: "reserve", credits: 2, note: "legacy reserve", at });
    await legacy.appendLedger({ jobId: legacyRow, workspaceId: ws, reason: "charge", credits: 1, ref: "legacy-shot", note: "legacy charge", at });
    await legacy.releaseAllHeld(legacyRow, ws);
    expect(await charges(legacyRow)).toBe(1);
    expect(await held(legacyRow)).toBe(0);
    expect(await legacy.setJobState(legacyRow, "done")).toBe(true);
    // A payload queued before 0019 cannot attach itself to a replacement.
    const keyedRow = await newJob("generating", "run-y", 0);
    expect(await store().heartbeat(keyedRow)).toBe(false);
    await expect(legacy.appendLedger({ jobId: keyedRow, workspaceId: ws, reason: "reserve", credits: 2, note: "late reserve", at }))
      .rejects.toBeInstanceOf(JobAbandonedError);
    expect(await held(keyedRow)).toBe(0);
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

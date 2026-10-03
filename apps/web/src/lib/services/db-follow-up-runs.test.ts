/**
 * Pack follow ups end to end against the real migrations, ledger functions
 * and runners in PGlite: the web app's retry, cancel and retry again, with
 * the queued payloads run by the real follow up runner and DbJobStore.
 *
 * - A stale runner comes back to life (reviewer item 1): a follow up that is
 *   canceled and followed by a new one must never deliver, charge, release
 *   or put the job back to done once the new one owns the job; the new one
 *   completes and is charged exactly once.
 * - The payload carries the brand kit, the plan's social badge and the
 *   job's recipe variants (item 3), and a failure while building it returns
 *   the hold (item 4).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackFollowUpInput } from "@curvi/trigger/follow-up";
import { runPackFollowUp } from "@curvi/trigger/follow-up";
import { DbJobStore } from "@curvi/trigger/db-store";
import { buildRuntimeDeps } from "@curvi/trigger/runtime";
import { activeRecipe, runGeneratePack, type ShotGenerateArgs } from "@curvi/trigger/runner";
import { LiveShotGenerator } from "@curvi/trigger/live-runtime";
import { InMemoryCapStore, MockProvider } from "@curvi/ai/testing";
import {
  assetVariants,
  assets,
  brandKits,
  creditLedger,
  generationJobs,
  jobSteps,
  members,
  packCompletionEvents,
  packFiles,
  products,
  signupGrants,
  sourceMedia,
  uploadPreflights,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { encodePng, endExiftool } from "@curvi/pipeline";
import type { Shot } from "@curvi/pipeline/schemas";
import { CUTOUT_TASK, creditCosts, socialBadgeByTier, spendCapPolicy } from "@curvi/pipeline/seed";
import { brandStyleFor } from "@/lib/jobs/payload";
import { recoverOrphanJobs } from "@/lib/jobs/recovery";
import { DbService } from "./db";
import { setCreditBudget, readCreditBudget } from "@/lib/billing/credit-planning";
import { CREDIT_BUDGET_MESSAGE } from "@/lib/billing/credit-budget";

const followUps = vi.hoisted(() => ({
  fn: vi.fn<(payload: PackFollowUpInput) => Promise<"inline">>(async () => "inline"),
}));
vi.mock("@/lib/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/enqueue")>()),
  enqueuePackFollowUp: followUps.fn,
}));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f201";
const CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product"];
const SHOT_ID = "s04_alt_angle_white";
const CREDITS = creditCosts.deterministic;

function service(database: Db = db as unknown as Db): DbService {
  return new DbService({ db: database, getUserId: async () => OWNER, getSupabase: async () => null });
}

function runnerStore(): DbJobStore {
  return new DbJobStore(db as unknown as Db, {
    reserveHandledExternally: true,
    uploader: { bucket: "test-bucket", upload: async () => ({ bytes: 1 }) },
  });
}

function inventoryPhoto(two = false) {
  const width = 100;
  const height = 100;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 20; y < 80; y++) for (let x = 10; x < (two ? 90 : 40); x++) {
    if (x >= 40 && x < 60) continue;
    const offset = (y * width + x) * 4;
    data[offset + (x < 40 ? 0 : 2)] = 240;
    data[offset + 3] = 255;
  }
  return { width, height, channels: 4 as const, data };
}

async function balance(ws: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [ws]);
  return Number(result.rows[0].credit_balance);
}

async function jobRow(jobId: string) {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return row;
}

async function completionEvents(jobId: string) {
  return db.select().from(packCompletionEvents).where(eq(packCompletionEvents.jobId, jobId));
}

async function ledger(jobId: string) {
  const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, jobId));
  return {
    held: rows.filter((r) => r.reason === "reserve" || r.reason === "release").reduce((sum, r) => sum - r.delta, 0),
    charges: rows.filter((r) => r.reason === "charge" && r.stepKey === SHOT_ID).length,
  };
}

async function workspaceWith(credits: number): Promise<{ ws: string; productId: string }> {
  const [w] = await db.insert(workspaces).values({ name: "Runs", plan: "starter" }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: OWNER, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
  await db.insert(creditLedger).values({ workspaceId: w.id, delta: credits, reason: "grant", source: "system" });
  return { ws: w.id, productId: p.id };
}

function reviewShot(ws: string): Shot {
  return {
    id: SHOT_ID,
    type: "alt_angle_white",
    sourceMediaId: `ws/${ws}/src/mug.jpg`,
    method: "deterministic",
    channels: ["amazon.secondary"],
    stylePreset: "none",
    scene: "side angle on white",
    credits: CREDITS,
    priority: 2,
  };
}

/** A delivered pack with one white angle that needs review, its planned
 * shot stored, settled the way the runner settles one. */
async function deliveredPack(ws: string, productId: string): Promise<string> {
  await db.insert(sourceMedia).values({ workspaceId: ws, productId, r2Key: `ws/${ws}/src/mug.jpg`, kind: "image", sha256: "a".repeat(64) }).onConflictDoNothing();
  const [job] = await db
    .insert(generationJobs)
    .values({
      workspaceId: ws,
      productId,
      status: "packaging",
      mode: "listing",
      channels: CHANNELS,
      runKey: "first-run",
      recipeVariants: { qc_judge: { recipeId: null, version: 1, source: "seed" } },
    })
    .returning();
  await client.query("select reserve_credits($1, $2, $3)", [ws, 10, job.id]);
  const [main] = await db
    .insert(assets)
    .values({
      workspaceId: ws,
      jobId: job.id,
      shotType: "amazon_main",
      approved: true,
      qc: { shotId: "s01_amazon_main", status: "passed", pass: true, credits: CREDITS },
    })
    .returning();
  await db.insert(assets).values({
    workspaceId: ws,
    jobId: job.id,
    shotType: "alt_angle_white",
    approved: false,
    qc: { shotId: SHOT_ID, status: "needs_review", pass: false, repairHint: "Soft edge.", credits: CREDITS, shot: reviewShot(ws), sourceSelection: { version: 1, sourceMediaId: reviewShot(ws).sourceMediaId, target: null, exclude: [], otherItems: false } },
  });
  await db.insert(assetVariants).values({
    workspaceId: ws,
    assetId: main.id,
    channelSpecId: "amazon.main",
    r2Key: `ws/${ws}/jobs/${job.id}/files/amazon/MUG.MAIN.jpg`,
    filename: "MUG.MAIN.jpg",
  });
  await db.insert(packFiles).values({
    workspaceId: ws,
    jobId: job.id,
    kind: "report",
    filename: "compliance-report.json",
    r2Key: `ws/${ws}/jobs/${job.id}/pack/compliance-report.json`,
  });
  await db.insert(jobSteps).values([
    { workspaceId: ws, jobId: job.id, shotId: "s01_amazon_main", stage: "amazon_main", status: "done" },
    { workspaceId: ws, jobId: job.id, shotId: SHOT_ID, stage: "alt_angle_white", status: "needs_review" },
  ]);
  await client.query("select charge_credits($1, $2, $3, $4)", [ws, CREDITS, job.id, "s01_amazon_main"]);
  await client.query("select release_credits($1, $2)", [ws, job.id]);
  await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, job.id));
  return job.id;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  await db.insert(signupGrants).values({ userId: OWNER, credits: 0 });
});

afterAll(async () => {
  await endExiftool();
  await client.close();
});

beforeEach(() => {
  followUps.fn.mockReset();
  followUps.fn.mockResolvedValue("inline");
});

describe("product selection across the first run and follow ups", () => {
  it.each(["deadline", "aborted", "asset-cap"] as const)("does not start added-photo provider work after the %s guard blocks it", async (guard) => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const shotId = "skipped_01_alt_angle_white:back";
    await db.insert(jobSteps).values({ workspaceId: ws, jobId, shotId, stage: "alt_angle_white:back", provider: "planner", status: "skipped", error: "needs photo" });
    const before = await balance(ws);
    expect(await service().addShotPhoto(ws, jobId, shotId, { key: `ws/${ws}/src/guarded.jpg`, sha256: "d".repeat(64) })).toMatchObject({ outcome: "started" });
    const payload = followUps.fn.mock.calls[0][0];
    const capStore = new InMemoryCapStore();
    if (guard === "asset-cap") await capStore.add(`caps:asset:image:${jobId}:${shotId}`, spendCapPolicy.perImageAssetMicros);
    const base = buildRuntimeDeps({ capStore });
    const bytes = await encodePng(inventoryPhoto());
    const cutout = new MockProvider({ name: "guarded-cutout", kind: "cutout", tasks: [CUTOUT_TASK],
      output: { imageBytes: bytes, contentType: "image/png" }, costMicros: 20_000, estimateMicros: 20_000 });
    base.ai.registry.register(cutout);
    base.ai.routing[CUTOUT_TASK] = [cutout.name];
    const generator = new LiveShotGenerator({ ai: base.ai,
      wiring: { llmLive: false, imageProviders: [], cutoutProviders: [cutout.name], cutoutLive: true }, loadMedia: async () => bytes });
    const generate = vi.spyOn(generator, "generate");
    const inventory = vi.spyOn(generator, "inventoryCutout");
    const controller = new AbortController();
    if (guard === "aborted") controller.abort();
    const summary = await runPackFollowUp(payload, { ...base, store: runnerStore(), generator,
      ...(guard !== "asset-cap" ? { runDeadline: { stopStartingAt: guard === "deadline" ? 0 : Date.now() + 60_000, signal: controller.signal } } : {}),
    });
    expect(cutout.calls).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
    if (guard !== "asset-cap") expect(inventory).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ state: "stopped", costMicros: 0, chargedCredits: 0, releasedCredits: CREDITS });
    expect(await balance(ws)).toBe(before);
  });

  // Successful cases render full-size marketplace images and run fidelity checks,
  // packaging and ledger settlement; allow bounded headroom on shared CI CPUs.
  it.each(["cached", "paid", "ambiguous", "touching"] as const)("handles an added photo without preflight using the %s cutout once", async (mode) => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    if (mode === "touching") {
      const rows = await db.select().from(assets).where(eq(assets.jobId, jobId));
      const previous = rows.find((row) => row.qc?.sourceSelection)!;
      await db.update(assets).set({ qc: { ...previous.qc, sourceSelection: { ...(previous.qc!.sourceSelection as object), target: {
        label: "red mug", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.6 },
        others: [{ label: "blue bowl", box: { x: 0.6, y: 0.2, width: 0.3, height: 0.6 } }],
      } } } }).where(eq(assets.id, previous.id));
    }
    const shotId = "skipped_01_alt_angle_white:back";
    await db.insert(jobSteps).values({ workspaceId: ws, jobId, shotId, stage: "alt_angle_white:back", provider: "planner", status: "skipped", error: "needs photo" });
    const key = `ws/${ws}/src/added.jpg`;
    const before = await balance(ws);
    // Exactly the existing pack uploader's request, with no preflight call.
    expect(await service().addShotPhoto(ws, jobId, shotId, { key, sha256: "c".repeat(64) })).toMatchObject({ outcome: "started" });
    const payload = followUps.fn.mock.calls[0][0];
    expect(payload.resolveAddedSources).toEqual([key]);
    if (mode === "touching") expect(payload.sourceSelections?.[key].exclude).toEqual(["blue bowl"]);
    const photo = inventoryPhoto(mode === "ambiguous" || mode === "touching");
    if (mode === "touching") for (let x = 40; x <= 60; x++) {
      photo.data[(50 * photo.width + x) * 4] = 240;
      photo.data[(50 * photo.width + x) * 4 + 3] = 255;
    }
    const bytes = await encodePng(photo);
    const base = buildRuntimeDeps();
    const cutout = new MockProvider({ name: "selection-cutout", kind: "cutout", tasks: [CUTOUT_TASK],
      output: { imageBytes: bytes, contentType: "image/png" }, costMicros: 20_000, estimateMicros: 20_000 });
    base.ai.registry.register(cutout);
    base.ai.routing[CUTOUT_TASK] = [cutout.name];
    const cached = vi.fn(async () => mode === "cached" ? { bytes, contentType: "image/png", storedAt: new Date() } : null);
    const generator = new LiveShotGenerator({
      ai: base.ai, wiring: { llmLive: false, imageProviders: [], cutoutProviders: [cutout.name], cutoutLive: true },
      loadMedia: async () => bytes, cutoutCache: { get: cached, put: async () => {} },
    });
    const generate = vi.spyOn(generator, "generate");
    const summary = await runPackFollowUp(payload, { ...base, store: runnerStore(), generator });
    expect(cutout.calls).toHaveLength(mode === "cached" ? 0 : 1);
    expect(summary.costMicros).toBe(mode === "cached" ? 0 : 20_000);
    if (mode === "ambiguous" || mode === "touching") {
      expect(summary).toMatchObject({ state: "stopped", chargedCredits: 0, releasedCredits: CREDITS });
      expect(generate).not.toHaveBeenCalled();
      expect(await balance(ws)).toBe(before);
    } else {
      expect(summary).toMatchObject({ state: "done", passed: 1, chargedCredits: CREDITS });
      expect(generate).toHaveBeenCalled();
      const rows = await db.select().from(assets).where(eq(assets.jobId, jobId));
      expect(rows.at(-1)?.qc?.sourceSelection).toMatchObject({ sourceMediaId: key, basis: "added_cutout_inventory", target: { keep: [expect.any(Object)] } });
      expect(await balance(ws)).toBe(before - CREDITS);
    }
  }, 60_000);

  it("persists exact selected pieces and exclusions, then restores them for retry and regeneration", async () => {
    const { ws, productId } = await workspaceWith(100);
    const key = `ws/${ws}/src/selected.jpg`;
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.6 };
    await db.insert(sourceMedia).values({ workspaceId: ws, productId, r2Key: key, kind: "image", sha256: "b".repeat(64), targetBox: box });
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "queued", runKey: "selected-first", mode: "listing", channels: CHANNELS }).returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 20, job.id]);
    const base = buildRuntimeDeps();
    const intakeKey = activeRecipe("intake").key;
    base.ai.registry.register(new MockProvider({ name: "selected-intake", tasks: [intakeKey], estimateMicros: 0, output: {
      images: [{ sellableProduct: true, distinctProducts: 2, sharpEnough: true,
        products: [
          { label: "red mug", box, matchesIntent: "yes" },
          { label: "blue bowl", box: { x: 0.6, y: 0.2, width: 0.3, height: 0.6 }, matchesIntent: "no" },
        ], flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false } }],
      sellerIntent: { featureOnly: "red mug", exclude: ["blue bowl"], mustKeep: [], styleNotes: null },
    } }));
    base.ai.routing[intakeKey] = ["selected-intake"];
    const summary = await runGeneratePack({
      jobId: job.id, workspaceId: ws, runKey: "selected-first", tier: "starter", channels: CHANNELS,
      creditBudget: 20, images: [{ mediaId: key, targetBox: box }], mode: "listing",
    }, { ...base, store: runnerStore(), generator: {
      inventoryCutout: async () => ({ cutout: inventoryPhoto(true), costMicros: 0 }),
      generate: async (args) => {
        if (args.shot.type === "alt_angle_white") throw new Error("fixture: soft edge");
        return base.generator.generate(args);
      },
    } });
    expect(summary.state, summary.error).toBe("done");
    const firstRows = await db.select().from(assets).where(eq(assets.jobId, job.id));
    const review = firstRows.find((row) => row.shotType === "alt_angle_white" && !row.approved)!;
    const selection = review.qc!.sourceSelection;
    expect(selection).toMatchObject({ version: 1, sourceMediaId: key, exclude: ["blue bowl"], target: {
      label: "red mug", keep: [box], others: [{ label: "blue bowl" }],
    } });
    expect(await service().retryShot(ws, job.id, review.qc!.shotId as string)).toMatchObject({ outcome: "started" });
    const payload = followUps.fn.mock.calls[0][0];
    expect(payload.sourceSelections?.[key]).toEqual(selection);
    expect((await jobRow(job.id)).restartPayload?.sourceSelections).toEqual(payload.sourceSelections);
    const staleAt = new Date(Date.now() - 6 * 60_000);
    await db.update(generationJobs).set({ runnerId: "old-process", heartbeatAt: staleAt, updatedAt: staleAt, startedAt: null }).where(eq(generationJobs.id, job.id));
    const recovered: PackFollowUpInput[] = [];
    await recoverOrphanJobs(db as unknown as Db, { owner: "new-process", submit: (value) => {
      if ("kind" in value && value.kind === "follow_up") recovered.push(value);
    } });
    const restored = recovered.find((value) => value.jobId === job.id)!;
    expect(restored).toBeDefined();
    expect(restored.sourceSelections).toEqual(payload.sourceSelections);
    expect(restored.runKey).not.toBe(payload.runKey);
    const seen: ShotGenerateArgs[] = [];
    await runPackFollowUp(restored, { ...buildRuntimeDeps(), store: runnerStore(), generator: {
      generate: async (args) => { seen.push(args); throw new Error("fixture: still soft"); },
    } });
    expect(seen[0].target).toEqual((selection as { target: unknown }).target);
    const after = await db.select().from(assets).where(eq(assets.jobId, job.id));
    expect(after.at(-1)?.qc?.sourceSelection).toEqual(selection);
    const scene = firstRows.find((row) => row.shotType === "lifestyle" && row.approved)!;
    expect(scene).toBeDefined();
    expect(await service().regenerateShot(ws, job.id, scene.qc!.shotId as string)).toMatchObject({ outcome: "started" });
    expect(followUps.fn.mock.calls.at(-1)![0].sourceSelections?.[key]).toEqual(selection);
  }, 20_000);

  it.each(["missing", "unknown-field"])("refuses a legacy selected photo with %s context and returns the hold", async (kind) => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const rows = await db.select().from(assets).where(eq(assets.jobId, jobId));
    const asset = rows.find((row) => row.qc?.shot)!;
    const qc = { ...asset.qc! };
    if (kind === "missing") delete qc.sourceSelection;
    else qc.sourceSelection = { ...(qc.sourceSelection as object), futureSelectionRule: true };
    await db.update(assets).set({ qc }).where(eq(assets.id, asset.id));
    await db.update(sourceMedia).set({ targetBox: { x: 0, y: 0, width: 0.4, height: 1 } }).where(eq(sourceMedia.productId, productId));
    const before = await balance(ws);
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "rejected", reason: "not_retryable", message: expect.stringContaining("product selection") });
    expect(followUps.fn).not.toHaveBeenCalled();
    expect(await balance(ws)).toBe(before);
    expect((await jobRow(jobId)).status).toBe("done");
  });

  it.each([1, 2])("only reuses a legacy intake proving a single source product (count=%s)", async (count) => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const rows = await db.select().from(assets).where(eq(assets.jobId, jobId));
    const asset = rows.find((row) => row.qc?.shot)!;
    const qc = { ...asset.qc! };
    delete qc.sourceSelection;
    await db.update(assets).set({ qc }).where(eq(assets.id, asset.id));
    await db.insert(uploadPreflights).values({ workspaceId: ws, r2Key: reviewShot(ws).sourceMediaId, noteKey: "", status: "ready", result: {}, intake: {
      image: { sellableProduct: true, distinctProducts: count, sharpEnough: true, flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false } },
    } });
    const result = await service().retryShot(ws, jobId, SHOT_ID);
    expect(result.outcome).toBe(count === 1 ? "started" : "rejected");
    if (count === 1) expect(followUps.fn.mock.calls[0][0].sourceSelections?.[reviewShot(ws).sourceMediaId]).toMatchObject({ version: 1, target: null, exclude: [], otherItems: false });
    else expect(followUps.fn).not.toHaveBeenCalled();
  });
});

describe("a canceled follow up's runner after a new follow up started (reviewer item 1)", () => {
  it("refuses the stale runner's writes and charges, and the new run completes and is charged once", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await balance(ws);
    const chargedBefore = (await jobRow(jobId)).creditsCharged;
    const initialRun = (await jobRow(jobId)).logicalRunId;
    expect(await completionEvents(jobId)).toMatchObject([{ logicalRunId: initialRun, outcome: "done", packStatus: "done" }]);

    // Retry the shot: the job row and the payload carry the same fresh key.
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "started" });
    const stale = followUps.fn.mock.calls[0][0];
    expect(stale.runKey).not.toBe("first-run");
    expect((await jobRow(jobId)).runKey).toBe(stale.runKey);
    const canceledRun = (await jobRow(jobId)).logicalRunId;
    expect(canceledRun).not.toBe(initialRun);

    // Cancel it before its runner gets to work: the hold comes back and the
    // key changes.
    expect(await service().cancelJob(ws, jobId)).toMatchObject({ outcome: "stopped", refundedCredits: CREDITS });
    const canceled = await jobRow(jobId);
    expect(canceled.status).toBe("done");
    expect(canceled.runKey).not.toBe(stale.runKey);
    expect(canceled.logicalRunId).toBe(canceledRun);
    expect((await completionEvents(jobId)).find((event) => event.logicalRunId === canceledRun)).toMatchObject({ outcome: "canceled", packStatus: "done" });
    expect(await balance(ws)).toBe(before);

    // Retry again: a new hold under a new key, the job generating again.
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "started" });
    const fresh = followUps.fn.mock.calls[1][0];
    expect(fresh.runKey).not.toBe(stale.runKey);
    expect(await jobRow(jobId)).toMatchObject({ status: "generating", runKey: fresh.runKey });
    const freshRun = (await jobRow(jobId)).logicalRunId;
    expect(freshRun).not.toBe(canceledRun);
    expect(await balance(ws)).toBe(before - CREDITS);
    const variantsBefore = (await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws))).length;

    // The first follow up's runner comes back to life now. It must stop
    // without delivering, charging, releasing the new hold or putting the
    // job back to done.
    const staleSummary = await runPackFollowUp(stale, { ...buildRuntimeDeps(), store: runnerStore() });
    expect(staleSummary).toMatchObject({ state: "stopped", chargedCredits: 0, passed: 0 });
    expect(await jobRow(jobId)).toMatchObject({ status: "generating", runKey: fresh.runKey });
    expect(await ledger(jobId)).toEqual({ held: CREDITS, charges: 0 });
    expect(await balance(ws)).toBe(before - CREDITS);
    expect(await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws))).toHaveLength(variantsBefore);
    expect(await completionEvents(jobId)).toHaveLength(2);

    // The new follow up runs to the end and is charged exactly once.
    const freshSummary = await runPackFollowUp(fresh, { ...buildRuntimeDeps(), store: runnerStore() });
    expect(freshSummary).toMatchObject({ state: "done", passed: 1, chargedCredits: CREDITS, releasedCredits: 0 });
    const done = await jobRow(jobId);
    expect(done.status).toBe("done");
    expect(done.creditsCharged).toBe(chargedBefore + CREDITS);
    expect(await ledger(jobId)).toEqual({ held: 0, charges: 1 });
    expect(await balance(ws)).toBe(before - CREDITS);
    const delivered = await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws));
    expect(delivered.filter((v) => v.r2Key.includes(`/followup-${fresh.runKey}/`)).length).toBeGreaterThan(0);
    expect(delivered.some((v) => v.r2Key.includes(`/followup-${stale.runKey}/`))).toBe(false);
    const events = await completionEvents(jobId);
    expect(events).toHaveLength(3);
    expect(events.find((event) => event.logicalRunId === freshRun)).toMatchObject({ outcome: "done", packStatus: "done" });
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
  });
});

describe("the follow up payload (reviewer items 3 and 4)", () => {
  it("carries the brand kit, the plan's social badge and the job's recipe variants", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const kit = { fonts: { heading: "inter" }, logoKey: `ws/${ws}/brand/logo.png`, stylePreset: null };
    await db.insert(brandKits).values({
      workspaceId: ws,
      colors: ["#112233", "not a color"],
      fonts: kit.fonts,
      logoR2Key: kit.logoKey,
      stylePreset: kit.stylePreset,
    });

    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "started" });
    const payload = followUps.fn.mock.calls[0][0];
    const brand = brandStyleFor(ws, kit);
    expect(brand).not.toBeNull();
    expect(payload.brand).toEqual(brand);
    expect(payload.brandColors).toEqual(["#112233"]);
    expect(payload.socialBadge).toBe(socialBadgeByTier.starter ?? false);
    expect(payload.recipeVariants).toEqual({ qc_judge: { recipeId: null, version: 1, source: "seed" } });
  });

  it("returns the hold when the payload cannot be built", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await balance(ws);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The product lookup runs after the hold commits; a blip there must not
    // strand the hold.
    const blip = new Proxy(db as unknown as Db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return new Proxy(target.query, {
            get(query, table, r) {
              if (table === "products") {
                return {
                  findFirst: async () => {
                    throw new Error("connection reset");
                  },
                };
              }
              return Reflect.get(query, table, r);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(await service(blip).retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    expect(followUps.fn).not.toHaveBeenCalled();
    expect(await balance(ws)).toBe(before);
    expect((await ledger(jobId)).held).toBe(0);
    expect((await jobRow(jobId)).status).toBe("done");
    const abandoned = await jobRow(jobId);
    const abandonedEvents = await completionEvents(jobId);
    expect(abandonedEvents).toHaveLength(2);
    expect(abandonedEvents.find((event) => event.logicalRunId === abandoned.logicalRunId)).toMatchObject({ outcome: "failed", packStatus: "done" });
    const reruns = await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId));
    expect(reruns.filter((s) => s.status !== "done" && s.status !== "needs_review")).toHaveLength(0);
  });
});

describe("owner credit budget on follow ups", () => {
  it("refuses before changing the delivered pack, and cancellation restores headroom once", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await jobRow(jobId);
    await setCreditBudget(db as unknown as Db, ws, OWNER, CREDITS);
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "rejected", reason: "credit_budget_exceeded", message: CREDIT_BUDGET_MESSAGE });
    expect(followUps.fn).not.toHaveBeenCalled();
    expect(await jobRow(jobId)).toMatchObject({ status: "done", runKey: before.runKey, logicalRunId: before.logicalRunId });
    expect((await ledger(jobId)).held).toBe(0);
    await setCreditBudget(db as unknown as Db, ws, OWNER, CREDITS * 2);
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "started" });
    expect(await readCreditBudget(db as unknown as Db, ws)).toMatchObject({ consumed: CREDITS, held: CREDITS, remaining: 0 });
    await service().cancelJob(ws, jobId);
    await service().cancelJob(ws, jobId);
    expect(await readCreditBudget(db as unknown as Db, ws)).toMatchObject({ consumed: CREDITS, held: 0, remaining: CREDITS });
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "started" });
    expect(await readCreditBudget(db as unknown as Db, ws)).toMatchObject({ consumed: CREDITS, held: CREDITS, remaining: 0 });
  });
});

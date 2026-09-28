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
import {
  assetVariants,
  assets,
  brandKits,
  creditLedger,
  generationJobs,
  jobSteps,
  members,
  packFiles,
  products,
  signupGrants,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { endExiftool } from "@curvi/pipeline";
import type { Shot } from "@curvi/pipeline/schemas";
import { creditCosts, socialBadgeByTier } from "@curvi/pipeline/seed";
import { brandStyleFor } from "@/lib/jobs/payload";
import { DbService } from "./db";

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

async function balance(ws: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [ws]);
  return Number(result.rows[0].credit_balance);
}

async function jobRow(jobId: string) {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return row;
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
    qc: { shotId: SHOT_ID, status: "needs_review", pass: false, repairHint: "Soft edge.", credits: CREDITS, shot: reviewShot(ws) },
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

describe("a canceled follow up's runner after a new follow up started (reviewer item 1)", () => {
  it("refuses the stale runner's writes and charges, and the new run completes and is charged once", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await balance(ws);
    const chargedBefore = (await jobRow(jobId)).creditsCharged;

    // Retry the shot: the job row and the payload carry the same fresh key.
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "started" });
    const stale = followUps.fn.mock.calls[0][0];
    expect(stale.runKey).not.toBe("first-run");
    expect((await jobRow(jobId)).runKey).toBe(stale.runKey);

    // Cancel it before its runner gets to work: the hold comes back and the
    // key changes.
    expect(await service().cancelJob(ws, jobId)).toMatchObject({ outcome: "stopped", refundedCredits: CREDITS });
    const canceled = await jobRow(jobId);
    expect(canceled.status).toBe("done");
    expect(canceled.runKey).not.toBe(stale.runKey);
    expect(await balance(ws)).toBe(before);

    // Retry again: a new hold under a new key, the job generating again.
    expect(await service().retryShot(ws, jobId, SHOT_ID)).toMatchObject({ outcome: "started" });
    const fresh = followUps.fn.mock.calls[1][0];
    expect(fresh.runKey).not.toBe(stale.runKey);
    expect(await jobRow(jobId)).toMatchObject({ status: "generating", runKey: fresh.runKey });
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
    const reruns = await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId));
    expect(reruns.filter((s) => s.status !== "done" && s.status !== "needs_review")).toHaveLength(0);
  });
});

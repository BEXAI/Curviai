/**
 * The pack operations against the real migrations and ledger functions in
 * PGlite: cancel returns exactly the credits held for shots not delivered,
 * a retried shot or an added photo holds its seed price against the job and
 * nothing else, a refusal writes nothing, a queue failure returns the hold,
 * and only members who may spend credits reach any of it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackFollowUpInput } from "@curvi/trigger/follow-up";
import {
  assetVariants,
  assets,
  creditLedger,
  generationJobs,
  jobSteps,
  members,
  packFiles,
  products,
  signupGrants,
  sourceMedia,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, loadChannelSpecs, type Db } from "@curvi/db";
import type { Shot } from "@curvi/pipeline/schemas";
import { creditCosts } from "@curvi/pipeline/seed";
import type { IngestOutcome } from "@/lib/trust/ingest";
import { DbService, followUpCutoutSources } from "./db";
import { RERUN_STEP_STATUS } from "./shot-ops";

const followUps = vi.hoisted(() => ({
  fn: vi.fn<(payload: PackFollowUpInput) => Promise<"inline">>(async () => "inline"),
}));
vi.mock("@/lib/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/enqueue")>()),
  enqueuePackFollowUp: followUps.fn,
}));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f101";
const CLIENT_SEAT = "00000000-0000-4000-8000-00000000f102";
const OUTSIDER = "00000000-0000-4000-8000-00000000f103";
const CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product"];
const MAIN_CREDITS = creditCosts.deterministic;

function service(userId = OWNER): DbService {
  return new DbService({ db: db as unknown as Db, getUserId: async () => userId, getSupabase: async () => null });
}

/** A service whose upload check answers with a fixed outcome and records
 * the keys it was asked to check. */
function checkedService(outcome: IngestOutcome, seen: string[] = []): DbService {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => OWNER,
    getSupabase: async () => null,
    ingestUpload: async (key) => {
      seen.push(key);
      return outcome;
    },
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

async function held(jobId: string): Promise<number> {
  const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, jobId));
  return rows.filter((r) => r.reason === "reserve" || r.reason === "release").reduce((sum, r) => sum - r.delta, 0);
}

async function workspaceWith(credits: number): Promise<{ ws: string; productId: string }> {
  const [w] = await db.insert(workspaces).values({ name: "Ops", plan: "starter" }).returning();
  await db.insert(members).values([
    { workspaceId: w.id, userId: OWNER, role: "owner" },
    { workspaceId: w.id, userId: CLIENT_SEAT, role: "client" },
  ]);
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
  await db.insert(creditLedger).values({ workspaceId: w.id, delta: credits, reason: "grant", source: "system" });
  return { ws: w.id, productId: p.id };
}

function reviewShot(ws: string): Shot {
  return {
    id: "s04_alt_angle_white",
    type: "alt_angle_white",
    sourceMediaId: `ws/${ws}/src/mug.jpg`,
    method: "deterministic",
    channels: ["amazon.secondary"],
    stylePreset: "none",
    scene: "side angle on white",
    credits: creditCosts.deterministic,
    priority: 2,
  };
}

/**
 * A delivered pack, settled the way the runner settles one: the main image
 * charged and delivered, one white angle that needs review with its planned
 * shot stored, a back angle skipped for want of a photo, and the report row
 * that marks the pack delivered.
 */
async function deliveredPack(ws: string, productId: string, opts: { storeShot?: boolean } = {}): Promise<string> {
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: ws, productId, status: "packaging", mode: "listing", channels: CHANNELS })
    .returning();
  await client.query("select reserve_credits($1, $2, $3)", [ws, 10, job.id]);
  const [main] = await db
    .insert(assets)
    .values({
      workspaceId: ws,
      jobId: job.id,
      shotType: "amazon_main",
      approved: true,
      qc: { shotId: "s01_amazon_main", status: "passed", pass: true, credits: MAIN_CREDITS },
    })
    .returning();
  await db.insert(assets).values({
    workspaceId: ws,
    jobId: job.id,
    shotType: "alt_angle_white",
    approved: false,
    qc: {
      shotId: "s04_alt_angle_white",
      status: "needs_review",
      pass: false,
      repairHint: "The edge was soft.",
      credits: creditCosts.deterministic,
      ...(opts.storeShot === false ? {} : { shot: reviewShot(ws) }),
    },
  });
  await db.insert(assetVariants).values({
    workspaceId: ws,
    assetId: main.id,
    channelSpecId: "amazon.main",
    r2Key: `ws/${ws}/jobs/${job.id}/files/amazon/MUG.MAIN.jpg`,
    filename: "MUG.MAIN.jpg",
  });
  await db.insert(packFiles).values([
    { workspaceId: ws, jobId: job.id, kind: "zip", channel: "amazon", filename: "amazon.zip", r2Key: `ws/${ws}/jobs/${job.id}/pack/amazon.zip` },
    { workspaceId: ws, jobId: job.id, kind: "report", filename: "compliance-report.json", r2Key: `ws/${ws}/jobs/${job.id}/pack/compliance-report.json` },
  ]);
  await db.insert(jobSteps).values([
    { workspaceId: ws, jobId: job.id, shotId: "s01_amazon_main", stage: "amazon_main", status: "done" },
    { workspaceId: ws, jobId: job.id, shotId: "s04_alt_angle_white", stage: "alt_angle_white", status: "needs_review" },
    {
      workspaceId: ws,
      jobId: job.id,
      shotId: "skipped_01_alt_angle_white:back",
      stage: "alt_angle_white:back",
      provider: "planner",
      status: "skipped",
      error: "needs photo",
    },
  ]);
  await client.query("select charge_credits($1, $2, $3, $4)", [ws, MAIN_CREDITS, job.id, "s01_amazon_main"]);
  await client.query("select release_credits($1, $2)", [ws, job.id]);
  await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, job.id));
  return job.id;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  // Settled signup grants, so workspace reads never add the free grant.
  await db.insert(signupGrants).values([
    { userId: OWNER, credits: 0 },
    { userId: CLIENT_SEAT, credits: 0 },
    { userId: OUTSIDER, credits: 0 },
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  followUps.fn.mockReset();
  followUps.fn.mockResolvedValue("inline");
});

describe("DbService.cancelJob", () => {
  it("cancels a running pack and returns every credit it held", async () => {
    const { ws, productId } = await workspaceWith(50);
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "generating" }).returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 12, job.id]);
    expect(await balance(ws)).toBe(38);

    const result = await service().cancelJob(ws, job.id);
    expect(result).toMatchObject({ outcome: "canceled", refundedCredits: 12 });
    expect(result.outcome === "canceled" && result.notice).toBe(
      "This pack was canceled. 12 credits went back to your balance.",
    );
    expect((await jobRow(job.id)).status).toBe("canceled");
    expect(await balance(ws)).toBe(50);
    expect(await held(job.id)).toBe(0);

    // A second cancel changes nothing and returns nothing more.
    expect(await service().cancelJob(ws, job.id)).toMatchObject({ outcome: "finished" });
    expect(await balance(ws)).toBe(50);
  });

  it("refunds only what is still held after shots already released", async () => {
    const { ws, productId } = await workspaceWith(50);
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "qc" }).returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 10, job.id]);
    // Two shots needed review and were released while it ran.
    await client.query("select release_credits($1, $2, $3)", [ws, job.id, 2.5]);
    expect(await service().cancelJob(ws, job.id)).toMatchObject({ outcome: "canceled", refundedCredits: 7.5 });
    expect(await balance(ws)).toBe(50);
  });

  it("charges what a pack already delivered and returns the rest", async () => {
    const { ws, productId } = await workspaceWith(50);
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "packaging" }).returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 10, job.id]);
    const [asset] = await db
      .insert(assets)
      .values({ workspaceId: ws, jobId: job.id, shotType: "amazon_main", approved: true, qc: { shotId: "s01", credits: 2 } })
      .returning();
    await db.insert(assetVariants).values({
      workspaceId: ws,
      assetId: asset.id,
      channelSpecId: "amazon.main",
      r2Key: `ws/${ws}/jobs/${job.id}/files/amazon/A.jpg`,
      filename: "A.jpg",
    });
    await db.insert(packFiles).values({
      workspaceId: ws,
      jobId: job.id,
      kind: "report",
      filename: "compliance-report.json",
      r2Key: `ws/${ws}/jobs/${job.id}/pack/compliance-report.json`,
    });

    const result = await service().cancelJob(ws, job.id);
    expect(result).toMatchObject({ outcome: "stopped", refundedCredits: 8 });
    const row = await jobRow(job.id);
    expect(row.status).toBe("done");
    expect(row.creditsCharged).toBe(2);
    expect(await balance(ws)).toBe(48);
  });

  it("refuses client seats and hides other workspaces' packs", async () => {
    const { ws, productId } = await workspaceWith(50);
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "generating" }).returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 5, job.id]);

    expect(await service(CLIENT_SEAT).cancelJob(ws, job.id)).toMatchObject({ outcome: "rejected", reason: "role_forbidden" });
    const other = await workspaceWith(10);
    await db.insert(members).values({ workspaceId: other.ws, userId: OUTSIDER, role: "owner" });
    expect(await service(OUTSIDER).cancelJob(other.ws, job.id)).toMatchObject({ outcome: "rejected", reason: "not_found" });
    expect(await service(OUTSIDER).cancelJob(ws, job.id)).toMatchObject({ outcome: "rejected", reason: "role_forbidden" });

    expect((await jobRow(job.id)).status).toBe("generating");
    expect(await balance(ws)).toBe(45);
  });
});

describe("DbService.retryShot", () => {
  it("holds the shot's seed price against the job and queues it exactly as planned", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await balance(ws);
    const chargedBefore = (await jobRow(jobId)).creditsCharged;

    const result = await service().retryShot(ws, jobId, "s04_alt_angle_white");
    expect(result).toMatchObject({ outcome: "started", creditsHeld: creditCosts.deterministic });
    expect(await balance(ws)).toBe(before - creditCosts.deterministic);
    expect(await held(jobId)).toBe(creditCosts.deterministic);
    const row = await jobRow(jobId);
    expect(row.status).toBe("generating");
    expect(row.creditsCharged).toBe(chargedBefore);

    expect(followUps.fn).toHaveBeenCalledTimes(1);
    const payload = followUps.fn.mock.calls[0][0];
    expect(payload).toMatchObject({
      kind: "follow_up",
      jobId,
      workspaceId: ws,
      reason: "retry",
      creditBudget: creditCosts.deterministic,
      existingFilesBySpec: { "amazon.main": 1 },
    });
    expect(payload.shots).toEqual([reviewShot(ws)]);

    // The card is back in progress, and a second click cannot run it twice.
    const steps = await db.select().from(jobSteps).where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.status, RERUN_STEP_STATUS)));
    expect(steps.map((s) => s.shotId)).toEqual(["s04_alt_angle_white"]);
    expect(result.outcome === "started" && result.job.followUpRunning).toBe(true);
    expect(await service().retryShot(ws, jobId, "s04_alt_angle_white")).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(followUps.fn).toHaveBeenCalledTimes(1);

    // Canceling the follow up returns its hold and keeps the delivered pack.
    const canceled = await service().cancelJob(ws, jobId);
    expect(canceled).toMatchObject({ outcome: "stopped", refundedCredits: creditCosts.deterministic });
    expect((await jobRow(jobId)).status).toBe("done");
    expect(await balance(ws)).toBe(before);
  });

  it("writes nothing when the workspace cannot pay for the shot", async () => {
    const { ws, productId } = await workspaceWith(10);
    const jobId = await deliveredPack(ws, productId);
    // The rest of the balance expired since.
    await db.insert(creditLedger).values({ workspaceId: ws, delta: -(await balance(ws)), reason: "expire", source: "system" });
    expect(await balance(ws)).toBe(0);
    const result = await service().retryShot(ws, jobId, "s04_alt_angle_white");
    expect(result).toMatchObject({ outcome: "rejected", reason: "insufficient_credits" });
    expect((await jobRow(jobId)).status).toBe("done");
    const reruns = await db.select().from(jobSteps).where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.status, RERUN_STEP_STATUS)));
    expect(reruns).toHaveLength(0);
    expect(followUps.fn).not.toHaveBeenCalled();
  });

  it("returns the hold and puts the pack back when the queue refuses the shot", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await balance(ws);
    vi.spyOn(console, "error").mockImplementation(() => {});
    followUps.fn.mockRejectedValueOnce(new Error("queue down"));

    expect(await service().retryShot(ws, jobId, "s04_alt_angle_white")).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    expect(await balance(ws)).toBe(before);
    expect(await held(jobId)).toBe(0);
    expect((await jobRow(jobId)).status).toBe("done");
    const reruns = await db.select().from(jobSteps).where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.status, RERUN_STEP_STATUS)));
    expect(reruns).toHaveLength(0);
  });

  it("refuses shots that are not waiting for review, packs still running and client seats", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    expect(await service().retryShot(ws, jobId, "s01_amazon_main")).toMatchObject({ reason: "not_retryable" });
    expect(await service().retryShot(ws, jobId, "s99_nothing")).toMatchObject({ reason: "not_retryable" });
    expect(await service(CLIENT_SEAT).retryShot(ws, jobId, "s04_alt_angle_white")).toMatchObject({ reason: "role_forbidden" });

    const legacy = await deliveredPack(ws, productId, { storeShot: false });
    expect(await service().retryShot(ws, legacy, "s04_alt_angle_white")).toMatchObject({ reason: "not_retryable" });

    await db.update(generationJobs).set({ status: "generating" }).where(eq(generationJobs.id, jobId));
    expect(await service().retryShot(ws, jobId, "s04_alt_angle_white")).toMatchObject({ reason: "not_ready" });
    expect(followUps.fn).not.toHaveBeenCalled();
  });

  it("refuses a shot whose channels are already full", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const [filler] = await db
      .insert(assets)
      .values({ workspaceId: ws, jobId, shotType: "alt_angle_white", approved: true, qc: { shotId: "filler" } })
      .returning();
    await db.insert(assetVariants).values(
      Array.from({ length: 8 }, (_, i) => ({
        workspaceId: ws,
        assetId: filler.id,
        channelSpecId: "amazon.secondary",
        r2Key: `ws/${ws}/jobs/${jobId}/files/amazon/PT0${i + 1}.jpg`,
        filename: `PT0${i + 1}.jpg`,
      })),
    );
    expect(await service().retryShot(ws, jobId, "s04_alt_angle_white")).toMatchObject({ reason: "channel_full" });
  });

  it("refuses a shot that needs a cutout while cutouts are paused, before any hold", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await balance(ws);
    const asked: string[] = [];
    const paused = new DbService({
      db: db as unknown as Db,
      getUserId: async () => OWNER,
      getSupabase: async () => null,
      providerVerdict: async () => "packs_paused",
      cutoutCached: async (_ws, key) => {
        asked.push(key);
        return false;
      },
    });

    const result = await paused.retryShot(ws, jobId, "s04_alt_angle_white");

    expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    expect(result.outcome === "rejected" && result.message).toContain("paused");
    expect(asked).toEqual([`ws/${ws}/src/mug.jpg`]);
    expect(await balance(ws)).toBe(before);
    expect((await jobRow(jobId)).status).toBe("done");
    expect(followUps.fn).not.toHaveBeenCalled();
  });

  it("runs the shot while cutouts are paused when its photo's cutout is in the upload cache", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const cached = new DbService({
      db: db as unknown as Db,
      getUserId: async () => OWNER,
      getSupabase: async () => null,
      providerVerdict: async () => "packs_paused",
      cutoutCached: async () => true,
    });

    expect(await cached.retryShot(ws, jobId, "s04_alt_angle_white")).toMatchObject({ outcome: "started" });
    expect(followUps.fn).toHaveBeenCalledTimes(1);
  });
});

describe("followUpCutoutSources", () => {
  it("lists each photo a follow up cuts out, leaving out kept photo copies", () => {
    const shot = (type: Shot["type"], method: Shot["method"], sourceMediaId: string) => ({ type, method, sourceMediaId });
    expect(
      followUpCutoutSources([
        shot("alt_angle_white", "deterministic", "a"),
        shot("original_photo", "deterministic", "b"),
        shot("lifestyle", "composite_generate", "a"),
        shot("infographic", "template", "c"),
      ]),
    ).toEqual(["a", "c"]);
  });
});

describe("DbService.addShotPhoto", () => {
  it("saves the photo to the product and runs the shot it unlocks in place of the skipped card", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const before = await balance(ws);
    const key = `ws/${ws}/src/back.jpg`;

    const result = await service().addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", {
      key,
      sha256: "b".repeat(64),
    });
    expect(result).toMatchObject({ outcome: "started" });
    const payload = followUps.fn.mock.calls[0][0];
    expect(payload.reason).toBe("add_angle");
    expect(payload.shots).toHaveLength(1);
    expect(payload.shots[0]).toMatchObject({
      id: "skipped_01_alt_angle_white:back",
      type: "alt_angle_white",
      sourceMediaId: key,
      credits: creditCosts.deterministic,
    });
    expect(payload.creditBudget).toBe(creditCosts.deterministic);
    expect(await balance(ws)).toBe(before - creditCosts.deterministic);

    const media = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
    expect(media).toHaveLength(1);
    expect(media[0].productId).toBe(productId);
    // The card now reads as in progress instead of needs photo.
    const view = result.outcome === "started" ? result.job.shots.find((s) => s.shotId === "skipped_01_alt_angle_white:back") : null;
    expect(view?.status).toBe("generating");
  });

  it("refuses foreign uploads, cards that are not waiting for a photo and photos saved elsewhere", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const input = { key: `ws/${ws}/src/back2.jpg`, sha256: "c".repeat(64) };
    expect(
      await service().addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", { ...input, key: "ws/elsewhere/src/x.jpg" }),
    ).toMatchObject({ reason: "foreign_key" });
    expect(await service().addShotPhoto(ws, jobId, "s04_alt_angle_white", input)).toMatchObject({ reason: "not_retryable" });

    const [otherProduct] = await db.insert(products).values({ workspaceId: ws, title: "Lamp", mode: "listing" }).returning();
    await db.insert(sourceMedia).values({ workspaceId: ws, productId: otherProduct.id, r2Key: input.key, kind: "image", sha256: input.sha256 });
    const before = await balance(ws);
    expect(await service().addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", input)).toMatchObject({ reason: "conflict" });
    expect(await balance(ws)).toBe(before);
    expect((await jobRow(jobId)).status).toBe("done");
    expect(followUps.fn).not.toHaveBeenCalled();
  });

  it("checks the added photo on the server and records its hash and size, not the client's", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const key = `ws/${ws}/src/checked-back.jpg`;
    const seen: string[] = [];
    const passed: IngestOutcome = { ok: true, sha256: "e".repeat(64), width: 900, height: 1200, bytes: 5000, rewritten: true };

    const result = await checkedService(passed, seen).addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", {
      key,
      sha256: "0".repeat(64),
    });
    expect(result).toMatchObject({ outcome: "started" });
    expect(seen).toEqual([key]);
    const [media] = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
    expect(media).toMatchObject({ sha256: "e".repeat(64), width: 900, height: 1200, productId });
  });

  it("refuses a photo that fails the upload check, and answers unavailable when the check could not run", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const input = { key: `ws/${ws}/src/not-a-photo.jpg`, sha256: "a".repeat(64) };
    const before = await balance(ws);

    const refused = await checkedService({
      ok: false,
      retryable: false,
      notice: "That file is not a photo we can use.",
    }).addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", input);
    expect(refused).toEqual({
      outcome: "rejected",
      reason: "invalid_upload",
      message: "That file is not a photo we can use.",
    });

    const down = await checkedService({
      ok: false,
      retryable: true,
      notice: "We could not check that upload right now.",
    }).addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", input);
    expect(down).toMatchObject({ outcome: "rejected", reason: "unavailable" });

    expect(await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, input.key))).toHaveLength(0);
    expect(await balance(ws)).toBe(before);
    expect((await jobRow(jobId)).status).toBe("done");
    expect(followUps.fn).not.toHaveBeenCalled();
  });
});

describe("DbService.getJob pack operations", () => {
  it("offers a retry and an added photo on a delivered pack, and nothing to client seats", async () => {
    const { ws, productId } = await workspaceWith(20);
    const jobId = await deliveredPack(ws, productId);
    const job = await service().getJob(ws, jobId);
    expect(job?.canManage).toBe(true);
    expect(job?.followUpRunning).toBe(false);
    expect(job?.shots.find((s) => s.shotId === "s04_alt_angle_white")?.action).toBe("retry");
    expect(job?.shots.find((s) => s.shotId === "skipped_01_alt_angle_white:back")).toMatchObject({
      action: "add_photo",
      angle: "back",
    });
    expect((await service(CLIENT_SEAT).getJob(ws, jobId))?.canManage).toBe(false);
  });
});

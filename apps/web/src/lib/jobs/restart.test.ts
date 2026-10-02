import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assetVariants,
  assets,
  channelSpecs,
  creditLedger,
  events,
  generationJobs,
  jobSteps,
  packFiles,
  products,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, type Db } from "@curvi/db";
import { DbJobStore } from "@curvi/trigger/db-store";
import { JobAbandonedError, ShotUnavailableError, withRunDeadline, type GeneratePackInput, type PipelineDeps } from "@curvi/trigger/runner";
import { InlinePackRunner } from "./inline-runner";
import {
  DEPLOY_RESTARTS_SWITCH_CACHE_MS,
  RESTART_PAYLOAD_INVALID_MESSAGE,
  claimRestartedJobs,
  deployRestartsOn,
  isRestartKey,
  requeueForRestart,
  resetDeployRestartsSwitchForTests,
  restoredPayload,
} from "./restart";
import { deliveredCharges, settleInterruptedJob } from "./settle";

// Deploy restarts against the real migrations in PGlite (docs/phases/
// PHASE_18.md P18-23): a stopped pack is queued to start again at most once,
// the stopped run is fenced, the restart is claimed by exactly one runner,
// and the ledger ends with one charge per delivered shot.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let product: string;
const silent = { warn: () => undefined, error: () => undefined };

async function balance(workspaceId = ws): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [workspaceId]);
  return Number(result.rows[0].credit_balance);
}

async function held(jobId: string): Promise<number> {
  const result = await client.query<{ held: string | number }>(
    `select coalesce(sum(-delta), 0) as held from credit_ledger where job_id = $1 and reason in ('reserve', 'release')`,
    [jobId],
  );
  return Number(result.rows[0].held);
}

async function jobRow(id: string) {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
  return row;
}

async function newJob(opts: { runKey: string; budget?: number; status?: string; workspaceId?: string; productId?: string }) {
  const workspaceId = opts.workspaceId ?? ws;
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId, productId: opts.productId ?? product, status: "queued", runKey: opts.runKey, channels: ["amazon"] })
    .returning();
  await client.query("select reserve_credits($1, $2, $3)", [workspaceId, opts.budget ?? 8, job.id]);
  if (opts.status && opts.status !== "queued") {
    await db.update(generationJobs).set({ status: opts.status as "generating" }).where(eq(generationJobs.id, job.id));
  }
  return job.id;
}

function payloadFor(jobId: string, runKey: string, budget = 8, workspaceId = ws): GeneratePackInput {
  return {
    jobId,
    workspaceId,
    tier: "starter",
    mode: "listing",
    channels: ["amazon"],
    creditBudget: budget,
    images: [{ mediaId: `ws/${workspaceId}/src/candle.jpg`, angle: "front" }],
    userDescription: "Only the blue candle",
    brandColors: [],
    runKey,
  };
}

async function saveRunAsset(jobId: string, shotId: string, credits = 2) {
  const [asset] = await db
    .insert(assets)
    .values({ workspaceId: ws, jobId, shotType: "main", approved: true, qc: { shotId, credits, status: "passed", costMicros: 40_000 } })
    .returning();
  await db.insert(jobSteps).values({ workspaceId: ws, jobId, shotId, stage: "main", provider: "worker", status: "done" });
  return asset.id;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Restart", plan: "starter" }).returning();
  ws = w.id;
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Candle", mode: "listing" }).returning();
  product = p.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 200, reason: "grant", source: "system" });
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  // Restarts left by an earlier test would be claimed by the next one.
  await client.query(`update generation_jobs set status = 'failed' where run_key like 'restart:%'`);
});

describe("deployRestartsOn: the switch P18-23 ships behind", () => {
  it("is off without a row, off when stored false, on only for a stored true, cached, and off on a failed read", async () => {
    resetDeployRestartsSwitchForTests();
    let clock = 0;
    const now = () => clock;
    expect(await deployRestartsOn(db as unknown as Db, now)).toBe(false);
    await client.query(`insert into platform_settings (key, value) values ('ops:deploy_restarts_enabled', 'false'::jsonb)`);
    clock += DEPLOY_RESTARTS_SWITCH_CACHE_MS;
    expect(await deployRestartsOn(db as unknown as Db, now)).toBe(false);
    await client.query(`update platform_settings set value = 'true'::jsonb where key = 'ops:deploy_restarts_enabled'`);
    // Cached for the switch's cache window.
    expect(await deployRestartsOn(db as unknown as Db, now)).toBe(false);
    clock += DEPLOY_RESTARTS_SWITCH_CACHE_MS;
    expect(await deployRestartsOn(db as unknown as Db, now)).toBe(true);
    clock += DEPLOY_RESTARTS_SWITCH_CACHE_MS;
    const broken = { execute: async () => Promise.reject(new Error("db down")) } as unknown as Db;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await deployRestartsOn(broken, now)).toBe(false);
    } finally {
      console.warn = warn;
      resetDeployRestartsSwitchForTests();
    }
  });
});

describe("requeueForRestart: a pack that never started", () => {
  it("keeps it queued with its hold, under a restart key, with the payload saved, and spends nothing", async () => {
    const jobId = await newJob({ runKey: "k-wait" });
    const before = await balance();
    const outcome = await requeueForRestart(db as unknown as Db, payloadFor(jobId, "k-wait"), "not_started", { log: silent });
    expect(outcome).toMatchObject({ requeued: true, restartCount: 0 });
    const row = await jobRow(jobId);
    expect(row.status).toBe("queued");
    expect(isRestartKey(row.runKey)).toBe(true);
    expect(row.restartCount).toBe(0);
    expect(row.restartPayload).toMatchObject({ jobId, creditBudget: 8, userDescription: "Only the blue candle" });
    expect(row.restartPayload).not.toHaveProperty("runKey");
    expect(await balance()).toBe(before);
    expect(await held(jobId)).toBe(8);
    const restarted = await db.select().from(events).where(and(eq(events.workspaceId, ws), eq(events.name, "funnel.pack_restarted")));
    expect(restarted.at(-1)?.props).toEqual({ reason: "not_started", restart_count: 0 });
  });
});

describe("requeueForRestart: a pack interrupted mid run", () => {
  it("releases the hold, supersedes the run's assets, clears its progress rows and reserves the estimate again", async () => {
    const jobId = await newJob({ runKey: "k-run", status: "generating" });
    await saveRunAsset(jobId, "s01_main");
    // The run already gave back a failed shot's credit.
    await client.query("select release_credits($1, $2, $3)", [ws, jobId, 1]);
    const before = await balance();

    const outcome = await requeueForRestart(db as unknown as Db, payloadFor(jobId, "k-run"), "interrupted", { log: silent });

    expect(outcome).toMatchObject({ requeued: true, restartCount: 1 });
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: "queued", restartCount: 1, creditsReserved: 8, creditsCharged: 0, error: null });
    expect(isRestartKey(row.runKey)).toBe(true);
    // The whole estimate is held again; the balance moved by the one credit
    // the run had already given back.
    expect(await held(jobId)).toBe(8);
    expect(await balance()).toBe(before - 1);
    const [asset] = await db.select().from(assets).where(eq(assets.jobId, jobId));
    expect(asset.approved).toBe(false);
    expect(asset.qc).toMatchObject({ status: "superseded", pass: false, supersededShotId: "s01_main", credits: 2 });
    expect(asset.qc).not.toHaveProperty("shotId");
    expect(await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))).toEqual([]);
  });

  it("restarts a pack at most once (the seed's deployRestarts.max)", async () => {
    const jobId = await newJob({ runKey: "k-cap", status: "generating" });
    expect((await requeueForRestart(db as unknown as Db, payloadFor(jobId, "k-cap"), "interrupted", { log: silent })).requeued).toBe(true);
    const [claimed] = await claimRestartedJobs(db as unknown as Db, { log: silent });
    expect(claimed.jobId).toBe(jobId);
    await db.update(generationJobs).set({ status: "generating" }).where(eq(generationJobs.id, jobId));

    const again = await requeueForRestart(db as unknown as Db, claimed, "interrupted", { log: silent });

    expect(again).toEqual({ requeued: false, why: "cap" });
    expect(await jobRow(jobId)).toMatchObject({ status: "generating", runKey: claimed.runKey, restartCount: 1 });
    // The settle then runs as before: failed, hold released.
    await settleInterruptedJob(db as unknown as Db, { jobId, workspaceId: ws }, "stopped");
    expect(await held(jobId)).toBe(0);
  });

  it("leaves a delivered pack, a moved run, a finished job and a follow up to the settle", async () => {
    const delivered = await newJob({ runKey: "k-done", status: "generating" });
    await db.insert(packFiles).values({
      workspaceId: ws,
      jobId: delivered,
      kind: "report",
      filename: "compliance-report.json",
      r2Key: `ws/${ws}/jobs/${delivered}/compliance-report.json`,
    });
    expect(await requeueForRestart(db as unknown as Db, payloadFor(delivered, "k-done"), "interrupted", { log: silent })).toEqual({
      requeued: false,
      why: "delivered",
    });
    const moved = await newJob({ runKey: "k-new", status: "generating" });
    expect(await requeueForRestart(db as unknown as Db, payloadFor(moved, "k-old"), "interrupted", { log: silent })).toEqual({
      requeued: false,
      why: "moved",
    });
    const finished = await newJob({ runKey: "k-fin", status: "done" });
    expect((await requeueForRestart(db as unknown as Db, payloadFor(finished, "k-fin"), "interrupted", { log: silent })).requeued).toBe(false);
    expect(
      await requeueForRestart(db as unknown as Db, { kind: "follow_up" } as unknown as GeneratePackInput, "interrupted", { log: silent }),
    ).toEqual({ requeued: false, why: "follow_up" });
  });

  it("changes nothing when the balance no longer covers the estimate, so the settle fails it as before", async () => {
    const [w] = await db.insert(workspaces).values({ name: "Thin", plan: "starter" }).returning();
    const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
    await db.insert(creditLedger).values({ workspaceId: w.id, delta: 10, reason: "grant", source: "system" });
    const jobId = await newJob({ runKey: "k-thin", status: "generating", workspaceId: w.id, productId: p.id });
    const [asset] = await db
      .insert(assets)
      .values({ workspaceId: w.id, jobId, shotType: "main", approved: true, qc: { shotId: "s01", credits: 2 } })
      .returning();
    // Credits expired meanwhile: after the release only 5 are free.
    await db.insert(creditLedger).values({ workspaceId: w.id, delta: -5, reason: "expire", source: "system" });

    const outcome = await requeueForRestart(db as unknown as Db, payloadFor(jobId, "k-thin", 8, w.id), "interrupted", { log: silent });

    expect(outcome).toEqual({ requeued: false, why: "insufficient_credits" });
    expect(await jobRow(jobId)).toMatchObject({ status: "generating", runKey: "k-thin", restartCount: 0, restartPayload: null });
    expect(await held(jobId)).toBe(8);
    const [kept] = await db.select().from(assets).where(eq(assets.id, asset.id));
    expect(kept.approved).toBe(true);
  });
});

describe("claimRestartedJobs: the pickup", () => {
  it("claims only queued restart jobs, oldest first, once each", async () => {
    const older = await newJob({ runKey: "k-a" });
    await requeueForRestart(db as unknown as Db, payloadFor(older, "k-a"), "not_started", { log: silent });
    const newer = await newJob({ runKey: "k-b" });
    await requeueForRestart(db as unknown as Db, payloadFor(newer, "k-b"), "not_started", { log: silent });
    const plain = await newJob({ runKey: "k-plain" });
    const ended = await newJob({ runKey: "k-ended" });
    await requeueForRestart(db as unknown as Db, payloadFor(ended, "k-ended"), "not_started", { log: silent });
    await db.update(generationJobs).set({ status: "canceled" }).where(eq(generationJobs.id, ended));

    // Two instances look at once: each job goes to exactly one of them.
    const [first, second] = await Promise.all([
      claimRestartedJobs(db as unknown as Db, { log: silent }),
      claimRestartedJobs(db as unknown as Db, { log: silent }),
    ]);
    const claimed = [...first, ...second];
    expect(claimed.map((p) => p.jobId)).toEqual([older, newer]);
    for (const payload of claimed) {
      const row = await jobRow(payload.jobId);
      expect(payload.runKey).toBe(row.runKey);
      expect(isRestartKey(row.runKey)).toBe(false);
      expect(row.restartPayload).toMatchObject({ jobId: row.id });
      expect(payload).toMatchObject({ workspaceId: ws, creditBudget: 8, channels: ["amazon"] });
    }
    expect(await claimRestartedJobs(db as unknown as Db, { log: silent })).toEqual([]);
    expect((await jobRow(plain)).runKey).toBe("k-plain");
  });

  it("settles a claimed restart whose saved payload cannot run, releasing its hold", async () => {
    const jobId = await newJob({ runKey: "k-bad" });
    await requeueForRestart(db as unknown as Db, payloadFor(jobId, "k-bad"), "not_started", { log: silent });
    await db
      .update(generationJobs)
      .set({ restartPayload: { ...payloadFor(jobId, "x"), images: [{ mediaId: "ws/someone-else/src/a.jpg" }] } })
      .where(eq(generationJobs.id, jobId));

    expect(await claimRestartedJobs(db as unknown as Db, { log: silent })).toEqual([]);

    expect(await jobRow(jobId)).toMatchObject({ status: "failed", error: RESTART_PAYLOAD_INVALID_MESSAGE });
    expect(await held(jobId)).toBe(0);
  });

  it("restores only payloads for the job's own workspace", () => {
    const row = { id: "job-1", workspace_id: "ws-1", restart_payload: payloadFor("other", "x", 8, "ws-1") };
    expect(restoredPayload(row, "key")).toMatchObject({ jobId: "job-1", workspaceId: "ws-1", runKey: "key" });
    for (const bad of [null, [], "x", { ...row.restart_payload, images: [{ mediaId: "ws/ws-2/src/a.jpg" }] }, { ...row.restart_payload, creditBudget: 0 }]) {
      expect(restoredPayload({ ...row, restart_payload: bad }, "key")).toBeNull();
    }
  });
});

describe("never charged twice, never run twice", () => {
  it("fences the stopped run and ends with one charge per delivered shot", async () => {
    const before = await balance();
    const jobId = await newJob({ runKey: "k-old", status: "generating" });
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true });
    const oldRun = store.forRun("k-old");
    await saveRunAsset(jobId, "s01_main", 2);

    expect((await requeueForRestart(db as unknown as Db, payloadFor(jobId, "k-old"), "interrupted", { log: silent })).requeued).toBe(true);
    const [claimed] = await claimRestartedJobs(db as unknown as Db, { log: silent });
    const newRun = store.forRun(claimed.runKey!);

    // The stopped run can no longer heartbeat, move the job, charge or release.
    expect(await oldRun.heartbeat(jobId)).toBe(false);
    expect(await oldRun.setJobState(jobId, "qc")).toBe(false);
    const charge = (ref: string, credits: number) => ({
      reason: "charge" as const,
      credits,
      ref,
      note: "shot passed",
      jobId,
      workspaceId: ws,
      at: new Date(),
    });
    await expect(oldRun.appendLedger(charge("s01_main", 2))).rejects.toBeInstanceOf(JobAbandonedError);

    // The new run delivers two shots and charges each once; a repeat charge
    // of the same shot is a no op in the ledger.
    expect(await newRun.setJobState(jobId, "generating")).toBe(true);
    await newRun.appendLedger(charge("s01_main", 2));
    await newRun.appendLedger(charge("s02_scene", 3));
    await newRun.appendLedger(charge("s01_main", 2));
    await newRun.releaseAllHeld(jobId, ws);
    expect(await newRun.setJobState(jobId, "done")).toBe(true);

    const charges = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.jobId, jobId), eq(creditLedger.reason, "charge")));
    expect(charges.map((c) => c.stepKey).sort()).toEqual(["s01_main", "s02_scene"]);
    expect(await held(jobId)).toBe(0);
    expect(await balance()).toBe(before - 5);
    expect(await jobRow(jobId)).toMatchObject({ status: "done", creditsCharged: 5 });
  });

  it("never charges a superseded asset, even with a file recorded against it", async () => {
    const jobId = await newJob({ runKey: "k-sup", status: "generating" });
    const assetId = await saveRunAsset(jobId, "s01_main", 2);
    await requeueForRestart(db as unknown as Db, payloadFor(jobId, "k-sup"), "interrupted", { log: silent });
    await db.insert(channelSpecs).values({ id: "restart-test-spec", version: 1, spec: {} }).onConflictDoNothing();
    await db.insert(assetVariants).values({
      workspaceId: ws,
      assetId,
      channelSpecId: "restart-test-spec",
      r2Key: `ws/${ws}/jobs/${jobId}/files/amazon/main.jpg`,
      filename: "main.jpg",
    });
    expect(await deliveredCharges(db as unknown as Db, { jobId, workspaceId: ws })).toEqual([]);
  });

  it("stops the stopped run from starting a new provider call once its signal fires", async () => {
    let calls = 0;
    const controller = new AbortController();
    const deps = withRunDeadline({
      runDeadline: { stopStartingAt: Number.MAX_SAFE_INTEGER, signal: controller.signal },
      clock: { now: () => new Date() },
      generator: {
        generate: async () => {
          calls += 1;
          throw new Error("would have called a provider");
        },
      },
    } as unknown as PipelineDeps);
    controller.abort(new Error("shutdown"));
    await expect(deps.generator.generate({} as never)).rejects.toBeInstanceOf(ShotUnavailableError);
    expect(calls).toBe(0);
  });

  it("a simulated SIGTERM mid pack ends with the job done on the next instance, charged once per shot", async () => {
    const before = await balance();
    const jobId = await newJob({ runKey: "k-sig", status: "queued" });
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true });
    let providerCalls = 0;
    let release: () => void = () => undefined;

    // The old instance: the pack starts, delivers one shot's generation,
    // then hangs past the grace window.
    const oldInstance = new InlinePackRunner<GeneratePackInput>(
      { concurrency: 1, shutdownGraceMs: 10, heartbeatMs: 60_000 },
      {
        runPack: async (payload, signal) => {
          const run = store.forRun(payload.runKey!);
          await run.setJobState(payload.jobId, "generating");
          providerCalls += 1;
          await saveRunAsset(payload.jobId, "s01_main", 2);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          // Woken after the drain: the run is fenced and starts nothing new.
          if (!signal.aborted && (await run.heartbeat(payload.jobId))) providerCalls += 1;
        },
        settle: async (payload, reason) => {
          await settleInterruptedJob(db as unknown as Db, payload, reason);
        },
        requeue: async (payload, reason) =>
          (await requeueForRestart(db as unknown as Db, payload, reason, { log: silent })).requeued,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
    );
    void oldInstance.submit(payloadFor(jobId, "k-sig"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const report = await oldInstance.shutdown("SIGTERM");
    expect(report).toMatchObject({ interrupted: 1, requeued: 1 });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The new instance picks it up and runs it to the end.
    const newInstance = new InlinePackRunner<GeneratePackInput>(
      { concurrency: 1, shutdownGraceMs: 10, heartbeatMs: 60_000 },
      {
        runPack: async (payload) => {
          const run = store.forRun(payload.runKey!);
          expect(await run.setJobState(payload.jobId, "generating")).toBe(true);
          for (const [shot, credits] of [["s01_main", 2], ["s02_scene", 3]] as const) {
            providerCalls += 1;
            await saveRunAsset(payload.jobId, shot, credits);
            await run.appendLedger({ reason: "charge", credits, ref: shot, note: "passed", jobId: payload.jobId, workspaceId: ws, at: new Date() });
          }
          await run.releaseAllHeld(payload.jobId, ws);
          await run.setJobState(payload.jobId, "done");
        },
        settle: async () => undefined,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
    );
    const claimed = await claimRestartedJobs(db as unknown as Db, { log: silent });
    expect(claimed.map((p) => p.jobId)).toEqual([jobId]);
    await Promise.all(claimed.map((p) => newInstance.submit(p)));

    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: "done", restartCount: 1, creditsCharged: 5 });
    // One generation on the old instance, two on the new one: the stopped
    // run started nothing after the drain.
    expect(providerCalls).toBe(3);
    const charges = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.jobId, jobId), eq(creditLedger.reason, "charge")));
    expect(charges).toHaveLength(2);
    expect(await held(jobId)).toBe(0);
    expect(await balance()).toBe(before - 5);
    expect(await deliveredCharges(db as unknown as Db, { jobId, workspaceId: ws })).toEqual([]);
    const working = await client.query(`select id from generation_jobs where id = $1 and status not in ('done', 'failed', 'canceled')`, [jobId]);
    expect(working.rows).toHaveLength(0);
  });
});


describe("restart age limit", () => {
  it("refuses an interrupted run older than the configured window", async () => {
    const jobId = await newJob({ runKey: "old-run", status: "generating" });
    await db.update(generationJobs).set({ createdAt: new Date(Date.now() - 61 * 60_000) }).where(eq(generationJobs.id, jobId));
    expect(await requeueForRestart(db as unknown as Db, payloadFor(jobId, "old-run"), "interrupted", { log: silent })).toEqual({ requeued: false, why: "too_old" });
    expect(await held(jobId)).toBe(8);
  });
});

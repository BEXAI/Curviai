import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assetVariants,
  assets,
  channelSpecs,
  creditLedger,
  generationJobs,
  packFiles,
  products,
  workspaces,
  type JobStatus,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import type { GeneratePackInput } from "@curvi/trigger/runner";

const afterMock = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after: afterMock }));

import {
  SETTLED_JOB_MESSAGES,
  enqueueGeneratePack,
  getInlinePackRunner,
  heartbeatQueuedJobs,
  settleInterruptedJob,
  PACKAGING_RESERVE_MS,
  stopStartingAt,
} from "./enqueue";
import {
  InlinePackRunner,
  InlineRunnerClosedError,
  installInlinePackRunner,
  resetInlinePackRunnerForTests,
  type InlinePackJob,
} from "./inline-runner";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let otherWs: string;
let productId: string;

const OLD = new Date(Date.now() - 20 * 60 * 1000);
const SPEC_ID = "amazon.secondary";

async function balance(workspaceId = ws): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [workspaceId]);
  return Number(result.rows[0].credit_balance);
}

async function held(jobId: string): Promise<number> {
  const result = await client.query<{ held: string | number }>(
    "select coalesce(sum(-delta), 0) as held from credit_ledger where job_id = $1 and reason in ('reserve', 'release')",
    [jobId],
  );
  return Number(result.rows[0].held);
}

async function jobWith(status: JobStatus, opts: { reserve?: number; updatedAt?: Date } = {}): Promise<string> {
  const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "queued" }).returning();
  if (opts.reserve) {
    await client.query("select reserve_credits($1, $2, $3)", [ws, opts.reserve, job.id]);
  }
  await db
    .update(generationJobs)
    .set({ status, updatedAt: opts.updatedAt ?? new Date() })
    .where(eq(generationJobs.id, job.id));
  return job.id;
}

async function jobRow(id: string) {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
  return row;
}

/** An asset row as DbJobStore.saveAsset writes it. */
async function assetRow(jobId: string, shotId: string, credits: number, opts: { approved: boolean }): Promise<string> {
  const [row] = await db
    .insert(assets)
    .values({
      workspaceId: ws,
      jobId,
      shotType: "alt_angle_white",
      approved: opts.approved,
      qc: { shotId, credits, status: opts.approved ? "passed" : "needs_review" },
    })
    .returning();
  return row.id;
}

/** An approved asset whose file savePack uploaded (it has a variant). */
async function deliveredAsset(jobId: string, shotId: string, credits: number): Promise<string> {
  const assetId = await assetRow(jobId, shotId, credits, { approved: true });
  await db.insert(assetVariants).values({
    workspaceId: ws,
    assetId,
    channelSpecId: SPEC_ID,
    r2Key: `ws/${ws}/jobs/${jobId}/amazon/${shotId}.jpg`,
    filename: `${shotId}.jpg`,
  });
  return assetId;
}

/** The compliance report row savePack writes last. */
async function reportRow(jobId: string): Promise<void> {
  await db.insert(packFiles).values({
    workspaceId: ws,
    jobId,
    kind: "report",
    filename: "compliance-report.json",
    r2Key: `ws/${ws}/jobs/${jobId}/compliance-report.json`,
  });
}

async function charges(jobId: string): Promise<Array<{ stepKey: string | null; credits: number }>> {
  const result = await client.query<{ step_key: string | null; credits: string | number }>(
    "select step_key, -delta as credits from credit_ledger where job_id = $1 and reason = 'charge' order by step_key",
    [jobId],
  );
  return result.rows.map((r) => ({ stepKey: r.step_key, credits: Number(r.credits) }));
}

function appDb(): Db {
  return db as unknown as Db;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Settle" }).returning();
  const [o] = await db.insert(workspaces).values({ name: "Other" }).returning();
  ws = w.id;
  otherWs = o.id;
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  productId = p.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 1000, reason: "grant", source: "system" });
  await db.insert(channelSpecs).values({ id: SPEC_ID, version: 1, spec: {} });
});

afterAll(async () => {
  await client.close();
});

describe("settleInterruptedJob", () => {
  it("fails a running job and returns its whole hold", async () => {
    const id = await jobWith("generating", { reserve: 10 });
    const before = await balance();

    const outcome = await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.interrupted);

    expect(outcome).toBe("failed");
    const row = await jobRow(id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe(SETTLED_JOB_MESSAGES.interrupted);
    expect(await balance()).toBe(before + 10);
    expect(await held(id)).toBe(0);
  });

  it("fails a job that never started and returns its hold", async () => {
    const id = await jobWith("queued", { reserve: 6 });
    const before = await balance();

    expect(await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.not_started)).toBe(
      "failed",
    );
    expect((await jobRow(id)).error).toBe(SETTLED_JOB_MESSAGES.not_started);
    expect(await balance()).toBe(before + 6);
  });

  it("never touches a job that already finished", async () => {
    const id = await jobWith("generating", { reserve: 10 });
    await client.query("select charge_credits($1, $2, $3, $4)", [ws, 4, id, "shot-1"]);
    await client.query("select release_credits($1, $2)", [ws, id]);
    await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, id));
    const before = await balance();

    const outcome = await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.crashed);

    expect(outcome).toBe("already_final");
    const row = await jobRow(id);
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    expect(await balance()).toBe(before);
  });

  it("charges every delivered approved asset of a pack stopped between savePack and its charges", async () => {
    // The runner's real order: shots needing review are released, savePack
    // writes the variants and then the report row, and only then do the
    // charges run. The stop lands after the report row, before any charge.
    const id = await jobWith("packaging", { reserve: 10 });
    await client.query("select release_credits($1, $2, $3)", [ws, id, 2]);
    await deliveredAsset(id, "shot-1", 4);
    await deliveredAsset(id, "shot-2", 3);
    await assetRow(id, "shot-3", 2, { approved: false });
    await assetRow(id, "shot-4", 1, { approved: true });
    await reportRow(id);
    expect(await charges(id)).toEqual([]);
    const before = await balance();

    const outcome = await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.interrupted);

    expect(outcome).toBe("done");
    const row = await jobRow(id);
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    // shot-3 needed review and shot-4 was left out of the pack (no variant),
    // so neither is charged.
    expect(await charges(id)).toEqual([
      { stepKey: "shot-1", credits: 4 },
      { stepKey: "shot-2", credits: 3 },
    ]);
    expect(row.creditsCharged).toBe(7);
    // Of the 8 still held, 7 were charged and the last one is released.
    expect(await balance()).toBe(before + 1);
    expect(await held(id)).toBe(0);
  });

  it("never charges an asset twice when the runner already charged part of the pack", async () => {
    const id = await jobWith("packaging", { reserve: 10 });
    await deliveredAsset(id, "shot-1", 4);
    await deliveredAsset(id, "shot-2", 3);
    await reportRow(id);
    // The runner charged shot-1 before the stop; shot-2 is still owed.
    await client.query("select charge_credits($1, $2, $3, $4)", [ws, 4, id, "shot-1"]);
    const before = await balance();

    expect(await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.timed_out)).toBe(
      "done",
    );

    expect(await charges(id)).toEqual([
      { stepKey: "shot-1", credits: 4 },
      { stepKey: "shot-2", credits: 3 },
    ]);
    expect((await jobRow(id)).creditsCharged).toBe(7);
    expect(await balance()).toBe(before + 3);
    expect(await held(id)).toBe(0);
  });

  it("charges nothing and fails the job when the pack was never delivered", async () => {
    const id = await jobWith("packaging", { reserve: 6 });
    // Variants exist but savePack stopped before the report row.
    await deliveredAsset(id, "shot-1", 4);
    const before = await balance();

    expect(await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.timed_out)).toBe(
      "failed",
    );

    expect((await jobRow(id)).error).toBe(SETTLED_JOB_MESSAGES.timed_out);
    expect(await charges(id)).toEqual([]);
    expect(await balance()).toBe(before + 6);
  });

  it("still settles a delivered pack when one charge is refused, releasing what is left", async () => {
    const id = await jobWith("packaging", { reserve: 5 });
    await deliveredAsset(id, "shot-1", 4);
    // Recorded at more credits than the hold covers: the ledger refuses it.
    await deliveredAsset(id, "shot-2", 50);
    await reportRow(id);
    const before = await balance();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.crashed)).toBe(
        "done",
      );
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }

    expect(await charges(id)).toEqual([{ stepKey: "shot-1", credits: 4 }]);
    expect(await balance()).toBe(before + 1);
    expect(await held(id)).toBe(0);
  });

  it("does not settle a job through another workspace", async () => {
    const id = await jobWith("generating", { reserve: 5 });

    await settleInterruptedJob(appDb(), { jobId: id, workspaceId: otherWs }, SETTLED_JOB_MESSAGES.interrupted);

    expect((await jobRow(id)).status).toBe("generating");
    expect(await held(id)).toBe(5);
  });

  it("is safe to run twice", async () => {
    const id = await jobWith("analyzing", { reserve: 8 });
    const before = await balance();
    await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.interrupted);
    expect(await settleInterruptedJob(appDb(), { jobId: id, workspaceId: ws }, SETTLED_JOB_MESSAGES.interrupted)).toBe(
      "already_final",
    );
    expect(await balance()).toBe(before + 8);
  });
});

describe("stopStartingAt", () => {
  it("leaves the packaging reserve before the run cap, and at least half the cap for shots", () => {
    expect(stopStartingAt(1_000, 25 * 60_000)).toBe(1_000 + 25 * 60_000 - PACKAGING_RESERVE_MS);
    expect(stopStartingAt(0, 60_000)).toBe(30_000);
  });
});

describe("heartbeatQueuedJobs", () => {
  it("bumps queued jobs only", async () => {
    const waiting = await jobWith("queued", { updatedAt: OLD });
    const started = await jobWith("generating", { updatedAt: OLD });

    await heartbeatQueuedJobs(appDb(), [waiting, started]);

    expect((await jobRow(waiting)).updatedAt.getTime()).toBeGreaterThan(OLD.getTime());
    expect((await jobRow(started)).updatedAt.getTime()).toBe(OLD.getTime());
  });

  it("bumps a follow up waiting under its run key, and not a job whose key moved on", async () => {
    const followUp = await jobWith("generating", { updatedAt: OLD });
    await db.update(generationJobs).set({ runKey: "follow-up-key", updatedAt: OLD }).where(eq(generationJobs.id, followUp));
    const replaced = await jobWith("generating", { updatedAt: OLD });
    await db.update(generationJobs).set({ runKey: "newer-key", updatedAt: OLD }).where(eq(generationJobs.id, replaced));
    const finished = await jobWith("done", { updatedAt: OLD });
    await db.update(generationJobs).set({ runKey: "done-key", updatedAt: OLD }).where(eq(generationJobs.id, finished));

    await heartbeatQueuedJobs(appDb(), [followUp, replaced, finished], ["follow-up-key", "stale-key", "done-key"]);

    expect((await jobRow(followUp)).updatedAt.getTime()).toBeGreaterThan(OLD.getTime());
    expect((await jobRow(replaced)).updatedAt.getTime()).toBe(OLD.getTime());
    expect((await jobRow(finished)).updatedAt.getTime()).toBe(OLD.getTime());
  });

  it("does nothing for an empty list", async () => {
    await expect(heartbeatQueuedJobs(appDb(), [])).resolves.toBeUndefined();
  });
});

describe("enqueueGeneratePack inline mode", () => {
  const payload = {
    jobId: "00000000-0000-4000-8000-0000000000aa",
    workspaceId: "00000000-0000-4000-8000-0000000000bb",
  } as GeneratePackInput;
  let ran: string[];
  let runner: InlinePackRunner<InlinePackJob>;

  beforeEach(() => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "");
    afterMock.mockReset();
    ran = [];
    resetInlinePackRunnerForTests();
    // Installed first, without signal hooks, so getInlinePackRunner returns
    // this runner instead of wiring the real pipeline.
    runner = installInlinePackRunner(
      () =>
        new InlinePackRunner<InlinePackJob>(
          { concurrency: 1, shutdownGraceMs: 0, heartbeatMs: 60_000 },
          {
            runPack: async (p) => {
              ran.push(p.jobId);
            },
            settle: async () => undefined,
          },
        ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetInlinePackRunnerForTests();
  });

  it("hands the job to the process wide runner after the response", async () => {
    expect(getInlinePackRunner()).toBe(runner);
    await expect(enqueueGeneratePack(payload)).resolves.toBe("inline");
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([]);

    const task = afterMock.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(ran).toEqual([payload.jobId]);
  });

  it("refuses new work while draining so the caller fails the job and releases its hold", async () => {
    await runner.shutdown("SIGTERM");
    await expect(enqueueGeneratePack(payload)).rejects.toBeInstanceOf(InlineRunnerClosedError);
    expect(afterMock).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
  });
});

describe("SETTLED_JOB_MESSAGES", () => {
  it("follow the copy rules: no dashes as punctuation, no arrows", () => {
    for (const message of Object.values(SETTLED_JOB_MESSAGES)) {
      expect(message).not.toMatch(/ [-–—] |→|->/);
      expect(message).toMatch(/credits were released/i);
    }
  });
});

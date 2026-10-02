import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { generationJobs, products, workspaces, creditLedger } from "@curvi/db/schema";
import { recoverOrphanJobs } from "./recovery";
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let workspaceId: string;
let productId: string;
const now = new Date();
const stale = new Date(now.getTime() - 6 * 60_000);
beforeAll(async () => {
  fixture = await createTestDb(); db = fixture.db as unknown as Db;
  [workspaceId] = (await db.insert(workspaces).values({ name: "Recovery" }).returning()).map((w) => w.id);
  [productId] = (await db.insert(products).values({ workspaceId, title: "Mug", mode: "listing" }).returning()).map((p) => p.id);
  await db.insert(creditLedger).values({ workspaceId, delta: 100, reason: "grant", source: "system" });
});
afterAll(async () => fixture.client.close());
async function makeJob(status: "queued" | "generating", heartbeatAt = stale) {
  const [job] = await db.insert(generationJobs).values({ workspaceId, productId, status: "queued", runKey: crypto.randomUUID(), runnerId: "dead-process", heartbeatAt, updatedAt: stale }).returning();
  await fixture.client.query("select reserve_credits($1, 5, $2)", [workspaceId, job.id]);
  await db.update(generationJobs).set({ status, startedAt: status === "queued" ? null : stale, updatedAt: stale, heartbeatAt,
    restartPayload: { jobId: job.id, workspaceId, tier: "starter", mode: "listing", channels: ["amazon"], creditBudget: 5, images: [{ mediaId: `ws/${workspaceId}/src/mug.jpg` }], brandColors: [] },
  }).where(eq(generationJobs.id, job.id));
  return job;
}
async function row(id: string) { return (await db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0]; }
async function held(id: string) { return Number((await fixture.client.query<{ held: number }>("select coalesce(sum(-delta),0) as held from credit_ledger where job_id=$1 and reason in ('reserve','release')", [id])).rows[0].held); }
describe("orphan recovery", () => {
  it("restores a prepared but never-started followup exactly once with its original hold", async () => {
    const job = await makeJob("generating");
    await db.update(generationJobs).set({ startedAt: null, restartPayload: {
      kind: "follow_up", reason: "regenerate", jobId: job.id, workspaceId, creditBudget: 5,
      baseCostMicros: 100, channels: ["amazon"], existingFilesBySpec: { "amazon.secondary": 9 }, acceptedAt: stale.toISOString(),
      shots: [{ id: "scene.v2", type: "lifestyle", method: "composite_generate", sourceMediaId: `ws/${workspaceId}/src/mug.jpg`, channels: ["amazon.secondary"], stylePreset: "studio", credits: 5, priority: 1, variation: 2 }],
    } }).where(eq(generationJobs.id, job.id));
    const submitted: unknown[] = [];
    const options = { now, owner: "new-process", submit: (payload: unknown) => { submitted.push(payload); } };
    await Promise.all([recoverOrphanJobs(db, options), recoverOrphanJobs(db, options)]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ kind: "follow_up", reason: "regenerate", jobId: job.id, baseCostMicros: 100 });
    expect((await row(job.id)).status).toBe("generating");
    expect(await held(job.id)).toBe(5);
  });
  it("settles queued work older than the one-hour recovery window", async () => {
    const job = await makeJob("queued");
    await db.update(generationJobs).set({ createdAt: new Date(now.getTime() - 61 * 60_000) }).where(eq(generationJobs.id, job.id));
    await recoverOrphanJobs(db, { now, owner: "new-process", submit: () => { throw Error("too old"); } });
    expect((await row(job.id)).status).toBe("failed");
    expect(await held(job.id)).toBe(0);
  });
  it("claims never-started work once under a new key and preserves its hold", async () => {
    const job = await makeJob("queued"); const submitted: string[] = [];
    const options = { now, owner: "new-process", submit: async (p: { jobId: string }) => { submitted.push(p.jobId); } };
    await Promise.all([recoverOrphanJobs(db, options), recoverOrphanJobs(db, options)]);
    expect(submitted).toEqual([job.id]);
    expect(await row(job.id)).toMatchObject({ status: "queued", runnerId: "new-process" });
    expect((await row(job.id)).runKey).not.toBe(job.runKey);
    expect(await held(job.id)).toBe(5);
  });
  it("settles a running crash, while a fresh heartbeat survives regardless of progress age", async () => {
    const dead = await makeJob("generating"); const alive = await makeJob("generating", now);
    const result = await recoverOrphanJobs(db, { now, owner: "new-process", submit: () => { throw Error("must not run"); } });
    expect(result).toMatchObject({ settled: 1, failures: 0 });
    expect(await row(dead.id)).toMatchObject({ status: "failed", runnerId: null });
    expect(await held(dead.id)).toBe(0);
    expect(await row(alive.id)).toMatchObject({ status: "generating", runnerId: "dead-process" });
    expect(await held(alive.id)).toBe(5);
  });
});

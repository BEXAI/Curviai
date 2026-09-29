import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditLedger, generationJobs, packFiles, products, workspaces, type JobStatus } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { RECONCILED_JOB_ERROR, reconcileStaleJobs, sweepStaleJobs } from "./reconcile";

// The scheduled stale job sweep against the real migrations in PGlite: it
// settles stale jobs in every workspace, returns each one's hold exactly once
// and never touches live or finished jobs.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const workspaceIds: string[] = [];
const productIds: string[] = [];

const STALE = new Date(Date.now() - 31 * 60 * 1000);

async function balanceOf(workspaceId: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [workspaceId]);
  return Number(result.rows[0].credit_balance);
}

async function jobWith(index: number, status: JobStatus, updatedAt: Date, reserve = 10): Promise<string> {
  const workspaceId = workspaceIds[index];
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId, productId: productIds[index], status: "queued" })
    .returning();
  await client.query("select reserve_credits($1, $2, $3)", [workspaceId, reserve, job.id]);
  await db.update(generationJobs).set({ status, updatedAt }).where(eq(generationJobs.id, job.id));
  return job.id;
}

async function statusOf(id: string): Promise<{ status: string; error: string | null }> {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
  return { status: row.status, error: row.error };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  for (const name of ["Sweep A", "Sweep B"]) {
    const [w] = await db.insert(workspaces).values({ name, plan: "starter" }).returning();
    const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
    await db.insert(creditLedger).values({ workspaceId: w.id, delta: 100, reason: "grant", source: "system" });
    workspaceIds.push(w.id);
    productIds.push(p.id);
  }
});

afterAll(async () => {
  await client.close();
});

describe("sweepStaleJobs", () => {
  it("fails stale jobs in every workspace and returns their holds", async () => {
    const a = await jobWith(0, "generating", STALE, 12);
    const b = await jobWith(1, "queued", STALE, 8);
    const beforeA = await balanceOf(workspaceIds[0]);
    const beforeB = await balanceOf(workspaceIds[1]);

    const result = await sweepStaleJobs(db as unknown as Db);

    expect(result.releaseFailures).toEqual([]);
    expect(result.reconciled.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(result.reconciled.find((r) => r.id === a)?.workspaceId).toBe(workspaceIds[0]);
    expect(await statusOf(a)).toEqual({ status: "failed", error: RECONCILED_JOB_ERROR });
    expect(await statusOf(b)).toEqual({ status: "failed", error: RECONCILED_JOB_ERROR });
    expect(await balanceOf(workspaceIds[0])).toBe(beforeA + 12);
    expect(await balanceOf(workspaceIds[1])).toBe(beforeB + 8);
  });

  it("keeps charged credits charged and releases only what is still held", async () => {
    const id = await jobWith(0, "generating", STALE, 10);
    await client.query("select charge_credits($1, $2, $3, $4)", [workspaceIds[0], 4, id, "shot-1"]);
    await db.update(generationJobs).set({ updatedAt: STALE }).where(eq(generationJobs.id, id));
    const before = await balanceOf(workspaceIds[0]);

    await sweepStaleJobs(db as unknown as Db);

    expect((await statusOf(id)).status).toBe("failed");
    expect(await balanceOf(workspaceIds[0])).toBe(before + 6);
  });

  it("leaves live and finished jobs alone", async () => {
    const live = await jobWith(0, "generating", new Date());
    const done = await jobWith(1, "generating", STALE);
    await db.update(generationJobs).set({ status: "done", updatedAt: STALE }).where(eq(generationJobs.id, done));

    const result = await sweepStaleJobs(db as unknown as Db);

    expect(result.reconciled.map((r) => r.id)).not.toContain(live);
    expect(result.reconciled.map((r) => r.id)).not.toContain(done);
    expect((await statusOf(live)).status).toBe("generating");
    expect((await statusOf(done)).status).toBe("done");
  });

  it("settles oldest first within the batch limit", async () => {
    const older = await jobWith(0, "qc", new Date(STALE.getTime() - 60_000));
    const newer = await jobWith(0, "qc", STALE);
    const before = await balanceOf(workspaceIds[0]);

    const first = await sweepStaleJobs(db as unknown as Db, { limit: 1 });
    expect(first.reconciled.map((r) => r.id)).toEqual([older]);
    const rest = await sweepStaleJobs(db as unknown as Db);
    expect(rest.reconciled.map((r) => r.id)).toEqual([newer]);
    expect(await balanceOf(workspaceIds[0])).toBe(before + 20);
  });

  it("releases once when two sweeps overlap", async () => {
    const id = await jobWith(1, "analyzing", STALE, 9);
    const before = await balanceOf(workspaceIds[1]);

    const results = await Promise.all([sweepStaleJobs(db as unknown as Db), sweepStaleJobs(db as unknown as Db)]);

    const ids = results.flatMap((r) => r.reconciled.map((job) => job.id));
    expect(ids).toEqual([id]);
    expect(await balanceOf(workspaceIds[1])).toBe(before + 9);
  });

  it("returns an orphaned follow up on a delivered pack to done and keeps its files", async () => {
    const id = await jobWith(0, "generating", STALE, 5);
    await db.insert(packFiles).values({
      workspaceId: workspaceIds[0],
      jobId: id,
      kind: "report",
      filename: "report.pdf",
      r2Key: `ws/${workspaceIds[0]}/${id}/report.pdf`,
    });
    const [beforeRow] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
    const before = await balanceOf(workspaceIds[0]);

    const result = await sweepStaleJobs(db as unknown as Db);

    expect(result.reconciled.map((r) => r.id)).toContain(id);
    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    expect(row.runKey).not.toBe(beforeRow.runKey);
    expect(await balanceOf(workspaceIds[0])).toBe(before + 5);
  });

  it("the workspace reconciler uses the same delivered rule", async () => {
    const delivered = await jobWith(1, "generating", STALE, 3);
    await db.insert(packFiles).values({
      workspaceId: workspaceIds[1],
      jobId: delivered,
      kind: "report",
      filename: "report.pdf",
      r2Key: `ws/${workspaceIds[1]}/${delivered}/report.pdf`,
    });
    const undelivered = await jobWith(1, "generating", STALE, 4);
    const live = await jobWith(1, "generating", new Date(), 2);
    const before = await balanceOf(workspaceIds[1]);

    const ids = await reconcileStaleJobs(db as unknown as Db, { workspaceId: workspaceIds[1] });

    expect(ids.sort()).toEqual([delivered, undelivered].sort());
    expect((await statusOf(delivered)).status).toBe("done");
    expect(await statusOf(undelivered)).toEqual({ status: "failed", error: RECONCILED_JOB_ERROR });
    expect((await statusOf(live)).status).toBe("generating");
    expect(await balanceOf(workspaceIds[1])).toBe(before + 7);
    // Settle the live job so later cases start clean.
    await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, live));
  });

  it("returns nothing when no job is stale", async () => {
    expect(await sweepStaleJobs(db as unknown as Db)).toEqual({ reconciled: [], releaseFailures: [] });
  });
});

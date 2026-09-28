import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditLedger, generationJobs, members, products, workspaces, type JobStatus } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { DbService } from "./db";

// The stale run reconciler in getJob (Update.md 3.1): only a run that has
// not heartbeated within the window is failed, and its hold is released once.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let productId: string;
const userId = "00000000-0000-4000-8000-000000000001";

const STALE = new Date(Date.now() - 31 * 60 * 1000);

async function balance(): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [ws]);
  return Number(result.rows[0].credit_balance);
}

async function jobWith(status: JobStatus, updatedAt: Date, reserve = 10): Promise<string> {
  const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status }).returning();
  await client.query("select reserve_credits($1, $2, $3)", [ws, reserve, job.id]);
  await db.update(generationJobs).set({ status, updatedAt }).where(eq(generationJobs.id, job.id));
  return job.id;
}

function service(): DbService {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => userId,
    getSupabase: async () => null,
  });
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Reconcile", plan: "starter" }).returning();
  ws = w.id;
  await db.insert(members).values({ workspaceId: ws, userId, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  productId = p.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 100, reason: "grant", source: "system" });
});

afterAll(async () => {
  await client.close();
});

describe("DbService.getJob stale run reconciler", () => {
  it("fails a run that stopped heartbeating and returns its hold", async () => {
    const id = await jobWith("generating", STALE);
    const before = await balance();

    const job = await service().getJob(ws, id);

    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("interrupted");
    expect(await balance()).toBe(before + 10);
  });

  it("leaves a run alone while it keeps heartbeating", async () => {
    const id = await jobWith("generating", new Date());
    const before = await balance();

    const job = await service().getJob(ws, id);

    expect(job?.status).toBe("generating");
    expect(await balance()).toBe(before);
  });

  it("never touches a finished job, however old", async () => {
    const id = await jobWith("generating", STALE);
    await db.update(generationJobs).set({ status: "done", updatedAt: STALE }).where(eq(generationJobs.id, id));

    const job = await service().getJob(ws, id);

    expect(job?.status).toBe("done");
  });

  it("releases once when several requests reconcile the same job", async () => {
    const id = await jobWith("qc", STALE);
    const before = await balance();

    const results = await Promise.all([service().getJob(ws, id), service().getJob(ws, id), service().getJob(ws, id)]);

    expect(results.every((job) => job?.status === "failed")).toBe(true);
    expect(await balance()).toBe(before + 10);
    const releases = await db.select().from(creditLedger).where(eq(creditLedger.jobId, id));
    expect(releases.filter((r) => r.reason === "release")).toHaveLength(1);
  });
});

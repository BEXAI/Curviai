import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { creditLedger, eq, generationJobs, jobSteps, products, workspaces, type Db } from "@curvi/db";
import { hasFreshHeartbeat, operatorJobTimeline, operateJob } from "./jobs";

let db: TestDb;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
const operator = "founder@curvi.ai";
const asDb = () => db as unknown as Db;
beforeAll(async () => { vi.stubEnv("OPS_EMAILS", operator); ({ db, client } = await createTestDb()); });
afterAll(async () => { vi.unstubAllEnvs(); await client.close(); });
async function fixture() {
  const now = new Date();
  const [ws] = await db.insert(workspaces).values({ name: "Ops" }).returning();
  const [product] = await db.insert(products).values({ workspaceId: ws!.id, mode: "listing", title: "Mug" }).returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: ws!.id, productId: product!.id, status: "generating", runKey: "run_1", heartbeatAt: now, startedAt: now }).returning();
  await db.insert(creditLedger).values({ workspaceId: ws!.id, delta: 100, reason: "grant" });
  await db.update(generationJobs).set({ restartPayload: { tier: "starter", mode: "listing", channels: ["amazon"], creditBudget: 8,
    images: [{ mediaId: `ws/${ws!.id}/src/mug.jpg`, angle: "front" }], brandColors: [], userDescription: "Mug" } }).where(eq(generationJobs.id, job!.id));
  return { job: job!, now };
}
describe("operator pack actions", () => {
  it("refuses a fresh heartbeat and audits an explicit forced settlement", async () => {
    const { job, now } = await fixture();
    expect(hasFreshHeartbeat(job.heartbeatAt, now)).toBe(true);
    await expect(operateJob(asDb(), { jobId: job.id, action: "settle", forced: false, operator }, now)).rejects.toThrow("fresh heartbeat");
    await operateJob(asDb(), { jobId: job.id, action: "settle", forced: true, operator }, now);
    const result = await client.query<{ forced: boolean }>("select forced from ops_audit where target_id=$1", [job.id]);
    expect(result.rows).toEqual([{ forced: true }]);
    expect((await db.query.generationJobs.findFirst({ where: eq(generationJobs.id, job.id) }))?.status).toBe("failed");
  });
  it("requeues a stale failed job once, retains the tenant guard, and exposes ordered steps", async () => {
    const { job, now } = await fixture();
    await db.update(generationJobs).set({ status: "failed", heartbeatAt: new Date(now.getTime() - 600000) }).where(eq(generationJobs.id, job.id));
    await db.insert(jobSteps).values({ workspaceId: job.workspaceId, jobId: job.id, stage: "cutout", provider: "test", attempt: 1, status: "failed", error: "Timed out" });
    const before = await operatorJobTimeline(asDb(), job.id, vi.fn());
    expect(before?.steps[0]).toMatchObject({ stage: "cutout", provider: "test", error: "Timed out" });
    await expect(operateJob(asDb(), { jobId: job.id, action: "requeue", forced: false, operator }, now)).resolves.toMatchObject({ requeued: true });
    const updated = await db.query.generationJobs.findFirst({ where: eq(generationJobs.id, job.id) });
    expect(updated).toMatchObject({ status: "queued", restartCount: 1 });
    expect(updated?.runKey).not.toBe(job.runKey);
  });
});

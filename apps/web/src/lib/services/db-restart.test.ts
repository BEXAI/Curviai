import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assets, generationJobs, jobSteps, members, products, signupGrants, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { RESTARTED_PACK_NOTICE } from "@/lib/jobs/restart-copy";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: vi.fn(async () => "inline") }));

import { DbService } from "./db";

// The pack page after a deploy restart (docs/phases/PHASE_18.md P18-23):
// getJob says the pack started again, and the superseded assets of the
// stopped run never show up as cards.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const USER = "00000000-0000-4000-8000-000000002301";

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("getJob after a deploy restart", () => {
  it("marks a restarted pack and shows only the new run's shots", async () => {
    const [w] = await db.insert(workspaces).values({ name: "Restarted", plan: "starter" }).returning();
    await db.insert(members).values({ workspaceId: w.id, userId: USER, role: "owner" });
    await db.insert(signupGrants).values({ userId: USER, workspaceId: w.id, credits: 0 });
    const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Candle", mode: "listing" }).returning();
    const [job] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: p.id, status: "generating", restartCount: 1, runKey: "run-2" })
      .returning();
    // The stopped run's asset, superseded by the restart.
    await db.insert(assets).values({
      workspaceId: w.id,
      jobId: job.id,
      shotType: "main",
      approved: false,
      qc: { status: "superseded", supersededShotId: "s01_old", credits: 2 },
    });
    // The new run's plan.
    await db.insert(jobSteps).values({ workspaceId: w.id, jobId: job.id, shotId: "s01_main", stage: "main", provider: "worker", status: "pending" });

    const service = new DbService({ db: db as unknown as Db, getUserId: async () => USER, getSupabase: async () => null });
    const view = await service.getJob(w.id, job.id);

    expect(view?.restarted).toBe(true);
    expect(view?.shots.map((s) => s.shotId)).toEqual(["s01_main"]);

    const [fresh] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: p.id, status: "generating", runKey: "run-3" })
      .returning();
    expect((await service.getJob(w.id, fresh.id))?.restarted).toBeUndefined();
  });

  it("says so in plain words, with no dashes as punctuation", () => {
    expect(RESTARTED_PACK_NOTICE).toBe(
      "We restarted the server while your pack was running, so it started again. You are charged only once.",
    );
    expect(RESTARTED_PACK_NOTICE).not.toMatch(/[‒-―←-⇿]|\s-\s|--|\p{Extended_Pictographic}/u);
  });
});

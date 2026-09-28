import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assetVariants,
  assets,
  generationJobs,
  jobSteps,
  members,
  products,
  signupGrants,
  sourceMedia,
  workspaces,
  type JobStatus,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { loadChannelSpecs, type Db } from "@curvi/db";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: vi.fn(async () => "inline") }));

import { DbService } from "./db";

// The before and after reveal's original photo on DbService.getJob, against
// the real migrations in PGlite: which stored photo is the pack's before,
// and when it is signed. A row outside the workspace prefix cannot exist
// (check constraint source_media_r2_key_workspace_prefix); makeover.test.ts
// covers the key re-check itself.

const R2_ENV = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 500;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  for (const name of Object.keys(R2_ENV)) {
    delete process.env[name];
  }
});

async function makeWorkspace(): Promise<{ id: string; user: string; productId: string }> {
  counter += 1;
  const user = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const [w] = await db.insert(workspaces).values({ name: `WS ${counter}`, plan: "starter" }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: user, role: "owner" });
  await db.insert(signupGrants).values({ userId: user, workspaceId: w.id, credits: 0 });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Kettle", mode: "listing" }).returning();
  return { id: w.id, user, productId: p.id };
}

function service(user: string): DbService {
  return new DbService({ db: db as unknown as Db, getUserId: async () => user, getSupabase: async () => null });
}

async function photo(w: { id: string; productId: string }, name: string, createdAt: Date, kind: "image" | "video" = "image") {
  await db.insert(sourceMedia).values({
    workspaceId: w.id,
    productId: w.productId,
    r2Key: `ws/${w.id}/src/${name}`,
    kind,
    sha256: name.padEnd(64, "0").slice(0, 64),
    createdAt,
  });
}

async function deliveredJob(w: { id: string; productId: string }, createdAt: Date, status: JobStatus = "done") {
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: w.id, productId: w.productId, status, createdAt, updatedAt: new Date() })
    .returning();
  const [asset] = await db
    .insert(assets)
    .values({ workspaceId: w.id, jobId: job.id, shotType: "amazon_main", approved: true, qc: { shotId: "s01_amazon_main" } })
    .returning();
  await db.insert(assetVariants).values({
    workspaceId: w.id,
    assetId: asset.id,
    channelSpecId: "amazon.main",
    r2Key: `ws/${w.id}/jobs/${job.id}/files/amazon/K1.MAIN.jpg`,
    filename: "K1.MAIN.jpg",
    bytes: 1234,
  });
  await db.insert(jobSteps).values({
    workspaceId: w.id,
    jobId: job.id,
    shotId: "s01_amazon_main",
    stage: "amazon_main",
    provider: "worker",
    status: status === "done" ? "done" : "generating",
  });
  return job.id;
}

describe("DbService.getJob original photo for the reveal", () => {
  it("signs the newest still photo stored no later than the pack started", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace();
    const started = new Date("2026-09-20T10:00:00Z");
    await photo(w, "old.jpg", new Date("2026-09-19T10:00:00Z"));
    await photo(w, "used.jpg", started);
    await photo(w, "clip.mp4", new Date("2026-09-20T09:59:00Z"), "video");
    await photo(w, "later.jpg", new Date("2026-09-21T10:00:00Z"));
    const jobId = await deliveredJob(w, started);

    const job = await service(w.user).getJob(w.id, jobId);

    expect(job?.sourceImageUrl).toContain("X-Amz-Signature");
    expect(job?.sourceImageUrl).toContain(encodeURIComponent("used.jpg").replace("%2E", "."));
    expect(job?.sourceImageUrl).not.toContain("later.jpg");
  });

  it("shows no original while the pack runs, without storage, or with no photo from before the pack", async () => {
    const w = await makeWorkspace();
    const started = new Date("2026-09-20T10:00:00Z");
    await photo(w, "after.jpg", new Date("2026-09-22T10:00:00Z"));
    const running = await deliveredJob(w, started, "generating");
    const done = await deliveredJob(w, started);

    // No R2: nothing can be signed.
    expect((await service(w.user).getJob(w.id, done))?.sourceImageUrl ?? null).toBeNull();

    Object.assign(process.env, R2_ENV);
    expect((await service(w.user).getJob(w.id, running))?.sourceImageUrl ?? null).toBeNull();
    // Only a photo added after the pack exists, so it is not this pack's before.
    expect((await service(w.user).getJob(w.id, done))?.sourceImageUrl ?? null).toBeNull();
  });

});

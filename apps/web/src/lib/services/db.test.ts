import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assetVariants,
  assets,
  creditLedger,
  generationJobs,
  jobSteps,
  members,
  packFiles,
  platformSettings,
  products,
  signupGrants,
  sourceMedia,
  workspaces,
  type JobStatus,
  type MemberRole,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, loadChannelSpecs, type Db } from "@curvi/db";
import { tierByKey } from "@curvi/pipeline/seed";

const enqueued = vi.hoisted(() => [] as Array<{ jobId: string; images: Array<{ mediaId: string }> }>);
vi.mock("@/lib/jobs/enqueue", () => ({
  enqueueGeneratePack: vi.fn(async (payload: { jobId: string; images: Array<{ mediaId: string }> }) => {
    enqueued.push(payload);
    return "inline";
  }),
}));

import { DbService, ProvisioningError } from "./db";

// DbService against the real migrations in PGlite: the stale run reconciler
// (Update.md 3.1 and 3.2), the transactional createJob (6.3), the board's
// shot mapping (3.5, 3.6), typed upload reasons (6.8) and file downloads.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let productId: string;
const userId = "00000000-0000-4000-8000-000000000001";

const STALE = new Date(Date.now() - 31 * 60 * 1000);

async function balanceOf(workspaceId: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [workspaceId]);
  return Number(result.rows[0].credit_balance);
}

async function balance(): Promise<number> {
  return balanceOf(ws);
}

async function jobWith(status: JobStatus, updatedAt: Date, reserve = 10, workspaceId = ws, product = productId): Promise<string> {
  const [job] = await db.insert(generationJobs).values({ workspaceId, productId: product, status }).returning();
  await client.query("select reserve_credits($1, $2, $3)", [workspaceId, reserve, job.id]);
  await db.update(generationJobs).set({ status, updatedAt }).where(eq(generationJobs.id, job.id));
  return job.id;
}

function service(user = userId): DbService {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => user,
    getSupabase: async () => null,
  });
}

let userCounter = 100;

/** A fresh workspace with its own member (so getCurrentWorkspace finds it),
 * a product and a credit grant. The member's signup grant is settled, as
 * migration 0012 records for every existing member, so reads do not pay the
 * free grant on top of the fixture's credits. */
async function makeWorkspace(
  credits: number,
  role: MemberRole = "owner",
): Promise<{ id: string; user: string; productId: string }> {
  userCounter += 1;
  const user = `00000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
  const [w] = await db.insert(workspaces).values({ name: `WS ${userCounter}`, plan: "starter" }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: user, role });
  await db.insert(signupGrants).values({ userId: user, workspaceId: w.id, credits: 0 });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Kettle", mode: "listing" }).returning();
  if (credits > 0) {
    await db.insert(creditLedger).values({ workspaceId: w.id, delta: credits, reason: "grant", source: "system" });
  }
  return { id: w.id, user, productId: p.id };
}

function srcKey(workspaceId: string, name: string): string {
  return `ws/${workspaceId}/src/${name}`;
}

const SHA = "a".repeat(64);

async function countRows(workspaceId: string) {
  const [p, m, j] = await Promise.all([
    db.select().from(products).where(eq(products.workspaceId, workspaceId)),
    db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, workspaceId)),
    db.select().from(generationJobs).where(eq(generationJobs.workspaceId, workspaceId)),
  ]);
  return { products: p.length, media: m.length, jobs: j.length };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
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

beforeEach(() => {
  enqueued.length = 0;
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

  it("answers null for an id that is not a uuid instead of a database error", async () => {
    expect(await service().getJob(ws, "not-a-uuid")).toBeNull();
  });
});

describe("stale sweep on list and balance reads (Update.md 3.2)", () => {
  it("shows a stale job as failed in the recent jobs list and returns its hold once", async () => {
    const w = await makeWorkspace(50);
    const id = await jobWith("generating", STALE, 10, w.id, w.productId);
    expect(await balanceOf(w.id)).toBe(40);

    const [a, b, c] = await Promise.all([
      service(w.user).listRecentJobs(w.id),
      service(w.user).listRecentJobs(w.id),
      service(w.user).listRecentJobs(w.id),
    ]);

    for (const list of [a, b, c]) {
      expect(list.find((j) => j.id === id)?.status).toBe("failed");
    }
    expect(await balanceOf(w.id)).toBe(50);
    const releases = await db.select().from(creditLedger).where(eq(creditLedger.jobId, id));
    expect(releases.filter((r) => r.reason === "release")).toHaveLength(1);
  });

  it("restores the balance the workspace summary shows", async () => {
    const w = await makeWorkspace(30);
    await jobWith("analyzing", STALE, 12, w.id, w.productId);
    const live = await jobWith("generating", new Date(), 5, w.id, w.productId);

    const summary = await service(w.user).getCurrentWorkspace();

    expect(summary?.id).toBe(w.id);
    expect(summary?.creditBalance).toBe(25);
    const [liveRow] = await db.select().from(generationJobs).where(eq(generationJobs.id, live));
    expect(liveRow.status).toBe("generating");
  });

  it("only sweeps the caller's workspace", async () => {
    const mine = await makeWorkspace(20);
    const other = await makeWorkspace(20);
    const otherJob = await jobWith("generating", STALE, 10, other.id, other.productId);

    await service(mine.user).listRecentJobs(mine.id);

    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, otherJob));
    expect(row.status).toBe("generating");
    expect(await balanceOf(other.id)).toBe(10);
  });
});

describe("DbService.createJob writes everything or nothing (Update.md 6.3)", () => {
  const CHANNELS = ["amazon.main", "shopify.product"];

  it("a rejected new product pack leaves no product, media or job behind", async () => {
    const w = await makeWorkspace(500);
    const before = await countRows(w.id);

    const result = await service(w.user).createJob(w.id, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `needs-photo-${w.id}`,
      newProductTitle: "Lamp",
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("needs_photo");
    }
    expect(await countRows(w.id)).toEqual(before);
  });

  it("a pack the balance cannot cover leaves no product, media, job or hold behind", async () => {
    const w = await makeWorkspace(1);
    const before = await countRows(w.id);

    const result = await service(w.user).createJob(w.id, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `broke-${w.id}`,
      uploads: [{ key: srcKey(w.id, "photo-1"), sha256: SHA, kind: "image" }],
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("insufficient_credits");
    }
    expect(await countRows(w.id)).toEqual(before);
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, w.id));
    expect(ledger.filter((r) => r.reason === "reserve")).toHaveLength(0);
    expect(await balanceOf(w.id)).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("creates the product, its photo, the job and one hold together", async () => {
    const w = await makeWorkspace(500);
    const before = await countRows(w.id);
    const key = srcKey(w.id, "photo-1");

    const result = await service(w.user).createJob(w.id, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `create-${w.id}`,
      uploads: [{ key, sha256: SHA, kind: "image" }],
      newProductTitle: "Copper kettle",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.job.productTitle).toBe("Copper kettle");
    expect(await countRows(w.id)).toEqual({
      products: before.products + 1,
      media: before.media + 1,
      jobs: before.jobs + 1,
    });
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.jobId, result.job.id));
    expect(ledger.filter((r) => r.reason === "reserve")).toHaveLength(1);
    expect(await balanceOf(w.id)).toBe(500 - result.job.creditsReserved);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].images.map((i) => i.mediaId)).toEqual([key]);
  });

  it("a retry with the same Idempotency-Key replays the job and duplicates nothing", async () => {
    const w = await makeWorkspace(500);
    const input = {
      productId: "new",
      channels: CHANNELS,
      mode: "listing" as const,
      idempotencyKey: `retry-${w.id}`,
      uploads: [{ key: srcKey(w.id, "photo-1"), sha256: SHA, kind: "image" as const }],
    };

    const first = await service(w.user).createJob(w.id, input);
    const second = await service(w.user).createJob(w.id, input);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    if (first.outcome === "created" && second.outcome === "replayed") {
      expect(second.job.id).toBe(first.job.id);
    }
    const rows = await countRows(w.id);
    expect(rows.media).toBe(1);
    expect(rows.jobs).toBe(1);
    expect(rows.products).toBe(2);
    expect(enqueued).toHaveLength(1);
  });

  it("two submits racing with one Idempotency-Key make one job, one product and one hold", async () => {
    const w = await makeWorkspace(500);
    const input = {
      productId: "new",
      channels: CHANNELS,
      mode: "listing" as const,
      idempotencyKey: `race-${w.id}`,
      uploads: [{ key: srcKey(w.id, "photo-1"), sha256: SHA, kind: "image" as const }],
    };

    const results = await Promise.all([service(w.user).createJob(w.id, input), service(w.user).createJob(w.id, input)]);

    const ids = results.map((r) => (r.outcome === "created" || r.outcome === "replayed" ? r.job.id : null));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    expect(await countRows(w.id)).toEqual({ products: 2, media: 1, jobs: 1 });
    const holds = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, w.id));
    expect(holds.filter((r) => r.reason === "reserve")).toHaveLength(1);
  });

  it("replays the winner when the key is taken between the check and the insert", async () => {
    const w = await makeWorkspace(500);
    const key = `late-${w.id}`;
    // The winning request committed its job right after this one checked.
    const [winner] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: w.productId, status: "queued", idempotencyKey: key, channels: CHANNELS, mode: "listing" })
      .returning();
    const before = await countRows(w.id);
    const svc = service(w.user);
    const spy = vi.spyOn(svc as unknown as { replayFor: () => Promise<unknown> }, "replayFor").mockResolvedValueOnce(null);

    const result = await svc.createJob(w.id, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: key,
      uploads: [{ key: srcKey(w.id, "late"), sha256: SHA, kind: "image" }],
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("replayed");
    if (result.outcome === "replayed") {
      expect(result.job.id).toBe(winner.id);
    }
    // The losing transaction rolled back its product and photo.
    expect(await countRows(w.id)).toEqual(before);
    expect(enqueued).toHaveLength(0);
  });

  it("the same upload in a second pack for the product is stored once and still used", async () => {
    const w = await makeWorkspace(500);
    const key = srcKey(w.id, "photo-1");
    const upload = [{ key, sha256: SHA, kind: "image" as const }];

    const first = await service(w.user).createJob(w.id, {
      productId: w.productId,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `twice-a-${w.id}`,
      uploads: upload,
    });
    const second = await service(w.user).createJob(w.id, {
      productId: w.productId,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `twice-b-${w.id}`,
      uploads: upload,
    });

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    const media = await db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, w.id));
    expect(media).toHaveLength(1);
    expect(enqueued[1].images.map((i) => i.mediaId)).toEqual([key]);
  });

  it("an existing product reuses its stored photos when no new one is sent", async () => {
    const w = await makeWorkspace(500);
    const key = srcKey(w.id, "stored");
    await db.insert(sourceMedia).values({ workspaceId: w.id, productId: w.productId, r2Key: key, kind: "image", sha256: SHA });

    const result = await service(w.user).createJob(w.id, {
      productId: w.productId,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `stored-${w.id}`,
    });

    expect(result.outcome).toBe("created");
    expect(enqueued[0].images.map((i) => i.mediaId)).toEqual([key]);
  });

  it("ignores uploads outside the workspace source prefix and writes nothing", async () => {
    const w = await makeWorkspace(500);
    const other = await makeWorkspace(0);
    const before = await countRows(w.id);

    const result = await service(w.user).createJob(w.id, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `foreign-${w.id}`,
      uploads: [{ key: srcKey(other.id, "theirs"), sha256: SHA, kind: "image" }],
    });

    expect(result.outcome).toBe("rejected");
    expect(await countRows(w.id)).toEqual(before);
    expect(await countRows(other.id)).toEqual({ products: 1, media: 0, jobs: 0 });
  });

  it("refuses Concept Mode while it is not offered", async () => {
    const w = await makeWorkspace(500);
    const before = await countRows(w.id);

    const result = await service(w.user).createJob(w.id, {
      productId: "new",
      channels: ["meta.feed_1x1"],
      mode: "concept",
      idempotencyKey: `concept-${w.id}`,
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("mode_unavailable");
    }
    expect(await countRows(w.id)).toEqual(before);
  });

  it("treats a product id that is not a uuid as unknown", async () => {
    const w = await makeWorkspace(500);
    const result = await service(w.user).createJob(w.id, {
      productId: "abc",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `bad-product-${w.id}`,
      uploads: [{ key: srcKey(w.id, "photo"), sha256: SHA, kind: "image" }],
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("unknown_product");
    }
  });

  it("refuses client seats before writing anything", async () => {
    const w = await makeWorkspace(500, "client");
    const before = await countRows(w.id);
    const result = await service(w.user).createJob(w.id, {
      productId: "new",
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `client-${w.id}`,
      uploads: [{ key: srcKey(w.id, "photo"), sha256: SHA, kind: "image" }],
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("role_forbidden");
    }
    expect(await countRows(w.id)).toEqual(before);
  });
});

describe("DbService.getJob shot cards", () => {
  async function doneJob(w: { id: string; productId: string }, status: JobStatus = "done", error?: string) {
    const [job] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: w.productId, status, error: error ?? null })
      .returning();
    return job.id;
  }

  it("keys compliance badges by shot id, so two lifestyle shots keep their own verdicts (Update.md 3.6)", async () => {
    const w = await makeWorkspace(0);
    const jobId = await doneJob(w);
    await db.insert(assets).values([
      {
        workspaceId: w.id,
        jobId,
        shotType: "lifestyle",
        approved: true,
        qc: { shotId: "s01_lifestyle", specId: "amazon.secondary", pass: true, fillPct: 72, background: null, credits: 1 },
      },
      {
        workspaceId: w.id,
        jobId,
        shotType: "lifestyle",
        approved: false,
        qc: {
          shotId: "s02_lifestyle",
          specId: "amazon.secondary",
          pass: false,
          repairHint: "Fix failed checks: fill",
          credits: 1,
        },
      },
    ]);
    await db.insert(jobSteps).values([
      { workspaceId: w.id, jobId, shotId: "s01_lifestyle", stage: "lifestyle", provider: "worker", status: "done" },
      { workspaceId: w.id, jobId, shotId: "s02_lifestyle", stage: "lifestyle", provider: "worker", status: "needs_review" },
    ]);

    const job = await service(w.user).getJob(w.id, jobId);

    const first = job?.shots.find((s) => s.shotId === "s01_lifestyle");
    const second = job?.shots.find((s) => s.shotId === "s02_lifestyle");
    expect(first?.status).toBe("done");
    expect(first?.compliance).toEqual({ pass: true, fillPct: 72, background: null });
    expect(first?.credits).toBe(1);
    expect(second?.status).toBe("needs_review");
    expect(second?.compliance).toBeNull();
    expect(second?.note).toContain("No credits were charged");
    expect(second?.note).not.toContain("Fix failed checks");
  });

  it("shows legacy failed shot rows as needs review, never as failed (Update.md 3.5)", async () => {
    const w = await makeWorkspace(0);
    const jobId = await doneJob(w);
    await db.insert(jobSteps).values({
      workspaceId: w.id,
      jobId,
      shotId: "s01_in_the_box",
      stage: "in_the_box",
      provider: "worker",
      status: "failed",
    });

    const job = await service(w.user).getJob(w.id, jobId);

    expect(job?.shots[0].status).toBe("needs_review");
  });

  it("lists every planned shot from the plan and the skipped ones last with their reason", async () => {
    const w = await makeWorkspace(0);
    const jobId = await doneJob(w, "generating");
    await db.update(generationJobs).set({ updatedAt: new Date() }).where(eq(generationJobs.id, jobId));
    const planAt = new Date(Date.now() - 5000);
    await db.insert(jobSteps).values([
      { workspaceId: w.id, jobId, shotId: "s02_lifestyle", stage: "lifestyle", provider: "image model", status: "pending", createdAt: planAt },
      { workspaceId: w.id, jobId, shotId: "s01_amazon_main", stage: "amazon_main", provider: "pixel pipeline", status: "pending", createdAt: planAt },
      {
        workspaceId: w.id,
        jobId,
        shotId: "skipped_01_alt_angle_white:side",
        stage: "alt_angle_white:side",
        provider: "planner",
        status: "skipped",
        error: "needs photo",
        createdAt: planAt,
      },
      { workspaceId: w.id, jobId, shotId: "s01_amazon_main", stage: "amazon_main", provider: "worker", status: "done" },
    ]);

    const job = await service(w.user).getJob(w.id, jobId);

    expect(job?.shots.map((s) => s.shotId)).toEqual(["s01_amazon_main", "s02_lifestyle", "skipped_01_alt_angle_white:side"]);
    expect(job?.shots[0].status).toBe("done");
    expect(job?.shots[0].providerStage).toBe("pixel pipeline");
    expect(job?.shots[1].status).toBe("pending");
    expect(job?.shots[1].providerStage).toBe("image model");
    expect(job?.shots[2].status).toBe("skipped");
    expect(job?.shots[2].label).toBe("Needs photo");
  });

  it("replaces a raw provider error with plain copy", async () => {
    const w = await makeWorkspace(0);
    const jobId = await doneJob(w, "failed", "All providers failed for task image.generate: bfl: 500 upstream timeout");

    const job = await service(w.user).getJob(w.id, jobId);

    expect(job?.error).toBeTruthy();
    expect(job?.error).not.toMatch(/providers|bfl|upstream/i);
  });
});

describe("DbService.listJobFiles and downloads", () => {
  const R2_ENV = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

  afterEach(() => {
    for (const name of Object.keys(R2_ENV)) {
      delete process.env[name];
    }
  });

  async function deliveredJob(w: { id: string; productId: string }) {
    const [job] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: w.productId, status: "done" })
      .returning();
    const [asset] = await db
      .insert(assets)
      .values({ workspaceId: w.id, jobId: job.id, shotType: "amazon_main", approved: true, qc: { shotId: "s01_amazon_main" } })
      .returning();
    const [variant] = await db
      .insert(assetVariants)
      .values({
        workspaceId: w.id,
        assetId: asset.id,
        channelSpecId: "amazon.main",
        r2Key: `ws/${w.id}/jobs/${job.id}/files/amazon/MUG1.MAIN.jpg`,
        filename: "MUG1.MAIN.jpg",
        bytes: 1234,
      })
      .returning();
    const [report] = await db
      .insert(packFiles)
      .values({
        workspaceId: w.id,
        jobId: job.id,
        kind: "report",
        channel: null,
        filename: "compliance-report.json",
        r2Key: `ws/${w.id}/jobs/${job.id}/pack/compliance-report.json`,
      })
      .returning();
    return { jobId: job.id, variantId: variant.id, reportId: report.id };
  }

  it("says plainly when no shot passed, instead of asking the customer to configure storage", async () => {
    const w = await makeWorkspace(0);
    const [job] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: w.productId, status: "done" })
      .returning();
    await db.insert(packFiles).values({
      workspaceId: w.id,
      jobId: job.id,
      kind: "report",
      filename: "compliance-report.json",
      r2Key: `ws/${w.id}/jobs/${job.id}/pack/compliance-report.json`,
    });

    const view = await service(w.user).listJobFiles(w.id, job.id);

    expect(view?.notice).toContain("nothing was charged");
    expect(view?.notice).not.toMatch(/R2|configure/i);
  });

  it("gives every file a stable id and a same origin download link", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace(0);
    const { jobId, variantId, reportId } = await deliveredJob(w);

    const view = await service(w.user).listJobFiles(w.id, jobId);

    const image = view?.files.find((f) => f.kind === "image");
    const report = view?.files.find((f) => f.kind === "report");
    expect(image?.id).toBe(`v_${variantId}`);
    expect(image?.downloadUrl).toBe(`/api/jobs/${jobId}/files/v_${variantId}`);
    expect(image?.url).toContain("X-Amz-Signature");
    expect(report?.downloadUrl).toBe(`/api/jobs/${jobId}/files/p_${reportId}`);
    expect(report?.url).toBeNull();
  });

  it("signs a fresh, named download url for a file of the job", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace(0);
    const { jobId, variantId } = await deliveredJob(w);

    const download = await service(w.user).getJobFileDownload(w.id, jobId, `v_${variantId}`);

    expect(download?.filename).toBe("MUG1.MAIN.jpg");
    expect(decodeURIComponent(download?.url ?? "")).toContain('filename="MUG1.MAIN.jpg"');
  });

  it("refuses files of another job, another workspace or a malformed id", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace(0);
    const other = await makeWorkspace(0);
    const mine = await deliveredJob(w);
    const theirs = await deliveredJob(other);
    const second = await deliveredJob(w);

    expect(await service(w.user).getJobFileDownload(w.id, mine.jobId, `v_${theirs.variantId}`)).toBeNull();
    expect(await service(w.user).getJobFileDownload(w.id, mine.jobId, `v_${second.variantId}`)).toBeNull();
    expect(await service(w.user).getJobFileDownload(w.id, theirs.jobId, `v_${theirs.variantId}`)).toBeNull();
    expect(await service(w.user).getJobFileDownload(w.id, mine.jobId, "v_nope")).toBeNull();
    expect(await service(w.user).getJobFileDownload(w.id, mine.jobId, `x_${mine.variantId}`)).toBeNull();
  });

  it("offers no download links when storage is not configured", async () => {
    const w = await makeWorkspace(0);
    const { jobId, variantId } = await deliveredJob(w);
    const view = await service(w.user).listJobFiles(w.id, jobId);
    expect(view?.files.every((f) => f.downloadUrl === null)).toBe(true);
    expect(await service(w.user).getJobFileDownload(w.id, jobId, `v_${variantId}`)).toBeNull();
  });
});

describe("DbService.registerSourceMedia typed reasons (Update.md 6.8)", () => {
  it("maps each refusal to a reason and treats a repeat as saved", async () => {
    const w = await makeWorkspace(0);
    const [second] = await db.insert(products).values({ workspaceId: w.id, title: "Tray", mode: "listing" }).returning();
    const base = { productId: w.productId, kind: "image" as const, bytes: 10, sha256: SHA };
    const svc = service(w.user);

    expect((await svc.registerSourceMedia(w.id, { ...base, r2Key: `ws/${w.id}/jobs/x` })).reason).toBe("foreign_key");
    expect((await svc.registerSourceMedia(w.id, { ...base, productId: "abc", r2Key: srcKey(w.id, "p") })).reason).toBe(
      "unknown_product",
    );

    const key = srcKey(w.id, "once");
    expect((await svc.registerSourceMedia(w.id, { ...base, r2Key: key })).ok).toBe(true);
    expect((await svc.registerSourceMedia(w.id, { ...base, r2Key: key })).ok).toBe(true);
    const clash = await svc.registerSourceMedia(w.id, { ...base, productId: second.id, r2Key: key });
    expect(clash.ok).toBe(false);
    expect(clash.reason).toBe("conflict");
    const rows = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
    expect(rows).toHaveLength(1);
  });

  it("refuses client seats as forbidden", async () => {
    const w = await makeWorkspace(0, "client");
    const result = await service(w.user).registerSourceMedia(w.id, {
      productId: w.productId,
      r2Key: srcKey(w.id, "c"),
      kind: "image",
      bytes: 10,
      sha256: SHA,
    });
    expect(result.reason).toBe("forbidden");
  });
});

describe("workspace provisioning failures (Update.md 6.8)", () => {
  it("throws a ProvisioningError instead of reading as signed out", async () => {
    // A signed in user with no workspace yet, and a provisioning function
    // that cannot run: the caller must see a server error, not "Sign in".
    await client.exec("alter function provision_workspace(uuid, text, numeric) rename to provision_workspace_off");
    try {
      await expect(service("00000000-0000-4000-8000-0000000fffff").getCurrentWorkspace()).rejects.toBeInstanceOf(
        ProvisioningError,
      );
    } finally {
      await client.exec("alter function provision_workspace_off(uuid, text, numeric) rename to provision_workspace");
    }
  });
});

describe("signup grant settled on the first read (migration 0012 follow up)", () => {
  const FREE_CREDITS = tierByKey("free").creditsOnce;

  /** A user the auth trigger bootstrapped: workspace and owner membership,
   * with the grant attempted through bootstrap_workspace, which passes no
   * fallback amount. */
  async function bootstrappedUser(): Promise<{ user: string; ws: string }> {
    userCounter += 1;
    const user = `00000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
    const result = await client.query<{ bootstrap_workspace: string }>("select bootstrap_workspace($1, $2)", [
      user,
      `seller${userCounter}@example.com`,
    ]);
    return { user, ws: result.rows[0].bootstrap_workspace };
  }

  async function grantRows(workspaceId: string) {
    return db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.workspaceId, workspaceId), eq(creditLedger.reason, "grant")));
  }

  beforeEach(async () => {
    // pnpm db:seed has not run: no free_signup_credits setting.
    await db.delete(platformSettings);
  });

  it("pays the seed grant to a user bootstrapped before pnpm db:seed, exactly once", async () => {
    const { user, ws: own } = await bootstrappedUser();
    // The trigger path could not pay: nothing settled, nothing granted.
    expect(await db.select().from(signupGrants).where(eq(signupGrants.userId, user))).toHaveLength(0);
    expect(await balanceOf(own)).toBe(0);

    const first = await service(user).getCurrentWorkspace();
    expect(first?.id).toBe(own);
    expect(first?.creditBalance).toBe(FREE_CREDITS);
    const [grant] = await db.select().from(signupGrants).where(eq(signupGrants.userId, user));
    expect(grant).toMatchObject({ workspaceId: own, credits: FREE_CREDITS, withheldReason: null });

    const again = await service(user).getCurrentWorkspace();
    expect(again?.creditBalance).toBe(FREE_CREDITS);
    const grants = await grantRows(own);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ source: "signup", delta: FREE_CREDITS });
  });

  it("pays the seeded platform setting once it exists, not the app's fallback", async () => {
    await db.insert(platformSettings).values({ key: "free_signup_credits", value: 12 });
    const { user, ws: own } = await bootstrappedUser();
    // With the setting seeded the trigger path pays; the read adds nothing.
    const summary = await service(user).getCurrentWorkspace();
    expect(summary?.creditBalance).toBe(12);
    expect(await grantRows(own)).toHaveLength(1);
  });

  it("retries a grant that failed on the next read, and never fails the page for it", async () => {
    const { user, ws: own } = await bootstrappedUser();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await client.exec("alter function grant_signup_credits(uuid, numeric) rename to grant_signup_credits_off");
    try {
      const summary = await service(user).getCurrentWorkspace();
      expect(summary?.id).toBe(own);
      expect(summary?.creditBalance).toBe(0);
      expect(String(errors.mock.calls[0]?.[0])).toContain("could not settle the signup grant");
    } finally {
      await client.exec("alter function grant_signup_credits_off(uuid, numeric) rename to grant_signup_credits");
      errors.mockRestore();
    }
    const retried = await service(user).getCurrentWorkspace();
    expect(retried?.creditBalance).toBe(FREE_CREDITS);
    expect(await grantRows(own)).toHaveLength(1);
  });

  it("leaves a settled grant alone, including one withheld for a reused inbox", async () => {
    const { user, ws: own } = await bootstrappedUser();
    await db
      .insert(signupGrants)
      .values({ userId: user, workspaceId: own, credits: 0, withheldReason: "email_already_granted" });
    const summary = await service(user).getCurrentWorkspace();
    expect(summary?.creditBalance).toBe(0);
    expect(await grantRows(own)).toHaveLength(0);
  });

  it("pays nothing to a member who owns no workspace", async () => {
    // An invited editor: the grant only ever lands in the user's own workspace.
    const owner = await makeWorkspace(0);
    userCounter += 1;
    const editor = `00000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
    await db.insert(members).values({ workspaceId: owner.id, userId: editor, role: "editor" });
    const summary = await service(editor).getCurrentWorkspace();
    expect(summary?.id).toBe(owner.id);
    expect(summary?.creditBalance).toBe(0);
    expect(await db.select().from(signupGrants).where(eq(signupGrants.userId, editor))).toHaveLength(0);
  });
});

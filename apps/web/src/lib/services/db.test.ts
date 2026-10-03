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
  spendCapCounters,
  workspaces,
  type JobStatus,
  type MemberRole,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, loadChannelSpecs, type Db } from "@curvi/db";
import { costCaps, tierByKey } from "@curvi/pipeline/seed";

const enqueued = vi.hoisted(() => [] as Array<{ jobId: string; images: Array<{ mediaId: string }> }>);
vi.mock("@/lib/jobs/enqueue", () => ({
  enqueueGeneratePack: vi.fn(async (payload: { jobId: string; images: Array<{ mediaId: string }> }) => {
    enqueued.push(payload);
    return "inline";
  }),
}));

// Stored objects the compliance report reads; every other r2 helper is real.
const storedObjects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("@/lib/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/r2")>();
  return { ...actual,
    getObjectBytes: vi.fn(async (key: string) => storedObjects.get(key) ?? null),
    getObjectBytesBounded: vi.fn(async (key: string) => storedObjects.get(key) ?? null),
  };
});

import { publicJobError } from "@/lib/job-copy";
import { DbService, ProvisioningError } from "./db";
import { storePackPhotos } from "@/lib/api-v1/photos";
import { jobRequestFingerprint } from "./job-request";
import type { CreateJobInput } from "./types";

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

describe("DbService accepted request receipts", () => {
  it("refuses semantic changes under the same key and replays after mutable product edits", async () => {
    const w = await makeWorkspace(500);
    const input: CreateJobInput = {
      productId: "new", channels: ["amazon.main"], mode: "listing", idempotencyKey: `receipt-${w.id}`,
      newProductTitle: "Mug", userDescription: "Blue ceramic mug", sku: "MUG",
      boxContents: ["Mug"], comparisonFacts: ["300 ml"], endorsements: ["Best mug"],
      uploads: [
        { key: srcKey(w.id, "front"), sha256: SHA, kind: "image", angle: "front" },
        { key: srcKey(w.id, "back"), sha256: "b".repeat(64), kind: "image", angle: "back" },
      ],
    };
    const svc = service(w.user);
    const first = await svc.createJob(w.id, input);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    const changes: Array<Partial<CreateJobInput>> = [
      { newProductTitle: "Cup" }, { sku: "CUP" }, { boxContents: ["Mug", "Lid"] },
      { comparisonFacts: ["500 ml"] }, { endorsements: ["Top pick"] }, { answers: { mood: "gym" } },
      { sellerAnswers: { key: input.uploads![0].key, picks: { target: "item:2" } } },
      { uploads: [{ ...input.uploads![0], angle: "back" }, input.uploads![1]] },
      { uploads: [{ ...input.uploads![0], targetBox: { x: 0, y: 0, width: 0.5, height: 1 } }, input.uploads![1]] },
      { uploads: input.uploads!.slice(0, 1) }, { uploads: [] }, { uploads: [...input.uploads!].reverse() },
    ];
    for (const change of changes) {
      expect(await svc.createJob(w.id, { ...input, ...change }), JSON.stringify(change)).toEqual({ outcome: "conflict", existingJobId: first.job.id });
    }
    await db.update(products).set({ title: "Renamed later", sku: "LATER", boxContents: ["Other details"] }).where(eq(products.id, first.job.productId));
    expect(await svc.createJob(w.id, input)).toMatchObject({ outcome: "replayed", job: { id: first.job.id } });
    expect(first.job).not.toHaveProperty("requestFingerprint");
    expect((await countRows(w.id)).jobs).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it("returns an existing-pack conflict for a legacy row without inventing missing request data", async () => {
    const w = await makeWorkspace(500);
    const input: CreateJobInput = { productId: "new", channels: ["amazon.main"], mode: "listing", idempotencyKey: `legacy-${w.id}`,
      uploads: [{ key: srcKey(w.id, "legacy"), sha256: SHA, kind: "image" }] };
    const svc = service(w.user);
    const first = await svc.createJob(w.id, input);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    await db.update(generationJobs).set({ requestFingerprint: null }).where(eq(generationJobs.id, first.job.id));
    const before = await balanceOf(w.id);
    expect(await svc.createJob(w.id, input)).toEqual({ outcome: "conflict", existingJobId: first.job.id });
    expect(await balanceOf(w.id)).toBe(before);
    expect((await countRows(w.id)).jobs).toBe(1);
  });

  it("keeps the same API photo on two new products and replays retries with fresh upload keys", async () => {
    const w = await makeWorkspace(500);
    const svc = service(w.user);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", "base64");
    const upload = async () => {
      const photos = await storePackPhotos(w.id, [{ data: bytes.toString("base64") }], { store: false });
      if (!photos.ok) throw new Error(photos.message);
      return photos.uploads;
    };
    const base = { productId: "new", channels: ["amazon.main"], mode: "listing" as const, origin: "api" as const };
    const firstInput = { ...base, idempotencyKey: `photo-a-${w.id}`, uploads: await upload() };
    const secondInput = { ...base, idempotencyKey: `photo-b-${w.id}`, uploads: await upload() };
    const first = await svc.createJob(w.id, firstInput);
    const second = await svc.createJob(w.id, secondInput);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    if (first.outcome !== "created" || second.outcome !== "created") return;
    expect(firstInput.uploads[0].key).not.toBe(secondInput.uploads[0].key);
    const media = await db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, w.id));
    expect(new Set(media.map((row) => row.productId))).toEqual(new Set([first.job.productId, second.job.productId]));
    expect(await svc.createJob(w.id, { ...firstInput, uploads: await upload() })).toMatchObject({ outcome: "replayed", job: { id: first.job.id } });
    for (const productId of [first.job.productId, second.job.productId]) {
      expect(await svc.createJob(w.id, { ...base, productId, idempotencyKey: `reuse-${productId}` })).toMatchObject({ outcome: "created" });
    }
    expect((await countRows(w.id)).jobs).toBe(4);
  });

  it("returns the previous window's legacy pack without another hold or enqueue", async () => {
    const w = await makeWorkspace(500);
    const input: CreateJobInput = {
      productId: "new", channels: ["amazon.main"], mode: "listing", origin: "api", audience: "assistant",
      idempotencyKey: `previous-${w.id}`,
      uploads: [{ key: srcKey(w.id, "previous-attempt"), sha256: SHA, kind: "image" }],
    };
    const svc = service(w.user);
    const first = await svc.createJob(w.id, input);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") throw new Error("fixture pack was not created");
    await db.update(generationJobs).set({ requestFingerprint: null }).where(eq(generationJobs.id, first.job.id));
    const before = await balanceOf(w.id);
    const lifecycle = { retainUploads: false };
    const retry = await svc.createJob(w.id, {
      ...input, idempotencyKey: `current-${w.id}`, previousIdempotencyKeys: [input.idempotencyKey],
      uploads: [{ ...input.uploads![0], key: srcKey(w.id, "current-attempt") }],
    }, lifecycle);
    expect(retry).toEqual({ outcome: "conflict", existingJobId: first.job.id });
    expect(lifecycle.retainUploads).toBe(false);
    expect(await balanceOf(w.id)).toBe(before);
    expect(await countRows(w.id)).toEqual({ products: 2, media: 1, jobs: 1 });
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, w.id));
    expect(ledger.filter(row => row.reason === "reserve")).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it("replays a matching previous receipt and skips a proven different request", async () => {
    const w = await makeWorkspace(500);
    const input: CreateJobInput = {
      productId: "new", channels: ["amazon.main"], mode: "listing", origin: "api",
      idempotencyKey: `previous-${w.id}`, newProductTitle: "Mug",
      uploads: [{ key: srcKey(w.id, "first-attempt"), sha256: SHA, kind: "image" }],
    };
    const svc = service(w.user);
    const first = await svc.createJob(w.id, input);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") throw new Error("fixture pack was not created");
    const next = {
      ...input, idempotencyKey: `current-${w.id}`, previousIdempotencyKeys: [input.idempotencyKey],
      uploads: [{ ...input.uploads![0], key: srcKey(w.id, "next-attempt") }],
    };
    const before = await balanceOf(w.id);
    expect(await svc.createJob(w.id, next)).toMatchObject({ outcome: "replayed", job: { id: first.job.id } });
    expect(await balanceOf(w.id)).toBe(before);
    expect(await svc.createJob(w.id, { ...next, newProductTitle: "Different request" })).toMatchObject({ outcome: "created" });
    expect((await countRows(w.id)).jobs).toBe(2);
    expect(enqueued).toHaveLength(2);
  });

  it("fails closed if storage returns a malformed previous receipt", async () => {
    const w = await makeWorkspace(500);
    const input: CreateJobInput = {
      productId: "new", channels: ["amazon.main"], mode: "listing", origin: "api",
      idempotencyKey: `previous-${w.id}`,
      uploads: [{ key: srcKey(w.id, "malformed-receipt"), sha256: SHA, kind: "image" }],
    };
    const svc = service(w.user);
    const first = await svc.createJob(w.id, input);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") throw new Error("fixture pack was not created");
    const [stored] = await db.select().from(generationJobs).where(eq(generationJobs.id, first.job.id));
    const before = await balanceOf(w.id);
    // The current schema prevents malformed writes. Simulate an unexpected
    // legacy storage value at the read boundary without weakening that check.
    const read = vi.spyOn(db.query.generationJobs, "findFirst").mockResolvedValueOnce({ ...stored, requestFingerprint: "invalid" });
    try {
      expect(await svc.createJob(w.id, {
        ...input, idempotencyKey: `current-${w.id}`, previousIdempotencyKeys: [input.idempotencyKey],
      })).toEqual({ outcome: "conflict", existingJobId: first.job.id });
    } finally {
      read.mockRestore();
    }
    expect(await balanceOf(w.id)).toBe(before);
    expect((await countRows(w.id)).jobs).toBe(1);
    expect(enqueued).toHaveLength(1);
  });
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
    const [saved] = await db.select().from(generationJobs).where(eq(generationJobs.id, result.job.id));
    expect(saved.restartPayload).toMatchObject({ jobId: result.job.id, workspaceId: w.id, creditBudget: result.job.creditsReserved });
    expect(saved.restartPayload).not.toHaveProperty("runKey");
    expect(saved.runnerId).toBeTruthy();
    expect(saved.heartbeatAt).toBeInstanceOf(Date);
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

  it("a reused Idempotency-Key with other photos or another note is a conflict, not a replay", async () => {
    const w = await makeWorkspace(500);
    const input = {
      productId: "new",
      channels: CHANNELS,
      mode: "listing" as const,
      idempotencyKey: `reuse-${w.id}`,
      userDescription: "Blue bottle",
      uploads: [{ key: srcKey(w.id, "first"), sha256: SHA, kind: "image" as const }],
    };
    const first = await service(w.user).createJob(w.id, input);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;

    const otherPhoto = await service(w.user).createJob(w.id, {
      ...input,
      uploads: [{ key: srcKey(w.id, "second"), sha256: SHA, kind: "image" as const }],
    });
    expect(otherPhoto).toEqual({ outcome: "conflict", existingJobId: first.job.id });
    const otherNote = await service(w.user).createJob(w.id, { ...input, userDescription: "Red bottle" });
    expect(otherNote).toEqual({ outcome: "conflict", existingJobId: first.job.id });
    expect(await service(w.user).createJob(w.id, input)).toMatchObject({ outcome: "replayed", job: { id: first.job.id } });
    expect((await countRows(w.id)).jobs).toBe(1);
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
    // The winner saved the same photo on its product and persisted the
    // complete accepted request before this request reached the insert.
    await db
      .insert(sourceMedia)
      .values({ workspaceId: w.id, productId: w.productId, r2Key: srcKey(w.id, "late"), kind: "image", sha256: SHA });
    const before = await countRows(w.id);
    const input: CreateJobInput = {
      productId: "new", channels: CHANNELS, mode: "listing", idempotencyKey: key,
      uploads: [{ key: srcKey(w.id, "late"), sha256: SHA, kind: "image" }],
    };
    await db.update(generationJobs).set({ requestFingerprint: jobRequestFingerprint(input) }).where(eq(generationJobs.id, winner.id));
    const svc = service(w.user);
    const spy = vi.spyOn(svc as unknown as { replayFor: () => Promise<unknown> }, "replayFor").mockResolvedValueOnce(null);

    const result = await svc.createJob(w.id, input);

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

  it("an existing product runs only on the new photos when the pack sends some", async () => {
    const w = await makeWorkspace(500);
    const old = srcKey(w.id, "old");
    await db.insert(sourceMedia).values({ workspaceId: w.id, productId: w.productId, r2Key: old, kind: "image", sha256: SHA });
    const fresh = srcKey(w.id, "fresh");

    const result = await service(w.user).createJob(w.id, {
      productId: w.productId,
      channels: CHANNELS,
      mode: "listing",
      idempotencyKey: `fresh-${w.id}`,
      uploads: [{ key: fresh, sha256: SHA, kind: "image" }],
    });

    expect(result.outcome).toBe("created");
    expect(enqueued[0].images.map((i) => i.mediaId)).toEqual([fresh]);
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

  it("never serves the raw 401 chain to the pack page or the dashboard (A6)", async () => {
    // The stored error production showed raw on a pack card.
    const raw =
      'All providers failed for task llm.intake: anthropic-claude: anthropic-claude responded 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    const w = await makeWorkspace(0);
    const jobId = await doneJob(w, "failed", raw);

    const job = await service(w.user).getJob(w.id, jobId);
    const recent = await service(w.user).listRecentJobs(w.id, 8);

    expect(job?.error).toBe(publicJobError(raw));
    expect(job?.error).toContain("problem on our side, not with your photo");
    for (const surface of [JSON.stringify(job), JSON.stringify(recent)]) {
      expect(surface).not.toMatch(/anthropic|responded|401|authentication_error|x-api-key/i);
    }
  });
});

describe("DbService.listJobFiles and downloads", () => {
  const R2_ENV = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

  afterEach(() => {
    for (const name of Object.keys(R2_ENV)) {
      delete process.env[name];
    }
  });

  async function deliveredJob(w: { id: string; productId: string }, status: JobStatus = "done") {
    const [job] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: w.productId, status })
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

  // A run the time cap or a restart settled as failed writes no files and
  // charges nothing. Files are served once the pack is done, or once it
  // charged for what it delivered.
  it.each(["failed", "canceled", "queued", "generating", "qc"] as const)(
    "lists, previews and serves no files while the job is %s",
    async (status) => {
      Object.assign(process.env, R2_ENV);
      const w = await makeWorkspace(0);
      const { jobId, variantId, reportId } = await deliveredJob(w, status);
      await db.insert(jobSteps).values({
        workspaceId: w.id,
        jobId,
        shotId: "s01_amazon_main",
        stage: "amazon_main",
        provider: "worker",
        status: "done",
      });
      const svc = service(w.user);

      const view = await svc.listJobFiles(w.id, jobId);
      expect(view).toEqual({ jobId, status, files: [] });
      expect(await svc.getJobFileDownload(w.id, jobId, `v_${variantId}`)).toBeNull();
      expect(await svc.getJobFileDownload(w.id, jobId, `p_${reportId}`)).toBeNull();

      const job = await svc.getJob(w.id, jobId);
      const shot = job?.shots.find((s) => s.shotId === "s01_amazon_main");
      expect(shot).toBeDefined();
      expect(shot?.imageUrl ?? null).toBeNull();
      expect(shot?.downloadUrl ?? null).toBeNull();
    },
  );

  it("previews and links a delivered shot once the job is done", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace(0);
    const { jobId, variantId } = await deliveredJob(w);
    await db.insert(jobSteps).values({
      workspaceId: w.id,
      jobId,
      shotId: "s01_amazon_main",
      stage: "amazon_main",
      provider: "worker",
      status: "done",
    });

    const job = await service(w.user).getJob(w.id, jobId);

    const shot = job?.shots.find((s) => s.shotId === "s01_amazon_main");
    expect(shot?.channels).toEqual(["amazon.main"]);
    expect(shot?.imageUrl).toContain("X-Amz-Signature");
    expect(shot?.downloadUrl).toBe(`/api/jobs/${jobId}/files/v_${variantId}`);
  });

  it("reads the stored compliance report as the readable view, scoped to the workspace", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace(0);
    const other = await makeWorkspace(0);
    const { jobId } = await deliveredJob(w);
    storedObjects.set(
      `ws/${w.id}/jobs/${jobId}/pack/compliance-report.json`,
      Buffer.from(
        JSON.stringify({
          generatedAt: "2026-09-28T12:00:00.000Z",
          files: [
            {
              file: "MUG1.MAIN.jpg",
              channel: "amazon",
              specId: "amazon.main",
              checks: [{ name: "fillRatio", pass: true, measured: 0.87, limit: "0.85 to 0.9" }],
              pass: true,
            },
          ],
          dropped: [],
        }),
      ),
    );

    const view = await service(w.user).getComplianceReport(w.id, jobId);
    expect(view?.available).toBe(true);
    expect(view?.productTitle).toBe("Kettle");
    expect(view?.channels[0].files[0].checks[0]).toMatchObject({ label: "Product fill", measured: "87 percent" });

    // Another workspace never sees it, and a malformed id is no job.
    expect(await service(other.user).getComplianceReport(other.id, jobId)).toBeNull();
    expect(await service(w.user).getComplianceReport(w.id, "nope")).toBeNull();

    // A new pick with the same filename has its own post-packaging checks.
    await db.update(assetVariants).set({ picked: false }).where(eq(assetVariants.workspaceId, w.id));
    const key = `ws/${w.id}/jobs/${jobId}/files/variation-2/amazon/MUG1.MAIN.jpg`;
    const [version] = await db.insert(assets).values({ workspaceId: w.id, jobId, shotType: "lifestyle", approved: true, qc: {
      shotId: "scene.v2", fileReports: { [key]: { file: "MUG1.MAIN.jpg", channel: "amazon", specId: "amazon.main",
        checks: [{ name: "fillRatio", pass: false, measured: 0.45, limit: "0.85 to 0.9" }], pass: false } },
    } }).returning();
    await db.insert(assetVariants).values({ workspaceId: w.id, assetId: version.id, channelSpecId: "amazon.main", r2Key: key, filename: "MUG1.MAIN.jpg", picked: true });
    const changed = await service(w.user).getComplianceReport(w.id, jobId);
    expect(changed?.summary).toMatchObject({ files: 1, passed: 0, needsAttention: 1 });
    expect(changed?.channels[0].files[0].checks[0].measured).toBe("45 percent");

  });

  it("says why the compliance report is not available yet or not stored", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace(0);
    const running = await deliveredJob(w, "generating");
    const pending = await service(w.user).getComplianceReport(w.id, running.jobId);
    expect(pending).toMatchObject({ available: false, notice: expect.stringContaining("once the pack finishes") });

    const done = await deliveredJob(w);
    const missing = await service(w.user).getComplianceReport(w.id, done.jobId);
    expect(missing).toMatchObject({ available: false, notice: expect.stringContaining("not available") });
  });

  it("still serves files a failed pack already charged for", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace(0);
    const { jobId, variantId } = await deliveredJob(w, "failed");
    await db.update(generationJobs).set({ creditsCharged: 4 }).where(eq(generationJobs.id, jobId));
    const svc = service(w.user);

    const view = await svc.listJobFiles(w.id, jobId);
    expect(view?.files.some((f) => f.id === `v_${variantId}`)).toBe(true);
    const download = await svc.getJobFileDownload(w.id, jobId, `v_${variantId}`);
    expect(download?.filename).toBe("MUG1.MAIN.jpg");
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


describe("daily spend admission", () => {
  it("refuses a workspace at its day cap before creating a job or holding credits", async () => {
    const w = await makeWorkspace(100);
    await db.insert(spendCapCounters).values({ key: `caps:workspace:${w.id}:${new Date().toISOString().slice(0,10)}`, totalMicros: costCaps.workspaceExpectedDailyMicrosByTier.starter * costCaps.workspaceDailyMultiplier });
    const before = await countRows(w.id);
    const result = await service(w.user).createJob(w.id, { productId: "new", mode: "listing", channels: ["amazon.main"], idempotencyKey: crypto.randomUUID(), uploads: [{ key: srcKey(w.id, "day-cap"), sha256: SHA, kind: "image" }] });
    expect(result).toMatchObject({ outcome: "rejected", reason: "workspace_day_cap" });
    expect(await countRows(w.id)).toEqual(before);
    expect(await balanceOf(w.id)).toBe(100);
  });
  it("an operator zero stop wins over the seed and never takes a hold", async () => {
    const w = await makeWorkspace(100);
    await db.insert(platformSettings).values({ key: "ops:global_hard_stop_usd", value: 0 });
    try {
      expect(await service(w.user).createJob(w.id, { productId: "new", mode: "listing", channels: ["amazon.main"], idempotencyKey: crypto.randomUUID(), uploads: [{ key: srcKey(w.id, "stop"), sha256: SHA, kind: "image" }] })).toMatchObject({ outcome: "rejected", reason: "unavailable" });
      expect(await balanceOf(w.id)).toBe(100);
      expect((await countRows(w.id)).jobs).toBe(0);
    } finally { await db.delete(platformSettings).where(eq(platformSettings.key, "ops:global_hard_stop_usd")); }
  });
});

describe("workspace and member identity", () => {
  it("chooses the oldest owner membership and resolves member emails only within the caller workspace", async () => {
    const first = await makeWorkspace(50);
    const [oldMember, recentOwner] = await db.insert(workspaces).values([{ name: "Older member" }, { name: "Newer owner" }]).returning();
    await db.insert(members).values([{ workspaceId: oldMember.id, userId: first.user, role: "editor", createdAt: new Date(0) }, { workspaceId: recentOwner.id, userId: first.user, role: "owner", createdAt: new Date(Date.now()+1000) }]);
    expect((await service(first.user).getCurrentWorkspace())?.id).toBe(first.id);
    await client.exec("create table if not exists auth.users (id uuid primary key, email text)");
    await client.query("insert into auth.users(id,email) values($1,$2)", [first.user, "owner@example.test"]);
    expect(await service(first.user).listMembers(first.id)).toContainEqual({ id: first.user, label: "owner@example.test", role: "owner" });
    expect(await service(userId).listMembers(first.id)).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { creditLedger, generationJobs, members, products, signupGrants, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import type { IngestOutcome } from "@/lib/trust/ingest";

vi.mock("@/lib/jobs/enqueue", () => ({
  enqueueGeneratePack: vi.fn(async () => "inline"),
}));

import { DbService } from "./db";

// Server side upload ingest inside DbService (lib/trust/ingest.ts): every
// upload is checked before anything is written, and the stored hash and size
// are the server's.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 0;
const SERVER_SHA = "f".repeat(64);
const CLIENT_SHA = "0".repeat(64);

async function workspace(): Promise<{ id: string; user: string; product: string }> {
  counter += 1;
  const user = `00000000-0000-4000-8000-${String(500 + counter).padStart(12, "0")}`;
  const [w] = await db.insert(workspaces).values({ name: `Ingest ${counter}`, plan: "starter" }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: user, role: "owner" });
  await db.insert(signupGrants).values({ userId: user, workspaceId: w.id, credits: 0 });
  await db.insert(creditLedger).values({ workspaceId: w.id, delta: 100, reason: "grant", source: "system" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Kettle", mode: "listing" }).returning();
  return { id: w.id, user, product: p.id };
}

function service(user: string, outcome: IngestOutcome | null, seen: string[] = []): DbService {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => user,
    getSupabase: async () => null,
    ingestUpload: outcome
      ? async (key) => {
          seen.push(key);
          return outcome;
        }
      : null,
  });
}

const REFUSED: IngestOutcome = { ok: false, retryable: false, notice: "That file is not a photo we can use." };
const DOWN: IngestOutcome = { ok: false, retryable: true, notice: "We could not check that upload right now." };
const PASSED: IngestOutcome = { ok: true, sha256: SERVER_SHA, width: 600, height: 800, bytes: 1000, rewritten: true };

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("createJob upload ingest", () => {
  it("refuses a pack whose upload fails the check, writing nothing", async () => {
    const w = await workspace();
    const key = `ws/${w.id}/src/bad`;
    const seen: string[] = [];
    const result = await service(w.user, REFUSED, seen).createJob(w.id, {
      productId: "new",
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: `ingest-${counter}-a`,
      uploads: [{ key, sha256: CLIENT_SHA, kind: "image" }],
    });
    expect(result).toEqual({ outcome: "rejected", reason: "invalid_upload", message: REFUSED.notice });
    expect(seen).toEqual([key]);
    expect(await db.select().from(products).where(eq(products.workspaceId, w.id))).toHaveLength(1);
    expect(await db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, w.id))).toHaveLength(0);
    expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, w.id))).toHaveLength(0);
  });

  it("answers a check that could not run as retryable", async () => {
    const w = await workspace();
    const result = await service(w.user, DOWN).createJob(w.id, {
      productId: w.product,
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: `ingest-${counter}-b`,
      uploads: [{ key: `ws/${w.id}/src/x`, sha256: CLIENT_SHA, kind: "image" }],
    });
    expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
  });

  it("stores the server's hash and upright size, not the client's", async () => {
    const w = await workspace();
    const key = `ws/${w.id}/src/good`;
    const result = await service(w.user, PASSED).createJob(w.id, {
      productId: w.product,
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: `ingest-${counter}-c`,
      uploads: [{ key, sha256: CLIENT_SHA, kind: "image" }],
    });
    expect(result.outcome).toBe("created");
    const [row] = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
    expect(row).toMatchObject({ sha256: SERVER_SHA, width: 600, height: 800 });
  });
});

describe("registerSourceMedia upload ingest", () => {
  it("refuses with a typed reason and records nothing", async () => {
    const w = await workspace();
    const result = await service(w.user, REFUSED).registerSourceMedia(w.id, {
      productId: w.product,
      r2Key: `ws/${w.id}/src/bad`,
      kind: "image",
      bytes: 10,
      sha256: CLIENT_SHA,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_upload", notice: REFUSED.notice });
    expect(await db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, w.id))).toHaveLength(0);
  });

  it("records the server's hash and size", async () => {
    const w = await workspace();
    const key = `ws/${w.id}/src/ok`;
    const result = await service(w.user, PASSED).registerSourceMedia(w.id, {
      productId: w.product,
      r2Key: key,
      kind: "image",
      bytes: 10,
      sha256: CLIENT_SHA,
      width: 1,
      height: 1,
    });
    expect(result.ok).toBe(true);
    const [row] = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
    expect(row).toMatchObject({ sha256: SERVER_SHA, width: 600, height: 800 });
  });

  it("keeps the client's values when the check is skipped (no storage configured)", async () => {
    const w = await workspace();
    const key = `ws/${w.id}/src/skip`;
    await service(w.user, null).registerSourceMedia(w.id, {
      productId: w.product,
      r2Key: key,
      kind: "image",
      bytes: 10,
      sha256: CLIENT_SHA,
      width: 5,
      height: 7,
    });
    const [row] = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
    expect(row).toMatchObject({ sha256: CLIENT_SHA, width: 5, height: 7 });
  });
});

describe("saveBrandKit logo ingest", () => {
  it("refuses a new logo that fails the check", async () => {
    const w = await workspace();
    const result = await service(w.user, REFUSED).saveBrandKit(w.id, {
      name: "Kit",
      colors: ["#112233"],
      fonts: { heading: "", body: "" },
      stylePreset: "minimal_studio",
      hasLogo: true,
      logoKey: `ws/${w.id}/src/logo`,
    });
    expect(result).toEqual({ ok: false, notice: REFUSED.notice });
  });
});

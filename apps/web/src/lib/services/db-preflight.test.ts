/**
 * The preflight at upload in db mode (docs/phases/PHASE_14.md workstream 4
 * and item 3.2), against the real migrations in PGlite: the answer is cached
 * per upload key and note, its spend is booked on the workspace and never
 * charged in credits, a blocking answer keeps the photo from starting a
 * pack with nothing held, and the chooser's box is saved on source_media and
 * sent to the runner with the reusable intake answer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creditLedger, generationJobs, members, products, signupGrants, sourceMedia, uploadPreflights, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, type Db } from "@curvi/db";
import type { UploadPreflightArgs, UploadPreflightRun } from "@curvi/trigger/preflight";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import { DbService } from "./db";

const enqueue = vi.hoisted(() => ({
  fn: vi.fn<(payload: GeneratePackInput) => Promise<"inline">>(async () => "inline"),
}));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: enqueue.fn }));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000fa01";
const CLIENT = "00000000-0000-4000-8000-00000000fa02";
const flags = { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false };
const shoeBox = { x: 0.5, y: 0.5, width: 0.4, height: 0.3 };
let keyCounter = 0;

function runOf(overrides: Partial<UploadPreflightRun> = {}): UploadPreflightRun {
  return {
    missing: false,
    photo: { width: 3000, height: 4000 },
    intake: {
      image: { sellableProduct: true, distinctProducts: 2, sharpEnough: true, screenshot: false, flags },
      noteKey: "set by the test",
      recipe: { key: "intake_normalizer", version: 3 },
      at: new Date().toISOString(),
    },
    moderation: [],
    cutout: "done",
    items: [
      { number: 1, label: "silver watch", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 }, areaShare: 0.1, colorName: "gray", featured: false },
      { number: 2, label: "white sneakers", box: shoeBox, areaShare: 0.1, colorName: "white", featured: false },
    ],
    rule: "ambiguous",
    thumbnails: [Buffer.from("a"), Buffer.from("b")],
    preview: null,
    costMicros: 21_000,
    ...overrides,
  };
}

function service(userId: string, run: (args: UploadPreflightArgs) => Promise<UploadPreflightRun>, putObject = vi.fn(async () => undefined)) {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => userId,
    getSupabase: async () => null,
    ingestUpload: null,
    preflight: { run, putObject, sign: async (key) => `https://r2.example/${key}` },
  });
}

async function workspace(credits = 100): Promise<{ ws: string; productId: string }> {
  const [w] = await db.insert(workspaces).values({ name: "Preflight", plan: "starter" }).returning();
  await db.insert(members).values([
    { workspaceId: w.id, userId: OWNER, role: "owner" },
    { workspaceId: w.id, userId: CLIENT, role: "client" },
  ]);
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Watch", mode: "listing" }).returning();
  await db.insert(creditLedger).values({ workspaceId: w.id, delta: credits, reason: "grant", source: "system" });
  return { ws: w.id, productId: p.id };
}

async function balance(ws: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [ws]);
  return Number(result.rows[0].credit_balance);
}

function jobInput(productId: string, uploads: NonNullable<Parameters<DbService["createJob"]>[1]["uploads"]>, userDescription?: string) {
  keyCounter += 1;
  return {
    productId,
    channels: ["amazon.main"],
    mode: "listing" as const,
    idempotencyKey: `preflight-test-${keyCounter}`,
    uploads,
    ...(userDescription ? { userDescription } : {}),
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await db.insert(signupGrants).values([
    { userId: OWNER, credits: 0 },
    { userId: CLIENT, credits: 0 },
  ]);
});

beforeEach(() => {
  enqueue.fn.mockClear();
});

afterAll(async () => {
  await client.close();
});

describe("DbService.preflightUpload cutout preview", () => {
  it("stores the preview under the workspace cache and signs it, never keeping bytes in the row", async () => {
    const { ws } = await workspace();
    const key = `ws/${ws}/src/single.jpg`;
    const single = runOf({
      items: [{ number: 1, label: "silver watch", box: shoeBox, areaShare: 0.2, colorName: "gray", featured: true }],
      rule: "single_object",
      thumbnails: [],
      preview: Buffer.from("png"),
    });
    const putObject = vi.fn(async () => undefined);
    const svc = service(OWNER, async () => single, putObject);
    const first = await svc.preflightUpload(ws, { key });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.preflight.status).toBe("ready");
    expect(putObject).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^ws/${ws}/cache/preview/`)), single.preview, "image/png");
    expect(first.preflight.previewUrl).toMatch(new RegExp(`^https://r2\\.example/ws/${ws}/cache/preview/.+\\.png$`));
    const [row] = await db.select().from(uploadPreflights).where(eq(uploadPreflights.r2Key, key));
    expect(JSON.stringify(row.result)).not.toContain("https://");
    expect((row.result as { previewKey?: string }).previewKey).toMatch(/cache\/preview/);
    // The cached answer signs the same preview again.
    const again = await svc.preflightUpload(ws, { key });
    expect(again.ok && again.preflight.previewUrl).toBe(first.preflight.previewUrl);
  });

  it("keeps no preview for a photo that needs the chooser", async () => {
    const { ws } = await workspace();
    const putObject = vi.fn(async () => undefined);
    const svc = service(OWNER, async () => runOf({ preview: Buffer.from("png") }), putObject);
    const result = await svc.preflightUpload(ws, { key: `ws/${ws}/src/two.jpg` });
    expect(result.ok && result.preflight.status).toBe("choose");
    expect(result.ok && result.preflight.previewUrl).toBeUndefined();
  });
});

describe("DbService.preflightUpload", () => {
  it("checks a photo once per note, caches it and books the spend on the workspace", async () => {
    const { ws } = await workspace();
    const key = `ws/${ws}/src/cafe.jpg`;
    const run = vi.fn(async (args: UploadPreflightArgs) => runOf({ intake: { ...runOf().intake!, noteKey: args.note ?? "" } }));
    const putObject = vi.fn(async () => undefined);
    const svc = service(OWNER, run, putObject);
    const before = await balance(ws);

    const first = await svc.preflightUpload(ws, { key });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.preflight.status).toBe("choose");
    expect(first.preflight.items.map((i) => i.label)).toEqual(["silver watch", "white sneakers"]);
    // Thumbnails live under the workspace prefix and come back signed.
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(first.preflight.items[0].thumbUrl).toMatch(new RegExp(`^https://r2\\.example/ws/${ws}/preflight/`));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws, mediaKey: key }));

    // The same photo and note again: served from the row, no provider call.
    const again = await svc.preflightUpload(ws, { key });
    expect(again.ok && again.preflight.items).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(1);

    // A new note asks again; every run's spend stays booked.
    await svc.preflightUpload(ws, { key, note: "the sneakers" });
    expect(run).toHaveBeenCalledTimes(2);
    const [row] = await db
      .select()
      .from(uploadPreflights)
      .where(and(eq(uploadPreflights.workspaceId, ws), eq(uploadPreflights.r2Key, key)));
    expect(row.costMicros).toBe(42_000);
    expect(row.status).toBe("choose");
    // Never charged in credits.
    expect(await balance(ws)).toBe(before);
  });

  it("refuses a client seat and another workspace's key without calling anything", async () => {
    const { ws } = await workspace();
    const run = vi.fn(async () => runOf());
    expect(await service(CLIENT, run).preflightUpload(ws, { key: `ws/${ws}/src/a.jpg` })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    const { ws: other } = await workspace();
    expect(await service(OWNER, run).preflightUpload(ws, { key: `ws/${other}/src/a.jpg` })).toMatchObject({
      ok: false,
      reason: "foreign_key",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("answers unavailable, never a 500, when the check itself fails", async () => {
    const { ws } = await workspace();
    const outcome = await service(OWNER, async () => {
      throw new Error("worker runtime down");
    }).preflightUpload(ws, { key: `ws/${ws}/src/b.jpg` });
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("createJob with a preflight", () => {
  it("refuses a photo the preflight blocked, with the fix, and holds nothing", async () => {
    const { ws, productId } = await workspace();
    const key = `ws/${ws}/src/gun.jpg`;
    const svc = service(OWNER, async () => runOf({ moderation: ["weapons"], items: [], thumbnails: [] }));
    const checked = await svc.preflightUpload(ws, { key });
    expect(checked.ok && checked.preflight.status).toBe("blocked");
    const before = await balance(ws);

    const result = await svc.createJob(ws, jobInput(productId, [{ key, sha256: "a".repeat(64), kind: "image" }]));
    expect(result).toMatchObject({ outcome: "rejected", reason: "invalid_upload" });
    expect(result.outcome === "rejected" && result.message).toContain("weapons");
    expect(await balance(ws)).toBe(before);
    expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws))).toHaveLength(0);
    expect(enqueue.fn).not.toHaveBeenCalled();
  });

  it("saves the chooser's box on source_media and sends it with the reusable intake answer", async () => {
    const { ws, productId } = await workspace();
    const key = `ws/${ws}/src/cafe.jpg`;
    const svc = service(OWNER, async (args) => runOf({ intake: { ...runOf().intake!, noteKey: args.note ?? "" } }));
    await svc.preflightUpload(ws, { key });

    const result = await svc.createJob(
      ws,
      jobInput(productId, [{ key, sha256: "b".repeat(64), kind: "image", angle: "front", targetBox: shoeBox }]),
    );
    expect(result.outcome).toBe("created");
    const [media] = await db
      .select()
      .from(sourceMedia)
      .where(and(eq(sourceMedia.workspaceId, ws), eq(sourceMedia.r2Key, key)));
    expect(media.targetBox).toEqual(shoeBox);
    const payload = enqueue.fn.mock.calls[0][0];
    expect(payload.images[0]).toMatchObject({ mediaId: key, angle: "front", targetBox: shoeBox });
    expect(payload.images[0].preflight?.recipe).toEqual({ key: "intake_normalizer", version: 3 });
  });

  it("keeps the stored box of a product's saved photo for later packs", async () => {
    const { ws, productId } = await workspace();
    const key = `ws/${ws}/src/saved.jpg`;
    await db.insert(sourceMedia).values({ workspaceId: ws, productId, r2Key: key, kind: "image", sha256: "c".repeat(64), targetBox: shoeBox });
    const result = await service(OWNER, async () => runOf()).createJob(ws, jobInput(productId, []));
    expect(result.outcome).toBe("created");
    const payload = enqueue.fn.mock.calls[0][0];
    expect(payload.images[0]).toMatchObject({ mediaId: key, targetBox: shoeBox });
    expect(payload.images[0].preflight).toBeUndefined();
  });
});

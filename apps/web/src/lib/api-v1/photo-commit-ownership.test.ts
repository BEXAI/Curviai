import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { creditLedger, generationJobs, members, products, signupGrants, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DbService } from "@/lib/services/db";
import type { ImportedPhoto } from "@/lib/url-import/image";
import { createPack, type ApiContext } from "./actions";
import { mainImagePng } from "./test-fixtures";

const enqueued = vi.hoisted(() => [] as Array<{ jobId: string; images: Array<{ mediaId: string }> }>);
vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: vi.fn() }));
import { enqueueGeneratePack } from "@/lib/jobs/enqueue";

const PHOTO_URL = "https://shop.example/product.png";
const PHOTO_REQUEST = { channels: ["amazon.main"], photos: [{ url: PHOTO_URL }] };
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let photo: ImportedPhoto;

async function fixture() {
  const userId = randomUUID();
  const [workspace] = await db.insert(workspaces).values({ name: "Photo ownership", plan: "starter" }).returning();
  await db.insert(members).values({ workspaceId: workspace.id, userId, role: "owner" });
  await db.insert(signupGrants).values({ workspaceId: workspace.id, userId, credits: 0 });
  await db.insert(creditLedger).values({ workspaceId: workspace.id, delta: 500, reason: "grant", source: "system" });
  const [product] = await db.insert(products).values({ workspaceId: workspace.id, title: "Kettle", mode: "listing" }).returning();
  const objects = new Map<string, Buffer>();
  const services = new DbService({
    db: db as unknown as Db,
    getUserId: async () => userId,
    getSupabase: async () => null,
    ingestUpload: null,
    sourceObjectExists: async (key) => objects.has(key),
  });
  const put = vi.fn(async (_workspaceId: string, imported: ImportedPhoto, key: string) => {
    objects.set(key, Buffer.from(imported.body));
    return true;
  });
  const remove = vi.fn(async (keys: string[]) => {
    for (const key of keys) objects.delete(key);
    return [] as string[];
  });
  const ctx: ApiContext = {
    caller: {
      kind: "api_key",
      keyId: `test-${workspace.id}`,
      prefix: null,
      connectionId: null,
      ipExempt: false,
      scopes: ["packs:write", "packs:read", "checks"],
      principal: { workspaceId: workspace.id, workspaceName: workspace.name, plan: "starter", role: "owner", userId },
      services,
      rateSubject: `user:${userId}`,
    },
    headers: new Headers(),
    photos: { fetchPhoto: async () => ({ ok: true, photo }), put, remove },
  };
  const media = () => db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, workspace.id));
  const jobs = () => db.select().from(generationJobs).where(eq(generationJobs.workspaceId, workspace.id));
  return { workspace, product, objects, services, put, remove, ctx, media, jobs };
}

function pauseFirstEnqueue() {
  let entered!: () => void;
  let reject!: (error: Error) => void;
  const atEnqueue = new Promise<void>((resolve) => { entered = resolve; });
  const result = new Promise<never>((_resolve, refuse) => { reject = refuse; });
  vi.mocked(enqueueGeneratePack).mockImplementationOnce(async () => {
    entered();
    return result;
  });
  return { atEnqueue, reject };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  const body = await mainImagePng(300, 0.8);
  photo = { body, contentType: "image/png", sha256: createHash("sha256").update(body).digest("hex"), width: 300, height: 300 };
});

afterAll(async () => { await client.close(); });

beforeEach(() => {
  enqueued.length = 0;
  vi.mocked(enqueueGeneratePack).mockReset().mockImplementation(async (payload) => {
    enqueued.push(payload);
    return "inline";
  });
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("R2_ACCOUNT_ID", "test-account");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setRateLimitStoreForTests(null);
});

describe("API photo ownership at database commit", () => {
  it.each(["existing", "new"] as const)("retains an %s product's source after another pack accepts it and the first enqueue fails", async (productKind) => {
    const f = await fixture();
    const enqueue = pauseFirstEnqueue();
    const first = createPack(f.ctx, {
      ...PHOTO_REQUEST,
      ...(productKind === "existing" ? { productId: f.product.id } : { title: "New photographed product" }),
    }, "first-request");
    await enqueue.atEnqueue;
    const [committed] = await f.media();
    expect(committed).toBeDefined();
    if (productKind === "new") expect(committed.productId).not.toBe(f.product.id);

    // A's source is now durable and visible to a request that supplies no
    // photo. Its accepted worker payload must survive A's later failure.
    const second = await createPack(f.ctx, { productId: committed.productId, channels: ["amazon.main"] }, "second-request");
    expect(second.status).toBe(201);
    const accepted = enqueued.at(-1)!;
    expect(accepted.images.map((image) => image.mediaId)).toEqual([committed.r2Key]);
    expect(f.objects.get(committed.r2Key)).toEqual(photo.body);

    enqueue.reject(new Error("test queue unavailable after another pack accepted the source"));
    expect((await first).status).toBe(503);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.objects.get(committed.r2Key)).toEqual(photo.body);
    expect(await f.media()).toEqual([committed]);
    expect((await f.jobs()).find((job) => job.id === accepted.jobId)?.status).toBe("queued");
  });

  it("keeps failed enqueue sources valid through a retry and a later product-only request", async () => {
    const f = await fixture();
    const body = { ...PHOTO_REQUEST, productId: f.product.id };
    vi.mocked(enqueueGeneratePack).mockRejectedValueOnce(new Error("test queue unavailable"));
    expect((await createPack(f.ctx, body, "retry-request")).status).toBe(503);
    const [firstPhoto] = await f.media();
    expect(f.objects.get(firstPhoto.r2Key)).toEqual(photo.body);

    expect((await createPack(f.ctx, body, "retry-request")).status).toBe(201);
    expect((await createPack(f.ctx, { productId: f.product.id, channels: ["amazon.main"] }, "product-only-request")).status).toBe(201);
    const sources = await f.media();
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((source) => source.r2Key)).size).toBe(2);
    expect(enqueued.at(-1)!.images.map((image) => image.mediaId).sort()).toEqual(sources.map((source) => source.r2Key).sort());
    for (const source of sources) expect(f.objects.get(source.r2Key)).toEqual(photo.body);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("retains durable sources when a postcommit job read unexpectedly throws", async () => {
    const f = await fixture();
    vi.spyOn(f.services, "getJob").mockRejectedValueOnce(new Error("test job read unavailable"));
    await expect(createPack(f.ctx, { ...PHOTO_REQUEST, productId: f.product.id }, "read-failure-request"))
      .rejects.toThrow("test job read unavailable");
    const [committed] = await f.media();
    expect((await f.jobs())).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].images.map((image) => image.mediaId)).toEqual([committed.r2Key]);
    expect(f.objects.get(committed.r2Key)).toEqual(photo.body);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("retains committed sources when the database acknowledgment is lost", async () => {
    const f = await fixture();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      await transaction(callback, config);
      throw new Error("test database acknowledgment lost after commit");
    });

    expect((await createPack(f.ctx, { ...PHOTO_REQUEST, productId: f.product.id }, "lost-acknowledgment-request")).status).toBe(503);
    const [committed] = await f.media();
    expect((await f.jobs())).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
    expect(f.objects.get(committed.r2Key)).toEqual(photo.body);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("deletes attempt-owned objects when a request is refused before persistence", async () => {
    const f = await fixture();
    const response = await createPack(f.ctx, { ...PHOTO_REQUEST, productId: randomUUID() }, "missing-product-request");
    expect(response.status).toBe(404);
    expect(f.put).toHaveBeenCalledTimes(1);
    const uploadedKey = f.put.mock.calls[0][2];
    expect(f.remove).toHaveBeenCalledExactlyOnceWith([uploadedKey]);
    expect(f.objects.size).toBe(0);
    expect(await f.media()).toHaveLength(0);
    expect(await f.jobs()).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });
});

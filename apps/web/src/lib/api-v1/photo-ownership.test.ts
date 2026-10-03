import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api-keys/auth";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { CreateJobInput, CreateJobResult, JobView, Services } from "@/lib/services/types";
import { createFakeServices, TEST_JOB_ID, TEST_PRODUCT_ID, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";
import type { ImportedPhoto, PhotoImportResult } from "@/lib/url-import/image";
import { createPack, type ApiContext } from "./actions";
import { storePackPhotos, type PhotoDeps } from "./photos";
import { mainImagePng } from "./test-fixtures";

const PHOTO_URL = "https://shop.example/product.png";
const BROKEN_URL = "https://shop.example/broken.png";
const BODY = { channels: ["amazon.main"], photos: [{ url: PHOTO_URL }] };
const job: JobView = {
  id: TEST_JOB_ID,
  productId: TEST_PRODUCT_ID,
  productTitle: "Product",
  status: "queued",
  mode: "listing",
  channels: ["amazon.main"],
  creditsReserved: 1,
  creditsCharged: 0,
  createdAt: "2026-10-02T00:00:00.000Z",
  shots: [],
};
let photo: ImportedPhoto;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryPhotos() {
  const objects = new Map<string, Buffer>();
  const fetchPhoto = vi.fn(async (): Promise<PhotoImportResult> => ({ ok: true, photo }));
  const put = vi.fn(async (_workspaceId: string, imported: ImportedPhoto, key: string) => {
    if (objects.has(key)) return false;
    objects.set(key, Buffer.from(imported.body));
    return true;
  });
  const remove = vi.fn(async (keys: string[]) => {
    for (const key of keys) objects.delete(key);
    return [] as string[];
  });
  return { objects, fetchPhoto, put, remove };
}

function context(services: Services, photos: PhotoDeps): ApiContext {
  const caller: ApiCaller = {
    kind: "api_key",
    keyId: "test-key",
    prefix: null,
    connectionId: null,
    ipExempt: false,
    scopes: ["packs:write", "packs:read", "checks"],
    principal: { workspaceId: TEST_WORKSPACE_ID, workspaceName: "Test", plan: "pro", role: "owner", userId: "test-user" },
    services,
    rateSubject: "user:test-user",
  };
  return { caller, headers: new Headers(), photos };
}

beforeAll(async () => {
  const body = await mainImagePng(300, 0.8);
  photo = {
    body,
    contentType: "image/png",
    sha256: createHash("sha256").update(body).digest("hex"),
    width: 300,
    height: 300,
  };
});

beforeEach(() => {
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("R2_ACCOUNT_ID", "test-account");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("API photo storage ownership", () => {
  it("stores identical bytes separately for separate requests while deduplicating each request", async () => {
    const storage = memoryPhotos();
    const sources = [{ url: PHOTO_URL, angle: "front" as const }, { url: PHOTO_URL, angle: "back" as const }];
    const [first, second] = await Promise.all([
      storePackPhotos(TEST_WORKSPACE_ID, sources, { store: true, ...storage }),
      storePackPhotos(TEST_WORKSPACE_ID, sources, { store: true, ...storage }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.uploads).toEqual([
      { key: expect.stringContaining(`ws/${TEST_WORKSPACE_ID}/src/`), sha256: photo.sha256, kind: "image", angle: "front" },
    ]);
    expect(second.uploads).toEqual([
      { key: expect.stringContaining(`ws/${TEST_WORKSPACE_ID}/src/`), sha256: photo.sha256, kind: "image", angle: "front" },
    ]);
    expect(first.uploads[0].key).not.toBe(second.uploads[0].key);
    expect(first.created).toEqual([first.uploads[0].key]);
    expect(second.created).toEqual([second.uploads[0].key]);
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(storage.objects.size).toBe(2);
  });

  it.each([
    { outcome: "replayed", job },
    { outcome: "conflict", existingJobId: TEST_JOB_ID },
    { outcome: "rejected", reason: "maintenance", message: "Packs are paused." },
  ] satisfies CreateJobResult[])("a delayed $outcome response deletes only that request's photo", async (firstResult) => {
    const storage = memoryPhotos();
    const services = createFakeServices("owner");
    const firstEntered = deferred<CreateJobInput>();
    const firstResponse = deferred<CreateJobResult>();
    vi.mocked(services.createJob)
      .mockImplementationOnce(async (_workspaceId, input) => {
        firstEntered.resolve(input);
        return firstResponse.promise;
      })
      .mockResolvedValueOnce({ outcome: "created", job });
    const ctx = context(services, storage);

    // A writes first, but B creates the pack before A's replay/refusal lands.
    const first = createPack(ctx, BODY, "shared-idempotency-key");
    const firstInput = await firstEntered.promise;
    const second = await createPack(ctx, BODY, "shared-idempotency-key");
    const secondInput = vi.mocked(services.createJob).mock.calls[1][1];
    firstResponse.resolve(firstResult);
    const response = await first;
    const firstKey = firstInput.uploads![0].key;
    const secondKey = secondInput.uploads![0].key;

    expect(second.status).toBe(201);
    expect(response.status).toBe(firstResult.outcome === "replayed" ? 200 : firstResult.outcome === "conflict" ? 409 : 503);
    expect(firstInput).toMatchObject({ origin: "api", uploads: [{ sha256: photo.sha256 }] });
    expect(secondInput).toMatchObject({ origin: "api", uploads: [{ sha256: photo.sha256 }] });
    expect(firstKey).not.toBe(secondKey);
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith([firstKey]);
    expect(storage.objects.has(firstKey)).toBe(false);
    expect(storage.objects.get(secondKey)).toEqual(photo.body);
    expect([...storage.objects.keys()]).toEqual([secondKey]);
  });

  it("a partial photo-set failure cannot delete a concurrently accepted pack's source", async () => {
    const storage = memoryPhotos();
    const firstStored = deferred<string>();
    const brokenPhoto = deferred<PhotoImportResult>();
    const originalPut = storage.put.getMockImplementation()!;
    storage.put.mockImplementation(async (workspaceId, imported, key) => {
      const created = await originalPut(workspaceId, imported, key);
      firstStored.resolve(key);
      return created;
    });
    const photos: PhotoDeps = {
      ...storage,
      fetchPhoto: async (url) => url === BROKEN_URL ? brokenPhoto.promise : { ok: true, photo },
    };
    const services = createFakeServices("owner");
    vi.mocked(services.createJob).mockResolvedValue({ outcome: "created", job });
    const ctx = context(services, photos);

    const failed = createPack(ctx, { ...BODY, photos: [{ url: PHOTO_URL }, { url: BROKEN_URL }] }, "partial-request");
    const firstKey = await firstStored.promise;
    const accepted = await createPack(ctx, BODY, "accepted-request");
    const acceptedKey = vi.mocked(services.createJob).mock.calls[0][1].uploads![0].key;
    brokenPhoto.resolve({ ok: false, reason: "not_image", message: "Not an image." });
    const response = await failed;

    expect(accepted.status).toBe(201);
    expect(response).toMatchObject({ status: 422, body: { reason: "not_image" } });
    expect(services.createJob).toHaveBeenCalledTimes(1);
    expect(firstKey).not.toBe(acceptedKey);
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith([firstKey]);
    expect([...storage.objects.keys()]).toEqual([acceptedKey]);
    expect(storage.objects.get(acceptedKey)).toEqual(photo.body);
  });
});

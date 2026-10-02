import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { demoApiKeyBackend, setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { createApiKey } from "@/lib/api-keys/manage";
import { MemoryApiKeyStore } from "@/lib/api-keys/store";
import { createPack, type ApiContext } from "@/lib/api-v1/actions";
import { API_OPERATIONS, buildOpenApiDocument, componentSchema } from "@/lib/api-v1/openapi";
import {
  ChannelsResponse,
  COMPONENT_SCHEMAS,
  ErrorResponse,
  MainImageCheckResponse,
  PackFilesResponse,
  PackResponse,
} from "@/lib/api-v1/schemas";
import { DEMO_KEY_ID, demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import type { JobView } from "@/lib/services/types";
import { createFakeServices, OTHER_WORKSPACE_ID } from "@/lib/testing/fake-services";

// Contract tests for the public API v1 (docs/phases/PHASE_16.md workstream
// 5): every operation in the OpenAPI document is served by a route, every
// answer matches the documented schema and status, and keys are scoped to
// their workspace and stop working when revoked. Runs on the demo services.

const packsRoute = await import("./packs/route");
const packRoute = await import("./packs/[id]/route");
const filesRoute = await import("./packs/[id]/files/route");
const checkRoute = await import("./checks/main-image/route");
const channelsRoute = await import("./channels/route");
const openapiRoute = await import("./openapi.json/route");

const ROUTES: Record<string, Record<string, unknown>> = {
  "/api/v1/packs": packsRoute,
  "/api/v1/packs/{id}": packRoute,
  "/api/v1/packs/{id}/files": filesRoute,
  "/api/v1/checks/main-image": checkRoute,
  "/api/v1/channels": channelsRoute,
};

const BASE = "https://curvi.ai";
let fixture: DemoApiFixture;

function request(
  method: string,
  path: string,
  options: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.20", ...options.headers };
  const key = options.key === undefined ? fixture.key : options.key;
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** The operation's documented statuses. */
function documented(path: string, method: string): number[] {
  const op = API_OPERATIONS.find((o) => o.path === path && o.method === method);
  if (!op) throw new Error(`undocumented ${method} ${path}`);
  return [...op.success.map((s) => s.status), ...op.errors];
}

/** Checks status and body against the document and returns the body. */
async function expectContract<T extends z.ZodType>(
  response: Response,
  path: string,
  method: string,
  schema: T,
): Promise<z.infer<T> & Partial<z.infer<typeof ErrorResponse>>> {
  expect(documented(path, method)).toContain(response.status);
  const body = (await response.json()) as unknown;
  const parsed = (response.status < 400 ? schema : ErrorResponse).safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return body as z.infer<T> & Partial<z.infer<typeof ErrorResponse>>;
}

async function createDemoPack(key: string, body: unknown = { channels: ["amazon.main"] }): Promise<Response> {
  return packsRoute.POST(request("POST", "/api/v1/packs", { body, headers: { "idempotency-key": key } }));
}

beforeEach(() => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the OpenAPI document", () => {
  it("is served, and every operation in it has a route handler", async () => {
    const response = await openapiRoute.GET();
    expect(response.status).toBe(200);
    const doc = (await response.json()) as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe("3.1.0");
    for (const op of API_OPERATIONS) {
      expect(doc.paths[op.path]?.[op.method], `${op.method} ${op.path}`).toBeDefined();
      expect(typeof ROUTES[op.path]?.[op.method.toUpperCase()], `${op.method} ${op.path} handler`).toBe("function");
    }
    expect(Object.keys(doc.paths).sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it("resolves every schema reference and generates its schemas from the route schemas", () => {
    const doc = buildOpenApiDocument();
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1]);
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    for (const ref of refs) {
      expect(schemas[ref!], ref).toBeDefined();
    }
    for (const name of Object.keys(COMPONENT_SCHEMAS) as Array<keyof typeof COMPONENT_SCHEMAS>) {
      expect(schemas[name]).toEqual(componentSchema(name));
    }
    // The pack request documents the Idempotency-Key header as required.
    expect(text).toContain('"name":"Idempotency-Key","in":"header","required":true');
  });
});

describe("POST /api/v1/packs", () => {
  it("starts a pack and answers the documented shape, with channel names expanded to live specs", async () => {
    const response = await createDemoPack("contract-1", { channels: ["amazon"], title: "Glass bottle" });
    expect(response.status).toBe(201);
    const body = await expectContract(response, "/api/v1/packs", "post", PackResponse);
    expect(response.headers.get("location")).toBe(`/api/v1/packs/${body.pack.id}`);
    expect(body.pack.channels).toContain("amazon.main");
    expect(body.pack.creditsReserved).toBeGreaterThan(0);
    expect(body.pack.productTitle).toBe("Glass bottle");
  });

  it("requires an Idempotency-Key, replays a retry and refuses the key with another body", async () => {
    const missing = await packsRoute.POST(request("POST", "/api/v1/packs", { body: { channels: ["amazon.main"] } }));
    expect((await expectContract(missing, "/api/v1/packs", "post", PackResponse)).reason).toBe("idempotency_key_required");

    const first = await expectContract(await createDemoPack("same"), "/api/v1/packs", "post", PackResponse);
    const retry = await createDemoPack("same");
    expect(retry.status).toBe(200);
    const replay = await expectContract(retry, "/api/v1/packs", "post", PackResponse);
    expect(replay).toMatchObject({ replayed: true, pack: { id: first.pack.id } });

    const clash = await createDemoPack("same", { channels: ["shopify.product"] });
    expect(clash.status).toBe(409);
    expect(await expectContract(clash, "/api/v1/packs", "post", PackResponse)).toMatchObject({
      reason: "idempotency_conflict",
      existingPackId: first.pack.id,
    });
  });

  it("refuses unknown channels, unknown fields and a bundle that clashes with the options", async () => {
    for (const body of [
      { channels: ["myspace"] },
      { channels: ["amazon.main"], surprise: true },
      { channels: ["amazon.main"], bundle: "main", outputOptions: { bundle: "listing" } },
      { channels: ["amazon.main"], photos: [{ url: "https://example.com/a.jpg", data: "AAAA" }] },
    ]) {
      const response = await createDemoPack(`bad-${JSON.stringify(body).length}`, body);
      expect(response.status).toBe(400);
      await expectContract(response, "/api/v1/packs", "post", PackResponse);
    }
  });

  it("takes the bundle shortcut and base64 photos", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    const png = await mainImagePng(400, 0.8);
    const response = await createDemoPack("bundle-photo", {
      channels: ["amazon.main"],
      bundle: "main",
      photos: [{ data: png.toString("base64") }],
    });
    expect(response.status).toBe(201);
    await expectContract(response, "/api/v1/packs", "post", PackResponse);
    const bad = await createDemoPack("bad-photo", { channels: ["amazon.main"], photos: [{ data: "bm90IGFuIGltYWdl" }] });
    expect(bad.status).toBe(422);
    await expectContract(bad, "/api/v1/packs", "post", PackResponse);
    vi.unstubAllEnvs();
  });

  it("reads photo links through the safe import, naming stored photos by their hash", async () => {
    const png = await mainImagePng(300, 0.8);
    const fetchPhoto = vi.fn(async () => ({
      ok: true as const,
      photo: { body: png, contentType: "image/png" as const, sha256: "a".repeat(64), width: 300, height: 300 },
    }));
    const put = vi.fn(async (_ws: string, _photo: unknown, _key: string) => true);
    const remove = vi.fn(async (_keys: string[]) => [] as string[]);
    const services = createFakeServices("owner");
    vi.mocked(services.createJob).mockResolvedValue({ outcome: "conflict" });
    vi.stubEnv("R2_ACCOUNT_ID", "acct");
    vi.stubEnv("R2_ACCESS_KEY_ID", "id");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("R2_BUCKET_PRIVATE", "bucket");
    const ctx: ApiContext = {
      caller: {
        kind: "api_key",
        keyId: DEMO_KEY_ID,
        prefix: "cv_live_000000000000",
        connectionId: null,
        ipExempt: false,
        scopes: ["packs:write"],
        principal: { workspaceId: OTHER_WORKSPACE_ID, workspaceName: "W", plan: "growth", role: "owner", userId: "u" },
        services,
        rateSubject: "user:u",
      },
      headers: new Headers(),
      photos: { fetchPhoto, put, remove },
    };
    await createPack(ctx, { channels: ["amazon.main"], photos: [{ url: "https://shop.example/p.png", angle: "back" }] }, "k1");
    vi.unstubAllEnvs();
    expect(fetchPhoto).toHaveBeenCalledWith("https://shop.example/p.png");
    const key = `ws/${OTHER_WORKSPACE_ID}/src/api-${"a".repeat(64)}`;
    expect(put).toHaveBeenCalledWith(OTHER_WORKSPACE_ID, expect.anything(), key);
    expect(services.createJob).toHaveBeenCalledWith(
      OTHER_WORKSPACE_ID,
      expect.objectContaining({
        idempotencyKey: "k1",
        mode: "listing",
        productId: "new",
        uploads: [{ key, sha256: "a".repeat(64), kind: "image", angle: "back" }],
      }),
    );
    // The key made no new pack (a conflict), so the photo this request
    // wrote is taken back.
    expect(remove).toHaveBeenCalledWith([key]);
  });

  it("never writes over a stored photo and only takes back what a refused request wrote", async () => {
    const png = await mainImagePng(300, 0.8);
    const photoOf = (sha: string) => ({
      ok: true as const,
      photo: { body: png, contentType: "image/png" as const, sha256: sha, width: 300, height: 300 },
    });
    const fetchPhoto = vi.fn(async (url: string) => photoOf(url.endsWith("old.png") ? "b".repeat(64) : "c".repeat(64)));
    // The old photo is already stored (and cleaned by ingest): the
    // conditional put reports it was there and writes nothing.
    const put = vi.fn(async (_ws: string, _photo: unknown, key: string) => !key.endsWith("b".repeat(64)));
    const remove = vi.fn(async (_keys: string[]) => [] as string[]);
    const services = createFakeServices("owner");
    vi.stubEnv("R2_ACCOUNT_ID", "acct");
    vi.stubEnv("R2_ACCESS_KEY_ID", "id");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("R2_BUCKET_PRIVATE", "bucket");
    const ctx: ApiContext = {
      caller: {
        kind: "api_key",
        keyId: DEMO_KEY_ID,
        prefix: "cv_live_000000000000",
        connectionId: null,
        ipExempt: false,
        scopes: ["packs:write"],
        principal: { workspaceId: OTHER_WORKSPACE_ID, workspaceName: "W", plan: "growth", role: "owner", userId: "u" },
        services,
        rateSubject: "user:u",
      },
      headers: new Headers(),
      photos: { fetchPhoto, put, remove },
    };
    const body = { channels: ["amazon.main"], photos: [{ url: "https://shop.example/old.png" }, { url: "https://shop.example/new.png" }] };
    vi.mocked(services.createJob).mockResolvedValueOnce({
      outcome: "rejected",
      reason: "insufficient_credits",
      message: "Not enough credits.",
    });
    const refused = await createPack(ctx, body, "k3");
    const newKey = `ws/${OTHER_WORKSPACE_ID}/src/api-${"c".repeat(64)}`;
    expect(refused.status).toBe(402);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([newKey]);

    remove.mockClear();
    const job: JobView = {
      id: "00000000-0000-4000-8000-000000000999",
      productId: "3f2e1d0c-9b8a-4765-8432-10fedcba9876",
      productTitle: "Mug",
      status: "queued",
      mode: "listing",
      channels: ["amazon.main"],
      creditsReserved: 1,
      creditsCharged: 0,
      createdAt: new Date(0).toISOString(),
      shots: [],
    };
    vi.mocked(services.createJob).mockResolvedValueOnce({ outcome: "created", job });
    expect((await createPack(ctx, body, "k4")).status).toBe(201);
    vi.unstubAllEnvs();
    expect(remove).not.toHaveBeenCalled();
  });

  it("takes the question step's answers as seed values and refuses any other value", async () => {
    const ok = await createDemoPack("answers-1", { channels: ["amazon.main"], answers: { mood: "kitchen", channels: "amazon" } });
    expect(ok.status).toBe(201);
    await expectContract(ok, "/api/v1/packs", "post", PackResponse);
    for (const answers of [{ mood: "neon" }, { target: "item:1" }, { channels: "myspace" }]) {
      const bad = await createDemoPack(`answers-bad-${JSON.stringify(answers).length}`, { channels: ["amazon.main"], answers });
      expect(bad.status, JSON.stringify(answers)).toBe(400);
      expect((await expectContract(bad, "/api/v1/packs", "post", PackResponse)).reason).toBe("invalid_request");
    }

    const services = createFakeServices("owner");
    vi.mocked(services.createJob).mockResolvedValue({ outcome: "conflict" });
    const ctx: ApiContext = {
      caller: {
        kind: "api_key",
        keyId: DEMO_KEY_ID,
        prefix: "cv_live_000000000000",
        connectionId: null,
        ipExempt: false,
        scopes: ["packs:write"],
        principal: { workspaceId: OTHER_WORKSPACE_ID, workspaceName: "W", plan: "growth", role: "owner", userId: "u" },
        services,
        rateSubject: "user:u",
      },
      headers: new Headers(),
    };
    await createPack(ctx, { channels: ["amazon.main"], answers: { mood: "gym" } }, "k-answers");
    expect(services.createJob).toHaveBeenCalledWith(
      OTHER_WORKSPACE_ID,
      expect.objectContaining({ answers: { mood: "gym" } }),
    );
  });

  it("refuses a key whose maker holds a client seat before fetching any photo", async () => {
    const fetchPhoto = vi.fn();
    const services = createFakeServices("client");
    const ctx: ApiContext = {
      caller: {
        kind: "api_key",
        keyId: DEMO_KEY_ID,
        prefix: "cv_live_000000000000",
        connectionId: null,
        ipExempt: false,
        scopes: ["packs:write"],
        principal: { workspaceId: OTHER_WORKSPACE_ID, workspaceName: "W", plan: "growth", role: "client", userId: "u" },
        services,
        rateSubject: "user:u",
      },
      headers: new Headers(),
      photos: { fetchPhoto },
    };
    const result = await createPack(ctx, { channels: ["amazon.main"], photos: [{ url: "https://shop.example/p.png" }] }, "k2");
    expect(result.status).toBe(403);
    expect(fetchPhoto).not.toHaveBeenCalled();
    expect(services.createJob).not.toHaveBeenCalled();
  });

  it("holds the form's rate limit", async () => {
    setRateLimitStoreForTests(new MemoryRateLimitStore());
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      statuses.push((await createDemoPack(`rl-${i}`, { channels: ["myspace"] })).status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 400)).toBe(true);
    const limited = await createDemoPack("rl-last", { channels: ["myspace"] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    await expectContract(limited, "/api/v1/packs", "post", PackResponse);
  });
});

describe("GET /api/v1/packs/{id} and /files", () => {
  it("reads the pack until it finishes, then lists its files", async () => {
    const created = (await (await createDemoPack("read-1")).json()) as { pack: { id: string } };
    const id = created.pack.id;
    let finished = false;
    for (let i = 0; i < 20 && !finished; i += 1) {
      const response = await packRoute.GET(request("GET", `/api/v1/packs/${id}`), params(id));
      expect(response.status).toBe(200);
      const body = await expectContract(response, "/api/v1/packs/{id}", "get", PackResponse);
      finished = body.pack.finished;
    }
    expect(finished).toBe(true);
    const files = await filesRoute.GET(request("GET", `/api/v1/packs/${id}/files`), params(id));
    expect(files.status).toBe(200);
    const body = await expectContract(files, "/api/v1/packs/{id}/files", "get", PackFilesResponse);
    expect(body.files.length).toBeGreaterThan(0);
    // The demo stores no files, so there is nothing to sign.
    expect(body.files.every((f) => f.url === null && f.expiresAt === null)).toBe(true);
  });

  it("answers 404 for a bad id and a pack that is not there", async () => {
    for (const id of ["nope", "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"]) {
      const pack = await packRoute.GET(request("GET", `/api/v1/packs/${id}`), params(id));
      expect(pack.status).toBe(404);
      await expectContract(pack, "/api/v1/packs/{id}", "get", PackResponse);
      const files = await filesRoute.GET(request("GET", `/api/v1/packs/${id}/files`), params(id));
      expect(files.status).toBe(404);
    }
  });

  it("signs each file link on the files route with a 15 minute expiry", async () => {
    const services = createFakeServices("owner");
    vi.mocked(services.listJobFiles).mockResolvedValue({
      jobId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
      status: "done",
      files: [
        { id: "v_1", name: "a.jpg", channel: "amazon", specId: "amazon.main", kind: "image", bytes: 10, url: null, downloadUrl: "/x" },
        { id: "p_2", name: "b.zip", channel: "amazon", specId: null, kind: "zip", bytes: 20, url: null, downloadUrl: null },
      ],
    });
    vi.mocked(services.getJobFileDownload).mockResolvedValue({ url: "https://r2.example/signed", filename: "SKU_main.jpg" });
    setApiKeyBackendForTests(demoApiKeyBackend(fixture.store, () => services));
    const id = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
    const response = await filesRoute.GET(request("GET", `/api/v1/packs/${id}/files`), params(id));
    const body = await expectContract(response, "/api/v1/packs/{id}/files", "get", PackFilesResponse);
    expect(body.files[0]).toMatchObject({ url: "https://r2.example/signed", name: "SKU_main.jpg" });
    expect(Date.parse(body.files[0]!.expiresAt!) - Date.now()).toBeLessThanOrEqual(900_000);
    expect(body.files[1]).toMatchObject({ url: null, expiresAt: null });
    expect(services.getJobFileDownload).toHaveBeenCalledTimes(1);
    expect(services.getJobFileDownload).toHaveBeenCalledWith(DEMO_WORKSPACE_ID, id, "v_1");
  });
});

describe("keys are scoped and revocable", () => {
  it("never reads another workspace's pack", async () => {
    const created = (await (await createDemoPack("scoped")).json()) as { pack: { id: string } };
    // A key of another workspace: its calls run as that workspace.
    const store = new MemoryApiKeyStore();
    const other = await createApiKey(
      store,
      { workspaceId: OTHER_WORKSPACE_ID, plan: "growth", role: "owner", userId: "u2" },
      { name: "other" },
    );
    if (!other.ok) throw new Error("expected a key");
    const services = createFakeServices("owner");
    setApiKeyBackendForTests({
      mode: "db",
      store,
      acceptsPrefix: () => true,
      principal: async (record) => ({
        workspaceId: record.workspaceId,
        workspaceName: "Other",
        plan: "growth",
        role: "owner",
        userId: "u2",
      }),
      servicesFor: () => services,
    });
    const response = await packRoute.GET(
      request("GET", `/api/v1/packs/${created.pack.id}`, { key: other.key }),
      params(created.pack.id),
    );
    expect(response.status).toBe(404);
    expect(services.getJob).toHaveBeenCalledWith(OTHER_WORKSPACE_ID, created.pack.id);
    // And the demo key does not open the other workspace's store.
    const demoKey = await packRoute.GET(request("GET", `/api/v1/packs/${created.pack.id}`), params(created.pack.id));
    expect(demoKey.status).toBe(401);
  });

  it("refuses a missing key, a wrong key and a revoked key with 401", async () => {
    const none = await channelsRoute.GET(request("GET", "/api/v1/channels", { key: null }));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    await expectContract(none, "/api/v1/channels", "get", ChannelsResponse);

    expect((await channelsRoute.GET(request("GET", "/api/v1/channels"))).status).toBe(200);
    await fixture.store.revoke(DEMO_WORKSPACE_ID, DEMO_KEY_ID, new Date());
    const revoked = await channelsRoute.GET(request("GET", "/api/v1/channels"));
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ reason: "revoked_key" });
    const packs = await createDemoPack("after-revoke");
    expect(packs.status).toBe(401);
  });

  it("refuses a key without the scope an operation needs", async () => {
    const store = new MemoryApiKeyStore();
    const reader = await createApiKey(
      store,
      { workspaceId: DEMO_WORKSPACE_ID, plan: "growth", role: "owner", userId: "u" },
      { name: "reader", scopes: ["packs:read"] },
    );
    if (!reader.ok) throw new Error("expected a key");
    setApiKeyBackendForTests(demoApiKeyBackend(store, () => fixture.service));
    const response = await packsRoute.POST(
      request("POST", "/api/v1/packs", { key: reader.key, body: { channels: ["amazon.main"] }, headers: { "idempotency-key": "r" } }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "insufficient_scope" });
  });
});

describe("POST /api/v1/checks/main-image", () => {
  it("measures a compliant main image and a failing one", async () => {
    const good = await mainImagePng(2000, 0.87);
    const pass = await checkRoute.POST(
      request("POST", "/api/v1/checks/main-image", { body: { data: good.toString("base64") } }),
    );
    expect(pass.status).toBe(200);
    const passBody = await expectContract(pass, "/api/v1/checks/main-image", "post", MainImageCheckResponse);
    expect(passBody).toMatchObject({ pass: true, width: 2000, height: 2000 });

    const small = await mainImagePng(600, 0.3);
    const fail = await checkRoute.POST(
      request("POST", "/api/v1/checks/main-image", { body: { data: small.toString("base64") } }),
    );
    const failBody = await expectContract(fail, "/api/v1/checks/main-image", "post", MainImageCheckResponse);
    expect(failBody.pass).toBe(false);
    expect(failBody.checks.filter((c) => !c.pass).map((c) => c.key).sort()).toEqual(["fill", "resolution"]);
  });

  it("refuses a body with neither or both inputs, and bytes that are not an image", async () => {
    for (const body of [{}, { url: "https://a.example/x.png", data: "AAAA" }]) {
      const response = await checkRoute.POST(request("POST", "/api/v1/checks/main-image", { body }));
      expect(response.status).toBe(400);
      await expectContract(response, "/api/v1/checks/main-image", "post", MainImageCheckResponse);
    }
    const junk = await checkRoute.POST(request("POST", "/api/v1/checks/main-image", { body: { data: "bm9wZQ==" } }));
    expect(junk.status).toBe(422);
  });
});

describe("GET /api/v1/channels", () => {
  it("lists specs with availability on the plan and the bundles", async () => {
    const response = await channelsRoute.GET(request("GET", "/api/v1/channels"));
    const body = await expectContract(response, "/api/v1/channels", "get", ChannelsResponse);
    expect(body.channels.find((c) => c.id === "amazon.main")).toMatchObject({ availability: "available", width: 2000 });
    expect(body.bundles.map((b) => b.key)).toContain("everything");
  });
});

describe("the look shortcut", () => {
  it("expands a look into its seeded preset for the bundle, under any options sent with it", async () => {
    const { withLook } = await import("@/lib/api-v1/actions");
    const { lookPresetFor } = await import("@curvi/pipeline/output-options");
    expect(withLook({ channels: ["amazon.main"] })).toEqual({ channels: ["amazon.main"] });
    expect(withLook({ channels: ["amazon.main"], look: "marketplace" })).toEqual({
      channels: ["amazon.main"],
      look: "marketplace",
      outputOptions: { ...lookPresetFor("marketplace"), lookBase: "marketplace" },
    });
    expect(
      withLook({ channels: ["amazon.main"], look: "keep_photo", outputOptions: { bundle: "listing", logo: false } }),
    ).toEqual({
      channels: ["amazon.main"],
      look: "keep_photo",
      outputOptions: { ...lookPresetFor("keep_photo", "listing"), lookBase: "keep_photo", bundle: "listing", logo: false },
    });
    // An unknown look is left for the schema to refuse.
    expect(withLook({ channels: ["amazon.main"], look: "neon" })).toEqual({ channels: ["amazon.main"], look: "neon" });
  });

  it("starts a pack with a look and the bundle shortcut, and refuses an unknown look", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    const ok = await createDemoPack("look-1", { channels: ["amazon.main"], bundle: "main", look: "marketplace" });
    expect(ok.status).toBe(201);
    await expectContract(ok, "/api/v1/packs", "post", PackResponse);
    const bad = await createDemoPack("look-2", { channels: ["amazon.main"], look: "neon" });
    expect(bad.status).toBe(400);
    expect((await expectContract(bad, "/api/v1/packs", "post", PackResponse)).reason).toBe("invalid_request");
  });
});

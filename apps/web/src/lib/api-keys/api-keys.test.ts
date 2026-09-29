import { describe, expect, it, vi } from "vitest";
import { createFakeServices, OTHER_WORKSPACE_ID, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";
import type { Services } from "@/lib/services/types";
import { authenticateApiKey, LAST_USED_WRITE_INTERVAL_MS } from "./auth";
import { DEMO_API_KEY, demoApiKeyBackend, type ApiKeyBackend, type ApiPrincipal } from "./backend";
import {
  API_SCOPES,
  bearerKeyOf,
  DEMO_KEY_TAG,
  generateApiKey,
  hashApiKey,
  keyMatchesHash,
  LIVE_KEY_TAG,
  prefixOf,
} from "./format";
import {
  API_KEY_COPY,
  checkApiAccess,
  createApiKey,
  listApiKeys,
  MAX_ACTIVE_API_KEYS,
  revokeApiKey,
  type ApiKeyManager,
} from "./manage";
import { MemoryApiKeyStore, type ApiKeyRecord } from "./store";

// Workspace API keys (docs/phases/PHASE_16.md workstream 5): shown once,
// stored hashed, looked up by prefix, revocable, workspace scoped, Growth
// and up (seed entitlement apiAccess), owners and admins manage them.

const USER_A = "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090";
const USER_B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

function manager(overrides: Partial<ApiKeyManager> = {}): ApiKeyManager {
  return { workspaceId: TEST_WORKSPACE_ID, plan: "growth", role: "owner", userId: USER_A, ...overrides };
}

function headers(key: string | null): Headers {
  return new Headers(key ? { authorization: `Bearer ${key}` } : {});
}

/** A db like backend over a memory store: members and plans per workspace. */
function testBackend(
  store: MemoryApiKeyStore,
  seats: Record<string, { plan: string; members: Record<string, ApiPrincipal["role"]> }>,
  servicesFor: (principal: ApiPrincipal) => Services = () => createFakeServices("owner"),
): ApiKeyBackend {
  return {
    mode: "db",
    store,
    acceptsPrefix: (prefix) => !prefix.startsWith(DEMO_KEY_TAG),
    principal: async (record: ApiKeyRecord) => {
      const ws = seats[record.workspaceId];
      const role = record.createdBy ? ws?.members[record.createdBy] : undefined;
      return ws && role && record.createdBy
        ? { workspaceId: record.workspaceId, workspaceName: "W", plan: ws.plan, role, userId: record.createdBy }
        : null;
    },
    servicesFor,
  };
}

describe("key format", () => {
  it("makes a prefixed key whose hash, not the key, is what gets stored", () => {
    const made = generateApiKey();
    expect(made.key.startsWith(LIVE_KEY_TAG)).toBe(true);
    expect(prefixOf(made.key)).toBe(made.prefix);
    expect(made.keyHash).toBe(hashApiKey(made.key));
    expect(made.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(made.keyHash).not.toContain(made.key.slice(made.prefix.length + 1));
    expect(keyMatchesHash(made.key, made.keyHash)).toBe(true);
    expect(keyMatchesHash(`${made.key.slice(0, -1)}x`, made.keyHash)).toBe(false);
    expect(keyMatchesHash(made.key, "")).toBe(false);
    expect(generateApiKey().prefix).not.toBe(made.prefix);
  });

  it("reads only well formed keys and bearer headers", () => {
    expect(prefixOf("cv_live_abc")).toBeNull();
    expect(prefixOf("sk_live_0123456789ab_x")).toBeNull();
    expect(prefixOf(DEMO_API_KEY)).toBe(`${DEMO_KEY_TAG}000000000000`);
    expect(bearerKeyOf(headers("abc"))).toBe("abc");
    expect(bearerKeyOf(new Headers({ authorization: "Basic abc" }))).toBeNull();
    expect(bearerKeyOf(headers(null))).toBeNull();
  });
});

describe("key management", () => {
  it("gates keys on the seeded apiAccess entitlement: Growth and up", () => {
    expect(checkApiAccess("free").ok).toBe(false);
    expect(checkApiAccess("starter").ok).toBe(false);
    expect(checkApiAccess("growth").ok).toBe(true);
    expect(checkApiAccess("pro").ok).toBe(true);
    expect(checkApiAccess("agency").ok).toBe(true);
    const refused = checkApiAccess("starter");
    expect(refused.ok ? "" : refused.message).toContain("Growth plan");
  });

  it("shows a new key once and lists keys without their hash", async () => {
    const store = new MemoryApiKeyStore();
    const created = await createApiKey(store, manager(), { name: "  Claude   Code  " });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.key.startsWith(created.view.prefix)).toBe(true);
    expect(created.view.name).toBe("Claude Code");
    expect(created.view.scopes).toEqual([...API_SCOPES]);
    const stored = await store.findByPrefix(created.view.prefix);
    expect(stored?.keyHash).toBe(hashApiKey(created.key));
    expect(stored?.createdBy).toBe(USER_A);

    const listed = await listApiKeys(store, manager());
    expect(listed.ok).toBe(true);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(created.key);
    expect(text).not.toContain(stored?.keyHash ?? "missing");
  });

  it("lets only owners and admins on an entitled plan manage keys", async () => {
    const store = new MemoryApiKeyStore();
    for (const role of ["editor", "client"] as const) {
      expect(await createApiKey(store, manager({ role }), { name: "x" })).toMatchObject({ ok: false, reason: "forbidden" });
      expect(await listApiKeys(store, manager({ role }))).toMatchObject({ ok: false, reason: "forbidden" });
    }
    expect(await createApiKey(store, manager({ role: "admin" }), { name: "x" })).toMatchObject({ ok: true });
    expect(await createApiKey(store, manager({ plan: "starter" }), { name: "x" })).toMatchObject({
      ok: false,
      reason: "upgrade_required",
    });
    expect(await createApiKey(store, manager(), { name: "   " })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await createApiKey(store, manager(), { name: "x", scopes: ["admin:all"] })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("keeps scopes the caller asked for and caps active keys", async () => {
    const store = new MemoryApiKeyStore();
    const readOnly = await createApiKey(store, manager(), { name: "reader", scopes: ["packs:read", "nope"] });
    expect(readOnly.ok && readOnly.view.scopes).toEqual(["packs:read"]);
    for (let i = 1; i < MAX_ACTIVE_API_KEYS; i += 1) {
      await createApiKey(store, manager(), { name: `k${i}` });
    }
    expect(await createApiKey(store, manager(), { name: "one too many" })).toMatchObject({ ok: false, reason: "too_many" });
  });

  it("revokes only keys of the manager's own workspace, on any plan", async () => {
    const store = new MemoryApiKeyStore();
    const created = await createApiKey(store, manager(), { name: "x" });
    if (!created.ok) throw new Error("expected a key");
    const other = manager({ workspaceId: OTHER_WORKSPACE_ID });
    expect(await revokeApiKey(store, other, created.view.id)).toEqual({ ok: false, reason: "not_found", notice: API_KEY_COPY.notFound });
    expect(await revokeApiKey(store, manager({ role: "editor" }), created.view.id)).toMatchObject({ reason: "forbidden" });
    expect(await revokeApiKey(store, manager(), "not a uuid")).toMatchObject({ reason: "not_found" });
    expect(await revokeApiKey(store, manager({ plan: "free" }), created.view.id)).toMatchObject({ ok: true });
    expect((await store.findByPrefix(created.view.prefix))?.revokedAt).toBeInstanceOf(Date);
  });
});

describe("authenticateApiKey", () => {
  async function setup(plan = "growth") {
    const store = new MemoryApiKeyStore();
    const services = createFakeServices("owner");
    const backend = testBackend(
      store,
      {
        [TEST_WORKSPACE_ID]: { plan, members: { [USER_A]: "owner", [USER_B]: "client" } },
        [OTHER_WORKSPACE_ID]: { plan: "growth", members: { [USER_B]: "owner" } },
      },
      () => services,
    );
    const created = await createApiKey(store, manager({ plan: "growth" }), { name: "k" });
    if (!created.ok) throw new Error("expected a key");
    return { store, backend, services, key: created.key, view: created.view };
  }

  it("resolves a valid key to its workspace and maker, with the form's rate limit subject", async () => {
    const { backend, key, services } = await setup();
    const auth = await authenticateApiKey(headers(key), "packs:write", { backend });
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.caller.principal).toMatchObject({ workspaceId: TEST_WORKSPACE_ID, userId: USER_A, role: "owner" });
    expect(auth.caller.services).toBe(services);
    expect(auth.caller.rateSubject).toBe(`user:${USER_A}`);
  });

  it("answers the same 401 for a missing, malformed, unknown or wrong key", async () => {
    const { backend, key } = await setup();
    const unknown = generateApiKey().key;
    const wrongSecret = `${prefixOf(key)}_${"A".repeat(43)}`;
    const results = await Promise.all(
      [null, "nope", unknown, wrongSecret].map((k) => authenticateApiKey(headers(k), null, { backend })),
    );
    expect(results.map((r) => (r.ok ? 200 : r.error.status))).toEqual([401, 401, 401, 401]);
    expect(results.map((r) => (r.ok ? "" : r.error.reason))).toEqual(["missing_key", "invalid_key", "invalid_key", "invalid_key"]);
  });

  it("stops a revoked key at once", async () => {
    const { backend, key, store, view } = await setup();
    expect((await authenticateApiKey(headers(key), null, { backend })).ok).toBe(true);
    await revokeApiKey(store, manager(), view.id);
    const auth = await authenticateApiKey(headers(key), null, { backend });
    expect(auth).toMatchObject({ ok: false, error: { status: 401, reason: "revoked_key" } });
  });

  it("stops a key whose maker left the workspace", async () => {
    const store = new MemoryApiKeyStore();
    const created = await createApiKey(store, manager({ userId: USER_B }), { name: "k" });
    if (!created.ok) throw new Error("expected a key");
    // USER_B made the key, then left: the workspace has no seat for them.
    const backend = testBackend(store, { [TEST_WORKSPACE_ID]: { plan: "growth", members: {} } });
    expect(await authenticateApiKey(headers(created.key), null, { backend })).toMatchObject({
      ok: false,
      error: { status: 401, reason: "invalid_key" },
    });
  });

  it("refuses a workspace whose plan dropped below Growth, and a key without the scope", async () => {
    const { backend, key } = await setup("starter");
    expect(await authenticateApiKey(headers(key), null, { backend })).toMatchObject({
      ok: false,
      error: { status: 403, reason: "upgrade_required" },
    });

    const store = new MemoryApiKeyStore();
    const reader = await createApiKey(store, manager(), { name: "r", scopes: ["packs:read"] });
    if (!reader.ok) throw new Error("expected a key");
    const readerBackend = testBackend(store, { [TEST_WORKSPACE_ID]: { plan: "growth", members: { [USER_A]: "owner" } } });
    expect((await authenticateApiKey(headers(reader.key), "packs:read", { backend: readerBackend })).ok).toBe(true);
    expect(await authenticateApiKey(headers(reader.key), "packs:write", { backend: readerBackend })).toMatchObject({
      ok: false,
      error: { status: 403, reason: "insufficient_scope" },
    });
  });

  it("never lets the demo key into a database backend", async () => {
    const store = new MemoryApiKeyStore();
    const backend = testBackend(store, {});
    const spy = vi.spyOn(store, "findByPrefix");
    expect(await authenticateApiKey(headers(DEMO_API_KEY), null, { backend })).toMatchObject({
      ok: false,
      error: { status: 401 },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts the demo key on the demo backend", async () => {
    const auth = await authenticateApiKey(headers(DEMO_API_KEY), "packs:write", {
      backend: demoApiKeyBackend(undefined, () => createFakeServices("owner")),
    });
    expect(auth.ok).toBe(true);
  });

  it("records use at most once a minute per key", async () => {
    const { backend, key, store } = await setup();
    const touch = vi.spyOn(store, "touch");
    const t0 = new Date("2026-09-29T10:00:00.000Z");
    await authenticateApiKey(headers(key), null, { backend, now: t0 });
    await vi.waitFor(() => expect(touch).toHaveBeenCalledTimes(1));
    await authenticateApiKey(headers(key), null, { backend, now: new Date(t0.getTime() + 1000) });
    await authenticateApiKey(headers(key), null, {
      backend,
      now: new Date(t0.getTime() + LAST_USED_WRITE_INTERVAL_MS),
    });
    await vi.waitFor(() => expect(touch).toHaveBeenCalledTimes(2));
  });

  it("answers 503, not a pass, when the lookup fails", async () => {
    const { backend, key, store } = await setup();
    vi.spyOn(store, "findByPrefix").mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await authenticateApiKey(headers(key), null, { backend })).toMatchObject({
      ok: false,
      error: { status: 503, reason: "unavailable" },
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiKeys, creditLedger, members, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { authenticateApiKey } from "./auth";
import { DEMO_API_KEY, dbApiKeyBackend } from "./backend";
import { DbApiKeyStore } from "./db-store";
import { createApiKey, listApiKeys, revokeApiKey } from "./manage";

// api_keys over the owner connection (migration 0024): the store filters
// every workspace scoped call by workspace_id itself, since the owner
// connection bypasses RLS, and a key acts as its maker only while that
// member still belongs to the workspace.

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const CLIENT = "00000000-0000-4000-8000-0000000000a2";
const OTHER_OWNER = "00000000-0000-4000-8000-0000000000a3";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let otherWs: string;

function headers(key: string): Headers {
  return new Headers({ authorization: `Bearer ${key}` });
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Growth shop", plan: "growth" }).returning();
  const [o] = await db.insert(workspaces).values({ name: "Other shop", plan: "pro" }).returning();
  ws = w!.id;
  otherWs = o!.id;
  await db.insert(members).values([
    { workspaceId: ws, userId: OWNER, role: "owner" },
    { workspaceId: ws, userId: CLIENT, role: "client" },
    { workspaceId: otherWs, userId: OTHER_OWNER, role: "owner" },
  ]);
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 100, reason: "grant", source: "system" });
});

afterAll(async () => {
  await client.close();
});

describe("DbApiKeyStore", () => {
  it("stores the hash and prefix, never the key, and lists per workspace", async () => {
    const store = new DbApiKeyStore(db as unknown as Db);
    const manager = { workspaceId: ws, plan: "growth", role: "owner" as const, userId: OWNER };
    const created = await createApiKey(store, manager, { name: "CLI" });
    if (!created.ok) throw new Error(created.notice);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.view.id));
    expect(row?.prefix).toBe(created.view.prefix);
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(row?.createdBy).toBe(OWNER);

    const other = await createApiKey(store, { workspaceId: otherWs, plan: "pro", role: "owner", userId: OTHER_OWNER }, { name: "Other" });
    if (!other.ok) throw new Error(other.notice);
    const listed = await listApiKeys(store, manager);
    expect(listed.ok && listed.keys.map((k) => k.id)).toEqual([created.view.id]);
    expect(await store.countActive(ws)).toBe(1);

    // Revoking through another workspace finds nothing.
    expect(await revokeApiKey(store, { workspaceId: otherWs, plan: "pro", role: "owner", userId: OTHER_OWNER }, created.view.id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("authenticates a key as its maker until it is revoked", async () => {
    const database = db as unknown as Db;
    const store = new DbApiKeyStore(database);
    const backend = dbApiKeyBackend(database);
    const created = await createApiKey(store, { workspaceId: ws, plan: "growth", role: "owner", userId: OWNER }, { name: "Agent" });
    if (!created.ok) throw new Error(created.notice);

    const auth = await authenticateApiKey(headers(created.key), "packs:write", { backend });
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.caller.principal).toMatchObject({ workspaceId: ws, userId: OWNER, role: "owner", plan: "growth" });
    expect(auth.caller.services.mode).toBe("db");
    await expect.poll(async () => (await store.findByPrefix(created.view.prefix))?.lastUsedAt).toBeInstanceOf(Date);

    await revokeApiKey(store, { workspaceId: ws, plan: "growth", role: "admin", userId: OWNER }, created.view.id);
    expect(await authenticateApiKey(headers(created.key), null, { backend })).toMatchObject({
      ok: false,
      error: { reason: "revoked_key" },
    });
  });

  it("stops a key once its maker leaves, and follows the maker's seat", async () => {
    const database = db as unknown as Db;
    const store = new DbApiKeyStore(database);
    const backend = dbApiKeyBackend(database);
    // A key made by an owner who is later demoted to a client seat.
    await db.insert(members).values({ workspaceId: ws, userId: "00000000-0000-4000-8000-0000000000a4", role: "owner" });
    const created = await createApiKey(
      store,
      { workspaceId: ws, plan: "growth", role: "owner", userId: "00000000-0000-4000-8000-0000000000a4" },
      { name: "Leaver" },
    );
    if (!created.ok) throw new Error(created.notice);
    await client.exec(`update members set role = 'client' where user_id = '00000000-0000-4000-8000-0000000000a4'`);
    const demoted = await authenticateApiKey(headers(created.key), "packs:write", { backend });
    expect(demoted.ok && demoted.caller.principal.role).toBe("client");
    if (demoted.ok) {
      const refused = await demoted.caller.services.createJob(ws, {
        productId: "new",
        channels: ["amazon.main"],
        mode: "listing",
        idempotencyKey: "demoted",
      });
      expect(refused).toMatchObject({ outcome: "rejected", reason: "role_forbidden" });
    }
    await client.exec(`delete from members where user_id = '00000000-0000-4000-8000-0000000000a4'`);
    expect(await authenticateApiKey(headers(created.key), null, { backend })).toMatchObject({
      ok: false,
      error: { status: 401, reason: "invalid_key" },
    });
  });

  it("refuses the demo key and a plan without API access", async () => {
    const database = db as unknown as Db;
    const backend = dbApiKeyBackend(database);
    expect(await authenticateApiKey(headers(DEMO_API_KEY), null, { backend })).toMatchObject({ ok: false, error: { status: 401 } });

    const store = new DbApiKeyStore(database);
    const created = await createApiKey(store, { workspaceId: otherWs, plan: "pro", role: "owner", userId: OTHER_OWNER }, { name: "Downgraded" });
    if (!created.ok) throw new Error(created.notice);
    await client.exec(`update workspaces set plan = 'starter' where id = '${otherWs}'`);
    expect(await authenticateApiKey(headers(created.key), null, { backend })).toMatchObject({
      ok: false,
      error: { status: 403, reason: "upgrade_required" },
    });
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { members, workspaces, mcpConnections, eq, type Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { DEMO_API_KEY } from "@/lib/api-keys/backend";
import { API_SCOPES } from "@/lib/api-keys/format";
import { getPack, listPackFiles } from "@/lib/api-v1/actions";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { demoApiFixture } from "@/lib/api-v1/test-fixtures";
import { checkAssistantAccess } from "@/lib/entitlements";
import { DEMO_MODE_REFUSED_MESSAGE } from "@/lib/services/demo-mode";
import { authenticateMcp, oauthIdentityOf, type AuthenticateMcpOptions, type McpAuthResult } from "./authenticate";
import { dbMcpAuthBackend, memoryMcpAuthBackend, type McpAuthBackend, type MemoryMembership } from "./backend";
import { MemoryMcpConnectionStore, type McpConnectionRecord } from "./connections";
import { TEST_CLIENT_ID, TEST_CONFIG, TEST_USER_ID, oauthClaims, testKeys, type TestKeys } from "./test-tokens";

// One authenticator for /api/mcp (docs/phases/PHASE_19.md, P19-08 and
// "Workspace scoping"): the API key path as before, and the OAuth path that
// reads the connection, the membership and the workspace on every call.

const WS_A = "00000000-0000-4000-8000-00000000aaaa";
const WS_B = "00000000-0000-4000-8000-00000000bbbb";
const NOW = new Date("2026-10-01T12:00:00.000Z");

let keys: TestKeys;
let seats: MemoryMembership[];
let store: MemoryMcpConnectionStore;
let backend: McpAuthBackend;

function seat(workspaceId: string, role: MemoryMembership["role"] = "owner", plan = "free"): MemoryMembership {
  return { userId: TEST_USER_ID, workspaceId, workspaceName: workspaceId === WS_A ? "Shop A" : "Shop B", plan, role };
}

function row(overrides: Partial<McpConnectionRecord> = {}): McpConnectionRecord {
  return {
    id: "00000000-0000-4000-8000-0000000c0001",
    workspaceId: WS_A,
    userId: TEST_USER_ID,
    oauthClientId: TEST_CLIENT_ID,
    clientName: "ChatGPT",
    profileId: "ProfileIdProfileId0001",
    createdAt: new Date("2026-09-30T00:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

async function bearer(claims = oauthClaims()): Promise<Headers> {
  return new Headers({ authorization: `Bearer ${await keys.sign(claims)}` });
}

function options(extra: AuthenticateMcpOptions = {}): AuthenticateMcpOptions {
  return { backend, config: TEST_CONFIG, jwks: keys.jwks, now: NOW, ...extra };
}

function failureKind(result: McpAuthResult): string {
  return result.ok ? "ok" : result.failure.kind;
}

beforeAll(async () => {
  keys = await testKeys();
});

beforeEach(() => {
  seats = [seat(WS_A)];
  store = new MemoryMcpConnectionStore([row()]);
  backend = memoryMcpAuthBackend({ memberships: seats, connections: store, services: () => demoApiFixture().service });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticateMcp: credentials", () => {
  it("asks for a credential when there is no bearer", async () => {
    expect(await authenticateMcp(new Headers(), null, options())).toEqual({
      ok: false,
      credential: "none",
      failure: { kind: "no_credential" },
    });
    expect(failureKind(await authenticateMcp(new Headers({ authorization: "Basic abc" }), null, options()))).toBe("no_credential");
  });

  it("takes the API key path for a cv_ bearer, unchanged, and reuses the lookup made before the body", async () => {
    const fixture = demoApiFixture();
    const headers = new Headers({ authorization: `Bearer ${DEMO_API_KEY}` });
    const lookup = vi.fn(async () => ({ ok: true as const, caller: { ...(await keyCaller(fixture)) } }));
    const fresh = await authenticateMcp(headers, "packs:write", options({ authenticateApiKey: lookup }));
    expect(fresh.ok && fresh.caller.kind).toBe("api_key");
    expect(lookup).toHaveBeenCalledWith(headers, null);

    const preAuth = await lookup();
    lookup.mockClear();
    const reused = await authenticateMcp(headers, "checks", options({ authenticateApiKey: lookup, preAuth }));
    expect(reused.ok).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(reused.ok && oauthIdentityOf(reused.caller)).toBe(null);

    const narrowed = await authenticateMcp(headers, "packs:write", options({ preAuth: { ok: true, caller: { ...preAuth.caller, scopes: ["checks"] } } }));
    expect(narrowed).toMatchObject({ ok: false, credential: "api_key", failure: { kind: "api_key", error: { status: 403, reason: "insufficient_scope" } } });

    const malformed = await authenticateMcp(new Headers({ authorization: "Bearer cv_live_nope" }), null, options());
    expect(malformed).toMatchObject({ ok: false, credential: "api_key", failure: { kind: "api_key", error: { status: 401 } } });
  });

  it("refuses a token that fails verification with its reason, before any connection lookup", async () => {
    const findLive = vi.spyOn(store, "findLive");
    const result = await authenticateMcp(await bearer(oauthClaims({ aud: "authenticated" })), null, options());
    expect(result).toEqual({ ok: false, credential: "oauth", failure: { kind: "token", reason: "wrong_audience" } });
    expect(findLive).not.toHaveBeenCalled();
  });
});

async function keyCaller(fixture: ReturnType<typeof demoApiFixture>) {
  const auth = await authenticateApiKey(new Headers({ authorization: `Bearer ${fixture.key}` }), null, { backend: fixture.backend });
  if (!auth.ok) {
    throw new Error("the fixture key should authenticate");
  }
  return auth.caller;
}

describe("authenticateMcp: the OAuth caller", () => {
  it("acts as the user in the connection's workspace with every scope, exempt from the IP rule", async () => {
    const result = await authenticateMcp(await bearer(), "packs:write", options());
    if (!result.ok) {
      throw new Error(JSON.stringify(result));
    }
    expect(result.caller).toMatchObject({
      kind: "oauth",
      keyId: null,
      prefix: null,
      connectionId: row().id,
      ipExempt: true,
      scopes: [...API_SCOPES],
      rateSubject: `user:${TEST_USER_ID}`,
      principal: { workspaceId: WS_A, workspaceName: "Shop A", plan: "free", role: "owner", userId: TEST_USER_ID },
    });
    expect(oauthIdentityOf(result.caller)).toEqual({ clientId: TEST_CLIENT_ID, profileId: "ProfileIdProfileId0001", email: "seller@example.com" });
  });

  it("never takes the workspace from anything but the connection", async () => {
    seats.push(seat(WS_B));
    const headers = await bearer(oauthClaims({ workspace_id: WS_B, app_metadata: { workspace_id: WS_B } }));
    headers.set("x-curvi-workspace", WS_B);
    const result = await authenticateMcp(headers, null, options());
    expect(result.ok && result.caller.principal.workspaceId).toBe(WS_A);
  });

  it("reads the role fresh, so a client seat stays a client seat", async () => {
    seats[0] = seat(WS_A, "client");
    const result = await authenticateMcp(await bearer(), null, options());
    expect(result.ok && result.caller.principal.role).toBe("client");
  });

  it("refuses a member who left at once, and revokes the connection so the consent page asks again", async () => {
    seats.length = 0;
    expect(failureKind(await authenticateMcp(await bearer(), null, options()))).toBe("reconnect");
    expect(store.rows[0]?.revokedAt).toEqual(NOW);
    // Back in the workspace, the revoked row is not made live again.
    seats.push(seat(WS_A));
    expect(failureKind(await authenticateMcp(await bearer(), null, options()))).toBe("reconnect");
    expect(store.rows).toHaveLength(1);
  });

  it("checks the plan against the seed's assistantAccess and answers with the neutral copy", async () => {
    for (const plan of ["free", "starter", "growth", "pro", "agency"]) {
      seats[0] = seat(WS_A, "owner", plan);
      expect((await authenticateMcp(await bearer(), null, options())).ok, plan).toBe(true);
    }
    const seedCheck = vi.fn(checkAssistantAccess);
    await authenticateMcp(await bearer(), null, options({ assistantAccess: seedCheck }));
    expect(seedCheck).toHaveBeenCalledWith("agency");
    const off = await authenticateMcp(await bearer(), null, options({ assistantAccess: (plan) => checkAssistantAccess(plan, () => false) }));
    expect(off).toEqual({ ok: false, credential: "oauth", failure: { kind: "not_in_plan", message: MCP_COPY.assistantAccessOff } });
  });

  it("records a use at most once a minute", async () => {
    const touch = vi.spyOn(store, "touch");
    await authenticateMcp(await bearer(), null, options());
    expect(touch).toHaveBeenCalledTimes(1);
    store.rows[0]!.lastUsedAt = new Date(NOW.getTime() - 30_000);
    await authenticateMcp(await bearer(), null, options());
    expect(touch).toHaveBeenCalledTimes(1);
    store.rows[0]!.lastUsedAt = new Date(NOW.getTime() - 60_000);
    await authenticateMcp(await bearer(), null, options());
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it("answers unavailable when the connection lookup fails or demo mode is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "findLive").mockRejectedValue(new Error("db down"));
    const down = await authenticateMcp(await bearer(), null, options());
    expect(down).toEqual({ ok: false, credential: "oauth", failure: { kind: "unavailable", message: MCP_COPY.connectionUnavailable } });

    // With no database configured, production refuses the in memory demo.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("ALLOW_DEMO_MODE", "");
    const refused = await authenticateMcp(await bearer(), null, { config: TEST_CONFIG, jwks: keys.jwks, now: NOW });
    expect(refused).toEqual({ ok: false, credential: "oauth", failure: { kind: "unavailable", message: DEMO_MODE_REFUSED_MESSAGE } });
    vi.unstubAllEnvs();
  });
});

describe("authenticateMcp: connections that do not exist yet", () => {
  beforeEach(() => {
    store.rows.length = 0;
  });

  it("makes the first row when no row ever existed and the user has exactly one workspace", async () => {
    const result = await authenticateMcp(await bearer(), null, options());
    expect(result.ok && result.caller.principal.workspaceId).toBe(WS_A);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ userId: TEST_USER_ID, oauthClientId: TEST_CLIENT_ID, workspaceId: WS_A, revokedAt: null });
    expect(store.rows[0]!.profileId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("asks to reconnect a user with two workspaces or none, and makes no row", async () => {
    seats.push(seat(WS_B));
    expect(failureKind(await authenticateMcp(await bearer(), null, options()))).toBe("reconnect");
    seats.length = 0;
    expect(failureKind(await authenticateMcp(await bearer(), null, options()))).toBe("reconnect");
    expect(store.rows).toHaveLength(0);
  });

  it("never recreates a revoked row", async () => {
    store.rows.push(row({ revokedAt: new Date("2026-09-30T12:00:00.000Z") }));
    expect(failureKind(await authenticateMcp(await bearer(), null, options()))).toBe("reconnect");
    expect(store.rows).toHaveLength(1);
  });
});

describe("over the database (mcp_connections, migration 0028)", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;
  let wsA: string;
  let wsB: string;
  const OTHER_USER = "00000000-0000-4000-8000-0000000000e1";

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
    const [a] = await db.insert(workspaces).values({ name: "Shop A", plan: "starter" }).returning();
    const [b] = await db.insert(workspaces).values({ name: "Shop B", plan: "growth" }).returning();
    wsA = a!.id;
    wsB = b!.id;
    await db.insert(members).values([
      { workspaceId: wsA, userId: TEST_USER_ID, role: "owner" },
      { workspaceId: wsB, userId: OTHER_USER, role: "owner" },
    ]);
    return async () => {
      await client.close();
    };
  });

  function dbOptions(): AuthenticateMcpOptions {
    return { backend: dbMcpAuthBackend(db as unknown as Db, { check: async () => "alive" }), config: TEST_CONFIG, jwks: keys.jwks, now: NOW };
  }

  it("makes the first row, keeps one profile id per user across clients, reconnects and workspace changes", async () => {
    const first = await authenticateMcp(await bearer(), null, dbOptions());
    if (!first.ok) {
      throw new Error(JSON.stringify(first));
    }
    expect(first.caller.principal).toMatchObject({ workspaceId: wsA, workspaceName: "Shop A", plan: "starter", role: "owner" });
    const profileId = oauthIdentityOf(first.caller)!.profileId;
    expect(profileId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // A refresh (new session, same connection) and a repeat call keep it.
    const again = await authenticateMcp(await bearer(oauthClaims({ session_id: "33333333-3333-4444-8555-666666666666" })), null, dbOptions());
    expect(again.ok && again.caller.connectionId).toBe(first.caller.connectionId);
    expect(again.ok && oauthIdentityOf(again.caller)!.profileId).toBe(profileId);

    // The consent page moves the connection to another workspace: a new row,
    // the old one revoked, the same profile id.
    await db.insert(members).values({ workspaceId: wsB, userId: TEST_USER_ID, role: "editor" });
    const store = dbMcpAuthBackend(db as unknown as Db).connections;
    const moved = await store.connect({ userId: TEST_USER_ID, oauthClientId: TEST_CLIENT_ID, clientName: "ChatGPT", workspaceId: wsB }, NOW);
    expect(moved.id).not.toBe(first.caller.connectionId);
    expect(moved.profileId).toBe(profileId);
    expect((await store.findById(first.caller.connectionId!))?.revokedAt).not.toBeNull();
    const inB = await authenticateMcp(await bearer(), null, dbOptions());
    expect(inB.ok && inB.caller.principal).toMatchObject({ workspaceId: wsB, role: "editor" });
    expect(inB.ok && oauthIdentityOf(inB.caller)!.profileId).toBe(profileId);

    // The same workspace again keeps the live row.
    const same = await store.connect({ userId: TEST_USER_ID, oauthClientId: TEST_CLIENT_ID, clientName: "ChatGPT", workspaceId: wsB }, NOW);
    expect(same.id).toBe(moved.id);

    // Another client of the same user gets the same profile id.
    const codex = await store.connect({ userId: TEST_USER_ID, oauthClientId: "codex-client", clientName: "Codex", workspaceId: wsA }, NOW);
    expect(codex.profileId).toBe(profileId);

    // A disconnect revokes; the next call is asked to reconnect and no row
    // comes back on its own.
    await store.revoke(moved.id, NOW);
    expect(failureKind(await authenticateMcp(await bearer(), null, dbOptions()))).toBe("reconnect");
    const live = await db.select().from(mcpConnections).where(eq(mcpConnections.oauthClientId, TEST_CLIENT_ID));
    expect(live.filter((r) => r.revokedAt === null)).toHaveLength(0);

    // Reconnecting through the consent page works and keeps the id.
    const back = await store.connect({ userId: TEST_USER_ID, oauthClientId: TEST_CLIENT_ID, clientName: "ChatGPT", workspaceId: wsA }, NOW);
    expect(back.profileId).toBe(profileId);
    const after = await authenticateMcp(await bearer(), null, dbOptions());
    expect(after.ok && after.caller.connectionId).toBe(back.id);
  });

  it("cannot reach another workspace's pack", async () => {
    const USER_C = "00000000-0000-4000-8000-0000000000c3";
    await db.insert(members).values({ workspaceId: wsA, userId: USER_C, role: "owner" });
    const product = await client.query<{ id: string }>(
      "insert into products (workspace_id, title, mode) values ($1, 'Lamp', 'listing') returning id",
      [wsB],
    );
    const job = await client.query<{ id: string }>(
      "insert into generation_jobs (workspace_id, product_id) values ($1, $2) returning id",
      [wsB, product.rows[0]!.id],
    );
    const result = await authenticateMcp(await bearer(oauthClaims({ sub: USER_C })), null, dbOptions());
    if (!result.ok) {
      throw new Error(JSON.stringify(result));
    }
    expect(result.caller.principal.workspaceId).toBe(wsA);
    const ctx = { caller: result.caller, headers: new Headers() };
    expect((await getPack(ctx, job.rows[0]!.id)).status).toBe(404);
    expect((await listPackFiles(ctx, job.rows[0]!.id)).status).toBe(404);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mcpConnections, members, termsAcceptances, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { DbMcpConnectionStore } from "./connections";
import { dbConsentBackend, type ConsentBackend } from "./consent-backend";

// The consent backend over the owner connection and Supabase's auth-js
// (docs/phases/PHASE_19.md, P19-09 and P19-10). Supabase's own tables are
// stood in for by the columns its migrations create (docs/verification.md,
// "PHASE_19", the p19/consent rows); the hosted columns are checked in P19-12.

const USER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const CLIENT = "11111111-2222-4333-8444-555555555555";
const OTHER_CLIENT = "99999999-2222-4333-8444-555555555555";
const NOW = new Date("2026-10-01T12:00:00.000Z");

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let wsA: string;
let wsB: string;

interface StubCalls {
  approve: Array<[string, unknown]>;
  deny: Array<[string, unknown]>;
  revokeGrant: unknown[];
  signOut: unknown[];
}

function stubSupabase(answers: {
  details?: () => Promise<{ data: unknown; error: unknown }>;
  approve?: () => Promise<{ data: unknown; error: unknown }>;
  revoke?: () => Promise<{ error: unknown }>;
  user?: { id: string; email?: string } | null;
} = {}) {
  const calls: StubCalls = { approve: [], deny: [], revokeGrant: [], signOut: [] };
  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: answers.user ?? null } }),
      signOut: async (options: unknown) => {
        calls.signOut.push(options);
        return { error: null };
      },
      oauth: {
        getAuthorizationDetails: async () => (answers.details ? answers.details() : { data: null, error: null }),
        approveAuthorization: async (id: string, options: unknown) => {
          calls.approve.push([id, options]);
          return answers.approve ? answers.approve() : { data: { redirect_url: "https://chatgpt.com/cb?code=c" }, error: null };
        },
        denyAuthorization: async (id: string, options: unknown) => {
          calls.deny.push([id, options]);
          return { data: { redirect_url: "https://chatgpt.com/cb?error=access_denied" }, error: null };
        },
        revokeGrant: async (options: unknown) => {
          calls.revokeGrant.push(options);
          return answers.revoke ? answers.revoke() : { data: {}, error: null };
        },
      },
    },
  };
  return { calls, factory: async () => supabase as never };
}

function backendWith(supabase = stubSupabase(), now = NOW): ConsentBackend {
  return dbConsentBackend(db as unknown as Db, supabase.factory, () => now);
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [a] = await db.insert(workspaces).values({ name: "Shop A", plan: "free" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "Shop B", plan: "starter" }).returning();
  wsA = a!.id;
  wsB = b!.id;
  await db.insert(members).values([
    { workspaceId: wsB, userId: USER, role: "editor", createdAt: new Date("2026-02-01T00:00:00.000Z") },
    { workspaceId: wsA, userId: USER, role: "owner", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    { workspaceId: wsA, userId: OTHER, role: "admin" },
  ]);
  // Supabase Auth's tables, with the columns its migrations create
  // (20250731150234, 20250804100000, 20250904133000; status is an enum there).
  await client.exec(`
    create table auth.oauth_clients (id uuid primary key, client_name text);
    create table auth.oauth_authorizations (
      id uuid primary key default gen_random_uuid(),
      authorization_id text unique not null,
      client_id uuid not null references auth.oauth_clients(id),
      user_id uuid,
      redirect_uri text not null,
      scope text not null,
      status text not null default 'pending',
      approved_at timestamptz
    );
    create table auth.sessions (id uuid primary key, user_id uuid not null, oauth_client_id uuid, not_after timestamptz);
    insert into auth.oauth_clients (id, client_name) values ('${CLIENT}', 'ChatGPT');
  `);
});

afterAll(async () => {
  await client.close();
});

describe("DbConsentBackend: Supabase's OAuth server", () => {
  it("follows the kill switch: only MCP_OAUTH_ENABLED=1 lets the page connect", () => {
    for (const [value, on] of [["1", true], ["0", false], ["", false], ["true", false]] as const) {
      vi.stubEnv("MCP_OAUTH_ENABLED", value);
      expect(backendWith().signInEnabled(), value).toBe(on);
    }
    vi.unstubAllEnvs();
  });

  it("maps the details answer, the consented answer and each failure", async () => {
    const details = stubSupabase({
      details: async () => ({
        data: {
          authorization_id: "abc",
          redirect_uri: "https://chatgpt.com/cb",
          client: { id: CLIENT, name: "ChatGPT", uri: "", logo_uri: "" },
          user: { id: USER, email: "a@example.com" },
          scope: "openid email  profile email",
        },
        error: null,
      }),
    });
    expect(await backendWith(details).getAuthorization("abc")).toEqual({
      kind: "details",
      clientId: CLIENT,
      clientName: "ChatGPT",
      scopes: ["openid", "email", "profile"],
    });
    const consented = stubSupabase({ details: async () => ({ data: { redirect_url: "https://chatgpt.com/cb?code=x" }, error: null }) });
    expect(await backendWith(consented).getAuthorization("abc")).toEqual({ kind: "consented", redirectUrl: "https://chatgpt.com/cb?code=x" });

    const failure = (error: unknown) => stubSupabase({ details: async () => ({ data: null, error }) });
    expect(await backendWith(failure({ name: "AuthSessionMissingError", status: 400 })).getAuthorization("abc")).toEqual({ kind: "signed_out" });
    expect(await backendWith(failure({ name: "AuthApiError", status: 403, code: "session_not_found" })).getAuthorization("abc")).toEqual({ kind: "signed_out" });
    expect(await backendWith(failure({ name: "AuthApiError", status: 404, code: "oauth_authorization_not_found" })).getAuthorization("abc")).toEqual({ kind: "expired" });
    expect(await backendWith(failure({ name: "AuthApiError", status: 400, code: "validation_failed" })).getAuthorization("abc")).toEqual({ kind: "expired" });
    expect(await backendWith(failure({ name: "AuthRetryableFetchError", status: 502 })).getAuthorization("abc")).toEqual({ kind: "unavailable" });
    const thrown = stubSupabase({
      details: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await backendWith(thrown).getAuthorization("abc")).toEqual({ kind: "unavailable" });
    expect(await dbConsentBackend(db as unknown as Db, async () => null).getAuthorization("abc")).toEqual({ kind: "unavailable" });
  });

  it("approves and denies without a browser redirect, and maps a failed approval", async () => {
    const supabase = stubSupabase();
    const b = backendWith(supabase);
    expect(await b.approve("abc")).toEqual({ ok: true, redirectUrl: "https://chatgpt.com/cb?code=c" });
    expect(await b.deny("abc")).toEqual({ ok: true, redirectUrl: "https://chatgpt.com/cb?error=access_denied" });
    expect(supabase.calls.approve).toEqual([["abc", { skipBrowserRedirect: true }]]);
    expect(supabase.calls.deny).toEqual([["abc", { skipBrowserRedirect: true }]]);
    const expired = stubSupabase({ approve: async () => ({ data: null, error: { status: 400 } }) });
    expect(await backendWith(expired).approve("abc")).toEqual({ ok: false, reason: "expired" });
  });

  it("revokes the user's own grant by client id and signs out this browser only", async () => {
    const supabase = stubSupabase();
    const b = backendWith(supabase);
    expect(await b.revokeOwnGrant(CLIENT)).toBe(true);
    expect(supabase.calls.revokeGrant).toEqual([{ clientId: CLIENT }]);
    await b.signOutHere();
    // A global sign out would also delete every ChatGPT session of the user
    // (Supabase Auth models.Logout deletes all of the user's sessions).
    expect(supabase.calls.signOut).toEqual([{ scope: "local" }]);
    const failing = stubSupabase({ revoke: async () => ({ error: { status: 500 } }) });
    expect(await backendWith(failing).revokeOwnGrant(CLIENT)).toBe(false);
  });

  it("reads the signed in user from the web session", async () => {
    expect(await backendWith(stubSupabase({ user: { id: USER, email: "a@example.com" } })).currentUser()).toEqual({
      id: USER,
      email: "a@example.com",
    });
    expect(await backendWith(stubSupabase({ user: null })).currentUser()).toBeNull();
  });
});

describe("DbConsentBackend: the owner connection", () => {
  it("lists the user's memberships with workspace names, oldest first", async () => {
    const memberships = await backendWith().listMemberships(USER);
    expect(memberships.map((m) => [m.workspaceId, m.workspaceName, m.role])).toEqual([
      [wsA, "Shop A", "owner"],
      [wsB, "Shop B", "editor"],
    ]);
    expect(await backendWith().listMemberships("00000000-0000-4000-8000-0000000000ff")).toEqual([]);
  });

  it("reads today's role and workspace names", async () => {
    const b = backendWith();
    expect(await b.role(USER, wsB)).toBe("editor");
    expect(await b.role(OTHER, wsB)).toBeNull();
    expect(await b.workspaceNames([wsA, wsB])).toEqual(
      new Map([
        [wsA, "Shop A"],
        [wsB, "Shop B"],
      ]),
    );
    expect(await b.workspaceNames([])).toEqual(new Map());
  });

  it("reads an approved authorization of this user from auth.oauth_authorizations", async () => {
    await client.exec(`
      insert into auth.oauth_authorizations (authorization_id, client_id, user_id, redirect_uri, scope, status, approved_at) values
        ('ApprovedNow', '${CLIENT}', '${USER}', 'https://chatgpt.com/connector/oauth/cb1', 'openid email', 'approved', '2026-10-01T11:58:00Z'),
        ('ApprovedLongAgo', '${CLIENT}', '${USER}', 'https://chatgpt.com/connector/oauth/cb1', 'openid email', 'approved', '2026-10-01T11:40:00Z'),
        ('StillPending', '${CLIENT}', '${USER}', 'https://chatgpt.com/connector/oauth/cb1', 'openid email', 'pending', null);
    `);
    const b = backendWith();
    expect(await b.storedAuthorization("ApprovedNow", USER)).toEqual({
      clientId: CLIENT,
      clientName: "ChatGPT",
      scopes: ["openid", "email"],
      redirectUri: "https://chatgpt.com/connector/oauth/cb1",
    });
    // Another user's request, a code older than 10 minutes, and a pending one.
    expect(await b.storedAuthorization("ApprovedNow", OTHER)).toBeNull();
    expect(await b.storedAuthorization("ApprovedLongAgo", USER)).toBeNull();
    expect(await b.storedAuthorization("StillPending", USER)).toBeNull();
    expect(await b.storedAuthorization("Missing", USER)).toBeNull();
  });

  it("fails closed when the table cannot be read", async () => {
    const created = await createTestDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = dbConsentBackend(created.db as unknown as Db, stubSupabase().factory, () => NOW);
    expect(await b.storedAuthorization("ApprovedNow", USER)).toBe("unavailable");
    expect(await b.endSessions(USER, CLIENT)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await created.client.close();
  });

  it("ends only that user's sessions for that client", async () => {
    await client.exec(`
      insert into auth.sessions (id, user_id, oauth_client_id) values
        ('00000000-0000-4000-8000-0000000000c1', '${USER}', '${CLIENT}'),
        ('00000000-0000-4000-8000-0000000000c2', '${USER}', '${OTHER_CLIENT}'),
        ('00000000-0000-4000-8000-0000000000c3', '${USER}', null),
        ('00000000-0000-4000-8000-0000000000c4', '${OTHER}', '${CLIENT}');
    `);
    expect(await backendWith().endSessions(USER, CLIENT)).toBe(true);
    const left = await client.query<{ id: string }>("select id from auth.sessions order by id");
    expect(left.rows.map((r) => r.id)).toEqual([
      "00000000-0000-4000-8000-0000000000c2",
      "00000000-0000-4000-8000-0000000000c3",
      "00000000-0000-4000-8000-0000000000c4",
    ]);
  });

  it("records the terms acceptance of a user first seen on the consent page", async () => {
    const newcomer = "00000000-0000-4000-8000-0000000000a9";
    await db.insert(members).values({ workspaceId: wsB, userId: newcomer, role: "owner" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await backendWith().prepareUser({ id: newcomer, email: null }, new Headers({ "user-agent": "test" }));
    error.mockRestore();
    const rows = await db.select().from(termsAcceptances).where(eq(termsAcceptances.userId, newcomer));
    expect(rows.map((r) => [r.source, r.workspaceId])).toEqual([["assistant_consent", wsB]]);
  });
});

describe("DbMcpConnectionStore listings", () => {
  it("lists a user's rows newest first and a workspace's live rows", async () => {
    const store = new DbMcpConnectionStore(db as unknown as Db);
    const first = await store.connect({ userId: USER, oauthClientId: CLIENT, clientName: "ChatGPT", workspaceId: wsA }, new Date("2026-09-01T00:00:00Z"));
    const moved = await store.connect({ userId: USER, oauthClientId: CLIENT, clientName: "ChatGPT", workspaceId: wsB }, new Date("2026-09-02T00:00:00Z"));
    const other = await store.connect({ userId: OTHER, oauthClientId: CLIENT, clientName: "ChatGPT", workspaceId: wsA }, new Date("2026-09-03T00:00:00Z"));
    expect((await store.listForUser(USER)).map((r) => [r.id, r.revokedAt !== null])).toEqual([
      [moved.id, false],
      [first.id, true],
    ]);
    expect((await store.listLiveInWorkspace(wsA)).map((r) => r.id)).toEqual([other.id]);
    expect((await store.listLiveInWorkspace(wsB)).map((r) => r.id)).toEqual([moved.id]);
    await db.delete(mcpConnections);
  });
});

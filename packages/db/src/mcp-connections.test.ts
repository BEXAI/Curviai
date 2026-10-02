import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  actAsAnon,
  actAsAuthenticated,
  actAsJwt,
  actAsSuperuser,
  createTestDb,
  readJournalEntries,
  SUPABASE_AUTH_SHIM_SQL,
  type TestDb,
} from "./test-helpers";
import { workspaces } from "./schema";

// Migration 0028 (docs/phases/PHASE_19.md, P19-04 and P19-05):
// mcp_connections RLS (rule 5), the restrictive no_oauth_clients policy that
// keeps tokens from Supabase's OAuth server out of the Data API, and the
// Custom Access Token hook that gives those tokens the MCP audience.

const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const ADMIN_A = "00000000-0000-4000-8000-0000000000a2";
const EDITOR_A = "00000000-0000-4000-8000-0000000000a3";
const CLIENT_SEAT_A = "00000000-0000-4000-8000-0000000000a4";
const FORMER_A = "00000000-0000-4000-8000-0000000000a5";
const OWNER_B = "00000000-0000-4000-8000-0000000000b1";
const CHATGPT = "11111111-2222-4333-8444-555555555555";
const RESOURCE = "https://curvi.ai/api/mcp";
const PROFILE = "AAAAAAAAAAAAAAAAAAAAAA";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;

async function insertConnection(values: {
  workspaceId: string;
  userId: string;
  revokedAt?: Date | null;
  profileId?: string;
}): Promise<string> {
  // Raw SQL, so a refusal names the constraint (Drizzle wraps the error).
  const result = await client.query<{ id: string }>(
    `insert into mcp_connections (workspace_id, user_id, oauth_client_id, client_name, profile_id, revoked_at)
     values ($1, $2, $3, 'ChatGPT', $4, $5) returning id`,
    [values.workspaceId, values.userId, CHATGPT, values.profileId ?? PROFILE, values.revokedAt ?? null],
  );
  return result.rows[0]!.id;
}

async function rowsVisible(): Promise<Array<{ user_id: string; workspace_id: string }>> {
  const result = await client.query<{ user_id: string; workspace_id: string }>(
    "select user_id, workspace_id from mcp_connections order by user_id",
  );
  return result.rows;
}

/** An access token from Supabase's OAuth server, as PostgREST would see it. */
function oauthClaims(sub: string): Record<string, unknown> & { sub: string } {
  return {
    sub,
    role: "authenticated",
    aud: RESOURCE,
    client_id: CHATGPT,
    session_id: "22222222-3333-4444-8555-666666666666",
    scope: "openid email",
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [a] = await db.insert(workspaces).values({ name: "Workspace A", plan: "growth" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "Workspace B" }).returning();
  wsA = a!.id;
  wsB = b!.id;
  await client.query(
    `insert into members (workspace_id, user_id, role) values
       ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'editor'), ($1, $5, 'client'), ($6, $7, 'owner')`,
    [wsA, OWNER_A, ADMIN_A, EDITOR_A, CLIENT_SEAT_A, wsB, OWNER_B],
  );
  await insertConnection({ workspaceId: wsA, userId: OWNER_A });
  await insertConnection({ workspaceId: wsA, userId: EDITOR_A });
  await insertConnection({ workspaceId: wsA, userId: EDITOR_A, revokedAt: new Date("2026-09-30T00:00:00Z") });
  await insertConnection({ workspaceId: wsA, userId: FORMER_A });
  await insertConnection({ workspaceId: wsB, userId: OWNER_B });
  await client.query("insert into subscriptions (workspace_id, provider, tier, status) values ($1, 'stripe', 'growth', 'active')", [wsA]);
  await client.query(
    "insert into recipes (key, version, stage, model, body, active) values ('test.recipe', 1, 'intake', 'test-model', '{\"prompt\":\"secret\"}', true)",
  );
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await actAsSuperuser(client);
  await client.close();
});

describe("mcp_connections table", () => {
  it("exists with row level security on", async () => {
    const result = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'mcp_connections' and relnamespace = 'public'::regnamespace",
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
  });

  it("keeps one live row per user and client, beside any number of revoked ones", async () => {
    await expect(insertConnection({ workspaceId: wsB, userId: OWNER_A })).rejects.toThrow(/mcp_connections_live_user_client_uq/);
    const revoked = await insertConnection({ workspaceId: wsB, userId: OWNER_A, revokedAt: new Date() });
    await client.query("delete from mcp_connections where id = $1", [revoked]);
  });

  it("holds profile_id to 22 base64url characters", async () => {
    await expect(insertConnection({ workspaceId: wsB, userId: ADMIN_A, profileId: "short" })).rejects.toThrow(
      /mcp_connections_profile_id_check/,
    );
    await expect(insertConnection({ workspaceId: wsB, userId: ADMIN_A, profileId: "A".repeat(21) + "=" })).rejects.toThrow(
      /mcp_connections_profile_id_check/,
    );
  });

  it("goes with its workspace", async () => {
    const [c] = await db.insert(workspaces).values({ name: "Gone soon" }).returning();
    await insertConnection({ workspaceId: c!.id, userId: "00000000-0000-4000-8000-0000000000c1" });
    await client.query("delete from workspaces where id = $1", [c!.id]);
    const left = await client.query("select 1 from mcp_connections where workspace_id = $1", [c!.id]);
    expect(left.rows).toHaveLength(0);
  });
});

describe("mcp_connections row level security (rule 5)", () => {
  it("shows a member only their own rows", async () => {
    await actAsAuthenticated(client, EDITOR_A);
    const rows = await rowsVisible();
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.user_id === EDITOR_A)).toBe(true);

    await actAsAuthenticated(client, CLIENT_SEAT_A);
    expect(await rowsVisible()).toEqual([]);
  });

  it("shows owners and admins every row of their workspace and none of another", async () => {
    for (const admin of [OWNER_A, ADMIN_A]) {
      await actAsAuthenticated(client, admin);
      const rows = await rowsVisible();
      expect(rows.length).toBe(4);
      expect(rows.every((row) => row.workspace_id === wsA)).toBe(true);
    }
    await actAsAuthenticated(client, OWNER_B);
    const rows = await rowsVisible();
    expect(rows).toEqual([{ user_id: OWNER_B, workspace_id: wsB }]);
  });

  it("shows a user who left the workspace nothing, not even their own row", async () => {
    await actAsAuthenticated(client, FORMER_A);
    expect(await rowsVisible()).toEqual([]);
  });

  it("shows the anon role nothing", async () => {
    await actAsAnon(client);
    expect(await rowsVisible()).toEqual([]);
  });

  it("refuses every write from a client role, even the workspace owner's", async () => {
    for (const act of [() => actAsAuthenticated(client, OWNER_A), () => actAsAuthenticated(client, EDITOR_A), () => actAsAnon(client)]) {
      await act();
      await expect(
        client.query(
          "insert into mcp_connections (workspace_id, user_id, oauth_client_id, profile_id) values ($1, $2, 'x', $3)",
          [wsA, EDITOR_A, PROFILE],
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
      const updated = await client.query("update mcp_connections set revoked_at = null, workspace_id = $1 returning id", [wsB]);
      expect(updated.rows).toHaveLength(0);
      const deleted = await client.query("delete from mcp_connections returning id");
      expect(deleted.rows).toHaveLength(0);
    }
    await actAsSuperuser(client);
    const all = await client.query("select 1 from mcp_connections");
    expect(all.rows).toHaveLength(5);
    const revoked = await client.query("select 1 from mcp_connections where revoked_at is not null");
    expect(revoked.rows).toHaveLength(1);
  });
});

describe("no_oauth_clients: tokens from Supabase's OAuth server reach nothing through the Data API", () => {
  it("lets the same user with a web session read and rename their workspace", async () => {
    await actAsAuthenticated(client, OWNER_A);
    const seen = await client.query<{ id: string }>("select id from workspaces");
    expect(seen.rows.map((r) => r.id)).toEqual([wsA]);
    const renamed = await client.query("update workspaces set name = 'Workspace A' where id = $1 returning id", [wsA]);
    expect(renamed.rows).toHaveLength(1);
    expect((await client.query("select 1 from subscriptions")).rows).toHaveLength(1);
    expect((await client.query("select 1 from recipes")).rows.length).toBeGreaterThan(0);
  });

  it("shows an OAuth token nothing from workspaces, subscriptions, recipes or any tenant table", async () => {
    await actAsJwt(client, oauthClaims(OWNER_A));
    for (const table of ["workspaces", "subscriptions", "recipes", "members", "credit_ledger", "mcp_connections", "api_keys", "channel_specs"]) {
      const rows = await client.query(`select 1 from ${table}`);
      expect(rows.rows, table).toHaveLength(0);
    }
  });

  it("lets an OAuth token change nothing", async () => {
    await actAsJwt(client, oauthClaims(OWNER_A));
    const renamed = await client.query("update workspaces set name = 'Taken' where id = $1 returning id", [wsA]);
    expect(renamed.rows).toHaveLength(0);
    await expect(
      client.query("insert into products (workspace_id, title, mode) values ($1, 'Lamp', 'listing')", [wsA]),
    ).rejects.toThrow(/row-level security/);
    await actAsSuperuser(client);
    const name = await client.query<{ name: string }>("select name from workspaces where id = $1", [wsA]);
    expect(name.rows[0]?.name).toBe("Workspace A");
  });

  it("treats a JSON null or a missing client_id as a web session", async () => {
    await actAsJwt(client, { sub: OWNER_A, role: "authenticated", aud: "authenticated", client_id: null });
    expect((await client.query("select 1 from workspaces")).rows).toHaveLength(1);
    await actAsJwt(client, { sub: OWNER_A, role: "authenticated", aud: "authenticated" });
    expect((await client.query("select 1 from workspaces")).rows).toHaveLength(1);
  });

  it("is on every public table with row level security, and every public table has row level security", async () => {
    const tables = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`,
    );
    expect(tables.rows.length).toBeGreaterThan(30);
    const policies = await client.query<{ tablename: string; permissive: string; roles: string[] | string; cmd: string; qual: string; with_check: string }>(
      `select tablename, permissive, roles, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and policyname = 'no_oauth_clients'`,
    );
    const byTable = new Map(policies.rows.map((row) => [row.tablename, row]));
    for (const table of tables.rows) {
      expect(table.relrowsecurity, `${table.relname} should have row level security`).toBe(true);
      const policy = byTable.get(table.relname);
      expect(policy, `${table.relname} lacks the no_oauth_clients policy`).toBeDefined();
      expect(policy!.permissive).toBe("RESTRICTIVE");
      expect(String(policy!.roles)).toMatch(/authenticated/);
      expect(String(policy!.roles)).not.toMatch(/anon|public/);
      expect(policy!.cmd).toBe("ALL");
      expect(policy!.qual).toMatch(/client_id/);
      expect(policy!.with_check).toMatch(/client_id/);
    }
  });
});

describe("curvi_access_token_hook (P19-04)", () => {
  async function hook(event: unknown): Promise<unknown> {
    const result = await client.query<{ out: unknown }>("select public.curvi_access_token_hook($1::jsonb) as out", [
      event === undefined ? null : JSON.stringify(event),
    ]);
    return result.rows[0]?.out ?? null;
  }

  const webClaims = {
    iss: "https://example.supabase.co/auth/v1",
    aud: "authenticated",
    exp: 1790000000,
    iat: 1789996400,
    sub: OWNER_A,
    email: "owner@example.com",
    phone: "",
    role: "authenticated",
    aal: "aal1",
    session_id: "22222222-3333-4444-8555-666666666666",
    is_anonymous: false,
  };

  it("leaves a web session's claims untouched, aud included", async () => {
    const event = { user_id: OWNER_A, claims: webClaims, authentication_method: "password" };
    expect(await hook(event)).toEqual(event);
  });

  it("sets aud to the MCP resource on a token whose claims carry client_id, and changes nothing else", async () => {
    const claims = { ...webClaims, client_id: CHATGPT, scope: "openid email" };
    const event = { user_id: OWNER_A, claims, authentication_method: "oauth_provider/authorization_code" };
    expect(await hook(event)).toEqual({ ...event, claims: { ...claims, aud: RESOURCE } });
    const arrayAud = { ...event, claims: { ...claims, aud: ["authenticated"] } };
    expect(await hook(arrayAud)).toEqual({ ...event, claims: { ...claims, aud: RESOURCE } });
    const noAud = { ...event, claims: { sub: OWNER_A, client_id: CHATGPT } };
    expect(await hook(noAud)).toEqual({ ...event, claims: { sub: OWNER_A, client_id: CHATGPT, aud: RESOURCE } });
  });

  it("never raises on missing or odd fields and returns them unchanged", async () => {
    const odd: unknown[] = [
      {},
      { claims: null },
      { claims: "text" },
      { claims: [1, 2] },
      { claims: {} },
      { claims: { client_id: null, aud: "authenticated" } },
      { claims: { client_id: 5, aud: "authenticated" } },
      { claims: { client_id: "", aud: "authenticated" } },
      { claims: { client_id: { id: CHATGPT }, aud: "authenticated" } },
      [],
      "text",
      42,
    ];
    for (const event of odd) {
      expect(await hook(event), JSON.stringify(event)).toEqual(event);
    }
    expect(await hook(undefined)).toBeNull();
  });

  it("is a plain stable SQL function that reads no table and runs with the caller's rights", async () => {
    const result = await client.query<{ lang: string; volatile: string; secdef: boolean; src: string }>(
      `select l.lanname as lang, p.provolatile as volatile, p.prosecdef as secdef, p.prosrc as src
       from pg_proc p join pg_language l on l.oid = p.prolang
       where p.proname = 'curvi_access_token_hook' and p.pronamespace = 'public'::regnamespace`,
    );
    const fn = result.rows[0]!;
    expect(fn.lang).toBe("sql");
    expect(fn.volatile).toBe("s");
    expect(fn.secdef).toBe(false);
    expect(fn.src).not.toMatch(/\bfrom\b/i);
  });

  it("may be executed by supabase_auth_admin only", async () => {
    const result = await client.query<{ role: string; allowed: boolean }>(
      `select r as role, has_function_privilege(r, 'public.curvi_access_token_hook(jsonb)', 'execute') as allowed
       from unnest(array['supabase_auth_admin', 'anon', 'authenticated', 'service_role']) as r`,
    );
    expect(Object.fromEntries(result.rows.map((row) => [row.role, row.allowed]))).toEqual({
      supabase_auth_admin: true,
      anon: false,
      authenticated: false,
      service_role: false,
    });
    const acl = await client.query<{ grantee: string }>(
      `select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee
       from pg_proc p, aclexplode(p.proacl) a
       where p.proname = 'curvi_access_token_hook' and a.privilege_type = 'EXECUTE' and a.grantee = 0`,
    );
    expect(acl.rows).toEqual([]);

    await client.exec("set role supabase_auth_admin");
    const out = await client.query<{ out: { claims: { aud: string } } }>(
      "select public.curvi_access_token_hook($1::jsonb) as out",
      [JSON.stringify({ claims: { client_id: CHATGPT, aud: "authenticated" } })],
    );
    expect(out.rows[0]?.out.claims.aud).toBe(RESOURCE);
    await actAsAuthenticated(client, OWNER_A);
    await expect(client.query("select public.curvi_access_token_hook('{}'::jsonb)")).rejects.toThrow(/permission denied/);
  });
});

// createTestDb grants every table to the client roles after the migrations
// ran, so the tests above prove RLS alone holds. Supabase instead grants new
// tables and functions through default privileges as they are created,
// before the migration's REVOKE runs. Replay that order (the 0027 test's
// pattern) to prove the revokes stick.
describe("0028 privileges under Supabase style default grants", () => {
  it("leave anon and authenticated only reading mcp_connections and unable to run the hook", async () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const fresh = new PGlite();
    try {
      await fresh.exec(`
        ${SUPABASE_AUTH_SHIM_SQL}
        create role anon;
        create role authenticated;
        create role service_role bypassrls;
        create role supabase_auth_admin;
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      `);
      for (const entry of readJournalEntries()) {
        await fresh.exec(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"));
      }
      const result = await fresh.query<{ role: string; can_select: boolean; can_write: boolean; can_hook: boolean }>(`
        select r.role,
          has_table_privilege(r.role, 'public.mcp_connections', 'select') as can_select,
          has_table_privilege(r.role, 'public.mcp_connections', 'insert')
            or has_table_privilege(r.role, 'public.mcp_connections', 'update')
            or has_table_privilege(r.role, 'public.mcp_connections', 'delete') as can_write,
          has_function_privilege(r.role, 'public.curvi_access_token_hook(jsonb)', 'execute') as can_hook
        from (values ('anon'), ('authenticated'), ('supabase_auth_admin')) as r(role)
        order by r.role
      `);
      expect(result.rows).toEqual([
        { role: "anon", can_select: true, can_write: false, can_hook: false },
        { role: "authenticated", can_select: true, can_write: false, can_hook: false },
        { role: "supabase_auth_admin", can_select: false, can_write: false, can_hook: true },
      ]);
    } finally {
      await fresh.close();
    }
  });
});

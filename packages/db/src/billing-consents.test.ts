import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  readJournalEntries,
} from "./test-helpers";

// billing_consents (migration billing_terms, docs/phases/PHASE_20.md
// P20-07): the renewal consent record. Owners and admins of the workspace
// read it; nobody writes it from a client (only the webhook on the owner
// connection); it outlives a deleted workspace (CLAUDE.md rule 5).

const WS_A = "00000000-0000-4000-8000-0000000029a1";
const WS_B = "00000000-0000-4000-8000-0000000029b1";
const OWNER = "00000000-0000-4000-8000-000000002901";
const ADMIN = "00000000-0000-4000-8000-000000002902";
const EDITOR = "00000000-0000-4000-8000-000000002903";
const CLIENT = "00000000-0000-4000-8000-000000002904";
const OUTSIDER = "00000000-0000-4000-8000-000000002905";

describe("billing_consents row level security", () => {
  let client: PGlite;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    await createAppUserRole(client);
    await client.query("insert into workspaces (id, name) values ($1, 'A'), ($2, 'B')", [WS_A, WS_B]);
    await client.query(
      `insert into members (workspace_id, user_id, role) values
         ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'editor'), ($1, $5, 'client'), ($6, $7, 'owner')`,
      [WS_A, OWNER, ADMIN, EDITOR, CLIENT, WS_B, OUTSIDER],
    );
    await client.query(
      `insert into billing_consents
         (workspace_id, user_id, email_key, checkout_session_id, tier, cadence, amount_usd, disclosure_version, disclosure_sha256, accepted_at)
       values
         ($1, $2, 'owner@example.com', 'cs_a', 'growth', 'annual', 792, '2026-10-02', 'hash_a', now()),
         ($3, $4, 'other@example.com', 'cs_b', 'starter', 'monthly', 29, '2026-10-02', 'hash_b', now())`,
      [WS_A, OWNER, WS_B, OUTSIDER],
    );
  });

  afterEach(async () => {
    await actAsSuperuser(client);
  });

  afterAll(async () => {
    await client.close();
  });

  async function visibleSessions(): Promise<string[]> {
    const rows = await client.query<{ checkout_session_id: string }>(
      "select checkout_session_id from billing_consents order by checkout_session_id",
    );
    return rows.rows.map((row) => row.checkout_session_id);
  }

  it("has row level security on", async () => {
    const rls = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'billing_consents'",
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
  });

  it("lets owners and admins read their own workspace's records only", async () => {
    for (const user of [OWNER, ADMIN]) {
      await actAs(client, user);
      expect(await visibleSessions()).toEqual(["cs_a"]);
    }
    await actAs(client, OUTSIDER);
    expect(await visibleSessions()).toEqual(["cs_b"]);
  });

  it("hides the records from editors, clients and anonymous visitors", async () => {
    for (const user of [EDITOR, CLIENT]) {
      await actAs(client, user);
      expect(await visibleSessions()).toEqual([]);
    }
    await actAsAnon(client);
    expect(await visibleSessions().catch(() => [])).toEqual([]);
  });

  it("refuses every client write, even from an owner", async () => {
    for (const become of [() => actAs(client, OWNER), () => actAsAuthenticated(client, OWNER), () => actAsAnon(client)]) {
      await become();
      await expect(
        client.query(
          `insert into billing_consents (workspace_id, checkout_session_id, tier, cadence, disclosure_version, disclosure_sha256, accepted_at)
           values ($1, 'cs_forged', 'pro', 'monthly', 'v', 'h', now())`,
          [WS_A],
        ),
      ).rejects.toThrow(/permission denied|row-level security/);
      const updated = await client
        .query("update billing_consents set disclosure_sha256 = 'changed'")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(updated).toBe(0);
      const deleted = await client
        .query("delete from billing_consents")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(deleted).toBe(0);
      await actAsSuperuser(client);
    }
    const rows = await client.query<{ disclosure_sha256: string }>("select disclosure_sha256 from billing_consents order by checkout_session_id");
    expect(rows.rows.map((row) => row.disclosure_sha256)).toEqual(["hash_a", "hash_b"]);
  });

  it("keeps one record per Checkout Session", async () => {
    await expect(
      client.query(
        `insert into billing_consents (workspace_id, checkout_session_id, tier, cadence, disclosure_version, disclosure_sha256, accepted_at)
         values ($1, 'cs_a', 'growth', 'annual', 'v', 'h', now())`,
        [WS_A],
      ),
    ).rejects.toThrow(/duplicate key|unique/);
  });

  it("keeps one record per portal session, and exactly one session id per record", async () => {
    await client.query(
      `insert into billing_consents (workspace_id, portal_session_id, tier, cadence, disclosure_version, disclosure_sha256, disclosure_text, accepted_at)
       values ($1, 'bps_a', 'pro', 'annual', 'v', 'h', 'The terms shown', now())`,
      [WS_A],
    );
    await expect(
      client.query(
        `insert into billing_consents (workspace_id, portal_session_id, tier, cadence, disclosure_version, disclosure_sha256, accepted_at)
         values ($1, 'bps_a', 'pro', 'annual', 'v', 'h', now())`,
        [WS_A],
      ),
    ).rejects.toThrow(/duplicate key|unique/);
    await expect(
      client.query(
        `insert into billing_consents (workspace_id, tier, cadence, disclosure_version, disclosure_sha256, accepted_at)
         values ($1, 'pro', 'annual', 'v', 'h', now())`,
        [WS_A],
      ),
    ).rejects.toThrow(/billing_consents_one_session|check constraint/);
    await expect(
      client.query(
        `insert into billing_consents (workspace_id, checkout_session_id, portal_session_id, tier, cadence, disclosure_version, disclosure_sha256, accepted_at)
         values ($1, 'cs_both', 'bps_both', 'pro', 'annual', 'v', 'h', now())`,
        [WS_A],
      ),
    ).rejects.toThrow(/billing_consents_one_session|check constraint/);
    await client.query("delete from billing_consents where portal_session_id = 'bps_a'");
  });

  it("outlives a deleted workspace, with the workspace cleared", async () => {
    await client.query("delete from workspaces where id = $1", [WS_B]);
    const rows = await client.query<{ workspace_id: string | null; tier: string }>(
      "select workspace_id, tier from billing_consents where checkout_session_id = 'cs_b'",
    );
    expect(rows.rows).toEqual([{ workspace_id: null, tier: "starter" }]);
  });
});

describe("billing_consents and no_oauth_clients", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create or replace function auth.jwt() returns jsonb
      language sql stable
      as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    `);
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    for (const entry of readJournalEntries()) {
      await db.exec(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it("carries the restrictive no_oauth_clients policy for authenticated", async () => {
    const policies = await db.query<{ policyname: string; permissive: string }>(
      "select policyname, permissive from pg_policies where tablename = 'billing_consents' and policyname = 'no_oauth_clients'",
    );
    expect(policies.rows).toEqual([{ policyname: "no_oauth_clients", permissive: "RESTRICTIVE" }]);
  });

  // Supabase grants new tables to the client roles through default
  // privileges before the migration's REVOKE runs (replayed above).
  // TRUNCATE ignores RLS, so the grants must go (security review 6).
  it("leaves anon and authenticated no write grant, so not even TRUNCATE reaches it", async () => {
    const privileges = await db.query<{ role: string; privilege: string; allowed: boolean }>(`
      select r.role, p.privilege, has_table_privilege(r.role, 'public.billing_consents', p.privilege) as allowed
      from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
      cross join (values ('insert'), ('update'), ('delete'), ('truncate')) as p(privilege)
    `);
    expect(privileges.rows).toHaveLength(12);
    for (const row of privileges.rows) {
      expect(row.allowed, `${row.role} ${row.privilege}`).toBe(row.role === "service_role");
    }
    // Reading stays with RLS, which lets owners and admins see their own.
    const read = await db.query<{ allowed: boolean }>(
      "select has_table_privilege('authenticated', 'public.billing_consents', 'select') as allowed",
    );
    expect(read.rows[0]?.allowed).toBe(true);
  });
});

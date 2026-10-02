import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsServiceRole,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  readJournalEntries,
  SUPABASE_AUTH_SHIM_SQL,
} from "./test-helpers";

// Migration ops_switches_and_audit (docs/phases/PHASE_20.md P20-20 and
// P20-66, "Data model summary"):
// - expand only: each stored switch row is copied to its ops: key once and
//   the old key stays, so the code before the deploy (and a rollback) keeps
//   reading what it read;
// - ops_audit is a platform table: RLS on, no client policies, nothing for
//   anon or authenticated, no_oauth_clients, and no foreign key, so a
//   deleted workspace keeps its audit trail (CLAUDE.md rule 5).

const MIGRATION = "_ops_switches_and_audit";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const USER = "00000000-0000-4000-8000-000000002801";
const WORKSPACE = "00000000-0000-4000-8000-0000000028aa";

function migrationSql(tag: string): string {
  return readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
}

/**
 * A fresh PGlite with the Supabase roles and auth functions, migrated in
 * journal order, with `beforeTarget` run just before this migration.
 * `defaultGrants` replays Supabase's default privileges, granted as each
 * table is created.
 */
async function migratedDb(options: {
  beforeTarget?: (db: PGlite) => Promise<void>;
  defaultGrants?: boolean;
}): Promise<PGlite> {
  const db = new PGlite();
  // auth.uid() and auth.jwt() (the shared shim): 0028_mcp_connections's
  // no_oauth_clients policy, which this migration adds too, reads auth.jwt().
  await db.exec(`
    ${SUPABASE_AUTH_SHIM_SQL}
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
  `);
  if (options.defaultGrants) {
    await db.exec(`
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    `);
  }
  const entries = readJournalEntries();
  expect(entries.filter((entry) => entry.tag.endsWith(MIGRATION))).toHaveLength(1);
  for (const entry of entries) {
    if (entry.tag.endsWith(MIGRATION)) {
      await options.beforeTarget?.(db);
    }
    await db.exec(migrationSql(entry.tag));
  }
  return db;
}

async function settings(db: PGlite): Promise<Map<string, unknown>> {
  const result = await db.query<{ key: string; value: unknown }>("select key, value from platform_settings");
  return new Map(result.rows.map((row) => [row.key, row.value]));
}

describe("ops_switches_and_audit, the switch copy (expand only)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await migratedDb({
      beforeTarget: async (before) => {
        // Production as the founder left it: output options switched off,
        // acquisition paused (a PHASE_18 switch), an ops: row an operator
        // already wrote, a value of the wrong shape, and a plain setting.
        await before.query(
          `insert into platform_settings (key, value) values
             ('free_signup_credits', '5'::jsonb),
             ('output_options_enabled', 'false'::jsonb),
             ('acquisition_paused', 'true'::jsonb),
             ('referrals_enabled', 'false'::jsonb),
             ('ops:referrals_enabled', 'true'::jsonb),
             ('lifecycle_email_enabled', '"yes"'::jsonb),
             ('founding_offer_enabled', 'true'::jsonb),
             ('store_audit_enabled', 'true'::jsonb)`,
        );
      },
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it("copies each stored switch to its ops: key and keeps the old key", async () => {
    const rows = await settings(db);
    expect(rows.get("output_options_enabled")).toBe(false);
    expect(rows.get("ops:output_options_enabled")).toBe(false);
    expect(rows.get("acquisition_paused")).toBe(true);
    expect(rows.get("ops:acquisition_paused")).toBe(true);
    expect(rows.get("founding_offer_enabled")).toBe(true);
    expect(rows.get("ops:founding_offer_enabled")).toBe(true);
  });

  it("never overwrites an ops: row that is already there", async () => {
    const rows = await settings(db);
    expect(rows.get("referrals_enabled")).toBe(false);
    expect(rows.get("ops:referrals_enabled")).toBe(true);
  });

  it("copies the value as stored, so a value today's reader treats as off stays off", async () => {
    expect((await settings(db)).get("ops:lifecycle_email_enabled")).toBe("yes");
  });

  it("copies nothing for a switch with no row, a plain setting or the seeded store audit gate", async () => {
    const rows = await settings(db);
    expect(rows.has("ops:free_preview_enabled")).toBe(false);
    expect(rows.has("ops:deploy_restarts_enabled")).toBe(false);
    expect(rows.has("ops:free_signup_credits")).toBe(false);
    expect(rows.has("ops:store_audit_enabled")).toBe(false);
    expect(rows.get("free_signup_credits")).toBe(5);
    expect([...rows.keys()].filter((key) => key.startsWith("ops:")).sort()).toEqual([
      "ops:acquisition_paused",
      "ops:founding_offer_enabled",
      "ops:lifecycle_email_enabled",
      "ops:output_options_enabled",
      "ops:referrals_enabled",
    ]);
  });

  it("leaves today's reader reading the old key, so the code before the deploy and a rollback behave as before", async () => {
    // outputOptionsSwitchOn (apps/web/src/lib/features.ts) before P20-20:
    // this select, and only a stored true turns options on.
    const result = await db.query<{ value: unknown }>(
      "select value from platform_settings where key = 'output_options_enabled' limit 1",
    );
    expect(result.rows[0]?.value === true).toBe(false);
    expect(result.rows).toEqual([{ value: false }]);
  });

  it("only inserts into platform_settings: no delete, update, drop or rename", () => {
    const tag = readJournalEntries().find((entry) => entry.tag.endsWith(MIGRATION))!.tag;
    const statements = migrationSql(tag)
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\b(delete\s+from|update\s+"?platform_settings|drop\s+(table|column)|rename|alter\s+column)\b/i);
    expect(statements).toMatch(/insert into "platform_settings"[\s\S]*on conflict \("key"\) do nothing/i);
  });
});

describe("ops_audit (platform table)", () => {
  let client: PGlite;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    await createAppUserRole(client);
    await client.query("insert into workspaces (id, name) values ($1, 'Audited')", [WORKSPACE]);
    await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [WORKSPACE, USER]);
    await client.query(
      `insert into ops_audit (operator_email, action, target_kind, target_id, workspace_id, detail)
       values ('founder@curvi.ai', 'credits.grant', 'workspace', $1, $2::uuid, '{"credits": 300}'::jsonb)`,
      [WORKSPACE, WORKSPACE],
    );
  });

  afterEach(async () => {
    await actAsSuperuser(client);
  });

  afterAll(async () => {
    await client.close();
  });

  it("has row level security on and no permissive policy", async () => {
    const rls = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'ops_audit'",
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const policies = await client.query<{ policyname: string; permissive: string }>(
      "select policyname, permissive from pg_policies where tablename = 'ops_audit'",
    );
    expect(policies.rows.filter((row) => row.permissive === "PERMISSIVE")).toEqual([]);
  });

  it("has no foreign key, so a workspace delete keeps its trail", async () => {
    const fks = await client.query("select conname from pg_constraint where conrelid = 'ops_audit'::regclass and contype = 'f'");
    expect(fks.rows).toEqual([]);
    await client.query("delete from workspaces where id = $1", [WORKSPACE]);
    const rows = await client.query<{ workspace_id: string }>("select workspace_id from ops_audit");
    expect(rows.rows).toEqual([{ workspace_id: WORKSPACE }]);
  });

  const clientRoles = [
    ["anon", () => actAsAnon(client)],
    ["authenticated", () => actAsAuthenticated(client, USER)],
    ["app member", () => actAs(client, USER)],
  ] as const;

  for (const [name, become] of clientRoles) {
    it(`is invisible and unwritable to ${name}`, async () => {
      await become();
      const visible = await client
        .query("select * from ops_audit")
        .then((r) => r.rows.length)
        .catch(() => 0);
      expect(visible, `${name} read ops_audit`).toBe(0);
      await expect(
        client.query(
          "insert into ops_audit (operator_email, action, target_kind, target_id) values ('me@example.com', 'credits.grant', 'workspace', 'x')",
        ),
      ).rejects.toThrow(/permission denied|row-level security/);
      const updated = await client
        .query("update ops_audit set forced = true")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(updated).toBe(0);
      const deleted = await client
        .query("delete from ops_audit")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(deleted).toBe(0);

      await actAsSuperuser(client);
      const rows = await client.query<{ forced: boolean }>("select forced from ops_audit");
      expect(rows.rows).toEqual([{ forced: false }]);
    });
  }

  it("lets the service role read and write it", async () => {
    await actAsServiceRole(client);
    await client.query(
      "insert into ops_audit (operator_email, action, target_kind, target_id) values ('ops@curvi.ai', 'switch.set', 'platform_setting', 'ops:packs_paused')",
    );
    const rows = await client.query("select id from ops_audit");
    expect(rows.rows).toHaveLength(2);
    await client.query("delete from ops_audit where action = 'switch.set'");
  });

  it("refuses an empty action or an oversized target", async () => {
    await expect(
      client.query("insert into ops_audit (operator_email, action, target_kind) values ('ops@curvi.ai', '', 'workspace')"),
    ).rejects.toThrow(/ops_audit_lengths_check/);
    await expect(
      client.query("insert into ops_audit (operator_email, action, target_kind, target_id) values ('ops@curvi.ai', 'x.y', 'workspace', $1)", [
        "t".repeat(201),
      ]),
    ).rejects.toThrow(/ops_audit_lengths_check/);
  });
});

// Supabase grants new tables through default privileges as they are
// created, before the migration's REVOKE runs; the tests above use grants
// made after the migrations. Replay Supabase's order to prove the REVOKE
// sticks; the shared shim's auth.jwt() lets the restrictive
// no_oauth_clients policy be created.
describe("ops_audit on a Supabase shaped database", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await migratedDb({ defaultGrants: true });
  });

  afterAll(async () => {
    await db.close();
  });

  it("leaves anon and authenticated with no privilege on the table or its sequence", async () => {
    const privileges = await db.query<{ role: string; object: string; allowed: boolean }>(`
      select r.role, o.object,
        case when o.object like '%_seq'
          then has_sequence_privilege(r.role, o.object, 'usage')
          else has_table_privilege(r.role, o.object, 'select')
            or has_table_privilege(r.role, o.object, 'insert')
            or has_table_privilege(r.role, o.object, 'update')
            or has_table_privilege(r.role, o.object, 'delete')
        end as allowed
      from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
      cross join (values ('public.ops_audit'), ('public.ops_audit_id_seq')) as o(object)
    `);
    expect(privileges.rows).toHaveLength(6);
    for (const row of privileges.rows) {
      expect(row.allowed, `${row.role} on ${row.object}`).toBe(row.role === "service_role");
    }
  });

  it("carries the restrictive no_oauth_clients policy for authenticated", async () => {
    const policies = await db.query<{ policyname: string; permissive: string; roles: string[] | string }>(
      "select policyname, permissive, roles from pg_policies where tablename = 'ops_audit'",
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({ policyname: "no_oauth_clients", permissive: "RESTRICTIVE" });
    expect(String(policies.rows[0]!.roles)).toContain("authenticated");
  });
});

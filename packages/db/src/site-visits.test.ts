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
} from "./test-helpers";

// Migration 0027: site_visits and site_visit_salts are platform tables for
// the cookieless visitor count. Only the owner connection and the service
// role may read or write them; anon and signed in users see nothing and
// write nothing (CLAUDE.md rule 5: a test for each new table).

const USER = "00000000-0000-4000-8000-000000002701";
const HASH = "0123456789abcdef0123456789abcdef";
const SALT = "ab".repeat(32);

let client: PGlite;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  await createAppUserRole(client);
  await client.query("insert into site_visit_salts (day, salt) values ('2026-10-01', $1)", [SALT]);
  await client.query(
    `insert into site_visits (day, visitor_hash, path, referrer_host, utm_source, device)
     values ('2026-10-01', $1, '/', 'news.ycombinator.com', 'newsletter', 'desktop'),
            ('2026-10-01', $1, '/pricing', null, null, 'desktop')`,
    [HASH],
  );
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

const CLIENT_ROLES = [
  ["anon", () => actAsAnon(client)],
  ["authenticated", () => actAsAuthenticated(client, USER)],
  ["app member", () => actAs(client, USER)],
] as const;

describe("site_visits and site_visit_salts (0027)", () => {
  it("have row level security on", async () => {
    const result = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('site_visits', 'site_visit_salts') order by relname",
    );
    expect(result.rows).toEqual([
      { relname: "site_visit_salts", relrowsecurity: true },
      { relname: "site_visits", relrowsecurity: true },
    ]);
  });

  it("have no column that could hold an IP address or a user agent", async () => {
    const result = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('site_visits', 'site_visit_salts')`,
    );
    const columns = result.rows.map((r) => r.column_name);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column).not.toMatch(/ip|agent|ua$|address|country|city/);
    }
  });

  it("keep only the UTC day, no time of day, so rows cannot be lined up by time with other records", async () => {
    const result = await client.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name in ('site_visits', 'site_visit_salts')
       order by table_name, ordinal_position`,
    );
    const timed = result.rows.filter((r) => /time|interval/.test(r.data_type) || /_at$/.test(r.column_name));
    expect(timed).toEqual([]);
    expect(result.rows.filter((r) => r.column_name === "day").map((r) => r.data_type)).toEqual(["date", "date"]);
  });

  for (const [name, become] of CLIENT_ROLES) {
    it(`are invisible and unwritable to ${name}`, async () => {
      await become();
      for (const table of ["site_visits", "site_visit_salts", "site_visits_daily"]) {
        // Either the revoke or RLS with no policies stops it; both are fine.
        const visible = await client
          .query(`select * from ${table}`)
          .then((r) => r.rows.length)
          .catch(() => 0);
        expect(visible, `${name} read ${table}`).toBe(0);
      }
      await expect(
        client.query(
          "insert into site_visits (day, visitor_hash, path, device) values ('2026-10-01', $1, '/forged', 'desktop')",
          [HASH],
        ),
      ).rejects.toThrow(/permission denied|row-level security/);
      await expect(
        client.query("insert into site_visit_salts (day, salt) values ('2026-10-02', $1)", [SALT]),
      ).rejects.toThrow(/permission denied|row-level security/);
      const update = await client
        .query("update site_visit_salts set salt = $1", ["cd".repeat(32)])
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(update).toBe(0);
      const del = await client
        .query("delete from site_visits")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(del).toBe(0);

      await actAsSuperuser(client);
      const salts = await client.query<{ salt: string }>("select salt from site_visit_salts");
      expect(salts.rows).toEqual([{ salt: SALT }]);
      const visits = await client.query("select id from site_visits");
      expect(visits.rows).toHaveLength(2);
    });
  }

  it("let the service role read and write both tables and the daily view", async () => {
    await actAsServiceRole(client);
    await client.query("insert into site_visit_salts (day, salt) values ('2026-10-02', $1)", ["cd".repeat(32)]);
    await client.query(
      "insert into site_visits (day, visitor_hash, path, device) values ('2026-10-02', $1, '/help', 'mobile')",
      [HASH],
    );
    const salts = await client.query("select day from site_visit_salts");
    expect(salts.rows).toHaveLength(2);
    const daily = await client.query<{ day: string | Date; visitors: number; page_views: number }>(
      "select day::text as day, visitors, page_views from site_visits_daily order by day",
    );
    expect(daily.rows).toEqual([
      { day: "2026-10-01", visitors: 1, page_views: 2 },
      { day: "2026-10-02", visitors: 1, page_views: 1 },
    ]);
    await client.query("delete from site_visit_salts where day = '2026-10-02'");
    await client.query("delete from site_visits where day = '2026-10-02'");
  });

  it("refuse a visitor hash that is not 32 hex characters, so a raw IP can never land in it", async () => {
    await expect(
      client.query(
        "insert into site_visits (day, visitor_hash, path, device) values ('2026-10-01', '203.0.113.7', '/', 'desktop')",
      ),
    ).rejects.toThrow(/site_visits_visitor_hash_check/);
    await expect(
      client.query("insert into site_visit_salts (day, salt) values ('2026-10-03', 'short')"),
    ).rejects.toThrow(/site_visit_salts_salt_check/);
    await expect(
      client.query(
        "insert into site_visits (day, visitor_hash, path, device) values ('2026-10-01', $1, '/', 'watch')",
        [HASH],
      ),
    ).rejects.toThrow(/site_visits_device_check/);
    await expect(
      client.query(
        "insert into site_visits (day, visitor_hash, path, device) values ('2026-10-01', $1, $2, 'desktop')",
        [HASH, `/${"a".repeat(400)}`],
      ),
    ).rejects.toThrow(/site_visits_lengths_check/);
  });
});

// createTestDb grants every table to the client roles after the migrations
// ran, so the tests above prove RLS alone holds. Supabase instead grants new
// tables through default privileges as they are created, before the
// migration's REVOKE runs. Replay that order to prove the REVOKE sticks.
describe("0027 privileges under Supabase style default grants", () => {
  it("leave anon and authenticated with no privilege on the tables, the view and the sequence", async () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const fresh = new PGlite();
    try {
      await fresh.exec(`
        create schema if not exists auth;
        create or replace function auth.uid() returns uuid
        language sql stable
        as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create role anon;
        create role authenticated;
        create role service_role bypassrls;
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      `);
      for (const entry of readJournalEntries()) {
        await fresh.exec(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"));
      }
      const privileges = await fresh.query<{ role: string; object: string; allowed: boolean }>(`
        select r.role, o.object,
          case when o.object like '%_seq'
            then has_sequence_privilege(r.role, o.object, 'usage')
            else has_table_privilege(r.role, o.object, 'select')
              or has_table_privilege(r.role, o.object, 'insert')
              or has_table_privilege(r.role, o.object, 'update')
              or has_table_privilege(r.role, o.object, 'delete')
          end as allowed
        from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
        cross join (values ('public.site_visits'), ('public.site_visit_salts'), ('public.site_visits_daily'), ('public.site_visits_id_seq')) as o(object)
      `);
      for (const row of privileges.rows) {
        expect(row.allowed, `${row.role} on ${row.object}`).toBe(row.role === "service_role");
      }
    } finally {
      await fresh.close();
    }
  });
});

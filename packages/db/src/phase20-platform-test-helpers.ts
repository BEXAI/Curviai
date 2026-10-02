import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { readJournalEntries, SUPABASE_AUTH_SHIM_SQL } from "./test-helpers";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Preserve Supabase default grants, allowing tests to verify the migration's
 * REVOKEs rather than the blanket grants createTestDb installs afterwards. */
export async function createPhase20MigrationDb(before?: (client: PGlite, tag: string) => Promise<void>): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(`
    ${SUPABASE_AUTH_SHIM_SQL}
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, created_at timestamptz not null default now());
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create role supabase_auth_admin;
    grant usage on schema public, auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  for (const { tag } of readJournalEntries()) {
    await before?.(client, tag);
    await client.exec(readFileSync(join(migrationsDir, `${tag}.sql`), "utf8"));
  }
  return client;
}

export async function platformPrivileges(client: PGlite, table: string): Promise<unknown[]> {
  const result = await client.query<{ grantee: string; privilege_type: string }>(
    "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated')",
    [table],
  );
  return result.rows;
}

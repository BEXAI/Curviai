import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

interface JournalEntry {
  idx: number;
  tag: string;
}

export function readJournalEntries(): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

/** The auth schema with the auth.uid() and auth.jwt() shims, for every
 * PGlite database the tests build (migrations reference both). */
export const SUPABASE_AUTH_SHIM_SQL = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create or replace function auth.jwt() returns jsonb
  language sql
  stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;
`;

/**
 * Boot an in memory PGlite database, install the Supabase auth shims
 * (auth.uid() and auth.jwt()) and the Supabase roles (anon, authenticated,
 * service_role and supabase_auth_admin as plain non superuser roles;
 * service_role additionally gets BYPASSRLS like on Supabase), then apply
 * every migration in journal order. Mirrors what drizzle-kit migrate would run.
 * The roles exist before migrations run so conditional grant/revoke blocks in
 * migrations take the same branch they take in production. After migrations the
 * roles receive Supabase-style blanket table grants, which is exactly the
 * exposure the RLS policies must defend against.
 *
 * The auth.jwt() shim returns the claims from the request.jwt.claim or
 * request.jwt.claims setting (PostgREST sets the latter), so a test sets
 * request.jwt.claims to act with a whole token, such as an OAuth token that
 * carries client_id (PHASE_19 P19-05, the no_oauth_clients policy).
 */
export async function createTestDb(): Promise<{ client: PGlite; db: TestDb }> {
  const client = new PGlite();
  await client.exec(`
    ${SUPABASE_AUTH_SHIM_SQL}
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create role supabase_auth_admin;
  `);
  for (const entry of readJournalEntries()) {
    const sqlText = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    await client.exec(sqlText);
  }
  await client.exec(`
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant select, insert, update, delete on all tables in schema public
      to anon, authenticated, service_role;
    grant usage, select on all sequences in schema public
      to anon, authenticated, service_role;
  `);
  const db = drizzle(client, { schema });
  return { client, db };
}

/**
 * PGlite connects as a superuser, and superusers bypass row level security.
 * Create a plain role with only the grants an application user would have,
 * so SET ROLE app_user exercises the real RLS policies.
 */
export async function createAppUserRole(client: PGlite): Promise<void> {
  await client.exec(`
    create role app_user;
    grant usage on schema public to app_user;
    grant select, insert, update, delete on all tables in schema public to app_user;
    grant usage, select on all sequences in schema public to app_user;
    grant usage on schema auth to app_user;
  `);
}

export async function actAs(client: PGlite, userId: string): Promise<void> {
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("select set_config('request.jwt.claims', '', false)");
  await client.exec("set role app_user");
}

/** Act as a signed-in Supabase user through the authenticated role. */
export async function actAsAuthenticated(client: PGlite, userId: string): Promise<void> {
  await client.exec("reset role");
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("select set_config('request.jwt.claims', '', false)");
  await client.exec("set role authenticated");
}

/**
 * Act through the authenticated role with a whole set of JWT claims, as
 * PostgREST does: auth.uid() reads sub, auth.jwt() the claims. A token from
 * Supabase's OAuth server carries client_id (PHASE_19 P19-05).
 */
export async function actAsJwt(client: PGlite, claims: Record<string, unknown> & { sub: string }): Promise<void> {
  await client.exec("reset role");
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [claims.sub]);
  await client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  await client.exec("set role authenticated");
}

/** Act as an anonymous visitor holding only the anon key. */
export async function actAsAnon(client: PGlite): Promise<void> {
  await client.exec("reset role");
  await client.query("select set_config('request.jwt.claim.sub', '', false)");
  await client.query("select set_config('request.jwt.claims', '', false)");
  await client.exec("set role anon");
}

/** Act as the backend service role (BYPASSRLS, like Supabase's service_role). */
export async function actAsServiceRole(client: PGlite): Promise<void> {
  await client.exec("reset role");
  await client.query("select set_config('request.jwt.claim.sub', '', false)");
  await client.query("select set_config('request.jwt.claims', '', false)");
  await client.exec("set role service_role");
}

export async function actAsSuperuser(client: PGlite): Promise<void> {
  await client.exec("reset role");
  await client.query("select set_config('request.jwt.claim.sub', '', false)");
  await client.query("select set_config('request.jwt.claims', '', false)");
}

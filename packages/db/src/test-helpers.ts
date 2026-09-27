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

/**
 * Boot an in memory PGlite database, install the Supabase auth shim, then apply
 * every migration in journal order. Mirrors what drizzle-kit migrate would run.
 */
export async function createTestDb(): Promise<{ client: PGlite; db: TestDb }> {
  const client = new PGlite();
  await client.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid
    language sql
    stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  for (const entry of readJournalEntries()) {
    const sqlText = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    await client.exec(sqlText);
  }
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
  await client.exec("set role app_user");
}

export async function actAsSuperuser(client: PGlite): Promise<void> {
  await client.exec("reset role");
  await client.query("select set_config('request.jwt.claim.sub', '', false)");
}

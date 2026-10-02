/**
 * A throwaway database on a real Postgres server for the race suites
 * (docs/phases/PHASE_20.md P20-03): packages/db's ledger-race.pg.test.ts and
 * apps/web's billing store race suite. The PGlite suites run on one
 * connection, so they cannot show what two connections racing for the same
 * workspace do.
 *
 * Needs TEST_DATABASE_URL pointing at a server whose user may create
 * databases (CI's Postgres 17 service container, or a local server). The
 * database gets the same Supabase shim as createTestDb and every migration
 * in journal order; drop() removes it.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { readJournalEntries } from "./test-helpers";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const SHIM = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create or replace function auth.jwt() returns jsonb language sql stable
    as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
  end $$;
`;

export interface RaceDatabase {
  /** The new database's connection string. */
  url: string;
  /** A pool of `max` connections to it, so parallel calls race. */
  sql: postgres.Sql;
  /** Ends the pool and drops the database. */
  drop(): Promise<void>;
}

export async function createRaceDatabase(serverUrl: string, max: number): Promise<RaceDatabase> {
  const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
  const name = `curvi_race_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await admin.unsafe(`create database ${name}`);
  const target = new URL(serverUrl);
  target.pathname = `/${name}`;
  const sql = postgres(target.toString(), { max, onnotice: () => undefined });
  await sql.unsafe(SHIM);
  for (const entry of readJournalEntries()) {
    await sql.unsafe(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"));
  }
  return {
    url: target.toString(),
    sql,
    async drop() {
      await sql.end();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

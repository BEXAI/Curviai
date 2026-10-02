import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRaceDatabase, type RaceDatabase } from "./race-db";

// docs/phases/PHASE_20.md P20-03: ledger races on a real Postgres. The
// PGlite suites run on one connection, so they cannot show what two
// connections racing for the same workspace do. These cases do, with each
// call on its own pooled connection. The ledger functions are SQL, so they
// are called here; the billing store's grant and clawback races run through
// DbBillingStore itself in apps/web/src/lib/billing/ledger-race.pg.test.ts
// (law and copy review 17).
//
// Runs only when TEST_DATABASE_URL points at a Postgres server whose user
// may create databases (CI's Postgres 17 service container, or a local
// server). Each run creates its own database (race-db.ts), applies every
// migration in journal order, and drops the database at the end. Without
// TEST_DATABASE_URL it is skipped.

const url = process.env.TEST_DATABASE_URL;

/** Parallel calls each get their own connection. */
const PARALLEL = 20;

describe.skipIf(!url)("ledger races on real Postgres (TEST_DATABASE_URL)", () => {
  let race: RaceDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    race = await createRaceDatabase(url!, PARALLEL + 5);
    sql = race.sql;
  }, 120_000);

  afterAll(async () => {
    await race?.drop();
  });

  async function workspaceWith(credits: number): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into workspaces (name) values (${`race ${randomUUID()}`}) returning id`;
    if (credits > 0) {
      await sql`insert into credit_ledger (workspace_id, delta, reason, source) values (${row.id}, ${credits}, 'grant', 'test')`;
    }
    return row.id;
  }

  async function balanceOf(workspaceId: string): Promise<number> {
    const [row] = await sql<{ balance: string }[]>`select coalesce(sum(delta), 0)::text as balance from credit_ledger where workspace_id = ${workspaceId}`;
    return Number(row.balance);
  }

  async function jobFor(workspaceId: string): Promise<string> {
    const [product] = await sql<{ id: string }[]>`insert into products (workspace_id, title, mode) values (${workspaceId}, 'Race product', 'listing') returning id`;
    const [job] = await sql<{ id: string }[]>`insert into generation_jobs (workspace_id, product_id) values (${workspaceId}, ${product.id}) returning id`;
    return job.id;
  }

  it(`${PARALLEL} parallel reserves against a balance that covers 10: exactly 10 succeed, never below zero`, async () => {
    const ws = await workspaceWith(10);
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () => sql`select reserve_credits(${ws}::uuid, 1, null) as left`),
    );
    const ok = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(10);
    expect(refused).toHaveLength(PARALLEL - 10);
    for (const result of refused) {
      expect((result.reason as { code?: string }).code).toBe("CU402");
    }
    expect(await balanceOf(ws)).toBe(0);
  });

  it("parallel charges of the same job and step charge once", async () => {
    const ws = await workspaceWith(10);
    const job = await jobFor(ws);
    await sql`select reserve_credits(${ws}::uuid, 10, ${job}::uuid)`;
    await Promise.all(
      Array.from({ length: PARALLEL }, () => sql`select charge_credits(${ws}::uuid, 2, ${job}::uuid, 'shot_01')`),
    );
    const charges = await sql`select 1 from credit_ledger where job_id = ${job} and reason = 'charge'`;
    expect(charges).toHaveLength(1);
    const [row] = await sql<{ charged: string }[]>`select credits_charged::text as charged from generation_jobs where id = ${job}`;
    expect(Number(row.charged)).toBe(2);
    expect(await balanceOf(ws)).toBe(0);
  });
});

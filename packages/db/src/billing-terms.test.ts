import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actAs,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  readJournalEntries,
  SUPABASE_AUTH_SHIM_SQL,
} from "./test-helpers";

// Migration billing_terms (docs/phases/PHASE_20.md P20-05 and P20-07, "Data
// model summary"). P20-05: credits never expire, so the top up expiry the old
// code wrote is cleared and no ledger row stores one.

const MIGRATION = "_billing_terms";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const WORKSPACE = "00000000-0000-4000-8000-0000000029aa";

function migrationSql(tag: string): string {
  return readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
}

/** A fresh PGlite with the Supabase roles, migrated in journal order, with
 * `beforeTarget` run just before this migration. */
async function migratedDb(beforeTarget: (db: PGlite) => Promise<void>): Promise<PGlite> {
  const db = new PGlite();
  // auth.uid() and auth.jwt() (the shared shim): 0028_mcp_connections's
  // no_oauth_clients policy, which this migration adds too, reads auth.jwt().
  await db.exec(`
    ${SUPABASE_AUTH_SHIM_SQL}
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
  `);
  const entries = readJournalEntries();
  expect(entries.filter((entry) => entry.tag.endsWith(MIGRATION))).toHaveLength(1);
  for (const entry of entries) {
    if (entry.tag.endsWith(MIGRATION)) {
      await beforeTarget(db);
    }
    await db.exec(migrationSql(entry.tag));
  }
  return db;
}

describe("billing_terms: no credit expiry (P20-05)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await migratedDb(async (before) => {
      // Production before the deploy: two top ups with the old 12 month
      // expiry, a plan grant and a charge with none.
      await before.query("insert into workspaces (id, name) values ($1, 'Billing terms')", [WORKSPACE]);
      await before.query(
        `insert into credit_ledger (workspace_id, delta, reason, source, expires_at) values
           ($1, 100, 'topup', 'stripe', now() + interval '360 days'),
           ($1, 500, 'topup', 'stripe', now() + interval '200 days'),
           ($1, 600, 'grant', 'stripe', null),
           ($1, -3, 'charge', null, null)`,
        [WORKSPACE],
      );
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it("clears the expiry on every top up row", async () => {
    const rows = await db.query<{ reason: string; expires_at: string | null }>(
      "select reason, expires_at from credit_ledger where reason = 'topup'",
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.expires_at === null)).toBe(true);
  });

  it("leaves no ledger row with an expiry and changes no amount", async () => {
    const rows = await db.query<{ with_expiry: number; balance: string }>(
      "select count(*) filter (where expires_at is not null)::int as with_expiry, sum(delta)::text as balance from credit_ledger",
    );
    expect(rows.rows).toEqual([{ with_expiry: 0, balance: "1197.0" }]);
  });
});

describe("billing_terms: the released schedule on a cancel flow record (P20-06)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await migratedDb(async () => undefined);
  });

  afterAll(async () => {
    await db.close();
  });

  it("adds a nullable cancel_flows.released_schedule_id", async () => {
    const columns = await db.query<{ data_type: string; is_nullable: string }>(
      "select data_type, is_nullable from information_schema.columns where table_name = 'cancel_flows' and column_name = 'released_schedule_id'",
    );
    expect(columns.rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);
  });
});

describe("billing_terms: subscriptions.cadence (P20-07)", () => {
  const WS = "00000000-0000-4000-8000-0000000029c1";
  const MEMBER = "00000000-0000-4000-8000-0000000029c2";
  let client: PGlite;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    await createAppUserRole(client);
    await client.query("insert into workspaces (id, name) values ($1, 'Cadence')", [WS]);
    await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'editor')", [WS, MEMBER]);
    await client.query(
      "insert into subscriptions (workspace_id, provider, external_id, tier, status, cadence) values ($1, 'stripe', 'sub_c', 'growth', 'active', 'annual')",
      [WS],
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it("lets members read the cadence and never write it", async () => {
    await actAs(client, MEMBER);
    const rows = await client.query<{ cadence: string }>("select cadence from subscriptions");
    expect(rows.rows).toEqual([{ cadence: "annual" }]);
    const updated = await client
      .query("update subscriptions set cadence = 'monthly'")
      .then((r) => r.affectedRows ?? 0)
      .catch(() => 0);
    expect(updated).toBe(0);
    await actAsSuperuser(client);
    const after = await client.query<{ cadence: string }>("select cadence from subscriptions");
    expect(after.rows).toEqual([{ cadence: "annual" }]);
  });

  it("lets a cancel flow record have no reason (P20-07, Minnesota)", async () => {
    await client.query(
      "insert into cancel_flows (workspace_id, reason, outcome) values ($1, null, 'canceled')",
      [WS],
    );
    const rows = await client.query<{ reason: string | null }>("select reason from cancel_flows");
    expect(rows.rows).toEqual([{ reason: null }]);
  });
});

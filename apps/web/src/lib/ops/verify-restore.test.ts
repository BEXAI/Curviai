import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@curvi/db/testing";

// docs/phases/PHASE_20.md P20-11: ops/cron/verify-restore.sql on a PGlite
// database built from every migration, standing in for the drill database
// after pnpm db:migrate and the data load. PGlite has no auth.users and no
// drizzle bookkeeping, so the test creates small stand ins for both.

const VERIFY_SQL = readFileSync(fileURLToPath(new URL("../../../../../ops/cron/verify-restore.sql", import.meta.url)), "utf8");

type Client = Awaited<ReturnType<typeof createTestDb>>["client"];

interface CheckRow {
  check_name: string;
  ok: boolean;
  detail: string;
}

const WS_A = "00000000-0000-4000-8000-00000000000a";
const WS_B = "00000000-0000-4000-8000-00000000000b";
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b1";
const LATEST = "1790000000000";
const COUNTED = ["public.workspaces", "public.members", "public.products", "public.generation_jobs", "public.credit_ledger", "auth.users"];

async function checks(client: Client): Promise<Record<string, CheckRow>> {
  const rows = (await client.query<CheckRow>("select * from drill_check.verify()")).rows;
  return Object.fromEntries(rows.map((row) => [row.check_name, row]));
}

async function failing(client: Client): Promise<string[]> {
  return Object.values(await checks(client))
    .filter((row) => !row.ok)
    .map((row) => row.check_name);
}

/** Writes the manifest the drill would load: the counts and totals as they are now. */
async function loadManifest(client: Client, overrides: { counts?: Record<string, number>; ledgerTenths?: number; latest?: string | null } = {}) {
  await client.exec("delete from drill_check.manifest_counts; delete from drill_check.expected;");
  for (const table of COUNTED) {
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    await client.query("insert into drill_check.manifest_counts (table_name, expected) values ($1, $2)", [
      table,
      overrides.counts?.[table] ?? rows[0].n,
    ]);
  }
  await client.query("insert into drill_check.manifest_counts values ('drizzle.__drizzle_migrations', 99)");
  const { rows } = await client.query<{ tenths: string }>("select (coalesce(sum(delta), 0) * 10)::text as tenths from credit_ledger");
  await client.query("insert into drill_check.expected (key, value) values ('ledger_total_tenths', $1), ('latest_migration', $2)", [
    String(overrides.ledgerTenths ?? Number(rows[0].tenths)),
    overrides.latest === undefined ? LATEST : overrides.latest,
  ]);
}

describe("ops/cron/verify-restore.sql", () => {
  let client: Client;
  let liveJobs: number;

  beforeAll(async () => {
    ({ client } = await createTestDb());
    // Stand ins for what Supabase Auth and drizzle-kit migrate create.
    await client.exec(`
      create table auth.users (id uuid primary key, email text);
      create schema drizzle;
      create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
      insert into drizzle.__drizzle_migrations (hash, created_at) values ('a', 1780000000000), ('b', ${LATEST});
    `);

    // The drill loads the checks right after the migrate and takes the
    // grants baseline before any data arrives.
    await client.exec(VERIFY_SQL);
    const baseline = await client.query<{ n: number }>("select drill_check.snapshot_acl_baseline() as n");
    expect(baseline.rows[0].n).toBeGreaterThan(50);

    // The restored data.
    await client.query("insert into auth.users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')", [USER_A, USER_B]);
    await client.query("insert into workspaces (id, name) values ($1, 'Shop A'), ($2, 'Shop B')", [WS_A, WS_B]);
    await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [
      WS_A,
      USER_A,
      WS_B,
      USER_B,
    ]);
    const product = await client.query<{ id: string }>(
      "insert into products (workspace_id, title, mode) values ($1, 'Copper kettle', 'listing') returning id",
      [WS_A],
    );
    const productId = product.rows[0].id;
    const jobs = await client.query<{ id: string; status: string }>(
      `insert into generation_jobs (workspace_id, product_id, status) values
         ($1, $2, 'queued'), ($1, $2, 'generating'), ($1, $2, 'done') returning id, status`,
      [WS_A, productId],
    );
    const running = jobs.rows.find((job) => job.status === "generating")!.id;
    await client.query(
      `insert into credit_ledger (workspace_id, delta, reason, source, job_id) values
         ($1, 50, 'grant', 'system', null),
         ($2, 12.5, 'topup', 'stripe', null),
         ($1, -6, 'reserve', 'system', $3),
         ($1, 2.5, 'release', 'system', $3),
         ($1, -2.5, 'charge', 'system', $3)`,
      [WS_A, WS_B, running],
    );

    // P20-33's column, so the reset is seen clearing it.
    await client.exec("alter table generation_jobs add column run_payload jsonb");
    await client.exec(`update generation_jobs set run_payload = '{"shots": 3}'`);
    // Adding a column changes no grant, RLS switch or policy; take the
    // baseline again as the drill would after a migrate that included it.
    await client.query("select drill_check.snapshot_acl_baseline()");

    const reset = await client.query<{ n: number }>("select drill_check.fail_live_jobs() as n");
    liveJobs = reset.rows[0].n;
    await loadManifest(client);
  });

  afterAll(async () => {
    await client.close();
  });

  it("fails every live job and clears every stored run payload", async () => {
    expect(liveJobs).toBe(2);
    const { rows } = await client.query<{ status: string; error: string | null; run_payload: unknown }>(
      "select status, error, run_payload from generation_jobs order by status",
    );
    expect(rows.map((row) => row.status)).toEqual(["done", "failed", "failed"]);
    expect(rows.filter((row) => row.status === "failed").every((row) => row.error === "Restored into a drill database; not run.")).toBe(true);
    expect(rows.every((row) => row.run_payload === null)).toBe(true);
  });

  it("passes every check on a faithful restore", async () => {
    const result = await checks(client);
    expect(Object.keys(result)).toEqual([
      "tables_present",
      "row_counts",
      "latest_migration",
      "ledger_total",
      "ledger_balances",
      "foreign_keys",
      "acl_unchanged",
      "ledger_functions_locked",
      "live_jobs_reset",
    ]);
    expect(Object.values(result).filter((row) => !row.ok)).toEqual([]);
    expect(result.row_counts.detail).toBe("Every row count matches the backup across 6 tables.");
    expect(result.ledger_total.detail).toBe("Ledger total 56.5 credits, the backup 56.5.");
    expect(result.latest_migration.detail).toBe(`Both at migration ${LATEST}.`);
  });

  it("fails on a row count or a table the backup has and the drill lacks", async () => {
    await loadManifest(client, { counts: { "public.workspaces": 3 } });
    expect(await failing(client)).toEqual(["row_counts"]);
    expect((await checks(client)).row_counts.detail).toBe("public.workspaces has 2 rows, the backup 3");

    await client.query("insert into drill_check.manifest_counts values ('public.dropped_table', 4)");
    expect(await failing(client)).toEqual(["tables_present", "row_counts"]);
    await loadManifest(client);
  });

  it("fails when the ledger total differs from the backup", async () => {
    await loadManifest(client, { ledgerTenths: 560 });
    expect(await failing(client)).toEqual(["ledger_total"]);
    await loadManifest(client);
  });

  it("fails when the schema is older than the backup's, and passes when newer", async () => {
    await loadManifest(client, { latest: "1800000000000" });
    expect(await failing(client)).toEqual(["latest_migration"]);
    expect((await checks(client)).latest_migration.detail).toContain("check out the commit production runs");
    await loadManifest(client, { latest: "1700000000000" });
    expect(await failing(client)).toEqual([]);
    await loadManifest(client);
  });

  it("fails when a function the migrations lock is opened to a client role", async () => {
    await client.exec("grant execute on function reserve_credits(uuid, numeric, uuid) to anon");
    expect(await failing(client)).toEqual(["acl_unchanged", "ledger_functions_locked"]);
    const result = await checks(client);
    expect(result.ledger_functions_locked.detail).toBe("Open: reserve_credits(uuid,numeric,uuid) to anon");
    expect(result.acl_unchanged.detail).toBe("Changed: function reserve_credits(uuid,numeric,uuid)");
    await client.exec("revoke execute on function reserve_credits(uuid, numeric, uuid) from anon");
    expect(await failing(client)).toEqual([]);
  });

  it("fails when RLS is switched off or a policy changes", async () => {
    await client.exec("alter table credit_ledger disable row level security");
    expect(await failing(client)).toEqual(["acl_unchanged"]);
    await client.exec("alter table credit_ledger enable row level security");
    expect(await failing(client)).toEqual([]);
  });

  it("fails on a row whose foreign key points at nothing, loaded with triggers off", async () => {
    const ghost = "00000000-0000-4000-8000-0000000000ff";
    await client.exec("set session_replication_role = replica");
    await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'editor')", [ghost, USER_B]);
    await client.exec("set session_replication_role = origin");
    await loadManifest(client);
    expect(await failing(client)).toEqual(["foreign_keys"]);
    expect((await checks(client)).foreign_keys.detail).toMatch(/^members_workspace_id_workspaces_id_fk: 1 rows$/);
    await client.query("delete from members where workspace_id = $1", [ghost]);
    await loadManifest(client);
    expect(await failing(client)).toEqual([]);
  });

  it("fails when a live job is left", async () => {
    const product = await client.query<{ id: string }>("select id from products limit 1");
    await client.query("insert into generation_jobs (workspace_id, product_id, status) values ($1, $2, 'queued')", [
      WS_A,
      product.rows[0].id,
    ]);
    await loadManifest(client);
    expect(await failing(client)).toEqual(["live_jobs_reset"]);
    expect(await client.query<{ n: number }>("select drill_check.fail_live_jobs() as n").then((r) => r.rows[0].n)).toBe(1);
    expect(await failing(client)).toEqual([]);
  });

  it("fails without a baseline or without the migrate's bookkeeping", async () => {
    await client.exec("create table drill_check.saved as select * from drill_check.acl_baseline; delete from drill_check.acl_baseline;");
    expect(await failing(client)).toEqual(["acl_unchanged"]);
    await client.exec("insert into drill_check.acl_baseline select * from drill_check.saved; drop table drill_check.saved;");

    await client.exec("alter table drizzle.__drizzle_migrations rename to moved");
    expect(await failing(client)).toEqual(["latest_migration"]);
    await client.exec("alter table drizzle.moved rename to __drizzle_migrations");
    expect(await failing(client)).toEqual([]);
  });
});

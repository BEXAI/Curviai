import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  actAs,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  type TestDb,
} from "./test-helpers";
import { creditLedger, generationJobs, products, workspaces } from "./schema";

const EXPECTED_TABLES = [
  "workspaces",
  "members",
  "brand_kits",
  "products",
  "source_media",
  "generation_jobs",
  "job_steps",
  "assets",
  "asset_variants",
  "channel_specs",
  "recipes",
  "credit_ledger",
  "subscriptions",
  "referrals",
  "share_links",
  "gallery_items",
  "integrations",
  "events",
  "churn_scores",
];

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const USER_CLIENT = "00000000-0000-4000-8000-00000000000c";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let productA: string;
let productB: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);

  const [a] = await db.insert(workspaces).values({ name: "Workspace A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "Workspace B" }).returning();
  wsA = a.id;
  wsB = b.id;

  await client.query(
    `insert into members (workspace_id, user_id, role) values
       ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'client')`,
    [wsA, USER_A, wsB, USER_B, USER_CLIENT],
  );

  const [pa] = await db
    .insert(products)
    .values({ workspaceId: wsA, title: "Copper kettle", mode: "listing" })
    .returning();
  const [pb] = await db
    .insert(products)
    .values({ workspaceId: wsB, title: "Walnut tray", mode: "concept" })
    .returning();
  productA = pa.id;
  productB = pb.id;

  await db.insert(creditLedger).values([
    { workspaceId: wsA, delta: 100, reason: "grant", source: "system" },
    { workspaceId: wsB, delta: 40, reason: "grant", source: "system" },
  ]);
});

afterAll(async () => {
  await actAsSuperuser(client);
  await client.close();
});

describe("migrations", () => {
  it("apply cleanly and create every table", async () => {
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = result.rows.map((r) => r.table_name);
    for (const table of EXPECTED_TABLES) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it("enable row level security on every table including recipes and channel_specs", async () => {
    const result = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relkind = 'r' and relnamespace = 'public'::regnamespace`,
    );
    const rls = new Map(result.rows.map((r) => [r.relname, r.relrowsecurity]));
    for (const table of EXPECTED_TABLES) {
      expect(rls.get(table), `${table} should have RLS enabled`).toBe(true);
    }
  });

  it("enforce the one active subscription per workspace constraint", async () => {
    await actAsSuperuser(client);
    await client.query(
      "insert into subscriptions (workspace_id, provider, tier, status) values ($1, 'stripe', 'starter', 'active')",
      [wsA],
    );
    await expect(
      client.query(
        "insert into subscriptions (workspace_id, provider, tier, status) values ($1, 'stripe', 'growth', 'active')",
        [wsA],
      ),
    ).rejects.toThrow(/subscriptions_one_active_per_workspace_uq/);
    await client.query(
      "insert into subscriptions (workspace_id, provider, tier, status) values ($1, 'stripe', 'starter', 'canceled')",
      [wsA],
    );
  });
});

describe("row level security isolation", () => {
  it("shows user A only workspace A rows in workspaces, products and credit_ledger", async () => {
    await actAs(client, USER_A);

    const wsRows = await db.select().from(workspaces);
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0].id).toBe(wsA);

    const productRows = await db.select().from(products);
    expect(productRows).toHaveLength(1);
    expect(productRows[0].id).toBe(productA);
    expect(productRows[0].workspaceId).toBe(wsA);

    const ledgerRows = await db.select().from(creditLedger);
    expect(ledgerRows.length).toBeGreaterThan(0);
    expect(ledgerRows.every((row) => row.workspaceId === wsA)).toBe(true);

    await actAsSuperuser(client);
  });

  it("shows user B only workspace B rows", async () => {
    await actAs(client, USER_B);

    const wsRows = await db.select().from(workspaces);
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0].id).toBe(wsB);

    const productRows = await db.select().from(products);
    expect(productRows).toHaveLength(1);
    expect(productRows[0].id).toBe(productB);

    const ledgerRows = await db.select().from(creditLedger);
    expect(ledgerRows.every((row) => row.workspaceId === wsB)).toBe(true);

    await actAsSuperuser(client);
  });

  it("shows nothing to a user with no membership", async () => {
    await actAs(client, "00000000-0000-4000-8000-0000000000ff");
    const wsRows = await db.select().from(workspaces);
    expect(wsRows).toHaveLength(0);
    await actAsSuperuser(client);
  });

  it("blocks the client role from inserting into generation_jobs and credit_ledger", async () => {
    await actAs(client, USER_CLIENT);

    await expect(
      client.query(
        "insert into generation_jobs (workspace_id, product_id) values ($1, $2)",
        [wsA, productA],
      ),
    ).rejects.toThrow(/row-level security/);

    await expect(
      client.query(
        "insert into credit_ledger (workspace_id, delta, reason) values ($1, 999, 'grant')",
        [wsA],
      ),
    ).rejects.toThrow(/row-level security/);

    // The client role can still read assets and jobs in its workspace.
    const jobRows = await db.select().from(generationJobs);
    expect(jobRows.every((row) => row.workspaceId === wsA)).toBe(true);

    await actAsSuperuser(client);
  });

  it("lets an owner insert a generation job", async () => {
    await actAs(client, USER_A);
    const [job] = await db
      .insert(generationJobs)
      .values({ workspaceId: wsA, productId: productA, idempotencyKey: "owner-job-1" })
      .returning();
    expect(job.workspaceId).toBe(wsA);
    expect(job.status).toBe("queued");
    await actAsSuperuser(client);
  });

  it("rejects duplicate idempotency keys", async () => {
    await actAsSuperuser(client);
    await expect(
      db
        .insert(generationJobs)
        .values({ workspaceId: wsA, productId: productA, idempotencyKey: "owner-job-1" }),
    ).rejects.toThrow(/idempotency_key/);
  });
});

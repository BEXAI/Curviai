import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsServiceRole,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  type TestDb,
} from "./test-helpers";
import { creditLedger, galleryItems, recipes, workspaces } from "./schema";

// Every test in this file replays an exploit that the security audit executed
// against migration 0001 and asserts that 0002_security_hardening closes it.

const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const EDITOR_A = "00000000-0000-4000-8000-0000000000a2";
const CLIENT_A = "00000000-0000-4000-8000-0000000000a3";
const OWNER_B = "00000000-0000-4000-8000-0000000000b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let productA: string;
let jobA: string;

// PGlite returns numeric as text, so coerce before comparing.
async function balanceAsSuperuser(workspaceId: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>(
    "select credit_balance($1)",
    [workspaceId],
  );
  return Number(result.rows[0].credit_balance);
}

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
       ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'client'), ($5, $6, 'owner')`,
    [wsA, OWNER_A, EDITOR_A, CLIENT_A, wsB, OWNER_B],
  );

  const productResult = await client.query<{ id: string }>(
    "insert into products (workspace_id, title, mode) values ($1, 'Copper kettle', 'listing') returning id",
    [wsA],
  );
  productA = productResult.rows[0].id;
  const jobResult = await client.query<{ id: string }>(
    "insert into generation_jobs (workspace_id, product_id) values ($1, $2) returning id",
    [wsA, productA],
  );
  jobA = jobResult.rows[0].id;

  await db
    .insert(creditLedger)
    .values({ workspaceId: wsA, delta: 100, reason: "grant", source: "system" });
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await actAsSuperuser(client);
  await client.close();
});

describe("finding 1: credit_ledger self-grant", () => {
  it("denies owner and editor members inserting grant rows while keeping SELECT", async () => {
    await actAs(client, OWNER_A);
    await expect(
      client.query(
        "insert into credit_ledger (workspace_id, delta, reason, source) values ($1, 1000000, 'grant', 'stripe')",
        [wsA],
      ),
    ).rejects.toThrow(/row-level security/);

    await actAsSuperuser(client);
    await actAs(client, EDITOR_A);
    await expect(
      client.query(
        "insert into credit_ledger (workspace_id, delta, reason, source) values ($1, 1000000, 'grant', 'stripe')",
        [wsA],
      ),
    ).rejects.toThrow(/row-level security/);

    // Members still read their own workspace ledger.
    const rows = await db.select().from(creditLedger);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === wsA)).toBe(true);
  });
});

describe("finding 2: ledger functions executable by anyone", () => {
  it("denies a non member calling credit_balance and reserve_credits cross tenant", async () => {
    await actAs(client, OWNER_B);
    await expect(client.query("select credit_balance($1)", [wsA])).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      client.query("select reserve_credits($1, 40, $2)", [wsA, jobA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      client.query("select charge_credits($1, 10, $2)", [wsA, jobA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      client.query("select release_credits($1, $2)", [wsA, jobA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("denies the authenticated and anon roles outright", async () => {
    await actAsAuthenticated(client, OWNER_B);
    await expect(client.query("select credit_balance($1)", [wsA])).rejects.toThrow(
      /permission denied/,
    );
    await actAsAnon(client);
    await expect(client.query("select credit_balance($1)", [wsA])).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      client.query("select reserve_credits($1, 40, $2)", [wsA, jobA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("still allows the service role to execute the ledger functions", async () => {
    await actAsServiceRole(client);
    const result = await client.query<{ credit_balance: string | number }>(
      "select credit_balance($1)",
      [wsA],
    );
    expect(Number(result.rows[0].credit_balance)).toBe(100);
  });
});

describe("finding 3: workspaces FOR ALL policy", () => {
  it("denies a client member updating plan or deleting the workspace", async () => {
    await actAs(client, CLIENT_A);
    const update = await client.query("update workspaces set plan = 'agency' where id = $1", [
      wsA,
    ]);
    expect(update.affectedRows ?? 0).toBe(0);
    const del = await client.query("delete from workspaces where id = $1", [wsA]);
    expect(del.affectedRows ?? 0).toBe(0);

    await actAsSuperuser(client);
    const check = await client.query<{ plan: string }>(
      "select plan from workspaces where id = $1",
      [wsA],
    );
    expect(check.rows).toHaveLength(1);
    expect(check.rows[0].plan).toBe("free");
  });

  it("denies even the owner deleting the workspace or escalating plan", async () => {
    await actAs(client, OWNER_A);
    const del = await client.query("delete from workspaces where id = $1", [wsA]);
    expect(del.affectedRows ?? 0).toBe(0);
    await expect(
      client.query("update workspaces set plan = 'agency' where id = $1", [wsA]),
    ).rejects.toThrow(/service role/);
    await expect(
      client.query("update workspaces set stripe_customer_id = 'cus_evil' where id = $1", [
        wsA,
      ]),
    ).rejects.toThrow(/service role/);

    await actAsSuperuser(client);
    const check = await client.query<{ plan: string }>(
      "select plan from workspaces where id = $1",
      [wsA],
    );
    expect(check.rows[0].plan).toBe("free");
  });

  it("still lets the owner rename the workspace and the service role change plan", async () => {
    await actAs(client, OWNER_A);
    const rename = await client.query(
      "update workspaces set name = 'Workspace A renamed' where id = $1",
      [wsA],
    );
    expect(rename.affectedRows).toBe(1);

    await actAsServiceRole(client);
    const upgrade = await client.query(
      "update workspaces set plan = 'growth' where id = $1",
      [wsA],
    );
    expect(upgrade.affectedRows).toBe(1);

    await actAsSuperuser(client);
    await client.query("update workspaces set plan = 'free' where id = $1", [wsA]);
  });
});

describe("finding 4: subscriptions FOR ALL policy", () => {
  it("denies a member inserting an active agency subscription but keeps SELECT", async () => {
    await actAs(client, OWNER_A);
    await expect(
      client.query(
        "insert into subscriptions (workspace_id, provider, tier, status) values ($1, 'stripe', 'agency', 'active')",
        [wsA],
      ),
    ).rejects.toThrow(/row-level security/);

    await actAsSuperuser(client);
    await client.query(
      "insert into subscriptions (workspace_id, provider, tier, status) values ($1, 'stripe', 'starter', 'active')",
      [wsA],
    );

    await actAs(client, OWNER_A);
    const rows = await client.query<{ tier: string }>("select tier from subscriptions");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].tier).toBe("starter");

    // A member cannot flip their tier in place either: no UPDATE policy exists.
    const update = await client.query(
      "update subscriptions set tier = 'agency' where workspace_id = $1",
      [wsA],
    );
    expect(update.affectedRows ?? 0).toBe(0);
  });
});

describe("finding 5: recipes and channel_specs without RLS", () => {
  beforeAll(async () => {
    await actAsSuperuser(client);
    await client.query(
      `insert into recipes (key, version, stage, model, body, active)
       values ('intake_normalizer', 1, 'intake', 'model-a', '{"system":"normalize"}', true)`,
    );
    await client.query(
      `insert into channel_specs (id, version, spec) values ('amazon.main', 1, '{"id":"amazon.main"}')`,
    );
  });

  it("lets authenticated users read recipes but never write them", async () => {
    await actAsAuthenticated(client, OWNER_A);
    const rows = await db.select().from(recipes);
    expect(rows).toHaveLength(1);

    const update = await client.query(
      "update recipes set body = '{\"system\":\"injected prompt\"}' where key = 'intake_normalizer'",
    );
    expect(update.affectedRows ?? 0).toBe(0);
    await expect(
      client.query(
        `insert into recipes (key, version, stage, model, body, active)
         values ('evil', 1, 'intake', 'model-x', '{"system":"pwn"}', true)`,
      ),
    ).rejects.toThrow(/row-level security/);

    await actAsSuperuser(client);
    const check = await client.query<{ body: { system: string } }>(
      "select body from recipes where key = 'intake_normalizer'",
    );
    expect(check.rows[0].body.system).toBe("normalize");
  });

  it("lets authenticated users read channel_specs but never write them", async () => {
    await actAsAuthenticated(client, OWNER_A);
    const rows = await client.query<{ id: string }>("select id from channel_specs");
    expect(rows.rows).toHaveLength(1);

    const update = await client.query(
      "update channel_specs set spec = '{\"id\":\"tampered\"}' where id = 'amazon.main'",
    );
    expect(update.affectedRows ?? 0).toBe(0);
    await expect(
      client.query(
        "insert into channel_specs (id, version, spec) values ('evil.spec', 1, '{}')",
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows anon nothing at all", async () => {
    await actAsAnon(client);
    const recipeRows = await client.query("select * from recipes");
    expect(recipeRows.rows).toHaveLength(0);
    const specRows = await client.query("select * from channel_specs");
    expect(specRows.rows).toHaveLength(0);
  });
});

describe("finding 6: job_steps, churn_scores and events write policies", () => {
  it("denies members writing job_steps while keeping member SELECT", async () => {
    await actAs(client, OWNER_A);
    await expect(
      client.query(
        "insert into job_steps (workspace_id, job_id, stage, cost_micros) values ($1, $2, 'generating', 1)",
        [wsA, jobA],
      ),
    ).rejects.toThrow(/row-level security/);

    await actAsSuperuser(client);
    await client.query(
      "insert into job_steps (workspace_id, job_id, stage, cost_micros) values ($1, $2, 'generating', 12345)",
      [wsA, jobA],
    );

    await actAs(client, OWNER_A);
    const rows = await client.query<{ cost_micros: number }>(
      "select cost_micros from job_steps",
    );
    expect(rows.rows).toHaveLength(1);
    const tamper = await client.query("update job_steps set cost_micros = 0");
    expect(tamper.affectedRows ?? 0).toBe(0);
  });

  it("denies members writing churn_scores", async () => {
    await actAs(client, OWNER_A);
    await expect(
      client.query(
        "insert into churn_scores (workspace_id, score, band) values ($1, 0, 'healthy')",
        [wsA],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("lets any member insert events but only into their own workspace", async () => {
    await actAs(client, CLIENT_A);
    await client.query("insert into events (workspace_id, name) values ($1, 'asset_viewed')", [
      wsA,
    ]);

    await actAsSuperuser(client);
    await actAs(client, OWNER_B);
    await expect(
      client.query("insert into events (workspace_id, name) values ($1, 'spoofed')", [wsA]),
    ).rejects.toThrow(/row-level security/);

    // Nobody rewrites analytics history from the client side.
    await actAsSuperuser(client);
    await actAs(client, OWNER_A);
    const rewrite = await client.query("update events set name = 'rewritten'");
    expect(rewrite.affectedRows ?? 0).toBe(0);
  });
});

describe("finding 7: charge_credits idempotency", () => {
  let jobB: string;

  beforeAll(async () => {
    await actAsSuperuser(client);
    const jobResult = await client.query<{ id: string }>(
      "insert into generation_jobs (workspace_id, product_id) values ($1, $2) returning id",
      [wsA, productA],
    );
    jobB = jobResult.rows[0].id;
    await client.query("select reserve_credits($1, 60, $2)", [wsA, jobB]);
  });

  it("charges once for a retried charge with the same step key", async () => {
    const first = await client.query<{ charge_credits: string | number }>(
      "select charge_credits($1, 40, $2, $3)",
      [wsA, jobB, "asset-1"],
    );
    expect(Number(first.rows[0].charge_credits)).toBe(20);

    const retry = await client.query<{ charge_credits: string | number }>(
      "select charge_credits($1, 40, $2, $3)",
      [wsA, jobB, "asset-1"],
    );
    // The retry is a no-op and reports the unchanged held amount.
    expect(Number(retry.rows[0].charge_credits)).toBe(20);

    const charged = await client.query<{ credits_charged: string | number }>(
      "select credits_charged from generation_jobs where id = $1",
      [jobB],
    );
    expect(Number(charged.rows[0].credits_charged)).toBe(40);

    const chargeRows = await client.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where job_id = $1 and reason = 'charge' and step_key = 'asset-1'",
      [jobB],
    );
    expect(chargeRows.rows[0].count).toBe(1);
    expect(await balanceAsSuperuser(wsA)).toBe(40);
  });

  it("keeps the legacy 3-argument call working without an idempotency key", async () => {
    const result = await client.query<{ charge_credits: string | number }>(
      "select charge_credits($1, 10, $2)",
      [wsA, jobB],
    );
    expect(Number(result.rows[0].charge_credits)).toBe(10);
    const charged = await client.query<{ credits_charged: string | number }>(
      "select credits_charged from generation_jobs where id = $1",
      [jobB],
    );
    expect(Number(charged.rows[0].credits_charged)).toBe(50);
  });

  it("backs the idempotency up with a partial unique index against direct writes", async () => {
    await expect(
      client.query(
        "insert into credit_ledger (workspace_id, delta, reason, source, job_id, step_key) values ($1, -40, 'charge', 'system', $2, 'asset-1')",
        [wsA, jobB],
      ),
    ).rejects.toThrow(/credit_ledger_job_step_charge_uq/);
  });
});

describe("finding 8: anonymous gallery enumeration", () => {
  beforeAll(async () => {
    await actAsSuperuser(client);
    await client.query(
      "insert into gallery_items (workspace_id, category, consent_at) values ($1, 'private', now())",
      [wsA],
    );
    await client.query(
      "insert into gallery_items (workspace_id, category, consent_at, published) values ($1, 'showcase', now(), true)",
      [wsA],
    );
  });

  it("returns only explicitly published rows to anon", async () => {
    await actAsAnon(client);
    const rows = await client.query<{ category: string; published: boolean }>(
      "select category, published from gallery_items",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].category).toBe("showcase");
    expect(rows.rows[0].published).toBe(true);
  });

  it("keeps the full tenant view for workspace members", async () => {
    await actAs(client, OWNER_A);
    const rows = await db.select().from(galleryItems);
    expect(rows).toHaveLength(2);
  });
});

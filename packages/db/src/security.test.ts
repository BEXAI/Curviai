import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsServiceRole,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  readJournalEntries,
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
      "insert into gallery_items (workspace_id, category, consent_at, published, review_status) values ($1, 'showcase', now(), true, 'approved')",
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

// Migration 0011 (Update.md 4.1 and 4.2): members lost every write path to the
// tables whose rows carry R2 object keys or consent decisions. Each case below
// replays the exploit through an app_user or authenticated session and asserts
// the denial, then checks that member reads and server writes still work.
describe("0011: tenant write lockdown", () => {
  let productB: string;
  let jobB: string;
  let assetA: string;
  let assetB: string;
  const keyA = () => `ws/${wsA}/src/photo-a.jpg`;
  const keyB = () => `ws/${wsB}/src/secret-b.jpg`;
  const sha = "a".repeat(64);

  beforeAll(async () => {
    await actAsSuperuser(client);
    await client.query(
      `insert into channel_specs (id, version, spec) values ('amazon.main', 1, '{"id":"amazon.main"}')
       on conflict (id) do nothing`,
    );
    const product = await client.query<{ id: string }>(
      "insert into products (workspace_id, title, mode) values ($1, 'Walnut tray', 'listing') returning id",
      [wsB],
    );
    productB = product.rows[0].id;
    const job = await client.query<{ id: string }>(
      "insert into generation_jobs (workspace_id, product_id) values ($1, $2) returning id",
      [wsB, productB],
    );
    jobB = job.rows[0].id;
    await client.query(
      "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, $3, 'image', $4), ($5, $6, $7, 'image', $4)",
      [wsA, productA, keyA(), sha, wsB, productB, keyB()],
    );
    const a = await client.query<{ id: string }>(
      "insert into assets (workspace_id, job_id, shot_type, approved) values ($1, $2, 'main_white', false) returning id",
      [wsA, jobA],
    );
    assetA = a.rows[0].id;
    const b = await client.query<{ id: string }>(
      "insert into assets (workspace_id, job_id, shot_type, approved) values ($1, $2, 'main_white', true) returning id",
      [wsB, jobB],
    );
    assetB = b.rows[0].id;
    await client.query(
      `insert into asset_variants (workspace_id, asset_id, channel_spec_id, r2_key, filename) values
         ($1, $2, 'amazon.main', $3, 'a.jpg'), ($4, $5, 'amazon.main', $6, 'b.jpg')`,
      [
        wsA,
        assetA,
        `ws/${wsA}/jobs/${jobA}/files/amazon/a.jpg`,
        wsB,
        assetB,
        `ws/${wsB}/jobs/${jobB}/files/amazon/b.jpg`,
      ],
    );
  });

  it("denies every member role inserting source_media that points at another workspace's object", async () => {
    for (const user of [OWNER_A, EDITOR_A, CLIENT_A]) {
      await actAsSuperuser(client);
      await actAs(client, user);
      await expect(
        client.query(
          "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, $3, 'image', $4)",
          [wsA, productA, keyB(), sha],
        ),
      ).rejects.toThrow(/row-level security/);
    }
    // The authenticated role (the real Supabase client path) is denied too,
    // even for a key inside its own workspace.
    await actAsAuthenticated(client, OWNER_A);
    await expect(
      client.query(
        "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, $3, 'image', $4)",
        [wsA, productA, keyA(), sha],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("denies members repointing or deleting existing source_media rows", async () => {
    await actAs(client, OWNER_A);
    const repoint = await client.query("update source_media set r2_key = $1 where workspace_id = $2", [
      keyB(),
      wsA,
    ]);
    expect(repoint.affectedRows ?? 0).toBe(0);
    const del = await client.query("delete from source_media where workspace_id = $1", [wsA]);
    expect(del.affectedRows ?? 0).toBe(0);

    await actAsSuperuser(client);
    const rows = await client.query<{ r2_key: string }>(
      "select r2_key from source_media where workspace_id = $1",
      [wsA],
    );
    expect(rows.rows.map((r) => r.r2_key)).toEqual([keyA()]);
  });

  it("denies members inserting assets or asset_variants rows", async () => {
    await actAs(client, EDITOR_A);
    await expect(
      client.query(
        "insert into assets (workspace_id, job_id, shot_type, approved) values ($1, $2, 'main_white', true)",
        [wsA, jobA],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      client.query(
        "insert into asset_variants (workspace_id, asset_id, channel_spec_id, r2_key, filename) values ($1, $2, 'amazon.main', $3, 'stolen.jpg')",
        [wsA, assetA, keyB()],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("denies the client role, and every other member, flipping assets.approved", async () => {
    for (const user of [CLIENT_A, OWNER_A]) {
      await actAsSuperuser(client);
      await actAs(client, user);
      const flip = await client.query("update assets set approved = true where id = $1", [assetA]);
      expect(flip.affectedRows ?? 0).toBe(0);
      const retarget = await client.query("update asset_variants set r2_key = $1 where asset_id = $2", [
        keyB(),
        assetA,
      ]);
      expect(retarget.affectedRows ?? 0).toBe(0);
    }
    await actAsSuperuser(client);
    const check = await client.query<{ approved: boolean }>("select approved from assets where id = $1", [
      assetA,
    ]);
    expect(check.rows[0].approved).toBe(false);
  });

  it("keeps member reads of their own workspace's media, assets and variants", async () => {
    await actAs(client, CLIENT_A);
    const media = await client.query<{ workspace_id: string }>("select workspace_id from source_media");
    expect(media.rows.length).toBeGreaterThan(0);
    expect(media.rows.every((r) => r.workspace_id === wsA)).toBe(true);
    const assetRows = await client.query<{ id: string }>("select id from assets");
    expect(assetRows.rows.map((r) => r.id)).toEqual([assetA]);
    const variants = await client.query<{ workspace_id: string }>("select workspace_id from asset_variants");
    expect(variants.rows).toHaveLength(1);
    expect(variants.rows[0].workspace_id).toBe(wsA);
  });

  it("still lets the service role write media rows", async () => {
    await actAsServiceRole(client);
    const insert = await client.query(
      "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, $3, 'image', $4)",
      [wsA, productA, `ws/${wsA}/src/service-write.jpg`, sha],
    );
    expect(insert.affectedRows).toBe(1);
  });

  it("rejects an object key outside the row's own workspace prefix, even from the owner connection", async () => {
    await actAsSuperuser(client);
    await expect(
      client.query(
        "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, $3, 'image', $4)",
        [wsA, productA, keyB(), sha],
      ),
    ).rejects.toThrow(/source_media_r2_key_workspace_prefix/);
    await expect(
      client.query(
        "insert into asset_variants (workspace_id, asset_id, channel_spec_id, r2_key, filename) values ($1, $2, 'amazon.main', $3, 'x.jpg')",
        [wsA, assetA, `ws/${wsB}/jobs/${jobB}/files/amazon/b.jpg`],
      ),
    ).rejects.toThrow(/asset_variants_r2_key_workspace_prefix/);
    await expect(
      client.query(
        "insert into pack_files (workspace_id, job_id, kind, filename, r2_key) values ($1, $2, 'zip', 'amazon.zip', $3)",
        [wsA, jobA, `ws/${wsB}/jobs/${jobB}/pack/amazon.zip`],
      ),
    ).rejects.toThrow(/pack_files_r2_key_workspace_prefix/);
    // A lookalike prefix (the workspace id plus a suffix) does not pass either.
    await expect(
      client.query(
        "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, $3, 'image', $4)",
        [wsA, productA, `ws/${wsA}x/src/a.jpg`, sha],
      ),
    ).rejects.toThrow(/source_media_r2_key_workspace_prefix/);
    // Updates are checked as well.
    await expect(
      client.query("update source_media set r2_key = $1 where r2_key = $2", [keyB(), keyA()]),
    ).rejects.toThrow(/source_media_r2_key_workspace_prefix/);
    // Keys the worker writes pass.
    const ok = await client.query(
      "insert into pack_files (workspace_id, job_id, kind, filename, r2_key) values ($1, $2, 'zip', 'amazon.zip', $3)",
      [wsA, jobA, `ws/${wsA}/jobs/${jobA}/pack/amazon.zip`],
    );
    expect(ok.affectedRows).toBe(1);
  });

  it("limits brand kit writes to owner, admin and editor, and keeps logo keys in the workspace", async () => {
    await actAs(client, CLIENT_A);
    await expect(
      client.query("insert into brand_kits (workspace_id, name) values ($1, 'Client kit')", [wsA]),
    ).rejects.toThrow(/row-level security/);

    await actAsSuperuser(client);
    await actAs(client, EDITOR_A);
    const created = await client.query<{ id: string }>(
      "insert into brand_kits (workspace_id, name) values ($1, 'Editor kit') returning id",
      [wsA],
    );
    const kitId = created.rows[0].id;
    // The foreign logo exploit from Update.md 4.2 fails on the prefix check.
    await expect(
      client.query("update brand_kits set logo_r2_key = $1 where id = $2", [keyB(), kitId]),
    ).rejects.toThrow(/brand_kits_logo_r2_key_workspace_prefix/);
    const ownLogo = await client.query("update brand_kits set logo_r2_key = $1 where id = $2", [
      `ws/${wsA}/src/logo.png`,
      kitId,
    ]);
    expect(ownLogo.affectedRows).toBe(1);

    await actAsSuperuser(client);
    await actAs(client, CLIENT_A);
    const clientUpdate = await client.query("update brand_kits set name = 'Hijacked' where id = $1", [kitId]);
    expect(clientUpdate.affectedRows ?? 0).toBe(0);
    const clientRead = await client.query<{ name: string }>("select name from brand_kits where id = $1", [
      kitId,
    ]);
    expect(clientRead.rows[0].name).toBe("Editor kit");

    await actAsSuperuser(client);
    await actAs(client, OWNER_A);
    const del = await client.query("delete from brand_kits where id = $1", [kitId]);
    expect(del.affectedRows ?? 0).toBe(0);

    await actAsSuperuser(client);
    await actAs(client, OWNER_B);
    const foreign = await client.query("update brand_kits set name = 'Cross tenant' where id = $1", [kitId]);
    expect(foreign.affectedRows ?? 0).toBe(0);
  });

  it("stops a client seat deleting products, which would cascade to jobs and assets", async () => {
    await actAs(client, CLIENT_A);
    const del = await client.query("delete from products where id = $1", [productA]);
    expect(del.affectedRows ?? 0).toBe(0);
    const rename = await client.query("update products set title = 'Renamed' where id = $1", [productA]);
    expect(rename.affectedRows ?? 0).toBe(0);
    await expect(
      client.query("insert into products (workspace_id, title, mode) values ($1, 'Client product', 'listing')", [
        wsA,
      ]),
    ).rejects.toThrow(/row-level security/);

    // Even the owner cannot delete through a client connection.
    await actAsSuperuser(client);
    await actAs(client, OWNER_A);
    const ownerDelete = await client.query("delete from products where id = $1", [productA]);
    expect(ownerDelete.affectedRows ?? 0).toBe(0);

    // Editors keep product edits in their own workspace.
    await actAsSuperuser(client);
    await actAs(client, EDITOR_A);
    const editorRename = await client.query("update products set title = 'Copper kettle v2' where id = $1", [
      productA,
    ]);
    expect(editorRename.affectedRows).toBe(1);

    await actAsSuperuser(client);
    const survivors = await client.query<{ count: number }>(
      "select count(*)::int as count from generation_jobs where product_id = $1",
      [productA],
    );
    expect(survivors.rows[0].count).toBeGreaterThan(0);
  });

  it("denies members publishing share links or gallery items, or writing referrals and integrations", async () => {
    await actAs(client, EDITOR_A);
    await expect(
      client.query("insert into share_links (slug, workspace_id, asset_id, public) values ('leak', $1, $2, true)", [
        wsA,
        assetA,
      ]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      client.query(
        "insert into gallery_items (workspace_id, category, consent_at, published) values ($1, 'self published', now(), true)",
        [wsA],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      client.query("insert into referrals (code, referrer_workspace_id) values ('SELF', $1)", [wsA]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      client.query("insert into integrations (workspace_id, kind, encrypted_token) values ($1, 'shopify', 'x')", [
        wsA,
      ]),
    ).rejects.toThrow(/row-level security/);
    const publish = await client.query("update gallery_items set published = true where workspace_id = $1", [wsA]);
    expect(publish.affectedRows ?? 0).toBe(0);
  });

  it("shows integration rows, which hold credentials, to owners and admins only", async () => {
    await actAsSuperuser(client);
    await client.query("insert into integrations (workspace_id, kind, encrypted_token) values ($1, 'shopify', 'enc')", [
      wsA,
    ]);
    await actAs(client, OWNER_A);
    const owner = await client.query("select encrypted_token from integrations");
    expect(owner.rows).toHaveLength(1);
    for (const user of [EDITOR_A, CLIENT_A, OWNER_B]) {
      await actAsSuperuser(client);
      await actAs(client, user);
      const rows = await client.query("select encrypted_token from integrations");
      expect(rows.rows).toHaveLength(0);
    }
  });
});

// The prefix constraints are added NOT VALID so a production database with
// legacy rows can take the migration. This boots a fresh database, applies
// every migration before 0011, writes rows 0011 would reject, then applies
// 0011 on top.
describe("0011: applies over legacy rows without failing", () => {
  it("keeps pre existing out of prefix rows and still checks new writes", async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const legacy = new PGlite();
    try {
      await legacy.exec(`
        create schema if not exists auth;
        create or replace function auth.uid() returns uuid language sql stable
          as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create role anon;
        create role authenticated;
        create role service_role bypassrls;
      `);
      const entries = readJournalEntries();
      const lockdown = entries.find((e) => e.tag === "0011_tenant_write_lockdown");
      expect(lockdown?.idx).toBe(11);
      for (const entry of entries.filter((e) => e.idx < 11)) {
        await legacy.exec(readFileSync(join(dir, `${entry.tag}.sql`), "utf8"));
      }
      const ws = await legacy.query<{ id: string }>("insert into workspaces (name) values ('Legacy') returning id");
      const wsId = ws.rows[0].id;
      const product = await legacy.query<{ id: string }>(
        "insert into products (workspace_id, title, mode) values ($1, 'Old', 'listing') returning id",
        [wsId],
      );
      await legacy.query(
        "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, 'uploads/legacy.jpg', 'image', 'x')",
        [wsId, product.rows[0].id],
      );
      await legacy.query("insert into brand_kits (workspace_id, logo_r2_key) values ($1, 'logos/legacy.png')", [
        wsId,
      ]);

      await legacy.exec(readFileSync(join(dir, "0011_tenant_write_lockdown.sql"), "utf8"));

      const kept = await legacy.query<{ r2_key: string }>("select r2_key from source_media");
      expect(kept.rows.map((r) => r.r2_key)).toEqual(["uploads/legacy.jpg"]);
      const constraints = await legacy.query<{ conname: string; convalidated: boolean }>(
        "select conname, convalidated from pg_constraint where conname like '%r2_key_workspace_prefix'",
      );
      expect(constraints.rows).toHaveLength(4);
      expect(constraints.rows.every((c) => c.convalidated === false)).toBe(true);
      await expect(
        legacy.query(
          "insert into source_media (workspace_id, product_id, r2_key, kind, sha256) values ($1, $2, 'uploads/new.jpg', 'image', 'x')",
          [wsId, product.rows[0].id],
        ),
      ).rejects.toThrow(/source_media_r2_key_workspace_prefix/);
    } finally {
      await legacy.close();
    }
  });
});

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsServiceRole,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
} from "./test-helpers";

// Migration pack_claims (docs/phases/PHASE_18.md P18-04): a platform table
// for the operator's prospect packs and their claim links. Only the owner
// connection and the service role read or write it; anon, signed in users
// and members of the operator's own workspace see nothing and write
// nothing (CLAUDE.md rule 5: a test for each new table). The checks keep
// raw tokens out and keep a claim consistent.

const OPERATOR = "00000000-0000-4000-8000-000000001401";
const HASH = "ab".repeat(32);

let client: PGlite;
let workspaceId: string;
let jobId: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  await createAppUserRole(client);
  const ws = await client.query<{ id: string }>("insert into workspaces (name) values ('Operator') returning id");
  workspaceId = ws.rows[0].id;
  await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, OPERATOR]);
  const product = await client.query<{ id: string }>(
    "insert into products (workspace_id, title, mode) values ($1, 'Candle', 'listing') returning id",
    [workspaceId],
  );
  const job = await client.query<{ id: string }>(
    "insert into generation_jobs (workspace_id, product_id, status) values ($1, $2, 'done') returning id",
    [workspaceId, product.rows[0].id],
  );
  jobId = job.rows[0].id;
  await client.query(
    `insert into pack_claims (token_hash, job_id, staff_workspace_id, prospect_label, product_source_url, expires_at)
     values ($1, $2, $3, 'Juniper Candles', 'https://juniper.example/products/candle', now() + interval '30 days')`,
    [HASH, jobId, workspaceId],
  );
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

const CLIENT_ROLES = [
  ["anon", () => actAsAnon(client)],
  ["authenticated", () => actAsAuthenticated(client, OPERATOR)],
  ["app member", () => actAs(client, OPERATOR)],
] as const;

describe("pack_claims (pack_claims)", () => {
  it("has row level security on and no column for a raw token", async () => {
    const rls = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'pack_claims'",
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const columns = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'pack_claims'",
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain("token_hash");
    expect(names).not.toContain("token");
  });

  for (const [name, become] of CLIENT_ROLES) {
    it(`is invisible and unwritable to ${name}, the operator's own membership included`, async () => {
      await become();
      const visible = await client
        .query("select * from pack_claims")
        .then((r) => r.rows.length)
        .catch(() => 0);
      expect(visible).toBe(0);
      await expect(
        client.query(
          "insert into pack_claims (token_hash, job_id, staff_workspace_id, prospect_label, expires_at) values ($1, $2, $3, 'X', now())",
          ["cd".repeat(32), jobId, workspaceId],
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
      const updated = await client
        .query("update pack_claims set taken_down_at = now(), claimed_at = now()")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(updated).toBe(0);
      const deleted = await client
        .query("delete from pack_claims")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(deleted).toBe(0);
      await actAsSuperuser(client);
      const rows = await client.query<{ taken_down_at: string | null }>("select taken_down_at from pack_claims");
      expect(rows.rows).toEqual([{ taken_down_at: null }]);
    });
  }

  it("lets the service role read it", async () => {
    await actAsServiceRole(client);
    const rows = await client.query<{ prospect_label: string }>("select prospect_label from pack_claims");
    expect(rows.rows).toEqual([{ prospect_label: "Juniper Candles" }]);
  });

  it("keeps one claim per pack and per token hash, and refuses raw tokens and empty labels", async () => {
    await actAsSuperuser(client);
    const insert = (hash: string, label: string, job = jobId) =>
      client.query(
        "insert into pack_claims (token_hash, job_id, staff_workspace_id, prospect_label, expires_at) values ($1, $2, $3, $4, now())",
        [hash, job, workspaceId, label],
      );
    await expect(insert("ef".repeat(32), "Another")).rejects.toThrow(/pack_claims_job_id_uq/);
    const product = await client.query<{ id: string }>(
      "insert into products (workspace_id, title, mode) values ($1, 'Soap', 'listing') returning id",
      [workspaceId],
    );
    const other = await client.query<{ id: string }>(
      "insert into generation_jobs (workspace_id, product_id) values ($1, $2) returning id",
      [workspaceId, product.rows[0].id],
    );
    await expect(insert(HASH, "Another", other.rows[0].id)).rejects.toThrow(/pack_claims_token_hash_uq/);
    await expect(insert("0123456789abcdef0123456789abcdef", "Raw token", other.rows[0].id)).rejects.toThrow(
      /token_hash_check/,
    );
    await expect(insert("ef".repeat(32), "   ", other.rows[0].id)).rejects.toThrow(/lengths_check/);
    await expect(insert("ef".repeat(32), "x".repeat(81), other.rows[0].id)).rejects.toThrow(/lengths_check/);
  });

  it("refuses a claiming workspace without its time, and keeps the time when that workspace is deleted", async () => {
    await actAsSuperuser(client);
    const claimer = await client.query<{ id: string }>("insert into workspaces (name) values ('Prospect') returning id");
    await expect(
      client.query("update pack_claims set claimed_by_workspace_id = $1", [claimer.rows[0].id]),
    ).rejects.toThrow(/pack_claims_claim_check/);
    await client.query("update pack_claims set claimed_by_workspace_id = $1, claimed_at = now()", [claimer.rows[0].id]);
    await client.query("delete from workspaces where id = $1", [claimer.rows[0].id]);
    const rows = await client.query<{ claimed_by_workspace_id: string | null; claimed: boolean }>(
      "select claimed_by_workspace_id, claimed_at is not null as claimed from pack_claims",
    );
    expect(rows.rows).toEqual([{ claimed_by_workspace_id: null, claimed: true }]);
  });
});

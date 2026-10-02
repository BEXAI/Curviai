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

// Migration free_previews (docs/phases/PHASE_18.md P18-12): a platform
// table for the free white main image made before signup. Only the owner
// connection and the service role may read or write it; anon, signed in
// users and workspace members see nothing and write nothing (CLAUDE.md
// rule 5: a test for each new table). The checks keep raw IPs and emails
// out and keep a claim consistent.

const MEMBER = "00000000-0000-4000-8000-000000001201";
const HASH = "0123456789abcdef0123456789abcdef";
const EMAIL_KEY = "ab".repeat(32);

let client: PGlite;
let workspaceId: string;
let previewId: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  await createAppUserRole(client);
  const ws = await client.query<{ id: string }>("insert into workspaces (name) values ('Claimer') returning id");
  workspaceId = ws.rows[0].id;
  await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, MEMBER]);
  const row = await client.query<{ id: string }>(
    `insert into free_previews (ip_hash, status, cost_micros, source_format, expires_at)
     values ($1, 'done', 11000, 'jpeg', now() + interval '2 days') returning id`,
    [HASH],
  );
  previewId = row.rows[0].id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

const CLIENT_ROLES = [
  ["anon", () => actAsAnon(client)],
  ["authenticated", () => actAsAuthenticated(client, MEMBER)],
  ["app member", () => actAs(client, MEMBER)],
] as const;

describe("free_previews (free_previews)", () => {
  it("has row level security on and no column for a raw IP or email", async () => {
    const rls = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'free_previews'",
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const columns = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'free_previews'",
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain("ip_hash");
    expect(names).toContain("email_key");
    for (const name of names) {
      expect(name).not.toMatch(/^(ip|ip_address|email|user_agent)$/);
    }
  });

  for (const [name, become] of CLIENT_ROLES) {
    it(`is invisible and unwritable to ${name}`, async () => {
      await become();
      const visible = await client
        .query("select * from free_previews")
        .then((r) => r.rows.length)
        .catch(() => 0);
      expect(visible, `${name} read free_previews`).toBe(0);
      await expect(
        client.query("insert into free_previews (ip_hash, expires_at) values ($1, now())", [HASH]),
      ).rejects.toThrow(/permission denied|row-level security/);
      const claimed = await client
        .query(
          "update free_previews set status = 'claimed', claimed_at = now(), claimed_workspace_id = $1 where id = $2",
          [workspaceId, previewId],
        )
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(claimed).toBe(0);
      const deleted = await client
        .query("delete from free_previews")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(deleted).toBe(0);
      await actAsSuperuser(client);
      const row = await client.query<{ status: string }>("select status from free_previews where id = $1", [previewId]);
      expect(row.rows).toEqual([{ status: "done" }]);
    });
  }

  it("lets the service role read and claim a row", async () => {
    await actAsServiceRole(client);
    const before = await client.query("select id from free_previews");
    expect(before.rows).toHaveLength(1);
    await client.query(
      "update free_previews set status = 'claimed', claimed_at = now(), claimed_workspace_id = $1, email_key = $2 where id = $3",
      [workspaceId, EMAIL_KEY, previewId],
    );
    await actAsSuperuser(client);
    const row = await client.query<{ status: string; claimed_workspace_id: string }>(
      "select status, claimed_workspace_id from free_previews where id = $1",
      [previewId],
    );
    expect(row.rows[0]).toEqual({ status: "claimed", claimed_workspace_id: workspaceId });
  });

  it("refuses a raw IP, an email, an unknown status, a long reason and a half claim", async () => {
    const insert = (columns: string, values: string) =>
      client.query(`insert into free_previews (${columns}, expires_at) values (${values}, now())`);
    await expect(insert("ip_hash", "'203.0.113.10'")).rejects.toThrow(/free_previews_ip_hash_check/);
    await expect(insert("ip_hash, email_key", `'${HASH}', 'seller@example.com'`)).rejects.toThrow(
      /free_previews_email_key_check/,
    );
    await expect(insert("ip_hash, status", `'${HASH}', 'paid'`)).rejects.toThrow(/free_previews_status_check/);
    await expect(insert("ip_hash, blocked_reason", `'${HASH}', '${"x".repeat(201)}'`)).rejects.toThrow(
      /free_previews_lengths_check/,
    );
    await expect(insert("ip_hash, source_format", `'${HASH}', 'gif'`)).rejects.toThrow(
      /free_previews_source_format_check/,
    );
    await expect(insert("ip_hash, main_format", `'${HASH}', 'webp'`)).rejects.toThrow(/free_previews_main_format_check/);
    await expect(insert("ip_hash, status", `'${HASH}', 'claimed'`)).rejects.toThrow(/free_previews_claim_check/);
    await expect(insert("ip_hash, claimed_at", `'${HASH}', now()`)).rejects.toThrow(/free_previews_claim_check/);
  });

  it("forgets the claiming workspace when it is deleted, keeping the row for the counts", async () => {
    await client.query("delete from workspaces where id = $1", [workspaceId]);
    const row = await client.query<{ claimed_workspace_id: string | null; status: string }>(
      "select claimed_workspace_id, status from free_previews where id = $1",
      [previewId],
    );
    expect(row.rows[0]).toEqual({ claimed_workspace_id: null, status: "claimed" });
  });
});

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

// Migration lifecycle_email (docs/phases/PHASE_18.md P18-06): email_sends
// and email_suppressions are platform tables (the leads precedent), and
// leads gains the marketing consent columns. Only the owner connection and
// the service role read or write them; anon, signed in users and workspace
// members see nothing and write nothing (CLAUDE.md rule 5: a test for each
// new table). No address is ever stored, only its sha256 key.

const MEMBER = "00000000-0000-4000-8000-000000001301";
const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);

let client: PGlite;
let workspaceId: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  await createAppUserRole(client);
  const ws = await client.query<{ id: string }>("insert into workspaces (name) values ('Mailer') returning id");
  workspaceId = ws.rows[0].id;
  await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, MEMBER]);
  await client.query(
    `insert into email_sends (recipient_key, workspace_id, template, dedupe_key, kind, status)
     values ($1, $2, 'welcome', 'welcome:one', 'transactional', 'sent')`,
    [KEY, workspaceId],
  );
  await client.query("insert into email_suppressions (recipient_key, scope, reason) values ($1, 'marketing', 'unsubscribed')", [
    KEY,
  ]);
  await client.query(
    `insert into leads (email, source, marketing_consent_at, consent_source)
     values ('seller@example.com', 'main-image-checker', now(), 'main-image-checker')`,
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
  ["authenticated", () => actAsAuthenticated(client, MEMBER)],
  ["app member", () => actAs(client, MEMBER)],
] as const;

async function visibleRows(table: string): Promise<number> {
  return client
    .query(`select * from ${table}`)
    .then((r) => r.rows.length)
    .catch(() => 0);
}

async function affected(statement: string, params: unknown[] = []): Promise<number> {
  return client
    .query(statement, params)
    .then((r) => r.affectedRows ?? 0)
    .catch(() => 0);
}

describe("lifecycle_email tables", () => {
  it("has row level security on both tables and no column for an address", async () => {
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('email_sends', 'email_suppressions') order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "email_sends", relrowsecurity: true },
      { relname: "email_suppressions", relrowsecurity: true },
    ]);
    const columns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('email_sends', 'email_suppressions')`,
    );
    for (const { column_name } of columns.rows) {
      expect(column_name).not.toMatch(/^(email|address|to|recipient)$/);
    }
    // Permissive policies only: the restrictive no_oauth_clients policy of
    // 0028 grants nothing (mcp-connections.test.ts).
    const policies = await client.query(
      "select policyname from pg_policies where tablename in ('email_sends', 'email_suppressions') and permissive = 'PERMISSIVE'",
    );
    expect(policies.rows).toEqual([]);
  });

  for (const [name, become] of CLIENT_ROLES) {
    it(`is invisible and unwritable to ${name}`, async () => {
      await become();
      expect(await visibleRows("email_sends"), `${name} read email_sends`).toBe(0);
      expect(await visibleRows("email_suppressions"), `${name} read email_suppressions`).toBe(0);
      expect(await visibleRows("leads"), `${name} read leads`).toBe(0);
      await expect(
        client.query(
          "insert into email_sends (recipient_key, template, dedupe_key, kind) values ($1, 'welcome', 'forged', 'marketing')",
          [OTHER_KEY],
        ),
      ).rejects.toThrow(/permission denied|row-level security/);
      await expect(
        client.query("insert into email_suppressions (recipient_key, scope, reason) values ($1, 'all', 'manual')", [OTHER_KEY]),
      ).rejects.toThrow(/permission denied|row-level security/);
      expect(await affected("update email_sends set status = 'failed'")).toBe(0);
      // Lifting your own unsubscribe goes through the server, never a client role.
      expect(await affected("delete from email_suppressions")).toBe(0);
      expect(await affected("update leads set marketing_consent_at = now(), consent_source = 'forged'")).toBe(0);
      await actAsSuperuser(client);
      const send = await client.query<{ status: string }>("select status from email_sends where dedupe_key = 'welcome:one'");
      expect(send.rows).toEqual([{ status: "sent" }]);
      const suppression = await client.query("select scope from email_suppressions where recipient_key = $1", [KEY]);
      expect(suppression.rows).toEqual([{ scope: "marketing" }]);
    });
  }

  it("lets the service role read and write both tables", async () => {
    await actAsServiceRole(client);
    expect(await visibleRows("email_sends")).toBe(1);
    await client.query(
      "insert into email_suppressions (recipient_key, scope, reason) values ($1, 'all', 'bounced')",
      [OTHER_KEY],
    );
    await actAsSuperuser(client);
    await client.query("delete from email_suppressions where recipient_key = $1", [OTHER_KEY]);
  });

  it("allows one row per dedupe key", async () => {
    await expect(
      client.query(
        "insert into email_sends (recipient_key, template, dedupe_key, kind) values ($1, 'welcome', 'welcome:one', 'transactional')",
        [OTHER_KEY],
      ),
    ).rejects.toThrow(/email_sends_dedupe_key_uq/);
  });

  it("refuses an address as the key, an unknown kind, status, scope or reason, and long text", async () => {
    const send = (columns: string, values: string) =>
      client.query(`insert into email_sends (template, dedupe_key, ${columns}) values ('welcome', gen_random_uuid()::text, ${values})`);
    await expect(send("recipient_key, kind", "'seller@example.com', 'marketing'")).rejects.toThrow(
      /email_sends_recipient_key_check/,
    );
    await expect(send("recipient_key, kind", `'${KEY}', 'promo'`)).rejects.toThrow(/email_sends_kind_check/);
    await expect(send("recipient_key, kind, status", `'${KEY}', 'marketing', 'bounced'`)).rejects.toThrow(
      /email_sends_status_check/,
    );
    await expect(send("recipient_key, kind, error", `'${KEY}', 'marketing', '${"x".repeat(501)}'`)).rejects.toThrow(
      /email_sends_lengths_check/,
    );
    await expect(
      client.query("insert into email_suppressions (recipient_key, scope, reason) values ('seller@example.com', 'all', 'manual')"),
    ).rejects.toThrow(/email_suppressions_recipient_key_check/);
    await expect(
      client.query("insert into email_suppressions (recipient_key, scope, reason) values ($1, 'transactional', 'manual')", [
        OTHER_KEY,
      ]),
    ).rejects.toThrow(/email_suppressions_scope_check/);
    await expect(
      client.query("insert into email_suppressions (recipient_key, scope, reason) values ($1, 'all', 'angry')", [OTHER_KEY]),
    ).rejects.toThrow(/email_suppressions_reason_check/);
  });

  it("keeps the lead consent time and its source together", async () => {
    await expect(
      client.query("insert into leads (email, source, marketing_consent_at) values ('half@example.com', 'gallery', now())"),
    ).rejects.toThrow(/leads_consent_check/);
    await expect(
      client.query("insert into leads (email, source, consent_source) values ('half2@example.com', 'gallery', 'gallery')"),
    ).rejects.toThrow(/leads_consent_check/);
    const old = await client.query<{ marketing_consent_at: Date | null }>(
      "insert into leads (email, source) values ('before@example.com', 'gallery') returning marketing_consent_at",
    );
    // A lead without the box ticked (or from before it shipped) has no consent.
    expect(old.rows[0].marketing_consent_at).toBeNull();
  });

  it("forgets the workspace of a deleted workspace's sends, keeping the log", async () => {
    await client.query("delete from workspaces where id = $1", [workspaceId]);
    const row = await client.query<{ workspace_id: string | null; status: string }>(
      "select workspace_id, status from email_sends where dedupe_key = 'welcome:one'",
    );
    expect(row.rows[0]).toEqual({ workspace_id: null, status: "sent" });
  });
});

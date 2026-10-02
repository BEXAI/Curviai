import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  readJournalEntries,
  SUPABASE_AUTH_SHIM_SQL,
  type TestDb,
} from "./test-helpers";
import { creditLedger, referralCodes, referrals, workspaces } from "./schema";

// Migration referrals (docs/phases/PHASE_18.md P18-24, CLAUDE.md rule 5):
// referral_codes is read by the members of its workspace and written only
// by the owner connection; the reworked referrals table holds another
// tenant's facts (the referred workspace, its payment id, why it was
// rejected), so no client role reads or writes it and the server reads it
// over the owner connection; each referral reward
// and reversal is one ledger row; the rework refuses a table that is not
// empty.

const OWNER_A = "00000000-0000-4000-8000-0000000024a1";
const EDITOR_A = "00000000-0000-4000-8000-0000000024a2";
const CLIENT_A = "00000000-0000-4000-8000-0000000024a3";
const OWNER_B = "00000000-0000-4000-8000-0000000024b1";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let wsC: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "Referrer" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "Referred" }).returning();
  const [c] = await db.insert(workspaces).values({ name: "Other" }).returning();
  wsA = a.id;
  wsB = b.id;
  wsC = c.id;
  await client.query(
    `insert into members (workspace_id, user_id, role) values
       ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'client'), ($5, $6, 'owner')`,
    [wsA, OWNER_A, EDITOR_A, CLIENT_A, wsB, OWNER_B],
  );
  await db.insert(referralCodes).values([
    { workspaceId: wsA, code: "abcdefgh" },
    { workspaceId: wsB, code: "bbbbcccc" },
  ]);
  await db.insert(referrals).values({ code: "abcdefgh", referrerWorkspaceId: wsA, referredWorkspaceId: wsB });
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("referral_codes (referrals migration)", () => {
  it("has row level security on", async () => {
    const result = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'referral_codes'",
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
  });

  it("shows every member their own workspace's code only", async () => {
    for (const user of [OWNER_A, EDITOR_A, CLIENT_A]) {
      for (const become of [() => actAs(client, user), () => actAsAuthenticated(client, user)]) {
        await become();
        const rows = await client.query<{ code: string }>("select code from referral_codes");
        expect(rows.rows).toEqual([{ code: "abcdefgh" }]);
        await actAsSuperuser(client);
      }
    }
    await actAsAuthenticated(client, OWNER_B);
    expect((await client.query("select code from referral_codes")).rows).toEqual([{ code: "bbbbcccc" }]);
    await actAsAnon(client);
    expect((await client.query("select * from referral_codes")).rows).toHaveLength(0);
  });

  it("never lets a client role issue, change or delete a code", async () => {
    await actAsAuthenticated(client, OWNER_A);
    await expect(
      client.query("insert into referral_codes (workspace_id, code) values ($1, 'forged12')", [wsC]),
    ).rejects.toThrow(/row-level security|permission denied/);
    const updated = await client.query("update referral_codes set code = 'zzzzzzzz'");
    expect(updated.affectedRows ?? 0).toBe(0);
    const deleted = await client.query("delete from referral_codes");
    expect(deleted.affectedRows ?? 0).toBe(0);
    await actAsAnon(client);
    await expect(
      client.query("insert into referral_codes (workspace_id, code) values ($1, 'forged34')", [wsC]),
    ).rejects.toThrow(/row-level security|permission denied/);
    await actAsSuperuser(client);
    const rows = await client.query("select code from referral_codes where workspace_id = $1", [wsA]);
    expect(rows.rows).toEqual([{ code: "abcdefgh" }]);
  });

  it("keeps one code per workspace, each code unique and in the ref format", async () => {
    await expect(client.query("insert into referral_codes (workspace_id, code) values ($1, 'other123')", [wsA])).rejects.toThrow(
      /referral_codes_pkey|duplicate key/,
    );
    await expect(client.query("insert into referral_codes (workspace_id, code) values ($1, 'abcdefgh')", [wsC])).rejects.toThrow(
      /referral_codes_code_uq|duplicate key/,
    );
    for (const bad of ["ABCDEFGH", "abc", "ab-cdefg", "a".repeat(33)]) {
      await expect(
        client.query("insert into referral_codes (workspace_id, code) values ($1, $2)", [wsC, bad]),
        bad,
      ).rejects.toThrow(/referral_codes_code_check/);
    }
  });
});

describe("referrals (reworked)", () => {
  it("shows no client role any referral, the referrer's own members included", async () => {
    await actAsSuperuser(client);
    await client.query(
      "update referrals set status = 'rejected', reject_reason = 'email_reused', qualifying_payment = 'checkout:cs_secret' where referred_workspace_id = $1",
      [wsB],
    );
    try {
      // The referrer's members would otherwise learn the referred
      // workspace's id, its Stripe payment id and that its email was reused.
      for (const user of [OWNER_A, EDITOR_A, CLIENT_A]) {
        for (const become of [() => actAs(client, user), () => actAsAuthenticated(client, user)]) {
          await become();
          for (const column of ["*", "referred_workspace_id", "qualifying_payment", "reject_reason", "status"]) {
            expect((await client.query(`select ${column} from referrals`)).rows, `${user} ${column}`).toHaveLength(0);
          }
          await actAsSuperuser(client);
        }
      }
      await actAsAuthenticated(client, OWNER_B);
      expect((await client.query("select * from referrals")).rows).toHaveLength(0);
      await actAsAnon(client);
      expect((await client.query("select * from referrals")).rows).toHaveLength(0);
      // Permissive policies only: the restrictive no_oauth_clients policy of
      // 0028 grants nothing (mcp-connections.test.ts).
      const policies = await client.query(
        "select policyname from pg_policies where tablename = 'referrals' and permissive = 'PERMISSIVE'",
      );
      expect(policies.rows).toEqual([]);
    } finally {
      await actAsSuperuser(client);
      await client.query(
        "update referrals set status = 'pending', reject_reason = null, qualifying_payment = null where referred_workspace_id = $1",
        [wsB],
      );
    }
  });

  it("never lets a client role write a referral or move its status", async () => {
    await actAsAuthenticated(client, OWNER_A);
    await expect(
      client.query("insert into referrals (code, referrer_workspace_id, referred_workspace_id) values ('abcdefgh', $1, $2)", [
        wsA,
        wsC,
      ]),
    ).rejects.toThrow(/row-level security|permission denied/);
    const updated = await client.query("update referrals set status = 'rewarded', rewarded_at = now()");
    expect(updated.affectedRows ?? 0).toBe(0);
    await actAsAuthenticated(client, OWNER_B);
    const deleted = await client.query("delete from referrals");
    expect(deleted.affectedRows ?? 0).toBe(0);
    await actAsSuperuser(client);
    const rows = await client.query<{ status: string }>("select status from referrals");
    expect(rows.rows).toEqual([{ status: "pending" }]);
  });

  it("holds one referral per referred workspace, and many per code", async () => {
    await expect(
      client.query("insert into referrals (code, referrer_workspace_id, referred_workspace_id) values ('abcdefgh', $1, $2)", [
        wsA,
        wsB,
      ]),
    ).rejects.toThrow(/referrals_referred_workspace_id_uq|duplicate key/);
    const [d] = await db.insert(workspaces).values({ name: "Second referred" }).returning();
    const inserted = await client.query(
      "insert into referrals (code, referrer_workspace_id, referred_workspace_id) values ('abcdefgh', $1, $2) returning id",
      [wsA, d.id],
    );
    expect(inserted.rows).toHaveLength(1);
  });

  it("refuses unknown statuses, a rejection without a reason, a reason without one, and odd payment keys", async () => {
    const [e] = await db.insert(workspaces).values({ name: "Checks" }).returning();
    const insert = (status: string, reason: string | null, payment: string | null = null) =>
      client.query(
        "insert into referrals (code, referrer_workspace_id, referred_workspace_id, status, reject_reason, qualifying_payment) values ('abcdefgh', $1, $2, $3, $4, $5)",
        [wsA, e.id, status, reason, payment],
      );
    await expect(insert("paid", null)).rejects.toThrow(/referrals_status_check/);
    await expect(insert("rejected", null)).rejects.toThrow(/referrals_reject_reason_check/);
    await expect(insert("reversed", null)).rejects.toThrow(/referrals_reject_reason_check/);
    await expect(insert("pending", "self_referral")).rejects.toThrow(/referrals_reject_reason_check/);
    await expect(insert("rejected", "x".repeat(41))).rejects.toThrow(/referrals_reject_reason_check/);
    await expect(insert("qualified", null, "charge:ch_1")).rejects.toThrow(/referrals_qualifying_payment_check/);
    await expect(insert("qualified", null, "invoice:in_1; drop")).rejects.toThrow(/referrals_qualifying_payment_check/);
    const ok = await insert("rewarded", null, "invoice:in_1ABC");
    expect(ok.affectedRows).toBe(1);
  });

  it("keeps the referred side's row when the referrer's workspace goes", async () => {
    const [ref] = await db.insert(workspaces).values({ name: "Leaving referrer" }).returning();
    const [newbie] = await db.insert(workspaces).values({ name: "Stays" }).returning();
    await db.insert(referralCodes).values({ workspaceId: ref.id, code: "leaving1" });
    await db.insert(referrals).values({ code: "leaving1", referrerWorkspaceId: ref.id, referredWorkspaceId: newbie.id });
    await client.query("delete from workspaces where id = $1", [ref.id]);
    const rows = await client.query<{ code: string | null; referrer_workspace_id: string | null }>(
      "select code, referrer_workspace_id from referrals where referred_workspace_id = $1",
      [newbie.id],
    );
    expect(rows.rows).toEqual([{ code: null, referrer_workspace_id: null }]);
    expect((await client.query("select * from referral_codes where code = 'leaving1'")).rows).toHaveLength(0);
  });
});

describe("credit_ledger_referral_step_uq", () => {
  it("writes each referral reward and reversal once, and leaves other ledger rows alone", async () => {
    await db.insert(creditLedger).values({ workspaceId: wsA, delta: 50, reason: "referral", source: "system", stepKey: "referral:r1:referrer" });
    await expect(
      db.insert(creditLedger).values({ workspaceId: wsA, delta: 50, reason: "referral", source: "system", stepKey: "referral:r1:referrer" }),
    ).rejects.toThrow();
    await db.insert(creditLedger).values({ workspaceId: wsA, delta: -50, reason: "referral", source: "system", stepKey: "referral:r1:referrer:reversed" });
    await db.insert(creditLedger).values([
      { workspaceId: wsA, delta: 50, reason: "referral", source: "system" },
      { workspaceId: wsA, delta: 50, reason: "referral", source: "system" },
      { workspaceId: wsA, delta: 1, reason: "grant", source: "system", stepKey: "referral:r1:referrer" },
    ]);
    const rows = await client.query<{ n: number }>(
      "select count(*)::int as n from credit_ledger where step_key = 'referral:r1:referrer'",
    );
    expect(rows.rows[0].n).toBe(2);
  });
});

describe("the rework on a table that is not empty", () => {
  async function databaseBeforeReferrals(): Promise<{ db: PGlite; remaining: string[] }> {
    const fresh = new PGlite();
    // auth.uid() and auth.jwt(): 0028_mcp_connections's no_oauth_clients
    // policy reads auth.jwt().
    await fresh.exec(`
      ${SUPABASE_AUTH_SHIM_SQL}
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
    `);
    const entries = readJournalEntries();
    const at = entries.findIndex((entry) => entry.tag.endsWith("_referrals"));
    expect(at).toBeGreaterThan(0);
    for (const entry of entries.slice(0, at)) {
      await fresh.exec(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"));
    }
    return { db: fresh, remaining: entries.slice(at).map((entry) => entry.tag) };
  }

  it("refuses rows with or without a code and keeps the old table as it was", async () => {
    for (const withCode of [true, false]) {
      const { db: fresh, remaining } = await databaseBeforeReferrals();
      try {
        const ws = await fresh.query<{ id: string }>("insert into workspaces (name) values ('Old') returning id");
        await fresh.query("insert into referrals (code, referrer_workspace_id) values ($1, $2)", [
          withCode ? "OLDCODE" : "nocode",
          ws.rows[0].id,
        ]);
        if (!withCode) {
          // A row whose code would satisfy the new foreign key: only the
          // hand written refusal stops it.
          await fresh.exec(`
            alter table referrals drop constraint referrals_pkey;
            alter table referrals alter column code drop not null;
            update referrals set code = null;
            alter table referrals add constraint referrals_pkey primary key (referrer_workspace_id);
          `);
        }
        const sqlText = readFileSync(join(migrationsDir, `${remaining[0]}.sql`), "utf8");
        await expect(fresh.exec(sqlText)).rejects.toThrow(
          withCode ? /referrals_code_referral_codes_code_fk|foreign key/ : /referrals is not empty/,
        );
        const columns = await fresh.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_name = 'referrals'",
        );
        expect(columns.rows.map((row) => row.column_name)).not.toContain("status");
        const codes = await fresh.query("select 1 from pg_class where relname = 'referral_codes'");
        expect(codes.rows).toHaveLength(0);
      } finally {
        await fresh.close();
      }
    }
  });
});

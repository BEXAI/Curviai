import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  readJournalEntries,
  type TestDb,
} from "./test-helpers";
import * as schema from "./schema";
import { creditLedger, events, members, signupGrants, workspaces } from "./schema";
import { eq } from "drizzle-orm";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const GRANT_MIGRATION = "0012_signup_grant_on_confirm";

/**
 * A PGlite database shaped like Supabase for the signup paths: the auth
 * schema with a users table (the columns the grant functions read) exists
 * before migrations run, so the 0004 and 0012 blocks install the real
 * triggers on auth.users. stopBefore leaves later migrations unapplied, so a
 * test can build the pre 0012 state and then upgrade it.
 */
async function createSupabaseLikeDb(opts: { stopBefore?: string } = {}): Promise<{
  client: PGlite;
  db: TestDb;
  applyRemaining: () => Promise<void>;
}> {
  const client = new PGlite();
  await client.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid
    language sql
    stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table auth.users (
      id uuid primary key,
      email varchar(255),
      email_confirmed_at timestamptz,
      created_at timestamptz not null default now()
    );
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
  `);
  const entries = readJournalEntries();
  const stopAt = opts.stopBefore ? entries.findIndex((e) => e.tag === opts.stopBefore) : -1;
  const first = stopAt === -1 ? entries : entries.slice(0, stopAt);
  const rest = stopAt === -1 ? [] : entries.slice(stopAt);
  const apply = async (list: typeof entries): Promise<void> => {
    for (const entry of list) {
      await client.exec(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"));
    }
  };
  await apply(first);
  return { client, db: drizzle(client, { schema }), applyRemaining: () => apply(rest) };
}

async function balanceOf(client: PGlite, workspaceId: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [workspaceId]);
  return Number(result.rows[0].credit_balance);
}

async function workspaceOf(db: TestDb, userId: string): Promise<string> {
  const [row] = await db.select().from(members).where(eq(members.userId, userId));
  expect(row, `membership for ${userId}`).toBeTruthy();
  return row.workspaceId;
}

async function seedFreeGrant(client: PGlite, credits: number): Promise<void> {
  await client.query(
    `insert into platform_settings (key, value) values ('free_signup_credits', $1::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(credits)],
  );
}

async function signUp(client: PGlite, id: string, email: string, confirmed = false): Promise<void> {
  await client.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)", [
    id,
    email,
    confirmed ? new Date().toISOString() : null,
  ]);
}

async function confirm(client: PGlite, id: string): Promise<void> {
  await client.query("update auth.users set email_confirmed_at = now() where id = $1", [id]);
}

function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("provision_workspace", () => {
  let client: PGlite;
  let db: TestDb;
  const USER = "00000000-0000-4000-8000-0000000000aa";

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates a workspace, owner membership and the free grant once", async () => {
    const first = await client.query<{ provision_workspace: string }>(
      "select provision_workspace($1, $2, $3)",
      [USER, "Test workspace", 15],
    );
    const wsId = first.rows[0].provision_workspace;
    expect(wsId).toBeTruthy();

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
    expect(ws.name).toBe("Test workspace");
    expect(ws.plan).toBe("free");

    const memberRows = await db.select().from(members).where(eq(members.workspaceId, wsId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].userId).toBe(USER);
    expect(memberRows[0].role).toBe("owner");

    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, wsId));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].delta).toBe(15);
    expect(ledgerRows[0].reason).toBe("grant");
    // A valid LedgerSource (Update.md 1.9).
    expect(ledgerRows[0].source).toBe("signup");
  });

  it("is idempotent: a second call returns the same workspace with no second grant", async () => {
    const again = await client.query<{ provision_workspace: string }>(
      "select provision_workspace($1, $2, $3)",
      [USER, "Different name", 15],
    );
    const wsId = again.rows[0].provision_workspace;
    const allWorkspaces = await db.select().from(workspaces);
    expect(allWorkspaces).toHaveLength(1);
    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, wsId));
    expect(ledgerRows).toHaveLength(1);
  });

  it("pays the seeded amount over the caller's fallback once platform_settings holds it", async () => {
    const other = uid(0xab);
    await seedFreeGrant(client, 9);
    const result = await client.query<{ provision_workspace: string }>(
      "select provision_workspace($1, $2, $3)",
      [other, "Seeded", 15],
    );
    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.workspaceId, result.rows[0].provision_workspace));
    expect(ledgerRows.map((r) => r.delta)).toEqual([9]);
    await client.query("delete from platform_settings where key = 'free_signup_credits'");
  });

  it("is not executable by client facing roles", async () => {
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [USER]);
    await client.exec("set role authenticated");
    await expect(
      client.query("select provision_workspace($1, $2, $3)", [USER, "X", 15]),
    ).rejects.toThrow(/permission denied/);
    await expect(client.query("select grant_signup_credits($1, $2)", [USER, 15])).rejects.toThrow(
      /permission denied/,
    );
    await expect(client.query("select grant_pending_signup_credits()")).rejects.toThrow(/permission denied/);
    await client.exec("reset role");
  });
});

describe("signup grant on a confirmed email (Supabase auth triggers)", () => {
  let client: PGlite;
  let db: TestDb;

  beforeAll(async () => {
    const created = await createSupabaseLikeDb();
    client = created.client;
    db = created.db;
    // Deliberately not 15: the grant must come from the seeded setting.
    await seedFreeGrant(client, 12);
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates the workspace at signup but holds the grant until the email is confirmed", async () => {
    const user = uid(1);
    await signUp(client, user, "maker@example.com");
    const ws = await workspaceOf(db, user);
    expect(await balanceOf(client, ws)).toBe(0);
    expect(await db.select().from(signupGrants).where(eq(signupGrants.userId, user))).toHaveLength(0);

    await confirm(client, user);
    expect(await balanceOf(client, ws)).toBe(12);
    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ delta: 12, reason: "grant", source: "signup" });
    const [grant] = await db.select().from(signupGrants).where(eq(signupGrants.userId, user));
    expect(grant).toMatchObject({ workspaceId: ws, credits: 12, withheldReason: null });
    expect(grant.emailKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("grants exactly once per user, however often confirmation or provisioning runs", async () => {
    const user = uid(1);
    const ws = await workspaceOf(db, user);
    await client.query("update auth.users set email_confirmed_at = null where id = $1", [user]);
    await confirm(client, user);
    await client.query("select provision_workspace($1, $2, $3)", [user, "Again", 15]);
    await client.query("select bootstrap_workspace($1, $2)", [user, "maker@example.com"]);
    await client.query("select grant_signup_credits($1, $2)", [user, 15]);
    expect(await balanceOf(client, ws)).toBe(12);
    expect(await db.select().from(signupGrants).where(eq(signupGrants.userId, user))).toHaveLength(1);
  });

  it("grants at signup when the user is created already confirmed", async () => {
    const user = uid(2);
    await signUp(client, user, "admin.made@example.com", true);
    expect(await balanceOf(client, await workspaceOf(db, user))).toBe(12);
  });

  it("gives no second grant to plus addressed or dotted Gmail variants of one inbox", async () => {
    const first = uid(3);
    await signUp(client, first, "Jane.Doe@gmail.com", true);
    const firstWs = await workspaceOf(db, first);
    expect(await balanceOf(client, firstWs)).toBe(12);

    for (const [n, email] of [
      [4, "janedoe+farm1@gmail.com"],
      [5, "j.a.n.e.d.o.e@googlemail.com"],
      [6, " JANEDOE+x@GMAIL.COM "],
    ] as const) {
      const user = uid(n);
      await signUp(client, user, email);
      await confirm(client, user);
      const ws = await workspaceOf(db, user);
      expect(await balanceOf(client, ws), email).toBe(0);
      const [grant] = await db.select().from(signupGrants).where(eq(signupGrants.userId, user));
      expect(grant).toMatchObject({ credits: 0, withheldReason: "email_already_granted" });
      const withheld = await db.select().from(events).where(eq(events.workspaceId, ws));
      expect(withheld.map((e) => e.name)).toEqual(["free_grant_withheld"]);
    }

    // A different inbox on another domain keeps its own grant; plus tags are
    // folded there too.
    const other = uid(7);
    await signUp(client, other, "jane.doe+shop@example.org", true);
    expect(await balanceOf(client, await workspaceOf(db, other))).toBe(12);
    const sibling = uid(8);
    await signUp(client, sibling, "jane.doe@example.org", true);
    expect(await balanceOf(client, await workspaceOf(db, sibling))).toBe(0);
  });

  it("waits for the seed, then settles confirmed users once through grant_pending_signup_credits", async () => {
    await client.query("delete from platform_settings where key = 'free_signup_credits'");
    const user = uid(9);
    await signUp(client, user, "early@example.net");
    await confirm(client, user);
    const ws = await workspaceOf(db, user);
    expect(await balanceOf(client, ws)).toBe(0);
    expect(await db.select().from(signupGrants).where(eq(signupGrants.userId, user))).toHaveLength(0);

    // An unconfirmed user stays pending through the backfill.
    const unconfirmed = uid(10);
    await signUp(client, unconfirmed, "later@example.net");

    await seedFreeGrant(client, 12);
    const settled = await client.query<{ grant_pending_signup_credits: number }>(
      "select grant_pending_signup_credits()",
    );
    expect(Number(settled.rows[0].grant_pending_signup_credits)).toBe(1);
    expect(await balanceOf(client, ws)).toBe(12);
    const again = await client.query<{ grant_pending_signup_credits: number }>(
      "select grant_pending_signup_credits()",
    );
    expect(Number(again.rows[0].grant_pending_signup_credits)).toBe(0);
    expect(await balanceOf(client, ws)).toBe(12);
    expect(await balanceOf(client, await workspaceOf(db, unconfirmed))).toBe(0);
  });

  it("gives an unconfirmed user provisioned by the app a workspace and no credits", async () => {
    const user = uid(11);
    await client.query("insert into auth.users (id, email) values ($1, $2)", [user, "app.first@example.com"]);
    // Simulate a user whose insert trigger did not run: no membership yet.
    await client.query("delete from members where user_id = $1", [user]);
    const result = await client.query<{ provision_workspace: string }>(
      "select provision_workspace($1, $2, $3)",
      [user, "App first", 15],
    );
    const ws = result.rows[0].provision_workspace;
    expect(await balanceOf(client, ws)).toBe(0);
    await confirm(client, user);
    expect(await balanceOf(client, await workspaceOf(db, user))).toBe(12);
  });

  it("never fails a signup or a confirmation when the grant errors", async () => {
    await client.exec(`
      create function test_break_grants() returns trigger language plpgsql as $$
      begin raise exception 'grant store unavailable'; end $$;
      create trigger test_break_grants before insert on signup_grants
        for each row execute function test_break_grants();
    `);
    const user = uid(12);
    await signUp(client, user, "resilient@example.com");
    await expect(confirm(client, user)).resolves.toBeUndefined();
    const [row] = await client
      .query<{ email_confirmed_at: string | null }>("select email_confirmed_at from auth.users where id = $1", [user])
      .then((r) => r.rows);
    expect(row.email_confirmed_at).not.toBeNull();
    expect(await balanceOf(client, await workspaceOf(db, user))).toBe(0);

    await client.exec("drop trigger test_break_grants on signup_grants; drop function test_break_grants();");
    // The next settlement pays it.
    await client.query("select grant_pending_signup_credits()");
    expect(await balanceOf(client, await workspaceOf(db, user))).toBe(12);
  });
});

describe("migration 0012 on a database that already has users", () => {
  let client: PGlite;
  let db: TestDb;
  let applyRemaining: () => Promise<void>;

  beforeAll(async () => {
    const created = await createSupabaseLikeDb({ stopBefore: GRANT_MIGRATION });
    client = created.client;
    db = created.db;
    applyRemaining = created.applyRemaining;
  });

  afterAll(async () => {
    await client.close();
  });

  it("treats every existing account as settled, so confirming later pays nothing more", async () => {
    // Under 0004 the insert trigger paid 15 at signup, confirmed or not.
    await signUp(client, uid(20), "old.unconfirmed@gmail.com");
    await signUp(client, uid(21), "old.confirmed@example.com", true);
    const oldWs = await workspaceOf(db, uid(20));
    expect(await balanceOf(client, oldWs)).toBe(15);

    await applyRemaining();
    await seedFreeGrant(client, 12);

    await confirm(client, uid(20));
    await client.query("select grant_pending_signup_credits()");
    expect(await balanceOf(client, oldWs)).toBe(15);
    expect(await balanceOf(client, await workspaceOf(db, uid(21)))).toBe(15);
    const grants = await db.select().from(signupGrants);
    expect(grants.map((g) => g.userId).sort()).toEqual([uid(20), uid(21)]);
    expect(grants.every((g) => g.credits === 15)).toBe(true);

    // The existing inbox is keyed, so a plus addressed copy gets nothing.
    const copy = uid(22);
    await signUp(client, copy, "oldunconfirmed+again@gmail.com", true);
    expect(await balanceOf(client, await workspaceOf(db, copy))).toBe(0);
    // A new inbox gets the seeded amount.
    const fresh = uid(23);
    await signUp(client, fresh, "fresh@example.com", true);
    expect(await balanceOf(client, await workspaceOf(db, fresh))).toBe(12);
  });
});

describe("platform_settings and signup_grants (platform tables)", () => {
  let client: PGlite;
  const USER = uid(30);

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    await createAppUserRole(client);
    await client.query("select provision_workspace($1, $2, $3)", [USER, "Tables", 15]);
    await seedFreeGrant(client, 15);
  });

  afterAll(async () => {
    await actAsSuperuser(client);
    await client.close();
  });

  it("are invisible and unwritable to signed in users, members and anon", async () => {
    for (const become of [
      () => actAsAuthenticated(client, USER),
      () => actAsAnon(client),
      () => actAs(client, USER),
    ]) {
      await become();
      for (const table of ["platform_settings", "signup_grants"]) {
        const visible = await client
          .query(`select * from ${table}`)
          .then((r) => r.rows.length)
          .catch(() => 0);
        expect(visible, table).toBe(0);
      }
      await expect(
        client.query("insert into platform_settings (key, value) values ('free_signup_credits', '1000')"),
      ).rejects.toThrow(/permission denied|row-level security/);
      await expect(
        client.query("insert into signup_grants (user_id, credits) values ($1, 0)", [uid(31)]),
      ).rejects.toThrow(/permission denied|row-level security/);
      const updated = await client
        .query("update platform_settings set value = '1000' where key = 'free_signup_credits'")
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(updated).toBe(0);
      const deleted = await client
        .query("delete from signup_grants where user_id = $1", [USER])
        .then((r) => r.affectedRows ?? 0)
        .catch(() => 0);
      expect(deleted).toBe(0);
      await actAsSuperuser(client);
    }
    const setting = await client.query<{ value: unknown }>(
      "select value from platform_settings where key = 'free_signup_credits'",
    );
    expect(setting.rows[0].value).toBe(15);
    const grants = await client.query("select * from signup_grants where user_id = $1", [USER]);
    expect(grants.rows).toHaveLength(1);
  });
});

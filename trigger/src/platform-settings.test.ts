import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, type Db } from "@curvi/db";
import { creditLedger, members, platformSettings } from "@curvi/db/schema";
import { createTestDb } from "@curvi/db/testing";
import { platformSettingSeedRows, tierByKey } from "@curvi/pipeline/seed";
import { grantPendingSignupCredits, loadPlatformSettings } from "./platform-settings";

let created: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;

const CONFIRMED = "00000000-0000-4000-8000-00000000c001";
const UNCONFIRMED = "00000000-0000-4000-8000-00000000c002";

beforeAll(async () => {
  created = await createTestDb();
  db = created.db as unknown as Db;
});

afterAll(async () => {
  await created.client.close();
});

describe("pnpm db:seed platform settings", () => {
  it("upserts the seed rows, idempotently", async () => {
    expect(await loadPlatformSettings(db, [{ key: "free_signup_credits", value: 3 }])).toBe(1);
    expect(await loadPlatformSettings(db)).toBe(platformSettingSeedRows.length);
    expect(await loadPlatformSettings(db)).toBe(platformSettingSeedRows.length);
    const rows = await created.db.select().from(platformSettings);
    expect(rows).toHaveLength(platformSettingSeedRows.length);
    const grant = rows.find((r) => r.key === "free_signup_credits");
    expect(grant?.value).toBe(tierByKey("free").creditsOnce);
    const fromSql = await created.client.query<{ free_signup_credits: string | number }>(
      "select free_signup_credits()",
    );
    expect(Number(fromSql.rows[0].free_signup_credits)).toBe(tierByKey("free").creditsOnce);
  });

  it("settles nothing on a database without Supabase auth", async () => {
    expect(await grantPendingSignupCredits(db)).toBe(0);
  });

  it("pays the seeded grant to confirmed users who were never settled, once", async () => {
    // Supabase shape, added after migrations so no auth trigger ran: these
    // users confirmed while the grant could not be paid.
    await created.client.exec(`
      create table auth.users (
        id uuid primary key,
        email varchar(255),
        email_confirmed_at timestamptz,
        created_at timestamptz not null default now()
      );
    `);
    await created.client.query(
      "insert into auth.users (id, email, email_confirmed_at) values ($1, 'seeded@example.com', now()), ($2, 'waiting@example.com', null)",
      [CONFIRMED, UNCONFIRMED],
    );

    expect(await grantPendingSignupCredits(db)).toBe(1);
    expect(await grantPendingSignupCredits(db)).toBe(0);

    const [membership] = await created.db.select().from(members).where(eq(members.userId, CONFIRMED));
    const ledger = await created.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.workspaceId, membership.workspaceId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      delta: tierByKey("free").creditsOnce,
      reason: "grant",
      source: "signup",
    });
    expect(await created.db.select().from(members).where(eq(members.userId, UNCONFIRMED))).toHaveLength(0);
  });
});

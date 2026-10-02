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

  it("no longer seeds the output options kill switch, now the operator switch ops:output_options_enabled", async () => {
    await loadPlatformSettings(db);
    const rows = await created.db.select().from(platformSettings).where(eq(platformSettings.key, "output_options_enabled"));
    expect(rows).toHaveLength(0);
  });

  it("refuses an ops: row before writing anything", async () => {
    for (const key of ["ops:acquisition_paused", " OPS:packs_paused"]) {
      await expect(
        loadPlatformSettings(db, [
          { key: "free_signup_credits", value: 99 },
          { key, value: true },
        ]),
      ).rejects.toThrow(/never writes operator switches/);
    }
    const grant = await created.db.select().from(platformSettings).where(eq(platformSettings.key, "free_signup_credits"));
    expect(grant[0]?.value).toBe(tierByKey("free").creditsOnce);
  });

  it("leaves every ops: switch the founder set through a re-seed", async () => {
    // docs/phases/PHASE_20.md P20-20 acceptance: flip ops:acquisition_paused
    // on, run pnpm db:seed, and it stays on.
    await created.db.insert(platformSettings).values([
      { key: "ops:acquisition_paused", value: true },
      { key: "ops:output_options_enabled", value: false },
      { key: "ops:packs_paused", value: { on: true, message: "Back at noon", setBy: "ops@curvi.ai" } },
    ]);
    await loadPlatformSettings(db);
    await loadPlatformSettings(db);
    const rows = await created.db.select().from(platformSettings);
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    expect(byKey.get("ops:acquisition_paused")).toBe(true);
    expect(byKey.get("ops:output_options_enabled")).toBe(false);
    expect(byKey.get("ops:packs_paused")).toEqual({ on: true, message: "Back at noon", setBy: "ops@curvi.ai" });
  });

  it("writes none of PHASE_18's switches, which are ops: rows since P20-20", async () => {
    await loadPlatformSettings(db);
    const old = await created.db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.key, "acquisition_paused"));
    expect(old).toHaveLength(0);
  });

  it("still keeps a keepStored row as stored through a re-seed", async () => {
    const rows = [{ key: "test_kept_switch", value: false, keepStored: true }];
    await loadPlatformSettings(db, rows);
    const read = async () =>
      (await created.db.select().from(platformSettings).where(eq(platformSettings.key, "test_kept_switch")))[0]?.value;
    expect(await read()).toBe(false);
    await created.client.query("update platform_settings set value = 'true'::jsonb where key = 'test_kept_switch'");
    await loadPlatformSettings(db, rows);
    expect(await read()).toBe(true);
    await created.client.query("delete from platform_settings where key = 'test_kept_switch'");
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

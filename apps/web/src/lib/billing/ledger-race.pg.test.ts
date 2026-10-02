import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@curvi/db";
import { createRaceDatabase, type RaceDatabase } from "@curvi/db/race";
import { DbBillingStore } from "./db-store";

// docs/phases/PHASE_20.md P20-03: the billing store's races on a real
// Postgres, through DbBillingStore itself (law and copy review 17), so the
// claim, the lock and the ledger write the webhook runs are what is tested,
// not a copy of their SQL. packages/db/src/ledger-race.pg.test.ts covers the
// SQL ledger functions.
//
// Runs only when TEST_DATABASE_URL points at a Postgres server whose user
// may create databases (CI's ledger-race job). Skipped otherwise.

const url = process.env.TEST_DATABASE_URL;

/** Parallel calls each get their own connection. */
const PARALLEL = 20;

describe.skipIf(!url)("billing store races on real Postgres (TEST_DATABASE_URL)", () => {
  let race: RaceDatabase;
  let sql: RaceDatabase["sql"];
  let db: Db;
  let store: DbBillingStore;

  beforeAll(async () => {
    race = await createRaceDatabase(url!, 5);
    sql = race.sql;
    db = createDb(race.url, { max: PARALLEL + 5 });
    store = new DbBillingStore(db, "stripe");
  }, 120_000);

  afterAll(async () => {
    await (db as unknown as { $client?: { end(): Promise<void> } } | undefined)?.$client?.end();
    await race?.drop();
  });

  async function newWorkspace(): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into workspaces (name) values (${`race ${randomUUID()}`}) returning id`;
    return row!.id;
  }

  async function balanceOf(workspaceId: string): Promise<number> {
    const [row] = await sql<{ balance: string }[]>`select coalesce(sum(delta), 0)::text as balance from credit_ledger where workspace_id = ${workspaceId}`;
    return Number(row!.balance);
  }

  it(`${PARALLEL} parallel identical grant deliveries write one ledger row`, async () => {
    const ws = await newWorkspace();
    const invoiceId = `in_race_${randomUUID()}`;
    const written = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        store.recordGrantOnce(`invoice:${invoiceId}`, {
          workspaceId: ws,
          stripeCustomerId: null,
          credits: 600,
          reason: "grant",
          payment: { invoiceId },
        }),
      ),
    );
    expect(written.filter(Boolean)).toHaveLength(1);
    const grants = await sql`select 1 from credit_ledger where workspace_id = ${ws} and reason = 'grant'`;
    expect(grants).toHaveLength(1);
    expect(await balanceOf(ws)).toBe(600);
  });

  it("a reserve racing a refund clawback never takes the balance below zero", async () => {
    for (let round = 0; round < 10; round += 1) {
      const ws = await newWorkspace();
      const paymentIntentId = `pi_race_${randomUUID()}`;
      await store.recordGrantOnce(`checkout:cs_${paymentIntentId}`, {
        workspaceId: ws,
        stripeCustomerId: null,
        credits: 10,
        reason: "topup",
        payment: { paymentIntentId },
      });
      const clawback = store.clawbackOnce(`evt_refund_${paymentIntentId}`, {
        reason: "refund",
        chargeId: `ch_${paymentIntentId}`,
        paymentIntentId,
        share: 1,
      });
      const reserve = sql`select reserve_credits(${ws}::uuid, 6, null)`;
      const [taken, reserved] = await Promise.allSettled([clawback, reserve]);
      expect(taken.status).toBe("fulfilled");
      const outcome = (taken as PromiseFulfilledResult<Awaited<typeof clawback>>).value;
      expect(outcome.status).toBe("applied");
      const clawedBack = outcome.status === "applied" ? outcome.clawedBack : -1;
      expect(await balanceOf(ws)).toBe(0);
      if (reserved.status === "fulfilled") {
        expect(clawedBack).toBe(4);
      } else {
        expect((reserved.reason as { code?: string }).code).toBe("CU402");
        expect(clawedBack).toBe(10);
      }
    }
  });
});

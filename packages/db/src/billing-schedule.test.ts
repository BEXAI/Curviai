import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actAsAuthenticated,
  actAsSuperuser,
  createTestDb,
} from "./test-helpers";

const WS = "00000000-0000-4000-8000-000000004001";
const MEMBER = "00000000-0000-4000-8000-000000004002";

describe("billing_schedule: pending plan changes and ledger labels", () => {
  let client: PGlite;

  beforeAll(async () => {
    ({ client } = await createTestDb());
    await client.query("insert into workspaces (id, name) values ($1, 'Scheduled billing')", [WS]);
    await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [WS, MEMBER]);
    await client.query(
      `insert into subscriptions (workspace_id, provider, tier, status,
        pending_tier, pending_cadence, pending_at, pending_schedule_id)
       values ($1, 'stripe', 'growth', 'active', 'starter', 'monthly', '2026-11-01', 'sub_sched_1')`,
      [WS],
    );
    await client.query(
      "insert into credit_ledger (workspace_id, delta, reason, source, note) values ($1, 100, 'topup', 'stripe', 'Top up 100')",
      [WS],
    );
  });

  afterAll(async () => { await client.close(); });

  it("lets members read their pending change and note but never write them", async () => {
    await actAsAuthenticated(client, MEMBER);
    try {
      const pending = await client.query<{ pending_tier: string; pending_schedule_id: string }>(
        "select pending_tier, pending_schedule_id from subscriptions",
      );
      expect(pending.rows).toEqual([{ pending_tier: "starter", pending_schedule_id: "sub_sched_1" }]);
      expect((await client.query<{ note: string }>("select note from credit_ledger")).rows).toEqual([{ note: "Top up 100" }]);
      for (const statement of [
        "update subscriptions set pending_tier = 'pro' returning id",
        "update credit_ledger set note = 'Changed by client' returning id",
      ]) {
        const changed = await client.query(statement).then((r) => r.rows.length).catch(() => 0);
        expect(changed).toBe(0);
      }
    } finally {
      await actAsSuperuser(client);
    }
  });

  it("rejects incomplete schedules and invalid values, then clears all fields together", async () => {
    for (const [statement, constraint] of [
      ["update subscriptions set pending_at = null", "subscriptions_pending_schedule_complete"],
      ["update subscriptions set pending_cadence = 'weekly'", "subscriptions_pending_cadence"],
      ["update subscriptions set pending_tier = 'enterprise'", "subscriptions_pending_tier"],
      ["update subscriptions set pending_schedule_id = ''", "subscriptions_pending_schedule_id_length"],
    ]) {
      await expect(client.query(statement!)).rejects.toThrow(constraint!);
    }
    await client.query("update subscriptions set pending_tier = null, pending_cadence = null, pending_at = null, pending_schedule_id = null");
    expect((await client.query<{ pending_tier: string | null }>("select pending_tier from subscriptions")).rows).toEqual([{ pending_tier: null }]);
  });

  it("allows a nullable or 120 character note and rejects a longer one", async () => {
    await client.query("update credit_ledger set note = $1", ["é".repeat(120)]);
    await expect(client.query("update credit_ledger set note = $1", ["x".repeat(121)])).rejects.toThrow("credit_ledger_note_length");
    await client.query("update credit_ledger set note = null");
  });
});

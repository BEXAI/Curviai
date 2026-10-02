import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingConsents, creditLedger, events, subscriptions, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { formatBillingVerification, loadBillingVerification } from "./verify";

// docs/phases/PHASE_20.md P20-03: what pnpm billing:verify prints, on a
// PGlite fixture.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

const asDb = (): Db => db as unknown as Db;

describe("billing:verify report", () => {
  it("returns null for a workspace that does not exist, or an id that is not one", async () => {
    expect(await loadBillingVerification(asDb(), "00000000-0000-4000-8000-000000000999")).toBeNull();
    expect(await loadBillingVerification(asDb(), "not-a-uuid")).toBeNull();
  });

  it("prints the plan, the subscription, the ledger by reason and the last billing events", async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: "Verify shop", plan: "growth", stripeCustomerId: "cus_verify" })
      .returning();
    await db.insert(subscriptions).values({
      workspaceId: ws.id,
      provider: "stripe",
      externalId: "sub_verify",
      tier: "growth",
      status: "active",
      cadence: "monthly",
      periodEnd: new Date("2026-12-01T00:00:00Z"),
    });
    await db.insert(creditLedger).values([
      { workspaceId: ws.id, delta: 600, reason: "grant", source: "stripe" },
      { workspaceId: ws.id, delta: 600, reason: "grant", source: "stripe" },
      { workspaceId: ws.id, delta: 100, reason: "topup", source: "stripe" },
      { workspaceId: ws.id, delta: -50, reason: "refund", source: "stripe" },
      { workspaceId: ws.id, delta: -8.5, reason: "charge", source: "system" },
    ] satisfies Array<typeof creditLedger.$inferInsert>);
    for (let i = 0; i < 12; i += 1) {
      await db.insert(events).values({
        workspaceId: ws.id,
        name: `billing:stripe:invoice:in_${i}`,
        props: { kind: "grant", credits: 600, reason: "grant" },
        at: new Date(Date.UTC(2026, 10, 1, 0, i)),
      });
    }
    await db.insert(events).values({ workspaceId: ws.id, name: "pack_started", props: {} });
    // The activation claim has no workspace (it outlives a deletion); it is
    // found through the workspace's own invoice claim (law and copy review 19).
    await db.insert(events).values([
      { workspaceId: null, name: "billing:email:plan_active:in_0", props: { kind: "plan_active" }, at: new Date("2026-11-01T00:00:30Z") },
      { workspaceId: null, name: "billing:email:plan_active:in_someone_else", props: {}, at: new Date("2026-11-01T00:00:40Z") },
    ]);
    await db.insert(billingConsents).values({
      workspaceId: ws.id,
      checkoutSessionId: "cs_verify",
      tier: "growth",
      cadence: "monthly",
      disclosureVersion: "2026-10-02.2",
      disclosureSha256: "f".repeat(64),
      disclosureText: "The terms shown",
      acceptedAt: new Date("2026-11-01T00:00:00Z"),
    });

    const report = await loadBillingVerification(asDb(), ws.id);
    expect(report).not.toBeNull();
    expect(report!.balance).toBe(1241.5);
    expect(report!.ledgerByReason).toEqual([
      { reason: "charge", rows: 1, credits: -8.5 },
      { reason: "grant", rows: 2, credits: 1200 },
      { reason: "refund", rows: 1, credits: -50 },
      { reason: "topup", rows: 1, credits: 100 },
    ]);
    expect(report!.recentEvents).toHaveLength(10);
    expect(report!.recentEvents[0].name).toBe("billing:stripe:invoice:in_11");

    const lines = formatBillingVerification(report!);
    expect(lines.slice(0, 3)).toEqual([`Workspace ${ws.id} (Verify shop)`, "Plan: growth", "Stripe customer: cus_verify"]);
    expect(lines).toContain("  sub_verify               growth   monthly   active       period ends 2026-12-01T00:00:00.000Z");
    expect(lines).toContain("  2026-11-01T00:00:00.000Z  cs_verify  growth monthly  version 2026-10-02.2  sha256 ffffffffffff");
    expect(lines).toContain("  2026-11-01T00:00:30.000Z  billing:email:plan_active:in_0");
    expect(lines.join("\n")).not.toContain("in_someone_else");
    expect(lines).toContain("  grant      2 rows     1200");
    expect(lines).toContain("  charge     1 row      -8.5");
    expect(lines).toContain("Balance: 1241.5");
    expect(lines).toContain("  2026-11-01T00:11:00.000Z  billing:stripe:invoice:in_11  (kind grant, reason grant, credits 600)");
    expect(lines.join("\n")).not.toContain("pack_started");
  });

  it("says none for an empty workspace", async () => {
    const [ws] = await db.insert(workspaces).values({ name: "Empty" }).returning();
    const lines = formatBillingVerification((await loadBillingVerification(asDb(), ws.id))!);
    expect(lines).toContain("Stripe customer: none");
    expect(lines).toContain("  no rows");
    expect(lines).toContain("Balance: 0");
  });
});

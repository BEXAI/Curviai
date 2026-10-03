import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { creditLedger, generationJobs, members, products, workspaces, sql, type Db } from "@curvi/db";
import { planningOf, readCreditPlanning, readCreditBudget, setCreditBudget } from "./credit-planning";
import { CreditBudgetInput, creditBudgetEstimateLine, creditBudgetRejection, isCreditBudgetExceeded, CREDIT_BUDGET_MESSAGE } from "./credit-budget";
import { estimateChatOf, EstimateChat } from "@/lib/api-v1/chat-views";
import { shotOpResponse } from "@/lib/services/shot-op-response";

const OWNER = "00000000-0000-4000-8000-00000000c121";
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const database = () => db as unknown as Db;
beforeAll(async () => { ({ db, client } = await createTestDb()); });
afterAll(async () => { await client?.close(); });

async function setup() {
  const [ws] = await db.insert(workspaces).values({ name: "Credit planning" }).returning();
  await db.insert(members).values({ workspaceId: ws.id, userId: OWNER, role: "owner" });
  const [product] = await db.insert(products).values({ workspaceId: ws.id, title: "Mug", mode: "listing" }).returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: ws.id, productId: product.id, status: "queued" }).returning();
  await db.insert(creditLedger).values({ workspaceId: ws.id, delta: 100, reason: "grant", source: "system" });
  return { ws: ws.id, job: job.id };
}

describe("raw ledger planning", () => {
  it("counts fractional delivered work and outstanding holds once, excluding charge transfers from returns", async () => {
    const { ws, job } = await setup();
    await setCreditBudget(database(), ws, OWNER, 10);
    await client.query("select reserve_credits($1,10,$2)", [ws, job]);
    await client.query("select charge_credits($1,2.5,$2,'image-1')", [ws, job]);
    await client.query("select release_credits($1,$2,3)", [ws, job]);
    const before = await readCreditPlanning(database(), ws);
    expect(before).toMatchObject({ available: 93, budget: { consumed: 2.5, held: 4.5, remaining: 3 }, observation: { consumed: 2.5, returned: 3 } });
    await client.query("select charge_credits($1,2.5,$2,'image-1')", [ws, job]);
    expect(await readCreditPlanning(database(), ws)).toMatchObject({ available: 93, budget: { consumed: 2.5, held: 4.5, remaining: 3 } });
    await client.query("select release_credits($1,$2)", [ws, job]);
    await client.query("select release_credits($1,$2)", [ws, job]);
    expect(await readCreditPlanning(database(), ws)).toMatchObject({ available: 97.5, budget: { consumed: 2.5, held: 0, remaining: 7.5 }, observation: { returned: 7.5 } });
  });

  it("keeps earlier-month holds, excludes grants and refunds from consumption, and scopes every figure", async () => {
    const { ws, job } = await setup();
    await setCreditBudget(database(), ws, OWNER, 12);
    await client.query("select reserve_credits($1,8,$2)", [ws, job]);
    await db.execute(sql`update credit_ledger set created_at = date_trunc('month', now()) - interval '1 day' where workspace_id=${ws}::uuid and reason='reserve'`);
    await db.insert(creditLedger).values([{ workspaceId: ws, delta: 25, reason: "grant" }, { workspaceId: ws, delta: -10, reason: "refund" }]);
    const other = await setup();
    await client.query("select reserve_credits($1,30,$2)", [other.ws, other.job]);
    expect(await readCreditPlanning(database(), ws)).toMatchObject({ available: 107, budget: { held: 8, consumed: 0, remaining: 4 }, observation: { consumed: 0, returned: 0 }, projection: { reason: "insufficient_history", monthTotal: null } });
    await client.query("select charge_credits($1,2.5,$2,'old-hold-delivered')", [ws, job]);
    expect(await readCreditBudget(database(), ws)).toMatchObject({ held: 5.5, consumed: 2.5, remaining: 4 });
    await setCreditBudget(database(), ws, OWNER, 1);
    await client.query("select charge_credits($1,0.5,$2,'existing-reservation')", [ws, job]);
    await expect(client.query("select reserve_credits($1,0.5,$2)", [ws, job])).rejects.toMatchObject({ code: "CU429" });
    await client.query("select release_credits($1,$2)", [ws, job]);
    await setCreditBudget(database(), ws, OWNER, null);
    await client.query("select reserve_credits($1,0.5,$2)", [ws, job]);
    expect(await readCreditBudget(database(), ws)).toMatchObject({ monthlyLimit: null, remaining: null, held: 0.5 });
  });
});

describe("projection and refusal contracts", () => {
  const row = {
    period_start: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z", monthly_limit: 200,
    consumed: 20, held: 10, remaining: 170, available: 300,
    observed_from: "2026-09-15T00:00:00Z", observed_to: "2026-10-15T00:00:00Z", workspace_created_at: "2026-01-01T00:00:00Z",
    observed_consumed: 60, returned: 8, active_days: 3, first_charge: "2026-09-20T00:00:00Z", last_charge: "2026-10-10T00:00:00Z",
  };
  it("projects using a labeled thirty day observation and refuses sparse or clustered history", () => {
    expect(planningOf(row)).toMatchObject({ observation: { days: 30 }, projection: { monthTotal: 54, reason: "estimate" } });
    for (const sparse of [{ active_days: 2 }, { first_charge: "2026-10-09T00:00:00Z" }, { workspace_created_at: "2026-10-05T00:00:00Z" }]) {
      expect(planningOf({ ...row, ...sparse }).projection).toEqual({ monthTotal: null, reason: "insufficient_history" });
    }
  });
  it("uses the same budget message in app followups and assistant estimates without treating it as a top up", async () => {
    const budget = planningOf({ ...row, remaining: 0 }).budget;
    const chat = EstimateChat.parse(estimateChatOf({ creditsNeeded: 0.5, creditsAvailable: 300, creditBudget: budget, channels: [], leftOut: [], quote: "q", quoteValidMinutes: 15 }));
    expect(chat).toMatchObject({ enough: false, message: CREDIT_BUDGET_MESSAGE, credit_budget: { remaining: 0, monthly_limit: 200 } });
    const response = shotOpResponse(creditBudgetRejection(0.5));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: CREDIT_BUDGET_MESSAGE, reason: "credit_budget_exceeded" });
    expect(creditBudgetEstimateLine(budget, 0.5)).toContain("This estimate exceeds the budget");
    expect(creditBudgetEstimateLine({ ...budget, monthlyLimit: null, remaining: null }, 0.5)).toBeNull();
  });
  it("accepts explicit zero and disable but rejects precision, negative, oversized and client injected actor fields", () => {
    for (const monthlyLimit of [null, 0, 0.5, 12.1]) expect(CreditBudgetInput.safeParse({ monthlyLimit }).success).toBe(true);
    for (const monthlyLimit of [-1, 0.15, Infinity, NaN, 1_000_000_001]) expect(CreditBudgetInput.safeParse({ monthlyLimit }).success).toBe(false);
    expect(CreditBudgetInput.safeParse({ monthlyLimit: 10, workspaceId: "other" }).success).toBe(false);
    expect(isCreditBudgetExceeded({ cause: { code: "CU429" } })).toBe(true);
    expect(isCreditBudgetExceeded({ code: "CU402" })).toBe(false);
    expect(isCreditBudgetExceeded(new Error("budget"))).toBe(false);
  });
});
